/**
 * EventHub 客户端引擎单测（design §4.2 / §4.3，P1-8 判据）。
 *
 * 用假 EventSource + 手动时钟覆盖状态迁移、乱序/重复、非 200、首连竞态、
 * truncated reset 失败重试、`lastSeq=max` 只在 caught_up/heartbeat 等。
 */
import { describe, expect, test } from "bun:test";
import {
  EventHub,
  type EventSourceLike,
  type TimerHandle,
} from "../src/ui/state/hub/event-hub.ts";
import type { HubDispatch, HubView } from "../src/ui/state/hub/types.ts";

type Listener = (event: { data: string }) => void;

class FakeSource implements EventSourceLike {
  readonly url: string;
  closed = false;
  onerror: ((event: unknown) => void) | null = null;
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (list) list.push(listener);
    else this.listeners.set(type, [listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data: unknown): void {
    this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }

  fail(): void {
    this.onerror?.({});
  }
}

class FakeClock {
  now = 1_000;
  private readonly timers = new Map<number, { fn: () => void; at: number }>();
  private seq = 1;

  readonly setTimeoutFn = (fn: () => void, ms: number): TimerHandle => {
    const id = this.seq++;
    this.timers.set(id, { fn, at: this.now + ms });
    return id as unknown as TimerHandle;
  };

  readonly clearTimeoutFn = (handle: TimerHandle): void => {
    this.timers.delete(handle as unknown as number);
  };

  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.now) continue;
      this.timers.delete(id);
      timer.fn();
    }
  }

  pending(): number {
    return this.timers.size;
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const HELLO = {
  hub: 2,
  account: "owner",
  role: "owner" as const,
  cursor: 0,
  as_of_seq: 10,
  since: null as number | null,
  replay_limit: 500,
  heartbeat_ms: 40,
  auth_mode: "open" as const,
};

interface Harness {
  hub: EventHub;
  clock: FakeClock;
  sources: FakeSource[];
  /** each openUrl() call records the `since` it was asked for */
  sinces: Array<number | null>;
  urls: string[];
  dispatches: HubDispatch[];
}

async function harness(
  overrides: {
    openUrl?: (since: number | null) => Promise<string>;
    views?: Array<{ asOfSeq: number; catchUp: () => void | Promise<void>; reload: () => void | Promise<void> }>;
    backoff?: readonly number[];
    heartbeatMs?: number;
    helloTimeoutMs?: number;
    isVisible?: () => boolean;
  } = {},
): Promise<Harness> {
  const clock = new FakeClock();
  const sources: FakeSource[] = [];
  const sinces: Array<number | null> = [];
  const urls: string[] = [];
  let ticket = 0;
  const hub = new EventHub({
    accountId: "owner",
    openUrl: async (since) => {
      sinces.push(since);
      if (overrides.openUrl) return overrides.openUrl(since);
      const url = `http://x/api/stream?hub=2&ticket=${++ticket}${since === null ? "" : `&since=${since}`}`;
      urls.push(url);
      return url;
    },
    createSource: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    now: () => clock.now,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    backoff: overrides.backoff ?? [5, 10, 20, 40],
    jitterMs: 0,
    heartbeatMs: overrides.heartbeatMs ?? 40,
    helloTimeoutMs: overrides.helloTimeoutMs ?? 500,
    isVisible: overrides.isVisible,
  });
  for (const view of overrides.views ?? []) {
    hub.registerView(() => view);
  }
  const dispatches: HubDispatch[] = [];
  hub.subscribe(
    [
      "post.created",
      "post.updated",
      "post.deleted",
      "notification.created",
      "plugin.updated",
      "stream.reset",
      "stream.reconnected",
      "stream.state",
      "cursor.acked",
      "stream.heartbeat",
    ],
    (dispatch) => dispatches.push(dispatch),
  );
  return { hub, clock, sources, sinces, urls, dispatches };
}

function event(seq: number, over: Partial<{ type: string; actor: string; post_id: string | null; root_id: string | null; post_deleted: boolean }> = {}) {
  return {
    seq,
    type: over.type ?? "post.created",
    actor: over.actor ?? "manager",
    post_id: over.post_id === undefined ? `p${seq}` : over.post_id,
    root_id: over.root_id === undefined ? `p${seq}` : over.root_id,
    batch_id: "b",
    created_at: 1,
    payload: { parent_id: null, root_id: `p${seq}` },
    post_deleted: over.post_deleted ?? false,
  };
}

describe("EventHub 客户端状态机", () => {
  test("首连：hub=2 连接、hello 后 live、首连无 since 时推进水位", async () => {
    const h = await harness();
    h.hub.start();
    await flush();
    expect(h.sources.length).toBe(1);
    expect(h.sinces).toEqual([null]);
    expect(h.hub.getStatus().state).toBe("connecting");

    h.sources[0]!.emit("hello", HELLO);
    const status = h.hub.getStatus();
    expect(status.state).toBe("live");
    expect(status.asOfSeq).toBe(10);
    expect(status.resumeSeq).toBe(10);
    expect(status.cursor).toBe(0);
    h.hub.stop();
  });

  test("首连 since=min(活跃视图 seed)；视图注册落后时补拉", async () => {
    let catchUps = 0;
    const view: HubView = {
      asOfSeq: 7,
      catchUp: () => {
        catchUps += 1;
      },
      reload: () => {},
    };
    const h = await harness({ views: [{ ...view }] });
    h.hub.registerView(() => ({ ...view, asOfSeq: 9 }));
    h.hub.start();
    await flush();
    expect(h.sinces).toEqual([7]);

    h.sources[0]!.emit("hello", { ...HELLO, as_of_seq: 12, since: 7 });
    h.clock.advance(250);
    // 两个视图的 seed 都落后于 hello.as_of_seq → hello 后强制补拉（各一次）
    expect(catchUps).toBe(2);
    h.hub.stop();
  });

  test("post.updated：只派发 post.updated、不进通知、推进 lastSeq", async () => {
    const h = await harness();
    h.hub.start();
    await flush();
    const source = h.sources[0]!;
    source.emit("hello", { ...HELLO, as_of_seq: 5, since: 5 });

    source.emit("hub", event(6, { type: "post.updated" }));
    const updated = h.dispatches.filter((dispatch) => dispatch.topic === "post.updated");
    expect(updated).toHaveLength(1);
    expect(
      updated.map((dispatch) => (dispatch.topic === "post.updated" ? dispatch.event.seq : 0)),
    ).toEqual([6]);
    // post.updated 不是通知：不得派生 notification.created，也不得被当成 post.created。
    expect(h.dispatches.filter((dispatch) => dispatch.topic === "notification.created")).toHaveLength(0);
    expect(h.dispatches.filter((dispatch) => dispatch.topic === "post.created")).toHaveLength(0);
    expect(h.hub.getStatus().asOfSeq).toBe(6);

    // 重复/旧 seq 仍按 lastSeq 去重。
    source.emit("hub", event(6, { type: "post.updated" }));
    source.emit("hub", event(5, { type: "post.updated" }));
    expect(h.dispatches.filter((dispatch) => dispatch.topic === "post.updated")).toHaveLength(1);
    h.hub.stop();
  });

  test("plugin.updated 控制帧：合法帧派发、非法帧丢弃、不推进水位", async () => {
    const h = await harness();
    h.hub.start();
    await flush();
    const source = h.sources[0]!;
    source.emit("hello", { ...HELLO });

    source.emit("plugin.updated", {
      plugin_id: "link-preview",
      enabled: false,
      version: "1.2.3",
    });
    const updates = h.dispatches.filter((dispatch) => dispatch.topic === "plugin.updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      topic: "plugin.updated",
      pluginId: "link-preview",
      enabled: false,
      version: "1.2.3",
    });
    expect(h.hub.getStatus().asOfSeq).toBe(10);

    source.emit("plugin.updated", { plugin_id: 123, enabled: false });
    source.emit("plugin.updated", { plugin_id: "link-preview" });
    source.emit("plugin.updated", { enabled: true });
    expect(h.dispatches.filter((dispatch) => dispatch.topic === "plugin.updated")).toHaveLength(1);
    h.hub.stop();
  });

  test("去重 + 乱序：seq <= lastSeq 丢弃；notification.created 只派生他人未删事件", async () => {
    const h = await harness();
    h.hub.start();
    await flush();
    const source = h.sources[0]!;
    source.emit("hello", { ...HELLO, since: 5 });
    expect(h.hub.getStatus().asOfSeq).toBe(0); // hello 不抬水位

    source.emit("hub", event(7));
    source.emit("hub", event(6)); // 乱序：旧 seq 丢弃
    source.emit("hub", event(7)); // 重复丢弃
    source.emit("hub", event(8, { actor: "owner" }));
    source.emit("hub", event(9, { post_deleted: true }));
    source.emit("hub", event(10, { type: "thread.invited" }));

    const created = h.dispatches.filter((d) => d.topic === "post.created");
    expect(created.map((d) => (d.topic === "post.created" ? d.event.seq : 0))).toEqual([7, 8, 9]);
    const notifications = h.dispatches.filter((d) => d.topic === "notification.created");
    expect(notifications.map((d) => (d.topic === "notification.created" ? d.event.seq : 0))).toEqual([7, 10]);
    expect(h.hub.getStatus().asOfSeq).toBe(10);
    h.hub.stop();
  });

  test("lastSeq 只在 caught_up/heartbeat 推进（pending 未清时钳在空洞上界）", async () => {
    const reloadGate = deferred();
    const reloads: number[] = [];
    const h = await harness({
      views: [
        {
          asOfSeq: 5,
          catchUp: () => {},
          reload: () => {
            reloads.push(1);
            return reloadGate.promise;
          },
        },
      ],
    });
    h.hub.start();
    await flush();
    const source = h.sources[0]!;
    source.emit("hello", { ...HELLO, as_of_seq: 10, since: 5 });
    source.emit("caught_up", { as_of_seq: 10, replayed: 2 });
    expect(h.hub.getStatus().asOfSeq).toBe(10);

    source.emit("heartbeat", { as_of_seq: 15, unread_count: 0 });
    expect(h.hub.getStatus().asOfSeq).toBe(15);

    source.emit("reset", { as_of_seq: 20, reason: "replay_limit" });
    expect(h.hub.getStatus().state).toBe("degraded");
    expect(h.hub.getStatus().catchingUp).toBe(true);
    expect(h.hub.getStatus().asOfSeq).toBe(15); // reset 不抬水位
    expect(h.hub.getStatus().resumeSeq).toBe(20); // 下次 since 前跳，防反复 reset
    expect(reloads.length).toBe(1);

    source.emit("heartbeat", { as_of_seq: 25, unread_count: 1 });
    expect(h.hub.getStatus().asOfSeq).toBe(20); // 钳在 pending 上界（不越过空洞）

    reloadGate.resolve();
    await flush();
    expect(h.hub.getStatus().catchingUp).toBe(false);
    expect(h.hub.getStatus().state).toBe("live");
    expect(h.hub.getStatus().asOfSeq).toBe(20);
    h.hub.stop();
  });

  test("reset 的 REST 重取失败：保留 pending 并退避重试，不假装追上", async () => {
    let attempts = 0;
    const h = await harness({
      views: [
        {
          asOfSeq: 5,
          catchUp: () => {},
          reload: () => {
            attempts += 1;
            if (attempts === 1) return Promise.reject(new Error("network"));
            return Promise.resolve();
          },
        },
      ],
    });
    h.hub.start();
    await flush();
    const source = h.sources[0]!;
    source.emit("hello", { ...HELLO, as_of_seq: 10, since: 5 });
    source.emit("reset", { as_of_seq: 30, reason: "replay_limit" });
    await flush();
    expect(attempts).toBe(1);
    expect(h.hub.getStatus().catchingUp).toBe(true);
    expect(h.hub.getStatus().asOfSeq).toBe(0);

    h.clock.advance(1000);
    await flush();
    expect(attempts).toBe(2);
    expect(h.hub.getStatus().catchingUp).toBe(false);
    expect(h.hub.getStatus().asOfSeq).toBe(30);
    h.hub.stop();
  });

  test("rollback（hello.as_of_seq < lastSeq）→ 进 degraded 并强重取", async () => {
    let reloads = 0;
    const h = await harness({
      views: [
        {
          asOfSeq: 20,
          catchUp: () => {},
          reload: () => {
            reloads += 1;
          },
        },
      ],
    });
    h.hub.start();
    await flush();
    const first = h.sources[0]!;
    first.emit("hello", { ...HELLO, as_of_seq: 20, since: null });
    expect(h.hub.getStatus().asOfSeq).toBe(20);

    first.fail();
    h.clock.advance(5);
    await flush();
    const second = h.sources[1]!;
    second.emit("hello", { ...HELLO, as_of_seq: 12, since: 20 });
    await flush();
    expect(reloads).toBe(1);
    // rollback = 新库真相（review B1/B2）：旧水位（20）作废，lastSeq/resumeSeq 拨到 12；
    // REST 成功后仍保持 12（不回退到旧库已应用位置）。
    expect(h.hub.getStatus().catchingUp).toBe(false);
    expect(h.hub.getStatus().asOfSeq).toBe(12);
    expect(h.hub.getStatus().resumeSeq).toBe(12);
    // 判别力：必须低于回滚前水位（20），否则「两者都停在旧水位」也会假过。
    expect(h.hub.getStatus().asOfSeq).toBeLessThan(20);
    expect(h.hub.getStatus().resumeSeq).toBeLessThan(20);

    // 二次重连：since 必须是 12（不是旧的 20），否则会反复触发 rollback reset。
    second.fail();
    h.clock.advance(5);
    await flush();
    expect(h.sources.length).toBe(3);
    expect(h.sinces).toEqual([20, 20, 12]);
    h.hub.stop();
  });

  test("rollback：新库低 seq 事件（旧水位以下）仍被送达，不被去重丢弃", async () => {
    const reloadGate = deferred();
    const h = await harness({
      views: [
        {
          asOfSeq: 20,
          catchUp: () => {},
          reload: () => reloadGate.promise,
        },
      ],
    });
    h.hub.start();
    await flush();
    const first = h.sources[0]!;
    first.emit("hello", { ...HELLO, as_of_seq: 20, since: null });
    expect(h.hub.getStatus().asOfSeq).toBe(20);

    first.fail();
    h.clock.advance(5);
    await flush();
    const second = h.sources[1]!;
    second.emit("hello", { ...HELLO, as_of_seq: 12, since: 20 });
    // rollback 声明即把水位拨到新库真相；REST 尚未确认 → catching_up/degraded。
    expect(h.hub.getStatus().asOfSeq).toBe(12);
    expect(h.hub.getStatus().resumeSeq).toBe(12);
    expect(h.hub.getStatus().catchUpReason).toBe("rollback");
    expect(h.hub.getStatus().catchingUp).toBe(true);
    expect(h.hub.getStatus().state).toBe("degraded");

    for (let seq = 13; seq <= 20; seq += 1) {
      second.emit("hub", event(seq));
    }
    const created = h.dispatches.filter((d) => d.topic === "post.created");
    expect(created.map((d) => (d.topic === "post.created" ? d.event.seq : 0))).toEqual([
      13, 14, 15, 16, 17, 18, 19, 20,
    ]);
    expect(h.hub.getStatus().asOfSeq).toBe(20);

    reloadGate.resolve();
    await flush();
    expect(h.hub.getStatus().catchingUp).toBe(false);
    expect(h.hub.getStatus().state).toBe("live");
    expect(h.hub.getStatus().asOfSeq).toBe(20);
    h.hub.stop();
  });

  test("断线：退避 1/2/4/8 档（注入 5/10/20/40）逐档重连，每次换新 ticket URL", async () => {
    const h = await harness();
    h.hub.start();
    await flush();
    const source = h.sources[0]!;
    source.emit("hello", { ...HELLO });

    source.fail();
    expect(h.hub.getStatus().state).toBe("reconnecting");
    expect(h.sources.length).toBe(1);
    h.clock.advance(4);
    await flush();
    expect(h.sources.length).toBe(1);
    h.clock.advance(1);
    await flush();
    expect(h.sources.length).toBe(2);
    expect(h.urls[0]).not.toBe(h.urls[1]);

    h.sources[1]!.fail();
    h.clock.advance(9);
    await flush();
    expect(h.sources.length).toBe(2);
    h.clock.advance(1);
    await flush();
    expect(h.sources.length).toBe(3);

    h.sources[2]!.fail();
    h.clock.advance(19);
    await flush();
    expect(h.sources.length).toBe(3);
    h.clock.advance(1);
    await flush();
    expect(h.sources.length).toBe(4);
    h.hub.stop();
  });

  test("连续 5 次失败 → degraded（轮询兜底指示）", async () => {
    const h = await harness({ backoff: [1] });
    h.hub.start();
    await flush();
    for (let i = 0; i < 5; i += 1) {
      h.sources.at(-1)!.fail();
      h.clock.advance(1);
      await flush();
    }
    const status = h.hub.getStatus();
    expect(status.state).toBe("degraded");
    expect(status.reason).toBe("reconnect_failed");
    expect(status.attempts).toBeGreaterThanOrEqual(5);
    h.hub.stop();
  });

  test("degraded 兜底轮询：每 60s 对活跃视图 catch-up，恢复 live 后停止", async () => {
    let catchUps = 0;
    const h = await harness({
      backoff: [1],
      views: [
        {
          asOfSeq: 5,
          catchUp: () => {
            catchUps += 1;
          },
          reload: () => {},
        },
      ],
    });
    h.hub.start();
    await flush();
    h.sources[0]!.emit("hello", { ...HELLO, as_of_seq: 5, since: 5 });
    for (let i = 0; i < 5; i += 1) {
      h.sources.at(-1)!.fail();
      h.clock.advance(1);
      await flush();
    }
    const degraded = h.hub.getStatus();
    expect(degraded.state).toBe("degraded");
    expect(degraded.reason).toBe("reconnect_failed");
    expect(degraded.degradedPolling).toBe(true);
    expect(catchUps).toBe(0);

    h.clock.advance(60_000);
    await flush();
    h.clock.advance(250); // scheduleViewCatchUp 的 250ms 防抖
    await flush();
    expect(catchUps).toBe(1);

    h.clock.advance(60_000);
    await flush();
    h.clock.advance(250);
    await flush();
    expect(catchUps).toBe(2);

    // 恢复 live：兜底轮询停止（再等三个周期也不应再补拉）。
    h.sources.at(-1)!.emit("hello", { ...HELLO, as_of_seq: 6, since: 5 });
    expect(h.hub.getStatus().state).toBe("live");
    expect(h.hub.getStatus().degradedPolling).toBe(false);
    // 非首次 hello 自身会触发一次 250ms 防抖的重连补拉——先让它落地再计基线。
    await flush();
    h.clock.advance(250);
    await flush();
    const afterRecovery = catchUps;
    h.clock.advance(180_000);
    await flush();
    expect(catchUps).toBe(afterRecovery);
    h.hub.stop();
  });

  test("degraded 兜底轮询受 visible 门控：hidden 120s 不触发，visible 立即一次", async () => {
    let visible = true;
    let catchUps = 0;
    const h = await harness({
      backoff: [1],
      isVisible: () => visible,
      views: [
        {
          asOfSeq: 5,
          catchUp: () => {
            catchUps += 1;
          },
          reload: () => {},
        },
      ],
    });
    h.hub.start();
    await flush();
    h.sources[0]!.emit("hello", { ...HELLO, as_of_seq: 5, since: 5 });
    for (let i = 0; i < 5; i += 1) {
      h.sources.at(-1)!.fail();
      h.clock.advance(1);
      await flush();
    }
    expect(h.hub.getStatus().state).toBe("degraded");
    expect(h.hub.getStatus().degradedPolling).toBe(true);

    // hidden：清定时器，120s 内一次补拉都不发。
    visible = false;
    h.hub.handleVisibilityChange();
    expect(h.hub.getStatus().degradedPolling).toBe(false);
    h.clock.advance(120_000);
    await flush();
    expect(catchUps).toBe(0);

    // visible：立即补一次（250ms 防抖）并重建定时器。
    visible = true;
    h.hub.handleVisibilityChange();
    await flush();
    h.clock.advance(250);
    await flush();
    expect(catchUps).toBe(1);
    expect(h.hub.getStatus().degradedPolling).toBe(true);
    h.hub.stop();
  });

  test("visible/online 立即重连（取消退避）", async () => {
    const h = await harness({ backoff: [10_000] });
    h.hub.start();
    await flush();
    h.sources[0]!.fail();
    h.clock.advance(1);
    expect(h.sources.length).toBe(1);
    h.hub.resumeNow();
    await flush();
    expect(h.sources.length).toBe(2);
    h.hub.stop();
  });

  test("bye{recycle} 立即重连；bye{auth} 关闭实时层", async () => {
    const h = await harness({ backoff: [10_000] });
    h.hub.start();
    await flush();
    h.sources[0]!.emit("hello", { ...HELLO });
    h.sources[0]!.emit("bye", { reason: "recycle" });
    await flush();
    expect(h.sources.length).toBe(2);

    h.sources[1]!.emit("hello", { ...HELLO });
    h.sources[1]!.emit("bye", { reason: "auth" });
    expect(h.hub.getStatus().state).toBe("off");
    h.clock.advance(60_000);
    await flush();
    expect(h.sources.length).toBe(2);
  });

  test("心跳看门狗：2.5×heartbeat 无帧 → 关闭并重连", async () => {
    const h = await harness({ heartbeatMs: 40 });
    h.hub.start();
    await flush();
    h.sources[0]!.emit("hello", { ...HELLO, heartbeat_ms: 40 });
    // 看门狗有 1s 下限：2.5×40=100ms 会被抬到 1000ms。
    h.clock.advance(999);
    await flush();
    expect(h.sources.length).toBe(1);
    h.clock.advance(2);
    await flush();
    expect(h.sources.length).toBe(2);
    expect(h.sources[0]!.closed).toBe(true);
    h.hub.stop();
  });

  test("hello 超时（连上但无 hello）→ 失败重连", async () => {
    const h = await harness({ helloTimeoutMs: 500 });
    h.hub.start();
    await flush();
    expect(h.sources.length).toBe(1);
    h.clock.advance(500);
    await flush();
    expect(h.hub.getStatus().attempts).toBe(1);
    h.clock.advance(5);
    await flush();
    expect(h.sources.length).toBe(2);
    h.hub.stop();
  });

  test("非 200（EventSource 永久失败）→ 自有状态机换新 ticket 重连", async () => {
    const h = await harness();
    h.hub.start();
    await flush();
    h.sources[0]!.fail();
    h.clock.advance(5);
    await flush();
    expect(h.sources.length).toBe(2);
    expect(h.sources[1]!.url).not.toBe(h.sources[0]!.url);
    h.hub.stop();
  });

  test("取 ticket 失败（openUrl reject）→ 退避重试", async () => {
    let calls = 0;
    const h = await harness({
      openUrl: async (since) => {
        calls += 1;
        if (calls === 1) throw new Error("401");
        return `http://x/api/stream?hub=2&ticket=${calls}`;
      },
    });
    h.hub.start();
    await flush();
    expect(calls).toBe(1);
    expect(h.hub.getStatus().attempts).toBe(1);
    h.clock.advance(5);
    await flush();
    expect(calls).toBe(2);
    expect(h.sources.length).toBe(1);
    h.hub.stop();
  });

  test("stop 后不再重连、状态 off", async () => {
    const h = await harness({ backoff: [1] });
    h.hub.start();
    await flush();
    h.sources[0]!.emit("hello", { ...HELLO });
    h.hub.stop();
    expect(h.hub.getStatus().state).toBe("off");
    expect(h.sources[0]!.closed).toBe(true);
    h.clock.advance(60_000);
    await flush();
    expect(h.sources.length).toBe(1);
  });

  test("reconnected 只在非首次 hello 派发；cursor 帧广播 unread_count", async () => {
    const h = await harness();
    h.hub.start();
    await flush();
    h.sources[0]!.emit("hello", { ...HELLO });
    expect(h.dispatches.filter((d) => d.topic === "stream.reconnected").length).toBe(0);

    h.sources[0]!.fail();
    h.clock.advance(5);
    await flush();
    h.sources[1]!.emit("hello", { ...HELLO, cursor: 4 });
    const reconnected = h.dispatches.filter((d) => d.topic === "stream.reconnected");
    expect(reconnected.length).toBe(1);

    h.sources[1]!.emit("cursor", { cursor: 9, unread_count: 2 });
    const cursor = h.dispatches.find((d) => d.topic === "cursor.acked");
    expect(cursor && cursor.topic === "cursor.acked" ? [cursor.cursor, cursor.unreadCount] : null).toEqual([9, 2]);
    expect(h.hub.getStatus().cursor).toBe(9);
    h.hub.stop();
  });

  test("心跳主题携带 unread_count（对账通道）", async () => {
    const h = await harness();
    h.hub.start();
    await flush();
    h.sources[0]!.emit("hello", { ...HELLO });
    h.sources[0]!.emit("heartbeat", { as_of_seq: 11, unread_count: 3 });
    const beat = h.dispatches.find((d) => d.topic === "stream.heartbeat");
    expect(beat && beat.topic === "stream.heartbeat" ? [beat.asOfSeq, beat.unreadCount] : null).toEqual([11, 3]);
    expect(h.hub.getStatus().asOfSeq).toBe(11);
    h.hub.stop();
  });
});

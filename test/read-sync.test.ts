/**
 * report-server-read-state 客户端写队列单测（P1-7 + P1-13 上传）。
 *
 * 纯逻辑：普通假时钟/假 storage/假 client，零真实定时器、零真实网络。
 */
import { describe, expect, test } from "bun:test";
import {
  READ_QUEUE_BACKOFF_MS,
  READ_QUEUE_LIMIT,
  ServerReadQueue,
  parseReadQueue,
  readQueueStorageKey,
  readUploadMarkerKey,
  uploadLegacyReadSet,
  type ReadQueueClient,
  type ReadQueueStorage,
} from "../src/ui/state/read-sync.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

class FakeClock {
  time = 0;
  private timers: Array<{ id: number; at: number; callback: () => void }> = [];
  private nextId = 1;

  now = (): number => this.time;

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.time + Math.max(0, ms), callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };

  activeTimers(): number {
    return this.timers.length;
  }

  delays(): number[] {
    return this.timers.map((timer) => timer.at - this.time).sort((a, b) => a - b);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.time = due.at;
      due.callback();
    }
    this.time = target;
  }
}

class FakeStorage implements ReadQueueStorage {
  values = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
    this.writes += 1;
  }
}

class FakeClient implements ReadQueueClient {
  calls: string[][] = [];
  failFirst = 0;
  gate: Promise<void> | null = null;

  async markReads(postIds: string[]): Promise<{ stored: number; skipped?: string[] }> {
    this.calls.push([...postIds]);
    if (this.gate) await this.gate;
    if (this.failFirst > 0) {
      this.failFirst -= 1;
      throw new Error("offline");
    }
    return { stored: postIds.length };
  }
}

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function makeQueue(options: {
  clock?: FakeClock;
  storage?: FakeStorage | null;
  storageKey?: string | null;
  client?: FakeClient | null;
  static?: boolean;
  onAck?: (ids: string[]) => void;
}) {
  const clock = options.clock ?? new FakeClock();
  const queue = new ServerReadQueue({
    storageKey: options.storageKey === undefined ? "q1" : options.storageKey,
    storage: options.storage ?? null,
    static: options.static ?? false,
    client: options.client ?? null,
    timers: clock,
    now: clock.now,
    onAck: options.onAck,
  });
  return { queue, clock };
}

// ── P1-7：队列语义 ──────────────────────────────────────────────────────────

describe("ServerReadQueue", () => {
  test("dedupes repeated enqueue and preserves FIFO order", () => {
    const { queue } = makeQueue({});
    queue.enqueue("A");
    queue.enqueue("B");
    queue.enqueue("A");
    expect(queue.pending()).toEqual(["A", "B"]);
    expect(queue.size()).toBe(2);
    expect(queue.has("A")).toBe(true);
  });

  test("caps at 500 and drops the oldest entries", () => {
    const { queue } = makeQueue({});
    for (let i = 0; i <= READ_QUEUE_LIMIT; i += 1) queue.enqueue(`p${i}`);
    expect(queue.size()).toBe(READ_QUEUE_LIMIT);
    expect(queue.has("p0")).toBe(false);
    expect(queue.has("p1")).toBe(true);
    expect(queue.pending().at(-1)).toBe(`p${READ_QUEUE_LIMIT}`);
  });

  test("250 ids flush as 3 batch requests (100/100/50) and clear the queue", async () => {
    const client = new FakeClient();
    const { queue } = makeQueue({ client });
    for (let i = 0; i < 250; i += 1) queue.enqueue(`p${i}`);
    const result = await queue.flush();
    expect(result.failed).toBe(false);
    expect(result.sent).toBe(250);
    expect(client.calls.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
    expect(client.calls.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(queue.pending()).toEqual([]);
  });

  test("keeps failed items and never loses later entries", async () => {
    const client = new FakeClient();
    client.failFirst = 1;
    const { queue } = makeQueue({ client });
    for (let i = 0; i < 250; i += 1) queue.enqueue(`p${i}`);
    const first = await queue.flush();
    expect(first.failed).toBe(true);
    expect(queue.size()).toBe(250);
    expect(client.calls.length).toBe(1);

    const second = await queue.flush();
    expect(second.failed).toBe(false);
    expect(second.sent).toBe(250);
    expect(queue.pending()).toEqual([]);
    expect(client.calls.length).toBe(4);
  });

  test("backoff sequence is 2s → 5s → 15s → 60s then stops", async () => {
    const clock = new FakeClock();
    const client = new FakeClient();
    client.failFirst = 99;
    const { queue } = makeQueue({ clock, client });
    queue.enqueue("A");

    await queue.flush();
    expect(client.calls.length).toBe(1);
    for (const expected of READ_QUEUE_BACKOFF_MS) {
      expect(clock.delays()).toEqual([expected]);
      clock.advance(expected);
      await flushMicrotasks();
    }
    // 4 次退避全部失败后队列保留、不再自动排重试。
    expect(client.calls.length).toBe(1 + READ_QUEUE_BACKOFF_MS.length);
    expect(clock.activeTimers()).toBe(0);
    expect(queue.pending()).toEqual(["A"]);
  });

  test("static mode enqueues nothing, writes no storage and issues zero requests", async () => {
    const storage = new FakeStorage();
    const client = new FakeClient();
    const { queue } = makeQueue({ storage, client, static: true });
    queue.enqueue("A");
    queue.flushPersist();
    const result = await queue.flush();
    expect(queue.pending()).toEqual([]);
    expect(storage.writes).toBe(0);
    expect(client.calls.length).toBe(0);
    expect(result.sent).toBe(0);
  });

  test("ack only removes acknowledged ids", () => {
    const storage = new FakeStorage();
    const { queue } = makeQueue({ storage });
    queue.enqueue("A");
    queue.enqueue("B");
    queue.ack(["A"]);
    expect(queue.pending()).toEqual(["B"]);
    queue.flushPersist();
    expect(JSON.parse(storage.getItem("q1")!)).toEqual([
      { post_id: "B", queued_at: 0 },
    ]);
  });

  test("persists with a 250ms trailing debounce and reloads", () => {
    const clock = new FakeClock();
    const storage = new FakeStorage();
    const { queue } = makeQueue({ clock, storage });
    queue.enqueue("A");
    clock.advance(100);
    queue.enqueue("B");
    expect(storage.writes).toBe(0);
    clock.advance(249);
    expect(storage.writes).toBe(0);
    clock.advance(1);
    expect(storage.writes).toBe(1);
    expect(parseReadQueue(storage.getItem("q1")).map((entry) => entry.post_id)).toEqual(["A", "B"]);

    const reloaded = makeQueue({ storage }).queue;
    expect(reloaded.pending()).toEqual(["A", "B"]);
  });

  test("switchKey isolates accounts: old pending stays on the old key", () => {
    const storage = new FakeStorage();
    const { queue } = makeQueue({ storage, storageKey: "q-account-a" });
    queue.enqueue("A");
    queue.switchKey("q-account-b", storage);
    expect(queue.pending()).toEqual([]);
    expect(JSON.parse(storage.getItem("q-account-a")!).map((e: { post_id: string }) => e.post_id)).toEqual(["A"]);

    queue.switchKey("q-account-a", storage);
    expect(queue.pending()).toEqual(["A"]);
  });

  test("in-flight flush from the old key never acks into the new account queue", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new FakeClient();
    client.gate = gate;
    const storage = new FakeStorage();
    const acked: string[][] = [];
    const { queue } = makeQueue({
      storage,
      storageKey: "q-a",
      client,
      onAck: (ids) => acked.push(ids),
    });
    queue.enqueue("A");
    const inflight = queue.flush();
    queue.switchKey("q-b", storage);
    release();
    await inflight;
    expect(acked).toEqual([]);
    expect(queue.pending()).toEqual([]);
    // 旧 key 的 pending 仍在旧账号存储里，等下次登录该账号时补写。
    expect(JSON.parse(storage.getItem("q-a")!).map((e: { post_id: string }) => e.post_id)).toEqual(["A"]);
  });

  test("storage keys keep backend+account isolation", () => {
    expect(readQueueStorageKey("http://127.0.0.1:13680", "owner")).toBe(
      "report.readq.v1:http://127.0.0.1:13680:owner",
    );
    expect(readQueueStorageKey("", "owner")).toBe("report.readq.v1:same-origin:owner");
    expect(readUploadMarkerKey("http://x", "owner")).toBe(
      "report.read.uploaded.v1:http://x:owner",
    );
  });

  test("parseReadQueue tolerates corrupt data, dedupes and keeps the newest", () => {
    expect(parseReadQueue(null)).toEqual([]);
    expect(parseReadQueue("nope")).toEqual([]);
    expect(parseReadQueue(JSON.stringify(["a", "", "a", { post_id: "b", queued_at: 5 }]))).toEqual([
      { post_id: "a", queued_at: 0 },
      { post_id: "b", queued_at: 5 },
    ]);
    expect(
      parseReadQueue(JSON.stringify(["a", "b", "c"]), 2).map((entry) => entry.post_id),
    ).toEqual(["b", "c"]);
  });
});

// ── P1-13：旧本地 read-set 一次性上传 ───────────────────────────────────────

describe("uploadLegacyReadSet", () => {
  test("2000 ids upload as 20 batches and write the marker", async () => {
    const client = new FakeClient();
    const storage = new FakeStorage();
    const ids = Array.from({ length: 2000 }, (_, i) => `p${i}`);
    const result = await uploadLegacyReadSet({
      ids,
      client,
      storage,
      markerKey: "marker",
    });
    expect(result).toEqual({ attempted: true, ok: true, batches: 20 });
    expect(client.calls.length).toBe(20);
    expect(client.calls.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(storage.getItem("marker")).not.toBeNull();
  });

  test("an existing marker skips re-upload", async () => {
    const client = new FakeClient();
    const storage = new FakeStorage();
    storage.setItem("marker", "1");
    const result = await uploadLegacyReadSet({
      ids: ["a", "b"],
      client,
      storage,
      markerKey: "marker",
    });
    expect(result).toEqual({ attempted: false, ok: true, batches: 0 });
    expect(client.calls.length).toBe(0);
  });

  test("a failed batch keeps the marker unset so the next ready retries", async () => {
    const client = new FakeClient();
    client.failFirst = 0; // manual fail on 2nd call
    let call = 0;
    const flaky: ReadQueueClient = {
      async markReads(postIds) {
        call += 1;
        if (call === 2) throw new Error("offline");
        client.calls.push([...postIds]);
        return { stored: postIds.length };
      },
    };
    const storage = new FakeStorage();
    const result = await uploadLegacyReadSet({
      ids: Array.from({ length: 250 }, (_, i) => `p${i}`),
      client: flaky,
      storage,
      markerKey: "marker",
    });
    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.batches).toBe(1);
    expect(storage.getItem("marker")).toBeNull();
  });

  test("empty read-set or missing storage does nothing", async () => {
    const client = new FakeClient();
    const storage = new FakeStorage();
    expect(
      await uploadLegacyReadSet({ ids: [], client, storage, markerKey: "m" }),
    ).toEqual({ attempted: false, ok: true, batches: 0 });
    expect(
      await uploadLegacyReadSet({ ids: ["a"], client, storage, markerKey: null }),
    ).toEqual({ attempted: false, ok: false, batches: 0 });
    expect(client.calls.length).toBe(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { SSEStreamingApi } from "hono/streaming";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server/http.ts";
import { AuthManager } from "../src/server/auth.ts";
import { Presence } from "../src/server/presence.ts";
import { Hub } from "../src/server/hub.ts";
import { IdleLease } from "../src/server/lease.ts";
import { NOTIFICATION_TYPES } from "../src/core/types.ts";
import type { Role } from "../src/core/types.ts";
import {
  createAgents,
  initWorkspace,
  makeStore,
  runCli,
  startTestServer,
  tempDir,
  type TestStore,
} from "./helpers.ts";

const T0 = 1_700_000_000_000;

// ── tiny SSE frame reader (buffers across network chunks) ─────────────────────
interface Frame {
  event: string;
  id: string | null;
  data: string;
}

function parseFrame(raw: string): Frame | null {
  let event = "message";
  let id: string | null = null;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, id, data: data.join("\n") };
}

class SseClient {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly controller: AbortController;
  private buffer = "";
  private readonly frames: Frame[] = [];
  private closed = false;
  private readonly waiters: Array<{
    resolve: (frame: Frame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>, controller: AbortController) {
    this.reader = reader;
    this.controller = controller;
    void this.pump();
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let index = this.buffer.indexOf("\n\n");
        while (index >= 0) {
          const raw = this.buffer.slice(0, index);
          this.buffer = this.buffer.slice(index + 2);
          const frame = parseFrame(raw);
          if (frame) this.push(frame);
          index = this.buffer.indexOf("\n\n");
        }
      }
    } catch {
      // aborted by the test
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("stream closed"));
    }
  }

  private push(frame: Frame): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      this.frames.push(frame);
    }
  }

  next(timeoutMs = 4000): Promise<Frame> {
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new Error("stream closed"));
    return new Promise<Frame>((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const at = this.waiters.indexOf(entry);
          if (at >= 0) this.waiters.splice(at, 1);
          reject(new Error(`timeout waiting for SSE frame (buffer=${JSON.stringify(this.buffer)})`));
        }, timeoutMs),
      };
      this.waiters.push(entry);
    });
  }

  async nextOf(event: string, timeoutMs = 4000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = await this.next(Math.max(1, deadline - Date.now()));
      if (frame.event === event) return frame;
    }
  }

  /** true when no frame is already buffered (used for negative assertions). */
  get idle(): boolean {
    return this.frames.length === 0;
  }

  abort(): void {
    this.controller.abort();
  }
}

interface Harness {
  t: TestStore;
  hub: Hub;
  presence: Presence;
  lease: IdleLease;
  server: ReturnType<typeof Bun.serve>;
  url: string;
  envDir: string;
  clients: SseClient[];
  health: () => Promise<Record<string, any>>;
  connect: (
    path: string,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; headers: Headers; client: SseClient | null }>;
  close: () => Promise<void>;
}

// ── deterministic fake SSE stream (unit-level B1 regression) ─────────────────
interface FakeFrame {
  event: string;
  id?: string;
  data: string;
}

/**
 * In-memory SSE sink. `blockEvent` makes exactly one write of that event wait
 * on `blocked`/`release()`, so a store change can be committed precisely inside
 * the hello / replay / heartbeat write window.
 */
class FakeSseStream {
  aborted = false;
  closed = false;
  readonly frames: FakeFrame[] = [];
  readonly blocked: Promise<void>;
  blockEvent: string | null = null;
  private readonly abortListeners: Array<() => void> = [];
  private readonly waiters: Array<{
    event: string;
    resolve: (frame: FakeFrame) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private blockedResolve!: () => void;
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  constructor() {
    this.blocked = new Promise((resolve) => {
      this.blockedResolve = resolve;
    });
  }

  onAbort(listener: () => void): void {
    this.abortListeners.push(listener);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of this.abortListeners) listener();
  }

  async writeSSE(frame: FakeFrame): Promise<void> {
    if (this.blockEvent === frame.event) {
      this.blockEvent = null;
      this.gate = new Promise<void>((resolve) => {
        this.releaseGate = resolve;
        this.blockedResolve();
      });
    }
    if (this.gate) {
      const gate = this.gate;
      this.gate = null;
      await gate;
    }
    const waiterAt = this.waiters.findIndex((waiter) => waiter.event === frame.event);
    if (waiterAt >= 0) {
      const [waiter] = this.waiters.splice(waiterAt, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(frame);
      return;
    }
    this.frames.push(frame);
  }

  release(): void {
    const release = this.releaseGate;
    this.releaseGate = null;
    release?.();
  }

  nextOf(event: string, timeoutMs = 2000): Promise<FakeFrame> {
    const at = this.frames.findIndex((frame) => frame.event === event);
    if (at >= 0) return Promise.resolve(this.frames.splice(at, 1)[0]!);
    return new Promise<FakeFrame>((resolve, reject) => {
      const entry = {
        event,
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(entry);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new Error(
              `fake stream timeout waiting for ${event} (frames=${this.frames
                .map((frame) => frame.event)
                .join(",")})`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(entry);
    });
  }
}

function makeHubUnit(
  opts: Partial<ConstructorParameters<typeof Hub>[0]> = {},
): { t: TestStore; hub: Hub; presence: Presence; lease: IdleLease; close: () => void } {
  const t = makeStore();
  const presence = new Presence();
  const lease = new IdleLease({ idleTimeoutMs: 60_000, onIdle: () => {} });
  const hub = new Hub({
    store: t.store,
    presence,
    instanceId: "unit-hub",
    lease,
    heartbeatMs: 60_000,
    ...opts,
  });
  return {
    t,
    hub,
    presence,
    lease,
    close: () => {
      hub.dispose();
      lease.stop();
      t.close();
    },
  };
}

function makeHarness(opts: { hub?: Partial<ConstructorParameters<typeof Hub>[0]> } = {}): Harness {
  const t = makeStore();
  const envDir = tempDir();
  const envPath = join(envDir, "env");
  writeFileSync(envPath, "# open mode\n");
  const auth = new AuthManager({
    store: t.store,
    envFiles: [envPath],
    secretSalt: "salt",
    envTtlMs: 0,
    processEnv: {},
  });
  const presence = new Presence();
  const lease = new IdleLease({ idleTimeoutMs: 60_000, onIdle: () => {} });
  const hub = new Hub({
    store: t.store,
    presence,
    instanceId: "inst-hub",
    lease,
    heartbeatMs: 60_000,
    ...opts.hub,
  });
  const app = createApp({
    store: t.store,
    auth,
    presence,
    dataDir: t.dir,
    instanceId: "inst-hub",
    startedAt: T0,
    openExposed: false,
    port: null,
    lease,
    hub,
  });
  const server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req), idleTimeout: 0 });
  const url = `http://127.0.0.1:${server.port}`;
  const clients: SseClient[] = [];
  return {
    t,
    hub,
    presence,
    lease,
    server,
    url,
    envDir,
    clients,
    health: async () => (await fetch(`${url}/healthz`)).json() as Promise<Record<string, any>>,
    connect: async (path, headers = {}) => {
      const controller = new AbortController();
      const res = await fetch(`${url}${path}`, { headers, signal: controller.signal });
      if (res.status !== 200 || !res.body) {
        controller.abort();
        return { status: res.status, headers: res.headers, client: null };
      }
      const client = new SseClient(res.body.getReader(), controller);
      clients.push(client);
      return { status: res.status, headers: res.headers, client };
    },
    close: async () => {
      for (const client of clients) client.abort();
      hub.dispose();
      server.stop(true);
      lease.stop();
      t.close();
      rmSync(envDir, { recursive: true, force: true });
    },
  };
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function data(frame: { data: string }): Record<string, any> {
  return JSON.parse(frame.data) as Record<string, any>;
}

const harnesses: Harness[] = [];
function harness(opts: { hub?: Partial<ConstructorParameters<typeof Hub>[0]> } = {}): Harness {
  const created = makeHarness(opts);
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  for (const created of harnesses.splice(0)) await created.close();
});

/** a → root mentioning b: exactly two events (post.created + thread.invited) for b. */
function notifyB(t: TestStore, batchId: string, body = "hello @b"): { rootId: string; seqs: number[] } {
  const post = t.store.commitOps({
    author: "a",
    batchId,
    ops: [{ op: "post", body }],
  }).posts[0]!;
  return { rootId: post.id, seqs: [post.seq, post.seq + 1] };
}

// ── protocol ─────────────────────────────────────────────────────────────────
describe("event hub protocol (hub=2)", () => {
  test("hello → backlog → caught_up with monotonic id frames", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b"]);
    const { seqs } = notifyB(h.t, "P1");

    const { status, client } = await h.connect("/api/stream?hub=2&as=b&since=0");
    expect(status).toBe(200);
    const hello = data(await client!.nextOf("hello"));
    expect(hello.hub).toBe(2);
    expect(hello.account).toBe("b");
    expect(hello.role).toBe("agent");
    expect(hello.cursor).toBe(0);
    expect(hello.as_of_seq).toBe(2);
    expect(hello.since).toBe(0);
    expect(hello.replay_limit).toBe(500);
    expect(hello.heartbeat_ms).toBe(60_000);
    expect(hello.instance_id).toBe("inst-hub");
    expect(hello.auth_mode).toBe("open");

    const first = await client!.nextOf("hub");
    const second = await client!.nextOf("hub");
    expect(first.id).toBe(String(seqs[0]));
    expect(second.id).toBe(String(seqs[1]));
    expect(data(first).type).toBe("post.created");
    expect(data(first).post_deleted).toBe(false);
    expect(data(second).type).toBe("thread.invited");

    const caughtUp = data(await client!.nextOf("caught_up"));
    expect(caughtUp).toEqual({ as_of_seq: 2, replayed: 2 });
  });

  test("since is exclusive; ?after= is an alias; Last-Event-ID participates in max()", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b"]);
    notifyB(h.t, "P2"); // events 1,2

    // since=1 → first frame is 2
    const sinceOnly = await h.connect("/api/stream?hub=2&as=b&since=1");
    expect((await sinceOnly.client!.nextOf("hub")).id).toBe("2");
    sinceOnly.client!.abort();

    // max(since=0, Last-Event-ID=1) = 1 → first frame is 2
    const headerWins = await h.connect("/api/stream?hub=2&as=b&since=0", {
      "last-event-id": "1",
    });
    expect((await headerWins.client!.nextOf("hub")).id).toBe("2");
    headerWins.client!.abort();

    // after= alias
    const afterAlias = await h.connect("/api/stream?hub=2&as=b&after=1");
    expect((await afterAlias.client!.nextOf("hub")).id).toBe("2");
    afterAlias.client!.abort();

    // max(since=2, Last-Event-ID=1) = 2 → nothing to replay, caught_up(0)
    const caughtUp = await h.connect("/api/stream?hub=2&as=b&since=2", {
      "last-event-id": "1",
    });
    expect(data(await caughtUp.client!.nextOf("caught_up"))).toEqual({
      as_of_seq: 2,
      replayed: 0,
    });
  });

  test("rollback reset when since > as_of_seq", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b"]);
    notifyB(h.t, "P3");
    const { client } = await h.connect("/api/stream?hub=2&as=b&since=999");
    const hello = data(await client!.nextOf("hello"));
    expect(hello.as_of_seq).toBe(2);
    const reset = data(await client!.nextOf("reset"));
    expect(reset).toEqual({ as_of_seq: 2, reason: "rollback" });
    expect(client!.idle).toBe(true); // no data frames, no caught_up
  });

  test("truncated backlog resets (visible row budget), never a silent gap", async () => {
    const h = harness({ hub: { replayLimit: 2 } });
    createAgents(h.t.store, ["a", "b"]);
    notifyB(h.t, "P4-1");
    notifyB(h.t, "P4-2");
    notifyB(h.t, "P4-3"); // 6 visible events
    const { client } = await h.connect("/api/stream?hub=2&as=b&since=0");
    expect(data(await client!.nextOf("hello")).replay_limit).toBe(2);
    const reset = data(await client!.nextOf("reset"));
    expect(reset.reason).toBe("replay_limit");
    expect(reset.as_of_seq).toBe(6);
    expect(client!.idle).toBe(true); // reset replaces caught_up/backlog
  });

  test("heartbeat is a real event frame carrying the delivered watermark", async () => {
    const h = harness({ hub: { heartbeatMs: 100 } });
    createAgents(h.t.store, ["a", "b"]);
    const { client } = await h.connect("/api/stream?hub=2&as=b&since=0");
    await client!.nextOf("hello");
    await client!.nextOf("caught_up");
    const beat = data(await client!.nextOf("heartbeat"));
    expect(beat.as_of_seq).toBe(0);
    expect(typeof beat.unread_count).toBe("number");

    const { seqs } = notifyB(h.t, "P5");
    const frame = await client!.nextOf("hub");
    expect(frame.id).toBe(String(seqs[0]));
    // a later heartbeat must never advertise seqs past undelivered events
    const nextBeat = data(await client!.nextOf("heartbeat"));
    expect(nextBeat.as_of_seq).toBeGreaterThanOrEqual(seqs[1]!);
    expect(nextBeat.as_of_seq).toBeLessThanOrEqual(h.t.store.maxEventSeq());
  });

  test("bye{recycle} at the per-stream lifetime (120ms stand-in covers the age>=maxStreamMs branch)", async () => {
    // Production lifetime is 30min; the 120ms stand-in exercises the same
    // `age >= maxStreamMs` branch without a 30-minute wait or fake clock.
    const h = harness({ hub: { heartbeatMs: 50, maxStreamMs: 120 } });
    createAgents(h.t.store, ["a", "b"]);
    const { client } = await h.connect("/api/stream?hub=2&as=b&since=0");
    await client!.nextOf("hello");
    await client!.nextOf("caught_up");
    const bye = data(await client!.nextOf("bye", 3000));
    expect(bye).toEqual({ reason: "recycle" });
  });

  test("abort recycles the registration, presence and lease hold", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b"]);
    const { client } = await h.connect("/api/stream?hub=2&as=b&since=0");
    await client!.nextOf("hello");
    expect((await h.health()).hub.connections).toBe(1);
    expect(h.presence.connectionCount("b")).toBe(1);
    await waitUntil(() => h.lease.snapshot().in_flight === 1);
    client!.abort();
    await waitUntil(async () => (await h.health()).hub.connections === 0, 1000);
    expect(h.presence.connectionCount("b")).toBe(0);
    expect(h.lease.snapshot().in_flight).toBe(0);
  });

  test("per-account and global limits answer 503 + Retry-After, with reconnect grace", async () => {
    const h = harness({ hub: { maxPerAccount: 2, maxStreams: 8 } });
    createAgents(h.t.store, ["a", "b"]);
    const one = await h.connect("/api/stream?hub=2&as=b&since=0");
    const two = await h.connect("/api/stream?hub=2&as=b&since=0");
    await one.client!.nextOf("hello");
    await two.client!.nextOf("hello");
    const refused = await h.connect("/api/stream?hub=2&as=b&since=0");
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect((await h.health()).hub.refused_total).toBe(1);
    // another account still fits
    expect((await h.connect("/api/stream?hub=2&as=owner&since=0")).status).toBe(200);
    // aborting one frees the slot within the grace window
    one.client!.abort();
    await waitUntil(async () => (await h.health()).hub.connections === 2);
    expect((await h.connect("/api/stream?hub=2&as=b&since=0")).status).toBe(200);

    const global = harness({ hub: { maxPerAccount: 8, maxStreams: 1 } });
    createAgents(global.t.store, ["a", "b"]);
    const only = await global.connect("/api/stream?hub=2&as=a&since=0");
    await only.client!.nextOf("hello");
    expect((await global.connect("/api/stream?hub=2&as=b&since=0")).status).toBe(503);
    expect((await global.health()).hub.refused_total).toBe(1);
  });

  test("cursor broadcast reaches every tab of the account", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b"]);
    const { seqs } = notifyB(h.t, "P6");
    const tab1 = await h.connect("/api/stream?hub=2&as=b&since=0");
    const tab2 = await h.connect("/api/stream?hub=2&as=b&since=0");
    await tab1.client!.nextOf("caught_up");
    await tab2.client!.nextOf("caught_up");
    const ackRes = await fetch(`${h.url}/api/notifications/ack`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-report-account": "b" },
      body: JSON.stringify({ target: seqs[1] }),
    });
    const ack = (await ackRes.json()) as Record<string, any>;
    expect(ack).toEqual({ ok: true, cursor: seqs[1]!, unread_count: 0 });
    for (const tab of [tab1, tab2]) {
      const frame = await tab.client!.nextOf("cursor");
      expect(data(frame)).toEqual({ cursor: seqs[1]!, unread_count: 0 });
    }
  });

  test("first connect without since: no backlog/caught_up, later events still arrive", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b"]);
    notifyB(h.t, "NS-SEED"); // events 1,2 exist before the connection
    const { client } = await h.connect("/api/stream?hub=2&as=b");
    const hello = data(await client!.nextOf("hello"));
    expect(hello.since).toBeNull();
    expect(hello.as_of_seq).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client!.idle).toBe(true); // no replay, no caught_up
    const fresh = notifyB(h.t, "NS-FRESH");
    const frame = await client!.nextOf("hub", 3000);
    expect(Number(frame.id)).toBe(fresh.seqs[0]!);
  });

  test("hub.shutdown sends bye{shutdown} and clears the registry", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b"]);
    const { client } = await h.connect("/api/stream?hub=2&as=b&since=0");
    await client!.nextOf("caught_up");
    const bye = client!.nextOf("bye", 2000);
    await h.hub.shutdown();
    expect(data(await bye)).toEqual({ reason: "shutdown" });
    await waitUntil(async () => (await h.health()).hub.connections === 0, 1000);
    expect(h.presence.connectionCount("b")).toBe(0);
  });
});

// ── lost-wakeup guards (B1) ──────────────────────────────────────────────────
describe("event hub lost-wakeup guards (B1)", () => {
  test("event committed while caught_up is being written is pushed ≤100ms after caught_up", async () => {
    const u = makeHubUnit({ replayLimit: 100, heartbeatMs: 60_000 });
    const stream = new FakeSseStream();
    let serving: Promise<void> | null = null;
    try {
      createAgents(u.t.store, ["a", "b"]);
      notifyB(u.t, "LW-SEED-1"); // 2 events
      notifyB(u.t, "LW-SEED-2"); // 4 events
      const ceiling = u.t.store.maxEventSeq();
      expect(ceiling).toBe(4);

      stream.blockEvent = "caught_up";
      serving = u.hub.serve({
        account: u.t.store.getAccount("b")!,
        stream: stream as unknown as SSEStreamingApi,
        authMode: "open",
        since: 0,
      });
      await stream.blocked; // replay snapshot taken, caught_up write in flight
      const fresh = notifyB(u.t, "LW-DURING-CAUGHT-UP");
      expect(u.t.store.maxEventSeq()).toBeGreaterThan(ceiling);
      // Hold the blocked write past the 50ms coalesced wake: the wake fires while
      // `conn.wake` is null (the connection is not waiting), so only the tail /
      // wakeSeq check can recover it — this is the actual lost-wakeup window.
      await new Promise((resolve) => setTimeout(resolve, 120));
      stream.release();
      const caught = data(await stream.nextOf("caught_up", 1000));
      expect(caught.as_of_seq).toBe(ceiling);
      expect(caught.replayed).toBe(ceiling);

      // Drop the replay frames already buffered; only the tail matters here.
      stream.frames.length = 0;
      const started = Date.now();
      const frame = await stream.nextOf("hub", 150); // old code: waits for the 60s heartbeat
      const latency = Date.now() - started;
      expect(Number(frame.id)).toBe(fresh.seqs[0]!);
      expect(JSON.parse(frame.data).type).toBe("post.created");
      expect(latency).toBeLessThanOrEqual(100);
    } finally {
      stream.abort();
      if (serving) await serving;
      u.close();
    }
  });

  test("event committed while hello is being written is not lost", async () => {
    const u = makeHubUnit({ replayLimit: 100, heartbeatMs: 60_000 });
    const stream = new FakeSseStream();
    let serving: Promise<void> | null = null;
    try {
      createAgents(u.t.store, ["a", "b"]);
      notifyB(u.t, "LW-H-SEED"); // 2 events
      stream.blockEvent = "hello";
      serving = u.hub.serve({
        account: u.t.store.getAccount("b")!,
        stream: stream as unknown as SSEStreamingApi,
        authMode: "open",
        since: 0,
      });
      await stream.blocked; // hello write in flight, replay query not started yet
      const fresh = notifyB(u.t, "LW-DURING-HELLO");
      await new Promise((resolve) => setTimeout(resolve, 120));
      stream.release();
      const caught = data(await stream.nextOf("caught_up", 1000));
      // The replay query runs after hello, so the fresh events are part of the
      // backlog (and are also not lost if they land later — the tail check).
      expect(caught.replayed).toBe(4);
      const hubIds = stream.frames
        .filter((frame) => frame.event === "hub")
        .map((frame) => Number(frame.id));
      expect(hubIds).toContain(fresh.seqs[0]!);
    } finally {
      stream.abort();
      if (serving) await serving;
      u.close();
    }
  });

  test("event committed while heartbeat is being written is pushed ≤100ms after heartbeat", async () => {
    const u = makeHubUnit({ heartbeatMs: 80, replayLimit: 100 });
    const stream = new FakeSseStream();
    let serving: Promise<void> | null = null;
    try {
      createAgents(u.t.store, ["a", "b"]);
      stream.blockEvent = "heartbeat";
      serving = u.hub.serve({
        account: u.t.store.getAccount("b")!,
        stream: stream as unknown as SSEStreamingApi,
        authMode: "open",
        since: 0,
      });
      await stream.blocked; // first heartbeat write in flight
      const fresh = notifyB(u.t, "LW-DURING-HEARTBEAT");
      // Same as above: let the coalesced wake fire while the connection is busy.
      await new Promise((resolve) => setTimeout(resolve, 120));
      stream.release();
      await stream.nextOf("heartbeat", 1000);
      stream.frames.length = 0; // drop the empty-replay caught_up / old frames
      const started = Date.now();
      const frame = await stream.nextOf("hub", 150); // old code: lost until the next write
      const latency = Date.now() - started;
      expect(Number(frame.id)).toBe(fresh.seqs[0]!);
      expect(latency).toBeLessThanOrEqual(100);
    } finally {
      stream.abort();
      if (serving) await serving;
      u.close();
    }
  });

  test("sparse agent heartbeat carries the global scan watermark, not its last visible seq", async () => {
    const u = makeHubUnit({ heartbeatMs: 80 });
    const stream = new FakeSseStream();
    let serving: Promise<void> | null = null;
    try {
      createAgents(u.t.store, ["a", "b", "c"]);
      notifyB(u.t, "SP-SEED"); // events 1,2 — b participates
      const max = u.t.store.maxEventSeq();
      serving = u.hub.serve({
        account: u.t.store.getAccount("b")!,
        stream: stream as unknown as SSEStreamingApi,
        authMode: "open",
        since: max,
      });
      await stream.nextOf("caught_up", 1000);

      // c's private root is invisible to b; it still advances the global max.
      u.t.store.commitOps({
        author: "c",
        batchId: "SP-PRIVATE",
        ops: [{ op: "post", body: "c only" }],
      });
      const expected = u.t.store.maxEventSeq();
      expect(expected).toBe(max + 1);

      let asOf = 0;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && asOf < expected) {
        asOf = data(await stream.nextOf("heartbeat", 500)).as_of_seq as number;
      }
      expect(asOf).toBe(expected); // no visible frame, but the scan ceiling advanced
      expect(stream.frames.filter((frame) => frame.event === "hub")).toHaveLength(0);
    } finally {
      stream.abort();
      if (serving) await serving;
      u.close();
    }
  });
});

// ── visibility ───────────────────────────────────────────────────────────────
describe("event hub visibility (same SQL as REST)", () => {
  test("agent stream only carries roots it participates in; owner sees all", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b", "c"]);
    const forB = notifyB(h.t, "V1"); // events 1,2 — visible to b only (and global roles)
    const cStream = await h.connect("/api/stream?hub=2&as=c&since=0");
    const cHello = data(await cStream.client!.nextOf("hello"));
    expect(cHello.as_of_seq).toBe(2);
    const cCaughtUp = data(await cStream.client!.nextOf("caught_up"));
    expect(cCaughtUp).toEqual({ as_of_seq: 2, replayed: 0 });
    expect(cStream.client!.idle).toBe(true);

    const ownerStream = await h.connect("/api/stream?hub=2&as=owner&since=0");
    expect((await ownerStream.client!.nextOf("hub")).id).toBe("1");
    ownerStream.client!.abort();

    // a later mention of c reaches the already-connected c stream
    h.t.store.commitOps({
      author: "a",
      batchId: "V2",
      ops: [{ op: "post", body: "c joins @c" }],
    });
    const frame = await cStream.client!.nextOf("hub", 3000);
    expect(data(frame).type).toBe("post.created");
    expect(data(frame).root_id).not.toBe(forB.rootId);
  });

  test("store.eventLines: agent filter, owner bypass, no ambiguous column", () => {
    const t = makeStore();
    try {
      createAgents(t.store, ["a", "b", "c"]);
      notifyB(t, "V3");
      const agentView = { id: "c", role: "agent" as Role };
      const agent = t.store.eventLines({ viewer: agentView, since: 0 });
      expect(agent.lines).toHaveLength(0);
      expect(agent.as_of_seq).toBe(2);
      expect(agent.truncated).toBe(false);

      const owner = t.store.eventLines({ viewer: { id: "owner", role: "owner" }, since: 0 });
      expect(owner.lines.map((line) => line.seq)).toEqual([1, 2]);
      expect(owner.lines.every((line) => line.post_deleted === false)).toBe(true);

      const bPage = t.store.eventLines({ viewer: { id: "b", role: "agent" }, since: 0 });
      expect(bPage.lines.map((line) => line.type)).toEqual(["post.created", "thread.invited"]);
      // type filter + includeSelf=false (REST predicate)
      const filtered = t.store.eventLines({
        viewer: { id: "b", role: "agent" },
        since: 0,
        includeSelf: false,
        types: NOTIFICATION_TYPES,
      });
      expect(filtered.lines).toHaveLength(2);

      // explicit empty type list → no rows, but the ceiling stays observable
      const none = t.store.eventLines({
        viewer: { id: "owner", role: "owner" },
        since: 0,
        types: [],
      });
      expect(none.lines).toEqual([]);
      expect(none.as_of_seq).toBe(2);
      expect(none.truncated).toBe(false);
    } finally {
      t.close();
    }
  });
});

// ── deletions ────────────────────────────────────────────────────────────────
describe("post.deleted (hub pushes, notifications never do)", () => {
  test("softDelete emits one event in the same transaction with ids-only payload", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b"]);
    const { rootId } = notifyB(h.t, "D1");
    const before = h.t.store.maxEventSeq();
    h.t.store.softDelete(rootId, { id: "a", role: "agent" });
    expect(h.t.store.maxEventSeq()).toBe(before + 1);
    const page = h.t.store.eventLines({ viewer: { id: "b", role: "agent" }, since: before });
    expect(page.lines).toHaveLength(1);
    const line = page.lines[0]!;
    expect(line.type).toBe("post.deleted");
    expect(line.actor).toBe("a");
    expect(line.post_id).toBe(rootId);
    expect(line.root_id).toBe(rootId);
    expect(line.post_deleted).toBe(true);
    expect(Object.keys(line.payload as Record<string, unknown>).sort()).toEqual([
      "parent_id",
      "post_id",
      "root_id",
    ]);
    expect(JSON.stringify(line.payload)).not.toContain("tags");
    expect(JSON.stringify(line.payload)).not.toContain("author");

    // read paths never deliver it
    const lines = h.t.store.notificationLines("b").lines;
    expect(
      lines.some((entry) => "type" in entry && entry.type === "post.deleted"),
    ).toBe(false);
    expect(h.t.store.notificationHistory("b", { limit: 100 }).events.some(
      (event) => (event.type as string) === "post.deleted",
    )).toBe(false);
    expect(h.t.store.unreadCount("b")).toBe(0); // its post.created is gone too
  });

  test("connected viewer receives the deletion frame within 2s", async () => {
    const h = harness({ hub: { wakeDebounceMs: 10 } });
    createAgents(h.t.store, ["a", "b"]);
    const { rootId, seqs } = notifyB(h.t, "D2");
    const { client } = await h.connect(`/api/stream?hub=2&as=b&since=${seqs[1]}`);
    await client!.nextOf("caught_up");
    h.t.store.softDelete(rootId, { id: "a", role: "agent" });
    const frame = await client!.nextOf("hub", 2000);
    expect(frame.id).toBe(String(seqs[1]! + 1));
    const payload = data(frame);
    expect(payload.type).toBe("post.deleted");
    expect(payload.post_deleted).toBe(true);
    expect(payload.payload).toEqual({
      post_id: rootId,
      root_id: rootId,
      parent_id: null,
    });
  });

  test("CLI wait-notifications never prints post.deleted", async () => {
    const ws = initWorkspace({ open: true });
    const server = await startTestServer({ workspace: ws });
    try {
      const base = ["--data-dir", ws.dataDir];
      const created = await runCli(["accounts", "create", "b", ...base, "--as", "manager"]);
      expect(created.code).toBe(0);
      const posted = await runCli(["post", "for b @b", ...base, "--as", "owner"]);
      expect(posted.code).toBe(0);
      const rootId = (JSON.parse(posted.stdout) as { posts: Array<{ id: string }> }).posts[0]!.id;
      const first = await runCli(["wait-notifications", ...base, "--as", "b"], {
        timeoutMs: 30_000,
      });
      expect(first.code).toBe(0);
      expect(first.stdout).toContain("post.created");
      expect(first.stdout.trim().split("\n").every((line) => line.startsWith("{"))).toBe(true);

      // delete (cursor already advanced) then produce a fresh notification so
      // the long poll can return promptly — the deletion event must be absent.
      const res = await fetch(`${server.url}/api/posts/${rootId}`, {
        method: "DELETE",
        headers: { "x-report-account": "owner" },
      });
      expect(res.status).toBe(200);
      const second = await runCli(["post", "fresh for b @b", ...base, "--as", "owner"]);
      expect(second.code).toBe(0);

      const waited = await runCli(["wait-notifications", ...base, "--as", "b"], {
        timeoutMs: 30_000,
      });
      expect(waited.code).toBe(0);
      const lines = waited.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((line) => line.type === "post.deleted")).toBe(false);
      for (const line of lines) {
        expect(["post.created", "thread.invited", "thread.snapshot"]).toContain(line.type);
      }
      const peek = (await (
        await fetch(`${server.url}/api/notifications?peek=1`, {
          headers: { "x-report-account": "b" },
        })
      ).json()) as { events: Array<{ type: string }>; unread_count: number };
      expect(peek.events.some((event) => event.type === "post.deleted")).toBe(false);
      expect(peek.unread_count).toBe(0);
    } finally {
      await server.stop();
      ws.cleanup();
    }
  }, 60_000);
});

// ── unread counters / peek / history ─────────────────────────────────────────
describe("unread_count and unread_by_target", () => {
  test("store counters: same predicate as the list, deletion-safe, visibility-scoped", () => {
    const t = makeStore();
    try {
      createAgents(t.store, ["a", "b", "c"]);
      const one = notifyB(t, "U1"); // 2 events
      const two = notifyB(t, "U2"); // 2 events
      expect(t.store.unreadCount("b")).toBe(4);
      const byTarget = t.store.unreadByTarget("b");
      expect(byTarget).toEqual({ [one.rootId]: 2, [two.rootId]: 2 });
      expect(Object.values(byTarget).reduce((sum, n) => sum + n, 0)).toBe(4);
      expect(t.store.unreadCount("c")).toBe(0);
      expect(t.store.unreadByTarget("c")).toEqual({});

      // partial ack: only events with seq <= cursor stop counting
      t.store.advanceCursor("b", 2);
      expect(t.store.unreadCount("b")).toBe(2);
      expect(t.store.unreadByTarget("b")).toEqual({ [two.rootId]: 2 });

      // ack everything
      t.store.advanceCursor("b", t.store.maxEventSeq());
      expect(t.store.unreadCount("b")).toBe(0);

      // deletion removes its notification from the count (delete event itself is not a reminder)
      const three = notifyB(t, "U3");
      expect(t.store.unreadCount("b")).toBe(2);
      t.store.softDelete(three.rootId, { id: "a", role: "agent" });
      expect(t.store.unreadCount("b")).toBe(0);

      // owner sees U1+U2 (4 events); U3's two events are excluded by the
      // deleted-post predicate and the post.deleted event is not a reminder
      expect(t.store.unreadCount("owner")).toBe(4);
    } finally {
      t.close();
    }
  });

  test("peek returns limit/has_more/unread_count/unread_by_target; ack returns unread_count", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b", "c"]);
    for (let index = 0; index < 3; index += 1) notifyB(h.t, `PK${index}`, `page ${index} @b`);
    const peek = (await (
      await fetch(`${h.url}/api/notifications?peek=1&limit=4`, {
        headers: { "x-report-account": "b" },
      })
    ).json()) as Record<string, any>;
    expect(peek.limit).toBe(4);
    expect(peek.has_more).toBe(true);
    expect(peek.unread_count).toBe(6);
    const eventLines = (peek.events as Array<Record<string, any>>).filter(
      (event) => event.type !== "thread.snapshot",
    );
    expect(eventLines).toHaveLength(4);
    expect(
      Object.values(peek.unread_by_target as Record<string, number>).reduce(
        (sum, n) => sum + n,
        0,
      ),
    ).toBe(6);

    const all = (await (
      await fetch(`${h.url}/api/notifications?peek=1&limit=200`, {
        headers: { "x-report-account": "b" },
      })
    ).json()) as Record<string, any>;
    expect(all.has_more).toBe(false);
    expect(all.unread_count).toBe(6);
    const target = all.target as number;
    const ack = (await (
      await fetch(`${h.url}/api/notifications/ack`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-report-account": "b" },
        body: JSON.stringify({ target }),
      })
    ).json()) as Record<string, any>;
    expect(ack).toEqual({ ok: true, cursor: target, unread_count: 0 });

    const history = (await (
      await fetch(`${h.url}/api/notifications/history?limit=100`, {
        headers: { "x-report-account": "b" },
      })
    ).json()) as Record<string, any>;
    expect(history.unread_count).toBe(0);
    expect(history.unread_by_target).toEqual({});
    // additive: legacy fields unchanged
    expect(history.cursor).toBe(target);
    expect(typeof history.has_more).toBe("boolean");
    expect("next_before" in history).toBe(true);

    // invalid limit is rejected for peeks, ignored for the unbounded long poll
    expect(
      (
        await fetch(`${h.url}/api/notifications?peek=1&limit=0`, {
          headers: { "x-report-account": "b" },
        })
      ).status,
    ).toBe(400);

    // `?cursor=` replays the LIST for debug/CLI use, but the badge stays
    // account-wide (stored cursor) — after ack it must be 0.
    const replay = (await (
      await fetch(`${h.url}/api/notifications?peek=1&cursor=0&limit=200`, {
        headers: { "x-report-account": "b" },
      })
    ).json()) as Record<string, any>;
    expect((replay.events as unknown[]).length).toBeGreaterThan(0);
    expect(replay.unread_count).toBe(0);
    expect(replay.unread_by_target).toEqual({});
  });
});

describe("hub option env fallbacks", () => {
  test("invalid legacy FDE2E_REPORT_HUB_MAX_STREAM_MS falls back to the 30min default", () => {
    const t = makeStore();
    const presence = new Presence();
    const previous = process.env.FDE2E_REPORT_HUB_MAX_STREAM_MS;
    const hubs: Hub[] = [];
    try {
      for (const raw of ["abc", "0", "-5", "1.5"]) {
        process.env.FDE2E_REPORT_HUB_MAX_STREAM_MS = raw;
        const hub = new Hub({ store: t.store, presence, instanceId: "env-hub" });
        hubs.push(hub);
        expect(hub.maxStreamMs).toBe(30 * 60_000);
      }
      process.env.FDE2E_REPORT_HUB_MAX_STREAM_MS = "1000";
      const valid = new Hub({ store: t.store, presence, instanceId: "env-hub" });
      hubs.push(valid);
      expect(valid.maxStreamMs).toBe(1000);
    } finally {
      for (const hub of hubs) hub.dispose();
      if (previous === undefined) delete process.env.FDE2E_REPORT_HUB_MAX_STREAM_MS;
      else process.env.FDE2E_REPORT_HUB_MAX_STREAM_MS = previous;
      t.close();
    }
  });

  test("STOA_HUB_MAX_STREAM_MS (new prefix) wins over the legacy key", () => {
    const t = makeStore();
    const presence = new Presence();
    const keys = ["STOA_HUB_MAX_STREAM_MS", "FDE2E_REPORT_HUB_MAX_STREAM_MS"] as const;
    const previous = keys.map((key) => process.env[key]);
    const hubs: Hub[] = [];
    try {
      process.env.STOA_HUB_MAX_STREAM_MS = "2500";
      process.env.FDE2E_REPORT_HUB_MAX_STREAM_MS = "1000";
      const hub = new Hub({ store: t.store, presence, instanceId: "env-hub" });
      hubs.push(hub);
      expect(hub.maxStreamMs).toBe(2500);
      delete process.env.STOA_HUB_MAX_STREAM_MS;
      const legacyHub = new Hub({ store: t.store, presence, instanceId: "env-hub" });
      hubs.push(legacyHub);
      expect(legacyHub.maxStreamMs).toBe(1000);
    } finally {
      for (const hub of hubs) hub.dispose();
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      t.close();
    }
  });
});

// ── healthz / status / capabilities / legacy ────────────────────────────────
describe("diagnostics and legacy compatibility", () => {
  test("healthz.hub reflects live streams; status carries a hub summary; capabilities advertises event_hub", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b"]);
    const { client } = await h.connect("/api/stream?hub=2&as=b&since=0");
    await client!.nextOf("hello");
    const health = await h.health();
    expect(health.hub.connections).toBe(1);
    expect(health.hub.streams).toBe(1);
    expect(health.hub.accounts).toBe(1);
    expect(health.hub.refused_total).toBe(0);
    const status = (await (
      await fetch(`${h.url}/api/status`, { headers: { "x-report-account": "b" } })
    ).json()) as Record<string, any>;
    expect(status.hub.connections).toBe(1);
    const caps = (await (await fetch(`${h.url}/api/capabilities`)).json()) as Record<string, any>;
    expect(caps.features.event_hub).toBe(true);
    expect(caps.features.sse).toBe(true);
  });

  test("without hub=2 the legacy wire format is unchanged (deep equality, exact key set)", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b"]);
    const { client } = await h.connect("/api/stream?as=owner");
    const helloFrame = await client!.nextOf("hello");
    const hello = data(helloFrame);
    expect(helloFrame.id).toBeNull();
    // old hello contract: exactly these five fields, exact values
    expect(hello).toEqual({
      account: "owner",
      cursor: 0,
      as_of_seq: 0,
      auth_mode: "open",
      author: null,
    });
    expect(Object.keys(hello).sort()).toEqual(
      ["account", "as_of_seq", "auth_mode", "author", "cursor"].sort(),
    );

    // legacy events keep `event: report`, carry no `id:`, and must NOT expose
    // the hub-only `post_deleted` projection.
    const post = h.t.store.commitOps({
      author: "a",
      batchId: "L1",
      ops: [{ op: "post", body: "legacy push" }],
    }).posts[0]!;
    const frame = await client!.nextOf("report", 4000);
    expect(frame.id).toBeNull();
    expect(data(frame)).toEqual({
      seq: post.seq,
      type: "post.created",
      actor: "a",
      post_id: post.id,
      root_id: post.id,
      batch_id: post.batch_id,
      created_at: post.created_at,
      payload: {
        parent_id: null,
        root_id: post.id,
        self_thread_id: post.id,
        quoted_post_id: null,
      },
    });
    expect(Object.keys(data(frame)).sort()).toEqual(
      ["actor", "batch_id", "created_at", "payload", "post_id", "root_id", "seq", "type"].sort(),
    );
    expect("post_deleted" in data(frame)).toBe(false);
    expect((await h.health()).hub.legacy_connects).toBe(1);
  });

  test("legacy SSE releases presence and lease on abort (no hub param)", async () => {
    const h = harness();
    createAgents(h.t.store, ["a", "b"]);
    const { client } = await h.connect("/api/stream?as=b");
    await client!.nextOf("hello");
    expect(h.presence.connectionCount("b")).toBe(1);
    await waitUntil(() => h.lease.snapshot().in_flight === 1);
    client!.abort();
    // Old code never ran its finally on abort (Hono swallows write errors);
    // the loop also stayed in waitForChange forever. Both are fixed.
    await waitUntil(() => h.presence.connectionCount("b") === 0, 1000);
    await waitUntil(() => h.lease.snapshot().in_flight === 0, 1000);
    expect((await h.health()).hub.legacy_connects).toBe(1);
  });
});

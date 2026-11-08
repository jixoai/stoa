import type { SSEStreamingApi } from "hono/streaming";
import type { Account, EventLine, Role } from "../core/types.ts";
import type { IdleLease } from "./lease.ts";
import type { Presence } from "./presence.ts";
import type { Store, Viewer } from "./store.ts";

/**
 * Event hub (design §3.3): one shared, viewer-scoped SSE stream per tab.
 *
 * Lifecycle rules that matter here:
 * - Hono's `stream.write()/writeln()` swallow every write error
 *   (`node_modules/hono/dist/utils/stream.js`), so a failed write is NOT a
 *   recycling signal. Cleanup only trusts `stream.onAbort`, `stream.aborted`,
 *   `req.raw.signal.aborted` and the per-stream maximum lifetime.
 * - The hub registers exactly ONE `store.onChange()` listener and coalesces
 *   wakes for 50ms, so a batch commit fans out as one `eventLines` scan per
 *   connection instead of one per event.
 * - Every connection re-runs the visibility SQL on wake: the stream is not a
 *   cache, `eventLines` remains the single source of truth.
 */

export interface HubSnapshot {
  /** live connections (== streams; both names kept for diagnostics) */
  connections: number;
  streams: number;
  /** distinct accounts currently connected */
  accounts: number;
  /** handshakes refused because per-account/global limits were hit */
  refused_total: number;
  /** legacy (`/api/stream` without `hub=2`) handshakes since process start */
  legacy_connects: number;
  max_per_account: number;
  max_streams: number;
  heartbeat_ms: number;
}

export interface HubOptions {
  store: Store;
  presence: Presence;
  instanceId: string;
  /** assigned after `createApp` in serve.ts; read dynamically */
  lease?: IdleLease | null;
  heartbeatMs?: number;
  maxPerAccount?: number;
  maxStreams?: number;
  maxStreamMs?: number;
  replayLimit?: number;
  wakeDebounceMs?: number;
  now?: () => number;
}

export interface HubStreamOptions {
  account: Account;
  stream: SSEStreamingApi;
  authMode: "open" | "auth";
  /** effectiveSince (`max(since, Last-Event-ID)`); null = first connect */
  since: number | null;
  signal?: AbortSignal;
}

interface Connection {
  id: number;
  accountId: string;
  role: Role;
  stream: SSEStreamingApi;
  /** read cursor at connect time (hello/`cursor` frames) */
  cursor: number;
  /** stream position: every visible event with seq <= lastSeq was delivered */
  lastSeq: number;
  startedAt: number;
  nextHeartbeatAt: number;
  closed: boolean;
  wake: (() => void) | null;
  releasePresence: () => void;
  releaseLease: (() => void) | null;
}

const UNREAD_CACHE_TTL_MS = 5_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export class Hub {
  readonly store: Store;
  readonly presence: Presence;
  readonly instanceId: string;
  readonly heartbeatMs: number;
  readonly maxPerAccount: number;
  readonly maxStreams: number;
  readonly maxStreamMs: number;
  readonly replayLimit: number;

  private readonly wakeDebounceMs: number;
  private readonly now: () => number;
  private lease: IdleLease | null;
  private readonly connections = new Map<number, Connection>();
  private readonly unreadCache = new Map<string, { value: number; at: number }>();
  private readonly unsubscribe: () => void;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private nextConnectionId = 0;
  private refusedTotal = 0;
  private legacyConnects = 0;
  /**
   * Global seq watermark captured by the coalesced wake timer. A connection
   * whose `lastSeq` is behind it has undelivered events even if `conn.wake`
   * was null at the moment the store change fired (lost-wakeup guard).
   */
  private wakeSeq = 0;
  private stopped = false;

  constructor(opts: HubOptions) {
    this.store = opts.store;
    this.presence = opts.presence;
    this.instanceId = opts.instanceId;
    this.lease = opts.lease ?? null;
    this.heartbeatMs = opts.heartbeatMs ?? envInt("FDE2E_REPORT_HUB_HEARTBEAT_MS", 15_000);
    this.maxPerAccount = opts.maxPerAccount ?? envInt("FDE2E_REPORT_HUB_MAX_PER_ACCOUNT", 8);
    this.maxStreams = opts.maxStreams ?? envInt("FDE2E_REPORT_HUB_MAX_STREAMS", 64);
    this.maxStreamMs = opts.maxStreamMs ?? envInt("FDE2E_REPORT_HUB_MAX_STREAM_MS", 30 * 60_000);
    this.replayLimit = opts.replayLimit ?? envInt("FDE2E_REPORT_HUB_REPLAY_LIMIT", 500);
    this.wakeDebounceMs = opts.wakeDebounceMs ?? 50;
    this.now = opts.now ?? Date.now;
    // Capture the watermark synchronously in the listener (the store is
    // guaranteed open while notifying); the debounce timer only wakes and must
    // never touch the DB — a test may close the store before it fires.
    this.unsubscribe = this.store.onChange(() => {
      this.wakeSeq = this.store.maxEventSeq();
      this.scheduleWake();
    });
  }

  /** serve.ts assigns the lease after `createApp` has built the app. */
  setLease(lease: IdleLease | null): void {
    this.lease = lease;
  }

  noteLegacyConnect(): void {
    this.legacyConnects += 1;
  }

  snapshot(): HubSnapshot {
    this.prune();
    const accounts = new Set<string>();
    for (const conn of this.connections.values()) accounts.add(conn.accountId);
    return {
      connections: this.connections.size,
      streams: this.connections.size,
      accounts: accounts.size,
      refused_total: this.refusedTotal,
      legacy_connects: this.legacyConnects,
      max_per_account: this.maxPerAccount,
      max_streams: this.maxStreams,
      heartbeat_ms: this.heartbeatMs,
    };
  }

  /**
   * Handshake admission. Already-aborted records never count (2s reconnect
   * grace: a frozen tab's socket may linger in the registry for a tick, but a
   * new handshake is not misjudged as over-limit because prune() drops them).
   */
  admit(accountId: string): boolean {
    this.prune();
    if (this.stopped || this.connections.size >= this.maxStreams) {
      this.refusedTotal += 1;
      return false;
    }
    let forAccount = 0;
    for (const conn of this.connections.values()) {
      if (conn.accountId === accountId) forAccount += 1;
    }
    if (forAccount >= this.maxPerAccount) {
      this.refusedTotal += 1;
      return false;
    }
    return true;
  }

  /** Push a `cursor` frame to every live connection of the account (multi-tab ack). */
  broadcastCursor(accountId: string, cursor: number, unreadCount: number): void {
    this.unreadCache.delete(accountId);
    for (const conn of this.connections.values()) {
      if (conn.accountId !== accountId || conn.closed || conn.stream.aborted) continue;
      conn.cursor = cursor;
      void this.writeControl(conn, "cursor", { cursor, unread_count: unreadCount });
    }
  }

  /**
   * 控制帧广播（无 DB 事件）：`plugin.updated` 等开关变化让所有标签页立即生效。
   * 漏帧由重连/设置页重新 `GET /api/plugins` 兜底。
   */
  broadcastControl(event: string, data: Record<string, unknown>): void {
    for (const conn of this.connections.values()) {
      if (conn.closed || conn.stream.aborted) continue;
      void this.writeControl(conn, event, data);
    }
  }

  /** Close every stream with `bye{shutdown}` (graceful server close). */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.changeTimer !== null) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    const conns = [...this.connections.values()];
    await Promise.all(
      conns.map(async (conn) => {
        if (conn.closed || conn.stream.aborted) {
          this.cleanup(conn);
          return;
        }
        await this.writeControl(conn, "bye", { reason: "shutdown" });
        this.cleanup(conn);
      }),
    );
  }

  /** Drop the store listener and release every registration (tests/shutdown). */
  dispose(): void {
    this.unsubscribe();
    if (this.changeTimer !== null) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    for (const conn of [...this.connections.values()]) this.cleanup(conn);
  }

  /**
   * Run one hub-mode SSE connection until the client aborts, the account dies,
   * the stream reaches `maxStreamMs`, or the hub shuts down.
   */
  async serve(opts: HubStreamOptions): Promise<void> {
    const { account, stream, signal } = opts;
    const now = this.now();
    const conn: Connection = {
      id: ++this.nextConnectionId,
      accountId: account.id,
      role: account.role,
      stream,
      cursor: this.store.getCursor(account.id),
      lastSeq: opts.since ?? 0,
      startedAt: now,
      nextHeartbeatAt: now + this.heartbeatMs,
      closed: false,
      wake: null,
      releasePresence: this.presence.connect(account.id),
      releaseLease: this.lease?.hold() ?? null,
    };
    this.connections.set(conn.id, conn);
    const cleanup = (): void => this.cleanup(conn);
    stream.onAbort(cleanup);
    const onSignalAbort = (): void => cleanup();
    signal?.addEventListener("abort", onSignalAbort);
    try {
      const helloAsOf = this.store.maxEventSeq();
      if (opts.since === null) conn.lastSeq = helloAsOf;
      await stream.writeSSE({
        event: "hello",
        data: JSON.stringify({
          hub: 2,
          account: account.id,
          role: account.role,
          cursor: conn.cursor,
          as_of_seq: helloAsOf,
          since: opts.since,
          replay_limit: this.replayLimit,
          heartbeat_ms: this.heartbeatMs,
          instance_id: this.instanceId,
          auth_mode: opts.authMode,
        }),
      });
      if (opts.since !== null) await this.replay(conn);
      // Events committed while `hello`/`replay`/`caught_up` were being written
      // cannot have set `conn.wake` (the loop was not waiting yet). Tail-check
      // the global max here so they are drained immediately instead of waiting
      // for the next heartbeat or the next unrelated write.
      let dirty = this.store.maxEventSeq() > conn.lastSeq;
      for (;;) {
        if (this.stopped || conn.closed || stream.aborted || signal?.aborted) return;
        const tick = this.now();
        const age = tick - conn.startedAt;
        if (age >= this.maxStreamMs) {
          await this.writeControl(conn, "bye", { reason: "recycle" });
          return;
        }
        // The coalesced wake timer may have fired while this connection was
        // busy writing: `conn.wake` was null then, but `wakeSeq` still records
        // that new events exist past `lastSeq`.
        if (!dirty && this.wakeSeq > conn.lastSeq) dirty = true;
        if (!dirty) {
          const waitMs = Math.max(
            1,
            Math.min(conn.nextHeartbeatAt - tick, this.maxStreamMs - age),
          );
          const woken = await this.waitWake(conn, waitMs);
          if (this.stopped || conn.closed || stream.aborted || signal?.aborted) return;
          dirty = woken || this.wakeSeq > conn.lastSeq;
        }
        if (dirty) {
          const current = this.store.getAccount(conn.accountId);
          if (!current || current.disabled !== 0) {
            await this.writeControl(conn, "bye", { reason: "auth" });
            return;
          }
          this.presence.touch(conn.accountId);
          await this.pump(conn);
          dirty = false;
          // A write landing after the pump snapshot must not wait for the next
          // change notification: loop again immediately to drain the tail.
          if (this.store.maxEventSeq() > conn.lastSeq) dirty = true;
        }
        const beatAt = this.now();
        if (beatAt >= conn.nextHeartbeatAt) {
          const current = this.store.getAccount(conn.accountId);
          if (!current || current.disabled !== 0) {
            await this.writeControl(conn, "bye", { reason: "auth" });
            return;
          }
          // `as_of_seq` = `conn.lastSeq` = the global `MAX(seq)` covered by this
          // connection's last COMPLETE scan (the delivered watermark). It is NOT
          // the last visible event's seq, and it is NOT `maxEventSeq()`: the
          // client advances its own lastSeq from this frame, so advertising a
          // value past an undelivered event would silently skip it. Do not
          // change this to maxEventSeq().
          await stream.writeSSE({
            event: "heartbeat",
            data: JSON.stringify({
              as_of_seq: conn.lastSeq,
              unread_count: this.unreadFor(conn.accountId),
            }),
          });
          conn.nextHeartbeatAt = beatAt + this.heartbeatMs;
          // Same lost-wakeup guard as above: a commit during the heartbeat
          // write must not wait for the next heartbeat interval.
          if (this.store.maxEventSeq() > conn.lastSeq) dirty = true;
        }
      }
    } finally {
      signal?.removeEventListener("abort", onSignalAbort);
      cleanup();
    }
  }

  /** Initial backlog: replay `since..as_of_seq`, then `caught_up` (never after reset). */
  private async replay(conn: Connection): Promise<void> {
    const page = this.store.eventLines({
      viewer: this.viewer(conn),
      since: conn.lastSeq,
      limit: this.replayLimit,
      includeSelf: true,
    });
    if (conn.lastSeq > page.as_of_seq) {
      await this.writeReset(conn, page.as_of_seq, "rollback");
      conn.lastSeq = page.as_of_seq;
      return;
    }
    if (page.truncated) {
      // Visible backlog exceeds the replay budget: declare a hole and jump the
      // watermark. No `caught_up` — the client must confirm via REST first.
      await this.writeReset(conn, page.as_of_seq, "replay_limit");
      conn.lastSeq = page.as_of_seq;
      return;
    }
    let replayed = 0;
    for (const line of page.lines) {
      await this.sendEvent(conn, line);
      conn.lastSeq = Math.max(conn.lastSeq, line.seq);
      replayed += 1;
    }
    conn.lastSeq = Math.max(conn.lastSeq, page.as_of_seq);
    await conn.stream.writeSSE({
      event: "caught_up",
      data: JSON.stringify({ as_of_seq: page.as_of_seq, replayed }),
    });
  }

  /** Incremental batch after a wake (same overflow rules as replay). */
  private async pump(conn: Connection): Promise<void> {
    const page = this.store.eventLines({
      viewer: this.viewer(conn),
      since: conn.lastSeq,
      limit: this.replayLimit,
      includeSelf: true,
    });
    if (conn.lastSeq > page.as_of_seq) {
      await this.writeReset(conn, page.as_of_seq, "rollback");
      conn.lastSeq = page.as_of_seq;
      return;
    }
    if (page.truncated) {
      await this.writeReset(conn, page.as_of_seq, "replay_limit");
      conn.lastSeq = page.as_of_seq;
      return;
    }
    for (const line of page.lines) {
      await this.sendEvent(conn, line);
      conn.lastSeq = Math.max(conn.lastSeq, line.seq);
    }
    conn.lastSeq = Math.max(conn.lastSeq, page.as_of_seq);
  }

  private viewer(conn: Connection): Viewer {
    return { id: conn.accountId, role: conn.role };
  }

  private async sendEvent(conn: Connection, line: EventLine): Promise<void> {
    await conn.stream.writeSSE({
      event: "hub",
      id: String(line.seq),
      data: JSON.stringify(line),
    });
  }

  private async writeReset(
    conn: Connection,
    asOfSeq: number,
    reason: "replay_limit" | "rollback",
  ): Promise<void> {
    await this.writeControl(conn, "reset", { as_of_seq: asOfSeq, reason });
  }

  private async writeControl(
    conn: Connection,
    event: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (conn.closed || conn.stream.aborted) return;
    await conn.stream.writeSSE({ event, data: JSON.stringify(data) });
  }

  /**
   * Wait for a coalesced change wake or the given timeout. Resolves `true` when
   * the hub woke the connection (store change or cleanup), `false` on timeout.
   */
  private waitWake(conn: Connection, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (woken: boolean): void => {
        if (done) return;
        done = true;
        conn.wake = null;
        if (timer !== null) clearTimeout(timer);
        resolve(woken);
      };
      conn.wake = () => finish(true);
      timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    });
  }

  private scheduleWake(): void {
    if (this.stopped || this.changeTimer !== null) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      // `wakeSeq` was recorded by the store listener; a connection busy in a
      // write has `conn.wake === null`, and the retained watermark is what lets
      // it notice the missed wake on its next loop iteration.
      for (const conn of this.connections.values()) conn.wake?.();
    }, this.wakeDebounceMs);
  }

  /** Drop aborted/closed records (never counted toward limits). */
  private prune(): void {
    for (const conn of [...this.connections.values()]) {
      if (conn.closed || conn.stream.aborted) this.cleanup(conn);
    }
  }

  private cleanup(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    this.connections.delete(conn.id);
    this.unreadCache.delete(conn.accountId);
    const wake = conn.wake;
    conn.wake = null;
    try {
      conn.releaseLease?.();
    } catch {
      // already released
    }
    conn.releaseLease = null;
    try {
      conn.releasePresence();
    } catch {
      // already released
    }
    wake?.();
  }

  /** `unread_count` for heartbeats, 5s TTL per account (design §3.3). */
  private unreadFor(accountId: string): number {
    const now = this.now();
    const cached = this.unreadCache.get(accountId);
    if (cached && now - cached.at < UNREAD_CACHE_TTL_MS) return cached.value;
    let value = cached?.value ?? 0;
    try {
      value = this.store.unreadCount(accountId);
    } catch {
      // account vanished mid-stream: keep the last known value; the loop's
      // account check will close the stream with bye{auth}.
    }
    this.unreadCache.set(accountId, { value, at: now });
    return value;
  }
}

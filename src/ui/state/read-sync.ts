/**
 * 服务端按帖已读的写路径队列（report-server-read-state design §5.4 / P1-7）。
 *
 * 纯逻辑（零 React / 零 DOM 假设），由 `notifications.tsx` 的 Provider 持有：
 * - 停留/点击先写本地 read-set（即时 UI），再 `enqueue` 到这里异步批量写服务端；
 * - per-account 持久化：`report.readq.v1:<base>:<account>`，失败保留、离线自动补；
 * - 250ms trailing debounce 合并 flush；持久化 250ms debounce（pagehide/hidden 同步落盘）；
 * - 每片 ≤100（服务端 `limits.reads_batch`）；上限 500 条 FIFO（超出丢最旧）；
 * - 失败退避 2s → 5s → 15s → 60s 后停止自动重试（等下一次 online/visible/ready）；
 * - 静态归档：`enqueue` no-op（不写 storage），`flush` 零请求；不建重试队列。
 */

export const READ_QUEUE_PREFIX = "report.readq.v1";
/** 旧本地 read-set 一次性上传完成标记（P1-13）。 */
export const READ_UPLOAD_MARKER_PREFIX = "report.read.uploaded.v1";
export const READ_QUEUE_LIMIT = 500;
export const READ_QUEUE_BATCH_SIZE = 100;
/** `GET /api/reads?ids=` 单次上限（design D13 `limits.reads_query`）。 */
export const READ_QUERY_LIMIT = 200;
export const READ_QUEUE_PERSIST_DEBOUNCE_MS = 250;
export const READ_QUEUE_FLUSH_DEBOUNCE_MS = 250;
/** 失败退避序列；用尽后不再自动重试，等下一次显式触发。 */
export const READ_QUEUE_BACKOFF_MS = [2_000, 5_000, 15_000, 60_000] as const;

export type ReadQueueStorage = Pick<Storage, "getItem" | "setItem">;

export interface ReadQueueTimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** 服务端写队列只需要一个方法：`ReportClient.markReads` 的窄接口。 */
export interface ReadQueueClient {
  markReads(postIds: string[]): Promise<{ stored: number; skipped?: string[] }>;
}

export interface ReadQueueEntry {
  post_id: string;
  queued_at: number;
}

export interface ReadQueueOptions {
  /** `null` = 不持久化（无账号/隐私模式退化为内存）。 */
  storageKey: string | null;
  storage?: ReadQueueStorage | null;
  /** 静态归档：enqueue no-op、flush 零请求。 */
  static?: boolean;
  client?: ReadQueueClient | null;
  limit?: number;
  batchSize?: number;
  persistDebounceMs?: number;
  flushDebounceMs?: number;
  timers?: ReadQueueTimerApi;
  now?: () => number;
  /** 一批写成功后回调（Provider 据此采纳 serverReadIds）。 */
  onAck?: (postIds: string[]) => void;
}

export interface ReadSyncDiagnostics {
  /** 当前待补写的帖子数（＝队列长度） */
  pending: number;
  /** 队列长度（与 pending 同值；便于 QA 直接读「queue size」语义） */
  queueSize: number;
  lastFlush: number | null;
  lastFlushOk: boolean | null;
  flushing: boolean;
  /** 成功发出的 batch 数（本次会话） */
  batches: number;
  failures: number;
}

export interface ReadQueueFlushResult {
  sent: number;
  failed: boolean;
}

export function readQueueStorageKey(base: string, accountId: string): string {
  return `${READ_QUEUE_PREFIX}:${base || "same-origin"}:${accountId}`;
}

export function readUploadMarkerKey(base: string, accountId: string): string {
  return `${READ_UPLOAD_MARKER_PREFIX}:${base || "same-origin"}:${accountId}`;
}

/** 解析持久化队列：容忍字符串/对象两种形态，去重（保留最早位置）并只留最近 `limit` 条。 */
export function parseReadQueue(raw: string | null, limit = READ_QUEUE_LIMIT): ReadQueueEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: ReadQueueEntry[] = [];
  const seen = new Set<string>();
  for (const value of parsed) {
    const postId =
      typeof value === "string"
        ? value
        : value && typeof value === "object" && typeof (value as { post_id?: unknown }).post_id === "string"
          ? (value as { post_id: string }).post_id
          : "";
    if (!postId || seen.has(postId)) continue;
    const queuedAt =
      value && typeof value === "object" && typeof (value as { queued_at?: unknown }).queued_at === "number"
        ? (value as { queued_at: number }).queued_at
        : 0;
    seen.add(postId);
    entries.push({ post_id: postId, queued_at: queuedAt });
  }
  return entries.slice(Math.max(0, entries.length - Math.max(0, limit)));
}

export interface LegacyUploadOptions {
  ids: readonly string[];
  client: ReadQueueClient;
  storage: ReadQueueStorage | null;
  markerKey: string | null;
  batchSize?: number;
}

export interface LegacyUploadResult {
  /** 本次是否真的发起过上传（marker 已存在/无 id/无 storage 时为 false）。 */
  attempted: boolean;
  /** 全部分片成功（marker 已写入）或无需上传。 */
  ok: boolean;
  batches: number;
}/**
 * P1-13：旧本地 read-set 一次性上传（≤2000，分片 100）。
 * 成功后写 `<markerKey>`；失败不写标记、下次 ready 重试；只上传传入的当前账号 ids。
 */
export async function uploadLegacyReadSet(options: LegacyUploadOptions): Promise<LegacyUploadResult> {
  const { ids, client, storage, markerKey } = options;
  const batchSize = options.batchSize ?? READ_QUEUE_BATCH_SIZE;
  if (!storage || !markerKey) return { attempted: false, ok: false, batches: 0 };
  try {
    if (storage.getItem(markerKey) !== null) return { attempted: false, ok: true, batches: 0 };
  } catch {
    return { attempted: false, ok: false, batches: 0 };
  }
  if (ids.length === 0) return { attempted: false, ok: true, batches: 0 };
  let batches = 0;
  for (let index = 0; index < ids.length; index += batchSize) {
    const chunk = ids.slice(index, index + batchSize);
    try {
      await client.markReads(chunk);
    } catch {
      return { attempted: true, ok: false, batches };
    }
    batches += 1;
  }
  try {
    storage.setItem(markerKey, String(Date.now()));
  } catch {
    // 写不进标记也视为上传完成（本次会话不再重复）；下次启动会重传（幂等）。
  }
  return { attempted: true, ok: true, batches };
}

/** 按上限切片（`GET /api/reads` 用；空数组返回 []）。 */
export function chunkIds(ids: readonly string[], size = READ_QUERY_LIMIT): string[][] {
  if (size <= 0) return ids.length > 0 ? [[...ids]] : [];
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

export interface ReadReconcilePlan {
  /** 需要采纳进 `serverReadIds` 的帖子（服务端返回的读行）。 */
  adopt: string[];
  /** 本地乐观缓存里“服务端没有且不在重试队列”的条目（服务端为准 → 丢弃）。 */
  orphans: string[];
}

/**
 * 对账规则（design §5.3 D6）：服务端返回的读行全部采纳；本地条目只要
 * 「不在服务端结果里」且「不在重试队列里」就丢弃。队列中的条目保留等待补写。
 */
export function planReadReconciliation(input: {
  localIds: readonly string[];
  queuedIds: ReadonlySet<string>;
  serverIds: ReadonlySet<string>;
}): ReadReconcilePlan {
  const adopt = [...input.serverIds];
  const orphans = input.localIds.filter(
    (id) => !input.serverIds.has(id) && !input.queuedIds.has(id),
  );
  return { adopt, orphans };
}

export interface ReadSources {
  serverReadIds: ReadonlySet<string>;
  localReadIds: ReadonlySet<string>;
  cursor: number;
}

/** 已读三源合并：服务端读集合 / 本地乐观缓存 / 游标水位任一命中即已读。 */
export function isReadFromSources(
  sources: ReadSources,
  targetId: string | null,
  seq: number,
): boolean {
  if (targetId && (sources.serverReadIds.has(targetId) || sources.localReadIds.has(targetId))) {
    return true;
  }
  return seq <= sources.cursor;
}

const DEFAULT_TIMERS: ReadQueueTimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const diagnostics: ReadSyncDiagnostics = {
  pending: 0,
  queueSize: 0,
  lastFlush: null,
  lastFlushOk: null,
  flushing: false,
  batches: 0,
  failures: 0,
};

let diagnosticsInstalled = false;

/** 安装只读诊断对象（`window.__reportReadSync`），QA 直接读 pending/lastFlush。 */
export function installReadSyncDiagnostics(
  target: Window | undefined = typeof window === "undefined" ? undefined : window,
): void {
  if (diagnosticsInstalled || !target) return;
  diagnosticsInstalled = true;
  try {
    Object.defineProperty(target, "__reportReadSync", {
      configurable: true,
      get: () => ({ ...diagnostics }),
    });
  } catch {
    // sandboxed/old browsers: diagnostics are best-effort only
  }
}

installReadSyncDiagnostics();

export function getReadSyncDiagnostics(): ReadSyncDiagnostics {
  return { ...diagnostics };
}

/** 账号切换/测试：把模块级诊断归零（避免上一账号的 pending 串读）。 */
export function resetReadSyncDiagnostics(): void {
  diagnostics.pending = 0;
  diagnostics.queueSize = 0;
  diagnostics.lastFlush = null;
  diagnostics.lastFlushOk = null;
  diagnostics.flushing = false;
  diagnostics.batches = 0;
  diagnostics.failures = 0;
}

/**
 * 服务端已读写队列。
 *
 * 幂等性由服务端 `INSERT … ON CONFLICT DO NOTHING` 保证；本类只负责
 * 「尽量送达 + 不阻塞 UI + 离线不丢」。
 */
export class ServerReadQueue {
  private entries: ReadQueueEntry[] = [];
  private storageKey: string | null;
  private storage: ReadQueueStorage | null;
  private readonly staticMode: boolean;
  private client: ReadQueueClient | null;
  private readonly limit: number;
  private readonly batchSize: number;
  private readonly persistDebounceMs: number;
  private readonly flushDebounceMs: number;
  private readonly timers: ReadQueueTimerApi;
  private readonly now: () => number;
  private readonly onAck: ((postIds: string[]) => void) | null;
  private persistTimer: unknown = null;
  private flushTimer: unknown = null;
  private retryTimer: unknown = null;
  private inflight: Promise<ReadQueueFlushResult> | null = null;
  /** switchKey/dispose 时递增：旧 flush 的结果不得写进新账号队列。 */
  private generation = 0;
  /** 连续失败次数（成功一批即归零）。 */
  private attempts = 0;
  private disposed = false;

  constructor(options: ReadQueueOptions) {
    this.storageKey = options.storageKey;
    this.storage = options.storage ?? null;
    this.staticMode = options.static === true;
    this.client = options.client ?? null;
    this.limit = options.limit ?? READ_QUEUE_LIMIT;
    this.batchSize = options.batchSize ?? READ_QUEUE_BATCH_SIZE;
    this.persistDebounceMs = options.persistDebounceMs ?? READ_QUEUE_PERSIST_DEBOUNCE_MS;
    this.flushDebounceMs = options.flushDebounceMs ?? READ_QUEUE_FLUSH_DEBOUNCE_MS;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.now = options.now ?? (() => Date.now());
    this.onAck = options.onAck ?? null;
    this.load();
    this.syncDiagnostics();
  }

  setClient(client: ReadQueueClient | null): void {
    this.client = client;
  }

  has(postId: string): boolean {
    return this.entries.some((entry) => entry.post_id === postId);
  }

  size(): number {
    return this.entries.length;
  }

  /** FIFO 快照（flush/对账用）。 */
  pending(): string[] {
    return this.entries.map((entry) => entry.post_id);
  }

  /** 入队（去重、FIFO、超上限丢最旧）；静默安排 250ms 合并 flush 与持久化。 */
  enqueue(postId: string): void {
    if (this.disposed || this.staticMode || !postId) return;
    if (this.has(postId)) return;
    this.entries.push({ post_id: postId, queued_at: this.now() });
    while (this.entries.length > this.limit) this.entries.shift();
    this.schedulePersist();
    this.scheduleFlush(this.flushDebounceMs);
    this.syncDiagnostics();
  }

  /** 只删除成功送达的项（失败保留）。 */
  ack(postIds: readonly string[]): void {
    if (postIds.length === 0) return;
    const done = new Set(postIds);
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => !done.has(entry.post_id));
    if (this.entries.length === before) return;
    this.schedulePersist();
    this.syncDiagnostics();
  }

  /** 250ms trailing debounce：多次 enqueue/ack 只写一次 localStorage。 */
  schedulePersist(): void {
    if (this.disposed || this.staticMode) return;
    if (!this.storageKey || !this.storage) return;
    if (this.persistTimer !== null) this.timers.clearTimeout(this.persistTimer);
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = null;
      this.flushPersist();
    }, this.persistDebounceMs);
  }

  /** 同步落盘（pagehide / hidden / switchKey / dispose）。 */
  flushPersist(): void {
    if (this.persistTimer !== null) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.write();
  }

  /** 排队一次合并 flush（退避期间不打断；已有定时器时不重复排）。 */
  scheduleFlush(delay = this.flushDebounceMs): void {
    if (this.disposed || this.staticMode || !this.client) return;
    // 退避定时器拥有下一次尝试：期间的新 enqueue 只合并进现有队列，不重置退避。
    if (this.retryTimer !== null) return;
    if (this.flushTimer !== null) return;
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delay);
  }

  /**
   * 立即 flush（单飞）：循环分片直到队列空或首批失败。
   * 失败不抛错（UI 不受影响），按 2s/5s/15s/60s 退避重试。
   * 显式调用（online/visible/ready）会取消退避并重新计数。
   */
  flush(): Promise<ReadQueueFlushResult> {
    if (this.disposed || this.staticMode || !this.client) {
      return Promise.resolve({ sent: 0, failed: false });
    }
    if (this.inflight) return this.inflight;
    if (this.flushTimer !== null) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer !== null) {
      // 显式触发优先于退避：取消旧定时器并重新给满退避预算。
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.attempts = 0;
    }
    const generation = this.generation;
    this.inflight = this.runFlush(generation).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** 账号/后端切换：先落盘旧队列，再装新账号的队列（不把旧 pending 写到新账号）。 */
  switchKey(storageKey: string | null, storage: ReadQueueStorage | null = null): void {
    this.flushPersist();
    this.generation += 1;
    this.entries = [];
    this.storageKey = storageKey;
    this.storage = storage;
    this.attempts = 0;
    if (this.flushTimer !== null) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer !== null) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.load();
    this.syncDiagnostics();
  }

  dispose(): void {
    if (this.disposed) return;
    this.flushPersist();
    this.disposed = true;
    if (this.flushTimer !== null) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer !== null) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.client = null;
    this.syncDiagnostics();
  }

  diagnostics(): ReadSyncDiagnostics {
    return {
      pending: this.entries.length,
      queueSize: this.entries.length,
      lastFlush: diagnostics.lastFlush,
      lastFlushOk: diagnostics.lastFlushOk,
      flushing: this.inflight !== null,
      batches: diagnostics.batches,
      failures: diagnostics.failures,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async runFlush(generation: number): Promise<ReadQueueFlushResult> {
    let sent = 0;
    while (this.entries.length > 0 && this.client && !this.disposed) {
      const batch = this.entries.slice(0, this.batchSize).map((entry) => entry.post_id);
      if (batch.length === 0) break;
      const client = this.client;
      try {
        await client.markReads(batch);
      } catch {
        if (generation !== this.generation) return { sent, failed: true };
        diagnostics.failures += 1;
        diagnostics.lastFlush = this.now();
        diagnostics.lastFlushOk = false;
        this.scheduleRetry();
        return { sent, failed: true };
      }
      if (generation !== this.generation || this.disposed) {
        // 队列已切到别的账号：不 ack、不回写，避免串号。
        return { sent, failed: false };
      }
      this.ack(batch);
      sent += batch.length;
      diagnostics.batches += 1;
      diagnostics.lastFlush = this.now();
      diagnostics.lastFlushOk = true;
      this.attempts = 0;
      this.onAck?.(batch);
      this.syncDiagnostics();
    }
    return { sent, failed: false };
  }

  private scheduleRetry(): void {
    if (this.disposed || this.staticMode || !this.client) return;
    if (this.attempts >= READ_QUEUE_BACKOFF_MS.length) return; // 用尽：等下一次显式触发
    const delay = READ_QUEUE_BACKOFF_MS[Math.min(this.attempts, READ_QUEUE_BACKOFF_MS.length - 1)]!;
    this.attempts += 1;
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
  }

  private load(): void {
    if (this.staticMode || !this.storageKey || !this.storage) {
      this.entries = [];
      return;
    }
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch {
      raw = null;
    }
    this.entries = parseReadQueue(raw, this.limit);
  }

  private write(): void {
    if (this.staticMode || !this.storageKey || !this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.entries));
    } catch {
      // private mode / quota：队列退化为本端内存，不阻塞已读交互。
    }
  }

  private syncDiagnostics(): void {
    diagnostics.pending = this.entries.length;
    diagnostics.queueSize = this.entries.length;
    diagnostics.flushing = this.inflight !== null;
  }
}

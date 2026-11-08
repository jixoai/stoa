/**
 * per-account 已读集合（report-read-dwell design §4.2/§4.3/§4.4）。
 *
 * 纯逻辑（零 React / 零 DOM 假设），由 `notifications.tsx` 的 Provider 持有：
 * - 上限 2000/账号，按「最近读取时间」LRU 淘汰（插入顺序＝最旧→最新）；
 * - 已在集合内的重复标记只 touch LRU，**不通知订阅者**、不产生重复持久化语义；
 * - per-post 外部订阅：一次标记只通知该 postId（及被淘汰的 id）的订阅者；
 * - 持久化 250ms trailing debounce；`flush()` 供 pagehide/hidden/卸载同步落盘；
 * - key 不变：`report.read.v1:<base>:<account>`；体积预算 <150KB/账号。
 */

export const READ_SET_PREFIX = "report.read.v1";
/** Owner 2026-11-08 拍板：2000/账号。 */
export const READ_SET_LIMIT = 2000;
export const READ_SET_PERSIST_DEBOUNCE_MS = 250;

export type ReadSetStorage = Pick<Storage, "getItem" | "setItem">;

export interface ReadSetTimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReadSetStoreOptions {
  storageKey: string | null;
  storage?: ReadSetStorage | null;
  limit?: number;
  debounceMs?: number;
  /** 每次真正写入 localStorage 后调用（供诊断计数）。 */
  onPersist?: () => void;
  timers?: ReadSetTimerApi;
}

export interface ReadSetMarkResult {
  changed: boolean;
  evicted: string[];
}

export function readSetStorageKey(base: string, accountId: string): string {
  return `${READ_SET_PREFIX}:${base || "same-origin"}:${accountId}`;
}

/** 解析持久化值：去重（保留最后出现位置）并只保留最近 `limit` 条。 */
export function parseReadSet(raw: string | null, limit = READ_SET_LIMIT): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ordered = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== "string" || value.length === 0) continue;
    // LRU 语义：重复 id 视为最近一次读取，移到队尾。
    if (ordered.has(value)) ordered.delete(value);
    ordered.add(value);
  }
  while (ordered.size > limit) {
    const oldest = ordered.values().next().value;
    if (oldest === undefined) break;
    ordered.delete(oldest);
  }
  return [...ordered];
}

const DEFAULT_TIMERS: ReadSetTimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ReadSetStore {
  private ids = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();
  private storageKey: string | null;
  private storage: ReadSetStorage | null;
  private readonly limit: number;
  private readonly debounceMs: number;
  private readonly onPersist: (() => void) | null;
  private readonly timers: ReadSetTimerApi;
  private persistTimer: unknown = null;
  private disposed = false;

  constructor(options: ReadSetStoreOptions) {
    this.storageKey = options.storageKey;
    this.storage = options.storage ?? null;
    this.limit = options.limit ?? READ_SET_LIMIT;
    this.debounceMs = options.debounceMs ?? READ_SET_PERSIST_DEBOUNCE_MS;
    this.onPersist = options.onPersist ?? null;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.load();
  }

  has(postId: string): boolean {
    return this.ids.has(postId);
  }

  size(): number {
    return this.ids.size;
  }

  /** 最旧→最新的快照（持久化顺序）。 */
  values(): string[] {
    return [...this.ids];
  }

  /** React state 用的副本（每次变更后重新取）。 */
  snapshot(): Set<string> {
    return new Set(this.ids);
  }

  /**
   * 标记已读：新 id 追加到 LRU 队尾并通知该 id 的订阅者；已存在则只 touch
   * （移到队尾）+ 排一次持久化，不通知。超过上限时淘汰最久未读条目并通知其订阅者
   * （UI 需要重新显示未读）。
   */
  mark(postId: string): ReadSetMarkResult {
    if (!postId) return { changed: false, evicted: [] };
    const existed = this.ids.has(postId);
    // Set 的插入顺序就是 LRU 顺序：先删再 add = 移到最近使用端。
    this.ids.delete(postId);
    this.ids.add(postId);
    if (existed) {
      this.schedulePersist();
      return { changed: false, evicted: [] };
    }
    const evicted: string[] = [];
    while (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
      evicted.push(oldest);
    }
    this.schedulePersist();
    this.notify([postId, ...evicted]);
    return { changed: true, evicted };
  }

  /**
   * 服务端对账：删除「服务端没有且不在重试队列」的本地乐观条目（服务端为准）。
   * 只通知被删除的 id（对应卡片需要重新显示未读）。
   */
  remove(postIds: readonly string[]): string[] {
    const removed: string[] = [];
    for (const postId of postIds) {
      if (this.ids.delete(postId)) removed.push(postId);
    }
    if (removed.length > 0) {
      this.schedulePersist();
      this.notify(removed);
    }
    return removed;
  }

  /** 账号切换：清空当前集合（内存/持久化），并通知全部订阅者。 */
  clear(): void {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this.schedulePersist();
    this.notifyAll();
  }

  /** 只通知该 postId 的订阅者（一次停留不惊动整列表）。 */
  subscribe(postId: string, listener: () => void): () => void {    let group = this.listeners.get(postId);
    if (!group) {
      group = new Set();
      this.listeners.set(postId, group);
    }
    group.add(listener);
    return () => {
      const current = this.listeners.get(postId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(postId);
    };
  }

  /** ack（游标推进）/ 账号切换：全部已读态可能变化，通知所有订阅者一次。 */
  notifyAll(): void {
    for (const group of this.listeners.values()) {
      for (const listener of [...group]) listener();
    }
  }

  /** 250ms trailing debounce；期间多次标记只写一次。 */
  schedulePersist(): void {
    if (this.disposed) return;
    if (!this.storageKey || !this.storage) return;
    if (this.persistTimer !== null) this.timers.clearTimeout(this.persistTimer);
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = null;
      this.write();
    }, this.debounceMs);
  }

  /** 同步落盘（pagehide / visibilitychange hidden / Provider 卸载）。 */
  flush(): void {
    if (this.persistTimer !== null) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.write();
  }

  /** 账号/后端切换：先把旧账号排队的变更写掉，再装新账号的集合并通知全部。 */
  switchKey(storageKey: string | null, storage: ReadSetStorage | null = null): void {
    this.flush();
    this.storageKey = storageKey;
    this.storage = storage;
    this.load();
    this.notifyAll();
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
    this.listeners.clear();
  }

  private load(): void {
    if (!this.storageKey || !this.storage) {
      this.ids = new Set();
      return;
    }
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch {
      raw = null;
    }
    this.ids = new Set(parseReadSet(raw, this.limit));
  }

  private write(): void {
    if (!this.storageKey || !this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.values()));
      this.onPersist?.();
    } catch {
      // private mode / quota：读集合退化为本端内存，不阻塞已读交互。
    }
  }

  private notify(postIds: readonly string[]): void {
    for (const postId of postIds) {
      const group = this.listeners.get(postId);
      if (!group) continue;
      for (const listener of [...group]) listener();
    }
  }
}

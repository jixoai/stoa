/**
 * 会话链拓扑缓存（report-notification-stacks design §4.3；无 React，可单测）。
 *
 * - 按帖 O(1) 缓存 `LineageNode`；账号/后端切换由调用方 `clear()`；
 * - `ensure(ids)`：过滤已缓存 id → trailing debounce（默认 150ms）合并成一批请求；
 *   单次端点上限 200 id → 超限分片（片数 = ⌈N/200⌉，每片仍是「一个合并批」）；
 * - 在途请求按批次去重（flush 串行，pending 累积到下一批）；
 * - 失败不阻塞 UI：不缓存、不重试风暴；该批目标以 self 锚点先行，下一次事件/对账再补；
 * - `markDeleted(postId)`：`post.deleted` 就地更新 `deleted_at`（不改 parent）。
 */
import type { LineageNode, LineageResponse } from "@core/types";
import { LINEAGE_IDS_LIMIT } from "@core/protocol";

export interface LineageClient {
  postLineage(ids: readonly string[]): Promise<LineageResponse>;
}

export interface LineageCacheOptions {
  /** 取当前客户端；返回 null（静态归档/未登录）时 `ensure` 不发任何请求。 */
  client(): LineageClient | null;
  /** 缓存变化（新节点/删除标记）时回调，用于触发重算。 */
  onChange(): void;
  debounceMs?: number;
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export const LINEAGE_DEBOUNCE_MS = 150;

export class LineageCache {
  private readonly nodes = new Map<string, LineageNode>();
  private readonly pendingIds = new Set<string>();
  private timer: unknown = null;
  private inflight: Promise<void> | null = null;
  /** `clear()` 递增：切换账号/后端后在途响应直接丢弃（防串号）。 */
  private epoch = 0;
  /** 累计请求数（诊断 `lineageRequests`；每合并批 ≤1 次） */
  requests = 0;
  /** 累计失败数（诊断 `lineageFailures`） */
  failures = 0;

  private readonly client: () => LineageClient | null;
  private readonly onChange: () => void;
  private readonly debounceMs: number;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(opts: LineageCacheOptions) {
    this.client = opts.client;
    this.onChange = opts.onChange;
    this.debounceMs = opts.debounceMs ?? LINEAGE_DEBOUNCE_MS;
    this.setTimer =
      opts.setTimeoutFn ?? ((handler, ms) => globalThis.setTimeout(handler, ms));
    this.clearTimer = opts.clearTimeoutFn ?? ((handle) => globalThis.clearTimeout(handle as never));
  }

  get(id: string): LineageNode | null {
    return this.nodes.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  get size(): number {
    return this.nodes.size;
  }

  values(): IterableIterator<LineageNode> {
    return this.nodes.values();
  }

  /** 待请求 id（测试/诊断用；生产不暴露到 UI）。 */
  get pendingCount(): number {
    return this.pendingIds.size;
  }

  /** 批量补拉：过滤已缓存 id，150ms 合并批。空集/无客户端时零请求。 */
  ensure(ids: Iterable<string>): void {
    if (!this.client()) return;
    let added = false;
    for (const id of ids) {
      if (!id || this.nodes.has(id) || this.pendingIds.has(id)) continue;
      this.pendingIds.add(id);
      added = true;
    }
    if (!added) return;
    this.schedule();
  }

  /** 立即发送待请求批（测试与 pagehide 用；串行于在途请求）。 */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        /* 已计数 */
      }
    }
    const client = this.client();
    if (!client || this.pendingIds.size === 0) return;
    // 端点单次上限 200（`LINEAGE_IDS_LIMIT`）：超限分片，片数 = ⌈N/200⌉。
    const ids = [...this.pendingIds];
    this.pendingIds.clear();
    const chunks: string[][] = [];
    for (let index = 0; index < ids.length; index += LINEAGE_IDS_LIMIT) {
      chunks.push(ids.slice(index, index + LINEAGE_IDS_LIMIT));
    }
    let changed = false;
    const task = (async () => {
      for (const chunk of chunks) {
        const epochAtStart = this.epoch;
        this.requests += 1;
        try {
          const { nodes } = await client.postLineage(chunk);
          if (this.epoch !== epochAtStart) return; // 账号/后端已切换：丢弃旧响应
          for (const node of nodes) {
            if (!node?.id) continue;
            this.nodes.set(node.id, node);
            changed = true;
          }
        } catch {
          if (this.epoch === epochAtStart) this.failures += 1;
        }
      }
    })();
    this.inflight = task;
    try {
      await task;
    } finally {
      if (this.inflight === task) this.inflight = null;
    }
    if (changed) this.onChange();
    if (this.pendingIds.size > 0) this.schedule();
  }

  /**
   * `post.deleted` 就地更新：置 `deleted_at`（不改 parent，触发重新分组）。
   * 未知节点 no-op（下次 lineage 会带墓碑）。
   */
  markDeleted(postId: string, at?: number): boolean {
    const node = this.nodes.get(postId);
    if (!node || node.deleted_at !== null) return false;
    this.nodes.set(postId, { ...node, deleted_at: at ?? Date.now() });
    this.onChange();
    return true;
  }

  /** 账号/后端切换清空（epoch 递增：在途响应在 resolve 时被丢弃）。 */
  clear(): void {
    this.epoch += 1;
    this.nodes.clear();
    this.pendingIds.clear();
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }
}

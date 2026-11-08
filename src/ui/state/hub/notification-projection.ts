/**
 * 通知投影状态（design §4.7；零 React，可单测）。
 *
 * 语义基线（report-notification-history-and-read）：
 * - 单帖已读只写本端 read-set；`ack()`（全部已读）唯一推进服务端游标、唯一清空投影；
 * - history 只补列表完整性；实时流只做增量与未读计数；refresh 是 union 不删行。
 *
 * 角标（每帖口径，实测校正见 README 报告）：
 * - 服务端 `unread_count` 是**事件数**：一次 @ 提醒会同时产生 `post.created` +
 *   `thread.invited` 两条事件，但 UI 只展示一行、角标只应 +1。
 * - 因此角标 = 服务端 `unread_by_target` 里**不同 target 的个数**
 *   （扣掉本端 read-set 命中的 target） + 尚未被下一次对账吸收的本地新 target。
 * - `post_deleted=true` 的帧、自身事件、`seq ≤ cursor` 的帧都不计数；
 *   `post.deleted` 扣减该 target 并触发一次对账（服务端计数兜底）。
 */
import type { HubEventLine } from "./types";

export interface ProjectedEvent {
  event: HubEventLine;
  /** 该事件指向的帖子已删除（post.deleted 或读时 post_deleted 投影） */
  deleted: boolean;
}

export interface NotificationSnapshotInput {
  cursor: number;
  /** 服务端游标口径的事件数（仅用于对账漂移检测） */
  unreadCount: number;
  /** 按 target 分组的未读事件数（`COALESCE(post_id, root_id)`） */
  unreadByTarget: Record<string, number>;
  events?: readonly HubEventLine[];
}

function targetOf(event: HubEventLine): string | null {
  return event.post_id ?? event.root_id ?? null;
}

function isNotificationType(type: string): boolean {
  return type === "post.created" || type === "thread.invited";
}

export class NotificationProjection {
  readonly me: string | null;
  cursor = 0;
  /** 服务端权威：每个 target 的未读事件数（只保留 >0） */
  serverTargets = new Map<string, number>();
  /** 服务端权威的未读事件总数（peek/heartbeat/ack 对账） */
  serverUnreadEvents = 0;
  /** 快照之后新到的 target（尚未被下一次服务端快照吸收） */
  localTargets = new Set<string>();
  /** 快照之后的事件级增量（正=新事件，负=本地观察到的删除；对账后清零） */
  localEventDelta = 0;
  /** seq → 事件（通知类型；列表与 history 按 seq 合并） */
  events = new Map<number, ProjectedEvent>();
  /** 由实时帧计入 localEventDelta 的 seq（删除扣减只对这些生效，避免与快照重复扣） */
  private locallyCounted = new Set<number>();

  constructor(me: string | null) {
    this.me = me;
  }

  /**
   * peek / heartbeat 对账落地：服务端快照替换计数基线，本地增量清零；
   * 事件按 seq union（不删已有行——唯一清空路径是 ack）。
   *
   * 乱序保护（review 非阻塞项）：快照的 `cursor` 小于本地已落地游标时（例如 ack 前
   * 发出的 peek 在 ack 之后才回来），只 union 事件，**不覆盖**计数基线，避免角标
   * 被旧快照顶回去。
   */
  applySnapshot(input: NotificationSnapshotInput): void {
    const previousCursor = this.cursor;
    this.cursor = Math.max(this.cursor, input.cursor ?? 0);
    const stale = (input.cursor ?? 0) < previousCursor;
    if (!stale) {
      this.serverUnreadEvents = Math.max(0, input.unreadCount ?? 0);
      this.serverTargets = new Map();
      for (const [target, count] of Object.entries(input.unreadByTarget ?? {})) {
        if (typeof count === "number" && count > 0) this.serverTargets.set(target, count);
      }
      this.localTargets.clear();
      this.localEventDelta = 0;
      this.locallyCounted.clear();
    }
    for (const event of input.events ?? []) {
      if (!isNotificationType(event.type)) continue;
      this.mergeEvent(event);
    }
  }

  /** 数据帧增量。返回 true = 该 seq 是新的（幂等：重复帧 no-op）。 */
  applyEvent(event: HubEventLine): boolean {
    if (!isNotificationType(event.type)) return false;
    if (this.events.has(event.seq)) return false;
    const counted = this.countEvent(event);
    this.events.set(event.seq, {
      event,
      deleted: event.post_deleted === true,
    });
    if (!counted) return true;
    this.localEventDelta += 1;
    this.locallyCounted.add(event.seq);
    const target = targetOf(event);
    if (target && !this.serverTargets.has(target)) this.localTargets.add(target);
    return true;
  }

  /**
   * `post.deleted`：把该 target 的未读事件逐条标记 deleted（每 seq 一次）。
   * 返回受影响的 target 与「是否需要服务端对账」（本地事件不完整时以服务端为准）。
   */
  applyDelete(postId: string | null, rootId: string | null): {
    removed: string[];
    needsReconcile: boolean;
  } {
    const target = postId ?? rootId;
    if (!target) return { removed: [], needsReconcile: false };
    let changed = false;
    for (const projected of this.events.values()) {
      if (targetOf(projected.event) !== target) continue;
      if (projected.deleted) continue;
      projected.deleted = true;
      changed = true;
      if (this.locallyCounted.delete(projected.event.seq)) this.localEventDelta -= 1;
    }
    const serverCount = this.serverTargets.get(target) ?? 0;
    if (serverCount > 0) {
      this.serverTargets.delete(target);
      this.serverUnreadEvents = Math.max(0, this.serverUnreadEvents - serverCount);
      changed = true;
    }
    if (this.localTargets.delete(target)) changed = true;
    return { removed: changed ? [target] : [], needsReconcile: true };
  }

  /** `cursor` 帧 / ack 响应：游标推进后全部未读投影清空（唯一清空路径之一）。 */
  applyCursor(cursor: number, unreadCount: number): void {
    this.cursor = Math.max(this.cursor, cursor ?? 0);
    this.serverUnreadEvents = Math.max(0, unreadCount ?? 0);
    this.serverTargets.clear();
    this.localTargets.clear();
    this.localEventDelta = 0;
    this.locallyCounted.clear();
  }

  /** ack 的唯一清空语义：清实时事件（posts 投影由调用方保留给历史行）。 */
  clearEvents(): void {
    this.events.clear();
  }

  /** 最近一次服务端快照的无偏期望值（heartbeat 漂移检测用）。 */
  expectedUnreadEvents(): number {
    return Math.max(0, this.serverUnreadEvents + this.localEventDelta);
  }

  /** 每帖口径角标：不同 target 数 − read-set 命中（read-set 只影响本端）。 */
  badge(readIds: ReadonlySet<string>): number {
    let count = 0;
    for (const target of this.serverTargets.keys()) {
      if (!readIds.has(target)) count += 1;
    }
    for (const target of this.localTargets) {
      if (readIds.has(target)) continue;
      if (this.serverTargets.has(target)) continue;
      count += 1;
    }
    return count;
  }

  /** 供 UI 判断「还有 N 条未读」：服务端不同 target 数（不扣 read-set）。 */
  unreadTargetCount(): number {
    let count = this.serverTargets.size;
    for (const target of this.localTargets) {
      if (!this.serverTargets.has(target)) count += 1;
    }
    return count;
  }

  private countEvent(event: HubEventLine): boolean {
    if (event.post_deleted === true) return false;
    if (this.me !== null && event.actor === this.me) return false;
    if (event.seq <= this.cursor) return false;
    return true;
  }

  private mergeEvent(event: HubEventLine): void {
    const existing = this.events.get(event.seq);
    if (existing) {
      if (event.post_deleted === true) existing.deleted = true;
      existing.event = event;
      return;
    }
    this.events.set(event.seq, {
      event,
      deleted: event.post_deleted === true,
    });
  }
}

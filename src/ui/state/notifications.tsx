/**
 * 通知状态：历史列表由页面单独分页拉取；这里维护「未读提醒」的实时投影
 * （EventHub 增量 + peek 对账）以及**按帖已读**的本地读集合。
 *
 * 硬规则（report-notification-history-and-read + report-event-hub §4.7）：
 * - 未读判定 = `target ∈ readSet ∪ seq ≤ cursor`；单帖已读只写本端 read-set，
 *   **不推进服务端游标**；`ack()`（全部已读）是唯一推进游标与唯一清空路径。
 * - 刷新是 union 合并，不是替换：peek 快照只补新行，内存里已有的行不因游标推进消失。
 * - 角标 = 服务端 `unread_by_target` 的**不同 target 数** − read-set 命中的 target，
 *   加上快照之后新到、尚未被下一次对账吸收的本地 target。服务端 `unread_count`
 *   是事件数（一次 @ 会同时产生 post.created + thread.invited），只用于漂移对账。
 * - `post_deleted=true` 的帧与 `post.deleted` 本身不计数；删除未读帖立即扣减并
 *   排一次服务端对账兜底。
 * - 心跳/60s 只做**漂移检测**：计数一致时零业务请求（空闲不轮询）。
 * - 启动只有 1 次 peek；逐帖 hydrate 只在通知页按需发生（`ensurePosts`）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { NotificationEventLine, PostView } from "@core/types";
import { useConnection } from "@/state/connection";
import { NotificationProjection } from "@/state/hub/notification-projection";
import { useEventHub, useEventHubApi, useHubStatus } from "@/state/hub/provider";
import type { HubEventLine } from "@/state/hub/types";

export interface NotificationItem {
  /** 代表事件（同帖多条提醒取 post.created 优先；用于文案/时间） */
  event: NotificationEventLine;
  /** 同一帖子（targetId）的全部事件，按 seq 倒序 */
  events: NotificationEventLine[];
  /** hydrated post; null when the post is gone / not visible to this viewer */
  post: PostView | null;
  /** navigation target (event.post_id ?? event.root_id) */
  targetId: string | null;
  deleted: boolean;
  /** 组内事件全部已读才算该帖已读（按帖粒度展示与计数） */
  read: boolean;
  /** 组内最大 seq（列表排序/角标同源） */
  sortSeq: number;
}

interface NotificationsValue {
  /** newest-first groups (one row per post) */
  items: NotificationItem[];
  /** 原始实时事件（未分组，页面与历史合并后统一分组） */
  liveEvents: NotificationEventLine[];
  /** 每帖口径未读角标（read-set 已扣减） */
  unread: number;
  /** 服务端已读水位（seq ≤ 该值的事件视为已读；「全部已读」推进） */
  ackedSeq: number;
  /** 已删除帖子的提醒数（按帖，仅删除，不再混入已读） */
  deletedCount: number;
  /** initial REST load or post hydration in flight */
  loading: boolean;
  hydrating: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  ack: () => Promise<void>;
  /** 打开某帖详情时调用：只把该帖标记为已读（本端读集合） */
  markPostRead: (postId: string) => void;
  /** 统一已读判定：target 在本地读集合，或事件 seq ≤ 已 ack 游标 */
  isRead: (targetId: string | null, seq: number) => boolean;
  /** 通知历史行取帖子投影（undefined = 尚未取回） */
  postOf: (postId: string) => PostView | null | undefined;
  /** 请求补拉一批帖子投影（历史列表用） */
  ensurePosts: (postIds: string[]) => void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

const HYDRATE_CONCURRENCY = 8;
const READ_SET_PREFIX = "report.read.v1";
/** 读集合本地上限：只保留最近加入的 N 个，避免 localStorage 无界增长。 */
const READ_SET_LIMIT = 500;
/** 实时删除/游标变化后的对账延迟（合并同一批推送） */
const RECONCILE_DEBOUNCE_MS = 400;
/** 心跳/60s 漂移检测窗口 */
const DRIFT_CHECK_MS = 60_000;

function targetIdOf(event: NotificationEventLine): string | null {
  return event.post_id ?? event.root_id ?? null;
}

function readSetStorageKey(base: string, accountId: string): string {
  return `${READ_SET_PREFIX}:${base || "same-origin"}:${accountId}`;
}

function loadReadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0));
  } catch {
    return new Set();
  }
}

/** peek 的 `events` 里混有 thread.snapshot：只保留带 seq 的通知事件。 */
function eventLinesOf(lines: readonly unknown[]): HubEventLine[] {
  const out: HubEventLine[] = [];
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const row = line as Partial<HubEventLine>;
    if (typeof row.seq !== "number" || typeof row.type !== "string") continue;
    if (row.type !== "post.created" && row.type !== "thread.invited") continue;
    out.push(row as HubEventLine);
  }
  return out;
}

/**
 * 事件 → 按帖分组（UI/角标的最小单元是「一个帖子一条提醒」）。
 *
 * 同一帖的 post.created 与 thread.invited 是同一件事的两条事件：列表只展示一行、
 * 角标只计 1，打开一次即两条都读（验收口径：两帖未读开一帖 → 角标 -1）。
 * 无 target 的事件（极少数协议事件）按事件自身独立成行。
 * 帖子投影尚未取回（undefined）的组暂不发布；删除态（null）发布为「已删除」行。
 */
export function groupNotificationEvents(
  events: Iterable<NotificationEventLine>,
  postOf: (postId: string) => PostView | null | undefined,
  isRead: (targetId: string | null, seq: number) => boolean,
): NotificationItem[] {
  const groups = new Map<string, NotificationEventLine[]>();
  for (const event of events) {
    const targetId = targetIdOf(event);
    const key = targetId ?? `event:${event.seq}`;
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }
  const rows: NotificationItem[] = [];
  for (const group of groups.values()) {
    const targetId = targetIdOf(group[0]!);
    const post = targetId ? postOf(targetId) : null;
    if (typeof post === "undefined") continue;
    group.sort((a, b) => b.seq - a.seq);
    const representative = group.find((event) => event.type === "post.created") ?? group[0]!;
    const sortSeq = group[0]!.seq;
    rows.push({
      event: representative,
      events: group,
      post: post ?? null,
      targetId,
      deleted: Boolean(post) ? post!.deleted_at !== null : Boolean(targetId),
      read: group.every((event) => isRead(targetId, event.seq)),
      sortSeq,
    });
  }
  return rows.sort((a, b) => b.sortSeq - a.sortSeq);
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { client, account, staticMode } = useConnection();
  const hub = useEventHubApi();
  const hubStatus = useHubStatus();

  const [projection, setProjection] = useState<NotificationProjection>(
    () => new NotificationProjection(account?.id ?? null),
  );
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((value) => value + 1), []);

  const [posts, setPosts] = useState<Map<string, PostView | null>>(() => new Map());
  const accountRef = useRef(account?.id ?? null);
  accountRef.current = account?.id ?? null;
  const storageKey = accountRef.current
    ? readSetStorageKey(client?.base ?? "", accountRef.current)
    : null;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  // 读集合在首帧就同步装好（而不是等 effect）：深链直接进详情时，ThreadPage 的
  // markPostRead 可能早于父级 effect 执行，异步加载会把它覆盖掉。
  const [readIds, setReadIds] = useState<Set<string>>(() =>
    storageKey && !staticMode ? loadReadSet(storageKey) : new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [hydrating, setHydrating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const postsRef = useRef(posts);
  postsRef.current = posts;
  const hydrationToken = useRef(0);
  const appliedStorageKey = useRef(storageKey);
  const reconcileTimer = useRef<number | null>(null);
  const lastHeartbeat = useRef<{ asOfSeq: number; unreadCount: number } | null>(null);
  /** client/account 组合：变了才重建投影（挂载首帧不重建，保证启动只有 1 次 peek）。 */
  const projectionKey = `${client?.base ?? ""}|${account?.id ?? ""}`;
  const projectionKeyRef = useRef(projectionKey);

  const persistReadSet = useCallback(
    (next: Set<string>) => {
      const key = storageKeyRef.current;
      if (!key || staticMode) return;
      try {
        localStorage.setItem(key, JSON.stringify([...next].slice(-READ_SET_LIMIT)));
      } catch {
        // private mode / quota: 读集合退化为本端内存，不阻塞已读交互
      }
    },
    [staticMode],
  );

  // 账号/后端切换：读集合与实时投影都换成该账号自己的（避免串号）。
  // 首次挂载已由 useState 懒初始化装好；这里只处理「键变了」。
  // 注意：挂载时必须**不**重置（否则会多出一次启动 peek）。
  useEffect(() => {
    if (appliedStorageKey.current !== storageKey) {
      appliedStorageKey.current = storageKey;
      setReadIds(staticMode || !storageKey ? new Set() : loadReadSet(storageKey));
    }
    if (projectionKeyRef.current === projectionKey) return;
    projectionKeyRef.current = projectionKey;
    const next = new NotificationProjection(accountRef.current);
    projectionRef.current = next;
    setProjection(next);
    setPosts(new Map());
    lastHeartbeat.current = null;
    bump();
    // 新投影由下面的 refresh effect（client 变化会重建 refresh）重新取一次快照。
  }, [storageKey, projectionKey, staticMode, bump]);

  const hydratePosts = useCallback(
    async (ids: string[], force = false) => {
      if (!client || ids.length === 0) return;
      const missing = force ? ids : ids.filter((id) => !postsRef.current.has(id));
      if (missing.length === 0) return;
      const token = ++hydrationToken.current;
      setHydrating(true);
      const results: Array<readonly [string, PostView | null]> = [];
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= missing.length) return;
          const id = missing[index]!;
          try {
            results.push([id, await client.post(id)] as const);
          } catch {
            // deleted / not visible / network: treat as unavailable, never as unread
            results.push([id, null] as const);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(HYDRATE_CONCURRENCY, missing.length) }, () => worker()),
      );
      setPosts((prev) => {
        const next = new Map(prev);
        for (const [id, post] of results) next.set(id, post);
        return next;
      });
      if (hydrationToken.current === token) setHydrating(false);
    },
    [client],
  );

  /**
   * 一次 peek 快照：服务端游标/未读计数/按 target 分组落地；事件按 seq union。
   * 不做逐帖 hydrate（首屏 0 次 /api/posts/:id；通知页自己 ensurePosts）。
   */
  const refresh = useCallback(async () => {
    if (!client) return;
    const initial = projectionRef.current.events.size === 0;
    if (initial) setLoading(true);
    try {
      const result = await client.notifications({ peek: true, limit: 100 });
      projectionRef.current.applySnapshot({
        cursor: result.cursor ?? 0,
        unreadCount: result.unread_count ?? 0,
        unreadByTarget: result.unread_by_target ?? {},
        events: eventLinesOf(result.events ?? []),
      });
      setError(null);
      bump();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client, bump]);

  /** 轻量对账（peek&limit=1）：只刷新 unread_count / unread_by_target / cursor。 */
  const reconcile = useCallback(async () => {
    if (!client) return;
    try {
      const result = await client.notifications({ peek: true, limit: 1 });
      projectionRef.current.applySnapshot({
        cursor: result.cursor ?? 0,
        unreadCount: result.unread_count ?? 0,
        unreadByTarget: result.unread_by_target ?? {},
        events: [],
      });
      bump();
    } catch {
      // 对账失败不打扰用户：下一轮 heartbeat/60s 再试
    }
  }, [client, bump]);

  const scheduleReconcile = useCallback(
    (delay = RECONCILE_DEBOUNCE_MS) => {
      if (staticMode || typeof window === "undefined") return;
      if (reconcileTimer.current !== null) window.clearTimeout(reconcileTimer.current);
      reconcileTimer.current = window.setTimeout(() => {
        reconcileTimer.current = null;
        void reconcile();
      }, delay);
    },
    [reconcile, staticMode],
  );

  useEffect(() => {
    return () => {
      if (reconcileTimer.current !== null) {
        window.clearTimeout(reconcileTimer.current);
        reconcileTimer.current = null;
      }
    };
  }, []);

  // 启动只有 1 次 peek（design §7.4）；进通知页不再 re-peek。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 删除事件落到帖子投影：通知行立即转「已删除」，不等下一次 hydrate。 */
  const markPostDeleted = useCallback((postId: string) => {
    setPosts((prev) => {
      if (prev.get(postId) === null) return prev;
      const next = new Map(prev);
      next.set(postId, null);
      return next;
    });
  }, []);

  // Hub 增量 + 对账通道（handler 走 ref，不触发 render）。
  useEventHub(
    [
      "notification.created",
      "post.deleted",
      "cursor.acked",
      "stream.reset",
      "stream.reconnected",
      "stream.heartbeat",
    ],
    (dispatch) => {
      if (staticMode) return;
      const current = projectionRef.current;
      switch (dispatch.topic) {
        case "notification.created": {
          const added = current.applyEvent(dispatch.event);
          if (!added) return;
          if (dispatch.event.post_deleted === true) {
            const target = targetIdOf(dispatch.event);
            if (target) markPostDeleted(target);
          }
          bump();
          return;
        }
        case "post.deleted": {
          const result = current.applyDelete(dispatch.event.post_id, dispatch.event.root_id);
          const target = dispatch.event.post_id ?? dispatch.event.root_id;
          if (target) markPostDeleted(target);
          bump();
          if (result.needsReconcile) scheduleReconcile();
          return;
        }
        case "cursor.acked": {
          current.applyCursor(dispatch.cursor, dispatch.unreadCount);
          bump();
          if (dispatch.unreadCount > 0) scheduleReconcile();
          return;
        }
        case "stream.reset": {
          void refresh();
          return;
        }
        case "stream.reconnected": {
          scheduleReconcile(250);
          return;
        }
        case "stream.heartbeat": {
          lastHeartbeat.current = {
            asOfSeq: dispatch.asOfSeq,
            unreadCount: dispatch.unreadCount,
          };
          // 心跳的 unread_count 有 5s 缓存：只在对不上且没有本地待吸收增量时对账，
          // 避免每个事件都多一次请求；空闲时计数一致 → 0 业务请求。
          if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
          const expected = current.expectedUnreadEvents();
          if (dispatch.unreadCount === expected) return;
          if (current.localEventDelta === 0 || dispatch.unreadCount > expected) {
            scheduleReconcile(600);
          }
          return;
        }
      }
    },
  );

  // 60s 漂移检测（只读本地心跳值，不发请求；对不上才排对账）。
  useEffect(() => {
    if (staticMode) return;
    if (typeof window === "undefined") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const heartbeat = lastHeartbeat.current;
      if (!heartbeat) return;
      if (heartbeat.unreadCount !== projectionRef.current.expectedUnreadEvents()) {
        scheduleReconcile(0);
      }
    }, DRIFT_CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") scheduleReconcile(250);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [staticMode, scheduleReconcile]);

  // degraded（reconnect_failed）兜底：实时流降级期间每 60s 主动对一次账。
  // hub 的 degradedPolling 已按 visible 门控制；可见性恢复导致 effect 重建时立即补一次。
  useEffect(() => {
    if (staticMode || !hubStatus.degradedPolling) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const reconcileNow = () => {
      if (document.visibilityState === "visible") void reconcile();
    };
    // 进入 degraded（或可见性恢复导致 effect 重建）时立即对一次账。
    reconcileNow();
    const timer = window.setInterval(reconcileNow, DRIFT_CHECK_MS);
    document.addEventListener("visibilitychange", reconcileNow);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", reconcileNow);
    };
  }, [staticMode, hubStatus.degradedPolling, reconcile]);

  const ack = useCallback(async () => {
    if (!client) return;
    const current = projectionRef.current;
    const maxEventSeq = [...current.events.keys()].reduce((value, seq) => Math.max(value, seq), 0);
    // 游标只推进到「已确认的流位置」；hello 的 as_of_seq 覆盖没订阅事件的历史未读。
    const target = Math.max(current.cursor, hub?.getStatus().asOfSeq ?? 0, maxEventSeq);
    if (target <= 0) {
      current.clearEvents();
      bump();
      return;
    }
    try {
      const result = await client.ackNotifications(target);
      current.applyCursor(result.cursor, result.unread_count);
      // 唯一清空路径：只清实时事件；posts 投影保留给历史列表复用。
      current.clearEvents();
      setError(null);
      bump();
      if (result.unread_count > 0) scheduleReconcile();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [client, hub, bump, scheduleReconcile]);

  /** 打开详情即已读：只记录该帖（本端），不碰服务端游标——别的旧帖不受影响。 */
  const markPostRead = useCallback(
    (postId: string) => {
      if (!postId) return;
      setReadIds((prev) => {
        if (prev.has(postId)) return prev;
        const next = new Set(prev);
        next.add(postId);
        persistReadSet(next);
        return next;
      });
    },
    [persistReadSet],
  );

  const isRead = useCallback(
    (targetId: string | null, seq: number) => {
      if (targetId && readIds.has(targetId)) return true;
      return seq <= projection.cursor;
    },
    [readIds, projection, version],
  );

  const postOf = useCallback(
    (postId: string) => posts.get(postId),
    [posts],
  );

  const ensurePosts = useCallback(
    (postIds: string[]) => {
      void hydratePosts(postIds);
    },
    [hydratePosts],
  );

  const items = useMemo<NotificationItem[]>(
    () =>
      groupNotificationEvents(
        [...projection.events.values()].map((row) => row.event),
        postOf,
        isRead,
      ),
    [projection, version, postOf, isRead],
  );

  const liveEvents = useMemo<NotificationEventLine[]>(
    () => [...projection.events.values()].map((row) => row.event),
    [projection, version],
  );

  const unread = projection.badge(readIds);
  const deletedCount = useMemo(() => items.filter((item) => item.deleted).length, [items]);

  const value = useMemo<NotificationsValue>(
    () => ({
      items,
      liveEvents,
      unread,
      ackedSeq: projection.cursor,
      deletedCount,
      loading: loading || hydrating,
      hydrating,
      error,
      refresh,
      ack,
      markPostRead,
      isRead,
      postOf,
      ensurePosts,
    }),
    [
      items,
      liveEvents,
      unread,
      projection,
      deletedCount,
      loading,
      hydrating,
      error,
      refresh,
      ack,
      markPostRead,
      isRead,
      postOf,
      ensurePosts,
    ],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used inside NotificationsProvider");
  return value;
}

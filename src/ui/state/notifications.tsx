/**
 * 通知状态：历史列表由页面单独分页拉取；这里维护「未读提醒」的实时投影
 * （EventHub 增量 + peek 对账）以及**按帖已读**的三层状态。
 *
 * 已读分层（report-server-read-state design §5.1）：
 * - 服务端 `post_reads`（经 `PostView.read` / history.read / GET /api/reads 采纳）
 *   = **权威**：跨设备/隐私窗口首帧即已读；
 * - 本地 read-set = **乐观缓存**（停留瞬间即时 UI、离线可用），有界 2000 LRU；
 * - 写队列 `read-sync` = 未确认的服务端写入（离线重试，ready/online/visible 补写）。
 * - 未读判定 = `serverReadIds ∪ readIds ∪ seq ≤ cursor`；单帖已读不推进游标，
 *   `ack()`（全部已读）= 目标批量写 post_reads + 推进游标（兼容保留）。
 *
 * 硬规则（report-notification-history-and-read + report-event-hub §4.7）：
 * - 刷新是 union 合并，不是替换：peek 快照只补新行，内存里已有的行不因游标推进消失。
 * - 角标 = 服务端 `unread_by_target` 的**不同 target 数** − 本地乐观 read-set 命中的
 *   target，加上快照之后新到、尚未被下一次对账吸收的本地 target。服务端快照已按
 *   `post_reads` 扣减，跨设备角标天然一致；`unread_count` 是事件数，只用于漂移对账。
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
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { NotificationEventLine, PostView } from "@core/types";
import { useConnection } from "@/state/connection";
import { NotificationProjection } from "@/state/hub/notification-projection";
import { useEventHub, useEventHubApi, useHubStatus } from "@/state/hub/provider";
import type { HubEventLine } from "@/state/hub/types";
import { noteReadSetPersist } from "@/state/read-dwell";
import {
  READ_QUEUE_BATCH_SIZE,
  READ_QUERY_LIMIT,
  ServerReadQueue,
  chunkIds,
  isReadFromSources,
  planReadReconciliation,
  readQueueStorageKey,
  readUploadMarkerKey,
  uploadLegacyReadSet,
} from "@/state/read-sync";
import {
  READ_SET_LIMIT,
  READ_SET_PERSIST_DEBOUNCE_MS,
  ReadSetStore,
  readSetStorageKey,
  type ReadSetStorage,
} from "@/state/read-set-store";

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
  /** 打开某帖详情/停留达标时调用：只把该帖标记为已读（本端读集合） */
  markPostRead: (postId: string) => void;
  /** 统一已读判定：target 在服务端读集合/本地读集合，或事件 seq ≤ 已 ack 游标 */
  isRead: (targetId: string | null, seq: number) => boolean;
  /** 单帖已读纯查询（PostCard/停留引擎用；seq 参与「全部已读」游标判定） */
  isPostRead: (postId: string, seq: number) => boolean;
  /** 采纳服务端已读（PostView.read / history.read / POST /api/reads 回执） */
  adoptServerReads: (postIds: readonly string[]) => void;
  /** 只订阅某个 postId 的已读翻转（不重渲染整列表） */
  subscribePostRead: (postId: string, listener: () => void) => () => void;
  /** 通知历史行取帖子投影（undefined = 尚未取回） */
  postOf: (postId: string) => PostView | null | undefined;
  /** 请求补拉一批帖子投影（历史列表用） */
  ensurePosts: (postIds: string[]) => void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

/**
 * 单帖已读的「窄上下文」：值恒定不变，PostCard 订阅它拿 per-id 外部订阅，
 * 不消费 NotificationsContext（否则一次停留会让所有卡片跟着 Provider 重渲染）。
 */
interface PostReadApi {
  isPostRead: (postId: string, seq: number) => boolean;
  subscribePostRead: (postId: string, listener: () => void) => () => void;
}

const PostReadContext = createContext<PostReadApi | null>(null);

/** PostCard 的已读标记：只在 id 的 read 翻转时重渲染该卡（design D7）。 */
export function usePostReadFlag(postId: string, seq: number): boolean {
  const api = useContext(PostReadContext);
  const subscribe = useCallback(
    (listener: () => void) => (api ? api.subscribePostRead(postId, listener) : () => {}),
    [api, postId],
  );
  const getSnapshot = useCallback(
    () => (api ? api.isPostRead(postId, seq) : false),
    [api, postId, seq],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

const HYDRATE_CONCURRENCY = 8;
/** 实时删除/游标变化后的对账延迟（合并同一批推送） */
const RECONCILE_DEBOUNCE_MS = 400;
/** 心跳/60s 漂移检测窗口 */
const DRIFT_CHECK_MS = 60_000;

function targetIdOf(event: NotificationEventLine): string | null {
  return event.post_id ?? event.root_id ?? null;
}

/** localStorage 在 private mode/SSR 下可能抛错：退化为纯内存。 */
function browserStorage(): ReadSetStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
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
  const queueStorageKey = accountRef.current
    ? readQueueStorageKey(client?.base ?? "", accountRef.current)
    : null;
  // 读集合在首帧就同步装好（而不是等 effect）：深链直接进详情时，停留引擎/
  // 通知页的 markPostRead 可能早于父级 effect 执行，异步加载会把它覆盖掉。
  const readStoreRef = useRef<ReadSetStore | null>(null);
  if (readStoreRef.current === null) {
    readStoreRef.current = new ReadSetStore({
      storageKey: staticMode ? null : storageKey,
      storage: staticMode ? null : browserStorage(),
      limit: READ_SET_LIMIT,
      debounceMs: READ_SET_PERSIST_DEBOUNCE_MS,
      onPersist: () => noteReadSetPersist(),
    });
  }
  const readStore = readStoreRef.current;
  const [readIds, setReadIds] = useState<Set<string>>(() => readStore.snapshot());
  // 服务端权威读集合（PostView.read / history.read / 写回执采纳；纯内存 LRU 2000）。
  // 不是唯一真值来源：feed 卡片直接读 post.read；这里服务通知行/停留引擎/角标判定。
  const serverReadStoreRef = useRef<ReadSetStore | null>(null);
  if (serverReadStoreRef.current === null) {
    serverReadStoreRef.current = new ReadSetStore({
      storageKey: null,
      storage: null,
      limit: READ_SET_LIMIT,
      debounceMs: 0,
    });
  }
  const serverReads = serverReadStoreRef.current;
  const [serverReadIds, setServerReadIds] = useState<Set<string>>(() => serverReads.snapshot());

  const adoptServerReads = useCallback(
    (postIds: readonly string[]) => {
      let changed = false;
      for (const postId of postIds) {
        if (!postId) continue;
        if (serverReads.mark(postId).changed) changed = true;
      }
      if (changed) setServerReadIds(serverReads.snapshot());
    },
    [serverReads],
  );

  // 写路径队列：per-account 持久化；失败离线保留、恢复后批量补写（P1-7）。
  const readSyncRef = useRef<ServerReadQueue | null>(null);
  if (readSyncRef.current === null) {
    readSyncRef.current = new ServerReadQueue({
      storageKey: staticMode ? null : queueStorageKey,
      storage: staticMode ? null : browserStorage(),
      static: staticMode,
      onAck: (postIds) => adoptServerReads(postIds),
    });
  }
  const readSync = readSyncRef.current;
  readSync.setClient(
    !staticMode && client && accountRef.current
      ? { markReads: (postIds) => client.markReads(postIds) }
      : null,
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

  // 账号/后端切换：读集合与实时投影都换成该账号自己的（避免串号）。
  // 首次挂载已由 ReadSetStore 懒初始化装好；这里只处理「键变了」。
  // 注意：挂载时必须**不**重置（否则会多出一次启动 peek）。
  useEffect(() => {
    if (appliedStorageKey.current !== storageKey) {
      appliedStorageKey.current = storageKey;
      readStore.switchKey(staticMode ? null : storageKey, staticMode ? null : browserStorage());
      setReadIds(readStore.snapshot());
      // 旧账号的 pending 已随本地 read-set 落盘（队列自己的 key）；新账号从自己的
      // 队列重新加载，绝不把旧账号的 id 写到新账号（generation 守卫）。
      readSync.switchKey(
        staticMode ? null : queueStorageKey,
        staticMode ? null : browserStorage(),
      );
      serverReads.clear();
      setServerReadIds(serverReads.snapshot());
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
  }, [storageKey, queueStorageKey, projectionKey, staticMode, bump, readStore, readSync, serverReads]);

  // pagehide / hidden / Provider 卸载时同步 flush 排队中的持久化（读集合 + 重试队列）。
  useEffect(() => {
    const flush = () => {
      readStore.flush();
      readSync.flushPersist();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [readStore, readSync]);

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
      // 通知行视角的服务端已读：PostView.read=true 直接采纳（跨设备首帧就准）。
      const serverReadFromPosts = results
        .filter(([, post]) => post?.read === true)
        .map(([id]) => id);
      if (serverReadFromPosts.length > 0) adoptServerReads(serverReadFromPosts);
      if (hydrationToken.current === token) setHydrating(false);
    },
    [client, adoptServerReads],
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

  /**
   * ready 对账（P1-8 / design §5.3）：先补写队列，再 `GET /api/reads` 分片核对。
   * 服务端为准：本地「服务端没有且不在重试队列」的条目会被丢弃；请求失败不删本地
   * （失败 ≠ 服务端为空）。隐私窗口（无本地缓存）跳过请求，权威值来自 peek/history。
   */
  const reconcileServerReads = useCallback(async () => {
    if (staticMode || !client) return;
    const baseAtStart = client.base;
    const accountAtStart = accountRef.current;
    const stillSame = () => client.base === baseAtStart && accountRef.current === accountAtStart;
    // P1-13 升级过渡：旧本地 read-set 一次性上传（≤2000，100/片）。失败不写标记，
    // 本轮也不再执行「服务端为准」的丢弃（避免服务端尚不知道的本地已读被抹掉），
    // 但队列补写照常进行。
    const upload = await uploadLegacyReadSet({
      ids: readStore.values(),
      client: { markReads: (postIds) => client.markReads(postIds) },
      storage: browserStorage(),
      markerKey: accountAtStart ? readUploadMarkerKey(baseAtStart, accountAtStart) : null,
    });
    if (!stillSame()) return;
    const uploadFailed = upload.attempted && !upload.ok;
    const queue = readSync;
    await queue.flush();
    if (!stillSame()) return;
    const localIds = readStore.values();
    if (localIds.length === 0) return;
    // 只核对本地集合（≤2000，符合服务端 200/次分片）；队列中尚未落库的 id 不参与孤儿判定。
    const serverIds = new Set<string>();
    for (const chunk of chunkIds(localIds, READ_QUERY_LIMIT)) {
      let rows;
      try {
        rows = await client.readStates(chunk);
      } catch {
        return;
      }
      if (!stillSame()) return;
      for (const row of rows) serverIds.add(row.post_id);
    }
    if (uploadFailed) return;
    const queued = new Set(queue.pending());
    const plan = planReadReconciliation({ localIds, queuedIds: queued, serverIds });
    if (plan.adopt.length > 0) adoptServerReads(plan.adopt);
    if (plan.orphans.length > 0) {
      readStore.remove(plan.orphans);
      setReadIds(readStore.snapshot());
    }
  }, [staticMode, client, readSync, readStore, adoptServerReads]);

  useEffect(() => {
    if (staticMode || !client) return;
    void reconcileServerReads();
  }, [reconcileServerReads, projectionKey]);

  // 网络恢复 / 页面重新可见：补写离线队列（事件触发，不做定时轮询）。
  useEffect(() => {
    if (staticMode) return;
    const onOnline = () => {
      void readSync.flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void readSync.flush();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [staticMode, readSync]);

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
    if (!client || staticMode) return;
    const current = projectionRef.current;
    // 1) 当前通知目标 → 服务端逐帖已读（batch ≤100；失败项进重试队列，不阻断 ack）。
    const targets = new Set<string>(current.serverTargets.keys());
    for (const target of current.localTargets) targets.add(target);
    for (const projected of current.events.values()) {
      const targetId = projected.event.post_id ?? projected.event.root_id;
      if (targetId) targets.add(targetId);
    }
    const targetIds = [...targets];
    for (let index = 0; index < targetIds.length; index += READ_QUEUE_BATCH_SIZE) {
      const chunk = targetIds.slice(index, index + READ_QUEUE_BATCH_SIZE);
      try {
        await client.markReads(chunk);
        adoptServerReads(chunk);
      } catch {
        for (const postId of chunk) readSync.enqueue(postId);
      }
    }
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
  }, [client, staticMode, hub, bump, scheduleReconcile, adoptServerReads, readSync]);

  /**
   * 按帖已读：本地 read-set（即时 UI）+ 服务端异步写入（P1-8）。
   * 不碰服务端游标——别的旧帖不受影响；写失败留在重试队列（不阻塞 UI）。
   * 已在集合内的重复标记只 touch LRU（幂等，不重渲染）。
   */
  const markPostRead = useCallback(
    (postId: string) => {
      if (!postId) return;
      const result = readStore.mark(postId);
      if (result.changed) setReadIds(readStore.snapshot());
      // 服务端已确认的帖子不重复入队；本地乐观已读但服务端未知（离线/升级存量）仍补写。
      if (!staticMode && !serverReads.has(postId)) readSync.enqueue(postId);
    },
    [readStore, readSync, serverReads, staticMode],
  );

  const isRead = useCallback(
    (targetId: string | null, seq: number) =>
      isReadFromSources(
        { serverReadIds, localReadIds: readIds, cursor: projection.cursor },
        targetId,
        seq,
      ),
    [readIds, serverReadIds, projection, version],
  );

  // 游标变化（ack / 服务端推送）会让「seq ≤ 游标」的帖子集体转已读：通知所有
  // 单帖订阅者一次，让卡片首帧同步（不依赖父级重渲染）。
  const cursor = projection.cursor;
  const lastCursorRef = useRef(cursor);
  useEffect(() => {
    if (lastCursorRef.current === cursor) return;
    lastCursorRef.current = cursor;
    readStore.notifyAll();
  }, [cursor, readStore]);

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

  // 窄上下文：值恒定，卡片只经 per-id 外部订阅更新（D7）。
  const cursorRef = useRef(projection.cursor);
  cursorRef.current = projection.cursor;
  const postReadApi = useMemo<PostReadApi>(
    () => ({
      isPostRead: (postId: string, seq: number) =>
        serverReads.has(postId) ||
        readStore.has(postId) ||
        (seq > 0 && seq <= cursorRef.current),
      subscribePostRead: (postId: string, listener: () => void) => {
        const unsubscribeLocal = readStore.subscribe(postId, listener);
        const unsubscribeServer = serverReads.subscribe(postId, listener);
        return () => {
          unsubscribeLocal();
          unsubscribeServer();
        };
      },
    }),
    [readStore, serverReads],
  );

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
      isPostRead: postReadApi.isPostRead,
      adoptServerReads,
      subscribePostRead: postReadApi.subscribePostRead,
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
      postReadApi,
      adoptServerReads,
      postOf,
      ensurePosts,
    ],
  );

  return (
    <NotificationsContext.Provider value={value}>
      <PostReadContext.Provider value={postReadApi}>{children}</PostReadContext.Provider>
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used inside NotificationsProvider");
  return value;
}

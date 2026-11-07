/**
 * 通知状态：历史列表由页面单独分页拉取；这里维护「未读提醒」的实时投影
 * （REST peek + SSE 增量，按 seq 去重）以及**按帖已读**的本地读集合。
 *
 * 硬规则：
 * - 未读数与列表**同源**：两者都从同一份 events × posts 投影出来；
 * - 已删帖不进未读：帖子状态未知时不发布该条（列表/角标都不算），确认删除后仍可见但灰显；
 * - SSE 与 REST 的差异只在传输：REST 排除本人事件，SSE 带 includeSelf——这里统一过滤
 *   actor===本人，避免角标被自己的发帖撑到 99+ 再被下拉拉回；
 * - **刷新是 union 合并，不是替换**（审查 B2）：peek 快照只补新行，内存里已有的行（含已读）
 *   不因游标推进而消失；唯一清空路径是「全部已读」。
 *
 * 已读语义（Owner 2026-11-07 + 审查 B1）：**按帖已读**。
 * - 打开帖子详情只把该帖加入本账号的本地读集合（localStorage，键含后端 URL + 账号），
 *   同帖的全部事件一并视为已读；**不推进服务端游标**，所以别的旧帖绝不被连带标已读。
 * - 判定统一为「target 在读集合 ∪ seq ≤ 已 ack 游标」；「全部已读」才推进服务端游标。
 * - 读集合只影响本端展示与未读计数；跨 reload 的历史行由 history 接口补齐。
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
  /** newest-first groups (one row per post); list === count source */
  items: NotificationItem[];
  /** 原始实时事件（未分组，页面与历史合并后统一分组） */
  liveEvents: NotificationEventLine[];
  /** unread visible reminders (deleted rows are excluded) */
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

/**
 * 事件 → 按帖分组（UI/角标的最小单元是「一个帖子一条提醒」）。
 *
 * 同一帖的 post.created 与 thread.invited 是同一件事的两条事件：列表只展示一行、
 * 角标只计 1，打开一次即两条都读（审查 B1 的验收口径：两帖未读开一帖 → 角标 -1）。
 * 无 target 的事件（极少数协议事件）按事件自身独立成行。
 * 帖子投影尚未取回（undefined）的组暂不发布，避免角标/列表短暂不一致。
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
  const { client, account, staticMode, subscribeEvents, sseState } = useConnection();
  const [events, setEvents] = useState<Map<number, NotificationEventLine>>(() => new Map());
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

  const eventsRef = useRef(events);
  eventsRef.current = events;
  const postsRef = useRef(posts);
  postsRef.current = posts;
  const ackedThrough = useRef(0);
  const [ackedSeq, setAckedSeq] = useState(0);
  const hydrationToken = useRef(0);
  const appliedStorageKey = useRef(storageKey);

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
  useEffect(() => {
    if (appliedStorageKey.current !== storageKey) {
      appliedStorageKey.current = storageKey;
      setReadIds(staticMode || !storageKey ? new Set() : loadReadSet(storageKey));
    }
    setEvents(new Map());
    setPosts(new Map());
    ackedThrough.current = 0;
    setAckedSeq(0);
  }, [storageKey, staticMode]);

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

  const refresh = useCallback(async () => {
    if (!client) return;
    const initial = eventsRef.current.size === 0;
    if (initial) setLoading(true);
    try {
      const result = await client.notifications({ peek: true });
      // 服务端游标是「全部已读」的水位；顺带校正本地（多 tab 时另一边已全部已读）。
      const nextAck = Math.max(ackedThrough.current, result.cursor ?? 0);
      ackedThrough.current = nextAck;
      setAckedSeq(nextAck);
      const lines = result.events.filter(
        (line): line is NotificationEventLine => "seq" in line && typeof line.seq === "number",
      );
      // union 合并（B2）：快照只补新行，不删内存里已经展示过的历史行。
      const merged = new Map(eventsRef.current);
      for (const line of lines) merged.set(line.seq, line);
      setEvents(merged);
      setError(null);
      const ids = [
        ...new Set(
          [...merged.values()]
            .map(targetIdOf)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      ];
      // 每次拉取都复核帖子状态（删除没有独立事件），保证「已删帖」不进未读
      void hydratePosts(ids, true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client, hydratePosts]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 重连后按服务端游标补拉未读（SSE 只负责增量）
  useEffect(() => {
    if (sseState === "open") void refresh();
  }, [sseState, refresh]);

  useEffect(() => {
    return subscribeEvents((event) => {
      // 自己的动作不通知自己（REST 同口径；SSE 带 includeSelf 需要在这里裁掉）
      if (accountRef.current && event.actor === accountRef.current) return;
      if (event.seq <= ackedThrough.current) return;
      setEvents((prev) => {
        if (prev.has(event.seq)) return prev;
        const next = new Map(prev);
        next.set(event.seq, event);
        return next;
      });
      // 新事件的目标帖还没有投影时立即补拉：分组器只在帖子已取回时发布，
      // 否则「停留在通知页 → 新 @ 到达」要等手动刷新/下一次 peek 才出现。
      const targetId = targetIdOf(event);
      if (targetId && !postsRef.current.has(targetId)) {
        void hydratePosts([targetId]);
      }
    });
  }, [subscribeEvents, hydratePosts]);

  const ack = useCallback(async () => {
    if (!client) return;
    const max = [...eventsRef.current.keys()].reduce((value, seq) => Math.max(value, seq), 0);
    if (max <= 0) {
      // 没有实时行也要保留 posts 投影：通知页的历史行仍靠它渲染正文/删除态。
      setEvents(new Map());
      return;
    }
    try {
      const cursor = await client.ackNotifications(max);
      // 以服务端响应游标为准校正水位（多 tab / 并发 ack 时本地不落后）。
      const nextAck = Math.max(ackedThrough.current, cursor);
      ackedThrough.current = nextAck;
      setAckedSeq(nextAck);
      // 只清实时事件；posts 投影保留给历史列表复用（否则 ack 后历史行会因查不到
      // 帖子而被分组器丢弃——浏览器验收实测 rows=0）。
      setEvents(new Map());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [client]);

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
      return seq <= ackedSeq;
    },
    [readIds, ackedSeq],
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
    () => groupNotificationEvents(events.values(), postOf, isRead),
    [events, postOf, isRead],
  );

  const liveEvents = useMemo<NotificationEventLine[]>(() => [...events.values()], [events]);

  const unread = useMemo(
    () => items.filter((item) => !item.deleted && !item.read).length,
    [items],
  );
  const deletedCount = useMemo(() => items.filter((item) => item.deleted).length, [items]);

  const value = useMemo<NotificationsValue>(
    () => ({
      items,
      liveEvents,
      unread,
      ackedSeq,
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
      ackedSeq,
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

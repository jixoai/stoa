/**
 * 通知状态：REST peek 拉未读 + SSE 增量（按 seq 去重）。
 *
 * 硬规则（走查修复）：
 * - 未读数与列表**同源**：两者都从同一份 events × posts 投影出来，不再各算各的；
 * - 已删帖不进未读：帖子状态未知时不发布该条（列表/角标都不算），确认删除后归入
 *   「已删除」分组（页面折叠/灰显），未读数只统计仍可见的提醒；
 * - SSE 与 REST 的差异只在传输：REST 排除本人事件，SSE 带 includeSelf——这里统一
 *   过滤 actor===本人，避免角标被自己的发帖撑到 99+ 再被下拉拉回。
 *
 * UI 不自动推进游标——「全部标为已读」时才 ack（design §7 的交付语义在网页侧的投影）。
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
  event: NotificationEventLine;
  /** hydrated post; null when the post is gone / not visible to this viewer */
  post: PostView | null;
  /** navigation target (event.post_id ?? event.root_id) */
  targetId: string | null;
  deleted: boolean;
}

interface NotificationsValue {
  /** newest-first, only rows whose post state is known (list === count source) */
  items: NotificationItem[];
  /** unread visible reminders (deleted rows are excluded) */
  unread: number;
  deletedCount: number;
  /** initial REST load or post hydration in flight */
  loading: boolean;
  hydrating: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  ack: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

const HYDRATE_CONCURRENCY = 8;

function targetIdOf(event: NotificationEventLine): string | null {
  return event.post_id ?? event.root_id ?? null;
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { client, account, subscribeEvents, sseState } = useConnection();
  const [events, setEvents] = useState<Map<number, NotificationEventLine>>(() => new Map());
  const [posts, setPosts] = useState<Map<string, PostView | null>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [hydrating, setHydrating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eventsRef = useRef(events);
  eventsRef.current = events;
  const postsRef = useRef(posts);
  postsRef.current = posts;
  const ackedThrough = useRef(0);
  const hydrationToken = useRef(0);
  const accountRef = useRef(account?.id ?? null);
  accountRef.current = account?.id ?? null;

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
      const lines = result.events.filter(
        (line): line is NotificationEventLine => "seq" in line && typeof line.seq === "number",
      );
      const maxSeq = lines.reduce((value, line) => Math.max(value, line.seq), 0);
      const next = new Map<number, NotificationEventLine>();
      for (const line of lines) next.set(line.seq, line);
      // SSE 事件可能比 REST 快照更新：保留快照之后到达的增量
      for (const [seq, event] of eventsRef.current) {
        if (seq > maxSeq) next.set(seq, event);
      }
      setEvents(next);
      setError(null);
      const ids = [
        ...new Set(
          [...next.values()]
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
    });
  }, [subscribeEvents]);

  const ack = useCallback(async () => {
    if (!client) return;
    const max = [...eventsRef.current.keys()].reduce((value, seq) => Math.max(value, seq), 0);
    if (max <= 0) {
      setEvents(new Map());
      setPosts(new Map());
      return;
    }
    try {
      await client.ackNotifications(max);
      ackedThrough.current = Math.max(ackedThrough.current, max);
      setEvents(new Map());
      setPosts(new Map());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [client]);

  const items = useMemo<NotificationItem[]>(() => {
    const rows: NotificationItem[] = [];
    for (const event of events.values()) {
      const targetId = targetIdOf(event);
      if (targetId) {
        if (!posts.has(targetId)) continue; // 状态未知：不发布，避免角标/列表短暂不一致
        const post = posts.get(targetId) ?? null;
        rows.push({ event, post, targetId, deleted: !post || post.deleted_at !== null });
      } else {
        rows.push({ event, post: null, targetId: null, deleted: false });
      }
    }
    return rows.sort((a, b) => b.event.seq - a.event.seq);
  }, [events, posts]);

  const unread = useMemo(() => items.filter((item) => !item.deleted).length, [items]);
  const deletedCount = items.length - unread;

  const value = useMemo<NotificationsValue>(
    () => ({
      items,
      unread,
      deletedCount,
      loading: loading || hydrating,
      hydrating,
      error,
      refresh,
      ack,
    }),
    [items, unread, deletedCount, loading, hydrating, error, refresh, ack],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used inside NotificationsProvider");
  return value;
}

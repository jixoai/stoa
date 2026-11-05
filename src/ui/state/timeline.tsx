/**
 * 时间线状态（跨路由持久）——design §12.2 的硬规则都收敛在这里：
 *
 * - 新数据一律先入 `pending[]`，绝不直接插入 `posts`
 * - 是否吸收由视图层判定（atTop ≤5px、无拖拽/惯性、tab 可见、非锚点恢复中）
 * - 时间线位置锚点 `{firstVisibleId, offsetPx, scrollTop, atTop}` 在离开详情前
 *   捕获，返回时先恢复再刷新
 * - 下拉/补拉都按 post id 去重；向下滚动用 before 游标，向上刷新用 after 游标
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
import type { PostView } from "@core/types";
import { postCursor } from "@/lib/cursor";
import { useConnection } from "@/state/connection";

export interface TimelineAnchor {
  firstVisibleId: string | null;
  offsetPx: number;
  scrollTop: number;
  atTop: boolean;
}

interface TimelineState {
  posts: PostView[];
  pending: PostView[];
  hasMore: boolean;
  oldestCursor: string | null;
  initialLoading: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  error: string | null;
  asOfSeq: number;
}

export interface TimelineApi extends TimelineState {
  loadInitial: () => Promise<void>;
  loadMore: () => Promise<void>;
  refreshNew: () => void;
  absorbPending: () => number;
  captureAnchor: (anchor: TimelineAnchor) => void;
  prepareReturn: () => void;
  takeRestore: () => TimelineAnchor | null;
  clearRestore: () => void;
  markInitialized: () => void;
  initialized: boolean;
}

const TimelineContext = createContext<TimelineApi | null>(null);

function mergePosts(...groups: PostView[][]): PostView[] {
  const byId = new Map<string, PostView>();
  for (const group of groups) {
    for (const post of group) byId.set(post.id, post);
  }
  return [...byId.values()].sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

export function TimelineProvider({ children }: { children: ReactNode }) {
  const { client, subscribeEvents, sseState } = useConnection();
  const [state, setState] = useState<TimelineState>({
    posts: [],
    pending: [],
    hasMore: false,
    oldestCursor: null,
    initialLoading: true,
    loadingMore: false,
    refreshing: false,
    error: null,
    asOfSeq: 0,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const initializedRef = useRef(false);
  const refreshInFlight = useRef(false);
  const refreshAgain = useRef(false);
  const refreshTimer = useRef<number | null>(null);
  const savedAnchor = useRef<TimelineAnchor | null>(null);
  const restoreNext = useRef(false);

  const loadInitial = useCallback(async () => {
    if (!client) return;
    setState((prev) => ({ ...prev, initialLoading: true, error: null }));
    try {
      const page = await client.timeline({ limit: 30 });
      initializedRef.current = true;
      setState({
        posts: mergePosts(page.posts),
        pending: [],
        hasMore: page.has_more,
        oldestCursor: page.next_cursor,
        initialLoading: false,
        loadingMore: false,
        refreshing: false,
        error: null,
        asOfSeq: page.as_of_seq,
      });
    } catch (err) {
      setState((prev) => ({ ...prev, initialLoading: false, error: (err as Error).message }));
    }
  }, [client]);

  const loadMore = useCallback(async () => {
    if (!client) return;
    const current = stateRef.current;
    if (!current.hasMore || current.loadingMore || current.initialLoading) return;
    setState((prev) => ({ ...prev, loadingMore: true }));
    try {
      const page = await client.timeline({ before: current.oldestCursor, limit: 30 });
      setState((prev) => ({
        ...prev,
        posts: mergePosts(prev.posts, page.posts),
        hasMore: page.has_more,
        oldestCursor: page.next_cursor,
        loadingMore: false,
        asOfSeq: Math.max(prev.asOfSeq, page.as_of_seq),
      }));
    } catch (err) {
      setState((prev) => ({ ...prev, loadingMore: false, error: (err as Error).message }));
    }
  }, [client]);

  const doRefresh = useCallback(async () => {
    if (!client) return;
    if (refreshInFlight.current) {
      refreshAgain.current = true;
      return;
    }
    const current = stateRef.current;
    const top = current.pending[0] ?? current.posts[0];
    if (!top) {
      await loadInitial();
      return;
    }
    refreshInFlight.current = true;
    setState((prev) => ({ ...prev, refreshing: true }));
    const collected: PostView[] = [];
    let after: string | null = postCursor(top);
    try {
      for (let page = 0; page < 5 && after; page += 1) {
        const result = await client.timeline({ after, limit: 100 });
        collected.push(...result.posts);
        if (!result.has_more || !result.next_cursor) break;
        after = result.next_cursor;
      }
      if (collected.length > 0) {
        setState((prev) => ({
          ...prev,
          pending: mergePosts(collected, prev.pending),
          refreshing: false,
          error: null,
          asOfSeq: Math.max(prev.asOfSeq, ...collected.map((post) => post.seq)),
        }));
      } else {
        setState((prev) => ({ ...prev, refreshing: false }));
      }
    } catch (err) {
      setState((prev) => ({ ...prev, refreshing: false, error: (err as Error).message }));
    } finally {
      refreshInFlight.current = false;
      if (refreshAgain.current) {
        refreshAgain.current = false;
        void doRefresh();
      }
    }
  }, [client, loadInitial]);

  const refreshNew = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void doRefresh();
    }, 250);
  }, [doRefresh]);

  // initial load once per connection
  useEffect(() => {
    if (!client || initializedRef.current) return;
    void loadInitial();
  }, [client, loadInitial]);

  // SSE → new-data fetch (debounced); events for other threads still matter
  useEffect(() => {
    return subscribeEvents(() => {
      refreshNew();
    });
  }, [subscribeEvents, refreshNew]);

  // 断线重连：hello 之后按 after 游标补拉（按 id 去重由 mergePosts 保证）
  useEffect(() => {
    if (sseState === "open") refreshNew();
  }, [sseState, refreshNew]);

  // When the tab comes back, catch up on anything missed while throttled.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshNew();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshNew]);

  const absorbPending = useCallback(() => {
    const count = stateRef.current.pending.length;
    if (count === 0) return 0;
    setState((prev) => ({
      ...prev,
      posts: mergePosts(prev.pending, prev.posts),
      pending: [],
    }));
    return count;
  }, []);

  const captureAnchor = useCallback((anchor: TimelineAnchor) => {
    savedAnchor.current = anchor;
  }, []);

  const prepareReturn = useCallback(() => {
    restoreNext.current = true;
  }, []);

  const takeRestore = useCallback(() => {
    if (!restoreNext.current) return null;
    restoreNext.current = false;
    return savedAnchor.current;
  }, []);

  const clearRestore = useCallback(() => {
    restoreNext.current = false;
  }, []);

  const markInitialized = useCallback(() => {
    initializedRef.current = true;
  }, []);

  const value = useMemo<TimelineApi>(
    () => ({
      ...state,
      loadInitial,
      loadMore,
      refreshNew,
      absorbPending,
      captureAnchor,
      prepareReturn,
      takeRestore,
      clearRestore,
      markInitialized,
      initialized: initializedRef.current,
    }),
    [
      state,
      loadInitial,
      loadMore,
      refreshNew,
      absorbPending,
      captureAnchor,
      prepareReturn,
      takeRestore,
      clearRestore,
      markInitialized,
    ],
  );

  return <TimelineContext.Provider value={value}>{children}</TimelineContext.Provider>;
}

export function useTimeline(): TimelineApi {
  const value = useContext(TimelineContext);
  if (!value) throw new Error("useTimeline must be used inside TimelineProvider");
  return value;
}

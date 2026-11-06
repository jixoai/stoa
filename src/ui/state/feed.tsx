/**
 * 通用帖子流控制器（主页双流 / 成员页 / 标签页共用一套机制）。
 *
 * design §12.2 的硬规则全部收敛在这里，视图层只决定「何时吸收」：
 * - 新数据一律先进 `pending[]`，绝不直接插入 `posts`
 * - 向下滚动用 before 游标；向上刷新用 after 游标；按 post id 去重
 * - 每个 feed 实例拥有**独立**的游标 / pending / 锚点（切 tab 不串流）
 * - 断线重连后按 after 游标补拉；去重由 mergePosts 保证
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
import { rememberPosts, readFeedCache, writeFeedCache } from "@/state/cache";
import { useConnection } from "@/state/connection";

export interface TimelineAnchor {
  firstVisibleId: string | null;
  offsetPx: number;
  scrollTop: number;
  atTop: boolean;
}

/** The subset of TimelinePage-like responses the feed machinery needs. */
export interface FeedPageData {
  posts: PostView[];
  has_more: boolean;
  next_cursor: string | null;
  as_of_seq?: number;
}

export interface FeedQuery {
  before?: string | null;
  after?: string | null;
  limit?: number;
}

export type FeedLoader = (query: FeedQuery) => Promise<FeedPageData>;

export interface FeedState {
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

export interface FeedController extends FeedState {
  loadInitial: () => Promise<void>;
  loadMore: () => Promise<void>;
  refreshNew: () => void;
  absorbPending: () => number;
  captureAnchor: (anchor: TimelineAnchor) => void;
  prepareReturn: () => void;
  takeRestore: () => TimelineAnchor | null;
  clearRestore: () => void;
}

export interface UsePostFeedOptions {
  /** Disable the app-wide SSE subscription (member page uses its own author stream). */
  realtime?: boolean;
  /** Load the first page on mount (default true). */
  autoLoad?: boolean;
  /** Change this to reset all state and reload (e.g. member account id). */
  resetKey?: string;
  limit?: number;
  /** 首帧种子（已在别处见过的帖子）；缺省时按 `cacheKey` 读上次快照。 */
  initialPosts?: PostView[];
  /** 时间线快照键：加载成功后写回，下次进入同一路由/标签/成员页立即排版。 */
  cacheKey?: string;
}

const EMPTY_STATE: FeedState = {
  posts: [],
  pending: [],
  hasMore: false,
  oldestCursor: null,
  initialLoading: true,
  loadingMore: false,
  refreshing: false,
  error: null,
  asOfSeq: 0,
};

/** 首帧种子：有已见数据时直接排版，`initialLoading` 仍为 true（网络结果会替换）。 */
function seedState(seed: PostView[] | undefined): FeedState {
  if (!seed || seed.length === 0) return EMPTY_STATE;
  return { ...EMPTY_STATE, posts: mergePosts(seed) };
}

export function mergePosts(...groups: PostView[][]): PostView[] {
  const byId = new Map<string, PostView>();
  for (const group of groups) {
    for (const post of group) byId.set(post.id, post);
  }
  return [...byId.values()].sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * One independent feed. The loader may be an inline closure: it is read through
 * a ref, so re-renders never re-trigger requests or reset cursors.
 */
export function usePostFeed(
  loader: FeedLoader | null,
  options: UsePostFeedOptions = {},
): FeedController {
  const {
    realtime = true,
    autoLoad = true,
    resetKey = "",
    limit = 30,
    initialPosts,
    cacheKey,
  } = options;
  const { subscribeEvents, sseState } = useConnection();
  const [state, setState] = useState<FeedState>(() =>
    seedState(initialPosts ?? (cacheKey ? readFeedCache(cacheKey) : [])),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const seedRef = useRef<PostView[] | undefined>(initialPosts);
  seedRef.current = initialPosts;
  const cacheKeyRef = useRef<string | undefined>(cacheKey);
  cacheKeyRef.current = cacheKey;

  const loaderRef = useRef<FeedLoader | null>(loader);
  loaderRef.current = loader;
  const hasLoader = loader !== null;
  const autoloadRef = useRef({ autoLoad, limit });
  autoloadRef.current = { autoLoad, limit };

  const generation = useRef(0);
  const initializedRef = useRef(false);
  const refreshInFlight = useRef(false);
  const refreshAgain = useRef(false);
  const refreshTimer = useRef<number | null>(null);
  const savedAnchor = useRef<TimelineAnchor | null>(null);
  const restoreNext = useRef(false);
  const lastKey = useRef(resetKey);

  const loadInitial = useCallback(async () => {
    const load = loaderRef.current;
    if (!load) return;
    const gen = generation.current;
    const { limit: pageSize } = autoloadRef.current;
    setState((prev) => ({ ...prev, initialLoading: true, error: null }));
    try {
      const page = await load({ limit: pageSize });
      if (gen !== generation.current) return;
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
        asOfSeq: page.as_of_seq ?? 0,
      });
    } catch (err) {
      if (gen !== generation.current) return;
      setState((prev) => ({ ...prev, initialLoading: false, error: (err as Error).message }));
    }
  }, []);

  const loadMore = useCallback(async () => {
    const load = loaderRef.current;
    if (!load) return;
    const current = stateRef.current;
    if (!current.hasMore || current.loadingMore || current.initialLoading) return;
    const gen = generation.current;
    setState((prev) => ({ ...prev, loadingMore: true }));
    try {
      const page = await load({ before: current.oldestCursor, limit: 30 });
      if (gen !== generation.current) return;
      setState((prev) => ({
        ...prev,
        posts: mergePosts(prev.posts, page.posts),
        hasMore: page.has_more,
        oldestCursor: page.next_cursor,
        loadingMore: false,
        asOfSeq: Math.max(prev.asOfSeq, page.as_of_seq ?? 0),
      }));
    } catch (err) {
      if (gen !== generation.current) return;
      setState((prev) => ({ ...prev, loadingMore: false, error: (err as Error).message }));
    }
  }, []);

  const doRefresh = useCallback(async () => {
    const load = loaderRef.current;
    if (!load) return;
    if (refreshInFlight.current) {
      refreshAgain.current = true;
      return;
    }
    const current = stateRef.current;
    if (current.initialLoading) return;
    const gen = generation.current;
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
        const result = await load({ after, limit: 100 });
        if (gen !== generation.current) return;
        collected.push(...result.posts);
        if (!result.has_more || !result.next_cursor) break;
        after = result.next_cursor;
      }
      if (gen !== generation.current) return;
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
      if (gen !== generation.current) return;
      setState((prev) => ({ ...prev, refreshing: false, error: (err as Error).message }));
    } finally {
      refreshInFlight.current = false;
      if (refreshAgain.current) {
        refreshAgain.current = false;
        void doRefresh();
      }
    }
  }, [loadInitial]);

  const refreshNew = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void doRefresh();
    }, 250);
  }, [doRefresh]);

  // resetKey change → drop cursors/pending/anchor, then load the new source.
  useEffect(() => {
    if (lastKey.current === resetKey) return;
    lastKey.current = resetKey;
    generation.current += 1;
    initializedRef.current = false;
    restoreNext.current = false;
    savedAnchor.current = null;
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    const key = cacheKeyRef.current;
    setState(seedState(seedRef.current ?? (key ? readFeedCache(key) : [])));
  }, [resetKey]);

  // 时间线快照写回：任何一批可见帖子（含 pending 吸收）都更新缓存，
  // 下次进入同一路由/标签/成员页时首帧就有内容。
  useEffect(() => {
    if (state.posts.length === 0) return;
    rememberPosts(state.posts);
    const key = cacheKeyRef.current;
    if (key) writeFeedCache(key, state.posts);
  }, [state.posts]);

  // initial load (once per source)
  useEffect(() => {
    if (!loaderRef.current || !autoLoad || initializedRef.current) return;
    void loadInitial();
  }, [hasLoader, autoLoad, loadInitial, resetKey]);

  // SSE → debounced after-cursor refresh (dedupe happens in mergePosts)
  useEffect(() => {
    if (!realtime) return;
    return subscribeEvents(() => refreshNew());
  }, [realtime, subscribeEvents, refreshNew]);

  // reconnect → catch up from the feed's own top cursor
  useEffect(() => {
    if (!realtime) return;
    if (sseState === "open") refreshNew();
  }, [realtime, sseState, refreshNew]);

  // tab visible again → catch up on anything missed while throttled
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

  return useMemo<FeedController>(
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
    ],
  );
}

// ── home feeds (two independent tabs; design §5.0) ───────────────────────────

interface HomeFeedsValue {
  recommended: FeedController;
  following: FeedController;
}

const HomeFeedsContext = createContext<HomeFeedsValue | null>(null);

export function HomeFeedsProvider({ children }: { children: ReactNode }) {
  const { client } = useConnection();
  const recommended = usePostFeed(
    client ? (query) => client.feed({ tab: "recommended", ...query }) : null,
    { cacheKey: "home:recommended" },
  );
  const following = usePostFeed(
    client ? (query) => client.feed({ tab: "following", ...query }) : null,
    { cacheKey: "home:following" },
  );
  const value = useMemo<HomeFeedsValue>(
    () => ({ recommended, following }),
    [recommended, following],
  );
  return <HomeFeedsContext.Provider value={value}>{children}</HomeFeedsContext.Provider>;
}

export function useHomeFeeds(): HomeFeedsValue {
  const value = useContext(HomeFeedsContext);
  if (!value) throw new Error("useHomeFeeds must be used inside HomeFeedsProvider");
  return value;
}

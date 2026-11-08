/**
 * 通用帖子流控制器（主页双流 / 成员页 / 标签页 / 收藏页共用一套机制）。
 *
 * design §12.2 的硬规则全部收敛在这里，视图层只决定「何时吸收」：
 * - 新数据一律先进 `pending[]`，绝不直接插入 `posts`
 * - 向下滚动用 before 游标；向上刷新用 after 游标；按 post id 去重
 * - 每个 feed 实例拥有**独立**的游标 / pending / 锚点（切 tab 不串流）
 * - 断线重连后按 after 游标补拉；去重由 mergePosts 保证
 *
 * 实时失效（report-event-hub §4.6）：
 * - `post.created` 只有「命中本 feed 谓词」的根帖才刷新，且只有**活跃** feed 发请求，
 *   非活跃只标脏（切回时补一次）；回复不进列表流。
 * - `post.deleted` 只按当前已渲染 id 命中（delete 载荷没有 tags/author）：
 *   post_id 命中 → 本地移除；root_id 命中 → 按 `deleteRootAction` 决定是否轻量补拉。
 * - `stream.reset` → 强重取（清空易变投影）；`stream.reconnected` → 轻量补拉。
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
import { useEventHub, useEventHubView } from "@/state/hub/provider";
import { isRootCreated, type HubEventLine, type HubView } from "@/state/hub/types";

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
  /** 页面级活跃开关：只有活跃 feed 响应推送（非活跃只标脏）。 */
  setLiveActive: (active: boolean) => void;
}

/** 实时失效谓词（report-event-hub §4.6）；不传 = 默认「根帖」规则。 */
export interface FeedLiveOptions {
  /** 页面挂载即活跃（默认 true；主页双流由 HomePage 显式切换）。 */
  active?: boolean;
  /** 哪些 `post.created` 属于本 feed（默认：根帖）。 */
  matches?: (event: HubEventLine) => boolean;
  /**
   * `post.deleted` 只命中 root_id（当前列表里的根帖，被删的是其下回复）时：
   * 成员页/标签页需要轻量补拉；主页/收藏页忽略。
   */
  deleteRootAction?: "ignore" | "refresh";
}

export interface UsePostFeedOptions {
  /** Disable the app-wide hub subscription (static archives never mount the hub). */
  realtime?: boolean;
  /** Load the first page on mount (default true). */
  autoLoad?: boolean;
  /** Change this to reset all state and reload (e.g. member account id). */
  resetKey?: string;
  limit?: number;
  /** 首帧种子（已在别处见过的帖子）；缺省时按 `cacheKey` 读上次快照。 */
  initialPosts?: PostView[];
  /** 时间线快照键：加载成功后写回，下次进入同一路由/标签页/成员页立即排版。 */
  cacheKey?: string;
  /** 推送失效规则（见 FeedLiveOptions）。 */
  live?: FeedLiveOptions;
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
    live,
  } = options;
  const liveMatch = live?.matches;
  const deleteRootAction = live?.deleteRootAction ?? "ignore";
  const [liveActive, setLiveActiveState] = useState(live?.active ?? true);
  const liveActiveRef = useRef(liveActive);
  liveActiveRef.current = liveActive;
  /** 非活跃期间收到的失效意图：切回活跃时补一次。 */
  const dirtyReason = useRef<"refresh" | "reload" | null>(null);
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
    let asOf = current.asOfSeq;
    try {
      for (let page = 0; page < 5 && after; page += 1) {
        const result = await load({ after, limit: 100 });
        if (gen !== generation.current) return;
        // 服务端快照水位（而非最后一条帖子的 seq）才是视图的 seed 上界。
        asOf = Math.max(asOf, result.as_of_seq ?? 0);
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
          asOfSeq: Math.max(prev.asOfSeq, asOf),
        }));
      } else {
        setState((prev) => ({ ...prev, refreshing: false, asOfSeq: Math.max(prev.asOfSeq, asOf) }));
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
    dirtyReason.current = null;
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

  /** 删除命中：只按当前已渲染 id 从 posts/pending 移除（不发请求）。 */
  const removePosts = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    setState((prev) => {
      const posts = prev.posts.filter((post) => !drop.has(post.id));
      const pending = prev.pending.filter((post) => !drop.has(post.id));
      if (posts.length === prev.posts.length && pending.length === prev.pending.length) return prev;
      return { ...prev, posts, pending };
    });
  }, []);

  // Hub → 精确失效（design §4.6）：回复不进列表流；非活跃只标脏；删除按 id 命中。
  useEventHub(
    ["post.created", "post.deleted", "stream.reset", "stream.reconnected"],
    (dispatch) => {
      if (!realtime) return;
      switch (dispatch.topic) {
        case "post.created": {
          const matches = liveMatch ? liveMatch(dispatch.event) : isRootCreated(dispatch.event);
          if (!matches) return;
          if (liveActiveRef.current) refreshNew();
          else dirtyReason.current = "refresh";
          return;
        }
        case "post.deleted": {
          const postId = dispatch.event.post_id;
          const rootId = dispatch.event.root_id;
          const current = stateRef.current;
          const ids = new Set([...current.posts, ...current.pending].map((post) => post.id));
          if (postId && ids.has(postId)) {
            removePosts([postId]);
            return;
          }
          if (rootId && ids.has(rootId) && deleteRootAction === "refresh") {
            if (liveActiveRef.current) refreshNew();
            else if (dirtyReason.current !== "reload") dirtyReason.current = "refresh";
          }
          return;
        }
        case "stream.reset": {
          if (liveActiveRef.current) {
            dirtyReason.current = null;
            void loadInitial();
          } else {
            dirtyReason.current = "reload";
          }
          return;
        }
        case "stream.reconnected": {
          if (liveActiveRef.current) refreshNew();
          else if (dirtyReason.current !== "reload") dirtyReason.current = "refresh";
          return;
        }
      }
    },
  );

  // 活跃视图：把 REST seed 水位交给总线（首连 since / hello 后补拉 / reset 强重取）。
  // 首帧 seed 没有服务端水位（asOfSeq=0）时不注册：等 REST 回来拿到 as_of_seq 再注册，
  // 注册时会与 hub.lastSeq 比对，落后就立刻补一次。
  useEventHubView(
    realtime && liveActive && state.asOfSeq > 0
      ? {
          asOfSeq: state.asOfSeq,
          catchUp: () => refreshNew(),
          reload: () => loadInitial(),
        }
      : null,
  );

  // 切回活跃：补一次非活跃期间标脏的失效。
  useEffect(() => {
    if (!liveActive) return;
    const reason = dirtyReason.current;
    dirtyReason.current = null;
    if (reason === "reload") void loadInitial();
    else if (reason === "refresh") refreshNew();
  }, [liveActive, loadInitial, refreshNew]);

  const setLiveActive = useCallback((active: boolean) => {
    setLiveActiveState((prev) => (prev === active ? prev : active));
  }, []);

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
      setLiveActive,
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
      setLiveActive,
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
  // 两条流常驻，但默认都**非活跃**：由 HomePage 按当前 tab 调 setLiveActive，
  // 保证一条推送最多只刷一个 feed（首页未挂载时 0 次）。
  const recommended = usePostFeed(
    client ? (query) => client.feed({ tab: "recommended", ...query }) : null,
    { cacheKey: "home:recommended", live: { active: false } },
  );
  const following = usePostFeed(
    client ? (query) => client.feed({ tab: "following", ...query }) : null,
    { cacheKey: "home:following", live: { active: false } },
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

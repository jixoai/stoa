/**
 * 时间线渲染面板（主页双流 / 成员页 / 标签页共用）。
 *
 * 状态与游标在 `state/feed.tsx`；这里只负责 design §12.2 的视图规则：
 * 新帖胶囊、顶部自动插入、锚点恢复、下拉刷新、j/k/Enter/r 键盘。
 * 每个面板实例绑定一个独立的 FeedController，切换 tab 不会串流。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PostView } from "@core/types";
import { ArrowUpIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { PostCard } from "@/components/PostCard";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { ContentSwap } from "@/components/ContentSwap";
import { PostListSkeleton } from "@/components/Skeletons";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { useConnection } from "@/state/connection";
import type { FeedController, TimelineAnchor } from "@/state/feed";
import { navigate } from "@/lib/router";
import { displayCount } from "@/lib/format";
import { loadScrollMemory, saveScrollMemory, scrollMemoryKey } from "@/lib/scroll-memory";

const TOP_THRESHOLD = 5;
const SETTLE_MS = 160;
const PILL_MERGE_MS = 400;

export interface TimelineFeedProps {
  feed: FeedController;
  /** Stable label for QA/telemetry, e.g. "recommended". */
  feedName?: string;
  /** 滚动记忆键：路由 path（如 `/`、`/u/manager`）与 feedTab。 */
  scrollPath?: string;
  scrollTab?: string;
  /** Rendered inside the scroll container, above the list (profile card, etc.). */
  leading?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
}

const HOLD_MS = 2500;

export function TimelineFeed({
  feed,
  feedName = "feed",
  scrollPath,
  scrollTab,
  leading,
  emptyTitle = "还没有帖子",
  emptyDescription = "在「发帖」里写下第一条公示。",
}: TimelineFeedProps) {
  const { who } = useConnection();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [atTop, setAtTop] = useState(true);
  const atTopRef = useRef(true);
  const [tabVisible, setTabVisible] = useState(() => document.visibilityState === "visible");
  const [pillCount, setPillCount] = useState(0);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [pullDistance, setPullDistance] = useState(0);
  const [pullHeld, setPullHeld] = useState(false);
  const settleTimer = useRef<number | null>(null);
  const pillTimer = useRef<number | null>(null);
  const interacting = useRef(false);
  const restoring = useRef(false);
  const restoredOnce = useRef(false);
  const leaving = useRef(false);
  const touchStartY = useRef<number | null>(null);
  const pullArmed = useRef(false);
  const rafRef = useRef<number | null>(null);
  const lastAnchor = useRef<TimelineAnchor | null>(null);
  const saveTimer = useRef<number | null>(null);
  const anchorHold = useRef<{ id: string; offset: number; until: number } | null>(null);
  const memoryKey = useMemo(
    () => scrollMemoryKey(scrollPath ?? feedName, scrollTab ?? feedName),
    [scrollPath, scrollTab, feedName],
  );

  // 下拉刷新：松手后保持刷新态，直到 refreshNew 的 refreshing 结束。
  useEffect(() => {
    if (!pullHeld) return;
    if (feed.refreshing) return;
    const timer = window.setTimeout(() => setPullHeld(false), 350);
    return () => window.clearTimeout(timer);
  }, [pullHeld, feed.refreshing]);

  const {
    posts,
    pending,
    loadInitial,
    loadMore,
    refreshNew,
    absorbPending,
    captureAnchor,
    prepareReturn,
    takeRestore,
  } = feed;

  const persist = useCallback(
    (anchor: TimelineAnchor) => {
      saveScrollMemory(memoryKey, {
        path: scrollPath ?? feedName,
        feedTab: scrollTab ?? feedName,
        anchorPostId: anchor.firstVisibleId,
        offsetPx: anchor.offsetPx,
        scrollTop: anchor.scrollTop,
      });
    },
    [memoryKey, scrollPath, scrollTab, feedName],
  );

  const schedulePersist = useCallback(
    (anchor: TimelineAnchor) => {
      lastAnchor.current = anchor;
      if (saveTimer.current !== null) return;
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        if (lastAnchor.current) persist(lastAnchor.current);
      }, 200);
    },
    [persist],
  );

  const captureNow = useCallback(() => {
    if (leaving.current || !restoredOnce.current) return;
    const container = containerRef.current;
    if (!container) return;
    const list = [...container.querySelectorAll<HTMLElement>("[data-post-id]")];
    const containerTop = container.getBoundingClientRect().top;
    const first = list.find((el) => el.getBoundingClientRect().bottom > containerTop + 1);
    const anchor: TimelineAnchor = {
      firstVisibleId: first?.dataset.postId ?? null,
      offsetPx: first ? first.getBoundingClientRect().top - containerTop : 0,
      scrollTop: container.scrollTop,
      atTop: container.scrollTop <= TOP_THRESHOLD,
    };
    captureAnchor(anchor);
    schedulePersist(anchor);
  }, [captureAnchor, schedulePersist]);

  const maybeAbsorb = useCallback(() => {
    if (!restoredOnce.current) return;
    if (restoring.current) return;
    if (document.visibilityState !== "visible") return;
    if (!atTopRef.current) return;
    if (interacting.current) return;
    if (pending.length === 0) return;
    const ids = new Set(pending.map((post) => post.id));
    absorbPending();
    const container = containerRef.current;
    if (container) container.scrollTop = 0;
    setFlashIds(ids);
    // 新帖入场：既有 200ms 位移 + report-read-dwell 的 900ms 未读底色脉冲。
    window.setTimeout(() => setFlashIds(new Set()), 1000);
  }, [pending, absorbPending]);

  // Restore anchor first, then refresh (design §12.2 + §6)。
  // 优先级：内存锚点（同会话返回）→ 持久化锚点 → 持久化 scrollTop → 顶部。
  useLayoutEffect(() => {
    if (restoredOnce.current) return;
    if (posts.length === 0) return;
    const inMemory = takeRestore();
    const saved = inMemory ? null : loadScrollMemory(memoryKey);
    restoredOnce.current = true;
    const container = containerRef.current;
    if (!container) return;
    restoring.current = true;

    const anchorId = inMemory ? inMemory.firstVisibleId : saved?.anchorPostId ?? null;
    const offsetPx = inMemory ? inMemory.offsetPx : saved?.offsetPx ?? 0;
    const scrollTop = inMemory ? inMemory.scrollTop : saved?.scrollTop ?? 0;

    const target = anchorId
      ? container.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(anchorId)}"]`)
      : null;
    if (target) {
      const containerTop = container.getBoundingClientRect().top;
      const delta = target.getBoundingClientRect().top - containerTop;
      // delta 是元素在 scrollTop=0 时的内容偏移；offsetPx = contentOffset - scrollTop
      container.scrollTop = Math.max(0, container.scrollTop + delta - offsetPx);
    } else if (anchorId || scrollTop > 0) {
      container.scrollTop = Math.max(0, scrollTop);
    } else {
      container.scrollTop = 0;
    }

    // 图片/视频元数据会改变上方行高；在短时间内用 ResizeObserver 保持锚点
    // 不漂移（用户一旦主动滚动立即放弃，不跟用户抢滚动条）。
    anchorHold.current = anchorId
      ? { id: anchorId, offset: offsetPx, until: performance.now() + HOLD_MS }
      : null;

    const top = container.scrollTop <= TOP_THRESHOLD;
    atTopRef.current = top;
    setAtTop(top);
    if (!top) {
      schedulePersist({
        firstVisibleId: anchorId,
        offsetPx,
        scrollTop: container.scrollTop,
        atTop: false,
      });
    }
    requestAnimationFrame(() => {
      restoring.current = false;
      // 恢复之后才刷新；非顶部时新帖进 pending，位置不动
      void refreshNew();
    });
  }, [posts.length, takeRestore, refreshNew, memoryKey, schedulePersist]);

  // 恢复窗口内（图片/视频加载改变行高）持续把锚点贴回原 offset（≤2px 容差）。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const align = () => {
      const hold = anchorHold.current;
      if (!hold) return;
      if (performance.now() > hold.until) {
        anchorHold.current = null;
        return;
      }
      const el = container.querySelector<HTMLElement>(
        `[data-post-id="${CSS.escape(hold.id)}"]`,
      );
      if (!el) {
        anchorHold.current = null;
        return;
      }
      const delta =
        el.getBoundingClientRect().top - container.getBoundingClientRect().top - hold.offset;
      if (Math.abs(delta) > 2) container.scrollTop += delta;
    };
    const cancel = () => {
      anchorHold.current = null;
    };
    container.addEventListener("load", align, true);
    container.addEventListener("wheel", cancel, { passive: true });
    container.addEventListener("touchstart", cancel, { passive: true });
    container.addEventListener("pointerdown", cancel);
    container.addEventListener("keydown", cancel);
    const observer = new ResizeObserver(align);
    const observed = new Set<Element>();
    const observeChildren = () => {
      for (const child of Array.from(container.children)) {
        if (observed.has(child)) continue;
        observed.add(child);
        observer.observe(child);
      }
    };
    observeChildren();
    const mutation = new MutationObserver(() => {
      observeChildren();
      align();
    });
    mutation.observe(container, { childList: true });
    return () => {
      container.removeEventListener("load", align, true);
      container.removeEventListener("wheel", cancel);
      container.removeEventListener("touchstart", cancel);
      container.removeEventListener("pointerdown", cancel);
      container.removeEventListener("keydown", cancel);
      observer.disconnect();
      mutation.disconnect();
    };
  }, []);

  // 离开面板（切 tab / 进详情）时记下回退标志并落地最后一次锚点。
  useEffect(() => {
    return () => {
      prepareReturn();
      if (lastAnchor.current) persist(lastAnchor.current);
    };
  }, [prepareReturn, persist]);

  // 刷新/关闭标签页前最后一帧也保存（BFCache 返回同样依赖它）。
  useEffect(() => {
    const flush = () => {
      if (lastAnchor.current) persist(lastAnchor.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [persist]);

  // Scroll → atTop/anchor/load more + 惯性结束判定
  const onScroll = useCallback(() => {
    if (leaving.current || !restoredOnce.current) return;
    const container = containerRef.current;
    if (!container) return;
    const top = container.scrollTop <= TOP_THRESHOLD;
    atTopRef.current = top;
    setAtTop(top);
    interacting.current = true;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        captureNow();
      });
    }
    if (container.scrollHeight - container.scrollTop - container.clientHeight < 640) {
      void loadMore();
    }
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      interacting.current = false;
      maybeAbsorb();
      captureNow();
    }, SETTLE_MS);
  }, [captureNow, maybeAbsorb, loadMore]);

  useEffect(() => {
    return () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      if (pillTimer.current !== null) window.clearTimeout(pillTimer.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Tab hidden → only accumulate, no pill; when visible again merge after 400ms.
  useEffect(() => {
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      setTabVisible(visible);
      if (visible) {
        maybeAbsorb();
        void refreshNew();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [maybeAbsorb, refreshNew]);

  // Pill count: 400ms debounce / 99+ / hidden accumulates silently.
  useEffect(() => {
    if (pillTimer.current !== null) window.clearTimeout(pillTimer.current);
    if (pending.length === 0 || !tabVisible || atTop) {
      setPillCount(0);
      return;
    }
    pillTimer.current = window.setTimeout(() => {
      pillTimer.current = null;
      setPillCount(pending.length);
    }, PILL_MERGE_MS);
  }, [pending.length, tabVisible, atTop]);

  // When settled at top (no drag/inertia), absorb immediately.
  useEffect(() => {
    if (pending.length > 0 && atTop && tabVisible) {
      const timer = window.setTimeout(maybeAbsorb, 0);
      return () => window.clearTimeout(timer);
    }
  }, [pending.length, atTop, tabVisible, maybeAbsorb]);

  // Keyboard: j/k move, Enter open, r reply (design §12.6)
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "j" || event.key === "k") {
        if (posts.length === 0) return;
        event.preventDefault();
        setSelectedIndex((index) => {
          const next =
            event.key === "j"
              ? Math.min(posts.length - 1, index < 0 ? 0 : index + 1)
              : Math.max(0, index < 0 ? 0 : index - 1);
          const el = document.querySelector<HTMLElement>(
            `[data-post-id="${CSS.escape(posts[next]!.id)}"]`,
          );
          el?.scrollIntoView({ block: "nearest" });
          return next;
        });
      } else if (event.key === "Enter" && selectedIndex >= 0) {
        const post = posts[selectedIndex];
        if (!post) return;
        event.preventDefault();
        leaveFor(`/p/${encodeURIComponent(post.id)}`);
      } else if (event.key === "r" && selectedIndex >= 0) {
        const post = posts[selectedIndex];
        if (!post) return;
        event.preventDefault();
        leaveFor(`/p/${encodeURIComponent(post.id)}?reply=1`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts, selectedIndex]);

  const leaveFor = (path: string) => {
    captureNow();
    leaving.current = true;
    prepareReturn();
    navigate(path);
  };
  const openPost = (post: PostView) => leaveFor(`/p/${encodeURIComponent(post.id)}`);
  const replyPost = (post: PostView) => leaveFor(`/p/${encodeURIComponent(post.id)}?reply=1`);
  const quotePost = (post: PostView) =>
    leaveFor(`/compose?quote=${encodeURIComponent(post.id)}`);

  const pendingAuthors = useMemo(
    () =>
      pending
        .slice(0, 3)
        .map((post) => who.find((row) => row.id === post.author))
        .filter((row): row is NonNullable<typeof row> => Boolean(row)),
    [pending, who],
  );

  const pillVisible = pillCount > 0 && !atTop && tabVisible;
  const showSkeleton = feed.initialLoading && posts.length === 0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-feed={feedName}>
      {pillVisible ? (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
          <Button
            type="button"
            data-testid="new-posts-pill"
            className="pointer-events-auto h-8 rounded-full px-3 shadow-lg animate-in fade-in slide-in-from-top-2"
            onClick={() => {
              const ids = new Set(pending.map((post) => post.id));
              absorbPending();
              setFlashIds(ids);
              window.setTimeout(() => setFlashIds(new Set()), 1000);
              containerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            {pending.length >= 4 && pendingAuthors.length > 0 ? (
              <span className="mr-1 flex -space-x-1">
                {pendingAuthors.slice(0, 3).map((author) => (
                  <AuthorAvatar
                    key={author.id}
                    account={author}
                    fallbackId={author.id}
                    size="tiny"
                    className="ring-1 ring-background"
                  />
                ))}
              </span>
            ) : null}
            <ArrowUpIcon data-icon="inline-start" />
            {displayCount(pending.length)} 条新帖子
          </Button>
        </div>
      ) : null}

      {pullDistance > 0 || pullHeld ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-1.5 text-xs text-muted-foreground"
          data-testid="pull-indicator"
          style={{ height: 40, transform: `translateY(${Math.min(40, pullHeld ? 12 : pullDistance / 2)}px)` }}
        >
          {pullHeld ? (
            <>
              <Loader2Icon className="size-3.5 animate-spin" /> 正在刷新…
            </>
          ) : pullDistance > 60 ? (
            "松开刷新"
          ) : (
            "下拉刷新"
          )}
        </div>
      ) : null}

      <div
        ref={containerRef}
        data-testid="timeline-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={onScroll}
        onTouchStart={(event) => {
          const container = containerRef.current;
          if (!container || container.scrollTop > 0 || pullHeld) return;
          touchStartY.current = event.touches[0]?.clientY ?? null;
          pullArmed.current = true;
        }}
        onTouchMove={(event) => {
          if (!pullArmed.current || touchStartY.current === null) return;
          const delta = (event.touches[0]?.clientY ?? 0) - touchStartY.current;
          // 跟手 + 阻尼：手指移动 1px，内容只下移 0.55px，最大 90px
          if (delta > 0) setPullDistance(Math.min(90, delta * 0.55));
        }}
        onTouchEnd={() => {
          const armed = pullArmed.current;
          pullArmed.current = false;
          touchStartY.current = null;
          if (armed && pullDistance > 60) {
            setPullHeld(true);
            setPullDistance(0);
            void refreshNew();
          } else {
            setPullDistance(0);
          }
        }}
        onTouchCancel={() => {
          pullArmed.current = false;
          touchStartY.current = null;
          setPullDistance(0);
        }}
      >
        <div
          className="flex flex-col"
          style={{
            transform: `translateY(${pullHeld ? 44 : pullDistance}px)`,
            transition: pullDistance > 0 ? "none" : "transform 180ms ease-out",
          }}
        >
        {leading}

        <ContentSwap
          ready={!showSkeleton}
          skeleton={<PostListSkeleton count={5} />}
          testId="feed-swap"
        >
          {posts.length === 0 ? (
            <Empty className="py-20">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RefreshCwIcon />
                </EmptyMedia>
                <EmptyTitle>{emptyTitle}</EmptyTitle>
                <EmptyDescription>{emptyDescription}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="divide-y divide-border/60">
              {posts.map((post, index) => (
                <div
                  key={post.id}
                  className={flashIds.has(post.id) ? "report-row-in report-row-new" : undefined}
                >
                  <PostCard
                    post={post}
                    selected={index === selectedIndex}
                    onOpen={openPost}
                    onReply={replyPost}
                    onQuote={quotePost}
                  />
                </div>
              ))}
              <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                {feed.loadingMore ? (
                  <span className="flex items-center gap-2">
                    <Spinner /> 加载更早的帖子…
                  </span>
                ) : feed.hasMore ? (
                  <Button variant="ghost" size="sm" onClick={() => void loadMore()}>
                    加载更早的帖子
                  </Button>
                ) : (
                  "没有更多了"
                )}
              </div>
            </div>
          )}
        </ContentSwap>

        {feed.error ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {feed.error}
                <Button size="sm" variant="outline" onClick={() => void loadInitial()}>
                  <Loader2Icon data-icon="inline-start" /> 重试
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        </div>
      </div>
    </div>
  );
}

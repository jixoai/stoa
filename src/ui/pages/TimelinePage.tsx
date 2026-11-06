import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "cn";
import type { PostView } from "@core/types";
import { ArrowUpIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { PostCard } from "@/components/PostCard";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useConnection } from "@/state/connection";
import { useTimeline, type TimelineAnchor } from "@/state/timeline";
import { navigate } from "@/lib/router";
import { displayCount } from "@/lib/format";

const TOP_THRESHOLD = 5;
const SETTLE_MS = 160;
const PILL_MERGE_MS = 400;

export function TimelinePage() {
  const { who } = useConnection();
  const timeline = useTimeline();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [atTop, setAtTop] = useState(true);
  const atTopRef = useRef(true);
  const [tabVisible, setTabVisible] = useState(() => document.visibilityState === "visible");
  const [pillCount, setPillCount] = useState(0);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [pullDistance, setPullDistance] = useState(0);
  const settleTimer = useRef<number | null>(null);
  const pillTimer = useRef<number | null>(null);
  const interacting = useRef(false);
  const restoring = useRef(false);
  const restoredOnce = useRef(false);
  const leaving = useRef(false);
  const restoreAnchor = useRef<TimelineAnchor | null>(null);
  const touchStartY = useRef<number | null>(null);
  const pullArmed = useRef(false);
  const rafRef = useRef<number | null>(null);

  const posts = timeline.posts;

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
    timeline.captureAnchor(anchor);
  }, [timeline]);

  const maybeAbsorb = useCallback(() => {
    if (!restoredOnce.current) return;
    if (restoring.current) return;
    if (document.visibilityState !== "visible") return;
    if (!atTopRef.current) return;
    if (interacting.current) return;
    if (timeline.pending.length === 0) return;
    const ids = new Set(timeline.pending.map((post) => post.id));
    timeline.absorbPending();
    const container = containerRef.current;
    if (container) container.scrollTop = 0;
    setFlashIds(ids);
    window.setTimeout(() => setFlashIds(new Set()), 400);
  }, [timeline]);

  // Restore anchor first, then refresh (design §12.2).
  useLayoutEffect(() => {
    if (restoredOnce.current) return;
    if (posts.length === 0) return;
    const requested = timeline.takeRestore();
    restoredOnce.current = true;
    const container = containerRef.current;
    if (!container) return;
    restoring.current = true;

    if (requested) {
      restoreAnchor.current = requested;
      const target = requested.firstVisibleId
        ? container.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(requested.firstVisibleId)}"]`)
        : null;
      if (target) {
        const containerTop = container.getBoundingClientRect().top;
        const delta = target.getBoundingClientRect().top - containerTop;
        // delta 是元素在 scrollTop=0 时的内容偏移；offsetPx = contentOffset - scrollTop
        container.scrollTop = Math.max(0, container.scrollTop + delta - requested.offsetPx);
      } else {
        container.scrollTop = Math.max(0, requested.scrollTop);
      }
    } else {
      container.scrollTop = 0;
    }
    const top = container.scrollTop <= TOP_THRESHOLD;
    atTopRef.current = top;
    setAtTop(top);
    requestAnimationFrame(() => {
      restoring.current = false;
      // 恢复之后才刷新；非顶部时新帖进 pending，位置不动
      void timeline.refreshNew();
    });
  }, [posts.length, timeline]);

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
      void timeline.loadMore();
    }
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      interacting.current = false;
      maybeAbsorb();
      captureNow();
    }, SETTLE_MS);
  }, [captureNow, maybeAbsorb, timeline]);

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
        void timeline.refreshNew();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [maybeAbsorb, timeline]);

  // Pill count: 400ms debounce / 99+ / hidden accumulates silently.
  useEffect(() => {
    if (pillTimer.current !== null) window.clearTimeout(pillTimer.current);
    if (timeline.pending.length === 0 || !tabVisible || atTop) {
      setPillCount(0);
      return;
    }
    pillTimer.current = window.setTimeout(() => {
      pillTimer.current = null;
      setPillCount(timeline.pending.length);
    }, PILL_MERGE_MS);
  }, [timeline.pending.length, tabVisible, atTop]);

  // When settled at top (no drag/inertia), absorb immediately.
  useEffect(() => {
    if (timeline.pending.length > 0 && atTop && tabVisible) {
      const timer = window.setTimeout(maybeAbsorb, 0);
      return () => window.clearTimeout(timer);
    }
  }, [timeline.pending.length, atTop, tabVisible, maybeAbsorb]);

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
          const el = document.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(posts[next]!.id)}"]`);
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
  }, [posts, selectedIndex, captureNow, timeline]);

  const leaveFor = (path: string) => {
    captureNow();
    leaving.current = true;
    timeline.prepareReturn();
    navigate(path);
  };
  const openPost = (post: PostView) => {
    leaveFor(`/p/${encodeURIComponent(post.id)}`);
  };
  const replyPost = (post: PostView) => {
    leaveFor(`/p/${encodeURIComponent(post.id)}?reply=1`);
  };
  const quotePost = (post: PostView) => {
    leaveFor(`/compose?quote=${encodeURIComponent(post.id)}`);
  };

  const pendingAuthors = useMemo(
    () =>
      timeline.pending
        .slice(0, 3)
        .map((post) => who.find((row) => row.id === post.author))
        .filter((row): row is NonNullable<typeof row> => Boolean(row)),
    [timeline.pending, who],
  );

  const pillVisible = pillCount > 0 && !atTop && tabVisible;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between border-b border-border/60 bg-background/80 px-4 backdrop-blur-md">
        <h1 className="text-base font-semibold">主页</h1>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {pillVisible ? (
          <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
            <Button
              type="button"
              data-testid="new-posts-pill"
              className="pointer-events-auto h-8 rounded-full px-3 shadow-lg animate-in fade-in slide-in-from-top-2"
              onClick={() => {
                const ids = new Set(timeline.pending.map((post) => post.id));
                timeline.absorbPending();
                setFlashIds(ids);
                window.setTimeout(() => setFlashIds(new Set()), 400);
                containerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              {timeline.pending.length >= 4 && pendingAuthors.length > 0 ? (
                <span className="mr-1 flex -space-x-1">
                  {pendingAuthors.slice(0, 3).map((author) => (
                    <span
                      key={author.id}
                      className="flex size-5 items-center justify-center rounded-full bg-muted text-[9px] ring-1 ring-background"
                      title={author.display}
                    >
                      {author.display.slice(0, 1).toUpperCase()}
                    </span>
                  ))}
                </span>
              ) : null}
              <ArrowUpIcon data-icon="inline-start" />
              {displayCount(timeline.pending.length)} 条新帖子
            </Button>
          </div>
        ) : null}

        {pullDistance > 0 ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center text-xs text-muted-foreground"
            style={{ transform: `translateY(${Math.min(40, pullDistance)}px)` }}
          >
            {pullDistance > 60 ? "松开刷新" : "下拉刷新"}
          </div>
        ) : null}

        <div
          ref={containerRef}
          data-testid="timeline-scroll"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          onScroll={onScroll}
          onTouchStart={(event) => {
            const container = containerRef.current;
            if (!container || container.scrollTop > 0) return;
            touchStartY.current = event.touches[0]?.clientY ?? null;
            pullArmed.current = true;
          }}
          onTouchMove={(event) => {
            if (!pullArmed.current || touchStartY.current === null) return;
            const delta = (event.touches[0]?.clientY ?? 0) - touchStartY.current;
            if (delta > 0) setPullDistance(Math.min(90, delta));
          }}
          onTouchEnd={() => {
            if (pullArmed.current && pullDistance > 60) {
              void timeline.refreshNew();
            }
            pullArmed.current = false;
            touchStartY.current = null;
            setPullDistance(0);
          }}
        >
          {timeline.initialLoading ? (
            <div className="flex flex-col gap-2 p-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="flex gap-3">
                  <Skeleton className="size-10 rounded-full" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                  </div>
                </div>
              ))}
            </div>
          ) : posts.length === 0 ? (
            <Empty className="py-20">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RefreshCwIcon />
                </EmptyMedia>
                <EmptyTitle>还没有帖子</EmptyTitle>
                <EmptyDescription>在「发帖」里写下第一条公示。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="divide-y divide-border/60">
              {posts.map((post, index) => (
                <div key={post.id} className={flashIds.has(post.id) ? "report-row-in" : undefined}>
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
                {timeline.loadingMore ? (
                  <span className="flex items-center gap-2">
                    <Spinner /> 加载更早的帖子…
                  </span>
                ) : timeline.hasMore ? (
                  <Button variant="ghost" size="sm" onClick={() => void timeline.loadMore()}>
                    加载更早的帖子
                  </Button>
                ) : (
                  "没有更多了"
                )}
              </div>
            </div>
          )}

          {timeline.error ? (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  {timeline.error}
                  <Button size="sm" variant="outline" onClick={() => void timeline.loadInitial()}>
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

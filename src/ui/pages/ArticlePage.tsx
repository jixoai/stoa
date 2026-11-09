/**
 * 长文阅读页（report-longform §4.2；路由 `#/a/<id>`，depth 1）。
 *
 * - 唯一 `<h1>`＝`articleSummary` 推导的标题；正文 H1 在 `ArticleBody` 跳过/降级；
 * - 正文列 ≤68ch；作者行/时间/约 N 分钟/标签；`ArticleBody` 渲染四块与 prose；
 * - 正文下方嵌入讨论区（`ArticleDiscussion`，复用线程页 planner 与行渲染件）；
 * - 顶部（页头动作）与底部各有「在独立线程页打开 · N 条回复」入口；
 * - read-dwell：正文根容器带 `data-post-id`/`data-read`，注册到既有 `useReadDwell`
 *   全局观察器，写路径复用 `markPostRead`（本地即时 + `report.readq` 批量同步），
 *   **不新建 read-set、不发独立 `/api/reads` 请求**；静态归档不注册、不渲染 data-read；
 * - `/a/<note>`：拿到帖子后 `replace` 到 `/p/<id>`（无死路由）；软删显示占位。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PostView, ThreadView } from "@core/types";
import { parseArticle } from "@core/article";
import { ArrowLeftIcon, BookmarkCheckIcon, BookmarkIcon, LinkIcon, MessageCircleIcon, QuoteIcon } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/PageHeader";
import { AuthorAvatar, AuthorLine } from "@/components/AuthorAvatar";
import { TagChips } from "@/components/TagChips";
import { ShareMenu } from "@/components/ShareMenu";
import { ArticleBody } from "@/components/ArticleBody";
import { ArticleDiscussion } from "@/components/ArticleDiscussion";
import { ArticleMediaProvider } from "@/lib/article-media";
import { ReplyComposer } from "@/components/ReplyComposer";
import { useConnection } from "@/state/connection";
import { useBookmarks } from "@/state/bookmarks";
import { usePostReadFlag } from "@/state/notifications";
import { useReadDwell } from "@/components/ReadDwellProvider";
import { useEventHub, useEventHubView } from "@/state/hub/provider";
import { getCachedThread, getThreadSeed, rememberThread } from "@/state/cache";
import { goBack, navigate, routeSource, usePageRoute } from "@/lib/router";
import { fullTime } from "@/lib/format";
import { copyText, postLink } from "@/lib/copy";
import { toastReadOnly } from "@/lib/readonly";
import { toast } from "@/components/ui/toast";

function ArticleHeaderMeta({ post, minutes }: { post: PostView; minutes: number }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <AuthorAvatar
        account={post.author_account}
        fallbackId={post.author}
        sharedId={post.id}
        className="size-11"
      />
      <div className="min-w-0">
        <AuthorLine account={post.author_account} fallbackId={post.author} sharedId={post.id} />
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted-foreground">
          <span title={new Date(post.created_at).toLocaleString("zh-CN")}>
            {fullTime(post.created_at)}
          </span>
          <span aria-hidden>·</span>
          <span data-testid="article-minutes">约 {minutes} 分钟</span>
        </div>
      </div>
    </div>
  );
}

function DeletedArticle() {
  return (
    <div className="mx-auto w-full max-w-[68ch] px-4 py-10" data-testid="article-deleted">
      <div className="flex min-h-32 items-center justify-center rounded-lg bg-muted/60 text-sm text-muted-foreground">
        此帖已删除
      </div>
    </div>
  );
}

export function ArticlePage() {
  const route = usePageRoute();
  const postId = route.name === "article" ? route.id : "";
  const source = routeSource(route);
  const { client, staticMode, account } = useConnection();
  const { isBookmarked, toggle: toggleBookmark } = useBookmarks();
  const [thread, setThread] = useState<ThreadView | null>(() =>
    postId ? getThreadSeed(postId) : null,
  );
  const [single, setSingle] = useState<PostView | null>(null);
  const [loaded, setLoaded] = useState(() => Boolean(postId && getCachedThread(postId)));
  const [error, setError] = useState<string | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const pageRef = useRef(postId);
  pageRef.current = postId;
  const threadRef = useRef<ThreadView | null>(thread);
  threadRef.current = thread;
  const refreshTimer = useRef<number | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!client || !postId) return;
      if (!silent) setError(null);
      const page = postId;
      try {
        const next = await client.thread(postId, postId);
        if (pageRef.current !== page) return;
        rememberThread(postId, next);
        setThread(next);
        setLoaded(true);
        setError(null);
      } catch (err) {
        // 线程深链异常（服务端拒绝/快照缺行）：退化为单帖阅读，讨论区留空。
        try {
          const one = await client.post(postId);
          if (pageRef.current !== page) return;
          setSingle(one);
          setLoaded(true);
          setError(null);
        } catch (err2) {
          if (pageRef.current !== page) return;
          if (!silent) setError((err2 as Error).message || (err as Error).message);
        }
      }
    },
    [client, postId],
  );

  // 路由切换：种子优先，然后完整线程（同 ThreadPage 的取数路径）。
  useEffect(() => {
    setThread(postId ? getThreadSeed(postId) : null);
    setSingle(null);
    setLoaded(Boolean(postId && getCachedThread(postId)));
    setError(null);
    setReplyOpen(false);
    void load(false);
  }, [load, postId]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void load(true);
    }, 350);
  }, [load]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  // EventHub：本会话新帖/删除精确失效（不新开连接、不整页刷新）。
  useEventHub(["post.created", "post.deleted", "stream.reset", "stream.reconnected"], (dispatch) => {
    if (dispatch.topic === "stream.reset") {
      void load(false);
      return;
    }
    if (dispatch.topic === "stream.reconnected") {
      scheduleRefresh();
      return;
    }
    if (dispatch.topic !== "post.created" && dispatch.topic !== "post.deleted") return;
    const current = threadRef.current;
    if (!current) return;
    const event = dispatch.event;
    if (
      event.root_id === current.root_id ||
      event.post_id === current.root_id ||
      event.post_id === postId
    ) {
      if (dispatch.topic === "post.deleted") void load(false);
      else scheduleRefresh();
    }
  });

  useEventHubView(
    thread && thread.as_of_seq > 0
      ? { asOfSeq: thread.as_of_seq, catchUp: () => load(true), reload: () => load(false) }
      : null,
  );

  const focal = useMemo<PostView | null>(() => {
    const fromThread = thread?.posts.find((node) => node.id === (thread.focal_id ?? postId));
    return fromThread ?? single;
  }, [thread, single, postId]);

  const bodyMd = focal && focal.deleted_at === null ? focal.body_md : "";
  const doc = useMemo(() => parseArticle(bodyMd), [bodyMd]);
  const deleted = Boolean(focal && focal.deleted_at !== null);

  // `/a/<note>` → `/p/<note>`（不留死路由；kind 创建后不可变）。
  useEffect(() => {
    if (!focal) return;
    if (focal.kind !== "article" && !deleted) {
      navigate(`/p/${encodeURIComponent(focal.id)}`, true);
    }
  }, [focal, deleted]);

  // read-dwell：与 PostCard 同一入口/同一写路径（§4.2；静态模式自动禁用）。
  const articleRef = useRef<HTMLElement | null>(null);
  const readDwell = useReadDwell();
  const localRead = usePostReadFlag(focal?.id ?? "", focal?.seq ?? 0);
  const read = focal?.read === true || localRead;
  const own = account !== null && focal?.author === account.id;
  const hasMedia = (focal?.media.length ?? 0) > 0;
  const trackable = !staticMode && readDwell.active && !deleted && !own && Boolean(focal);
  const observeRead = trackable && !read;
  useEffect(() => {
    const el = articleRef.current;
    if (!el || !observeRead || !focal) return;
    readDwell.observe(el, {
      postId: focal.id,
      author: focal.author,
      seq: focal.seq,
      bodyMd: focal.body_md,
      hasMedia,
      deleted,
    });
    return () => readDwell.unobserve(el);
  }, [readDwell, observeRead, read, focal, hasMedia, deleted]);

  const openThread = () => navigate(`/p/${encodeURIComponent(postId)}`);
  const replyCountLabel = focal
    ? focal.reply_count > 0
      ? `${focal.reply_count} 条回复`
      : "还没有回复"
    : "讨论";

  if (error && !focal) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="长文"
          back
          onBack={() => goBack("/")}
          backTestId="article-back"
          source={`来自${source}`}
        />
        <div className="p-4">
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {error}
              <Button size="sm" variant="outline" onClick={() => void load(false)}>
                重试
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="长文"
        back
        onBack={() => goBack("/")}
        backTestId="article-back"
        source={`来自${source}`}
        tone="thread"
        actions={
          focal ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground"
              data-testid="article-open-thread-top"
              onClick={openThread}
            >
              在独立线程页打开 · {replyCountLabel}
            </Button>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="article-scroll">
        {focal && deleted ? <DeletedArticle /> : null}
        {focal && !deleted ? (
          <ArticleMediaProvider media={focal.media}>
            <article
              ref={articleRef}
              data-post-id={focal.id}
              data-testid="article-view"
              data-read={trackable ? (read ? "1" : "0") : undefined}
              className="mx-auto w-full max-w-[68ch] px-4 pt-6"
            >
              <header data-testid="article-header">
                <Badge variant="outline" className="gap-1 text-[11px]">
                  长文
                </Badge>
                <h1
                  className="mt-2 text-[28px] leading-[36px] font-semibold tracking-tight sm:text-[32px] sm:leading-[40px]"
                  data-testid="article-title"
                >
                  {doc.stats.title}
                </h1>
                <div className="mt-4">
                  <ArticleHeaderMeta post={focal} minutes={doc.stats.minutes} />
                </div>
                <TagChips tags={focal.tags} />
              </header>

              <ArticleBody doc={doc} className="mt-6" />

              <footer className="mt-8 border-t border-border/60 pt-3 pb-2">
                <div className="flex flex-wrap items-center gap-0.5 text-muted-foreground">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="article-action-reply"
                    aria-label={replyCountLabel}
                    aria-disabled={staticMode || undefined}
                    className={cn("h-11 min-w-11 px-2", staticMode && "opacity-60")}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (staticMode) {
                        toastReadOnly();
                        return;
                      }
                      setReplyOpen(true);
                    }}
                  >
                    <MessageCircleIcon className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="article-action-quote"
                    aria-label="引用"
                    aria-disabled={staticMode || undefined}
                    className={cn("h-11 min-w-11 px-2", staticMode && "opacity-60")}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (staticMode) {
                        toastReadOnly();
                        return;
                      }
                      navigate(`/compose?quote=${encodeURIComponent(focal.id)}`);
                    }}
                  >
                    <QuoteIcon className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="article-action-bookmark"
                    aria-label={isBookmarked(focal.id) ? "取消收藏" : "收藏"}
                    aria-pressed={isBookmarked(focal.id)}
                    className={cn(
                      "h-11 min-w-11 px-2",
                      isBookmarked(focal.id) && "text-foreground",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleBookmark(focal.id);
                    }}
                  >
                    {isBookmarked(focal.id) ? (
                      <BookmarkCheckIcon className="size-4" />
                    ) : (
                      <BookmarkIcon className="size-4" />
                    )}
                  </Button>
                  <ShareMenu post={focal} />
                  <ArticleCopyLink post={focal} />
                </div>
                <div className="mt-2 text-sm">
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-link"
                    data-testid="article-open-thread-bottom"
                    onClick={openThread}
                  >
                    在独立线程页打开 · {replyCountLabel}
                  </Button>
                </div>
              </footer>
            </article>

            <ArticleDiscussion
              post={focal}
              thread={thread}
              loaded={loaded}
              onOpenReply={() => {
                if (staticMode) {
                  toastReadOnly();
                  return;
                }
                setReplyOpen(true);
              }}
            />

            {staticMode ? (
              <div
                className="mx-auto w-full max-w-[68ch] px-4 pb-6 text-sm text-muted-foreground"
                data-testid="article-readonly"
              >
                静态归档 · 只读：这篇长文以导出时的快照为准，不能回复。
              </div>
            ) : null}
          </ArticleMediaProvider>
        ) : null}
      </div>

      {focal && !deleted && !staticMode ? (
        <ReplyComposer
          post={focal}
          open={replyOpen}
          onOpenChange={setReplyOpen}
          onPosted={() => void load(false)}
        />
      ) : null}
    </div>
  );
}

/** 复制链接（canonical `#/a/<id>`）：静态归档只读下仍可用（不写服务端）。 */
function ArticleCopyLink({ post }: { post: PostView }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="article-action-copy"
      aria-label="复制链接"
      className="h-11 min-w-11 px-2"
      onClick={async (event) => {
        event.stopPropagation();
        // 复核 O11：载体从 focal 本身取（不再写字面量）——链接形态与数据同源。
        const ok = await copyText(postLink(post.id, post.kind));
        toast.add(
          ok
            ? { type: "success", title: "链接已复制", timeout: 1600 }
            : { type: "error", title: "复制失败", description: "请长按/右键手动复制链接", timeout: 2400 },
        );
      }}
    >
      <LinkIcon className="size-4" />
    </Button>
  );
}

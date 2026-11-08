import { useRef, useState } from "react";
import { cn } from "cn";
import type { PostView } from "@core/types";

type PostLike = PostView & { i?: number; n?: number };
import {
  BookmarkCheckIcon,
  BookmarkIcon,
  CheckIcon,
  LinkIcon,
  MessageCircleIcon,
  QuoteIcon,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { MediaGrid } from "@/components/MediaGrid";
import { QuoteCard } from "@/components/QuoteCard";
import { TagChips } from "@/components/TagChips";
import { AuthorAvatar, AuthorLine } from "@/components/AuthorAvatar";
import { Button } from "@/components/ui/button";
import { copyText, postLink } from "@/lib/copy";
import { timeShort } from "@/lib/format";
import { useConnection } from "@/state/connection";
import { useBookmarks } from "@/state/bookmarks";
import { prefetchThread } from "@/state/cache";
import { markSharedSubject } from "@/lib/shared-element";
import { toastReadOnly } from "@/lib/readonly";

export type PostVariant = "feed" | "focal" | "reply" | "ancestor";

interface PostCardProps {
  post: PostLike;
  variant?: PostVariant;
  onOpen?: (post: PostLike) => void;
  onReply?: (post: PostLike) => void;
  onQuote?: (post: PostLike) => void;
  onCopy?: (post: PostLike) => void;
  selected?: boolean;
  /** 「回复给 @x」：仅当父帖不是上一 post 行时由 planner 传入（design §2.3）。 */
  replyingTo?: string | null;
  /** 自接线程的连续续接条目：24px 头像靠正文列一侧、无作者行/操作栏。 */
  selfContinuation?: boolean;
  /** 连续自接链的首条仍显示作者/时间（整链头像统一 24px、同列同轨）。 */
  selfHeader?: boolean;
  /** 头像像素（feed 42；线程 timeline 行 46）。 */
  avatarPx?: number;
  /** 头像列与正文的间距（feed 12；线程 6 → 正文列 x=68）。 */
  avatarGapPx?: number;
  /** 行首内边距（默认 12；focal 20）。 */
  paddingTop?: number;
  className?: string;
  testId?: string;
}

/** 线程 timeline 行的字号：正文 17/27（设计复核 16.5–17 / 26–28）。 */
const THREAD_BODY = "text-[17px] leading-[25px]";

/**
 * 单条帖文卡片。
 *
 * - feed：正文约 6 行截断 + 展开；focal/ancestor：全文永不截断（design §12.3）
 * - 线程行共用同一条 46px 头像列（正文列 x=68）与 `px-4` 水平度量：不做任何缩进
 *   （design report-thread-timeline §3）；自接链续接条的 24px 头像**同轴居中**（中心 39）
 * - 操作栏固定三键：回复 / 引用 / 复制链接（无点赞转发）
 */
export function PostCard({
  post,
  variant = "feed",
  onOpen,
  onReply,
  onQuote,
  onCopy,
  selected = false,
  replyingTo = null,
  selfContinuation = false,
  selfHeader = false,
  avatarPx,
  avatarGapPx,
  paddingTop,
  className,
  testId,
}: PostCardProps) {
  const { staticMode, client } = useConnection();
  const { isBookmarked, toggle: toggleBookmark } = useBookmarks();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const deleted = post.deleted_at !== null;
  const author = post.author_account;
  // 目标页（焦点帖）用静态共享名；列表/回复/上文卡片不使用静态名，
  // 由点击处理器按「被点击的主体」打标（lib/shared-element）。
  const canShare = variant === "focal";

  const canClamp = variant === "feed" && !deleted;
  const longBody = post.body_md.length > 420 || post.body_md.split("\n").length > 6;
  const clamped = canClamp && longBody && !expanded;

  const handleOpen = (host: Element | null) => {
    if (deleted) return;
    // 共享元素主体＝被点的这条帖子（不是“列表里第一张同名卡片”）。
    markSharedSubject(host, post.id);
    onOpen?.(post);
  };

  const handleCopy = async () => {
    const ok = await copyText(postLink(post.id));
    if (ok) {
      setCopied(true);
      onCopy?.(post);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const startLongPress = () => {
    longPressed.current = false;
    if (copyTimer.current !== null) return;
    copyTimer.current = window.setTimeout(() => {
      copyTimer.current = null;
      longPressed.current = true;
      void handleCopy();
    }, 550);
  };
  const cancelLongPress = () => {
    if (copyTimer.current !== null) {
      window.clearTimeout(copyTimer.current);
      copyTimer.current = null;
    }
  };

  if (selfContinuation) {
    // 连续自接续接行：24px 头像与普通行同轴（中心 39，gutter 17，正文列仍 x=68），
    // 编号不做独立 chip 行，改正文行内后缀「· 5/9」。
    const inlineNumber =
      post.i !== undefined && post.n !== undefined ? ` · ${post.i}/${post.n}` : "";
    const source = deleted ? post.body_md : `${post.body_md}${inlineNumber}`;
    return (
      <article
        data-post-id={post.id}
        data-shared-host
        data-author={post.author}
        data-testid={testId ?? "post-self-continuation"}
        className={cn("relative flex items-start px-4 py-1.5", selected && "bg-accent/50", className)}
        style={{ gap: 6 }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a,button,input,textarea")) return;
          handleOpen(event.currentTarget);
        }}
      >
        <div className="flex w-[46px] shrink-0 items-start justify-center">
          <div className="relative z-[1] size-6" data-shared-avatar>
            <AuthorAvatar account={author} fallbackId={post.author} size="small" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          {selfHeader ? (
            <div data-shared-author>
              <AuthorLine
                account={author}
                fallbackId={post.author}
                time={timeShort(post.created_at)}
                size="thread"
                sharedId={canShare ? post.id : undefined}
              />
            </div>
          ) : null}
          {deleted ? (
            <DeletedBody compact />
          ) : (
            <>
              <div data-testid="post-body" className={cn(THREAD_BODY, selfHeader && "mt-0.5")}>
                <Markdown source={source} />
              </div>
              <MediaGrid media={post.media} />
              <QuoteCard post={post} />
              <TagChips tags={post.tags} />
            </>
          )}
        </div>
      </article>
    );
  }

  return (
    <article
      data-post-id={post.id}
      data-shared-host
      data-author={post.author}
      data-testid={testId ?? "post-card"}
      data-variant={variant}
      className={cn(
        "relative px-4 transition-colors",
        variant === "feed" ? "pb-3" : "pb-1.5",
        onOpen && !deleted && "cursor-pointer hover:bg-muted/30",
        selected && "bg-accent/60 ring-2 ring-ring/40",
        className,
      )}
      style={{ paddingTop: paddingTop ?? 12 }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a,button,input,textarea")) return;
        handleOpen(event.currentTarget);
      }}
      onPointerEnter={() => prefetchThread(client, post.id)}
      onPointerDown={() => prefetchThread(client, post.id)}
    >
      <div className="flex" style={{ gap: avatarGapPx ?? 12 }}>
        <div className="relative z-[1] shrink-0" data-shared-avatar>
          <AuthorAvatar
            account={author}
            fallbackId={post.author}
            size="normal"
            pixel={avatarPx}
            sharedId={canShare ? post.id : undefined}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div data-shared-author>
                <AuthorLine
                  account={author}
                  fallbackId={post.author}
                  time={timeShort(post.created_at)}
                  size={variant === "feed" ? "default" : "thread"}
                  sharedId={canShare ? post.id : undefined}
                />
              </div>
              {replyingTo ? (
                <div className="mt-0.5 text-[13px] text-muted-foreground">
                  回复给 <span className="font-medium text-link">@{replyingTo}</span>
                </div>
              ) : null}
            </div>
          </div>

          {deleted ? (
            <DeletedBody />
          ) : (
            <>
              <div
                data-testid="post-body"
                className={cn(
                  variant === "feed" ? "mt-1 text-[0.95rem]" : cn("-mt-2", THREAD_BODY),
                  clamped && "report-clamp-6",
                )}
              >
                <Markdown source={post.body_md} />
              </div>
              {canClamp && longBody ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  data-testid="expand-body"
                  className="mt-1 h-auto justify-start p-0 text-sm text-link"
                  onClick={(event) => {
                    event.stopPropagation();
                    setExpanded((value) => !value);
                  }}
                >
                  {expanded ? "收起" : "展开"}
                </Button>
              ) : null}
              <MediaGrid media={post.media} />
              <QuoteCard post={post} />
              <TagChips tags={post.tags} />
            </>
          )}

          {!deleted ? (
            <div
              data-testid="post-actions"
              className={cn(
                "text-muted-foreground",
                variant === "feed"
                  ? "-ml-2 mt-1.5 flex flex-wrap items-center gap-0.5"
                  : "-mt-1.5 flex w-full max-w-[464px] flex-wrap items-center justify-between",
              )}
            >
              <Button
                variant="ghost"
                size="sm"
                data-testid="action-reply"
                aria-disabled={staticMode || undefined}
                className={cn(
                  "h-11 min-w-11 gap-1.5 px-2",
                  variant !== "feed" && "-ml-2",
                  staticMode && "opacity-60",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  if (staticMode) {
                    toastReadOnly();
                    return;
                  }
                  onReply?.(post);
                }}
              >
                <MessageCircleIcon className="size-4" data-icon="inline-start" />
                回复{post.reply_count > 0 ? ` ${post.reply_count}` : ""}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="action-quote"
                aria-disabled={staticMode || undefined}
                className={cn("h-11 min-w-11 gap-1.5 px-2", staticMode && "opacity-60")}
                onClick={(event) => {
                  event.stopPropagation();
                  if (staticMode) {
                    toastReadOnly();
                    return;
                  }
                  onQuote?.(post);
                }}
              >
                <QuoteIcon className="size-4" data-icon="inline-start" />
                引用
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="action-bookmark"
                aria-pressed={isBookmarked(post.id)}
                aria-disabled={staticMode || undefined}
                title={isBookmarked(post.id) ? "取消收藏" : "收藏（账号菜单 → 收藏）"}
                className={cn(
                  "h-11 min-w-11 gap-1.5 px-2",
                  staticMode && "opacity-60",
                  isBookmarked(post.id) && "text-foreground",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleBookmark(post.id);
                }}
              >
                {isBookmarked(post.id) ? (
                  <BookmarkCheckIcon className="size-4" data-icon="inline-start" />
                ) : (
                  <BookmarkIcon className="size-4" data-icon="inline-start" />
                )}
                收藏
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="action-copy"
                title="点击复制；长按/右键也可复制链接"
                className={cn("h-11 min-w-11 gap-1.5 px-2", variant !== "feed" && "-mr-2")}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  startLongPress();
                }}
                onPointerUp={cancelLongPress}
                onPointerLeave={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onContextMenu={(event) => {
                  event.preventDefault();
                  cancelLongPress();
                  void handleCopy();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (longPressed.current) {
                    longPressed.current = false;
                    return;
                  }
                  void handleCopy();
                }}
              >
                {copied ? <CheckIcon className="size-4" data-icon="inline-start" /> : <LinkIcon className="size-4" data-icon="inline-start" />}
                {copied ? "已复制" : "复制链接"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function DeletedBody({ compact = false }: { compact?: boolean }) {
  return (
    <div
      data-testid="deleted-placeholder"
      className={cn(
        "mt-1 flex items-center rounded-lg bg-muted/60 px-3 text-sm text-muted-foreground",
        compact ? "min-h-8" : "min-h-16",
      )}
    >
      此帖已删除
    </div>
  );
}

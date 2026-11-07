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
import { Badge } from "@/components/ui/badge";
import { copyText, postLink } from "@/lib/copy";
import { timeShort } from "@/lib/format";
import { useConnection } from "@/state/connection";
import { useBookmarks } from "@/state/bookmarks";
import { prefetchThread } from "@/state/cache";
import { markSharedSubject } from "@/lib/shared-element";
import { toastReadOnly } from "@/lib/readonly";

export type PostVariant = "feed" | "focal" | "reply" | "ancestor";
export type ChainPosition = "none" | "start" | "middle" | "end" | "single";

interface PostCardProps {
  post: PostLike;
  variant?: PostVariant;
  onOpen?: (post: PostLike) => void;
  onReply?: (post: PostLike) => void;
  onQuote?: (post: PostLike) => void;
  onCopy?: (post: PostLike) => void;
  selected?: boolean;
  replyingTo?: string | null;
  /** 自接线程的后续条目：24px 头像、无作者行/操作栏 */
  selfContinuation?: boolean;
  /** 自接链首条仍显示作者/时间（整链头像统一 24px） */
  selfHeader?: boolean;
  chainPosition?: ChainPosition;
  className?: string;
  testId?: string;
}

/**
 * 单条帖文卡片。
 *
 * - feed：正文约 6 行截断 + 展开；focal：全文永不截断（design §12.3）
 * - 自接线程后续条：仅头像 + 正文 + i/n，连接线沿头像列（design §12.4）
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
  chainPosition = "none",
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
    return (
      <article
        data-post-id={post.id}
        data-shared-host
        data-author={post.author}
        data-testid={testId ?? "post-self-continuation"}
        className={cn("relative flex gap-2 px-3 py-1.5", selected && "bg-accent/50", className)}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a,button,input,textarea")) return;
          handleOpen(event.currentTarget);
        }}
      >
        {chainPosition !== "none" && chainPosition !== "single" ? (
          <span
            aria-hidden
            className="absolute left-[23px] w-0.5 bg-border"
            style={
              chainPosition === "start"
                ? { top: 24, bottom: 0 }
                : chainPosition === "end"
                  ? { top: 0, height: 12 }
                  : { top: 0, bottom: 0 }
            }
          />
        ) : null}
        <div className="relative z-[1] shrink-0" data-shared-avatar>
          <AuthorAvatar account={author} fallbackId={post.author} size="small" />
        </div>
        <div className="min-w-0 flex-1">
          {selfHeader ? (
            <div className="flex items-start justify-between gap-2">
              <div data-shared-author>
                <AuthorLine
                  account={author}
                  fallbackId={post.author}
                  time={timeShort(post.created_at)}
                  sharedId={canShare ? post.id : undefined}
                />
              </div>
              {post.i !== undefined && post.n !== undefined ? (
                <Badge variant="secondary" className="shrink-0 h-4 px-1 text-[10px]">
                  {post.i}/{post.n}
                </Badge>
              ) : null}
            </div>
          ) : post.i !== undefined && post.n !== undefined ? (
            <Badge variant="secondary" className="mb-0.5 h-4 px-1 text-[10px]">
              {post.i}/{post.n}
            </Badge>
          ) : null}
          {deleted ? (
            <DeletedBody compact />
          ) : (
            <>
              <Markdown source={post.body_md} className="text-[0.95rem]" />
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
        "relative px-4 py-3 transition-colors",
        onOpen && !deleted && "cursor-pointer hover:bg-muted/30",
        selected && "bg-accent/60 ring-2 ring-ring/40",
        className,
      )}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a,button,input,textarea")) return;
        handleOpen(event.currentTarget);
      }}
      onPointerEnter={() => prefetchThread(client, post.id)}
      onPointerDown={() => prefetchThread(client, post.id)}
    >
      <div className="flex gap-3">
        <div className="shrink-0" data-shared-avatar>
          <AuthorAvatar
            account={author}
            fallbackId={post.author}
            size={variant === "ancestor" ? "small" : "normal"}
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
                  sharedId={canShare ? post.id : undefined}
                />
              </div>
              {replyingTo ? (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  回复 <span className="text-link">@{replyingTo}</span>
                </div>
              ) : null}
            </div>
            {post.i !== undefined && post.n !== undefined ? (
              <Badge variant="secondary" className="shrink-0">
                {post.i}/{post.n}
              </Badge>
            ) : null}
          </div>

          {deleted ? (
            <DeletedBody />
          ) : (
            <>
              <div
                className={cn(
                  "mt-1",
                  variant === "focal" ? "text-[1.05rem] leading-relaxed" : "text-[0.95rem]",
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
            <div className="-ml-2 mt-1.5 flex flex-wrap items-center gap-0.5 text-muted-foreground">
              <Button
                variant="ghost"
                size="sm"
                data-testid="action-reply"
                aria-disabled={staticMode || undefined}
                className={cn("h-11 min-w-11 gap-1.5 px-2", staticMode && "opacity-60")}
                onClick={(event) => {
                  event.stopPropagation();
                  if (staticMode) {
                    toastReadOnly();
                    return;
                  }
                  onReply?.(post);
                }}
              >
                <MessageCircleIcon data-icon="inline-start" />
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
                <QuoteIcon data-icon="inline-start" />
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
                  <BookmarkCheckIcon data-icon="inline-start" />
                ) : (
                  <BookmarkIcon data-icon="inline-start" />
                )}
                收藏
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="action-copy"
                title="点击复制；长按/右键也可复制链接"
                className="h-11 min-w-11 gap-1.5 px-2"
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
                {copied ? <CheckIcon data-icon="inline-start" /> : <LinkIcon data-icon="inline-start" />}
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

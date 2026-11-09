import { useMemo } from "react";
import type { PostView, QuotedView } from "@core/types";
import { cn } from "cn";
import { ChevronRightIcon, EyeOffIcon, FileTextIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/Markdown";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { mediaFileName, mediaKind, useMediaUrl } from "@/lib/media";
import { timeShort } from "@/lib/format";
import { postHashHref } from "@/lib/post-href";
import { articleSummary } from "@core/article";
import { useConnection } from "@/state/connection";

function QuoteThumb({ quoted }: { quoted: QuotedView }) {
  const { client } = useConnection();
  const first = quoted.media[0];
  const state = useMediaUrl(client, first?.hash ?? null);
  if (!first || !state.url) return null;
  const kind = mediaKind(first.ext);
  if (kind === "video") {
    return (
      <video
        src={`${state.url}#t=0.1`}
        muted
        playsInline
        preload="metadata"
        aria-label={`视频 ${mediaFileName(first)}`}
        className="mt-2 max-h-40 w-full rounded-lg bg-black object-cover"
      />
    );
  }
  if (kind !== "image") return null;
  return (
    <img
      src={state.url}
      alt=""
      loading="lazy"
      className="mt-2 max-h-40 w-full rounded-lg object-cover"
    />
  );
}

/**
 * 引用卡：圆角描边容器 + 作者行 + 正文（≤3 行）+ 可选缩略图；整卡一个可点区域。
 * 只渲染一层；二级引用降级为链接（design §12.5）。
 */
export function QuoteCard({ post, className }: { post: PostView; className?: string }) {
  const rawQuoted = post.quoted;
  const quotedSummary = useMemo(
    () => (rawQuoted?.kind === "article" ? articleSummary(rawQuoted.body_md) : null),
    [rawQuoted?.kind, rawQuoted?.body_md],
  );
  if (!post.quoted_post_id) return null;
  if (!post.quoted_visible || !post.quoted) {
    return (
      <div
        data-testid="quote-unavailable"
        className={cn(
          "mt-2 flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground",
          className,
        )}
      >
        <EyeOffIcon className="size-4" /> 引用内容不可见
      </div>
    );
  }
  const quoted = post.quoted;
  return (
    <a
      href={postHashHref(quoted)}
      data-testid="quote-card"
      data-quote-kind={quoted.kind}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "mt-2 block rounded-xl border border-border bg-panel px-3 py-2 text-sm transition-colors hover:bg-muted/40",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <AuthorAvatar
          account={{
            id: quoted.author,
            display: quoted.display,
            profile: "",
            avatar: "",
            role: "agent",
            disabled: 0,
          }}
          fallbackId={quoted.author}
          size="tiny"
        />
        <span className="truncate font-medium">{quoted.display}</span>
        <span className="truncate text-xs text-muted-foreground">@{quoted.author}</span>
        <span
          className="ml-auto shrink-0 text-xs text-muted-foreground"
          data-testid="quote-time"
          title={new Date(quoted.created_at).toLocaleString("zh-CN")}
        >
          {timeShort(quoted.created_at)}
        </span>
      </div>
      {quoted.kind === "article" && quotedSummary ? (
        // 长文引用（report-longform §2.1/§4.3）：只显示「长文」徽标 + 标题 + 摘要，
        // 不渲染全文（D10）；整卡链接按 kind 指向 `#/a/<id>`。
        <div className="mt-1" data-testid="quote-article-summary">
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="shrink-0 gap-1 text-[10px]">
              <FileTextIcon className="size-3" aria-hidden />
              长文
            </Badge>
            <span className="line-clamp-1 min-w-0 flex-1 font-medium text-foreground">
              {quotedSummary.title}
            </span>
          </div>
          {quotedSummary.excerpt ? (
            <p className="mt-0.5 line-clamp-2 text-muted-foreground">{quotedSummary.excerpt}</p>
          ) : null}
          <p className="mt-0.5 text-xs text-muted-foreground">约 {quotedSummary.minutes} 分钟</p>
        </div>
      ) : (
        <div className="mt-1 line-clamp-3 text-muted-foreground">
          <Markdown source={quoted.body_md} className="[&_p]:my-0" linkTags={false} />
        </div>
      )}
      <QuoteThumb quoted={quoted} />
      {quoted.quoted_post_id ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-link">
          查看引用的引用 <ChevronRightIcon className="size-3" />
        </span>
      ) : null}
    </a>
  );
}

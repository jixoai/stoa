import type { PostView, QuotedView } from "@core/types";
import { cn } from "cn";
import { ChevronRightIcon, EyeOffIcon } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { useMediaUrl } from "@/lib/media";
import { useConnection } from "@/state/connection";

function QuoteThumb({ quoted }: { quoted: QuotedView }) {
  const { client } = useConnection();
  const first = quoted.media[0];
  const state = useMediaUrl(client, first?.hash ?? null);
  if (!first || !state.url) return null;
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
      href={`#/p/${encodeURIComponent(quoted.id)}`}
      data-testid="quote-card"
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
      </div>
      <div className="mt-1 line-clamp-3 text-muted-foreground">
        <Markdown source={quoted.body_md} className="[&_p]:my-0" />
      </div>
      <QuoteThumb quoted={quoted} />
      {quoted.quoted_post_id ? (
        <span className="mt-1 inline-flex items-center gap-1 text-xs text-link">
          查看引用的引用 <ChevronRightIcon className="size-3" />
        </span>
      ) : null}
    </a>
  );
}

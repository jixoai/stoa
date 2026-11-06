/**
 * 标签过滤页（design §5.0）：`#/tag/<tag>`，数据源＝`/api/read?tag=`。
 * 点击任意帖子的 tag chip 进入；保留时间线的 pending / 胶囊机制。
 */
import { useMemo } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TimelineFeed } from "@/components/TimelineFeed";
import { useConnection } from "@/state/connection";
import { usePostFeed } from "@/state/feed";
import { goBack, useRoute } from "@/lib/router";
import { isSemanticTag, tagChipClass, tagDescription, tagLabel } from "@/lib/tags";

export function TagPage() {
  const route = useRoute();
  const tag = route.name === "tag" ? route.tag : "";
  const { client } = useConnection();

  const feed = usePostFeed(
    client
      ? async (query) => {
          const page = await client.read({
            tag,
            after: query.after,
            limit: 100,
          });
          // `read` has no before cursor; the tag page is a latest-100 view.
          return {
            posts: page.posts,
            has_more: false,
            next_cursor: null,
            as_of_seq: 0,
          };
        }
      : null,
    { resetKey: tag },
  );

  const badge = useMemo(() => (isSemanticTag(tag) ? tagLabel(tag) : "自定义"), [tag]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border/60 bg-background/80 px-2 backdrop-blur-md">
        <Button variant="ghost" size="icon-sm" onClick={() => goBack("/")} aria-label="返回">
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">#{tag}</h1>
        </div>
        <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
          {tagDescription(tag)}
        </span>
        <Badge variant="outline" className={cn("shrink-0 border", tagChipClass(tag))}>
          {badge}
        </Badge>
      </header>

      <TimelineFeed
        key={tag}
        feed={feed}
        feedName={`tag:${tag}`}
        emptyTitle={`没有带 #${tag} 的帖子`}
        emptyDescription="标签会随发帖箱一起提交；换个标签或回主页看看。"
      />
    </div>
  );
}

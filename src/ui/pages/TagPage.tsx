/**
 * 标签过滤页（design §5.0）：`#/tag/<tag>`，数据源＝`/api/read?tag=`。
 * 点击任意帖子的 tag chip 进入；保留时间线的 pending / 胶囊机制。
 */
import { useMemo } from "react";
import { TimelineFeed } from "@/components/TimelineFeed";
import { PageHeader } from "@/components/PageHeader";
import { useConnection } from "@/state/connection";
import { usePostFeed } from "@/state/feed";
import { getCachedTagPosts } from "@/state/cache";
import { goBack, routeSource, useRoute } from "@/lib/router";
import { tagDescription } from "@/lib/tags";

export function TagPage() {
  const route = useRoute();
  const tag = route.name === "tag" ? route.tag : "";
  const source = routeSource(route);
  const { client } = useConnection();
  // 首帧种子：已在时间线里见过的同标签帖子，进入标签页的第一帧就是完整列表。
  const seedPosts = useMemo(() => (tag ? getCachedTagPosts(tag) : []), [tag]);

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
    {
      resetKey: tag,
      initialPosts: seedPosts,
      cacheKey: tag ? `tag:${tag}` : undefined,
    },
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={`#${tag}`}
        back
        onBack={() => goBack("/")}
        backTestId="tag-back"
        source={`来自${source} · ${tagDescription(tag)}`}
        sourceTestId="tag-source"
      />

      <TimelineFeed
        key={tag}
        feed={feed}
        feedName={`tag:${tag}`}
        scrollPath={`/tag/${tag}`}
        scrollTab="tag"
        emptyTitle={`没有带 #${tag} 的帖子`}
        emptyDescription="标签会随发帖箱一起提交；换个标签或回主页看看。"
      />
    </div>
  );
}

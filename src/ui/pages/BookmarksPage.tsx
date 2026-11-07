/**
 * 收藏页（根页 `#/bookmarks`）：当前账号收藏的帖子（根帖与回复都算），按帖子时间倒序。
 *
 * - 数据来自 `/api/bookmarks`（仍受可见性约束）；取消收藏后立刻从列表移除；
 * - 首帧用时间线快照种子（cacheKey），其余与通用 feed 一致（骨架/锚点/加载更多）；
 * - 静态归档：列表来自导出快照，写操作只读。
 */
import { useCallback, useMemo } from "react";
import type { FeedPageData, FeedQuery } from "@/state/feed";
import { usePostFeed } from "@/state/feed";
import { useBookmarks } from "@/state/bookmarks";
import { useConnection } from "@/state/connection";
import { PageHeader } from "@/components/PageHeader";
import { TimelineFeed } from "@/components/TimelineFeed";
import { goBack } from "@/lib/router";

export function BookmarksPage() {
  const { client } = useConnection();
  const { ids, ready } = useBookmarks();

  const loader = useCallback(
    async (query: FeedQuery): Promise<FeedPageData> => {
      if (!client) throw new Error("未连接后端");
      const page = await client.bookmarks({
        before: query.before,
        after: query.after,
        limit: query.limit,
      });
      return {
        posts: page.posts,
        has_more: page.has_more,
        next_cursor: page.next_cursor,
        as_of_seq: page.as_of_seq,
      };
    },
    [client],
  );

  const feed = usePostFeed(client ? loader : null, { cacheKey: "bookmarks" });

  // 取消收藏后立即从列表移除（服务端返回前也不闪回）。
  const visible = useMemo(() => {
    if (!ready) return feed;
    return { ...feed, posts: feed.posts.filter((post) => ids.has(post.id)) };
  }, [feed, ids, ready]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="收藏"
        back
        onBack={() => goBack("/")}
        backTestId="bookmarks-back"
        source="账号私有"
      />

      <TimelineFeed
        feed={visible}
        feedName="bookmarks"
        scrollPath="/bookmarks"
        scrollTab="all"
        emptyTitle="还没有收藏"
        emptyDescription="点帖子下方的「收藏」，会出现在这里。"
      />
    </div>
  );
}

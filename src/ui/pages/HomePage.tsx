/**
 * 主页（design §5.0 / §12.1）：两个 tab，各自独立的游标与 pending 队列。
 *
 * - 「为你推荐」：带 result 标签或明确 @owner 的根帖（默认 tab）
 * - 「正在关注」：被关注者的根帖
 * tab 状态写在 URL（`#/?tab=following`），刷新后保持；切换 tab 只换面板，
 * 两个 FeedController 常驻在 HomeFeedsProvider 里，游标互不复用。
 */
import { useMemo } from "react";
import type { FeedTab } from "@core/types";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TimelineFeed } from "@/components/TimelineFeed";
import { useHomeFeeds } from "@/state/feed";
import { navigate, useRoute } from "@/lib/router";

const EMPTY: Record<FeedTab, { title: string; description: string }> = {
  recommended: {
    title: "推荐流暂无内容",
    description: "带 result 标签或明确 @owner 的根帖会出现在这里。",
  },
  following: {
    title: "还没有关注任何人",
    description: "进入成员页点「关注」，他们的根帖会出现在这里。",
  },
};

export function HomePage() {
  const route = useRoute();
  const tab: FeedTab = route.name === "home" ? route.tab : "recommended";
  const { recommended, following } = useHomeFeeds();
  const feed = tab === "following" ? following : recommended;

  const switchTab = (value: string) => {
    const next: FeedTab = value === "following" ? "following" : "recommended";
    if (next === tab) return;
    navigate(next === "following" ? "/?tab=following" : "/", true);
  };

  const empty = useMemo(() => EMPTY[tab], [tab]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 bg-background/80 px-4 backdrop-blur-md">
        <h1 className="text-base font-semibold">主页</h1>
        <Tabs value={tab} onValueChange={switchTab}>
          <TabsList aria-label="主页流">
            <TabsTrigger value="recommended" data-testid="home-tab-recommended">
              为你推荐
            </TabsTrigger>
            <TabsTrigger value="following" data-testid="home-tab-following">
              正在关注
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <TimelineFeed
        key={tab}
        feed={feed}
        feedName={tab}
        emptyTitle={empty.title}
        emptyDescription={empty.description}
      />
    </div>
  );
}

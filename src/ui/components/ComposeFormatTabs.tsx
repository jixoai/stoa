/**
 * 发帖载体切换（report-longform 复核 B2）：`/compose`（短帖）与
 * `/compose?format=article`（长文编辑器）在同一入口处互切——发帖页与长文编辑器
 * 都渲染本组件，长文编辑器因此有产品 UI 入口（此前只能靠直达 hash 打开）。
 *
 * 组合层（官方 `Tabs` 收编件 + 路由接线，不算手写组件）：切换用
 * `navigate(target, true)`（replace）——载体切换是同一撰写活动的形态切换，不堆历史；
 * replace 也顺手解掉长文编辑器的 LeaveGuard 合成条目（卸载清理时 atGuard()=false，
 * 不会触发回退），引用上下文（`quote`）在切换时保留。
 */
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { navigate, usePageRoute } from "@/lib/router";

export function ComposeFormatTabs() {
  const route = usePageRoute();
  const format = route.name === "compose" ? route.format : "note";
  const quote = route.name === "compose" ? route.quote : null;
  const switchTo = (next: "note" | "article") => {
    if (next === format) return;
    const params = new URLSearchParams();
    if (quote) params.set("quote", quote);
    if (next === "article") params.set("format", "article");
    const query = params.toString();
    navigate(query ? `/compose?${query}` : "/compose", true);
  };
  return (
    <Tabs value={format} onValueChange={(value) => switchTo(value as "note" | "article")}>
      <TabsList aria-label="撰写载体" data-testid="compose-format-tabs">
        <TabsTrigger value="note" data-testid="compose-format-note">
          帖子
        </TabsTrigger>
        <TabsTrigger value="article" data-testid="compose-format-article">
          长文
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

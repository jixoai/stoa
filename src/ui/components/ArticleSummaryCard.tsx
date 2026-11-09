/**
 * 长文摘要卡（report-longform D10/§4.3）：feed / 线程 / 搜索 / 收藏 / 通知一律
 * 只渲染摘要——标题（≤2 行）+ 摘要（≤2 行）+「约 N 分钟 · M 个章节」+「阅读全文」，
 * **永不渲染 article 全文**（512KB 正文不进列表 DOM）。
 *
 * 组件全部来自官方 shadcn 收编件（`src/ui/components/ui/*`）：Badge / Button；
 * 组合层只做布局与数据接线（design §4.4「不手写」纪律）。
 */
import { useMemo } from "react";
import type { PostView } from "@core/types";
import { FileTextIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { articleSummary } from "@core/article";

export interface ArticleSummaryCardProps {
  post: Pick<PostView, "body_md">;
  /** 「阅读全文」/ 卡内按钮：由宿主（PostCard）接线到 open。 */
  onOpen?: () => void;
}

export function ArticleSummaryCard({ post, onOpen }: ArticleSummaryCardProps) {
  // 每张卡只解析一次（纯函数；同帖多卡按 body 各自 memo，见 design §4.3）。
  const summary = useMemo(() => articleSummary(post.body_md), [post.body_md]);
  return (
    <div data-testid="article-summary" className="mt-1">
      <div className="flex items-start gap-2">
        <Badge variant="outline" className="mt-0.5 shrink-0 gap-1 text-[11px]" data-testid="article-badge">
          <FileTextIcon className="size-3" aria-hidden />
          长文
        </Badge>
        <p
          className="line-clamp-2 min-w-0 flex-1 text-[0.95rem] font-medium leading-snug text-foreground"
          data-testid="article-summary-title"
        >
          {summary.title}
        </p>
      </div>
      {summary.excerpt ? (
        <p
          className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground"
          data-testid="article-summary-excerpt"
        >
          {summary.excerpt}
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <span data-testid="article-summary-minutes">约 {summary.minutes} 分钟</span>
        {summary.headings > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span>{summary.headings} 个章节</span>
          </>
        ) : null}
        {onOpen ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            data-testid="article-open-full"
            className="ml-auto h-auto p-0 text-sm text-link"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            阅读全文
          </Button>
        ) : null}
      </div>
    </div>
  );
}

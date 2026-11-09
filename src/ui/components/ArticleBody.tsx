/**
 * 长文正文渲染件（report-longform §4.2/§4.4）：
 * - 复用 `parseArticle` 已得到的 `ArticleNode[]`（Markdown 段走共享 `MarkdownBlocks`，
 *   不二次 `parseMarkdown`）；
 * - 指令块 → P1 四块渲染件（`ArticleBlocks`）；未知块/坏 JSON/schema 错 → 安全降级
 *   占位（块名 + 行号 + 原文转义，`data-article-block="unknown"`），永不白屏；
 * - 首个 H1（页面标题）在正文中跳过（唯一 `<h1>` 由 ArticlePage 提供）；
 *   其余 H1 由 article variant 降级为 h2 视觉。
 */
import { useMemo } from "react";
import type { ArticleBlockData, ArticleDoc, ArticleNode } from "@core/article";
import { ARTICLE_BLOCK_NAMES, articleHeadingIdList, titleNodeIndex } from "@core/article";
import type { Block } from "@core/markdown";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { MarkdownBlocks } from "@/components/Markdown";
import { ARTICLE_BLOCK_RENDERERS } from "@/components/ArticleBlocks";

type DirectiveNode = Extract<ArticleNode, { kind: "directive" }>;

interface MarkdownRun {
  kind: "markdown";
  key: string;
  blocks: Block[];
  /** 本段在文档 heading 序列中的起始下标（含被跳过的标题 H1）。 */
  headingOffset: number;
}

interface DirectiveRun {
  kind: "directive";
  key: string;
  node: DirectiveNode;
}

type Run = MarkdownRun | DirectiveRun;

/** 连续 Markdown 节点合成一段（指令块断开）；标题 H1 被跳过但计数照常推进。 */
function buildRuns(nodes: readonly ArticleNode[], skipIndex: number): Run[] {
  const runs: Run[] = [];
  let headingCount = 0;
  let current: MarkdownRun | null = null;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    const offsetHere = headingCount;
    if (node.kind === "markdown" && node.block.type === "heading") headingCount += 1;
    if (index === skipIndex) continue;
    if (node.kind === "directive") {
      runs.push({ kind: "directive", key: `d-${index}`, node });
      current = null;
      continue;
    }
    if (!current) {
      current = { kind: "markdown", key: `m-${index}`, blocks: [], headingOffset: offsetHere };
      runs.push(current);
    }
    current.blocks.push(node.block);
  }
  return runs;
}

/** 降级占位标题（§3.4）：先判未知块名，再看 JSON/schema 错误。 */
function degradedLabel(node: DirectiveNode): string {
  if (!(ARTICLE_BLOCK_NAMES as readonly string[]).includes(node.name)) return "不支持的区块";
  const messages = node.issues.map((issue) => issue.message).join("\n");
  if (/not valid JSON|single JSON object/i.test(messages)) return "区块内容不是合法 JSON";
  return "区块内容不符合规范";
}

function DirectiveNodeView({ node }: { node: DirectiveNode }) {
  const warnings = node.issues.filter((issue) => issue.severity === "warning");
  if (!node.data) {
    return (
      <div
        className="my-4"
        data-article-block="unknown"
        data-testid="article-block-degraded"
        data-block-name={node.name}
        data-block-line={node.line}
      >
        <Card className="gap-2 border-dashed py-3">
          <CardContent className="px-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-status-interrupted">
                {degradedLabel(node)}
              </Badge>
              <code className="font-mono text-xs text-muted-foreground">fde2e:{node.name}</code>
              <span className="text-xs text-muted-foreground">第 {node.line} 行</span>
            </div>
            {node.issues[0] ? (
              <p className="mt-1.5 text-xs text-muted-foreground" data-testid="article-block-issue">
                {node.issues[0].message}
              </p>
            ) : null}
            {node.raw ? (
              <pre
                className="mt-2 max-h-60 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed"
                data-testid="article-block-raw"
              >
                <code>{node.raw}</code>
              </pre>
            ) : null}
          </CardContent>
        </Card>
      </div>
    );
  }
  const data: ArticleBlockData = node.data;
  return (
    <div data-article-block-name={node.name}>
      {data.name === "stats" ? ARTICLE_BLOCK_RENDERERS.stats(data) : null}
      {data.name === "steps" ? ARTICLE_BLOCK_RENDERERS.steps(data) : null}
      {data.name === "compare" ? ARTICLE_BLOCK_RENDERERS.compare(data) : null}
      {data.name === "callout" ? ARTICLE_BLOCK_RENDERERS.callout(data) : null}
      {warnings.length > 0 ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="article-block-warning"
          data-warning-count={warnings.length}
        >
          提示：{warnings[0]!.message}
          {warnings.length > 1 ? `（共 ${warnings.length} 条）` : ""}
        </p>
      ) : null}
    </div>
  );
}

export function ArticleBody({ doc, className }: { doc: ArticleDoc; className?: string }) {
  const headingIds = useMemo(() => articleHeadingIdList(doc), [doc]);
  const skipIndex = titleNodeIndex(doc.nodes);
  const runs = useMemo(() => buildRuns(doc.nodes, skipIndex), [doc, skipIndex]);
  return (
    <div className={cn("min-w-0", className)} data-testid="article-body">
      {runs.map((run) =>
        run.kind === "directive" ? (
          <DirectiveNodeView key={run.key} node={run.node} />
        ) : (
          <MarkdownBlocks
            key={run.key}
            blocks={run.blocks}
            variant="article"
            headingIds={headingIds}
            headingOffset={run.headingOffset}
          />
        ),
      )}
    </div>
  );
}

import { useMemo } from "react";
import type { Block, InlineToken } from "@core/markdown";
import { parseInline, parseMarkdown } from "@core/markdown";
import { filterArticleInline } from "@core/article";
import { scanBareUrls } from "@core/link-extract";
import { cn } from "cn";
import { ExternalLinkIcon, ImageOffIcon } from "lucide-react";
import { useConnection } from "@/state/connection";
import { useMediaUrl } from "@/lib/media";
import { isRemoteImageUrl, useArticleMediaRefs, useArticleViewer } from "@/lib/article-media";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

/**
 * 渲染变体（report-longform §4.4）：
 * - `default`：note/feed/线程既有排版，**逐字不变**；
 * - `article`：长文 prose（17/28、H2 24/32、H3 20/28、段距 1em、表格/代码横向滚动）；
 *   正文 H1 一律降级为 h2 视觉（页面唯一 `<h1>` 由 ArticlePage 提供），H2/H3 取
 *   `articleHeadingIdList` 分配的 slug id；行内 link/image 先过 `filterArticleInline`。
 */
export type MarkdownVariant = "default" | "article";

function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const { client } = useConnection();
  const match = /^\/api\/media\/([A-Za-z0-9]+)$/.exec(src);
  const media = useMediaUrl(client, match?.[1] ?? null);
  if (match) {
    if (media.loading) return <Skeleton className="my-2 h-40 w-full rounded-xl" />;
    if (!media.url) {
      return (
        <span className="my-2 flex h-24 items-center justify-center gap-2 rounded-xl bg-muted text-xs text-muted-foreground">
          <ImageOffIcon className="size-4" /> 图片不可用
        </span>
      );
    }
    return <img src={media.url} alt={alt} loading="lazy" className="my-2 max-h-[420px] max-w-full rounded-xl object-cover" />;
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="my-2 max-h-[420px] max-w-full rounded-xl object-cover"
    />
  );
}

/**
 * article 变体的行内图片（report-longform §4.4）：本地媒体包一层官方 Button，
 * 点击打开既有 `ImageViewer`（手势/计数/关闭全部复用；外链图片不接 Button，
 * 保持 `no-referrer` + lazy 直显，失败走占位）。
 */
function ArticleImage({ src, alt }: { src: string; alt: string }) {
  const resolveRef = useArticleMediaRefs();
  const viewer = useArticleViewer();
  const ref = resolveRef(src);
  if (!ref) return <MarkdownImage src={src} alt={alt} />;
  return (
    <Button
      type="button"
      variant="ghost"
      data-testid="article-image"
      aria-label={alt ? `查看图片：${alt}` : "查看图片"}
      className="my-4 block h-auto w-full cursor-zoom-in rounded-xl p-0 hover:bg-transparent"
      onClick={(event) => {
        event.stopPropagation();
        viewer.open([ref]);
      }}
    >
      <MarkdownImage src={src} alt={alt} />
    </Button>
  );
}

/**
 * 正文 @ 提及：只有账号目录里真实存在的 id 才渲染为高亮链接；
 * 未知 @ 保持纯文本（与 core/mentions 的识别口径一致，代码块不参与）。
 * 点击跳到搜索页并以其提及过滤（搜索是 read 的救济通道）。
 */
const MENTION_RE = /(^|[^A-Za-z0-9_@/])@([a-z][a-z0-9_-]{0,31})\b/g;

/**
 * 正文 #tag（report-ux-r2 §4）：词边界 + `[a-z0-9-]{1,24}`，渲染为可点标签；
 * 行内代码 / 代码块不参与；链接文字里用 `linkTags=false` 避免嵌套 <a>。
 */
const HASHTAG_RE = /(^|[^A-Za-z0-9_-])#([A-Za-z0-9-]{1,24})(?![A-Za-z0-9-])/g;

interface TextMatch {
  kind: "mention" | "tag" | "url";
  /** 替换起点（不含前缀分隔符） */
  index: number;
  /** 替换长度（含 @ / #） */
  length: number;
  value: string;
}

function textMatches(
  text: string,
  known: Set<string>,
  linkTags: boolean,
  linkUrls: boolean,
): TextMatch[] {
  const matches: TextMatch[] = [];
  if (known.size > 0) {
    const re = new RegExp(MENTION_RE.source, "g");
    for (let match = re.exec(text); match; match = re.exec(text)) {
      const prefix = match[1] ?? "";
      const id = match[2]!;
      if (!known.has(id)) continue;
      matches.push({
        kind: "mention",
        index: match.index + prefix.length,
        length: id.length + 1,
        value: id,
      });
    }
  }
  if (linkTags) {
    const re = new RegExp(HASHTAG_RE.source, "gi");
    for (let match = re.exec(text); match; match = re.exec(text)) {
      const prefix = match[1] ?? "";
      const raw = match[2]!;
      matches.push({
        kind: "tag",
        index: match.index + prefix.length,
        length: raw.length + 1,
        value: raw,
      });
    }
  }
  if (linkUrls) {
    // 裸 URL 兜底与服务端抽取共用 core/link-extract 的同一份正则/裁剪。
    for (const match of scanBareUrls(text)) {
      matches.push({ kind: "url", index: match.index, length: match.length, value: match.url });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  return matches;
}

function renderText(
  text: string,
  known: Set<string>,
  linkTags: boolean,
  linkUrls: boolean,
): React.ReactNode {
  const matches = textMatches(text, known, linkTags, linkUrls);
  if (matches.length === 0) return <span className="whitespace-pre-wrap">{text}</span>;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    if (match.kind === "mention") {
      nodes.push(
        <a
          key={`${match.index}-${match.value}`}
          href={`#/search?q=${encodeURIComponent(`@${match.value}`)}`}
          data-testid="mention-link"
          className="font-medium text-link underline-offset-2 hover:underline"
        >
          @{match.value}
        </a>,
      );
    } else if (match.kind === "tag") {
      const tag = match.value.toLowerCase();
      nodes.push(
        <a
          key={`${match.index}-${tag}`}
          href={`#/tag/${encodeURIComponent(tag)}`}
          data-testid="hashtag-link"
          data-tag={tag}
          className="rounded-sm bg-muted/70 px-0.5 font-medium text-link underline-offset-2 hover:underline"
        >
          #{match.value}
        </a>,
      );
    } else {
      nodes.push(
        <a
          key={`${match.index}-${match.value}`}
          href={match.value}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="bare-url-link"
          className="text-link underline-offset-2 hover:underline"
        >
          {text.slice(match.index, match.index + match.length)}
        </a>,
      );
    }
    cursor = match.index + match.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <span className="whitespace-pre-wrap">{nodes}</span>;
}

function renderInline(
  tokens: InlineToken[],
  known: Set<string>,
  linkTags: boolean,
  linkUrls: boolean,
  article = false,
): React.ReactNode[] {
  // article：不合格的 link/image 还原为纯文本（§3.4），note 路径不经过本过滤。
  const filtered = article ? filterArticleInline(tokens) : tokens;
  return filtered.map((token, index) => {
    switch (token.type) {
      case "text":
        return <span key={index}>{renderText(token.text, known, linkTags, linkUrls)}</span>;
      case "code":
        return (
          <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
            {token.text}
          </code>
        );
      case "strong":
        return (
          <strong key={index} className="font-semibold">
            {renderInline(token.children, known, linkTags, linkUrls, article)}
          </strong>
        );
      case "em":
        return <em key={index}>{renderInline(token.children, known, linkTags, linkUrls, article)}</em>;
      case "link":
        return (
          <a
            key={index}
            href={token.href}
            target={token.href.startsWith("#") ? undefined : "_blank"}
            rel="noreferrer noopener"
            className="text-link underline-offset-2 hover:underline"
          >
            {renderInline(token.children, known, false, false, article)}
            {token.href.startsWith("#") ? null : (
              <ExternalLinkIcon className="ml-0.5 inline size-3" aria-hidden />
            )}
          </a>
        );
      case "image":
        return article ? (
          isRemoteImageUrl(token.src) ? (
            <MarkdownImage key={index} src={token.src} alt={token.alt} />
          ) : (
            <ArticleImage key={index} src={token.src} alt={token.alt} />
          )
        ) : (
          <MarkdownImage key={index} src={token.src} alt={token.alt} />
        );
    }
  });
}

function renderBlock(
  block: Block,
  index: number,
  known: Set<string>,
  linkTags: boolean,
  variant: MarkdownVariant = "default",
  headingId: string | null = null,
): React.ReactNode {
  const article = variant === "article";
  switch (block.type) {
    case "heading": {
      // article：正文 H1 降级 h2 视觉（页面唯一 h1 由 ArticlePage 提供）；
      // H2/H3 保持层级并挂 slug id；默认 variant 逐字不变。
      const level = article ? Math.max(2, Math.min(block.level, 4)) : Math.min(block.level, 4);
      const className = article
        ? level === 2
          ? "mt-8 mb-3 text-2xl font-semibold leading-[32px] first:mt-0"
          : level === 3
            ? "mt-6 mb-2 text-xl font-semibold leading-[28px]"
            : "mt-5 mb-2 text-base font-semibold"
        : level === 1
          ? "mt-3 mb-1.5 text-xl font-semibold"
          : level === 2
            ? "mt-3 mb-1.5 text-lg font-semibold"
            : "mt-2 mb-1 text-base font-semibold";
      const Tag = (`h${level}` as unknown) as "h1";
      return (
        <Tag key={index} className={className} id={article ? headingId ?? undefined : undefined}>
          {renderInline(block.children, known, linkTags, true, article)}
        </Tag>
      );
    }
    case "paragraph":
      return article ? (
        <p key={index} className="my-4 text-[17px] leading-[28px]">
          {renderInline(block.children, known, linkTags, true, true)}
        </p>
      ) : (
        <p key={index} className="my-1 text-[0.95rem] leading-relaxed">
          {renderInline(block.children, known, linkTags, true)}
        </p>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          key={index}
          className={cn(
            article
              ? "my-4 flex flex-col gap-1.5 pl-6 text-[17px] leading-[28px]"
              : "my-1.5 flex flex-col gap-1 pl-5 text-[0.95rem] leading-relaxed",
            block.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, known, linkTags, true, article)}</li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return article ? (
        <blockquote
          key={index}
          className="my-4 border-l-2 border-border pl-4 text-[17px] leading-[28px] text-muted-foreground"
        >
          {renderInline(block.children, known, linkTags, true, true)}
        </blockquote>
      ) : (
        <blockquote key={index} className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
          {renderInline(block.children, known, linkTags, true)}
        </blockquote>
      );
    case "code":
      return article ? (
        <pre
          key={index}
          className="my-4 overflow-x-auto rounded-xl bg-muted px-4 py-3 font-mono text-sm leading-relaxed"
          data-lang={block.lang || undefined}
        >
          <code>{block.text}</code>
        </pre>
      ) : (
        <pre
          key={index}
          className="my-2 overflow-x-auto rounded-xl bg-muted px-3 py-2 font-mono text-xs leading-relaxed"
        >
          <code>{block.text}</code>
        </pre>
      );
    case "table":
      return (
        <div key={index} className={article ? "my-4 overflow-x-auto" : "my-2 overflow-x-auto"}>
          <table className={cn("w-full border-collapse", article ? "text-[15px] leading-[24px]" : "text-sm")}>
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th key={cellIndex} className="border border-border px-2 py-1 text-left font-medium">
                    {renderInline(cell, known, linkTags, true, article)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="border border-border px-2 py-1 align-top">
                      {renderInline(cell, known, linkTags, true, article)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={index} className={article ? "my-6 border-border" : "my-3 border-border"} />;
  }
}

/** 已解析 block 列表的渲染件（ArticleBody 复用 `parseArticle` 的同一份 Block[]）。 */
export function MarkdownBlocks({
  blocks,
  className,
  linkTags = true,
  variant = "default",
  headingIds,
  headingOffset = 0,
}: {
  blocks: Block[];
  className?: string;
  linkTags?: boolean;
  variant?: MarkdownVariant;
  /** 全文档 heading slug 序列（`articleHeadingIdList`）；仅 article 消费。 */
  headingIds?: (string | null)[];
  /** 本段在文档 heading 序列中的起始下标（ArticleBody 逐节点渲染时推进）。 */
  headingOffset?: number;
}) {
  const { accounts } = useConnection();
  const known = useMemo(
    () => new Set(accounts.filter((account) => account.disabled !== 2).map((account) => account.id)),
    [accounts],
  );
  if (blocks.length === 0) return null;
  const article = variant === "article";
  let headingIndex = headingOffset - 1;
  return (
    <div className={cn("break-words", className)}>
      {blocks.map((block, index) => {
        if (block.type === "heading") headingIndex += 1;
        const headingId =
          article && block.type === "heading" ? headingIds?.[headingIndex] ?? null : null;
        return renderBlock(block, index, known, linkTags, variant, headingId);
      })}
    </div>
  );
}

/** markdown 子集渲染（core/markdown.ts 解析；React 元素输出，不拼 innerHTML）。 */
export function Markdown({
  source,
  className,
  linkTags = true,
  variant = "default",
  headingIds,
  blocks: providedBlocks,
}: {
  source: string;
  className?: string;
  linkTags?: boolean;
  variant?: MarkdownVariant;
  headingIds?: (string | null)[];
  /** 已解析的 block 列表（长文避免二次 parseMarkdown，design §4.4）。 */
  blocks?: Block[];
}) {
  const blocks = providedBlocks ?? parseMarkdown(source);
  return (
    <MarkdownBlocks
      blocks={blocks}
      className={className}
      linkTags={linkTags}
      variant={variant}
      headingIds={headingIds}
    />
  );
}

/**
 * 指令块内的行内 Markdown（report-longform §3.2/§3.4）：`parseInline` 后过
 * `filterArticleInline`（链接仅 http(s) 与页内锚点、图片仅 http(s) 与本地媒体），
 * 逐 token 渲染为 React 元素——`steps.expect/detail`、`callout.body/items` 用它，
 * **不解析块级 Markdown**（无标题/列表/表格语义）。
 */
export function ArticleInline({ source, className }: { source: string; className?: string }) {
  const { accounts } = useConnection();
  const known = useMemo(
    () => new Set(accounts.filter((account) => account.disabled !== 2).map((account) => account.id)),
    [accounts],
  );
  const tokens = useMemo(() => parseInline(source), [source]);
  return (
    <span className={cn("min-w-0 break-words", className)} data-testid="article-inline">
      {renderInline(tokens, known, true, true, true)}
    </span>
  );
}

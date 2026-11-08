import { useMemo } from "react";
import type { Block, InlineToken } from "@core/markdown";
import { parseMarkdown } from "@core/markdown";
import { scanBareUrls } from "@core/link-extract";
import { cn } from "cn";
import { ExternalLinkIcon, ImageOffIcon } from "lucide-react";
import { useConnection } from "@/state/connection";
import { useMediaUrl } from "@/lib/media";
import { Skeleton } from "@/components/ui/skeleton";

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
): React.ReactNode[] {
  return tokens.map((token, index) => {
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
            {renderInline(token.children, known, linkTags, linkUrls)}
          </strong>
        );
      case "em":
        return <em key={index}>{renderInline(token.children, known, linkTags, linkUrls)}</em>;
      case "link":
        return (
          <a
            key={index}
            href={token.href}
            target={token.href.startsWith("#") ? undefined : "_blank"}
            rel="noreferrer noopener"
            className="text-link underline-offset-2 hover:underline"
          >
            {renderInline(token.children, known, false, false)}
            {token.href.startsWith("#") ? null : (
              <ExternalLinkIcon className="ml-0.5 inline size-3" aria-hidden />
            )}
          </a>
        );
      case "image":
        return <MarkdownImage key={index} src={token.src} alt={token.alt} />;
    }
  });
}

function renderBlock(
  block: Block,
  index: number,
  known: Set<string>,
  linkTags: boolean,
): React.ReactNode {
  switch (block.type) {
    case "heading": {
      const level = Math.min(block.level, 4);
      const className =
        level === 1
          ? "mt-3 mb-1.5 text-xl font-semibold"
          : level === 2
            ? "mt-3 mb-1.5 text-lg font-semibold"
            : "mt-2 mb-1 text-base font-semibold";
      const Tag = (`h${level}` as unknown) as "h1";
      return (
        <Tag key={index} className={className}>
          {renderInline(block.children, known, linkTags, true)}
        </Tag>
      );
    }
    case "paragraph":
      return (
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
            "my-1.5 flex flex-col gap-1 pl-5 text-[0.95rem] leading-relaxed",
            block.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, known, linkTags, true)}</li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote key={index} className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
          {renderInline(block.children, known, linkTags, true)}
        </blockquote>
      );
    case "code":
      return (
        <pre
          key={index}
          className="my-2 overflow-x-auto rounded-xl bg-muted px-3 py-2 font-mono text-xs leading-relaxed"
        >
          <code>{block.text}</code>
        </pre>
      );
    case "table":
      return (
        <div key={index} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th key={cellIndex} className="border border-border px-2 py-1 text-left font-medium">
                    {renderInline(cell, known, linkTags, true)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="border border-border px-2 py-1 align-top">
                      {renderInline(cell, known, linkTags, true)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={index} className="my-3 border-border" />;
  }
}

/** markdown 子集渲染（core/markdown.ts 解析；React 元素输出，不拼 innerHTML）。 */
export function Markdown({
  source,
  className,
  linkTags = true,
}: {
  source: string;
  className?: string;
  linkTags?: boolean;
}) {
  const { accounts } = useConnection();
  const known = useMemo(
    () => new Set(accounts.filter((account) => account.disabled !== 2).map((account) => account.id)),
    [accounts],
  );
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return null;
  return <div className={cn("break-words", className)}>{blocks.map((block, index) => renderBlock(block, index, known, linkTags))}</div>;
}

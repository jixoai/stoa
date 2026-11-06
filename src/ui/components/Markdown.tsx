import { useMemo } from "react";
import type { Block, InlineToken } from "@core/markdown";
import { parseMarkdown } from "@core/markdown";
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

function renderText(text: string, known: Set<string>): React.ReactNode {
  if (known.size === 0) return <span className="whitespace-pre-wrap">{text}</span>;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  const re = new RegExp(MENTION_RE.source, "g");
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const prefix = match[1] ?? "";
    const id = match[2]!;
    if (!known.has(id)) continue;
    const start = match.index + prefix.length;
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(
      <a
        key={`${start}-${id}`}
        href={`#/search?q=${encodeURIComponent(`@${id}`)}`}
        data-testid="mention-link"
        className="font-medium text-link underline-offset-2 hover:underline"
      >
        @{id}
      </a>,
    );
    last = match.index + match[0].length;
  }
  if (nodes.length === 0) return <span className="whitespace-pre-wrap">{text}</span>;
  if (last < text.length) nodes.push(text.slice(last));
  return <span className="whitespace-pre-wrap">{nodes}</span>;
}

function renderInline(tokens: InlineToken[], known: Set<string>): React.ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.type) {
      case "text":
        return <span key={index}>{renderText(token.text, known)}</span>;
      case "code":
        return (
          <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
            {token.text}
          </code>
        );
      case "strong":
        return (
          <strong key={index} className="font-semibold">
            {renderInline(token.children, known)}
          </strong>
        );
      case "em":
        return <em key={index}>{renderInline(token.children, known)}</em>;
      case "link":
        return (
          <a
            key={index}
            href={token.href}
            target={token.href.startsWith("#") ? undefined : "_blank"}
            rel="noreferrer noopener"
            className="text-link underline-offset-2 hover:underline"
          >
            {renderInline(token.children, known)}
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

function renderBlock(block: Block, index: number, known: Set<string>): React.ReactNode {
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
          {renderInline(block.children, known)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={index} className="my-1 text-[0.95rem] leading-relaxed">
          {renderInline(block.children, known)}
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
            <li key={itemIndex}>{renderInline(item, known)}</li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote key={index} className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
          {renderInline(block.children, known)}
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
                    {renderInline(cell, known)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="border border-border px-2 py-1 align-top">
                      {renderInline(cell, known)}
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
export function Markdown({ source, className }: { source: string; className?: string }) {
  const { accounts } = useConnection();
  const known = useMemo(
    () => new Set(accounts.filter((account) => account.disabled !== 2).map((account) => account.id)),
    [accounts],
  );
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return null;
  return <div className={cn("break-words", className)}>{blocks.map((block, index) => renderBlock(block, index, known))}</div>;
}

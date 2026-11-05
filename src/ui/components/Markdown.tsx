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

function renderInline(tokens: InlineToken[]): React.ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.type) {
      case "text":
        return (
          <span key={index} className="whitespace-pre-wrap">
            {token.text}
          </span>
        );
      case "code":
        return (
          <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
            {token.text}
          </code>
        );
      case "strong":
        return (
          <strong key={index} className="font-semibold">
            {renderInline(token.children)}
          </strong>
        );
      case "em":
        return <em key={index}>{renderInline(token.children)}</em>;
      case "link":
        return (
          <a
            key={index}
            href={token.href}
            target={token.href.startsWith("#") ? undefined : "_blank"}
            rel="noreferrer noopener"
            className="text-link underline-offset-2 hover:underline"
          >
            {renderInline(token.children)}
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

function renderBlock(block: Block, index: number): React.ReactNode {
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
          {renderInline(block.children)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={index} className="my-1 text-[0.95rem] leading-relaxed">
          {renderInline(block.children)}
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
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote key={index} className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
          {renderInline(block.children)}
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
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="border border-border px-2 py-1 align-top">
                      {renderInline(cell)}
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
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return null;
  return <div className={cn("break-words", className)}>{blocks.map(renderBlock)}</div>;
}

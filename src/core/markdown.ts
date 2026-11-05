/**
 * Markdown subset (design §12.7): headings, lists, tables, blockquotes, fenced
 * code, inline code, links, images, bold/italic. The server stores raw markdown;
 * this module is used by tests and the SSG exporter (and can be reused by the UI).
 */

export type InlineToken =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: InlineToken[] }
  | { type: "em"; children: InlineToken[] }
  | { type: "link"; href: string; children: InlineToken[] }
  | { type: "image"; src: string; alt: string };

export type Block =
  | { type: "heading"; level: number; children: InlineToken[] }
  | { type: "paragraph"; children: InlineToken[] }
  | { type: "list"; ordered: boolean; items: InlineToken[][] }
  | { type: "quote"; children: InlineToken[] }
  | { type: "code"; lang: string; text: string }
  | { type: "table"; header: InlineToken[][]; rows: InlineToken[][][] }
  | { type: "hr" };

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeHref(href: string): boolean {
  return /^(https?:|mailto:|\/|#|\.\/|\.\.\/)/i.test(href);
}

export function parseInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  let buffer = "";
  const flush = () => {
    if (buffer) {
      tokens.push({ type: "text", text: buffer });
      buffer = "";
    }
  };
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "`") {
      const end = input.indexOf("`", i + 1);
      if (end > i) {
        flush();
        tokens.push({ type: "code", text: input.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "!" && input[i + 1] === "[") {
      const close = input.indexOf("](", i + 2);
      if (close > 0) {
        const endParen = input.indexOf(")", close + 2);
        if (endParen > 0) {
          flush();
          const alt = input.slice(i + 2, close);
          const src = input.slice(close + 2, endParen);
          if (isSafeHref(src)) tokens.push({ type: "image", src, alt });
          else buffer += input.slice(i, endParen + 1);
          i = endParen + 1;
          continue;
        }
      }
    }
    if (ch === "[") {
      const close = input.indexOf("](", i + 1);
      if (close > 0) {
        const endParen = input.indexOf(")", close + 2);
        if (endParen > 0) {
          flush();
          const label = input.slice(i + 1, close);
          const href = input.slice(close + 2, endParen);
          if (isSafeHref(href)) {
            tokens.push({ type: "link", href, children: parseInline(label) });
          } else {
            buffer += input.slice(i, endParen + 1);
          }
          i = endParen + 1;
          continue;
        }
      }
    }
    if (input.startsWith("**", i)) {
      const end = input.indexOf("**", i + 2);
      if (end > i) {
        flush();
        tokens.push({ type: "strong", children: parseInline(input.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const end = input.indexOf(ch, i + 1);
      if (end > i + 1) {
        flush();
        tokens.push({ type: "em", children: parseInline(input.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return tokens;
}

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      flushParagraph();
      const lang = fence[1]!.trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        children: parseInline(heading[2]!),
      });
      i += 1;
      continue;
    }
    if (/^(\*\s*\*\s*\*|-\s*-\s*-|___+)\s*$/.test(line.trim())) {
      flushParagraph();
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith(">")) {
        quote.push(lines[i]!.trimStart().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", children: parseInline(quote.join("\n")) });
      continue;
    }
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1]!)
    ) {
      flushParagraph();
      const header = splitRow(line).map((cell) => parseInline(cell));
      i += 2;
      const rows: InlineToken[][][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitRow(lines[i]!).map((cell) => parseInline(cell)));
        i += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const items: InlineToken[][] = [];
      while (i < lines.length) {
        const m = isOrdered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]!)
          : /^\s*[-*+]\s+(.*)$/.exec(lines[i]!);
        if (!m) break;
        items.push(parseInline(m[1]!));
        i += 1;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  return blocks;
}

function renderInline(tokens: InlineToken[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "text":
          return escapeHtml(token.text);
        case "code":
          return `<code>${escapeHtml(token.text)}</code>`;
        case "strong":
          return `<strong>${renderInline(token.children)}</strong>`;
        case "em":
          return `<em>${renderInline(token.children)}</em>`;
        case "link":
          return `<a href="${escapeHtml(token.href)}" rel="noreferrer noopener">${renderInline(
            token.children,
          )}</a>`;
        case "image":
          return `<img src="${escapeHtml(token.src)}" alt="${escapeHtml(token.alt)}" loading="lazy">`;
      }
    })
    .join("");
}

export function renderMarkdownHtml(markdown: string): string {
  return parseMarkdown(markdown)
    .map((block) => {
      switch (block.type) {
        case "heading":
          return `<h${block.level}>${renderInline(block.children)}</h${block.level}>`;
        case "paragraph":
          return `<p>${renderInline(block.children)}</p>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          const items = block.items.map((item) => `<li>${renderInline(item)}</li>`).join("");
          return `<${tag}>${items}</${tag}>`;
        }
        case "quote":
          return `<blockquote>${renderInline(block.children)}</blockquote>`;
        case "code":
          return `<pre><code${
            block.lang ? ` data-lang="${escapeHtml(block.lang)}"` : ""
          }>${escapeHtml(block.text)}</code></pre>`;
        case "table": {
          const head = `<tr>${block.header
            .map((cell) => `<th>${renderInline(cell)}</th>`)
            .join("")}</tr>`;
          const rows = block.rows
            .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
            .join("");
          return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
        }
        case "hr":
          return "<hr>";
      }
    })
    .join("\n");
}

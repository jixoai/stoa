/**
 * 有界 HTML 元数据扫描（design §6.4 / §6.5 / P1-10）。
 *
 * 手写正则扫描器（零第三方依赖）：OG → Twitter Card → `<title>`/meta description →
 * `article/main` 首段（≥40 字，≤400 字）→ favicon。不执行 JS/CSS、不请求子资源、
 * 不保存 HTML 原文；文本实体解码后按字符截断。
 */
import type { PreviewCover } from "../../core/plugins/types.ts";

export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 400;
export const MAX_SITE_NAME_CHARS = 100;
export const MAX_COVER_URL_CHARS = 2048;

export interface ParsedHtmlMeta {
  title: string | null;
  description: string | null;
  site_name: string | null;
  cover: PreviewCover | null;
  /** favicon 绝对 URL（仅在没有 og/twitter 图时作为小图标 cover 的候选）。 */
  favicon: string | null;
  canonical: string | null;
}

export function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  middot: "·",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    let code: number | null = null;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      code = Number.parseInt(body.slice(2), 16);
    } else if (body.startsWith("#")) {
      code = Number.parseInt(body.slice(1), 10);
    }
    if (code !== null) {
      // N1：越界/代理区码点不得抛 RangeError（否则整站预览永久 failed）。
      if (
        !Number.isFinite(code) ||
        code < 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return "\uFFFD";
      }
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

function cleanText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // 先去真实标签，再解实体（实体解出的 `<` 是正文，不是标签）。
  const text = decodeEntities(raw.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return text ? text : null;
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = re.exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function metaTags(html: string): Array<{ key: string; content: string }> {
  const out: Array<{ key: string; content: string }> = [];
  const re = /<meta\b[^>]*>/gi;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    const tag = match[0]!;
    const key = attr(tag, "property") ?? attr(tag, "name") ?? attr(tag, "itemprop");
    const content = attr(tag, "content");
    if (!key || content === null) continue;
    out.push({ key: key.toLowerCase(), content });
  }
  return out;
}

function first(meta: Array<{ key: string; content: string }>, keys: string[]): string | null {
  for (const key of keys) {
    const found = meta.find((entry) => entry.key === key);
    if (found && cleanText(found.content)) return found.content;
  }
  return null;
}

function parseDimension(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function resolveUrl(base: URL, raw: string): string | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    const out = url.toString();
    return out.length <= MAX_COVER_URL_CHARS ? out : null;
  } catch {
    return null;
  }
}

function isSvgCover(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.startsWith("data:")) return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".svg");
  } catch {
    return lower.split("?")[0]!.endsWith(".svg");
  }
}

function baseUrl(html: string, finalUrl: string): URL {
  const base = new URL(finalUrl);
  const match = /<base\b[^>]*>/i.exec(html);
  const href = match ? attr(match[0], "href") : null;
  if (href) {
    try {
      return new URL(href, base);
    } catch {
      return base;
    }
  }
  return base;
}

function titleTag(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? cleanText(match[1]) : null;
}

/** 首段候选扫描上限：只在前 64KiB 找 `<p>`，避免全文非贪婪回溯（B1）。 */
export const FIRST_PARAGRAPH_SCAN_CHARS = 64 * 1024;
const MAX_PARAGRAPH_CANDIDATES = 64;
const PARAGRAPH_SCAN_BUDGET_MS = 20;

/** 线性移除某个元素（script/style/nav/header/footer），不做跨全文惰性匹配。 */
function stripElementLinear(html: string, tag: string): string {
  const lower = html.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let out = "";
  let cursor = 0;
  for (;;) {
    const start = lower.indexOf(open, cursor);
    if (start < 0) {
      out += html.slice(cursor);
      return out;
    }
    out += html.slice(cursor, start);
    const end = lower.indexOf(close, start);
    if (end < 0) return out;
    cursor = end + close.length;
  }
}

function paragraphScope(html: string): string {
  const scan =
    html.length > FIRST_PARAGRAPH_SCAN_CHARS
      ? html.slice(0, FIRST_PARAGRAPH_SCAN_CHARS)
      : html;
  const lower = scan.toLowerCase();
  for (const tag of ["article", "main"]) {
    const open = lower.indexOf(`<${tag}`);
    if (open < 0) continue;
    const close = lower.indexOf(`</${tag}>`, open);
    if (close < 0) continue;
    return scan.slice(open, close);
  }
  return scan;
}

function firstParagraph(html: string): string | null {
  let scoped = paragraphScope(html);
  for (const tag of ["script", "style", "nav", "header", "footer"]) {
    scoped = stripElementLinear(scoped, tag);
  }
  const lower = scoped.toLowerCase();
  let cursor = 0;
  let candidates = 0;
  const deadline = performance.now() + PARAGRAPH_SCAN_BUDGET_MS;
  while (candidates < MAX_PARAGRAPH_CANDIDATES) {
    if ((candidates & 7) === 0 && performance.now() > deadline) return null;
    const open = lower.indexOf("<p", cursor);
    if (open < 0) return null;
    const after = lower[open + 2];
    if (after !== undefined && !/[\s>]/.test(after)) {
      cursor = open + 2;
      continue;
    }
    const openEnd = lower.indexOf(">", open + 2);
    if (openEnd < 0) return null;
    const close = lower.indexOf("</p>", openEnd + 1);
    if (close < 0) return null;
    const text = cleanText(scoped.slice(openEnd + 1, close));
    if (text && text.length >= 40) return truncateChars(text, MAX_DESCRIPTION_CHARS);
    cursor = close + 4;
    candidates += 1;
  }
  return null;
}

function faviconUrl(html: string, base: URL): string | null {
  const re = /<link\b[^>]*>/gi;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    const tag = match[0]!;
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    if (!rel.split(/\s+/).includes("icon")) continue;
    const href = attr(tag, "href");
    const resolved = href ? resolveUrl(base, href) : null;
    if (resolved && !isSvgCover(resolved)) return resolved;
  }
  return null;
}

function canonicalUrl(html: string, base: URL): string | null {
  const re = /<link\b[^>]*>/gi;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    const tag = match[0]!;
    if ((attr(tag, "rel") ?? "").toLowerCase() !== "canonical") continue;
    const href = attr(tag, "href");
    if (href) return resolveUrl(base, href);
  }
  return null;
}

/**
 * 解析 HTML 元数据。`finalUrl` 是重定向后的页面地址（相对 URL 基准）。
 */
export function parseHtmlMeta(html: string, finalUrl: string): ParsedHtmlMeta {
  const base = baseUrl(html, finalUrl);
  const meta = metaTags(html);

  const ogTitle = cleanText(first(meta, ["og:title"]));
  const twitterTitle = cleanText(first(meta, ["twitter:title"]));
  const documentTitle = titleTag(html);
  const title = truncateChars(ogTitle ?? twitterTitle ?? documentTitle ?? "", MAX_TITLE_CHARS) || null;

  const description = truncateChars(
    cleanText(first(meta, ["og:description"])) ??
      cleanText(first(meta, ["twitter:description"])) ??
      cleanText(first(meta, ["description"])) ??
      firstParagraph(html) ??
      "",
    MAX_DESCRIPTION_CHARS,
  ) || null;

  const siteName =
    truncateChars(
      cleanText(first(meta, ["og:site_name"])) ??
        cleanText(first(meta, ["twitter:site"])) ??
        "",
      MAX_SITE_NAME_CHARS,
    ) || null;

  const imageRaw =
    first(meta, ["og:image", "og:image:url", "og:image:secure_url"]) ??
    first(meta, ["twitter:image", "twitter:image:src"]);
  let cover: PreviewCover | null = null;
  if (imageRaw) {
    const url = resolveUrl(base, imageRaw.trim());
    if (url && !isSvgCover(url)) {
      cover = {
        url,
        w: parseDimension(first(meta, ["og:image:width", "twitter:image:width"])),
        h: parseDimension(first(meta, ["og:image:height", "twitter:image:height"])),
        kind: "og",
      };
    }
  }

  const favicon = faviconUrl(html, base);
  if (!cover && favicon) {
    cover = { url: favicon, w: null, h: null, kind: "favicon" };
  }

  return {
    title,
    description,
    site_name: siteName,
    cover,
    favicon,
    canonical: canonicalUrl(html, base),
  };
}

/** 从 Content-Type 或 `<meta charset>` 推字符集；非法序列替换，按字符截断。 */
export function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  let charset: string | null = null;
  if (contentType) {
    const match = /charset\s*=\s*"?([a-zA-Z0-9_-]+)/i.exec(contentType);
    if (match) charset = match[1]!;
  }
  if (!charset) {
    const head = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.slice(0, 2048))
      .toLowerCase();
    const meta = /<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i.exec(head);
    if (meta) charset = meta[1]!;
  }
  const label = charset?.toLowerCase() ?? "utf-8";
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

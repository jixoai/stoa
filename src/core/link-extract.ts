/**
 * 正文 → 可预览链接（design §4 / P1-3）。
 *
 * 纯本地纯函数：复用 `core/markdown.ts` 的语法树，跳过 fenced code block、行内
 * code 与图片；接受 markdown link href 与纯文本裸 URL。服务端写入事务与客户端
 * 裸 URL 兜底（Markdown.tsx）共用本模块的正则与规范化（禁止第二份正则）。
 */
import { parseMarkdown, type Block, type InlineToken } from "./markdown.ts";
import type { ExtractedLink } from "./plugins/types.ts";

/** 抽取/规范化规则版本；任何规则变更必须 bump（缓存失效依赖它）。 */
export const EXTRACT_VERSION = 2; // N3：裸 URL 增加 CJK/全角边界（cacheKey 失效）

export const MAX_LINKS_PER_POST = 3;
export const MAX_URL_CHARS = 2048;
export const MAX_LABEL_CHARS = 200;

const TRACKING_EXACT = new Set(["fbclid", "gclid", "yclid", "mc_cid", "mc_eid", "igshid"]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_EXACT.has(lower);
}

/**
 * 裸 URL（仅 http/https）：遇到空白、引号、CJK 文字（Han/Hiragana/Katakana/
 * Hangul）或全角字符即截断——中文正文里 URL 后常不空格（N3：不得把「获取详情」
 * 并进 URL）。尾标点裁剪仍由 `scanBareUrls` 处理。
 */
const BARE_URL_RE =
  /https?:\/\/[^\s<>"'`，。；：！？、（）【】《》「」『』“”‘’\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]+/giu;

function countChar(text: string, char: string): number {
  let count = 0;
  for (const ch of text) if (ch === char) count += 1;
  return count;
}

function trimTrailingPunctuation(raw: string): string {
  let out = raw;
  for (;;) {
    const last = out[out.length - 1];
    if (!last) return out;
    if (/[.,;:!?，。；：！？、'"”’]/.test(last)) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === ")" && countChar(out, "(") < countChar(out, ")")) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === "]" && countChar(out, "[") < countChar(out, "]")) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === "}" && countChar(out, "{") < countChar(out, "}")) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

export interface BareUrlMatch {
  /** 原文起点（含）。 */
  index: number;
  /** 裁剪后的 URL 长度。 */
  length: number;
  url: string;
}

/**
 * 扫出文本里的裸 http/https URL（尾标点/不成对括号裁剪）。
 * 客户端裸 URL 兜底与服务端抽取共用；`Markdown.tsx` SHALL 直接调用本函数。
 */
export function scanBareUrls(text: string): BareUrlMatch[] {
  const out: BareUrlMatch[] = [];
  const re = new RegExp(BARE_URL_RE.source, "giu");
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const url = trimTrailingPunctuation(match[0]!);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    out.push({ index: match.index, length: url.length, url });
  }
  return out;
}

/**
 * URL 规范化（spec「URL 规范化与上限」）：scheme/host 小写、去 fragment、
 * 去默认端口、去 utm_ 前缀参数与 fbclid/gclid/yclid/mc_cid/mc_eid/igshid，保留其余 query
 * 原序；超过 2048 字符返回 null（丢弃而不是截断）。
 */
export function canonicalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return null;
  url.protocol = protocol;
  url.hash = "";
  if (
    (protocol === "http:" && url.port === "80") ||
    (protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }
  const kept: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams.entries()) {
    if (!isTrackingParam(name)) kept.push([name, value]);
  }
  url.search = kept.length > 0
    ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`
    : "";
  const canonical = url.toString();
  if (canonical.length > MAX_URL_CHARS) return null;
  return canonical;
}

function truncateLabel(label: string): string | null {
  const trimmed = label.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_LABEL_CHARS);
}

function inlineText(tokens: InlineToken[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "code":
        out += token.text;
        break;
      case "strong":
      case "em":
        out += inlineText(token.children);
        break;
      case "link":
        out += inlineText(token.children);
        break;
      case "image":
        break;
    }
  }
  return out;
}

interface Candidate {
  url: string;
  label: string | null;
}

function collectInline(tokens: InlineToken[], out: Candidate[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        for (const match of scanBareUrls(token.text)) out.push({ url: match.url, label: null });
        break;
      }
      case "link": {
        // 链接文字里的 URL 文本不作为独立候选（外层 href 才是可点击目标）。
        out.push({ url: token.href, label: truncateLabel(inlineText(token.children)) });
        break;
      }
      case "strong":
      case "em":
        collectInline(token.children, out);
        break;
      case "code":
      case "image":
        // 行内 code / 图片：跳过（spec「链接抽取范围」）。
        break;
    }
  }
}

function collectBlock(block: Block, out: Candidate[]): void {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "quote":
      collectInline(block.children, out);
      break;
    case "list":
      for (const item of block.items) collectInline(item, out);
      break;
    case "table":
      for (const cell of block.header) collectInline(cell, out);
      for (const row of block.rows) for (const cell of row) collectInline(cell, out);
      break;
    case "code":
    case "hr":
      break;
  }
}

/**
 * 抽取正文中的可预览链接：规范化 → 去重（规范化后完全相同只留第一条）→ 上限 3。
 * 纯本地，无网络；调用方负责 catch 病理输入（失败不得阻断发帖）。
 */
export function extractLinks(bodyMd: string): ExtractedLink[] {
  const candidates: Candidate[] = [];
  // B4：不做正文截断（截断会伪造出正文不存在的 URL / 丢失尾部链接）。
  // 病态输入的线性预算由 markdown.ts 的 `](` / `)` 位置缓存保证。
  for (const block of parseMarkdown(bodyMd)) collectBlock(block, candidates);
  const seen = new Set<string>();
  const out: ExtractedLink[] = [];
  for (const candidate of candidates) {
    const canonical = canonicalizeUrl(candidate.url);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({
      url: canonical,
      position: out.length,
      label: candidate.label,
    });
    if (out.length >= MAX_LINKS_PER_POST) break;
  }
  return out;
}

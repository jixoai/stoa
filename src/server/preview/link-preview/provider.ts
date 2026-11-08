/**
 * `link-preview` provider（design §2.2 / §6 / P1 阶段实现）。
 *
 * P1 phases：页面 = meta → cover；图片/视频/音频/文档 = probe。crop/title 阶段
 * 已在类型/状态机中预留（P2 实现），不在 P1 返回。
 */
import { createHash } from "node:crypto";
import type {
  ExtractedLink,
  PhaseResult,
  PreviewFetchResponse,
  PreviewKind,
  PreviewPhase,
  PreviewProvider,
  ResolveContext,
} from "../../../core/plugins/types.ts";
import { LINK_PREVIEW } from "../../../core/plugins/builtin.ts";
import { EXTRACT_VERSION, extractLinks, MAX_LINKS_PER_POST, MAX_URL_CHARS } from "../../../core/link-extract.ts";
import { decodeHtml, parseHtmlMeta, truncateChars, type ParsedHtmlMeta } from "../html.ts";

const PAGE_LIKE_IMAGE = /\.(png|jpe?g|gif|webp|avif)(?:$|[?#])/i;
const PAGE_LIKE_VIDEO = /\.(mp4|webm|mov|ogv)(?:$|[?#])/i;
const PAGE_LIKE_AUDIO = /\.(mp3|wav|flac|m4a|ogg|oga)(?:$|[?#])/i;
const PAGE_LIKE_DOCUMENT = /\.(pdf|zip|docx?|xlsx?|pptx?|txt|md|json|csv|log)(?:$|[?#])/i;

/**
 * `rules_version` 的实际取值：manifest 规则版本 × 1000 + 抽取规则版本。
 * 任何抽取/抓取/元数据规则变化都会 bump（spec P1-3），cacheKey 随之失效。
 */
export function previewRulesVersion(env: Record<string, string | undefined> = process.env): number {
  const raw = env.FDE2E_REPORT_PREVIEW_RULES_VERSION;
  if (raw !== undefined && raw !== "" && Number.isInteger(Number(raw)) && Number(raw) > 0) {
    return Number(raw);
  }
  return LINK_PREVIEW.rulesVersion * 1000 + EXTRACT_VERSION;
}

export function previewPluginVersion(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.FDE2E_REPORT_PREVIEW_PLUGIN_VERSION;
  return raw && raw.trim() ? raw.trim() : LINK_PREVIEW.version;
}

/** `sha256(plugin_id \0 plugin_version \0 rules_version \0 canonical_url \0 body_hash)`。 */
export function buildPreviewCacheKey(input: {
  canonicalUrl: string;
  bodyHash: string;
  pluginId: string;
  pluginVersion: string;
  rulesVersion: number;
}): string {
  return createHash("sha256")
    .update(
      [
        input.pluginId,
        input.pluginVersion,
        String(input.rulesVersion),
        input.canonicalUrl,
        input.bodyHash,
      ].join("\0"),
    )
    .digest("hex");
}

export function bodyHash(bodyMd: string): string {
  return createHash("sha256").update(bodyMd).digest("hex");
}

/** 阶段列表只由 URL 形态决定（真正的 MIME 由 meta/probe 写入字段）。 */
export function phasesForUrl(url: string): readonly PreviewPhase[] {
  if (PAGE_LIKE_IMAGE.test(url) || PAGE_LIKE_VIDEO.test(url) || PAGE_LIKE_AUDIO.test(url)) {
    return ["probe"];
  }
  if (PAGE_LIKE_DOCUMENT.test(url)) return ["probe"];
  return ["meta", "cover"];
}

// ── MIME 嗅探（魔数 > Content-Type > 扩展名，design §6.3）────────────────────

export interface SniffedMime {
  kind: PreviewKind;
  mime: string | null;
}

function ascii(head: Uint8Array, length = 64): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(head.slice(0, length)).toLowerCase();
}

function magicMime(body: Uint8Array): string | null {
  if (!body || body.byteLength < 4) return null;
  const b = body;
  const text = ascii(body, 512).trimStart();
  if (text.startsWith("<!doctype html") || text.startsWith("<html") || text.startsWith("<head") || text.startsWith("<body")) {
    return "text/html";
  }
  if (text.startsWith("<?xml") && text.includes("<svg")) return "image/svg+xml";
  if (text.startsWith("<svg")) return "image/svg+xml";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45
  ) {
    return "audio/wav";
  }
  if (b[0] === 0x66 && b[1] === 0x74 && b[2] === 0x79 && b[3] === 0x70) {
    const brand = ascii(b.slice(8, 16), 8);
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "image/avif";
    if (brand.startsWith("m4a")) return "audio/mp4";
    if (brand.startsWith("qt")) return "video/quicktime";
    return "video/mp4";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return "audio/ogg";
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "audio/mpeg";
  if (b[0] === 0xff && (b[1] === 0xfb || b[1] === 0xf3 || b[1] === 0xf2)) return "audio/mpeg";
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return "audio/flac";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "application/zip";
  return null;
}

const MIME_EXT: Record<string, string> = {
  "text/html": "html",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
  "application/zip": "zip",
};

const EXT_MIME: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  log: "text/plain",
};

function extensionOf(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").pop() ?? "";
    const ext = last.includes(".") ? last.split(".").pop()!.toLowerCase() : "";
    return ext || null;
  } catch {
    return null;
  }
}

function kindForMime(mime: string | null): PreviewKind {
  if (!mime) return "unknown";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "page";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (
    mime === "application/pdf" ||
    mime === "application/zip" ||
    mime.startsWith("application/vnd.") ||
    mime === "application/msword" ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime.startsWith("text/")
  ) {
    return "document";
  }
  return "unknown";
}

export function sniffMime(
  body: Uint8Array | null,
  contentType: string | null,
  url: string,
): SniffedMime {
  const magic = magicMime(body ?? new Uint8Array());
  const declared = contentType?.split(";")[0]?.trim().toLowerCase() || null;
  const ext = extensionOf(url);
  const mime = magic ?? declared ?? (ext ? EXT_MIME[ext] ?? null : null);
  return { kind: kindForMime(mime), mime };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function filenameTitle(url: string): string | null {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (!last) return null;
    return truncateChars(decodeURIComponent(last), 200);
  } catch {
    return null;
  }
}

const HEAD_CACHE = "head:";
const PAGE_CACHE = "page:";
const META_CACHE = "meta:";

function cachedResponse(ctx: ResolveContext, key: string): PreviewFetchResponse | null {
  const value = ctx.cache.get(key);
  return value && typeof value === "object" && "status" in value
    ? (value as PreviewFetchResponse)
    : null;
}

async function metaPhase(
  link: ExtractedLink,
  ctx: ResolveContext,
): Promise<PhaseResult> {
  const headKey = `${HEAD_CACHE}${link.url}`;
  let head = cachedResponse(ctx, headKey);
  if (!head) {
    head = await ctx.transport.head(link.url, {
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
    });
    ctx.cache.set(headKey, head);
  }
  const ct = head.headers["content-type"] ?? null;
  const sniffed = sniffMime(head.body, ct, head.final_url || link.url);
  if (sniffed.kind !== "page") {
    return {
      phase: "meta",
      fields: { kind: sniffed.kind, mime: sniffed.mime, final_url: head.final_url || link.url },
    };
  }
  const pageKey = `${PAGE_CACHE}${link.url}`;
  let page = cachedResponse(ctx, pageKey);
  if (!page) {
    page =
      head.body && head.body.byteLength > 0
        ? head
        : await ctx.transport.page(link.url, {
            signal: ctx.signal,
            deadlineAt: ctx.deadlineAt,
          });
    ctx.cache.set(pageKey, page);
  }
  const html = decodeHtml(page.body ?? new Uint8Array(), page.headers["content-type"] ?? null);
  const meta = parseHtmlMeta(html, page.final_url || link.url);
  ctx.cache.set(`${META_CACHE}${link.url}`, meta);
  return {
    phase: "meta",
    fields: {
      kind: "page",
      mime: sniffed.mime ?? "text/html",
      final_url: page.final_url || link.url,
      title: meta.title,
      description: meta.description,
      site_name: meta.site_name ?? hostnameOf(page.final_url || link.url),
    },
  };
}

function coverPhase(link: ExtractedLink, ctx: ResolveContext): PhaseResult {
  const meta = ctx.cache.get(`${META_CACHE}${link.url}`) as ParsedHtmlMeta | undefined;
  if (!meta || !meta.cover) {
    // 页面无封面也是成功（ready），旧值不因“新版本没找到封面”被清空。
    return { phase: "cover", fields: {} };
  }
  return { phase: "cover", fields: { cover: meta.cover } };
}

async function probePhase(
  link: ExtractedLink,
  ctx: ResolveContext,
): Promise<PhaseResult> {
  const key = `probe:${link.url}`;
  let response = cachedResponse(ctx, key);
  if (!response) {
    response = await ctx.transport.probe(link.url, {
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
    });
    ctx.cache.set(key, response);
  }
  const sniffed = sniffMime(
    response.body,
    response.headers["content-type"] ?? null,
    response.final_url || link.url,
  );
  const fields: PhaseResult["fields"] = {
    kind: sniffed.kind,
    mime: sniffed.mime,
    final_url: response.final_url || link.url,
  };
  if (sniffed.kind === "document") {
    const title = filenameTitle(response.final_url || link.url);
    if (title) fields.title = title;
  }
  return { phase: "probe", fields };
}

export const LINK_PREVIEW_PROVIDER: PreviewProvider = {
  manifest: LINK_PREVIEW,
  extractUrls: extractLinks,
  buildCacheKey: buildPreviewCacheKey,
  phases: (link) => phasesForUrl(link.url),
  async resolvePhase(link, phase, ctx) {
    if (phase === "meta") return metaPhase(link, ctx);
    if (phase === "cover") return coverPhase(link, ctx);
    if (phase === "probe") return probePhase(link, ctx);
    // crop/title 属 P2：P1 返回空字段（阶段模型已容纳）。
    return { phase, fields: {} };
  },
};

export const PREVIEW_LIMITS = {
  previews_per_post: MAX_LINKS_PER_POST,
  url_max_chars: MAX_URL_CHARS,
} as const;

export { MIME_EXT };

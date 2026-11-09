import { fail } from "./errors.ts";
import type { PostKind, WriteOp } from "./types.ts";

export const SLUG_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const RESERVED_IDS = new Set(["owner", "manager"]);
export const MAX_BODY_CHARS = 200_000;
/** 长文（`kind: "article"`）字符上限（report-longform D2；产品口径「512KB」）。 */
export const MAX_ARTICLE_CHARS = 512_000;
/** 长文正文 UTF-8 字节护栏（防 512k 四字节字符/JSON 转义放大内存）。 */
export const MAX_ARTICLE_BYTES = 2 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;
export const MAX_BATCH_ITEMS = 500;
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
/** Semantic/custom post tags (design §5.0): lowercase slug-ish, e.g. `result`. */
export const TAG_RE = /^[a-z0-9-]{1,24}$/;
export const MAX_TAGS = 8;

export const MEDIA_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
  "text/x-log": "log",
  "text/plain-log": "log",
};

export const ALLOWED_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "mp4",
  "webm",
  "txt",
  "md",
  "json",
  "log",
]);

export const EXT_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  log: "text/plain; charset=utf-8",
};

export function assertSlug(id: string, what = "account id"): string {
  if (!SLUG_RE.test(id)) {
    fail(
      "BAD_REQUEST",
      `invalid ${what} "${id}": must match ${SLUG_RE.source} (lowercase, 1-32 chars)`,
    );
  }
  return id;
}

/**
 * 归一化载体字段（report-longform P1-2）：缺省/空值为 `note`；未知值 `BAD_REQUEST`。
 * 只允许 `"note" | "article"` 两个字面量。
 */
export function normalizeKind(input: unknown): PostKind {
  if (input === undefined || input === null || input === "") return "note";
  if (input === "note" || input === "article") return input;
  fail(
    "BAD_REQUEST",
    `invalid kind ${JSON.stringify(input)} (expected "note" or "article")`,
  );
}

export function assertBody(body: unknown, kind: PostKind = "note"): string {
  if (typeof body !== "string") fail("BAD_REQUEST", "body must be a string");
  const trimmed = body.trim();
  if (!trimmed) fail("BAD_REQUEST", "body must not be empty");
  if (kind === "article") {
    // 字节护栏先判（report-longform §2.2）：超 2 MiB 的正文直接按体积拒绝
    // （防 512k 多字节字符/JSON 转义放大内存），再用字符上限给精确口径。
    // TextEncoder 是 core 跨端可用的（浏览器/Node/Bun 同一 API）。
    const bytes = new TextEncoder().encode(body).length;
    if (bytes > MAX_ARTICLE_BYTES) {
      fail("BAD_REQUEST", "body too large (max 2 MiB utf-8 for article)");
    }
    if (body.length > MAX_ARTICLE_CHARS) {
      fail("BAD_REQUEST", `body too long (max ${MAX_ARTICLE_CHARS.toLocaleString("en-US")} chars for article)`);
    }
    return body;
  }
  if (body.length > MAX_BODY_CHARS) {
    fail("BAD_REQUEST", `body too long (max ${MAX_BODY_CHARS} chars)`);
  }
  return body;
}

/**
 * Validate + normalize a tag list: array of `[a-z0-9-]{1,24}`, at most 8 distinct
 * values, duplicates removed (first occurrence wins). Missing/null means `[]`.
 */
export function normalizeTags(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) fail("BAD_REQUEST", "tags must be an array of strings");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") fail("BAD_REQUEST", "tags entries must be strings");
    if (!TAG_RE.test(raw)) {
      fail(
        "BAD_REQUEST",
        `invalid tag "${raw}": must match ${TAG_RE.source} (lowercase letters, digits, dashes; 1-24 chars)`,
      );
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  if (out.length > MAX_TAGS) {
    fail("BAD_REQUEST", `too many tags (${out.length}); max ${MAX_TAGS} distinct tags per post`);
  }
  return out;
}

/** Single-tag filter validation (read/search). */
export function normalizeTagFilter(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || !TAG_RE.test(input)) {
    fail("BAD_REQUEST", `invalid tag filter: must match ${TAG_RE.source}`);
  }
  return input;
}

function normalizeMedia(media: unknown): string[] {
  if (media === undefined || media === null) return [];
  if (!Array.isArray(media)) fail("BAD_REQUEST", "media must be an array of sha256 hashes");
  if (media.length > MAX_ATTACHMENTS) {
    fail("BAD_REQUEST", `too many attachments (max ${MAX_ATTACHMENTS})`);
  }
  const out: string[] = [];
  for (const m of media) {
    if (typeof m !== "string" || !/^[a-f0-9]{64}$/.test(m)) {
      fail("BAD_REQUEST", "media entries must be lowercase sha256 hex");
    }
    out.push(m);
  }
  return out;
}

/**
 * Validate one JSONL write op. `attach` (local file paths) is a CLI-side extension:
 * the CLI uploads those files first and rewrites the op into `media` hashes.
 */
export function validateWriteOp(input: unknown): WriteOp {
  if (typeof input !== "object" || input === null) fail("BAD_REQUEST", "op must be an object");
  const obj = input as Record<string, unknown>;
  if (obj.commit === true) fail("BAD_REQUEST", "commit marker is not a write op");
  const op = obj.op;
  if (op === "post") {
    const kind = normalizeKind(obj.kind);
    const body = assertBody(obj.body, kind);
    const media = normalizeMedia(obj.media);
    const quote = typeof obj.quote === "string" && obj.quote ? assertRefSpec(obj.quote) : null;
    return {
      op: "post",
      body,
      quote,
      media,
      ref: normalizeRef(obj.ref),
      tags: normalizeTags(obj.tags),
      kind,
    };
  }
  if (op === "reply") {
    if (typeof obj.parent !== "string" || !obj.parent) {
      fail("BAD_REQUEST", "reply op requires parent");
    }
    const kind = normalizeKind(obj.kind);
    const body = assertBody(obj.body, kind);
    const media = normalizeMedia(obj.media);
    return {
      op: "reply",
      parent: assertRefSpec(obj.parent),
      body,
      media,
      tags: normalizeTags(obj.tags),
      kind,
    };
  }
  fail("BAD_REQUEST", `unknown op ${JSON.stringify(op)} (expected "post" or "reply")`);
}

const REF_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** `ref` names a post created earlier in the same batch. */
function normalizeRef(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fail("BAD_REQUEST", "ref must be a string");
  if (!REF_NAME.test(value)) fail("BAD_REQUEST", "ref must match [A-Za-z0-9_-]{1,32}");
  return value;
}

/**
 * Parent/quote targets may address a post created earlier in the same batch:
 * `$prev` (the last one), `$root` (the first one), or `$ref:<name>`.
 */
function assertRefSpec(value: string): string {
  if (value === "$prev" || value === "$root") return value;
  if (value.startsWith("$ref:")) {
    const name = value.slice(5);
    if (!REF_NAME.test(name)) fail("BAD_REQUEST", `invalid batch ref "${value}"`);
    return value;
  }
  if (value.startsWith("$")) fail("BAD_REQUEST", `unknown batch reference "${value}"`);
  return value;
}

export function isCommitLine(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as Record<string, unknown>).commit === true
  );
}

export interface ParsedBatchLine {
  kind: "op" | "commit";
  op?: WriteOp;
}

/** Parse a single JSONL line. Throws on malformed input. */
export function parseBatchLine(line: string): ParsedBatchLine {
  const trimmed = line.trim();
  if (!trimmed) fail("BAD_REQUEST", "empty JSONL line (blank lines are not operations)");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    fail("BAD_REQUEST", `invalid JSON line: ${(err as Error).message}`);
  }
  if (isCommitLine(parsed)) return { kind: "commit" };
  return { kind: "op", op: validateWriteOp(parsed) };
}

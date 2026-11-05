import { fail } from "./errors.ts";
import type { WriteOp } from "./types.ts";

export const SLUG_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const RESERVED_IDS = new Set(["owner", "manager"]);
export const MAX_BODY_CHARS = 200_000;
export const MAX_ATTACHMENTS = 4;
export const MAX_BATCH_ITEMS = 500;
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

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

export function assertBody(body: unknown): string {
  if (typeof body !== "string") fail("BAD_REQUEST", "body must be a string");
  const trimmed = body.trim();
  if (!trimmed) fail("BAD_REQUEST", "body must not be empty");
  if (body.length > MAX_BODY_CHARS) {
    fail("BAD_REQUEST", `body too long (max ${MAX_BODY_CHARS} chars)`);
  }
  return body;
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
    const body = assertBody(obj.body);
    const media = normalizeMedia(obj.media);
    const quote = typeof obj.quote === "string" && obj.quote ? assertRefSpec(obj.quote) : null;
    return { op: "post", body, quote, media, ref: normalizeRef(obj.ref) };
  }
  if (op === "reply") {
    if (typeof obj.parent !== "string" || !obj.parent) {
      fail("BAD_REQUEST", "reply op requires parent");
    }
    const body = assertBody(obj.body);
    const media = normalizeMedia(obj.media);
    return { op: "reply", parent: assertRefSpec(obj.parent), body, media };
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

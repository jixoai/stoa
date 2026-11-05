import { fail } from "./errors.ts";

export interface Cursor {
  v: 1;
  ts: number;
  id: string;
}

export type PageDirection = "asc" | "desc";

export function encodeCursor(ts: number, id: string): string {
  const payload: Cursor = { v: 1, ts, id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  if (!raw) fail("BAD_REQUEST", "empty cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    fail("BAD_REQUEST", "invalid cursor (not base64url JSON)");
  }
  if (typeof parsed !== "object" || parsed === null) fail("BAD_REQUEST", "invalid cursor");
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) fail("BAD_REQUEST", "unsupported cursor version");
  if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) {
    fail("BAD_REQUEST", "invalid cursor timestamp");
  }
  if (typeof obj.id !== "string" || !obj.id) fail("BAD_REQUEST", "invalid cursor id");
  return { v: 1, ts: obj.ts, id: obj.id };
}

export interface KeysetClause {
  sql: string;
  params: unknown[];
  direction: PageDirection;
}

/**
 * Build the keyset predicate. `before` pages toward older rows, `after` toward
 * newer rows; at most one may be supplied. No OFFSET anywhere (design §5.2).
 */
export function keysetClause(opts: {
  before?: string | null;
  after?: string | null;
  defaultDirection?: PageDirection;
}): KeysetClause {
  const { before, after } = opts;
  if (before && after) fail("BAD_REQUEST", "use either before or after, not both");
  if (before) {
    const c = decodeCursor(before);
    return {
      sql: "(created_at < ? OR (created_at = ? AND id < ?))",
      params: [c.ts, c.ts, c.id],
      direction: "desc",
    };
  }
  if (after) {
    const c = decodeCursor(after);
    return {
      sql: "(created_at > ? OR (created_at = ? AND id > ?))",
      params: [c.ts, c.ts, c.id],
      direction: "asc",
    };
  }
  return {
    sql: "1=1",
    params: [],
    direction: opts.defaultDirection ?? "desc",
  };
}

export interface PageResult<T> {
  items: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/** `rows` must contain limit+1 rows. Row identity is `(created_at, id)`. */
export function finalizePage<T extends { created_at: number; id: string }>(
  rows: T[],
  limit: number,
): PageResult<T> {
  if (limit <= 0) fail("BAD_REQUEST", "limit must be > 0");
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

export function parseLimit(raw: string | null | undefined, def = 20, max = 100): number {
  if (raw === null || raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail("BAD_REQUEST", "limit must be a positive integer");
  return Math.min(n, max);
}

/**
 * Parse human/AI supplied times: epoch ms, epoch seconds, ISO 8601, or relative
 * offsets like `30m` / `2h` / `3d`.
 */
export function parseTime(raw: string | null | undefined, now = Date.now()): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = raw.trim();
  const rel = /^(\d+)([smhd])$/.exec(value);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!;
    const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return now - n * mult;
  }
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    // >= 10^12 is treated as ms; otherwise seconds (both are unambiguous in practice)
    return n >= 1_000_000_000_000 ? n : n * 1000;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    fail("BAD_REQUEST", `invalid time "${raw}" (expected epoch, ISO 8601, or 30m/2h/3d)`);
  }
  return parsed;
}

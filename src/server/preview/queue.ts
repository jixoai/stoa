/**
 * `preview_jobs` 持久化队列 + `post_previews` 行读写（design §3.1/§3.2/§5.1）。
 *
 * 纯 DB 层：不抓取、不发请求、不依赖 Store；Store/worker/service 共同调用，
 * 保证写入事务（pending 行 + job）与 claim/complete/fail 只有一份 SQL。
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { all, get, run } from "../db.ts";
import type {
  PreviewCover,
  PreviewCoverKind,
  PreviewErrorCode,
  PreviewKind,
  PreviewLink,
  PreviewStatus,
} from "../../core/plugins/types.ts";

export interface PreviewRow {
  post_id: string;
  position: number;
  url: string;
  url_hash: string;
  label: string | null;
  cache_key: string;
  kind: string;
  mime: string | null;
  title: string | null;
  description: string | null;
  site_name: string | null;
  final_url: string | null;
  cover_url: string | null;
  cover_w: number | null;
  cover_h: number | null;
  cover_kind: string | null;
  status: string;
  phase: string;
  fields_ready: string;
  attempts: number;
  error_code: string | null;
  updated_at: number;
}

export interface PreviewJobRow {
  post_id: string;
  url_hash: string;
  cache_key: string;
  status: string;
  attempts: number;
  next_run_at: number;
  enqueued_at: number;
  updated_at: number;
  phase: string | null;
  post_created_at: number;
  last_error: string | null;
}

/** 写入路径的链接输入（cacheKey 已算定）。 */
export interface PendingLinkInput {
  position: number;
  url: string;
  urlHash: string;
  label: string | null;
  cacheKey: string;
  /** 预算未授权的链接延迟到下一窗口（缺省 = now，立即处理）。 */
  nextRunAt?: number;
}

export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export function parseFieldsReady(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function previewRowToLink(row: PreviewRow): PreviewLink {
  const cover: PreviewCover | null = row.cover_url
    ? {
        url: row.cover_url,
        w: row.cover_w,
        h: row.cover_h,
        kind: (row.cover_kind as PreviewCoverKind) ?? null,
      }
    : null;
  return {
    url: row.url,
    final_url: row.final_url,
    label: row.label,
    kind: (row.kind as PreviewKind) ?? "unknown",
    mime: row.mime,
    title: row.title,
    description: row.description,
    site_name: row.site_name,
    cover,
    status: (row.status as PreviewStatus) ?? "pending",
    phase: row.phase,
    fields_ready: parseFieldsReady(row.fields_ready),
    cache_key: row.cache_key,
    attempts: row.attempts,
    updated_at: row.updated_at,
    error_code: (row.error_code as PreviewErrorCode) ?? null,
  };
}

export function previewRowsForPost(db: Database, postId: string): PreviewRow[] {
  return all<PreviewRow>(
    db,
    "SELECT * FROM post_previews WHERE post_id = ? ORDER BY position ASC",
    postId,
  );
}

export function previewRow(db: Database, postId: string, urlHash: string): PreviewRow | null {
  return get<PreviewRow>(
    db,
    "SELECT * FROM post_previews WHERE post_id = ? AND url_hash = ? ORDER BY position ASC LIMIT 1",
    postId,
    urlHash,
  );
}

/**
 * 写入路径：upsert pending 行 + 去重入队（design §4）。
 * 同帖同 URL 重复入队只保留一行 job；cacheKey 变化原地重置 attempts/next_run_at；
 * 同 key 的 failed job 重新入队（插件重开后的复活语义）。
 */
export function enqueuePreviewLinks(
  db: Database,
  input: { postId: string; postCreatedAt: number; links: PendingLinkInput[]; now: number },
): void {
  for (const link of input.links) {
    run(
      db,
      `INSERT INTO post_previews(
         post_id, position, url, url_hash, label, cache_key, kind, mime, title, description,
         site_name, final_url, cover_url, cover_w, cover_h, cover_kind, status, phase,
         fields_ready, attempts, error_code, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unknown', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
               'pending', 'queued', '[]', 0, NULL, ?)
       ON CONFLICT(post_id, position) DO UPDATE SET
         url = excluded.url,
         url_hash = excluded.url_hash,
         label = excluded.label,
         cache_key = excluded.cache_key`,
      input.postId,
      link.position,
      link.url,
      link.urlHash,
      link.label,
      link.cacheKey,
      input.now,
    );
    run(
      db,
      `INSERT INTO preview_jobs(
         post_id, url_hash, cache_key, status, attempts, next_run_at, enqueued_at,
         updated_at, phase, post_created_at, last_error)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, NULL, ?, NULL)
       ON CONFLICT(post_id, url_hash) DO UPDATE SET
         cache_key = excluded.cache_key,
         status = CASE
           WHEN preview_jobs.cache_key != excluded.cache_key THEN 'queued'
           WHEN preview_jobs.status = 'failed' THEN 'queued'
           ELSE preview_jobs.status
         END,
         attempts = CASE
           WHEN preview_jobs.cache_key != excluded.cache_key THEN 0
           ELSE preview_jobs.attempts
         END,
         next_run_at = CASE
           WHEN preview_jobs.cache_key != excluded.cache_key OR preview_jobs.status = 'failed'
             THEN excluded.next_run_at
           ELSE preview_jobs.next_run_at
         END,
         enqueued_at = CASE
           WHEN preview_jobs.cache_key != excluded.cache_key THEN excluded.enqueued_at
           ELSE preview_jobs.enqueued_at
         END,
         updated_at = excluded.updated_at`,
      input.postId,
      link.urlHash,
      link.cacheKey,
      link.nextRunAt ?? input.now,
      input.now,
      input.now,
      input.postCreatedAt,
    );
  }
}

/** cacheKey 变化后的原地重置（扫描/手动 backfill 用；不动已展示字段）。 */
export function enqueueJobOnly(
  db: Database,
  input: {
    postId: string;
    urlHash: string;
    cacheKey: string;
    postCreatedAt: number;
    now: number;
    /** 预算未授权时延迟到下一窗口（R3）。 */
    nextRunAt?: number;
  },
): void {
  run(
    db,
    `INSERT INTO preview_jobs(
       post_id, url_hash, cache_key, status, attempts, next_run_at, enqueued_at,
       updated_at, phase, post_created_at, last_error)
     VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, NULL, ?, NULL)
     ON CONFLICT(post_id, url_hash) DO UPDATE SET
       cache_key = CASE
         WHEN preview_jobs.cache_key != excluded.cache_key THEN excluded.cache_key
         ELSE preview_jobs.cache_key
       END,
       status = CASE
         WHEN preview_jobs.cache_key != excluded.cache_key THEN 'queued'
         WHEN preview_jobs.status = 'failed' THEN 'queued'
         ELSE preview_jobs.status
       END,
       attempts = CASE
         WHEN preview_jobs.cache_key != excluded.cache_key THEN 0
         ELSE preview_jobs.attempts
       END,
       next_run_at = CASE
         WHEN preview_jobs.cache_key != excluded.cache_key OR preview_jobs.status = 'failed'
           THEN excluded.next_run_at
         ELSE preview_jobs.next_run_at
       END,
       updated_at = CASE
         WHEN preview_jobs.cache_key != excluded.cache_key OR preview_jobs.status = 'failed'
           THEN excluded.updated_at
         ELSE preview_jobs.updated_at
       END,
       last_error = CASE
         WHEN preview_jobs.cache_key != excluded.cache_key OR preview_jobs.status = 'failed'
           THEN NULL
         ELSE preview_jobs.last_error
       END`,
    input.postId,
    input.urlHash,
    input.cacheKey,
    input.nextRunAt ?? input.now,
    input.now,
    input.now,
    input.postCreatedAt,
  );
}

/** claim 原子化：事务内挑选 → 条件更新（并发 claim 不重复）。 */
export function claimNext(
  db: Database,
  opts: { now: number; limit: number },
): PreviewJobRow[] {
  const lim = Math.max(0, Math.floor(opts.limit));
  if (lim === 0) return [];
  const tx = db.transaction((): PreviewJobRow[] => {
    const candidates = all<PreviewJobRow>(
      db,
      `SELECT * FROM preview_jobs
       WHERE status = 'queued' AND next_run_at <= ?
       ORDER BY post_created_at DESC, enqueued_at ASC
       LIMIT ?`,
      opts.now,
      lim,
    );
    const claimed: PreviewJobRow[] = [];
    for (const row of candidates) {
      const updated = run(
        db,
        `UPDATE preview_jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
         WHERE post_id = ? AND url_hash = ? AND status = 'queued'`,
        opts.now,
        row.post_id,
        row.url_hash,
      );
      if (updated.changes > 0) claimed.push({ ...row, status: "running", attempts: row.attempts + 1 });
    }
    return claimed;
  });
  return tx();
}

export function setJobPhase(db: Database, postId: string, urlHash: string, phase: string, now: number): void {
  run(
    db,
    "UPDATE preview_jobs SET phase = ?, updated_at = ? WHERE post_id = ? AND url_hash = ?",
    phase,
    now,
    postId,
    urlHash,
  );
}

export function completeJob(db: Database, postId: string, urlHash: string): void {
  run(db, "DELETE FROM preview_jobs WHERE post_id = ? AND url_hash = ?", postId, urlHash);
}

/** 未执行的释放（域名忙/插件关闭/abort）：回到队列且不消耗一次尝试。 */
export function releaseJob(db: Database, postId: string, urlHash: string, now: number): void {
  run(
    db,
    `UPDATE preview_jobs
     SET status = 'queued', attempts = max(attempts - 1, 0), next_run_at = ?, updated_at = ?
     WHERE post_id = ? AND url_hash = ?`,
    now,
    now,
    postId,
    urlHash,
  );
}

/** 可重试失败：退避 or 达到最大次数后置 failed（保留行，等待版本扫描/手动回填）。 */
export function failJob(
  db: Database,
  opts: {
    postId: string;
    urlHash: string;
    error: string;
    now: number;
    backoffMs: readonly number[];
    maxAttempts: number;
  },
): void {
  const row = get<{ attempts: number }>(
    db,
    "SELECT attempts FROM preview_jobs WHERE post_id = ? AND url_hash = ?",
    opts.postId,
    opts.urlHash,
  );
  const attempts = row?.attempts ?? 1;
  if (attempts >= opts.maxAttempts) {
    run(
      db,
      `UPDATE preview_jobs SET status = 'failed', last_error = ?, updated_at = ?
       WHERE post_id = ? AND url_hash = ?`,
      opts.error,
      opts.now,
      opts.postId,
      opts.urlHash,
    );
    return;
  }
  const index = Math.min(Math.max(attempts - 1, 0), opts.backoffMs.length - 1);
  const delay = opts.backoffMs[index] ?? 24 * 60 * 60_000;
  run(
    db,
    `UPDATE preview_jobs
     SET status = 'queued', next_run_at = ?, last_error = ?, updated_at = ?
     WHERE post_id = ? AND url_hash = ?`,
    opts.now + delay,
    opts.error,
    opts.now,
    opts.postId,
    opts.urlHash,
  );
}

/** 启动恢复：`running` 残留重置为 queued（attempts 保留，小抖动后重跑）。 */
export function resetRunningJobs(db: Database, now: number, jitterMs = 250): number {
  const res = run(
    db,
    `UPDATE preview_jobs SET status = 'queued', next_run_at = ?, updated_at = ?
     WHERE status = 'running'`,
    now + jitterMs,
    now,
  );
  return res.changes;
}

/** worker claim 时先把新 cacheKey 写到字段行（不动旧字段/旧 status，design §5.2）。 */
export function adoptJobCacheKey(
  db: Database,
  postId: string,
  urlHash: string,
  cacheKey: string,
  now: number,
): number {
  return run(
    db,
    "UPDATE post_previews SET cache_key = ?, updated_at = ? WHERE post_id = ? AND url_hash = ?",
    cacheKey,
    now,
    postId,
    urlHash,
  ).changes;
}

export interface PreviewQueueStats {
  queued: number;
  running: number;
  failed: number;
  pending: number;
  partial: number;
  ready: number;
  preview_failed: number;
  last_error: string | null;
}

export function previewQueueStats(db: Database): PreviewQueueStats {
  const jobs = all<{ status: string; c: number }>(
    db,
    "SELECT status, COUNT(*) AS c FROM preview_jobs GROUP BY status",
  );
  const jobCounts = new Map(jobs.map((row) => [row.status, row.c]));
  const previews = all<{ status: string; c: number }>(
    db,
    "SELECT status, COUNT(*) AS c FROM post_previews GROUP BY status",
  );
  const previewCounts = new Map(previews.map((row) => [row.status, row.c]));
  const lastError = get<{ last_error: string | null }>(
    db,
    "SELECT last_error FROM preview_jobs WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
  );
  return {
    queued: jobCounts.get("queued") ?? 0,
    running: jobCounts.get("running") ?? 0,
    failed: jobCounts.get("failed") ?? 0,
    pending: previewCounts.get("pending") ?? 0,
    partial: previewCounts.get("partial") ?? 0,
    ready: previewCounts.get("ready") ?? 0,
    preview_failed: previewCounts.get("failed") ?? 0,
    last_error: lastError?.last_error ?? null,
  };
}

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fail } from "../core/errors.ts";

export type Bindings = SQLQueryBindings[];

export function openDatabase(opts: {
  dataDir: string;
  readonly?: boolean;
}): Database {
  const { dataDir } = opts;
  const path = join(dataDir, "report.sqlite");
  if (!opts.readonly) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } else if (!existsSync(path)) {
    fail("NOT_FOUND", `database not found at ${path} (run init first)`);
  }
  const db = new Database(path, { readonly: opts.readonly ?? false, create: !opts.readonly });
  if (!opts.readonly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
  } else {
    db.exec("PRAGMA busy_timeout = 5000");
  }
  return db;
}

export function all<T>(db: Database, sql: string, ...params: Bindings): T[] {
  return db.query(sql).all(...params) as T[];
}

export function get<T>(db: Database, sql: string, ...params: Bindings): T | null {
  const row = db.query(sql).get(...params) as T | undefined | null;
  return row ?? null;
}

export function run(
  db: Database,
  sql: string,
  ...params: Bindings
): { changes: number; lastInsertRowid: number } {
  const res = db.query(sql).run(...params);
  return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
}

export const SCHEMA_VERSION = 6;

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      display TEXT NOT NULL,
      profile TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT 'slate',
      created_at INTEGER NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      token_hash TEXT,
      token_rotated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_token ON accounts(token_hash);

    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      committed_at INTEGER,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      body_md TEXT NOT NULL,
      parent_id TEXT,
      root_id TEXT NOT NULL,
      self_thread_id TEXT NOT NULL,
      self_thread_is_leaf INTEGER NOT NULL DEFAULT 1,
      reply_to_account_id TEXT,
      quoted_post_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      batch_id TEXT NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_posts_root ON posts(root_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at, id);
    CREATE INDEX IF NOT EXISTS idx_posts_sthread ON posts(self_thread_id, self_thread_is_leaf);
    CREATE INDEX IF NOT EXISTS idx_posts_batch ON posts(batch_id, seq);
    CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id);

    CREATE TABLE IF NOT EXISTS participants (
      root_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      source TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (root_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_participants_account ON participants(account_id, root_id);

    CREATE TABLE IF NOT EXISTS mentions (
      post_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (post_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_account ON mentions(account_id);

    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      post_id TEXT,
      root_id TEXT,
      batch_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_root ON events(root_id, seq);

    CREATE TABLE IF NOT EXISTS cursors (
      account_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      author TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      items_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_open_author
      ON drafts(author) WHERE status = 'open';

    CREATE TABLE IF NOT EXISTS media (
      hash TEXT PRIMARY KEY,
      ext TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      ref_count INTEGER NOT NULL DEFAULT 0,
      w INTEGER,
      h INTEGER
    );

    CREATE TABLE IF NOT EXISTS post_media (
      post_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (post_id, hash)
    );
    CREATE INDEX IF NOT EXISTS idx_post_media_hash ON post_media(hash);

    CREATE TABLE IF NOT EXISTS stream_tickets (
      nonce TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      account_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_account ON bookmarks(account_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      followee_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (follower_id, followee_id)
    );
    CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

    -- v6: 服务端按帖已读（report-server-read-state design §3.1）。
    CREATE TABLE IF NOT EXISTS post_reads (
      account_id TEXT NOT NULL,
      post_id    TEXT NOT NULL,
      read_at    INTEGER NOT NULL,
      PRIMARY KEY (account_id, post_id)
    );
    -- 删帖/清理/统计按 post_id 反查（不参与读路径的覆盖判断）。
    CREATE INDEX IF NOT EXISTS idx_post_reads_post ON post_reads(post_id);

    -- v5: 帖子持久化预览字段（report-link-preview design §3.1，schema 逐字）。
    CREATE TABLE IF NOT EXISTS post_previews (
      post_id      TEXT NOT NULL,
      position     INTEGER NOT NULL,
      url          TEXT NOT NULL,
      url_hash     TEXT NOT NULL,
      label        TEXT,
      cache_key    TEXT NOT NULL,
      kind         TEXT NOT NULL DEFAULT 'unknown',
      mime         TEXT,
      title        TEXT,
      description  TEXT,
      site_name    TEXT,
      final_url    TEXT,
      cover_url    TEXT,
      cover_w      INTEGER,
      cover_h      INTEGER,
      cover_kind   TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      phase        TEXT NOT NULL DEFAULT 'queued',
      fields_ready TEXT NOT NULL DEFAULT '[]',
      attempts     INTEGER NOT NULL DEFAULT 0,
      error_code   TEXT,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (post_id, position)
    );

    -- v5: 持久化预览任务队列（design §3.2）。
    CREATE TABLE IF NOT EXISTS preview_jobs (
      post_id         TEXT NOT NULL,
      url_hash        TEXT NOT NULL,
      cache_key       TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'queued',
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_run_at     INTEGER NOT NULL,
      enqueued_at     INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      phase           TEXT,
      post_created_at INTEGER NOT NULL,
      last_error      TEXT,
      PRIMARY KEY (post_id, url_hash)
    );
  `);

  // ── additive migrations for databases created before schema v2 ──────────────
  // CREATE TABLE IF NOT EXISTS never adds columns, so old `posts` tables need an
  // explicit ALTER. The PRAGMA guard makes re-running `migrate()` idempotent.
  if (!hasColumn(db, "posts", "tags")) {
    db.exec("ALTER TABLE posts ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
  }

  // Backfill the default follow for existing instances (design §5.0: owner only
  // follows manager by default). Runs only while the edge table is still empty —
  // the documented "empty table" backfill — and never touches a populated one.
  const followCount =
    (db.query("SELECT COUNT(*) AS c FROM follows").get() as { c: number } | null)?.c ?? 0;
  if (followCount === 0) {
    const pair = db
      .query("SELECT COUNT(*) AS c FROM accounts WHERE id IN ('owner', 'manager') AND disabled != 2")
      .get() as { c: number } | null;
    if ((pair?.c ?? 0) === 2) {
      db.query(
        "INSERT OR IGNORE INTO follows(follower_id, followee_id, created_at) VALUES ('owner', 'manager', ?)",
      ).run(Date.now());
    }
  }

  // v3：媒体固有尺寸（前端占位预留）。老库补列；历史行在读取时按需解析并回填。
  if (!hasColumn(db, "media", "w")) db.exec("ALTER TABLE media ADD COLUMN w INTEGER");
  if (!hasColumn(db, "media", "h")) db.exec("ALTER TABLE media ADD COLUMN h INTEGER");

  // v5 早期草稿（表已建但列不全）兼容：CREATE TABLE IF NOT EXISTS 不会补列，
  // 这里按 design §3.1/§3.2 逐列补齐，保证重复 migrate 幂等。
  const previewColumns: Array<[string, string]> = [
    ["url", "TEXT NOT NULL DEFAULT ''"],
    ["url_hash", "TEXT NOT NULL DEFAULT ''"],
    ["label", "TEXT"],
    ["cache_key", "TEXT NOT NULL DEFAULT ''"],
    ["kind", "TEXT NOT NULL DEFAULT 'unknown'"],
    ["mime", "TEXT"],
    ["title", "TEXT"],
    ["description", "TEXT"],
    ["site_name", "TEXT"],
    ["final_url", "TEXT"],
    ["cover_url", "TEXT"],
    ["cover_w", "INTEGER"],
    ["cover_h", "INTEGER"],
    ["cover_kind", "TEXT"],
    ["status", "TEXT NOT NULL DEFAULT 'pending'"],
    ["phase", "TEXT NOT NULL DEFAULT 'queued'"],
    ["fields_ready", "TEXT NOT NULL DEFAULT '[]'"],
    ["attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["error_code", "TEXT"],
    ["updated_at", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [column, ddl] of previewColumns) {
    if (!hasColumn(db, "post_previews", column)) {
      db.exec(`ALTER TABLE post_previews ADD COLUMN ${column} ${ddl}`);
    }
  }
  const jobColumns: Array<[string, string]> = [
    ["cache_key", "TEXT NOT NULL DEFAULT ''"],
    ["status", "TEXT NOT NULL DEFAULT 'queued'"],
    ["attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["next_run_at", "INTEGER NOT NULL DEFAULT 0"],
    ["enqueued_at", "INTEGER NOT NULL DEFAULT 0"],
    ["updated_at", "INTEGER NOT NULL DEFAULT 0"],
    ["phase", "TEXT"],
    ["post_created_at", "INTEGER NOT NULL DEFAULT 0"],
    ["last_error", "TEXT"],
  ];
  for (const [column, ddl] of jobColumns) {
    if (!hasColumn(db, "preview_jobs", column)) {
      db.exec(`ALTER TABLE preview_jobs ADD COLUMN ${column} ${ddl}`);
    }
  }

  // B3：索引必须在补列之后创建（早期 v5 草稿表可能缺 cache_key/status/
  // next_run_at/post_created_at；先建索引会让 migrate 在启动时抛 no such column）。
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_post_previews_cache ON post_previews(cache_key);
    CREATE INDEX IF NOT EXISTS idx_post_previews_status ON post_previews(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_preview_jobs_ready
      ON preview_jobs(status, next_run_at, post_created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_preview_jobs_post ON preview_jobs(post_id);
  `);

  db.exec(`
    INSERT INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);
}

export function getMeta(db: Database, key: string): string | null {
  const row = get<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", key);
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  run(
    db,
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

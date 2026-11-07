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

export const SCHEMA_VERSION = 4;

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

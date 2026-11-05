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

export const SCHEMA_VERSION = 1;

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
      ref_count INTEGER NOT NULL DEFAULT 0
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

    INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
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

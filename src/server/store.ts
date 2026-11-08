import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  ALLOWED_EXTS,
  MAX_ATTACHMENTS,
  MAX_BATCH_ITEMS,
  MAX_MEDIA_BYTES,
  assertSlug,
  assertBody,
  normalizeTagFilter,
  normalizeTags,
} from "../core/validation.ts";
import { fail } from "../core/errors.ts";
import { readMediaSize } from "../core/media-meta.ts";
import { newUlid } from "../core/ids.ts";
import { extractMentions } from "../core/mentions.ts";
import {
  encodeCursor,
  finalizePage,
  keysetClause,
  type PageDirection,
} from "../core/pagination.ts";
import { assembleThread } from "../core/thread.ts";
import { isGlobalRole, visibleRootsClause } from "../core/visibility.ts";
import { NOTIFICATION_TYPES } from "../core/types.ts";
import { builtinPlugin, LINK_PREVIEW } from "../core/plugins/builtin.ts";
import type { PhaseFields, PreviewLink, PreviewPhase, PreviewStatus, PreviewErrorCode } from "../core/plugins/types.ts";
import { indexPostPreviewLinks } from "./preview/indexer.ts";
import {
  adoptJobCacheKey,
  parseFieldsReady,
  previewRow,
  previewRowsForPost,
  previewRowToLink,
  type PreviewRow,
} from "./preview/queue.ts";
import {
  assertCanAppend,
  parseDraftItems,
  serializeDraftItems,
} from "../core/drafts.ts";
import {
  accountTokenEnvKey,
  randomToken,
  renderAccountEnvFile,
  sha256Hex,
} from "../core/auth.ts";
import type {
  Account,
  AuthorView,
  Draft,
  EventLine,
  EventLinesPage,
  FeedPage,
  FeedTab,
  Follow,
  MediaRef,
  MediaRow,
  NotificationEventLine,
  NotificationHistoryPage,
  NotificationLine,
  Post,
  PostView,
  ProfilePage,
  QuotedView,
  Role,
  SuggestedAccount,
  ThreadNode,
  ThreadSnapshotLine,
  ThreadView,
  TimelinePage,
  TrendingTag,
  WriteOp,
} from "../core/types.ts";
import { all, get, getMeta, run, setMeta, type Bindings } from "./db.ts";

export interface Viewer {
  id: string;
  role: Role;
}

interface AccountRow extends Omit<Account, "role" | "disabled"> {
  role: string;
  disabled: number;
}
/** Raw posts row: `tags` is the JSON array text as stored in SQLite. */
interface PostRow extends Omit<Post, "tags"> {
  tags: string;
}
interface FollowRow extends Follow {}
interface DraftRow extends Draft {}
interface EventRow {
  seq: number;
  type: string;
  actor: string;
  post_id: string | null;
  root_id: string | null;
  batch_id: string;
  created_at: number;
  payload_json: string;
  /** only present on `eventLines` rows (`LEFT JOIN posts`) */
  post_deleted?: number | null;
}
interface MediaRowDb extends MediaRow {}
interface BatchRow {
  id: string;
  author: string;
  started_at: number;
  committed_at: number | null;
  status: string;
}

export interface CommitResult {
  batch_id: string;
  posts: PostView[];
  idempotent: boolean;
}

export interface AccountCreateResult {
  account: Account;
  token: string;
  envPath: string;
}

export interface DraftSummary {
  id: string;
  author: string;
  items: number;
  updated_at: number;
}

const AVATARS = ["slate", "sky", "violet", "amber", "emerald", "rose", "teal", "indigo"];

function avatarFor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATARS[hash % AVATARS.length]!;
}

function toAccount(row: AccountRow): Account {
  return {
    ...row,
    role: row.role as Role,
    disabled: row.disabled as Account["disabled"],
  };
}

function parseTagsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toEventLine(row: EventRow): EventLine {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = {};
  }
  return {
    seq: row.seq,
    type: row.type as EventLine["type"],
    actor: row.actor,
    post_id: row.post_id,
    root_id: row.root_id,
    batch_id: row.batch_id,
    created_at: row.created_at,
    payload,
    post_deleted: row.post_deleted === 1,
  };
}

function toPost(row: PostRow): Post {
  return { ...row, tags: parseTagsJson(row.tags) };
}

function mediaRef(row: MediaRowDb): MediaRef {
  const ref: MediaRef = {
    hash: row.hash,
    ext: row.ext,
    bytes: row.bytes,
    url: `/api/media/${row.hash}`,
  };
  // 只在已知尺寸时携带，避免给每个媒体负载加两个 null 字段。
  if (row.w && row.h) {
    ref.w = row.w;
    ref.h = row.h;
  }
  return ref;
}

function authorView(row: AccountRow | null): AuthorView | null {
  if (!row) return null;
  return {
    id: row.id,
    display: row.display,
    profile: row.profile,
    avatar: row.avatar,
    role: row.role as Role,
    disabled: row.disabled as AuthorView["disabled"],
  };
}

function chunks<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

export class Store {
  readonly db: Database;
  readonly dataDir: string;
  private readonly clock: () => number;
  private readonly listeners = new Set<() => void>();
  /** sqlite_master 探测缓存：只读导出的旧 v4 库没有预览表。 */
  private previewTableCache: boolean | null = null;
  /** sqlite_master 探测缓存：只读导出的旧 v5 库没有 post_reads 表。 */
  private readTableCache: boolean | null = null;
  /** 单次 commitOps 内预算限流计数（R4：按批次聚合日志）。 */
  private previewBudgetLimited: { account_budget: number; global_budget: number } = {
    account_budget: 0,
    global_budget: 0,
  };

  constructor(opts: { dataDir: string; db: Database; clock?: () => number }) {
    this.dataDir = opts.dataDir;
    this.db = opts.db;
    this.clock = opts.clock ?? Date.now;
  }

  // ── change notification (in-process; the server is the only writer) ──────────
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyChange(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // a broken subscriber must never break a committed write
      }
    }
  }

  /**
   * Resolve on the next committed change, on timeout, or when `signal` aborts.
   * The optional signal lets long-lived readers (legacy SSE) exit promptly on
   * client disconnect without changing their wait cadence.
   */
  waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(false);
        return;
      }
      let done = false;
      const finish = (changed: boolean) => {
        if (done) return;
        done = true;
        this.listeners.delete(listener);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(changed);
      };
      const listener = () => finish(true);
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.listeners.add(listener);
    });
  }

  // ── accounts ────────────────────────────────────────────────────────────────
  getAccount(id: string): Account | null {
    const row = get<AccountRow>(this.db, "SELECT * FROM accounts WHERE id = ?", id);
    return row ? toAccount(row) : null;
  }

  requireActiveAccount(id: string): Account {
    const account = this.getAccount(id);
    if (!account) fail("NOT_FOUND", `account "${id}" not found`);
    if (account.disabled !== 0) fail("FORBIDDEN", `account "${id}" is disabled`);
    return account;
  }

  requireGlobal(accountId: string): Account {
    const account = this.requireActiveAccount(accountId);
    if (!isGlobalRole(account.role)) {
      fail("FORBIDDEN", `account "${accountId}" is not owner/manager`);
    }
    return account;
  }

  getAccountByTokenHash(hash: string): Account | null {
    const row = get<AccountRow>(
      this.db,
      "SELECT * FROM accounts WHERE token_hash = ? AND disabled = 0",
      hash,
    );
    return row ? toAccount(row) : null;
  }

  listAccounts(includeTombstones = false): Account[] {
    const rows = all<AccountRow>(
      this.db,
      includeTombstones
        ? "SELECT * FROM accounts ORDER BY created_at ASC, id ASC"
        : "SELECT * FROM accounts WHERE disabled != 2 ORDER BY created_at ASC, id ASC",
    );
    return rows.map(toAccount);
  }

  ensureInitAccount(input: {
    id: string;
    role: Role;
    display: string;
  }): AccountCreateResult {
    assertSlug(input.id);
    const existing = this.getAccount(input.id);
    if (existing) {
      const envPath = join(this.dataDir, "accounts", `${input.id}.env`);
      return { account: existing, token: "", envPath };
    }
    return this.insertAccount({
      id: input.id,
      role: input.role,
      display: input.display,
      profile: input.role === "owner" ? "人类 owner" : "总调度 manager",
    });
  }

  createAccount(input: {
    id: string;
    role?: Role;
    display?: string;
    profile?: string;
  }): AccountCreateResult {
    assertSlug(input.id);
    const role: Role = input.role ?? "agent";
    if (role !== "agent") {
      fail("BAD_REQUEST", "only agent accounts can be created (owner/manager exist from init)");
    }
    return this.insertAccount({ ...input, role });
  }

  private insertAccount(input: {
    id: string;
    role: Role;
    display?: string;
    profile?: string;
  }): AccountCreateResult {
    assertSlug(input.id);
    const role: Role = input.role;
    const existing = this.getAccount(input.id);
    if (existing) {
      if (existing.disabled === 2) {
        fail(
          "CONFLICT",
          `account id "${input.id}" is a tombstone and can never be reused; choose a new id`,
        );
      }
      fail("CONFLICT", `account "${input.id}" already exists`);
    }
    const token = randomToken();
    const now = this.clock();
    const display = input.display?.trim() || input.id;
    run(
      this.db,
      `INSERT INTO accounts(id, role, display, profile, avatar, created_at, disabled, token_hash, token_rotated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      input.id,
      role,
      display,
      input.profile ?? "",
      avatarFor(input.id),
      now,
      sha256Hex(token),
      now,
    );
    this.resetCursorToTip(input.id, now);
    const envPath = this.writeAccountEnv(input.id, token);
    const account = this.getAccount(input.id);
    if (!account) fail("INTERNAL", "account insert did not persist");
    return { account, token, envPath };
  }

  private resetCursorToTip(accountId: string, now: number): void {
    const tip = this.maxEventSeq();
    run(
      this.db,
      `INSERT INTO cursors(account_id, seq, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at`,
      accountId,
      tip,
      now,
    );
  }

  private writeAccountEnv(accountId: string, token: string): string {
    const dir = join(this.dataDir, "accounts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${accountId}.env`);
    writeFileSync(path, renderAccountEnvFile(accountId, token), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }

  rotateAccount(accountId: string): AccountCreateResult {
    const account = this.getAccount(accountId);
    if (!account) fail("NOT_FOUND", `account "${accountId}" not found`);
    if (account.disabled === 2) fail("CONFLICT", `account "${accountId}" is a tombstone`);
    const token = randomToken();
    const now = this.clock();
    run(
      this.db,
      "UPDATE accounts SET token_hash = ?, token_rotated_at = ? WHERE id = ?",
      sha256Hex(token),
      now,
      accountId,
    );
    const envPath = this.writeAccountEnv(accountId, token);
    const updated = this.getAccount(accountId)!;
    return { account: updated, token, envPath };
  }

  rotateAllAccounts(): number {
    const accounts = this.listAccounts();
    let count = 0;
    for (const account of accounts) {
      if (account.disabled === 2) continue;
      this.rotateAccount(account.id);
      count += 1;
    }
    return count;
  }

  removeAccount(accountId: string): void {
    const account = this.getAccount(accountId);
    if (!account) fail("NOT_FOUND", `account "${accountId}" not found`);
    if (account.role !== "agent") {
      fail("FORBIDDEN", "owner/manager are固定身份 and cannot be removed");
    }
    if (account.disabled === 2) fail("CONFLICT", `account "${accountId}" is already a tombstone`);
    const tx = this.db.transaction(() => {
      run(
        this.db,
        "UPDATE accounts SET disabled = 2, token_hash = NULL WHERE id = ?",
        accountId,
      );
      run(this.db, "DELETE FROM cursors WHERE account_id = ?", accountId);
      run(this.db, "DELETE FROM participants WHERE account_id = ?", accountId);
      run(this.db, "DELETE FROM post_reads WHERE account_id = ?", accountId);
    });
    tx();
    this.notifyChange();
  }

  accountEnvPath(accountId: string): string {
    return join(this.dataDir, "accounts", `${accountId}.env`);
  }

  // ── follows (home-tab routing only; never visibility) ────────────────────────
  /**
   * Seed the default edge `owner → manager` (design §5.0). Runs only when the
   * follows table is still empty and both fixed accounts exist, so re-running it
   * on an existing database is safe and idempotent.
   */
  ensureDefaultFollows(now = this.clock()): boolean {
    const existing = get<{ c: number }>(this.db, "SELECT COUNT(*) AS c FROM follows");
    if ((existing?.c ?? 0) > 0) return false;
    const pair = get<{ c: number }>(
      this.db,
      "SELECT COUNT(*) AS c FROM accounts WHERE id IN ('owner', 'manager') AND disabled != 2",
    );
    if ((pair?.c ?? 0) !== 2) return false;
    run(
      this.db,
      "INSERT OR IGNORE INTO follows(follower_id, followee_id, created_at) VALUES ('owner', 'manager', ?)",
      now,
    );
    return true;
  }

  follow(followerId: string, followeeId: string): Follow {
    this.requireActiveAccount(followerId);
    const followee = this.getAccount(followeeId);
    if (!followee || followee.disabled === 2) {
      fail("NOT_FOUND", `account "${followeeId}" not found`);
    }
    if (followee.disabled !== 0) fail("FORBIDDEN", `account "${followeeId}" is disabled`);
    if (followerId === followeeId) fail("BAD_REQUEST", "cannot follow yourself");
    const now = this.clock();
    run(
      this.db,
      "INSERT OR IGNORE INTO follows(follower_id, followee_id, created_at) VALUES (?, ?, ?)",
      followerId,
      followeeId,
      now,
    );
    const row = get<FollowRow>(
      this.db,
      "SELECT * FROM follows WHERE follower_id = ? AND followee_id = ?",
      followerId,
      followeeId,
    );
    if (!row) fail("INTERNAL", "follow edge did not persist");
    return row;
  }

  unfollow(followerId: string, followeeId: string): boolean {
    this.requireActiveAccount(followerId);
    const res = run(
      this.db,
      "DELETE FROM follows WHERE follower_id = ? AND followee_id = ?",
      followerId,
      followeeId,
    );
    return res.changes > 0;
  }

  isFollowing(followerId: string, followeeId: string): boolean {
    const row = get<{ one: number }>(
      this.db,
      "SELECT 1 AS one FROM follows WHERE follower_id = ? AND followee_id = ?",
      followerId,
      followeeId,
    );
    return row !== null;
  }

  listFollowing(accountId: string): Array<{ account: Account; followed_at: number }> {
    const rows = all<AccountRow & { followed_at: number }>(
      this.db,
      `SELECT a.*, f.created_at AS followed_at
       FROM follows f JOIN accounts a ON a.id = f.followee_id
       WHERE f.follower_id = ? AND a.disabled != 2
       ORDER BY f.created_at ASC, a.id ASC`,
      accountId,
    );
    return rows.map((row) => ({ account: toAccount(row), followed_at: row.followed_at }));
  }

  followerCount(accountId: string): number {
    return (
      get<{ c: number }>(
        this.db,
        `SELECT COUNT(*) AS c FROM follows f JOIN accounts a ON a.id = f.follower_id
         WHERE f.followee_id = ? AND a.disabled != 2`,
        accountId,
      )?.c ?? 0
    );
  }

  followingCount(accountId: string): number {
    return (
      get<{ c: number }>(
        this.db,
        `SELECT COUNT(*) AS c FROM follows f JOIN accounts a ON a.id = f.followee_id
         WHERE f.follower_id = ? AND a.disabled != 2`,
        accountId,
      )?.c ?? 0
    );
  }

  // ── cursors ─────────────────────────────────────────────────────────────────
  maxEventSeq(): number {
    const row = get<{ seq: number | null }>(this.db, "SELECT MAX(seq) AS seq FROM events");
    return row?.seq ?? 0;
  }

  getCursor(accountId: string): number {
    const row = get<{ seq: number }>(this.db, "SELECT seq FROM cursors WHERE account_id = ?", accountId);
    return row?.seq ?? 0;
  }

  advanceCursor(accountId: string, target: number): number {
    if (!Number.isInteger(target) || target < 0) {
      fail("BAD_REQUEST", "cursor target must be a non-negative integer");
    }
    const now = this.clock();
    run(
      this.db,
      `INSERT INTO cursors(account_id, seq, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE
         SET seq = max(cursors.seq, excluded.seq), updated_at = excluded.updated_at`,
      accountId,
      target,
      now,
    );
    return this.getCursor(accountId);
  }

  // ── per-post reads（report-server-read-state）──────────────────────────────
  /**
   * 只读导出兼容：只读打开的旧 v5 库没有 `post_reads` 表（export 不跑
   * migrate）。探测一次并缓存，缺失时读路径降级为 `read=false` / 纯游标。
   */
  readTablesAvailable(): boolean {
    if (this.readTableCache !== null) return this.readTableCache;
    const row = get<{ name: string }>(
      this.db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'post_reads'",
    );
    this.readTableCache = row !== null;
    return this.readTableCache;
  }

  /**
   * 单帖幂等写已读：`read_at` 记首次时刻（`DO NOTHING`），重复写返回既有时间。
   * 未知帖与对该账号不可见的帖统一 404（不泄露存在性）；软删帖允许写（对未读
   * 与高亮无效果，见 design §2.2/§11）。
   */
  markPostRead(accountId: string, postId: string): { created: boolean; read_at: number } {
    this.requireActiveAccount(accountId);
    if (!this.readTablesAvailable()) {
      fail("UNAVAILABLE", "post_reads table is missing (read-only legacy database)");
    }
    const post = get<{ id: string; root_id: string }>(
      this.db,
      "SELECT id, root_id FROM posts WHERE id = ?",
      postId,
    );
    if (!post || !this.canViewRoot(accountId, post.root_id)) {
      fail("NOT_FOUND", `post "${postId}" not found or not visible`);
    }
    const now = this.clock();
    const inserted = run(
      this.db,
      `INSERT INTO post_reads(account_id, post_id, read_at) VALUES (?, ?, ?)
       ON CONFLICT(account_id, post_id) DO NOTHING`,
      accountId,
      postId,
      now,
    );
    const stored = get<{ read_at: number }>(
      this.db,
      "SELECT read_at FROM post_reads WHERE account_id = ? AND post_id = ?",
      accountId,
      postId,
    );
    if (!stored) fail("INTERNAL", "post_reads row did not persist");
    return { created: inserted.changes > 0, read_at: stored.read_at };
  }

  /**
   * 批量幂等写已读（单事务）。未知/不可见 id 静默跳过并回报在 `skipped`
   * （离线队列可能含已删帖，不能因一条坏 id 卡死整队）；`read_at` 为本次
   * 事务统一时刻（便于客户端对账）。`stored` 为可见 id 数（去重后），因此
   * `stored + skipped.length === 去重后输入数`。
   */
  markPostReads(
    accountId: string,
    postIds: readonly string[],
  ): { stored: number; skipped: string[]; read_at: number } {
    const account = this.requireActiveAccount(accountId);
    if (!this.readTablesAvailable()) {
      fail("UNAVAILABLE", "post_reads table is missing (read-only legacy database)");
    }
    const unique = [...new Set(postIds)];
    const now = this.clock();
    const tx = this.db.transaction((): { stored: number; skipped: string[]; read_at: number } => {
      const rootById = new Map<string, string>();
      for (const group of chunks(unique)) {
        const rows = all<{ id: string; root_id: string }>(
          this.db,
          `SELECT id, root_id FROM posts WHERE id IN (${placeholders(group.length)})`,
          ...group,
        );
        for (const row of rows) rootById.set(row.id, row.root_id);
      }

      const allowed = new Set<string>();
      if (isGlobalRole(account.role)) {
        for (const id of rootById.keys()) allowed.add(id);
      } else {
        const roots = [...new Set(rootById.values())];
        const visibleRoots = new Set<string>();
        for (const group of chunks(roots)) {
          const rows = all<{ root_id: string }>(
            this.db,
            `SELECT root_id FROM participants
             WHERE account_id = ? AND root_id IN (${placeholders(group.length)})`,
            accountId,
            ...group,
          );
          for (const row of rows) visibleRoots.add(row.root_id);
        }
        for (const [id, rootId] of rootById) {
          if (visibleRoots.has(rootId)) allowed.add(id);
        }
      }

      if (allowed.size > 0) {
        const insert = this.db.query(
          `INSERT INTO post_reads(account_id, post_id, read_at) VALUES (?, ?, ?)
           ON CONFLICT(account_id, post_id) DO NOTHING`,
        );
        for (const id of allowed) insert.run(accountId, id, now);
      }

      return {
        stored: allowed.size,
        skipped: unique.filter((id) => !allowed.has(id)),
        read_at: now,
      };
    });
    return tx();
  }

  /**
   * 该账号已存在的逐帖读行（`Map<post_id, read_at>`）；id 按 400 分组查询，
   * 不逐帖查询。未知/不可见 id 静默省略（读行本身即该账号的私有历史）。
   */
  readStatesFor(accountId: string, postIds: readonly string[]): Map<string, number> {
    this.requireActiveAccount(accountId);
    const out = new Map<string, number>();
    if (!this.readTablesAvailable()) return out;
    const unique = [...new Set(postIds)];
    for (const group of chunks(unique)) {
      const rows = all<{ post_id: string; read_at: number }>(
        this.db,
        `SELECT post_id, read_at FROM post_reads
         WHERE account_id = ? AND post_id IN (${placeholders(group.length)})`,
        accountId,
        ...group,
      );
      for (const row of rows) out.set(row.post_id, row.read_at);
    }
    return out;
  }

  // ── drafts ──────────────────────────────────────────────────────────────────
  createDraft(author: string): Draft {
    this.requireActiveAccount(author);
    const existing = get<DraftRow>(
      this.db,
      "SELECT * FROM drafts WHERE author = ? AND status = 'open'",
      author,
    );
    if (existing) {
      fail(
        "CONFLICT",
        `author ${author} already has an open draft ${existing.id} (resume it or discard it)`,
      );
    }
    const now = this.clock();
    const id = newUlid(now);
    run(
      this.db,
      "INSERT INTO drafts(id, author, created_at, updated_at, items_json, status) VALUES (?, ?, ?, ?, '[]', 'open')",
      id,
      author,
      now,
      now,
    );
    return this.getDraft(id)!;
  }

  getDraft(id: string): Draft | null {
    return get<DraftRow>(this.db, "SELECT * FROM drafts WHERE id = ?", id);
  }

  requireDraft(id: string, author: string): Draft {
    const draft = this.getDraft(id);
    if (!draft) fail("NOT_FOUND", `draft "${id}" not found`);
    if (draft.author !== author) fail("FORBIDDEN", "drafts are author-only");
    return draft;
  }

  listDrafts(author: string, includeTerminal = false): Draft[] {
    return all<DraftRow>(
      this.db,
      includeTerminal
        ? "SELECT * FROM drafts WHERE author = ? ORDER BY updated_at DESC"
        : "SELECT * FROM drafts WHERE author = ? AND status = 'open' ORDER BY updated_at DESC",
      author,
    );
  }

  appendDraftItem(draftId: string, author: string, op: WriteOp): { draft: Draft; items: number } {
    const draft = this.requireDraft(draftId, author);
    if (draft.status !== "open") fail("CONFLICT", `draft is ${draft.status}`);
    const items = parseDraftItems(draft.items_json);
    assertCanAppend(items.length);
    items.push(op);
    const now = this.clock();
    const payload = serializeDraftItems(items);
    // synchronous=FULL: the WAL commit fsyncs before append resolves (design §6).
    run(
      this.db,
      "UPDATE drafts SET items_json = ?, updated_at = ? WHERE id = ? AND status = 'open'",
      payload,
      now,
      draftId,
    );
    return { draft: this.getDraft(draftId)!, items: items.length };
  }

  discardDraft(draftId: string, author: string): void {
    const draft = this.requireDraft(draftId, author);
    if (draft.status !== "open") fail("CONFLICT", `draft is ${draft.status}`);
    run(
      this.db,
      "UPDATE drafts SET status = 'discarded', updated_at = ? WHERE id = ?",
      this.clock(),
      draftId,
    );
  }

  draftSummaries(): DraftSummary[] {
    const rows = all<{ id: string; author: string; items_json: string; updated_at: number }>(
      this.db,
      "SELECT id, author, items_json, updated_at FROM drafts WHERE status = 'open' ORDER BY updated_at ASC",
    );
    return rows.map((row) => ({
      id: row.id,
      author: row.author,
      items: parseDraftItems(row.items_json).length,
      updated_at: row.updated_at,
    }));
  }

  commitDraft(draftId: string, author: string): CommitResult {
    const draft = this.requireDraft(draftId, author);
    if (draft.status === "committed") {
      return this.commitOps({ author, batchId: draft.id, ops: [], draftId });
    }
    if (draft.status !== "open") fail("CONFLICT", `draft is ${draft.status}`);
    const items = parseDraftItems(draft.items_json);
    if (items.length === 0) fail("BAD_REQUEST", "draft has no items");
    return this.commitOps({ author, batchId: draft.id, ops: items, draftId });
  }

  // ── write transactions ──────────────────────────────────────────────────────
  commitOps(opts: {
    author: string;
    batchId: string;
    ops: WriteOp[];
    draftId?: string;
  }): CommitResult {
    this.requireActiveAccount(opts.author);
    this.previewBudgetLimited = { account_budget: 0, global_budget: 0 };
    const now = this.clock();
    const tx = this.db.transaction((): CommitResult => {
      const existing = get<BatchRow>(
        this.db,
        "SELECT * FROM batches WHERE id = ?",
        opts.batchId,
      );
      if (existing) {
        if (existing.author !== opts.author) {
          fail("CONFLICT", "batch belongs to a different author");
        }
        if (existing.status === "committed") {
          if (opts.draftId) {
            run(
              this.db,
              "UPDATE drafts SET status = 'committed' WHERE id = ? AND status = 'open'",
              opts.draftId,
            );
          }
          return this.reconstructBatch(opts.batchId, opts.author, true);
        }
        if (existing.status !== "open") {
          fail("CONFLICT", `batch is ${existing.status}`);
        }
      } else {
        run(
          this.db,
          "INSERT INTO batches(id, author, started_at, committed_at, status) VALUES (?, ?, ?, NULL, 'open')",
          opts.batchId,
          opts.author,
          now,
        );
      }

      if (opts.ops.length === 0) fail("BAD_REQUEST", "batch has no operations");
      if (opts.ops.length > MAX_BATCH_ITEMS) {
        fail("BAD_REQUEST", `too many operations in one batch (max ${MAX_BATCH_ITEMS})`);
      }

      const created: PostRow[] = [];
      const batchOrder: string[] = [];
      const batchRefs = new Map<string, string>();
      const resolveBatchRef = (spec: string): string => {
        if (spec === "$prev") {
          const id = batchOrder[batchOrder.length - 1];
          if (!id) fail("BAD_REQUEST", "$prev has no earlier post in this batch");
          return id;
        }
        if (spec === "$root") {
          const id = batchOrder[0];
          if (!id) fail("BAD_REQUEST", "$root has no earlier post in this batch");
          return id;
        }
        if (spec.startsWith("$ref:")) {
          const id = batchRefs.get(spec.slice(5));
          if (!id) fail("BAD_REQUEST", `unknown batch ref "${spec}" in this batch`);
          return id;
        }
        return spec;
      };
      for (const rawOp of opts.ops) {
        const op = rawOp;
        if (op.op === "post") {
          const body = assertBody(op.body);
          const tags = normalizeTags(op.tags);
          const id = newUlid(now);
          let quoted: PostRow | null = null;
          if (op.quote) {
            quoted = this.postRow(resolveBatchRef(op.quote));
            if (!quoted || quoted.deleted_at) fail("NOT_FOUND", "quoted post not found");
            if (!this.canViewRoot(opts.author, quoted.root_id)) {
              fail("NOT_FOUND", "quoted post not found");
            }
          }
          run(
            this.db,
            `INSERT INTO posts(id, author, body_md, parent_id, root_id, self_thread_id,
               self_thread_is_leaf, reply_to_account_id, quoted_post_id, tags, created_at, seq, batch_id, deleted_at)
             VALUES (?, ?, ?, NULL, ?, ?, 1, NULL, ?, ?, ?, 0, ?, NULL)`,
            id,
            opts.author,
            body,
            id,
            id,
            op.quote ?? null,
            JSON.stringify(tags),
            now,
            opts.batchId,
          );
          const post = this.postRow(id)!;
          this.applyMedia(post.id, op.media ?? []);
          const seq = this.insertEvent("post.created", opts.author, post.id, post.root_id, opts.batchId, now, {
            parent_id: null,
            root_id: post.root_id,
            self_thread_id: post.self_thread_id,
            quoted_post_id: post.quoted_post_id,
          });
          run(this.db, "UPDATE posts SET seq = ? WHERE id = ?", seq, post.id);
          post.seq = seq;
          created.push(post);

          this.indexPreviewLinks(post, now);
          this.addParticipant(post.root_id, opts.author, "author", now);
          this.processMentions(post, opts.author, now);
          if (quoted) this.mergeQuotedParticipants(post, quoted, opts.author, now);
          batchOrder.push(post.id);
          if (op.ref) {
            if (batchRefs.has(op.ref)) fail("BAD_REQUEST", `duplicate batch ref "${op.ref}"`);
            batchRefs.set(op.ref, post.id);
          }
        } else if (op.op === "reply") {
          const body = assertBody(op.body);
          const tags = normalizeTags(op.tags);
          const parentId = resolveBatchRef(op.parent);
          const parent = this.postRow(parentId);
          if (!parent) fail("BAD_REQUEST", `parent post "${parentId}" not found`);
          if (parent.deleted_at) fail("BAD_REQUEST", "cannot reply to a deleted post");
          if (!this.canViewRoot(opts.author, parent.root_id)) {
            fail("NOT_FOUND", `parent post "${parentId}" not found`);
          }
          const sameAuthor = parent.author === opts.author;
          const id = newUlid(now);
          const selfThreadId = sameAuthor ? parent.self_thread_id : id;
          const replyTo = sameAuthor ? parent.reply_to_account_id : parent.author;
          run(
            this.db,
            `INSERT INTO posts(id, author, body_md, parent_id, root_id, self_thread_id,
               self_thread_is_leaf, reply_to_account_id, quoted_post_id, tags, created_at, seq, batch_id, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, 0, ?, NULL)`,
            id,
            opts.author,
            body,
            parent.id,
            parent.root_id,
            selfThreadId,
            replyTo,
            JSON.stringify(tags),
            now,
            opts.batchId,
          );
          if (sameAuthor) {
            run(this.db, "UPDATE posts SET self_thread_is_leaf = 0 WHERE id = ?", parent.id);
          }
          const post = this.postRow(id)!;
          this.applyMedia(post.id, op.media ?? []);
          const seq = this.insertEvent("post.created", opts.author, post.id, post.root_id, opts.batchId, now, {
            parent_id: parent.id,
            root_id: post.root_id,
            self_thread_id: post.self_thread_id,
            reply_to_account_id: post.reply_to_account_id,
          });
          run(this.db, "UPDATE posts SET seq = ? WHERE id = ?", seq, post.id);
          post.seq = seq;
          created.push(post);
          this.indexPreviewLinks(post, now);
          this.addParticipant(post.root_id, opts.author, "reply", now);
          this.processMentions(post, opts.author, now);
          batchOrder.push(post.id);
        } else {
          fail("BAD_REQUEST", "unknown operation");
        }
      }

      run(
        this.db,
        "UPDATE batches SET committed_at = ?, status = 'committed' WHERE id = ?",
        now,
        opts.batchId,
      );
      if (opts.draftId) {
        run(
          this.db,
          "UPDATE drafts SET status = 'committed', updated_at = ? WHERE id = ? AND status = 'open'",
          now,
          opts.draftId,
        );
      }
      return {
        batch_id: opts.batchId,
        // re-read: earlier rows may have been updated in this transaction (is_leaf)
        posts: this.hydratePosts(
          created.map((p) => this.postRow(p.id)!),
          { id: opts.author, role: this.roleOf(opts.author) },
        ),
        idempotent: false,
      };
    });

    const result = tx();
    const limited = this.previewBudgetLimited;
    if (limited.account_budget + limited.global_budget > 0) {
      console.warn(
        `[report] preview enqueue limited for batch ${opts.batchId}: ` +
          `account_budget=${limited.account_budget} global_budget=${limited.global_budget}`,
      );
    }
    if (!result.idempotent) this.notifyChange();
    return result;
  }

  private reconstructBatch(batchId: string, author: string, idempotent: boolean): CommitResult {
    const rows = all<PostRow>(
      this.db,
      "SELECT * FROM posts WHERE batch_id = ? ORDER BY seq ASC",
      batchId,
    );
    return {
      batch_id: batchId,
      posts: this.hydratePosts(rows, { id: author, role: this.roleOf(author) }),
      idempotent,
    };
  }

  private roleOf(accountId: string): Role {
    return this.getAccount(accountId)?.role ?? "agent";
  }

  private insertEvent(
    type: string,
    actor: string,
    postId: string | null,
    rootId: string | null,
    batchId: string,
    createdAt: number,
    payload: unknown,
  ): number {
    const res = run(
      this.db,
      `INSERT INTO events(type, actor, post_id, root_id, batch_id, created_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      type,
      actor,
      postId,
      rootId,
      batchId,
      createdAt,
      JSON.stringify(payload ?? {}),
    );
    return res.lastInsertRowid;
  }

  private addParticipant(
    rootId: string,
    accountId: string,
    source: "author" | "mention" | "reply" | "quote",
    now: number,
  ): boolean {
    const res = run(
      this.db,
      "INSERT OR IGNORE INTO participants(root_id, account_id, source, added_at) VALUES (?, ?, ?, ?)",
      rootId,
      accountId,
      source,
      now,
    );
    return res.changes > 0;
  }

  private processMentions(post: PostRow, author: string, now: number): void {
    const ids = extractMentions(post.body_md);
    for (const id of ids) {
      const account = this.getAccount(id);
      if (!account || account.disabled !== 0) continue;
      run(
        this.db,
        "INSERT OR IGNORE INTO mentions(post_id, account_id, created_at) VALUES (?, ?, ?)",
        post.id,
        id,
        now,
      );
      const added = this.addParticipant(post.root_id, id, "mention", now);
      if (added && id !== author) {
        this.insertEvent("thread.invited", author, post.id, post.root_id, post.batch_id, now, {
          post_id: post.id,
          snapshot_seq: post.seq,
          account_id: id,
        });
      }
    }
  }

  private mergeQuotedParticipants(
    post: PostRow,
    quoted: PostRow,
    author: string,
    now: number,
  ): void {
    const rows = all<{ account_id: string }>(
      this.db,
      `SELECT p.account_id FROM participants p
       JOIN accounts a ON a.id = p.account_id
       WHERE p.root_id = ? AND a.disabled = 0`,
      quoted.root_id,
    );
    for (const row of rows) {
      if (row.account_id === author) continue;
      const added = this.addParticipant(post.root_id, row.account_id, "quote", now);
      if (added) {
        this.insertEvent("thread.invited", author, post.id, post.root_id, post.batch_id, now, {
          post_id: post.id,
          snapshot_seq: post.seq,
          account_id: row.account_id,
          via: "quote",
        });
      }
    }
  }

  private applyMedia(postId: string, hashes: string[]): void {
    if (hashes.length > MAX_ATTACHMENTS) fail("BAD_REQUEST", "too many attachments");
    hashes.forEach((hash, index) => {
      const media = get<MediaRowDb>(this.db, "SELECT * FROM media WHERE hash = ?", hash);
      if (!media) fail("BAD_REQUEST", `media ${hash} is not uploaded`);
      const inserted = run(
        this.db,
        "INSERT OR IGNORE INTO post_media(post_id, hash, position) VALUES (?, ?, ?)",
        postId,
        hash,
        index,
      );
      if (inserted.changes > 0) {
        run(this.db, "UPDATE media SET ref_count = ref_count + 1 WHERE hash = ?", hash);
      }
    });
  }

  private postRow(id: string): PostRow | null {
    return get<PostRow>(this.db, "SELECT * FROM posts WHERE id = ?", id);
  }

  canViewRoot(accountId: string, rootId: string): boolean {
    const account = this.getAccount(accountId);
    if (!account || account.disabled !== 0) return false;
    if (isGlobalRole(account.role)) return true;
    const row = get<{ one: number }>(
      this.db,
      "SELECT 1 AS one FROM participants WHERE root_id = ? AND account_id = ?",
      rootId,
      accountId,
    );
    return row !== null;
  }

  // ── views / hydration ───────────────────────────────────────────────────────
  private hydratePosts(posts: PostRow[], viewer: Viewer): PostView[] {
    if (posts.length === 0) return [];
    const accountIds = new Set<string>();
    for (const post of posts) accountIds.add(post.author);
    const postIds = posts.map((p) => p.id);
    const quotedIds = posts
      .map((p) => p.quoted_post_id)
      .filter((id): id is string => Boolean(id));

    const accounts = new Map<string, AccountRow>();
    for (const group of chunks([...accountIds])) {
      const rows = all<AccountRow>(
        this.db,
        `SELECT * FROM accounts WHERE id IN (${placeholders(group.length)})`,
        ...group,
      );
      for (const row of rows) accounts.set(row.id, row);
    }

    const accountsForQuoted = new Set<string>();
    const quotedRows = new Map<string, PostRow>();
    for (const group of chunks(quotedIds)) {
      const rows = all<PostRow>(
        this.db,
        `SELECT * FROM posts WHERE id IN (${placeholders(group.length)})`,
        ...group,
      );
      for (const row of rows) {
        quotedRows.set(row.id, row);
        accountsForQuoted.add(row.author);
      }
    }
    for (const group of chunks([...accountsForQuoted])) {
      const rows = all<AccountRow>(
        this.db,
        `SELECT * FROM accounts WHERE id IN (${placeholders(group.length)})`,
        ...group,
      );
      for (const row of rows) accounts.set(row.id, row);
    }

    const mediaByPost = new Map<string, MediaRef[]>();
    const mediaIds = [...new Set([...postIds, ...quotedIds])];
    for (const group of chunks(mediaIds)) {
      const rows = all<{
        post_id: string;
        hash: string;
        ext: string;
        bytes: number;
        w: number | null;
        h: number | null;
        position: number;
      }>(
        this.db,
        `SELECT pm.post_id, pm.position, m.hash, m.ext, m.bytes, m.w, m.h
         FROM post_media pm JOIN media m ON m.hash = pm.hash
         WHERE pm.post_id IN (${placeholders(group.length)})
         ORDER BY pm.position ASC`,
        ...group,
      );
      for (const row of rows) {
        const list = mediaByPost.get(row.post_id) ?? [];
        list.push(
          mediaRef({
            hash: row.hash,
            ext: row.ext,
            bytes: row.bytes,
            w: row.w,
            h: row.h,
            created_at: 0,
            ref_count: 0,
          }),
        );
        mediaByPost.set(row.post_id, list);
      }
    }

    const replyCounts = new Map<string, number>();
    for (const group of chunks(postIds)) {
      const rows = all<{ parent_id: string; c: number }>(
        this.db,
        `SELECT parent_id, COUNT(*) AS c FROM posts
         WHERE parent_id IN (${placeholders(group.length)}) AND deleted_at IS NULL
         GROUP BY parent_id`,
        ...group,
      );
      for (const row of rows) replyCounts.set(row.parent_id, row.c);
    }

    const quotedVisible = new Map<string, boolean>();
    if (!isGlobalRole(viewer.role) && quotedRows.size > 0) {
      const roots = [...new Set([...quotedRows.values()].map((p) => p.root_id))];
      for (const group of chunks(roots)) {
        const rows = all<{ root_id: string }>(
          this.db,
          `SELECT root_id FROM participants WHERE account_id = ? AND root_id IN (${placeholders(
            group.length,
          )})`,
          viewer.id,
          ...group,
        );
        for (const row of rows) quotedVisible.set(row.root_id, true);
      }
    }

    // 持久化预览字段：一次批量读（每页 ≤20 帖 × 3）。旧 v4 只读库没有表 → []。
    const previewsByPost = new Map<string, PreviewLink[]>();
    if (this.previewTablesAvailable()) {
      try {
        for (const group of chunks(postIds)) {
          const rows = all<PreviewRow>(
            this.db,
            `SELECT * FROM post_previews WHERE post_id IN (${placeholders(group.length)})
             ORDER BY post_id ASC, position ASC`,
            ...group,
          );
          for (const row of rows) {
            const list = previewsByPost.get(row.post_id) ?? [];
            list.push(previewRowToLink(row));
            previewsByPost.set(row.post_id, list);
          }
        }
      } catch {
        // 只读导出遇到未迁移旧库：视为无预览字段，不阻断整页读取。
        previewsByPost.clear();
      }
    }

    // 按帖已读（v6）：1 条查询/400 id 组，页内无 N+1（design §10）。
    const readStates = this.hydrateReadStates(viewer, posts);

    return posts.map((row) => {
      const post = toPost(row);
      const deleted = post.deleted_at !== null;
      const visibleQuoted = post.quoted_post_id
        ? quotedRows.get(post.quoted_post_id) ?? null
        : null;
      let quoted: QuotedView | null = null;
      let quotedIsVisible = false;
      if (visibleQuoted && !visibleQuoted.deleted_at) {
        const canSee =
          isGlobalRole(viewer.role) || quotedVisible.get(visibleQuoted.root_id) === true;
        if (canSee) {
          quotedIsVisible = true;
          const quotedAuthor = accounts.get(visibleQuoted.author) ?? null;
          quoted = {
            id: visibleQuoted.id,
            author: visibleQuoted.author,
            display: quotedAuthor?.display ?? visibleQuoted.author,
            body_md: visibleQuoted.body_md,
            created_at: visibleQuoted.created_at,
            media: mediaByPost.get(visibleQuoted.id) ?? [],
            quoted_post_id: visibleQuoted.quoted_post_id,
          };
        }
      }
      const readState = readStates.get(post.id) ?? { read: false, read_at: null };
      return {
        ...post,
        body_md: deleted ? "" : post.body_md,
        author_account: authorView(accounts.get(post.author) ?? null),
        media: deleted ? [] : mediaByPost.get(post.id) ?? [],
        reply_count: replyCounts.get(post.id) ?? 0,
        quoted: deleted ? null : quoted,
        quoted_visible: deleted ? false : quotedIsVisible,
        previews: deleted ? [] : previewsByPost.get(post.id) ?? [],
        read: readState.read,
        read_at: readState.read_at,
      };
    });
  }

  /**
   * 按帖已读投影（`read`/`read_at`），供 `hydratePosts` 批量填充。
   *
   * - 一次查询/400 id 组：`posts p LEFT JOIN post_reads r LEFT JOIN cursors c`
   *   同时拿到逐帖读行与账号游标，页内无 N+1，也不额外多一条游标查询；
   * - `read = read_at IS NOT NULL OR seq <= cursor`；仅游标覆盖的帖子
   *   `read_at=null`（design §2.1）；
   * - 旧 v5 只读库缺 `post_reads` 表 → 纯游标降级 + `read_at=null`，不抛错。
   */
  private hydrateReadStates(
    viewer: Viewer,
    posts: PostRow[],
  ): Map<string, { read: boolean; read_at: number | null }> {
    const states = new Map<string, { read: boolean; read_at: number | null }>();
    if (posts.length === 0) return states;
    if (!this.readTablesAvailable()) {
      const cursor = this.getCursor(viewer.id);
      for (const post of posts) {
        states.set(post.id, { read: post.seq <= cursor, read_at: null });
      }
      return states;
    }
    for (const group of chunks(posts.map((post) => post.id))) {
      const rows = all<{ id: string; read_at: number | null; covered: number }>(
        this.db,
        `SELECT p.id AS id, r.read_at AS read_at,
                (p.seq <= COALESCE(c.seq, 0)) AS covered
         FROM posts p
         LEFT JOIN post_reads r ON r.account_id = ? AND r.post_id = p.id
         LEFT JOIN cursors c ON c.account_id = ?
         WHERE p.id IN (${placeholders(group.length)})`,
        viewer.id,
        viewer.id,
        ...group,
      );
      for (const row of rows) {
        states.set(row.id, {
          read: row.read_at !== null || row.covered === 1,
          read_at: row.read_at,
        });
      }
    }
    return states;
  }

  getPostView(postId: string, viewer: Viewer): PostView | null {
    const row = this.postRow(postId);
    if (!row) return null;
    if (!this.canViewRoot(viewer.id, row.root_id)) return null;
    return this.hydratePosts([row], viewer)[0] ?? null;
  }

  // ── 预览插件 / 持久化预览字段（report-link-preview）─────────────────────────
  private previewTablesAvailable(): boolean {
    if (this.previewTableCache !== null) return this.previewTableCache;
    const row = get<{ name: string }>(
      this.db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'post_previews'",
    );
    this.previewTableCache = row !== null;
    return this.previewTableCache;
  }

  /** 只读导出兼容：旧 v4 库没有预览表时按 `previews=[]`/`preview_enabled=false`。 */
  hasPreviewTable(): boolean {
    return this.previewTablesAvailable();
  }

  /** meta 键 `plugins.<id>.enabled`；缺省取 manifest.defaultEnabled。 */
  pluginEnabled(pluginId: string): boolean {
    const manifest = builtinPlugin(pluginId);
    if (!manifest) return false;
    const raw = getMeta(this.db, `plugins.${pluginId}.enabled`);
    if (raw === null) return manifest.defaultEnabled;
    return raw === "1";
  }

  setPluginEnabled(pluginId: string, enabled: boolean, actor: string): void {
    const manifest = builtinPlugin(pluginId);
    if (!manifest) fail("NOT_FOUND", `plugin "${pluginId}" not found`);
    const now = this.clock();
    setMeta(this.db, `plugins.${pluginId}.enabled`, enabled ? "1" : "0");
    setMeta(this.db, `plugins.${pluginId}.updated_at`, String(now));
    setMeta(this.db, `plugins.${pluginId}.updated_by`, actor);
    this.notifyChange();
  }

  /** 写入事务内：抽 URL + pending 行 + job（无网络）。失败不阻断帖子提交。 */
  private indexPreviewLinks(post: PostRow, now: number): void {
    if (!this.pluginEnabled(LINK_PREVIEW.id)) return;
    if (!this.previewTablesAvailable()) return;
    try {
      indexPostPreviewLinks(this.db, {
        post,
        now,
        onBudgetLimited: (reason) => {
          if (reason === "account_budget") this.previewBudgetLimited.account_budget += 1;
          else if (reason === "global_budget") this.previewBudgetLimited.global_budget += 1;
        },
      });
    } catch (err) {
      // 预览不能成为发帖失败原因：只记日志（不含正文/URL）。
      console.error(`[report] preview index failed for post ${post.id}: ${(err as Error).message}`);
    }
  }

  /** 该帖最新持久化预览数组（worker 写事件前回读用）。 */
  previewsForPost(postId: string): PreviewLink[] {
    if (!this.previewTablesAvailable()) return [];
    return previewRowsForPost(this.db, postId).map(previewRowToLink);
  }

  /** worker 需要的帖子最小投影（不存在/已删除时由调用方删除 job）。 */
  previewPost(postId: string): Post | null {
    const row = this.postRow(postId);
    return row ? toPost(row) : null;
  }

  /** claim job 时先把新 cacheKey 写到字段行（不动旧字段/旧 status）。 */
  adoptPreviewCacheKey(postId: string, urlHash: string, cacheKey: string): number {
    if (!this.previewTablesAvailable()) return 0;
    return adoptJobCacheKey(this.db, postId, urlHash, cacheKey, this.clock());
  }

  /**
   * 多阶段唯一写入口：单事务更新 `post_previews` + 插 `post.updated` 事件。
   * 只覆盖本次提供的字段；`fields_ready` 取并集；返回该帖最新数组。
   */
  applyPreviewPhase(input: {
    postId: string;
    urlHash: string;
    cacheKey: string;
    phase: PreviewPhase;
    fields: PhaseFields;
    fieldsReady?: readonly string[];
    status: PreviewStatus;
    errorCode?: PreviewErrorCode | null;
    attempts?: number;
  }): PreviewLink[] | null {
    const post = this.postRow(input.postId);
    if (!post || post.deleted_at !== null) return null;
    if (!this.previewTablesAvailable()) return null;
    let result: PreviewLink[] | null = null;
    const tx = this.db.transaction(() => {
      const row = previewRow(this.db, input.postId, input.urlHash);
      if (!row) return;
      // 只在 job 的 cacheKey 仍是当前值（未被扫描重排）时写入。
      if (row.cache_key !== input.cacheKey) return;
      const now = this.clock();
      const ready = new Set(parseFieldsReady(row.fields_ready));
      for (const field of input.fieldsReady ?? []) ready.add(field);
      const fields = input.fields;
      if (fields.kind !== undefined) ready.add("kind");
      if (fields.mime !== undefined) ready.add("mime");
      if (fields.title !== undefined) ready.add("title");
      if (fields.description !== undefined) ready.add("description");
      if (fields.site_name !== undefined) ready.add("site_name");
      if (fields.cover !== undefined) ready.add("cover");

      const assignments: string[] = [];
      const params: Bindings = [];
      const set = (column: string, value: string | number | null): void => {
        assignments.push(`${column} = ?`);
        params.push(value);
      };
      set("phase", input.phase);
      set("status", input.status);
      set("fields_ready", JSON.stringify([...ready]));
      set("updated_at", now);
      set("error_code", input.errorCode ?? null);
      if (input.attempts !== undefined) set("attempts", input.attempts);
      if (fields.kind !== undefined) set("kind", fields.kind);
      if (fields.mime !== undefined) set("mime", fields.mime ?? null);
      if (fields.final_url !== undefined) set("final_url", fields.final_url ?? null);
      if (fields.title !== undefined) set("title", fields.title ?? null);
      if (fields.description !== undefined) set("description", fields.description ?? null);
      if (fields.site_name !== undefined) set("site_name", fields.site_name ?? null);
      if (fields.cover !== undefined) {
        set("cover_url", fields.cover?.url ?? null);
        set("cover_w", fields.cover?.w ?? null);
        set("cover_h", fields.cover?.h ?? null);
        set("cover_kind", fields.cover?.kind ?? null);
      }
      run(
        this.db,
        `UPDATE post_previews SET ${assignments.join(", ")}
         WHERE post_id = ? AND url_hash = ?`,
        ...params,
        input.postId,
        input.urlHash,
      );
      const previews = previewRowsForPost(this.db, input.postId).map(previewRowToLink);
      result = previews;
      this.insertEvent(
        "post.updated",
        post.author,
        post.id,
        post.root_id,
        post.batch_id,
        now,
        {
          post_id: post.id,
          root_id: post.root_id,
          phase: input.phase,
          status: input.status,
          previews,
        },
      );
    });
    tx();
    if (result !== null) this.notifyChange();
    return result;
  }

  // ── queries ─────────────────────────────────────────────────────────────────
  timeline(opts: {
    viewer: Viewer;
    limit?: number;
    before?: string | null;
    after?: string | null;
    tag?: string | null;
  }): TimelinePage {
    const limit = opts.limit ?? 20;
    const vis = visibleRootsClause(opts.viewer.role, opts.viewer.id);
    const keyset = keysetClause({ before: opts.before, after: opts.after });
    const direction: PageDirection = keyset.direction;
    const orderSql =
      direction === "desc" ? "ORDER BY created_at DESC, id DESC" : "ORDER BY created_at ASC, id ASC";
    const tag = normalizeTagFilter(opts.tag);
    const tagSql = tag ? "AND tags LIKE ? ESCAPE '\\'" : "";
    const tagParams: Bindings = tag ? [`%"${tag}"%`] : [];
    const rows = all<PostRow>(
      this.db,
      `SELECT * FROM posts
       WHERE parent_id IS NULL AND deleted_at IS NULL AND ${vis.sql} AND ${keyset.sql} ${tagSql}
       ${orderSql} LIMIT ?`,
      ...(vis.params as Bindings),
      ...(keyset.params as Bindings),
      ...tagParams,
      limit + 1,
    );
    const page = finalizePage(rows, limit);
    return {
      posts: this.hydratePosts(page.items, opts.viewer),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      order: direction,
      as_of_seq: this.maxEventSeq(),
    };
  }

  /**
   * Home feed (design §5.0). Both tabs share the root-post + visibility + keyset
   * semantics but are separate queries: a cursor from one tab is never reused for
   * the other (each call carries its own `before`), so switching tabs restarts
   * from that tab's head.
   *
   *  - recommended: roots tagged `result`, roots that mention `owner`, or roots authored
   *    by the viewer themselves (Owner 2026-11-07：本人帖应当出现在自己的推荐流里);
   *  - following: roots authored by accounts the viewer follows.
   *
   * Visibility is applied with the same clause as every other read path:
   * following never widens what a viewer may see.
   */
  feed(opts: {
    viewer: Viewer;
    tab: FeedTab;
    limit?: number;
    before?: string | null;
    after?: string | null;
  }): FeedPage {
    const limit = Math.min(opts.limit ?? 20, 100);
    const vis = visibleRootsClause(opts.viewer.role, opts.viewer.id);
    const keyset = keysetClause({ before: opts.before, after: opts.after });
    const direction: PageDirection = keyset.direction;
    const orderSql =
      direction === "desc" ? "ORDER BY created_at DESC, id DESC" : "ORDER BY created_at ASC, id ASC";
    const clauses = ["parent_id IS NULL", "deleted_at IS NULL", vis.sql, keyset.sql];
    const params: Bindings = [...(vis.params as Bindings), ...(keyset.params as Bindings)];
    if (opts.tab === "recommended") {
      // tags are stored as JSON text by our own writer (validated charset, no
      // quotes), so the quoted-substring match is exact for our data.
      clauses.push(
        `(tags LIKE ? ESCAPE '\\' OR id IN (SELECT post_id FROM mentions WHERE account_id = 'owner') OR author = ?)`,
      );
      params.push('%"result"%', opts.viewer.id);
    } else {
      clauses.push("author IN (SELECT followee_id FROM follows WHERE follower_id = ?)");
      params.push(opts.viewer.id);
    }
    const rows = all<PostRow>(
      this.db,
      `SELECT * FROM posts WHERE ${clauses.join(" AND ")} ${orderSql} LIMIT ?`,
      ...params,
      limit + 1,
    );
    const page = finalizePage(rows, limit);
    return {
      tab: opts.tab,
      posts: this.hydratePosts(page.items, opts.viewer),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      order: direction,
      as_of_seq: this.maxEventSeq(),
    };
  }

  /** Member page (design §5.0): account card + that member's visible root posts. */
  profile(opts: {
    viewer: Viewer;
    accountId: string;
    limit?: number;
    before?: string | null;
    after?: string | null;
  }): ProfilePage | null {
    const account = this.getAccount(opts.accountId);
    if (!account) return null;
    const limit = Math.min(opts.limit ?? 20, 100);
    const vis = visibleRootsClause(opts.viewer.role, opts.viewer.id);
    const keyset = keysetClause({ before: opts.before, after: opts.after });
    const direction: PageDirection = keyset.direction;
    const orderSql =
      direction === "desc" ? "ORDER BY created_at DESC, id DESC" : "ORDER BY created_at ASC, id ASC";
    const rows = all<PostRow>(
      this.db,
      `SELECT * FROM posts
       WHERE parent_id IS NULL AND deleted_at IS NULL AND author = ? AND ${vis.sql} AND ${keyset.sql}
       ${orderSql} LIMIT ?`,
      opts.accountId,
      ...(vis.params as Bindings),
      ...(keyset.params as Bindings),
      limit + 1,
    );
    const page = finalizePage(rows, limit);
    return {
      account: {
        id: account.id,
        display: account.display,
        profile: account.profile,
        avatar: account.avatar,
        role: account.role,
        disabled: account.disabled,
        created_at: account.created_at,
        following: this.isFollowing(opts.viewer.id, account.id),
        follower_count: this.followerCount(account.id),
        following_count: this.followingCount(account.id),
      },
      posts: this.hydratePosts(page.items, opts.viewer),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      order: direction,
      as_of_seq: this.maxEventSeq(),
    };
  }

  /**
   * Trending tags (report-ux-r2 §5): aggregate `tags` over the viewer's visible,
   * non-deleted **root** posts. Root-only by design — replies live inside their
   * root's conversation, so a root rollup cannot surface a tag from a thread the
   * caller may not see.
   *
   * `score = count × exp(-age_days / 7)` with `age_days` measured from the tag's
   * most recent use. Ties fall back to count, then recency, then tag name so the
   * order is deterministic across runs.
   */
  trendingTags(opts: { viewer: Viewer; limit?: number; now?: number }): TrendingTag[] {
    const limit = Math.min(opts.limit ?? 12, 50);
    if (limit <= 0) return [];
    const now = opts.now ?? this.clock();
    const vis = visibleRootsClause(opts.viewer.role, opts.viewer.id);
    const rows = all<{ tags: string; created_at: number }>(
      this.db,
      `SELECT tags, created_at FROM posts
       WHERE parent_id IS NULL AND deleted_at IS NULL AND ${vis.sql}`,
      ...(vis.params as Bindings),
    );
    const aggregate = new Map<string, { count: number; last_used_at: number }>();
    for (const row of rows) {
      // one use per root post even if a legacy row repeats a tag
      for (const tag of new Set(parseTagsJson(row.tags))) {
        const existing = aggregate.get(tag);
        if (existing) {
          existing.count += 1;
          if (row.created_at > existing.last_used_at) existing.last_used_at = row.created_at;
        } else {
          aggregate.set(tag, { count: 1, last_used_at: row.created_at });
        }
      }
    }
    const ranked: TrendingTag[] = [...aggregate.entries()].map(([tag, agg]) => {
      const ageDays = Math.max(0, now - agg.last_used_at) / 86_400_000;
      return {
        tag,
        count: agg.count,
        last_used_at: agg.last_used_at,
        score: agg.count * Math.exp(-ageDays / 7),
      };
    });
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        b.count - a.count ||
        b.last_used_at - a.last_used_at ||
        a.tag.localeCompare(b.tag),
    );
    return ranked.slice(0, limit);
  }

  /**
   * Suggested members (report-ux-r2 §5): everyone the viewer could follow except
   * themselves, ordered by follower count desc, then most recent post desc.
   * `last_post_at` only considers posts inside the viewer's visibility slice, so
   * the column cannot advertise activity in a hidden thread.
   */
  suggestedAccounts(opts: { viewer: Viewer; limit?: number }): SuggestedAccount[] {
    const limit = Math.min(opts.limit ?? 6, 50);
    if (limit <= 0) return [];
    const candidates = this.listAccounts(false).filter(
      (account) => account.id !== opts.viewer.id && account.disabled === 0,
    );
    if (candidates.length === 0) return [];

    const vis = visibleRootsClause(opts.viewer.role, opts.viewer.id);
    const lastPosts = all<{ author: string; last_post_at: number }>(
      this.db,
      `SELECT author, MAX(created_at) AS last_post_at FROM posts
       WHERE deleted_at IS NULL AND ${vis.sql}
       GROUP BY author`,
      ...(vis.params as Bindings),
    );
    const lastPostBy = new Map(lastPosts.map((row) => [row.author, row.last_post_at]));

    const followerRows = all<{ followee_id: string; c: number }>(
      this.db,
      `SELECT f.followee_id, COUNT(*) AS c
       FROM follows f JOIN accounts a ON a.id = f.follower_id
       WHERE a.disabled != 2
       GROUP BY f.followee_id`,
    );
    const followerBy = new Map(followerRows.map((row) => [row.followee_id, row.c]));

    const followed = new Set(
      this.listFollowing(opts.viewer.id).map(({ account }) => account.id),
    );

    const ranked: SuggestedAccount[] = candidates.map((account) => ({
      id: account.id,
      display: account.display,
      profile: account.profile,
      avatar: account.avatar,
      role: account.role,
      followers: followerBy.get(account.id) ?? 0,
      last_post_at: lastPostBy.get(account.id) ?? null,
      following: followed.has(account.id),
    }));
    ranked.sort(
      (a, b) =>
        b.followers - a.followers ||
        (b.last_post_at ?? 0) - (a.last_post_at ?? 0) ||
        a.id.localeCompare(b.id),
    );
    return ranked.slice(0, limit);
  }

  thread(opts: { viewer: Viewer; postId: string; focalId?: string | null }): ThreadView | null {
    const focal = this.postRow(opts.postId);
    if (!focal) return null;
    if (!this.canViewRoot(opts.viewer.id, focal.root_id)) return null;
    const rows = all<PostRow>(
      this.db,
      "SELECT * FROM posts WHERE root_id = ? ORDER BY created_at ASC, id ASC",
      focal.root_id,
    );
    if (rows.length === 0) return null;
    const assembled = assembleThread(
      rows.map((row) => ({ ...row, deleted: row.deleted_at !== null })),
      { focalId: opts.focalId ?? focal.id },
    );
    const hydrated = new Map(
      this.hydratePosts(rows, opts.viewer).map((post) => [post.id, post]),
    );
    const nodes: ThreadNode[] = [];
    for (const node of assembled.nodes) {
      const post = hydrated.get(node.id);
      if (!post) continue;
      const view: ThreadNode = {
        ...post,
        depth: node.depth,
        is_spine: node.is_spine,
        is_self_continuation: node.is_self_continuation,
        child_count: node.child_count,
      };
      if (node.i !== undefined && node.n !== undefined) {
        view.i = node.i;
        view.n = node.n;
      }
      nodes.push(view);
    }
    const participants = all<{ account_id: string }>(
      this.db,
      "SELECT account_id FROM participants WHERE root_id = ? ORDER BY added_at ASC",
      focal.root_id,
    ).map((row) => row.account_id);
    return {
      root_id: focal.root_id,
      focal_id: opts.focalId ?? focal.id,
      spine_complete: assembled.spine_complete,
      posts: nodes,
      collapsed: assembled.collapsed,
      participants,
      as_of_seq: Math.max(...rows.map((row) => row.seq), 0),
    };
  }

  search(opts: { viewer: Viewer; q: string; limit?: number }): PostView[] {
    const q = opts.q.trim();
    if (!q) fail("BAD_REQUEST", "search query must not be empty");
    const limit = Math.min(opts.limit ?? 30, 100);
    const vis = visibleRootsClause(opts.viewer.role, opts.viewer.id);
    const escaped = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const rows = all<PostRow>(
      this.db,
      `SELECT * FROM posts
       WHERE deleted_at IS NULL AND (body_md LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
         AND ${vis.sql}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      `%${escaped}%`,
      `%${escaped}%`,
      ...(vis.params as Bindings),
      limit,
    );
    return this.hydratePosts(rows, opts.viewer);
  }

  /** Account search (member pages / `search --accounts`); tombstones excluded. */
  searchAccounts(opts: { q: string; limit?: number }): Account[] {
    const q = opts.q.trim();
    if (!q) fail("BAD_REQUEST", "search query must not be empty");
    const limit = Math.min(opts.limit ?? 20, 100);
    const escaped = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const pattern = `%${escaped}%`;
    const rows = all<AccountRow>(
      this.db,
      `SELECT * FROM accounts
       WHERE disabled != 2
         AND (id LIKE ? ESCAPE '\\' OR display LIKE ? ESCAPE '\\' OR profile LIKE ? ESCAPE '\\')
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at ASC, id ASC
       LIMIT ?`,
      pattern,
      pattern,
      pattern,
      q,
      limit,
    );
    return rows.map(toAccount);
  }

  readPosts(opts: {
    viewer: Viewer;
    author?: string | null;
    tag?: string | null;
    since?: number | null;
    until?: number | null;
    limit?: number;
    order?: PageDirection;
    after?: string | null;
  }): { posts: PostView[]; has_more: boolean; next_cursor: string | null; order: PageDirection } {
    const limit = Math.min(opts.limit ?? 50, 200);
    const vis = visibleRootsClause(opts.viewer.role, opts.viewer.id);
    const clauses: string[] = ["deleted_at IS NULL", vis.sql];
    const params: Bindings = [...(vis.params as Bindings)];
    if (opts.author) {
      clauses.push("author = ?");
      params.push(opts.author);
    }
    const tag = normalizeTagFilter(opts.tag);
    if (tag) {
      clauses.push("tags LIKE ? ESCAPE '\\'");
      params.push(`%"${tag}"%`);
    }
    if (opts.since !== null && opts.since !== undefined) {
      clauses.push("created_at >= ?");
      params.push(opts.since);
    }
    if (opts.until !== null && opts.until !== undefined) {
      clauses.push("created_at <= ?");
      params.push(opts.until);
    }
    let direction: PageDirection = opts.order ?? "desc";
    if (opts.after) {
      const keyset = keysetClause({ after: opts.after });
      clauses.push(keyset.sql);
      params.push(...(keyset.params as Bindings));
      direction = "asc";
    }
    const orderSql =
      direction === "desc" ? "ORDER BY created_at DESC, id DESC" : "ORDER BY created_at ASC, id ASC";
    const rows = all<PostRow>(
      this.db,
      `SELECT * FROM posts WHERE ${clauses.join(" AND ")} ${orderSql} LIMIT ?`,
      ...params,
      limit + 1,
    );
    const page = finalizePage(rows, limit);
    return {
      posts: this.hydratePosts(page.items, opts.viewer),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      order: direction,
    };
  }

  softDelete(postId: string, viewer: Viewer): void {
    const post = this.postRow(postId);
    if (!post) fail("NOT_FOUND", `post "${postId}" not found`);
    if (!this.canViewRoot(viewer.id, post.root_id)) fail("NOT_FOUND", `post "${postId}" not found`);
    if (post.author !== viewer.id && !isGlobalRole(viewer.role)) {
      fail("FORBIDDEN", "only the author or owner/manager can delete a post");
    }
    if (post.deleted_at !== null) return;
    const now = this.clock();
    // The tombstone and its `post.deleted` event commit together: an event hub
    // subscriber can never observe one without the other. The payload carries
    // ids only (no tags/author) — clients match deletion by the ids they
    // currently render, never by actor/tags.
    const tx = this.db.transaction(() => {
      run(this.db, "UPDATE posts SET deleted_at = ? WHERE id = ?", now, postId);
      if (this.previewTablesAvailable()) {
        run(this.db, "DELETE FROM post_previews WHERE post_id = ?", postId);
        run(this.db, "DELETE FROM preview_jobs WHERE post_id = ?", postId);
      }
      this.insertEvent("post.deleted", viewer.id, post.id, post.root_id, post.batch_id, now, {
        post_id: post.id,
        root_id: post.root_id,
        parent_id: post.parent_id,
      });
    });
    tx();
    this.notifyChange();
  }

  // ── bookmarks（收藏；按账号私有，读路径仍受可见性约束）─────────────────────

  bookmark(accountId: string, postId: string): { created: boolean; created_at: number } {
    const viewer: Viewer = { id: accountId, role: this.accountRole(accountId) };
    const vis = visibleRootsClause(viewer.role, viewer.id);
    const row = get<{ id: string }>(
      this.db,
      `SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL AND ${vis.sql}`,
      postId,
      ...(vis.params as Bindings),
    );
    if (!row) fail("NOT_FOUND", `post "${postId}" not found or not visible`);
    const existing = get<{ created_at: number }>(
      this.db,
      "SELECT created_at FROM bookmarks WHERE account_id = ? AND post_id = ?",
      accountId,
      postId,
    );
    if (existing) return { created: false, created_at: existing.created_at };
    const now = this.clock();
    run(
      this.db,
      "INSERT INTO bookmarks(account_id, post_id, created_at) VALUES (?, ?, ?)",
      accountId,
      postId,
      now,
    );
    return { created: true, created_at: now };
  }

  unbookmark(accountId: string, postId: string): boolean {
    const res = run(
      this.db,
      "DELETE FROM bookmarks WHERE account_id = ? AND post_id = ?",
      accountId,
      postId,
    );
    return res.changes > 0;
  }

  bookmarkedIds(accountId: string): string[] {
    return all<{ post_id: string }>(
      this.db,
      "SELECT post_id FROM bookmarks WHERE account_id = ? ORDER BY created_at DESC, post_id DESC",
      accountId,
    ).map((row) => row.post_id);
  }

  /** 收藏列表：被该账号收藏且仍可见的帖子（根帖与回复都算），按帖子时间倒序。 */
  bookmarks(opts: {
    viewer: Viewer;
    limit?: number;
    before?: string | null;
    after?: string | null;
  }): TimelinePage {
    const limit = Math.min(opts.limit ?? 20, 100);
    const vis = visibleRootsClause(opts.viewer.role, opts.viewer.id);
    const keyset = keysetClause({ before: opts.before, after: opts.after });
    const direction: PageDirection = keyset.direction;
    const orderSql =
      direction === "desc" ? "ORDER BY created_at DESC, id DESC" : "ORDER BY created_at ASC, id ASC";
    const rows = all<PostRow>(
      this.db,
      `SELECT * FROM posts
       WHERE deleted_at IS NULL AND ${vis.sql}
         AND EXISTS (SELECT 1 FROM bookmarks b
                     WHERE b.post_id = posts.id AND b.account_id = ?)
         AND ${keyset.sql}
       ${orderSql} LIMIT ?`,
      ...(vis.params as Bindings),
      opts.viewer.id,
      ...(keyset.params as Bindings),
      limit + 1,
    );
    const page = finalizePage(rows, limit);
    return {
      posts: this.hydratePosts(page.items, opts.viewer),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      order: direction,
      as_of_seq: this.maxEventSeq(),
    };
  }

  private accountRole(accountId: string): Role {
    const row = get<{ role: Role }>(this.db, "SELECT role FROM accounts WHERE id = ?", accountId);
    if (!row) fail("NOT_FOUND", `account "${accountId}" not found`);
    return row.role;
  }

  // ── viewer-scoped events / notifications ────────────────────────────────────

  /**
   * Viewer-scoped event slice: `since < seq <= MAX(seq)` at snapshot time.
   *
   * - `visibleRootsClause(..., "e")` is the only visibility source (an aliased
   *   fragment is mandatory here: `events e LEFT JOIN posts p` has `root_id` on
   *   both sides, and the unqualified form raises `ambiguous column name`).
   * - The `MAX(seq)` ceiling is read first inside the transaction so a write
   *   landing mid-read cannot leak into this slice: new events have a larger
   *   seq and arrive in the next call (no gaps, no duplicates).
   * - `truncated` is the *only* overflow signal (visible rows are a sparse
   *   subset of seq; `as_of_seq - since` must never be used to infer overflow).
   * - `LEFT JOIN posts` yields the read-time `post_deleted` projection.
   */
  eventLines(opts: {
    viewer: Viewer;
    since: number;
    limit?: number;
    includeSelf?: boolean;
    types?: readonly string[] | null;
  }): EventLinesPage {
    const since = opts.since;
    if (!Number.isInteger(since) || since < 0) {
      fail("BAD_REQUEST", "since must be a non-negative integer seq");
    }
    // -1 is SQLite's "no limit"; `truncated` stays false in that mode.
    const limit = opts.limit ?? -1;
    if (limit !== -1 && (!Number.isInteger(limit) || limit < 1)) {
      fail("BAD_REQUEST", "limit must be a positive integer");
    }
    const vis = visibleRootsClause(opts.viewer.role, opts.viewer.id, "e");
    const tx = this.db.transaction((): EventLinesPage => {
      const asOfSeq = this.maxEventSeq();
      const clauses = ["e.seq > ?", "e.seq <= ?"];
      const params: Bindings = [since, asOfSeq];
      if (opts.includeSelf === false) {
        clauses.push("e.actor != ?");
        params.push(opts.viewer.id);
      }
      if (opts.types) {
        if (opts.types.length === 0) {
          clauses.push("1=0");
        } else {
          clauses.push(`e.type IN (${placeholders(opts.types.length)})`);
          params.push(...([...opts.types] as Bindings));
        }
      }
      clauses.push(vis.sql);
      params.push(...(vis.params as Bindings));
      // Ask for one extra row so `truncated` is observable without a second query.
      const sqlLimit = limit === -1 ? -1 : limit + 1;
      const rows = all<EventRow>(
        this.db,
        `SELECT e.seq, e.type, e.actor, e.post_id, e.root_id, e.batch_id, e.created_at,
                e.payload_json, (p.deleted_at IS NOT NULL) AS post_deleted
         FROM events e
         LEFT JOIN posts p ON p.id = e.post_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY e.seq ASC
         LIMIT ?`,
        ...params,
        sqlLimit,
      );
      const truncated = limit !== -1 && rows.length > limit;
      const page = truncated ? rows.slice(0, limit) : rows;
      return {
        lines: page.map(toEventLine),
        as_of_seq: asOfSeq,
        truncated,
      };
    });
    return tx();
  }

  /**
   * Unread notifications for the account cursor: visible + not self + only
   * `NOTIFICATION_TYPES` + live post. Shares the exact predicate with
   * `unreadByTarget` and `eventLines` (same alias, same join).
   */
  private unreadClause(accountId: string, cursor: number): { where: string; params: Bindings } {
    const account = this.requireActiveAccount(accountId);
    const vis = visibleRootsClause(account.role, accountId, "e");
    const clauses = [
      "e.seq > ?",
      "e.actor != ?",
      `e.type IN (${placeholders(NOTIFICATION_TYPES.length)})`,
      "p.deleted_at IS NULL",
    ];
    const params: Bindings = [
      cursor,
      accountId,
      ...([...NOTIFICATION_TYPES] as Bindings),
    ];
    // v6：逐帖已读的 target 整体不计未读。`e.post_id IS NULL` 的事件退化为
    // 纯游标（`pr.post_id = NULL` 不匹配 ⇒ NOT EXISTS 为真），不会误扣 root。
    if (this.readTablesAvailable()) {
      clauses.push(
        "NOT EXISTS (SELECT 1 FROM post_reads pr WHERE pr.account_id = ? AND pr.post_id = e.post_id)",
      );
      params.push(accountId);
    }
    clauses.push(vis.sql);
    params.push(...(vis.params as Bindings));
    return { where: clauses.join(" AND "), params };
  }

  unreadCount(accountId: string, cursorOverride?: number | null): number {
    const cursor = cursorOverride ?? this.getCursor(accountId);
    const { where, params } = this.unreadClause(accountId, cursor);
    return (
      get<{ c: number }>(
        this.db,
        `SELECT COUNT(*) AS c FROM events e LEFT JOIN posts p ON p.id = e.post_id
         WHERE ${where}`,
        ...params,
      )?.c ?? 0
    );
  }

  /** Unread events grouped by `COALESCE(post_id, root_id)` (read-set 精确扣减用). */
  unreadByTarget(accountId: string, cursorOverride?: number | null): Record<string, number> {
    const cursor = cursorOverride ?? this.getCursor(accountId);
    const { where, params } = this.unreadClause(accountId, cursor);
    const rows = all<{ target: string | null; c: number }>(
      this.db,
      `SELECT COALESCE(e.post_id, e.root_id) AS target, COUNT(*) AS c
       FROM events e LEFT JOIN posts p ON p.id = e.post_id
       WHERE ${where}
       GROUP BY target`,
      ...params,
    );
    const out: Record<string, number> = {};
    for (const row of rows) {
      if (row.target === null) continue;
      out[row.target] = row.c;
    }
    return out;
  }

  /**
   * Delivery lines (events + inline thread snapshots), in order.
   *
   * Delegates to `eventLines` so visibility/aliasing/`post.deleted` exclusion
   * live in exactly one SQL. Keeps the legacy contract: REST/CLI exclude the
   * account's own events by default and only `NOTIFICATION_TYPES` are delivered
   * (`post.deleted` and any future system event never show up as a reminder).
   */
  notificationLines(
    accountId: string,
    cursorOverride?: number | null,
    opts: { includeSelf?: boolean; limit?: number } = {},
  ): {
    lines: NotificationLine[];
    target: number | null;
    cursor: number;
    role: Role;
    truncated: boolean;
    as_of_seq: number;
  } {
    const account = this.requireActiveAccount(accountId);
    const cursor = cursorOverride ?? this.getCursor(accountId);
    const page = this.eventLines({
      viewer: { id: accountId, role: account.role },
      since: cursor,
      limit: opts.limit,
      // REST/CLI default excludes the account's own events; the legacy SSE
      // stream passes `includeSelf: true` explicitly.
      includeSelf: opts.includeSelf === true,
      types: NOTIFICATION_TYPES,
    });
    const lines: NotificationLine[] = [];
    let target: number | null = null;
    for (const event of page.lines) {
      lines.push(event);
      if (target === null || event.seq > target) target = event.seq;
      if (event.type === "thread.invited" && event.root_id) {
        const thread = this.thread({
          viewer: { id: accountId, role: account.role },
          postId: event.post_id ?? event.root_id,
          focalId: event.post_id,
        });
        if (thread) {
          lines.push({
            type: "thread.snapshot",
            of_seq: event.seq,
            root_id: event.root_id,
            thread,
          });
        }
      }
    }
    return {
      lines,
      target,
      cursor,
      role: account.role,
      truncated: page.truncated,
      as_of_seq: page.as_of_seq,
    };
  }

  /**
   * 通知历史（「始终可见列表」的服务端分页）：该账号可见的事件，按 seq 倒序，
   * `read` = `post_reads` 命中该帖 **或** 事件 seq ≤ 该账号游标。与
   * `notificationLines` 同口径：REST 排除本人事件、可见性走 `visibleRootsClause`。
   * 纯读接口：不推进游标、不改 schema——游标推进仍只由「全部已读」的 ack 承担。
   */
  notificationHistory(
    accountId: string,
    opts: { limit?: number; before?: number | null } = {},
  ): NotificationHistoryPage {
    const account = this.requireActiveAccount(accountId);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const cursor = this.getCursor(accountId);
    const vis = visibleRootsClause(account.role, accountId);
    const before = opts.before ?? null;
    // 只读「通知类」事件：event-hub 的 post.deleted 等非通知事件不混进历史列表。
    const clauses = [
      `type IN (${NOTIFICATION_TYPES.map(() => "?").join(",")})`,
      "actor != ?",
      vis.sql,
    ];
    const params: Bindings = [...NOTIFICATION_TYPES, accountId, ...(vis.params as Bindings)];
    if (before !== null) {
      if (!Number.isInteger(before) || before < 0) {
        fail("BAD_REQUEST", "before must be a non-negative integer seq");
      }
      clauses.push("seq < ?");
      params.push(before);
    }
    const rows = all<EventRow>(
      this.db,
      `SELECT * FROM events
       WHERE ${clauses.join(" AND ")}
       ORDER BY seq DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    // 逐帖已读（v6）：整页一次批量查询（≤100 id），不逐行查询。
    const readPostIds = new Set<string>();
    if (this.readTablesAvailable()) {
      const ids = [
        ...new Set(
          page
            .map((event) => event.post_id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      ];
      for (const group of chunks(ids)) {
        const reads = all<{ post_id: string }>(
          this.db,
          `SELECT post_id FROM post_reads
           WHERE account_id = ? AND post_id IN (${placeholders(group.length)})`,
          accountId,
          ...group,
        );
        for (const row of reads) readPostIds.add(row.post_id);
      }
    }
    const events = page.map((event) => {
      let payload: unknown = {};
      try {
        payload = JSON.parse(event.payload_json);
      } catch {
        payload = {};
      }
      return {
        seq: event.seq,
        type: event.type as NotificationEventLine["type"],
        actor: event.actor,
        post_id: event.post_id,
        root_id: event.root_id,
        batch_id: event.batch_id,
        created_at: event.created_at,
        payload,
        read:
          event.seq <= cursor ||
          (event.post_id !== null && readPostIds.has(event.post_id)),
      };
    });
    const hasMore = rows.length > limit;
    return {
      events,
      cursor,
      has_more: hasMore,
      next_before: hasMore && page.length > 0 ? page[page.length - 1]!.seq : null,
    };
  }

  // ── media ───────────────────────────────────────────────────────────────────
  saveMedia(bytes: Uint8Array, ext: string): MediaRow {
    if (!ALLOWED_EXTS.has(ext)) fail("UNSUPPORTED_MEDIA_TYPE", `unsupported media extension ${ext}`);
    if (bytes.byteLength === 0) fail("BAD_REQUEST", "empty upload");
    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      fail("PAYLOAD_TOO_LARGE", `media exceeds ${MAX_MEDIA_BYTES} bytes`);
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const size = readMediaSize(bytes, ext);
    const existing = get<MediaRowDb>(this.db, "SELECT * FROM media WHERE hash = ?", hash);
    if (existing) {
      if (size && (existing.w === null || existing.h === null)) {
        run(this.db, "UPDATE media SET w = ?, h = ? WHERE hash = ?", size.w, size.h, hash);
        return get<MediaRowDb>(this.db, "SELECT * FROM media WHERE hash = ?", hash)!;
      }
      return existing;
    }
    const dir = join(this.dataDir, "media");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${hash}.${ext}`);
    writeFileSync(path, bytes, { mode: 0o600 });
    try {
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // fsync unsupported on this fs: the write itself already succeeded
    }
    const now = this.clock();
    run(
      this.db,
      "INSERT OR IGNORE INTO media(hash, ext, bytes, created_at, ref_count, w, h) VALUES (?, ?, ?, ?, 0, ?, ?)",
      hash,
      ext,
      bytes.byteLength,
      now,
      size?.w ?? null,
      size?.h ?? null,
    );
    return get<MediaRowDb>(this.db, "SELECT * FROM media WHERE hash = ?", hash)!;
  }

  /** 历史媒体补尺寸：只处理缺 w/h 的行（每个文件一次），写回 DB 供前端预留占位。 */
  backfillMediaSizes(): number {
    const rows = all<{ hash: string; ext: string }>(
      this.db,
      "SELECT hash, ext FROM media WHERE w IS NULL OR h IS NULL",
    );
    let updated = 0;
    for (const row of rows) {
      try {
        const bytes = readFileSync(this.mediaPath(row.hash, row.ext));
        const size = readMediaSize(new Uint8Array(bytes), row.ext);
        if (!size) continue;
        run(this.db, "UPDATE media SET w = ?, h = ? WHERE hash = ?", size.w, size.h, row.hash);
        updated += 1;
      } catch {
        // 文件缺失/不可解析：保持 null，前端按旧行为渲染
      }
    }
    return updated;
  }

  getMedia(hash: string): MediaRow | null {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    return get<MediaRowDb>(this.db, "SELECT * FROM media WHERE hash = ?", hash);
  }

  mediaPath(hash: string, ext: string): string {
    return join(this.dataDir, "media", `${hash}.${ext}`);
  }

  // ── status / export data ────────────────────────────────────────────────────
  statusCounts(): {
    accounts: number;
    posts: number;
    roots: number;
    events: number;
    open_drafts: number;
    media_files: number;
    max_seq: number;
  } {
    const count = (sql: string) => get<{ c: number }>(this.db, sql)?.c ?? 0;
    return {
      accounts: count("SELECT COUNT(*) AS c FROM accounts WHERE disabled != 2"),
      posts: count("SELECT COUNT(*) AS c FROM posts"),
      roots: count("SELECT COUNT(*) AS c FROM posts WHERE parent_id IS NULL"),
      events: count("SELECT COUNT(*) AS c FROM events"),
      open_drafts: count("SELECT COUNT(*) AS c FROM drafts WHERE status = 'open'"),
      media_files: count("SELECT COUNT(*) AS c FROM media"),
      max_seq: this.maxEventSeq(),
    };
  }

  rootIds(): string[] {
    return all<{ root_id: string }>(
      this.db,
      "SELECT DISTINCT root_id FROM posts WHERE parent_id IS NULL ORDER BY created_at ASC, id ASC",
    ).map((row) => row.root_id);
  }

  allPostsForExport(): PostRow[] {
    return all<PostRow>(this.db, "SELECT * FROM posts ORDER BY created_at ASC, id ASC");
  }

  /** Every post the viewer may see (roots + replies + tombstones), oldest first. */
  visiblePostsForExport(viewer: Viewer): PostView[] {
    const vis = visibleRootsClause(viewer.role, viewer.id);
    const rows = all<PostRow>(
      this.db,
      `SELECT * FROM posts WHERE ${vis.sql} ORDER BY created_at ASC, id ASC`,
      ...(vis.params as Bindings),
    );
    return this.hydratePosts(rows, viewer);
  }

  /** All follow edges (static-archive snapshot; ordering keeps output stable). */
  allFollows(): Follow[] {
    return all<FollowRow>(
      this.db,
      "SELECT * FROM follows ORDER BY follower_id ASC, followee_id ASC",
    );
  }

  /** `{ root_id: [account_id...] }` for the given visible roots. */
  participantsForRoots(rootIds: string[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const group of chunks(rootIds)) {
      const rows = all<{ root_id: string; account_id: string }>(
        this.db,
        `SELECT root_id, account_id FROM participants
         WHERE root_id IN (${placeholders(group.length)})
         ORDER BY added_at ASC`,
        ...group,
      );
      for (const row of rows) {
        const list = out[row.root_id] ?? [];
        list.push(row.account_id);
        out[row.root_id] = list;
      }
    }
    return out;
  }

  mediaForExport(): MediaRow[] {
    return all<MediaRowDb>(
      this.db,
      "SELECT * FROM media WHERE ref_count > 0 ORDER BY created_at ASC",
    );
  }

  setPendingExport(pending: boolean): void {
    setMeta(this.db, "pending-export", pending ? "1" : "0");
  }

  pendingExport(): boolean {
    return getMeta(this.db, "pending-export") === "1";
  }
}

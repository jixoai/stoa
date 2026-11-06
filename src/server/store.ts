import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
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
  FeedPage,
  FeedTab,
  Follow,
  MediaRef,
  MediaRow,
  NotificationEventLine,
  NotificationLine,
  NotificationSnapshot,
  Post,
  PostView,
  ProfilePage,
  QuotedView,
  Role,
  ThreadNode,
  ThreadSnapshotLine,
  ThreadView,
  TimelinePage,
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

function toPost(row: PostRow): Post {
  return { ...row, tags: parseTagsJson(row.tags) };
}

function mediaRef(row: MediaRowDb): MediaRef {
  return {
    hash: row.hash,
    ext: row.ext,
    bytes: row.bytes,
    url: `/api/media/${row.hash}`,
  };
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

  waitForChange(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (changed: boolean) => {
        if (done) return;
        done = true;
        this.listeners.delete(listener);
        clearTimeout(timer);
        resolve(changed);
      };
      const listener = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
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
      const rows = all<{ post_id: string; hash: string; ext: string; bytes: number; position: number }>(
        this.db,
        `SELECT pm.post_id, pm.position, m.hash, m.ext, m.bytes
         FROM post_media pm JOIN media m ON m.hash = pm.hash
         WHERE pm.post_id IN (${placeholders(group.length)})
         ORDER BY pm.position ASC`,
        ...group,
      );
      for (const row of rows) {
        const list = mediaByPost.get(row.post_id) ?? [];
        list.push(mediaRef({ hash: row.hash, ext: row.ext, bytes: row.bytes, created_at: 0, ref_count: 0 }));
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
      return {
        ...post,
        body_md: deleted ? "" : post.body_md,
        author_account: authorView(accounts.get(post.author) ?? null),
        media: deleted ? [] : mediaByPost.get(post.id) ?? [],
        reply_count: replyCounts.get(post.id) ?? 0,
        quoted: deleted ? null : quoted,
        quoted_visible: deleted ? false : quotedIsVisible,
      };
    });
  }

  getPostView(postId: string, viewer: Viewer): PostView | null {
    const row = this.postRow(postId);
    if (!row) return null;
    if (!this.canViewRoot(viewer.id, row.root_id)) return null;
    return this.hydratePosts([row], viewer)[0] ?? null;
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
   *  - recommended: roots tagged `result`, or roots that mention `owner`;
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
        `(tags LIKE ? ESCAPE '\\' OR id IN (SELECT post_id FROM mentions WHERE account_id = 'owner'))`,
      );
      params.push('%"result"%');
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
    run(this.db, "UPDATE posts SET deleted_at = ? WHERE id = ?", this.clock(), postId);
    this.notifyChange();
  }

  // ── notifications ───────────────────────────────────────────────────────────
  /** Delivery lines (events + inline thread snapshots), in order. */
  notificationLines(
    accountId: string,
    cursorOverride?: number | null,
    opts: { includeSelf?: boolean } = {},
  ): {
    lines: NotificationLine[];
    target: number | null;
    cursor: number;
    role: Role;
  } {
    const account = this.requireActiveAccount(accountId);
    const cursor = cursorOverride ?? this.getCursor(accountId);
    const vis = visibleRootsClause(account.role, accountId);
    const lines: NotificationLine[] = [];
    let target: number | null = null;
    const selfClause = opts.includeSelf ? "1=1" : "actor != ?";
    const params: Bindings = opts.includeSelf
      ? [cursor, ...(vis.params as Bindings)]
      : [cursor, accountId, ...(vis.params as Bindings)];
    this.db.exec("BEGIN");
    try {
      const events = all<EventRow>(
        this.db,
        `SELECT * FROM events
         WHERE seq > ? AND ${selfClause} AND ${vis.sql}
         ORDER BY seq ASC`,
        ...params,
      );
      for (const event of events) {
        let payload: unknown = {};
        try {
          payload = JSON.parse(event.payload_json);
        } catch {
          payload = {};
        }
        lines.push({
          seq: event.seq,
          type: event.type as NotificationEventLine["type"],
          actor: event.actor,
          post_id: event.post_id,
          root_id: event.root_id,
          batch_id: event.batch_id,
          created_at: event.created_at,
          payload,
        });
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
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { lines, target, cursor, role: account.role };
  }

  // ── media ───────────────────────────────────────────────────────────────────
  saveMedia(bytes: Uint8Array, ext: string): MediaRow {
    if (!ALLOWED_EXTS.has(ext)) fail("UNSUPPORTED_MEDIA_TYPE", `unsupported media extension ${ext}`);
    if (bytes.byteLength === 0) fail("BAD_REQUEST", "empty upload");
    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      fail("PAYLOAD_TOO_LARGE", `media exceeds ${MAX_MEDIA_BYTES} bytes`);
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const existing = get<MediaRowDb>(this.db, "SELECT * FROM media WHERE hash = ?", hash);
    if (existing) return existing;
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
      "INSERT OR IGNORE INTO media(hash, ext, bytes, created_at, ref_count) VALUES (?, ?, ?, ?, 0)",
      hash,
      ext,
      bytes.byteLength,
      now,
    );
    return get<MediaRowDb>(this.db, "SELECT * FROM media WHERE hash = ?", hash)!;
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

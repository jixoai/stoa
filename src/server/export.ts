import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fail } from "../core/errors.ts";
import { readMediaSize, type MediaSize } from "../core/media-meta.ts";
import type {
  DisabledFlag,
  MediaRef,
  PostView,
  QuotedView,
  Role,
} from "../core/types.ts";
import { openDatabase } from "./db.ts";
import { Store, type Viewer } from "./store.ts";
import { LINK_PREVIEW } from "../core/plugins/builtin.ts";

export interface ExportOptions {
  dataDir: string;
  outDir?: string | null;
  prune?: boolean;
  keep?: number | null;
  now?: number;
  /** whose visibility slice is exported (`--as`; defaults to owner) */
  viewer?: string | null;
  /** built frontend directory (defaults to <repo>/dist) */
  uiDir?: string | null;
}

export interface ExportResult {
  out_dir: string;
  as_of_seq: number;
  /** the archive is a single app shell; kept in the JSON for CLI compatibility */
  pages: number;
  threads: number;
  media: number;
  duration_ms: number;
}

// ── snapshot contract (design §5; share one shape with the static mock) ───────

export interface SnapshotMedia {
  hash: string;
  ext: string;
  bytes: number;
  url: string;
  /** 固有尺寸（旧库未回填时导出侧从文件头补算），前端据此预留占位。 */
  w?: number | null;
  h?: number | null;
}

export interface SnapshotQuoted extends Omit<QuotedView, "media"> {
  media: SnapshotMedia[];
}

export interface SnapshotPost extends Omit<PostView, "media" | "quoted"> {
  media: SnapshotMedia[];
  quoted: SnapshotQuoted | null;
  /** 导出时 viewer 的逐帖已读快照；静态壳只读展示，不写回任何服务端。 */
  read?: boolean;
  read_at?: number | null;
}

export interface SnapshotAccount {
  id: string;
  display: string;
  profile: string;
  avatar: string;
  role: Role;
  disabled: DisabledFlag;
  created_at: number;
  followers: number;
}

export interface Snapshot {
  version: 1;
  /** 导出 viewer 的收藏帖子 id（静态归档只读展示）。 */
  bookmarks: string[];
  as_of_seq: number;
  viewer: string;
  accounts: SnapshotAccount[];
  follows: Array<[string, string]>;
  posts: SnapshotPost[];
  participants: Record<string, string[]>;
  media: SnapshotMedia[];
  /** 导出时的 link-preview 开关；静态 UI 据此决定是否渲染预览区。 */
  preview_enabled: boolean;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function snapshotMedia(ref: MediaRef, size: MediaSize | null): SnapshotMedia {
  // Relative to index.html so the archive works under file:// and any host root.
  const media: SnapshotMedia = {
    hash: ref.hash,
    ext: ref.ext,
    bytes: ref.bytes,
    url: `media/${ref.hash}.${ref.ext}`,
  };
  const w = ref.w ?? size?.w;
  const h = ref.h ?? size?.h;
  if (w && h) {
    media.w = w;
    media.h = h;
  }
  return media;
}

/**
 * Build the read-only snapshot the static app consumes (design §5). It is the
 * viewer's visibility slice: the exact same PostView hydration as `/api/read`,
 * with media URLs rewritten to archive-relative paths. No tokens, secrets or
 * backend addresses are read here, so none can leak into the archive.
 */
/** 只读导出同样要能给出尺寸：DB 未回填时现场解析文件头（每进程一次缓存）。 */
const exportSizeCache = new Map<string, MediaSize | null>();
function mediaSizeFor(store: Store, ref: MediaRef): MediaSize | null {
  if (ref.w && ref.h) return { w: ref.w, h: ref.h };
  const key = `${ref.hash}.${ref.ext}`;
  if (exportSizeCache.has(key)) return exportSizeCache.get(key) ?? null;
  let size: MediaSize | null = null;
  try {
    size = readMediaSize(new Uint8Array(readFileSync(store.mediaPath(ref.hash, ref.ext))), ref.ext);
  } catch {
    size = null;
  }
  exportSizeCache.set(key, size);
  return size;
}

export function buildSnapshot(store: Store, viewerId = "owner"): Snapshot {
  const account = store.getAccount(viewerId);
  if (!account || account.disabled !== 0) {
    fail("NOT_FOUND", `export viewer "${viewerId}" not found or disabled`);
  }
  const viewer: Viewer = { id: account.id, role: account.role };
  const posts = store.visiblePostsForExport(viewer);

  const mediaByKey = new Map<string, SnapshotMedia>();
  const collectMedia = (refs: MediaRef[]): SnapshotMedia[] =>
    refs.map((ref) => {
      const media = snapshotMedia(ref, mediaSizeFor(store, ref));
      const key = `${media.hash}.${media.ext}`;
      const existing = mediaByKey.get(key);
      if (existing) return existing;
      mediaByKey.set(key, media);
      return media;
    });

  const snapshotPosts: SnapshotPost[] = posts.map((post) => ({
    ...post,
    media: collectMedia(post.media),
    quoted: post.quoted ? { ...post.quoted, media: collectMedia(post.quoted.media) } : null,
  }));

  const accounts = store.listAccounts(false).map((row) => ({
    id: row.id,
    display: row.display,
    profile: row.profile,
    avatar: row.avatar,
    role: row.role,
    disabled: row.disabled,
    created_at: row.created_at,
    followers: store.followerCount(row.id),
  }));
  const active = new Set(accounts.map((row) => row.id));
  const follows: Array<[string, string]> = store
    .allFollows()
    .filter((edge) => active.has(edge.follower_id) && active.has(edge.followee_id))
    .map((edge) => [edge.follower_id, edge.followee_id]);

  const rootIds = [...new Set(snapshotPosts.map((post) => post.root_id))].sort();

  return {
    version: 1,
    as_of_seq: store.maxEventSeq(),
    viewer: account.id,
    accounts,
    follows,
    posts: snapshotPosts,
    participants: store.participantsForRoots(rootIds),
    bookmarks: store.bookmarkedIds(viewerId),
    media: [...mediaByKey.values()].sort(
      (a, b) => a.hash.localeCompare(b.hash) || a.ext.localeCompare(b.ext),
    ),
    // 只读导出：不启动 worker/不入队/不抓取。旧 v4 库没有预览表 → false。
    preview_enabled: store.hasPreviewTable() && store.pluginEnabled(LINK_PREVIEW.id),
  };
}

/**
 * Rewrite the built shell so it survives `file://`: assets stay relative and
 * the snapshot is inlined as JSON (no fetch, no module scripts).
 */
export function injectSnapshot(html: string, snapshot: Snapshot): string {
  const relative = html.replace(/(src|href)="\/assets\//g, '$1="./assets/');
  const marker = `<script type="application/json" id="report-snapshot">${safeJson(snapshot)}</script>`;
  const close = relative.lastIndexOf("</body>");
  if (close < 0) return `${relative}\n${marker}\n`;
  return `${relative.slice(0, close)}  ${marker}\n${relative.slice(close)}`;
}

function pruneHistory(historyDir: string, keep: number): void {
  if (!existsSync(historyDir)) return;
  const entries = readdirSync(historyDir)
    .filter((name) => {
      try {
        return statSync(join(historyDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  while (entries.length > keep) {
    const victim = entries.shift();
    if (victim) rmSync(join(historyDir, victim), { recursive: true, force: true });
  }
}

function copyTree(src: string, dest: string, skipTop: string[] = []): void {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(src)) {
    if (skipTop.includes(entry)) continue;
    const from = join(src, entry);
    const to = join(dest, entry);
    const st = statSync(from);
    if (st.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

/**
 * Static export: the production frontend shell (same build the live server
 * serves) plus one inline snapshot and the referenced media. Hash routing means
 * one index.html covers the timeline, threads, members and search.
 */
export function runExport(opts: ExportOptions): ExportResult {
  const started = Date.now();
  const now = opts.now ?? started;
  const ts = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const db = openDatabase({ dataDir: opts.dataDir, readonly: true });
  try {
    const store = new Store({ dataDir: opts.dataDir, db, clock: () => now });
    const snapshot = buildSnapshot(store, opts.viewer ?? "owner");

    const uiDir = resolve(opts.uiDir ?? join(import.meta.dir, "..", "..", "dist"));
    const shellPath = join(uiDir, "index.html");
    if (!existsSync(shellPath)) {
      fail(
        "BAD_REQUEST",
        `ui build not found at ${shellPath}; run \`bun run build\` before exporting`,
      );
    }
    const html = injectSnapshot(readFileSync(shellPath, "utf8"), snapshot);

    const isDefaultOut = !opts.outDir;
    const outRoot = resolve(opts.outDir ?? join(opts.dataDir, "export"));
    const tmpRoot = join(opts.dataDir, `.export-tmp-${ts}-${process.pid}`);
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });

    // Same assets the live server serves (index.html is replaced by our shell).
    copyTree(uiDir, tmpRoot, ["index.html"]);
    writeFileSync(join(tmpRoot, "index.html"), html, { mode: 0o600 });

    mkdirSync(join(tmpRoot, "media"), { recursive: true, mode: 0o700 });
    let mediaCount = 0;
    for (const media of snapshot.media) {
      const src = store.mediaPath(media.hash, media.ext);
      if (!existsSync(src)) continue;
      copyFileSync(src, join(tmpRoot, "media", `${media.hash}.${media.ext}`));
      mediaCount += 1;
    }

    // atomic swap
    mkdirSync(outRoot, { recursive: true, mode: 0o700 });
    const historyDir = join(outRoot, "history");
    const hold = join(opts.dataDir, `.export-history-hold-${process.pid}`);
    if (existsSync(hold) && !existsSync(historyDir)) renameSync(hold, historyDir);
    if (isDefaultOut && existsSync(historyDir)) {
      renameSync(historyDir, hold);
    }
    const old = `${outRoot}.old-${process.pid}-${ts}`;
    if (existsSync(outRoot)) renameSync(outRoot, old);
    renameSync(tmpRoot, outRoot);
    if (existsSync(old)) rmSync(old, { recursive: true, force: true });
    if (isDefaultOut) {
      if (existsSync(hold)) renameSync(hold, join(outRoot, "history"));
      const histRoot = join(outRoot, "history", ts);
      copyTreeExpress(outRoot, histRoot, ["history"]);
      if (opts.prune) pruneHistory(join(outRoot, "history"), Math.max(opts.keep ?? 5, 1));
    }

    return {
      out_dir: outRoot,
      as_of_seq: snapshot.as_of_seq,
      pages: 1,
      threads: Object.keys(snapshot.participants).length,
      media: mediaCount,
      duration_ms: Date.now() - started,
    };
  } finally {
    db.close();
  }
}

function copyTreeExpress(src: string, dest: string, skip: string[]): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (skip.includes(entry)) continue;
    const from = join(src, entry);
    const to = join(dest, entry);
    const st = statSync(from);
    if (st.isDirectory()) copyTreeExpress(from, to, []);
    else {
      try {
        linkSync(from, to);
      } catch {
        copyFileSync(from, to);
      }
    }
  }
}

/** Best-effort cleanup of interrupted exports (older than 1h). */
export function cleanupStaleExports(dataDir: string, now = Date.now()): void {
  try {
    for (const entry of readdirSync(dataDir)) {
      if (!/^\.export-tmp-|^\.export-history-hold-/.test(entry)) continue;
      const path = join(dataDir, entry);
      try {
        if (now - statSync(path).mtimeMs > 3_600_000) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

/** Mark/clear the pending-export retry flag (design §14). */
export function setPendingExportFlag(dataDir: string, pending: boolean): void {
  const db = openDatabase({ dataDir, readonly: false });
  try {
    const store = new Store({ dataDir, db });
    store.setPendingExport(pending);
  } finally {
    db.close();
  }
}

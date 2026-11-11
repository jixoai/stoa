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
import type { Database } from "bun:sqlite";
import { fail } from "../core/errors.ts";
import { readMediaSize, type MediaSize } from "../core/media-meta.ts";
import { VERSION } from "../core/protocol.ts";
import type {
  DisabledFlag,
  MediaRef,
  PostView,
  QuotedView,
  Role,
} from "../core/types.ts";
import { get, getMeta, openDatabase } from "./db.ts";
import { Store, type Viewer } from "./store.ts";
import { BUILTIN_PLUGINS, LINK_PREVIEW, builtinPlugin } from "../core/plugins/builtin.ts";

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
  /**
   * @internal 测试专用 seam：在快照读取完成、rev 计数之前触发（用于构造
   * 「快照读完后实例并发写入」的同读一致性场景）。生产路径绝不传。
   */
  __testAfterSnapshot?: () => void;
}

export interface ExportResult {
  out_dir: string;
  as_of_seq: number;
  /** 数据修订（stoa-stopped-preview design §1.1）：与产物 manifest.rev 同值。 */
  rev: string;
  /** the archive is a single app shell; kept in the JSON for CLI compatibility */
  pages: number;
  threads: number;
  media: number;
  duration_ms: number;
}

/**
 * 导出产物根的修订清单（stoa-stopped-preview design §1.1）。
 *
 * 缓存单一信源：消费方只比对 `rev`（数据本体自证）与 `ui_version`，绝不以
 * mtime/ETag 等传输层信号充当判据。清单本身不含 token、密钥或后端地址。
 */
export interface ExportManifest {
  /** `dataRevision()` 的同值，形如 `<events_max_seq>:<accounts_count>`。 */
  rev: string;
  /** 快照头部事件 seq（Store.maxEventSeq）。 */
  as_of_seq: number;
  /** 导出时刻（毫秒）。 */
  exported_at: number;
  /** 可见性切片（`--as`；快照内 viewer 账号 id）。 */
  viewer: string;
  /** 导出所用前端版本（package.json version 的既有常量 VERSION）。 */
  ui_version: string;
}

/** manifest 文件名（与 index.html / assets / media 同批原子换入）。 */
export const EXPORT_MANIFEST_FILE = "manifest.json";

/**
 * 数据修订 `${seq}:${accounts}:${follows}:${bookmarks}:${pluginsOn}`
 * （stoa-stopped-preview design v2 §1.3；计数分量为 `count,rowid_total`）。
 *
 * 所有读数与快照来自同一次一致读（WAL 读事务给稳定视图）：
 *  - seq ← 本次快照的 `as_of_seq`（runExport 直接传快照值，绝不事后另查——
 *    否则 rev 领先快照会让新帖永久不进归档）；`dataRevision()` 用于缓存比对时
 *    取当前 `SELECT MAX(seq) AS seq FROM events`（与 Store.maxEventSeq 同一条 SQL，
 *    src/server/store.ts:590）。
 *  - accounts ← `COUNT(*), TOTAL(rowid) FROM accounts WHERE disabled != 2`：表名见
 *    src/server/db.ts:63，口径与 `Store.listAccounts(false)` 一致（src/server/store.ts:331，
 *    排除 disabled=2 tombstone），因此新建账号与删除身份都会推进修订。
 *  - follows / bookmarks ← 整表 `COUNT(*), TOTAL(rowid)`；pluginsOn ← 内置插件开关位
 *    （meta `plugins.<id>.enabled`，缺省取 manifest.defaultEnabled，见
 *    src/core/plugins/builtin.ts）。这几类数据不进 events 但会进快照，必须由数据本体自证。
 *  - rowid 总量是对「集合等价交换」的守卫：取关 A + 关注 B、取消收藏 A + 收藏 B
 *    这类行数不变的关系/收藏变更会拿到新 rowid，`COUNT(*)` 相同但 `TOTAL(rowid)` 必变，
 *    停止态预览因此不会命中陈旧关系/收藏（仍是一条廉价聚合查询）。
 *  - 有意排除：逐账号已读游标（每次翻页都变，纳入会造成缓存抖动；归档已读状态可能陈旧，
 *    登记为 design §5 已知边界）。
 */
export function dataRevision(dataDir: string): string {
  const db = openDatabase({ dataDir, readonly: true });
  try {
    return inReadTransaction(db, () => revisionOf(db, maxEventSeqOf(db)));
  } finally {
    db.close();
  }
}

/** 与 `Store.maxEventSeq()` 同一条 SQL（src/server/store.ts:590）。 */
function maxEventSeqOf(db: Database): number {
  return get<{ seq: number | null }>(db, "SELECT MAX(seq) AS seq FROM events")?.seq ?? 0;
}

/**
 * 同一修订口径的库连接内版本：`seq` 由调用方给出（runExport 传快照 as_of_seq，
 * dataRevision 传当前 MAX(seq)）。
 *
 * 计数分量统一是 `count,rowid_total`（TOTAL(rowid) 对空表返回 0，用 CAST 归一到整数）：
 * rowid 表上的「等价交换」会更换 rowid 总量而不改变行数，单靠 COUNT(*) 会漏判。
 */
function revisionOf(db: Database, seq: number): string {
  const tally = (sql: string): string => {
    const row = get<{ c: number; t: number }>(db, sql);
    return `${row?.c ?? 0},${row?.t ?? 0}`;
  };
  const accounts = tally(
    "SELECT COUNT(*) AS c, CAST(TOTAL(rowid) AS INTEGER) AS t FROM accounts WHERE disabled != 2",
  );
  const follows = tally(
    "SELECT COUNT(*) AS c, CAST(TOTAL(rowid) AS INTEGER) AS t FROM follows",
  );
  const bookmarks = tally(
    "SELECT COUNT(*) AS c, CAST(TOTAL(rowid) AS INTEGER) AS t FROM bookmarks",
  );
  const pluginsOn =
    BUILTIN_PLUGINS.map((plugin) => plugin.id)
      .sort()
      .map((id) => {
        const raw = getMeta(db, `plugins.${id}.enabled`);
        const enabled = raw === null ? builtinPlugin(id)?.defaultEnabled === true : raw === "1";
        return enabled ? "1" : "0";
      })
      .join("") || "0";
  return `${seq}:${accounts}:${follows}:${bookmarks}:${pluginsOn}`;
}

/** 只读连接的稳定视图：快照与计数在同一个读事务里取，避免跨提交错位。 */
function inReadTransaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 连接随后由调用方关闭；回滚失败不覆盖原始错误。
    }
    throw err;
  }
}

/**
 * 读取产物根的 manifest（缺文件 / 坏 JSON / 形状不符一律 null —— 视为无缓存，
 * 绝不因清单损坏而报错）。
 */
export function readExportManifest(exportDir: string): ExportManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(exportDir, EXPORT_MANIFEST_FILE), "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const manifest = raw as Partial<ExportManifest>;
  if (
    typeof manifest.rev !== "string" ||
    typeof manifest.as_of_seq !== "number" ||
    typeof manifest.exported_at !== "number" ||
    typeof manifest.viewer !== "string" ||
    typeof manifest.ui_version !== "string"
  ) {
    return null;
  }
  return {
    rev: manifest.rev,
    as_of_seq: manifest.as_of_seq,
    exported_at: manifest.exported_at,
    viewer: manifest.viewer,
    ui_version: manifest.ui_version,
  };
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

/**
 * 正文内嵌的本地媒体引用（report-longform：`steps.media`/`compare` 的
 * `/api/media/<64hex>`）。指令块正文里没有 `post.media` 记录，但静态归档的
 * `staticMediaUrl` 需要快照 media 表命中 → 导出时按哈希补登（不存在的哈希跳过）。
 */
const BODY_MEDIA_RE = /\/api\/media\/([a-f0-9]{64})/g;

function collectBodyMedia(
  store: Store,
  body: string,
  collect: (refs: MediaRef[]) => void,
): void {
  const refs: MediaRef[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(BODY_MEDIA_RE)) {
    const hash = match[1]!;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const row = store.getMedia(hash);
    if (!row) continue;
    const ref: MediaRef = {
      hash: row.hash,
      ext: row.ext,
      bytes: row.bytes,
      url: `/api/media/${row.hash}`,
    };
    if (row.w && row.h) {
      ref.w = row.w;
      ref.h = row.h;
    }
    refs.push(ref);
  }
  if (refs.length > 0) collect(refs);
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

  const snapshotPosts: SnapshotPost[] = posts.map((post) => {
    const media = collectMedia(post.media);
    const quoted = post.quoted ? { ...post.quoted, media: collectMedia(post.quoted.media) } : null;
    // report-longform：正文手写/指令块内引用的媒体（`steps.media`/`compare` 两侧）不在
    // `post.media` 里，但静态归档必须能按相对路径加载 → 扫描正文哈希补进快照 media 表。
    // 复核 O10：不按 kind 设门——note 正文里的手写媒体同样要入快照（同一信源扫描）。
    if (post.body_md) collectBodyMedia(store, post.body_md, collectMedia);
    return { ...post, media, quoted };
  });

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
    // 快照与修订计数必须来自同一个读事务（design v2 §1.3）：rev 的 seq 分量直接取
    // 本次快照的 as_of_seq，绝不事后另查——否则 rev 领先快照会让新帖永久不进归档。
    const { snapshot, rev } = inReadTransaction(db, () => {
      const snapshot = buildSnapshot(store, opts.viewer ?? "owner");
      // 测试 seam 落点：快照已定、rev 计数尚未读——恰好检验「rev 不得领先快照」。
      opts.__testAfterSnapshot?.();
      return { snapshot, rev: revisionOf(db, snapshot.as_of_seq) };
    });
    const manifest: ExportManifest = {
      rev,
      as_of_seq: snapshot.as_of_seq,
      exported_at: now,
      viewer: snapshot.viewer,
      ui_version: VERSION,
    };

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

    // 修订清单进入临时产物根：随 index.html/assets/media 同批原子换入，绝不出现新旧混批。
    writeFileSync(join(tmpRoot, EXPORT_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    // atomic swap
    mkdirSync(outRoot, { recursive: true, mode: 0o700 });
    const historyDir = join(outRoot, "history");
    const hold = join(opts.dataDir, `.export-history-hold-${process.pid}`);
    if (existsSync(hold) && !existsSync(historyDir)) renameSync(hold, historyDir);
    if (isDefaultOut && existsSync(historyDir)) {
      renameSync(historyDir, hold);
    }
    const old = `${outRoot}.old-${process.pid}-${ts}`;
    let swapped = false;
    try {
      if (existsSync(outRoot)) renameSync(outRoot, old);
      renameSync(tmpRoot, outRoot);
      swapped = true;
    } finally {
      // 成功换入后立即清掉上一版；失败时保留 old（可能是唯一完好归档），
      // 交由 cleanupStaleExports 按 .old-* 前缀延后回收。
      if (swapped && existsSync(old)) rmSync(old, { recursive: true, force: true });
    }
    if (isDefaultOut) {
      if (existsSync(hold)) renameSync(hold, join(outRoot, "history"));
      const histRoot = join(outRoot, "history", ts);
      copyTreeExpress(outRoot, histRoot, ["history"]);
      if (opts.prune) pruneHistory(join(outRoot, "history"), Math.max(opts.keep ?? 5, 1));
    }

    return {
      out_dir: outRoot,
      as_of_seq: snapshot.as_of_seq,
      rev,
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

/**
 * 导出崩溃残留的识别：tmp/hold 以点开头；`.old-*` 是原子换目录的上一版备份
 * （`<outRoot>.old-<pid>-<YYYYMMDDTHHMMSS>`，见 runExport）。
 */
const STALE_EXPORT_RE = /^(?:\.export-tmp-|\.export-history-hold-)|\.old-\d+-\d{8}T\d{6}$/;

/** Best-effort cleanup of interrupted exports (older than 1h). */
export function cleanupStaleExports(dataDir: string, now = Date.now()): void {
  try {
    for (const entry of readdirSync(dataDir)) {
      if (!STALE_EXPORT_RE.test(entry)) continue;
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

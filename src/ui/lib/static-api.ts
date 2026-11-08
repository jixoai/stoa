/**
 * 静态归档模式（design report-app-grade §2 / §5，spec report-static-mode）。
 *
 * 导出产物把快照内联进 `#report-snapshot`；应用在 **API 客户端层** 换成只读实现：
 * - 读接口全部从快照派生（时间线 / feed 双 tab / 成员页 / 标签 / 搜索 / who / thread）；
 * - 写接口一律抛 `READ_ONLY`，**不经过 fetch**——静态归档不产生任何写网络请求；
 * - 分页与线上同语义：keyset `(created_at, id)`，游标格式与后端一致（base64url JSON）；
 * - 线程组装直接复用 `core/thread.ts` 的 spine 算法（单一实现，不另写一套）。
 *
 * 快照已经是「该 viewer 视角」的切片，mock 不再重复实现可见性（design §5）。
 */
import type {
  AccountProfile,
  AuthorView,
  FeedPage,
  FeedTab,
  MediaRef,
  NotificationHistoryPage,
  PostView,
  ProfilePage,
  QuotedView,
  ThreadNode,
  ThreadView,
  TimelinePage,
} from "@core/types";
import { assembleThread } from "@core/thread";
import {
  ApiError,
  ReportClient,
  type AccountRow,
  type AuthStatus,
  type ProfilePageView,
  type ReadPage,
  type ServerStatus,
  type SuggestedAccount,
  type TrendingTag,
  type WhoRow,
} from "@/lib/api";

export interface SnapshotAccount extends AuthorView {
  created_at?: number;
  followers?: number;
}

export interface SnapshotMedia extends MediaRef {
  /** 归档内相对路径，例如 `media/abc.png` */
  url: string;
}

export interface SnapshotPost {
  id: string;
  author: string;
  author_account?: AuthorView;
  body_md: string;
  reply_count?: number;
  quoted?: (QuotedView & { media: SnapshotMedia[] }) | null;
  quoted_visible?: boolean;
  parent_id?: string | null;
  root_id?: string | null;
  self_thread_id?: string | null;
  self_thread_is_leaf?: number;
  reply_to_account_id?: string | null;
  quoted_post_id?: string | null;
  created_at: number;
  seq?: number;
  batch_id?: string;
  deleted_at?: number | null;
  tags?: string[];
  media?: SnapshotMedia[];
}

export interface ReportSnapshot {
  version: number;
  as_of_seq: number;
  viewer: string;
  /** 导出 viewer 的收藏帖子 id（只读展示）。 */
  bookmarks?: string[];
  accounts: SnapshotAccount[];
  follows: Array<[string, string]>;
  posts: SnapshotPost[];
  participants?: Record<string, string[]>;
  media?: SnapshotMedia[];
}

export const SNAPSHOT_ELEMENT_ID = "report-snapshot";

let cachedSnapshot: ReportSnapshot | null | undefined;

/** 读取内联快照；不存在或解析失败返回 null（→ 非静态模式）。 */
export function readReportSnapshot(): ReportSnapshot | null {
  if (cachedSnapshot !== undefined) return cachedSnapshot;
  if (typeof document === "undefined") {
    cachedSnapshot = null;
    return null;
  }
  const el = document.getElementById(SNAPSHOT_ELEMENT_ID);
  if (!el) {
    cachedSnapshot = null;
    return null;
  }
  try {
    const parsed = JSON.parse(el.textContent ?? "") as Partial<ReportSnapshot>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.posts)) {
      cachedSnapshot = null;
      return null;
    }
    cachedSnapshot = {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      as_of_seq: typeof parsed.as_of_seq === "number" ? parsed.as_of_seq : 0,
      viewer: typeof parsed.viewer === "string" ? parsed.viewer : "owner",
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      follows: Array.isArray(parsed.follows) ? parsed.follows : [],
      posts: parsed.posts as SnapshotPost[],
      participants: parsed.participants ?? {},
      media: Array.isArray(parsed.media) ? parsed.media : [],
    };
  } catch {
    cachedSnapshot = null;
  }
  return cachedSnapshot;
}

// ── keyset pagination（与 core/pagination.ts 同语义） ─────────────────────────

interface Cursor {
  v: 1;
  ts: number;
  id: string;
}

function encodeCursor(ts: number, id: string): string {
  const payload: Cursor = { v: 1, ts, id };
  const json = JSON.stringify(payload);
  const base64 = btoa(json);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    const parsed = JSON.parse(json) as Partial<Cursor>;
    if (parsed.v !== 1 || typeof parsed.ts !== "number" || typeof parsed.id !== "string") return null;
    return { v: 1, ts: parsed.ts, id: parsed.id };
  } catch {
    return null;
  }
}

function newerThan(a: { created_at: number; id: string }, c: Cursor): boolean {
  return a.created_at > c.ts || (a.created_at === c.ts && a.id > c.id);
}

function olderThan(a: { created_at: number; id: string }, c: Cursor): boolean {
  return a.created_at < c.ts || (a.created_at === c.ts && a.id < c.id);
}

function byDesc(a: { created_at: number; id: string }, b: { created_at: number; id: string }): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function byAsc(a: { created_at: number; id: string }, b: { created_at: number; id: string }): number {
  return -byDesc(a, b);
}

interface PageSlice<T> {
  items: T[];
  has_more: boolean;
  next_cursor: string | null;
  order: "asc" | "desc";
}

function slicePage<T extends { created_at: number; id: string }>(
  sorted: T[],
  opts: { before?: string | null; after?: string | null; limit: number },
): PageSlice<T> {
  const limit = Math.max(1, Math.min(opts.limit, 200));
  if (opts.after) {
    const cursor = decodeCursor(opts.after);
    const rows = (cursor ? sorted.filter((row) => newerThan(row, cursor)) : sorted).sort(byAsc);
    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = items[items.length - 1];
    return {
      items,
      has_more: hasMore,
      next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
      order: "asc",
    };
  }
  if (opts.before) {
    const cursor = decodeCursor(opts.before);
    const rows = (cursor ? sorted.filter((row) => olderThan(row, cursor)) : sorted).sort(byDesc);
    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = items[items.length - 1];
    return {
      items,
      has_more: hasMore,
      next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
      order: "desc",
    };
  }
  const rows = sorted.slice().sort(byDesc);
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = items[items.length - 1];
  return {
    items,
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    order: "desc",
  };
}

function readOnlyError(): ApiError {
  return new ApiError("静态归档是只读的", 403, "READ_ONLY");
}

const OWNER_MENTION_RE = /(^|[^A-Za-z0-9_@/])@owner\b/;

/**
 * 只读客户端：所有数据从快照派生；写操作在客户端层直接拒绝（零网络）。
 */
export class StaticReportClient extends ReportClient {
  readonly mode = "static" as const;
  readonly snapshot: ReportSnapshot;

  private readonly accountsById = new Map<string, SnapshotAccount>();
  private readonly postsById = new Map<string, SnapshotPost>();
  private readonly mediaByHash = new Map<string, SnapshotMedia>();
  private readonly followsBy = new Map<string, Set<string>>();
  private readonly viewerAccount: SnapshotAccount;

  constructor(snapshot: ReportSnapshot) {
    // 静态模式没有后端地址；base 只用于「client 已存在」的判定与媒体缓存键
    super("static://archive", null);
    this.snapshot = snapshot;
    for (const account of snapshot.accounts) this.accountsById.set(account.id, account);
    for (const post of snapshot.posts) this.postsById.set(post.id, post);
    for (const media of snapshot.media ?? []) this.mediaByHash.set(media.hash, media);
    for (const post of snapshot.posts) {
      for (const media of post.media ?? []) this.mediaByHash.set(media.hash, media);
    }
    for (const [follower, followee] of snapshot.follows) {
      const set = this.followsBy.get(follower) ?? new Set<string>();
      set.add(followee);
      this.followsBy.set(follower, set);
    }
    this.viewerAccount =
      this.accountsById.get(snapshot.viewer) ?? {
        id: snapshot.viewer,
        display: snapshot.viewer,
        profile: "",
        avatar: "",
        role: "owner",
        disabled: 0,
      };
  }

  // ── 快照派生 ────────────────────────────────────────────────────────────────
  private authorView(id: string): AuthorView {
    const account = this.accountsById.get(id);
    if (account) return account;
    return { id, display: id, profile: "", avatar: "", role: "agent", disabled: 0 };
  }

  private authorRow(id: string): WhoRow {
    const view = this.authorView(id);
    return {
      ...view,
      online: view.role === "owner" || view.role === "manager",
      last_seen: null,
    };
  }

  private hydrate(post: SnapshotPost): PostView {
    const deleted = post.deleted_at !== null && post.deleted_at !== undefined;
    // 后端 export 已内联 quoted/reply_count/author_account；手写快照缺少时再派生。
    let quoted: QuotedView | null = null;
    if (post.quoted !== undefined) {
      quoted = post.quoted;
    } else {
      const quotedPost = post.quoted_post_id ? this.postsById.get(post.quoted_post_id) : null;
      if (quotedPost && (quotedPost.deleted_at === null || quotedPost.deleted_at === undefined)) {
        quoted = {
          id: quotedPost.id,
          author: quotedPost.author,
          display: this.authorView(quotedPost.author).display,
          body_md: quotedPost.body_md,
          created_at: quotedPost.created_at,
          media: quotedPost.media ?? [],
          quoted_post_id: quotedPost.quoted_post_id ?? null,
        };
      }
    }
    const replyCount =
      typeof post.reply_count === "number"
        ? post.reply_count
        : this.snapshot.posts.filter(
            (row) =>
              row.parent_id === post.id && (row.deleted_at === null || row.deleted_at === undefined),
          ).length;
    return {
      id: post.id,
      author: post.author,
      body_md: deleted ? "" : post.body_md,
      parent_id: post.parent_id ?? null,
      root_id: post.root_id ?? post.id,
      self_thread_id: post.self_thread_id ?? post.root_id ?? post.id,
      self_thread_is_leaf: post.self_thread_is_leaf ?? 0,
      reply_to_account_id: post.reply_to_account_id ?? null,
      quoted_post_id: post.quoted_post_id ?? null,
      tags: post.tags ?? [],
      created_at: post.created_at,
      seq: post.seq ?? 0,
      batch_id: post.batch_id ?? "",
      deleted_at: post.deleted_at ?? null,
      author_account: post.author_account ?? this.authorView(post.author),
      media: deleted ? [] : post.media ?? [],
      reply_count: replyCount,
      quoted: deleted ? null : quoted,
      quoted_visible: deleted ? false : post.quoted_visible ?? Boolean(quoted),
    };
  }

  private roots(): SnapshotPost[] {
    return this.snapshot.posts.filter(
      (post) => (post.parent_id ?? null) === null && (post.deleted_at ?? null) === null,
    );
  }

  private profileAccount(id: string): AccountProfile | null {
    const account = this.accountsById.get(id);
    if (!account) return null;
    const followerCount =
      account.followers ??
      this.snapshot.follows.filter(([, followee]) => followee === id).length;
    const followingCount = this.followsBy.get(id)?.size ?? 0;
    return {
      id: account.id,
      display: account.display,
      profile: account.profile,
      avatar: account.avatar,
      role: account.role,
      disabled: account.disabled,
      created_at: account.created_at ?? 0,
      following: this.followsBy.get(this.snapshot.viewer)?.has(id) ?? false,
      follower_count: followerCount,
      following_count: followingCount,
    };
  }

  /** 同步引导态：静态模式首帧即可 ready，不闪「正在连接」。 */
  boot(): {
    auth: AuthStatus;
    server: ServerStatus;
    account: { id: string; role: AuthorView["role"] };
    who: WhoRow[];
    accounts: AccountRow[];
  } {
    return {
      auth: {
        mode: "open",
        auth_enabled: false,
        auth_value_masked: "",
        env_files_loaded: [],
        env_files_missing: [],
        access_token_ttl_ms: 0,
        open_mode_warning: null,
      },
      server: {
        instanceId: "static",
        pid: 0,
        port: null,
        dataDir: "",
        startedAt: 0,
        openMode: true,
        openExposed: false,
      },
      account: { id: this.viewerAccount.id, role: this.viewerAccount.role },
      who: this.snapshot.accounts.map((account) => this.authorRow(account.id)),
      accounts: this.snapshot.accounts.map((account) => ({
        ...this.authorView(account.id),
        created_at: account.created_at ?? 0,
      })),
    };
  }

  // ── 读接口 ──────────────────────────────────────────────────────────────────
  override async health(): Promise<{
    ok: boolean;
    dataDir: string;
    version: string;
    instanceId: string;
    mode: string;
  }> {
    return {
      ok: true,
      dataDir: "",
      version: "static",
      instanceId: "static",
      mode: "static",
    };
  }

  override async authStatus(): Promise<AuthStatus> {
    return {
      mode: "open",
      auth_enabled: false,
      auth_value_masked: "",
      env_files_loaded: [],
      env_files_missing: [],
      access_token_ttl_ms: 0,
      open_mode_warning: null,
    };
  }

  override async status(): Promise<{
    server: ServerStatus;
    account: { id: string; role: AuthorView["role"] };
    auth: AuthStatus;
  }> {
    return {
      server: {
        instanceId: "static",
        pid: 0,
        port: null,
        dataDir: "",
        startedAt: 0,
        openMode: true,
        openExposed: false,
      },
      account: { id: this.viewerAccount.id, role: this.viewerAccount.role },
      auth: await this.authStatus(),
    };
  }

  override async cursor(): Promise<{ account: string; cursor: number }> {
    return { account: this.viewerAccount.id, cursor: this.snapshot.as_of_seq };
  }

  override async who(): Promise<{ accounts: WhoRow[]; presence_ttl_ms: number }> {
    return {
      accounts: this.snapshot.accounts.map((account) => this.authorRow(account.id)),
      presence_ttl_ms: 90_000,
    };
  }

  override async accounts(): Promise<AccountRow[]> {
    return this.snapshot.accounts.map((account) => ({
      ...this.authorView(account.id),
      created_at: account.created_at ?? 0,
    }));
  }

  override async following(): Promise<{ accounts: WhoRow[] }> {
    const followees = this.followsBy.get(this.snapshot.viewer) ?? new Set<string>();
    return { accounts: [...followees].map((id) => this.authorRow(id)) };
  }

  /** 热门标签：与 report-discover 契约同口径（可见根帖，count × 7 天衰减）。 */
  override async trendingTags(limit = 12): Promise<TrendingTag[]> {
    const now = Date.now();
    const stats = new Map<string, { count: number; last_used_at: number }>();
    for (const post of this.roots()) {
      for (const tag of post.tags ?? []) {
        const entry = stats.get(tag) ?? { count: 0, last_used_at: 0 };
        entry.count += 1;
        entry.last_used_at = Math.max(entry.last_used_at, post.created_at);
        stats.set(tag, entry);
      }
    }
    const rows: TrendingTag[] = [...stats].map(([tag, entry]) => {
      const ageDays = Math.max(0, now - entry.last_used_at) / 86_400_000;
      return {
        tag,
        count: entry.count,
        last_used_at: entry.last_used_at,
        score: entry.count * Math.exp(-ageDays / 7),
      };
    });
    rows.sort((a, b) => b.score - a.score || b.count - a.count || a.tag.localeCompare(b.tag));
    return rows.slice(0, Math.max(1, Math.min(limit, 50)));
  }

  /** 推荐成员：排除自己，粉丝数降序、同分按最近发帖时间降序。 */
  override async suggestedAccounts(limit = 6): Promise<SuggestedAccount[]> {
    const viewer = this.snapshot.viewer;
    const lastPostAt = new Map<string, number>();
    for (const post of this.roots()) {
      lastPostAt.set(post.author, Math.max(lastPostAt.get(post.author) ?? 0, post.created_at));
    }
    const following = this.followsBy.get(viewer) ?? new Set<string>();
    const places = new Map<string, number>();
    for (const [, followee] of this.snapshot.follows) {
      places.set(followee, (places.get(followee) ?? 0) + 1);
    }
    const rows = this.snapshot.accounts
      .filter((account) => account.id !== viewer && account.disabled !== 2)
      .map((account) => ({
        id: account.id,
        display: account.display,
        profile: account.profile,
        avatar: account.avatar,
        role: account.role,
        followers: account.followers ?? places.get(account.id) ?? 0,
        last_post_at: lastPostAt.get(account.id) ?? null,
        following: following.has(account.id),
      }))
      .sort((a, b) => {
        if (a.followers !== b.followers) return b.followers - a.followers;
        return (b.last_post_at ?? 0) - (a.last_post_at ?? 0) || a.id.localeCompare(b.id);
      });
    return rows.slice(0, Math.max(1, Math.min(limit, 50)));
  }

  override async bookmarkIds(): Promise<string[]> {
    return [...(this.snapshot.bookmarks ?? [])];
  }

  override async bookmarks(opts: {
    before?: string | null;
    after?: string | null;
    limit?: number;
  } = {}): Promise<TimelinePage> {
    const ids = new Set(this.snapshot.bookmarks ?? []);
    const rows = this.snapshot.posts.filter(
      (post) =>
        ids.has(post.id) && (post.deleted_at === null || post.deleted_at === undefined),
    );
    const page = slicePage(rows, {
      before: opts.before,
      after: opts.after,
      limit: opts.limit ?? 30,
    });
    return {
      posts: page.items.map((post) => this.hydrate(post)),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      order: page.order,
      as_of_seq: this.snapshot.as_of_seq,
    };
  }

  override async bookmark(_postId: string): Promise<{ bookmarked: boolean }> {
    throw readOnlyError();
  }

  override async unbookmark(_postId: string): Promise<{ bookmarked: boolean }> {
    throw readOnlyError();
  }

  override async timeline(opts: {
    before?: string | null;
    after?: string | null;
    limit?: number;
  } = {}): Promise<TimelinePage> {
    const page = slicePage(this.roots(), {
      before: opts.before,
      after: opts.after,
      limit: opts.limit ?? 30,
    });
    return {
      posts: page.items.map((post) => this.hydrate(post)),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      order: page.order,
      as_of_seq: this.snapshot.as_of_seq,
    };
  }

  override async feed(opts: {
    tab: FeedTab;
    before?: string | null;
    after?: string | null;
    limit?: number;
  }): Promise<FeedPage> {
    const followees = this.followsBy.get(this.snapshot.viewer) ?? new Set<string>();
    const rows = this.roots().filter((post) =>
      opts.tab === "following"
        ? followees.has(post.author)
        : (post.tags ?? []).includes("result") || OWNER_MENTION_RE.test(post.body_md),
    );
    const page = slicePage(rows, {
      before: opts.before,
      after: opts.after,
      limit: opts.limit ?? 30,
    });
    return {
      tab: opts.tab,
      posts: page.items.map((post) => this.hydrate(post)),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      order: page.order,
      as_of_seq: this.snapshot.as_of_seq,
    };
  }

  override async profile(
    accountId: string,
    opts: { before?: string | null; after?: string | null; limit?: number } = {},
  ): Promise<ProfilePageView> {
    const account = this.profileAccount(accountId);
    if (!account) throw new ApiError(`account "${accountId}" not found`, 404, "NOT_FOUND");
    const rows = this.roots().filter((post) => post.author === accountId);
    const page = slicePage(rows, {
      before: opts.before,
      after: opts.after,
      limit: opts.limit ?? 30,
    });
    const view: ProfilePage = {
      account,
      posts: page.items.map((post) => this.hydrate(post)),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      order: page.order,
      as_of_seq: this.snapshot.as_of_seq,
    };
    return { ...view, account: { ...account, online: account.role === "owner" || account.role === "manager", last_seen: null } };
  }

  override async read(opts: {
    tag?: string | null;
    author?: string | null;
    limit?: number;
    after?: string | null;
  } = {}): Promise<ReadPage> {
    const rows = this.snapshot.posts.filter((post) => {
      if ((post.deleted_at ?? null) !== null) return false;
      if (opts.author && post.author !== opts.author) return false;
      if (opts.tag && !(post.tags ?? []).includes(opts.tag)) return false;
      return true;
    });
    const page = slicePage(rows, {
      before: null,
      after: opts.after ?? null,
      limit: opts.limit ?? 100,
    });
    return {
      posts: page.items.map((post) => this.hydrate(post)),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      order: page.order,
    };
  }

  override async thread(id: string, focal?: string | null): Promise<ThreadView> {
    const focalPost = this.postsById.get(id);
    if (!focalPost) throw new ApiError(`thread "${id}" not found`, 404, "NOT_FOUND");
    const rootId = focalPost.root_id ?? focalPost.id;
    const rows = this.snapshot.posts.filter((post) => (post.root_id ?? post.id) === rootId);
    const assembled = assembleThread(
      rows.map((post) => ({
        id: post.id,
        author: post.author,
        parent_id: post.parent_id ?? null,
        root_id: post.root_id ?? post.id,
        self_thread_id: post.self_thread_id ?? post.root_id ?? post.id,
        created_at: post.created_at,
        deleted: (post.deleted_at ?? null) !== null,
      })),
      { focalId: focal ?? id },
    );
    const nodes: ThreadNode[] = [];
    for (const node of assembled.nodes) {
      const post = this.postsById.get(node.id);
      if (!post) continue;
      const view: ThreadNode = {
        ...this.hydrate(post),
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
    const participants =
      this.snapshot.participants?.[rootId] ??
      [...new Set(rows.map((post) => post.author))];
    return {
      root_id: rootId,
      focal_id: focal ?? id,
      spine_complete: assembled.spine_complete,
      posts: nodes,
      collapsed: assembled.collapsed,
      participants,
      as_of_seq: Math.max(0, ...rows.map((post) => post.seq ?? 0)),
    };
  }

  override async post(id: string): Promise<PostView> {
    const post = this.postsById.get(id);
    if (!post) throw new ApiError(`post "${id}" not found`, 404, "NOT_FOUND");
    return this.hydrate(post);
  }

  override async search(q: string, limit = 30): Promise<PostView[]> {
    return (await this.searchWithAccounts(q, limit)).posts;
  }

  override async searchWithAccounts(
    q: string,
    limit = 30,
  ): Promise<{ posts: PostView[]; accounts: WhoRow[] }> {
    const query = q.trim();
    if (!query) throw new ApiError("search query must not be empty", 400, "BAD_REQUEST");
    const posts = this.snapshot.posts
      .filter(
        (post) =>
          (post.deleted_at ?? null) === null &&
          (post.body_md.includes(query) || (post.tags ?? []).some((tag) => tag.includes(query))),
      )
      .sort(byDesc)
      .slice(0, Math.min(limit, 100))
      .map((post) => this.hydrate(post));
    const accounts = this.snapshot.accounts
      .filter(
        (account) =>
          account.disabled !== 2 &&
          (account.id.includes(query) ||
            account.display.includes(query) ||
            account.profile.includes(query)),
      )
      .sort((a, b) => {
        if (a.id === query) return -1;
        if (b.id === query) return 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .slice(0, Math.min(limit, 100))
      .map((account) => this.authorRow(account.id));
    return { posts, accounts };
  }

  override async notifications(): Promise<{
    events: never[];
    target: null;
    cursor: number;
    role: AuthorView["role"];
  }> {
    return { events: [], target: null, cursor: 0, role: this.viewerAccount.role };
  }

  /** 归档快照不含事件流：历史列表为空，页面对应空态（只读）。 */
  override async notificationHistory(): Promise<NotificationHistoryPage> {
    return { events: [], cursor: 0, has_more: false, next_before: null };
  }

  /** 静态媒体：快照里的相对路径直接交给 <img>/<video>，不 fetch blob。 */
  override staticMediaUrl(hash: string): string | null {
    const media = this.mediaByHash.get(hash);
    if (!media) return null;
    const url = media.url || `media/${media.hash}.${media.ext}`;
    if (url.startsWith("/")) return `.${url}`;
    return url;
  }

  // ── 写接口：客户端层拒绝，绝不发网络请求 ────────────────────────────────────
  override async follow(): Promise<{ following: boolean }> {
    throw readOnlyError();
  }

  override async unfollow(): Promise<{ following: boolean }> {
    throw readOnlyError();
  }

  override async createPost(): Promise<{ posts: PostView[] }> {
    throw readOnlyError();
  }

  override async createReply(): Promise<{ posts: PostView[] }> {
    throw readOnlyError();
  }

  override async removePost(): Promise<void> {
    throw readOnlyError();
  }

  override async uploadMedia(): Promise<never> {
    throw readOnlyError();
  }

  override async ackNotifications(): Promise<{ cursor: number; unread_count: number }> {
    throw readOnlyError();
  }

  override async streamTicket(): Promise<string> {
    throw readOnlyError();
  }
}

/** 在应用内 API 客户端层安装只读 mock（返回可直接交给 ConnectionProvider 的客户端）。 */
export function installStaticApi(snapshot: ReportSnapshot): StaticReportClient {
  return new StaticReportClient(snapshot);
}

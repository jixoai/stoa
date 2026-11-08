/**
 * report HTTP 客户端（壳侧唯一网络入口）。
 *
 * 契约以服务端 `src/server/http.ts` 为准：
 * - 认证模式 REST 一律 `Authorization: Bearer <token>`；开放模式服务端声明式身份
 * - SSE 不直传 token：先 `POST /api/stream/ticket` 换 60s 一次性票据，再
 *   `GET /api/stream?hub=2&ticket=…`（连接状态机在 `state/hub/event-hub.ts`）
 * - 媒体读取只认 Authorization：<img> 不能带 header，因此走 blob 缓存
 */
import type {
  Account,
  AccountProfile,
  AuthorView,
  FeedPage,
  FeedTab,
  NotificationHistoryPage,
  NotificationLine,
  PostView,
  ProfilePage,
  SuggestedAccount,
  ThreadView,
  TimelinePage,
  TrendingTag,
} from "@core/types";
import type { PluginView, PluginWorkerSummary } from "@core/plugins/types";

// 发现接口的行类型由 core 统一声明（report-discover），这里只做壳侧再导出。
/** `GET /api/reads` 行（账号私有）：与服务端响应同形。 */
export interface ReadRow {
  post_id: string;
  read_at: number;
}

export type { SuggestedAccount, TrendingTag } from "@core/types";
// 预览/插件契约单源在 core（服务端同一份类型），壳侧只再导出。
export type {
  PluginDependencyView,
  PluginView,
  PluginWorkerSummary,
  PreviewLink,
} from "@core/plugins/types";

/** `/api/status.preview_worker`：worker 计数 + 最近错误（P1-14）。 */
export interface PreviewWorkerStatus extends PluginWorkerSummary {
  last_error?: string | null;
}

/**
 * `GET /api/capabilities` 的壳侧视图（P1-12 下发 `features.preview_fields`）。
 * 启动期首帧门：feature 未加载/为 false 时不渲染预览整卡（见 PluginsProvider）。
 */
export interface CapabilitiesView {
  product?: string;
  version?: string;
  protocol?: number;
  features?: { preview_fields?: boolean } & Record<string, unknown>;
  [key: string]: unknown;
}

export interface AuthStatus {
  mode: "open" | "auth";
  auth_enabled: boolean;
  auth_value_masked: string;
  env_files_loaded: string[];
  env_files_missing: string[];
  access_token_ttl_ms: number;
  open_mode_warning: string | null;
}

export interface ServerStatus {
  instanceId: string;
  pid: number;
  port: number | null;
  dataDir: string;
  startedAt: number;
  openMode: boolean;
  openExposed: boolean;
}

export interface AccountRow extends AuthorView {
  created_at: number;
}

export interface WhoRow extends AuthorView {
  online: boolean;
  last_seen: number | null;
}

export interface LoginResult {
  token: string;
  exp: number;
  sub: string;
}

export interface UploadedMedia {
  hash: string;
  ext: string;
  bytes: number;
  url: string;
}

/** Profile account as returned by `GET /api/profile/:account` (adds presence). */
export interface ProfileAccountView extends AccountProfile {
  online: boolean;
  last_seen: number | null;
}

export interface ProfilePageView extends Omit<ProfilePage, "account"> {
  account: ProfileAccountView;
}

export interface ReadPage {
  posts: PostView[];
  has_more: boolean;
  next_cursor: string | null;
  order: "asc" | "desc";
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class AuthError extends ApiError {
  constructor(message = "authentication required") {
    super(message, 401, "UNAUTHORIZED");
    this.name = "AuthError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  auth?: boolean;
  signal?: AbortSignal;
}

export class ReportClient {
  readonly base: string;
  /** `static` = 归档快照的只读实现（见 lib/static-api.ts）；不发起任何网络请求。 */
  readonly mode: "live" | "static" = "live";
  private token: string | null;
  private onUnauthorized: (() => void) | null = null;

  constructor(base: string, token: string | null) {
    this.base = base.replace(/\/+$/, "");
    this.token = token;
  }

  /**
   * 静态归档可直接使用的媒体 URL（相对路径）；线上客户端返回 null，
   * 走 `mediaBlob` 的授权 blob 通道。
   */
  staticMediaUrl(_hash: string): string | null {
    return null;
  }

  /** 静态归档快照的 `preview_enabled`；线上返回 null（以 `/api/plugins` 为准）。 */
  staticPreviewEnabled(): boolean | null {
    return null;
  }

  // ── plugins（report-link-preview P1-12/P1-15）───────────────────────────────
  async plugins(): Promise<PluginView[]> {
    const data = (await this.request("/api/plugins")) as { plugins?: PluginView[] };
    return Array.isArray(data.plugins) ? data.plugins : [];
  }

  async setPlugin(id: string, enabled: boolean): Promise<PluginView> {
    const data = (await this.request(`/api/plugins/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { enabled },
    })) as { plugin: PluginView };
    return data.plugin;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  setUnauthorizedHandler(handler: (() => void) | null): void {
    this.onUnauthorized = handler;
  }

  private headers(extra?: Record<string, string>, auth = true): Record<string, string> {
    const headers: Record<string, string> = { ...(extra ?? {}) };
    if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async request(path: string, opts: RequestOptions = {}): Promise<unknown> {
    const auth = opts.auth !== false;
    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers: this.headers(
        opts.body !== undefined ? { "content-type": "application/json" } : undefined,
        auth,
      ),
      credentials: "omit",
      cache: "no-store",
      signal: opts.signal,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, init);
    } catch (err) {
      throw new ApiError(
        `无法连接后端（${(err as Error).message}）`,
        0,
        "NETWORK",
      );
    }
    if (res.status === 204) return null;
    const contentType = res.headers.get("content-type") ?? "";
    let payload: unknown = null;
    if (contentType.includes("application/json")) {
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
    } else {
      payload = await res.text();
    }
    const record =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new AuthError(
        typeof record?.error === "string" ? record.error : "authentication required",
      );
    }
    if (!res.ok || record?.ok === false) {
      throw new ApiError(
        typeof record?.error === "string" ? record.error : `HTTP ${res.status}`,
        res.status,
        typeof record?.code === "string" ? record.code : "HTTP_ERROR",
      );
    }
    return payload;
  }

  // ── discovery / auth ───────────────────────────────────────────────────────
  async health(): Promise<{ ok: boolean; dataDir: string; version: string; instanceId: string }> {
    return (await this.request("/healthz", { auth: false })) as {
      ok: boolean;
      dataDir: string;
      version: string;
      instanceId: string;
    };
  }

  async authStatus(): Promise<AuthStatus> {
    return (await this.request("/api/auth/status", { auth: false })) as AuthStatus;
  }

  async login(secret: string): Promise<LoginResult> {
    const data = (await this.request("/api/auth/login", {
      method: "POST",
      body: { secret },
      auth: false,
    })) as { token: string; exp: number; sub: string };
    return data;
  }

  async status(): Promise<{
    server: ServerStatus;
    account: { id: string; role: Account["role"] };
    auth: AuthStatus;
    preview_worker?: PreviewWorkerStatus;
  }> {
    return (await this.request("/api/status")) as {
      server: ServerStatus;
      account: { id: string; role: Account["role"] };
      auth: AuthStatus;
      preview_worker?: PreviewWorkerStatus;
    };
  }

  async cursor(): Promise<{ account: string; cursor: number }> {
    return (await this.request("/api/cursor")) as { account: string; cursor: number };
  }

  /** 启动期能力矩阵（`features.preview_fields` 用于预览首帧门，P1-12）。 */
  async capabilities(): Promise<CapabilitiesView> {
    return (await this.request("/api/capabilities")) as CapabilitiesView;
  }

  // ── directory ──────────────────────────────────────────────────────────────
  async who(): Promise<{ accounts: WhoRow[]; presence_ttl_ms: number }> {
    return (await this.request("/api/who")) as { accounts: WhoRow[]; presence_ttl_ms: number };
  }

  async accounts(): Promise<AccountRow[]> {
    const data = (await this.request("/api/accounts")) as { accounts: AccountRow[] };
    return data.accounts;
  }

  /** 热门标签（report-discover）。后端可能返回 `{tags}` 或裸数组，两端都收。 */
  async trendingTags(limit = 12): Promise<TrendingTag[]> {
    const data = (await this.request(`/api/tags/trending?limit=${limit}`)) as
      | TrendingTag[]
      | { tags?: TrendingTag[] };
    if (Array.isArray(data)) return data;
    return Array.isArray(data.tags) ? data.tags : [];
  }

  /** 推荐成员（report-discover），排除自己、带 following 标记。 */
  async suggestedAccounts(limit = 6): Promise<SuggestedAccount[]> {
    const data = (await this.request(`/api/accounts/suggested?limit=${limit}`)) as
      | SuggestedAccount[]
      | { accounts?: SuggestedAccount[] };
    if (Array.isArray(data)) return data;
    return Array.isArray(data.accounts) ? data.accounts : [];
  }

  // ── posts ──────────────────────────────────────────────────────────────────
  async timeline(opts: { before?: string | null; after?: string | null; limit?: number } = {}): Promise<TimelinePage> {
    const params = new URLSearchParams();
    if (opts.before) params.set("before", opts.before);
    if (opts.after) params.set("after", opts.after);
    params.set("limit", String(opts.limit ?? 30));
    const data = (await this.request(`/api/timeline?${params.toString()}`)) as TimelinePage & {
      ok: boolean;
    };
    return data;
  }

  /** Home feed (design §5.0): two tabs with independent server-side cursors. */
  async feed(opts: {
    tab: FeedTab;
    before?: string | null;
    after?: string | null;
    limit?: number;
  }): Promise<FeedPage> {
    const params = new URLSearchParams({ tab: opts.tab });
    if (opts.before) params.set("before", opts.before);
    if (opts.after) params.set("after", opts.after);
    params.set("limit", String(opts.limit ?? 30));
    const data = (await this.request(`/api/feed?${params.toString()}`)) as FeedPage & {
      ok: boolean;
    };
    return data;
  }

  /** Member page: profile card + that member's visible root posts. */
  async profile(
    accountId: string,
    opts: { before?: string | null; after?: string | null; limit?: number } = {},
  ): Promise<ProfilePageView> {
    const params = new URLSearchParams();
    if (opts.before) params.set("before", opts.before);
    if (opts.after) params.set("after", opts.after);
    params.set("limit", String(opts.limit ?? 30));
    const data = (await this.request(
      `/api/profile/${encodeURIComponent(accountId)}?${params.toString()}`,
    )) as { ok: boolean } & ProfilePageView;
    return data;
  }

  async follow(accountId: string): Promise<{ following: boolean }> {
    return (await this.request(`/api/follow/${encodeURIComponent(accountId)}`, {
      method: "POST",
    })) as { following: boolean };
  }

  async unfollow(accountId: string): Promise<{ following: boolean }> {
    return (await this.request(`/api/follow/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
    })) as { following: boolean };
  }

  async following(): Promise<{ accounts: WhoRow[] }> {
    return (await this.request("/api/following")) as { accounts: WhoRow[] };
  }

  /** CLI `read --tag/--author` equivalent (tag-page filtering). */
  async read(opts: {
    tag?: string | null;
    author?: string | null;
    limit?: number;
    after?: string | null;
  } = {}): Promise<ReadPage> {
    const params = new URLSearchParams();
    if (opts.tag) params.set("tag", opts.tag);
    if (opts.author) params.set("author", opts.author);
    if (opts.after) params.set("after", opts.after);
    params.set("limit", String(opts.limit ?? 100));
    const data = (await this.request(`/api/read?${params.toString()}`)) as {
      ok: boolean;
    } & ReadPage;
    return data;
  }

  /** 收藏：当前账号已收藏的帖子 id（按钮态用）。 */
  async bookmarkIds(): Promise<string[]> {
    const data = (await this.request("/api/bookmarks/ids")) as { ids?: string[] };
    return Array.isArray(data.ids) ? data.ids : [];
  }

  /** 收藏列表（按帖子时间倒序，含回复）。 */
  async bookmarks(opts: { before?: string | null; after?: string | null; limit?: number } = {}): Promise<TimelinePage> {
    const params = new URLSearchParams();
    if (opts.before) params.set("before", opts.before);
    if (opts.after) params.set("after", opts.after);
    params.set("limit", String(opts.limit ?? 30));
    const data = (await this.request(`/api/bookmarks?${params.toString()}`)) as {
      ok: boolean;
    } & TimelinePage;
    return data;
  }

  async bookmark(postId: string): Promise<{ bookmarked: boolean }> {
    return (await this.request(`/api/bookmarks/${encodeURIComponent(postId)}`, {
      method: "PUT",
    })) as { bookmarked: boolean };
  }

  async unbookmark(postId: string): Promise<{ bookmarked: boolean }> {
    return (await this.request(`/api/bookmarks/${encodeURIComponent(postId)}`, {
      method: "DELETE",
    })) as { bookmarked: boolean };
  }

  async thread(id: string, focal?: string | null): Promise<ThreadView> {
    const params = new URLSearchParams();
    if (focal) params.set("focal", focal);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const data = (await this.request(`/api/thread/${encodeURIComponent(id)}${suffix}`)) as {
      thread: ThreadView;
    };
    return data.thread;
  }

  async post(id: string): Promise<PostView> {
    const data = (await this.request(`/api/posts/${encodeURIComponent(id)}`)) as { post: PostView };
    return data.post;
  }

  async createPost(opts: {
    body: string;
    quote?: string | null;
    media?: string[];
    tags?: string[];
  }): Promise<{ posts: PostView[] }> {
    return (await this.request("/api/posts", {
      method: "POST",
      body: {
        body: opts.body,
        quote: opts.quote ?? null,
        media: opts.media ?? [],
        tags: opts.tags ?? [],
      },
    })) as { posts: PostView[] };
  }

  async createReply(
    parentId: string,
    opts: { body: string; media?: string[]; tags?: string[] },
  ): Promise<{ posts: PostView[] }> {
    return (await this.request(`/api/posts/${encodeURIComponent(parentId)}/replies`, {
      method: "POST",
      body: { body: opts.body, media: opts.media ?? [], tags: opts.tags ?? [] },
    })) as { posts: PostView[] };
  }

  async removePost(id: string): Promise<void> {
    await this.request(`/api/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async search(q: string, limit = 30): Promise<PostView[]> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    const data = (await this.request(`/api/search?${params.toString()}`)) as { posts: PostView[] };
    return data.posts;
  }

  /** `search --accounts`: posts and a member group in one round-trip. */
  async searchWithAccounts(
    q: string,
    limit = 30,
  ): Promise<{ posts: PostView[]; accounts: WhoRow[] }> {
    const params = new URLSearchParams({ q, limit: String(limit), accounts: "1" });
    const data = (await this.request(`/api/search?${params.toString()}`)) as {
      posts: PostView[];
      accounts: WhoRow[];
    };
    return { posts: data.posts, accounts: data.accounts };
  }

  // ── notifications ──────────────────────────────────────────────────────────
  async notifications(opts: {
    peek?: boolean;
    wait?: boolean;
    cursor?: number | null;
    /** 一次性 peek 的分页上限（默认 100/上限 200；服务端口径） */
    limit?: number;
  } = {}): Promise<{
    events: NotificationLine[];
    target: number | null;
    cursor: number;
    role: Account["role"];
    /** 游标口径未读事件数（服务端权威；角标按 target 去重，见 notification-projection） */
    unread_count?: number;
    /** 按 COALESCE(post_id, root_id) 分组的未读事件数 */
    unread_by_target?: Record<string, number>;
    limit?: number | null;
    has_more?: boolean;
  }> {
    const params = new URLSearchParams();
    if (opts.peek) params.set("peek", "1");
    if (opts.wait) params.set("wait", "1");
    if (opts.cursor !== undefined && opts.cursor !== null) params.set("cursor", String(opts.cursor));
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return (await this.request(`/api/notifications${suffix}`)) as {
      events: NotificationLine[];
      target: number | null;
      cursor: number;
      role: Account["role"];
      unread_count?: number;
      unread_by_target?: Record<string, number>;
      limit?: number | null;
      has_more?: boolean;
    };
  }

  async notificationHistory(
    opts: { limit?: number; before?: number | null } = {},
  ): Promise<NotificationHistoryPage> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.before !== undefined && opts.before !== null) params.set("before", String(opts.before));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return (await this.request(`/api/notifications/history${suffix}`)) as NotificationHistoryPage;
  }

  async ackNotifications(target: number): Promise<{ cursor: number; unread_count: number }> {
    const data = (await this.request("/api/notifications/ack", {
      method: "POST",
      body: { target },
    })) as { cursor: number; unread_count?: number };
    return { cursor: data.cursor, unread_count: data.unread_count ?? 0 };
  }

  // ── reads（服务端按帖已读；账号私有）────────────────────────────────────────
  /** 单帖已读（幂等；重复写返回首次 `read_at`）。 */
  async markRead(postId: string): Promise<{
    post_id: string;
    read: boolean;
    read_at: number;
    created: boolean;
  }> {
    return (await this.request("/api/reads", {
      method: "POST",
      body: { post_id: postId },
    })) as { post_id: string; read: boolean; read_at: number; created: boolean };
  }

  /** 批量已读（≤100/次；未知/不可见 id 由服务端静默 skip）。 */
  async markReads(postIds: string[]): Promise<{
    stored: number;
    skipped: string[];
    read_at: number;
  }> {
    const data = (await this.request("/api/reads/batch", {
      method: "POST",
      body: { post_ids: postIds },
    })) as { stored?: number; skipped?: string[]; read_at?: number };
    return {
      stored: data.stored ?? 0,
      skipped: Array.isArray(data.skipped) ? data.skipped : [],
      read_at: data.read_at ?? 0,
    };
  }

  /** 本账号的逐帖读行（≤200/次；不存在的行直接省略）。 */
  async readStates(ids: string[]): Promise<ReadRow[]> {
    if (ids.length === 0) return [];
    const params = new URLSearchParams({ ids: ids.join(",") });
    const data = (await this.request(`/api/reads?${params.toString()}`)) as {
      reads?: ReadRow[];
    };
    return Array.isArray(data.reads) ? data.reads : [];
  }

  // ── media ──────────────────────────────────────────────────────────────────
  async uploadMedia(file: File): Promise<UploadedMedia> {
    // NOTE: 服务端 CORS 只放行 authorization/content-type/x-report-account；
    // `x-filename` 会在预检被拒。扩展名改由 content-type 映射（见 core/validation）。
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const extType =
      ext === "png"
        ? "image/png"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webp"
            ? "image/webp"
            : ext === "gif"
              ? "image/gif"
              : ext === "svg"
                ? "image/svg+xml"
                : ext === "mp4"
                  ? "video/mp4"
                  : ext === "webm"
                    ? "video/webm"
                    : ext === "md"
                      ? "text/markdown"
                      : ext === "json"
                        ? "application/json"
                        : ext === "log"
                          ? "text/x-log"
                          : ext === "txt"
                            ? "text/plain"
                            : "";
    const contentType =
      file.type && file.type !== "application/octet-stream" ? file.type : extType || "application/octet-stream";
    const res = await fetch(`${this.base}/api/media`, {
      method: "POST",
      headers: this.headers({
        "content-type": contentType,
      }),
      body: file,
      credentials: "omit",
      cache: "no-store",
    });
    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new AuthError();
    }
    const payload = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; code?: string; hash?: string; ext?: string; bytes?: number; url?: string }
      | null;
    if (!res.ok || !payload?.hash) {
      throw new ApiError(payload?.error ?? `上传失败（HTTP ${res.status}）`, res.status, payload?.code ?? "UPLOAD_FAILED");
    }
    return { hash: payload.hash, ext: payload.ext ?? "", bytes: payload.bytes ?? file.size, url: payload.url ?? "" };
  }

  async mediaBlob(hash: string): Promise<Blob> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/media/${encodeURIComponent(hash)}`, {
        headers: this.headers(undefined, true),
        credentials: "omit",
        cache: "force-cache",
      });
    } catch (err) {
      throw new ApiError(`媒体加载失败（${(err as Error).message}）`, 0, "NETWORK");
    }
    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new AuthError();
    }
    if (!res.ok) throw new ApiError(`媒体 ${hash.slice(0, 8)} 加载失败（HTTP ${res.status}）`, res.status, "MEDIA");
    return res.blob();
  }

  // ── SSE ────────────────────────────────────────────────────────────────────
  async streamTicket(): Promise<string> {
    const data = (await this.request("/api/stream/ticket", { method: "POST" })) as { ticket: string };
    return data.ticket;
  }
}

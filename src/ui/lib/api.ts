/**
 * report HTTP 客户端（壳侧唯一网络入口）。
 *
 * 契约以服务端 `src/server/http.ts` 为准：
 * - 认证模式 REST 一律 `Authorization: Bearer <token>`；开放模式服务端声明式身份
 * - SSE 不直传 token：先 `POST /api/stream/ticket` 换 60s 一次性票据，再
 *   `GET /api/stream?ticket=…`（design §4/§11）
 * - 媒体读取只认 Authorization：<img> 不能带 header，因此走 blob 缓存
 */
import type {
  Account,
  AccountProfile,
  AuthorView,
  FeedPage,
  FeedTab,
  NotificationEventLine,
  NotificationHistoryPage,
  NotificationLine,
  PostView,
  ProfilePage,
  SuggestedAccount,
  ThreadView,
  TimelinePage,
  TrendingTag,
} from "@core/types";

// 发现接口的行类型由 core 统一声明（report-discover），这里只做壳侧再导出。
export type { SuggestedAccount, TrendingTag } from "@core/types";

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
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  auth?: boolean;
  signal?: AbortSignal;
}

export type SseState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

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
  }> {
    return (await this.request("/api/status")) as {
      server: ServerStatus;
      account: { id: string; role: Account["role"] };
      auth: AuthStatus;
    };
  }

  async cursor(): Promise<{ account: string; cursor: number }> {
    return (await this.request("/api/cursor")) as { account: string; cursor: number };
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
  async notifications(opts: { peek?: boolean; wait?: boolean; cursor?: number | null } = {}): Promise<{
    events: NotificationLine[];
    target: number | null;
    cursor: number;
    role: Account["role"];
  }> {
    const params = new URLSearchParams();
    if (opts.peek) params.set("peek", "1");
    if (opts.wait) params.set("wait", "1");
    if (opts.cursor !== undefined && opts.cursor !== null) params.set("cursor", String(opts.cursor));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return (await this.request(`/api/notifications${suffix}`)) as {
      events: NotificationLine[];
      target: number | null;
      cursor: number;
      role: Account["role"];
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

  async ackNotifications(target: number): Promise<number> {
    const data = (await this.request("/api/notifications/ack", {
      method: "POST",
      body: { target },
    })) as { cursor: number };
    return data.cursor;
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

export interface SseHandlers {
  onEvent: (event: NotificationEventLine) => void;
  onState: (state: SseState) => void;
  onHello?: (hello: { account: string; cursor: number; as_of_seq: number; auth_mode: string }) => void;
}

/**
 * EventSource 管理：认证模式每次（重）连都换新票据；断线指数退避重连。
 * 断线补拉由消费者负责（时间线用 after 游标，通知用 seq 去重）——本类只保证
 * “重连后事件会再次到达/或由消费者补拉”，不持有业务游标。
 */
export interface ReportStreamOptions {
  /**
   * Member-page live subscription: `?author=<acct>` makes the server push only
   * events produced by that account. This is a technical filter, not a follow.
   */
  author?: string | null;
}

export class ReportStream {
  private readonly client: ReportClient;
  private readonly authMode: "open" | "auth";
  private readonly handlers: SseHandlers;
  private readonly options: ReportStreamOptions;
  private source: EventSource | null = null;
  private timer: number | null = null;
  private attempt = 0;
  private stopped = false;
  private state: SseState = "idle";

  constructor(
    client: ReportClient,
    authMode: "open" | "auth",
    handlers: SseHandlers,
    options: ReportStreamOptions = {},
  ) {
    this.client = client;
    this.authMode = authMode;
    this.handlers = handlers;
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.source?.close();
    this.source = null;
    this.setState("closed");
  }

  private setState(state: SseState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState(state);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== null) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    this.attempt += 1;
    this.setState("reconnecting");
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay + Math.floor(Math.random() * 400));
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setState("connecting");
    let url: string;
    try {
      const params = new URLSearchParams();
      if (this.authMode === "auth") {
        params.set("ticket", await this.client.streamTicket());
      } else {
        params.set("as", "owner");
      }
      if (this.options.author) params.set("author", this.options.author);
      url = `${this.client.base}/api/stream?${params.toString()}`;
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    this.source?.close();
    const source = new EventSource(url);
    this.source = source;

    source.addEventListener("hello", (raw) => {
      this.attempt = 0;
      this.setState("open");
      try {
        const hello = JSON.parse((raw as MessageEvent<string>).data) as {
          account: string;
          cursor: number;
          as_of_seq: number;
          auth_mode: string;
        };
        this.handlers.onHello?.(hello);
      } catch {
        // malformed hello is not fatal: the stream itself is up
      }
    });

    source.addEventListener("report", (raw) => {
      try {
        const event = JSON.parse((raw as MessageEvent<string>).data) as NotificationEventLine;
        this.handlers.onEvent(event);
      } catch {
        // ignore malformed frame
      }
    });

    source.onerror = () => {
      if (this.stopped) return;
      source.close();
      if (this.source === source) this.source = null;
      this.scheduleReconnect();
    };
  }
}

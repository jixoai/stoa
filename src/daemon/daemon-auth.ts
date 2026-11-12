/**
 * daemon 登录会话与 cookie（daemon-unified-port design §4/§4.1，S3-2）。
 *
 * - 会话台账**以内存为准**：`daemon-sessions.json`（0600）只是落盘快照，
 *   变更时/定时（≤30s，默认 2s 去抖）批量写——绝不每请求原子写。
 * - TTL 7 天**滑动**：命中会话时按需（≥60s 间隔）把 `expiresAt` 推到 now+7d，
 *   过期清理在读写路径顺手做。
 * - cookie `stoa_daemon`：`HttpOnly; SameSite=Lax; Path=/`；`Secure` 当请求是 https
 *   **或** Host 不是回环（公网隧道落地到本机 http，浏览器侧却是 https）；
 *   `Domain` 只在 Host 是**带点的非 IP** 时设为 `.`+Host（host-only 规则：
 *   bare `localhost` 与 IP 一律不加 Domain）。
 * - 路由门读 `authenticated(req)`：只认 cookie 会话，不看 peer/来源（来源条件在 gate 层）。
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./state.ts";
import {
  daemonAccountConfigured,
  daemonAccountStatus,
  setDaemonAccount,
  verifyDaemonLogin,
  type DaemonAccount,
  type DaemonAccountStatus,
} from "./accounts.ts";
import { hostHeaderName } from "./slug.ts";

export const DAEMON_SESSIONS_FILE = "daemon-sessions.json";
export const DAEMON_SESSION_COOKIE = "stoa_daemon";
/** 会话 TTL（滑动）：7 天。 */
export const DAEMON_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 滑动续期最小间隔：避免每请求都标脏（落盘按批）。 */
export const DAEMON_SESSION_RENEW_MS = 60_000;
/** 批量落盘去抖（≤30s 纪律）。 */
export const DAEMON_SESSION_FLUSH_MS = 2_000;

export interface DaemonSession {
  /** 128-bit 不透明 id（32 hex）；cookie 值。 */
  id: string;
  username: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

function daemonSessionsPath(stateDir: string): string {
  return join(stateDir, DAEMON_SESSIONS_FILE);
}

function isDaemonSession(value: unknown): value is DaemonSession {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<DaemonSession>;
  return (
    typeof record.id === "string" &&
    record.id.length >= 16 &&
    typeof record.username === "string" &&
    record.username !== "" &&
    typeof record.createdAt === "number" &&
    typeof record.lastSeenAt === "number" &&
    typeof record.expiresAt === "number"
  );
}

/**
 * 内存台账 + 批量落盘。
 * 时钟可注入（TTL 滑动/过期测试）；`flushDelayMs <= 0` 时不做定时落盘（测试用）。
 */
export class DaemonSessionStore {
  readonly stateDir: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly flushDelayMs: number;
  private readonly sessions = new Map<string, DaemonSession>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(opts: {
    stateDir: string;
    now?: () => number;
    ttlMs?: number;
    renewMs?: number;
    flushDelayMs?: number;
  }) {
    this.stateDir = opts.stateDir;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? DAEMON_SESSION_TTL_MS;
    this.renewMs = opts.renewMs ?? DAEMON_SESSION_RENEW_MS;
    this.flushDelayMs = opts.flushDelayMs ?? DAEMON_SESSION_FLUSH_MS;
    this.load();
  }

  /** 读盘：无效/过期条目直接丢弃（不为它们保留快照）。 */
  private load(): void {
    const value = readJsonFile<{ sessions?: unknown }>(daemonSessionsPath(this.stateDir));
    if (!value || !Array.isArray(value.sessions)) return;
    const now = this.now();
    for (const entry of value.sessions) {
      if (!isDaemonSession(entry)) continue;
      if (entry.expiresAt <= now) continue;
      this.sessions.set(entry.id, { ...entry });
    }
  }

  list(): DaemonSession[] {
    this.purgeExpired();
    return [...this.sessions.values()];
  }

  /** 新建会话（立即落盘：登录后立刻重启 daemon 也不能丢）。 */
  create(username: string): DaemonSession {
    const now = this.now();
    const session: DaemonSession = {
      id: randomBytes(16).toString("hex"),
      username,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(session.id, session);
    this.dirty = true;
    this.flush();
    return session;
  }

  /** 命中会话（顺手过期清理 + 滑动续期）；无效返回 null。 */
  get(id: string | null | undefined): DaemonSession | null {
    const key = String(id ?? "").trim();
    if (!key) return null;
    const session = this.sessions.get(key);
    if (!session) return null;
    const now = this.now();
    if (session.expiresAt <= now) {
      this.sessions.delete(key);
      this.dirty = true;
      this.schedule();
      return null;
    }
    if (now - session.lastSeenAt >= this.renewMs) {
      session.lastSeenAt = now;
      session.expiresAt = now + this.ttlMs;
      this.dirty = true;
      this.schedule();
    }
    return session;
  }

  /** 删除会话（退出登录立即失效）：立即落盘。 */
  remove(id: string | null | undefined): boolean {
    const key = String(id ?? "").trim();
    if (!key) return false;
    const existed = this.sessions.delete(key);
    if (existed) {
      this.dirty = true;
      this.flush();
    }
    return existed;
  }

  removeAllFor(username: string): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.username === username) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.dirty = true;
      this.flush();
    }
    return removed;
  }

  /** 立即落盘（测试与退出路径显式调用；平时靠去抖定时器）。 */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.purgeExpired();
    writeJsonAtomic(daemonSessionsPath(this.stateDir), {
      sessions: [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt),
    });
    this.dirty = false;
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        this.dirty = true;
      }
    }
  }

  private schedule(): void {
    if (this.flushDelayMs <= 0 || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushDelayMs);
    // 常驻 daemon 不该因为落盘定时器不退出（测试进程同理）。
    (this.timer as { unref?: () => void }).unref?.();
  }
}

// ── cookie 语义 ──────────────────────────────────────────────────────────────

/** 解析 Cookie 头（同名取第一个；值不做 URL 解码——会话 id 是 hex）。 */
export function parseCookieHeader(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(raw ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name || name in out) continue;
    out[name] = value;
  }
  return out;
}

/** 请求里的 daemon 会话 id（无则 null）。 */
export function sessionIdFromRequest(req: Pick<Request, "headers">): string | null {
  const cookies = parseCookieHeader(req.headers.get("cookie"));
  const value = cookies[DAEMON_SESSION_COOKIE] ?? "";
  return value || null;
}

/** 回环 host（含 `*.localhost`：浏览器把整个 .localhost 段当作本机安全上下文）。 */
export function isLoopbackHostname(host: string | null | undefined): boolean {
  const name = hostHeaderName(host).replace(/^\[|\]$/g, "");
  if (!name) return false;
  if (name === "localhost" || name === "127.0.0.1" || name === "::1") return true;
  return name.endsWith(".localhost");
}

/** IP 字面量 host（IPv4 点分 / IPv6 含冒号）——cookie Domain 不得用于 IP。 */
export function isIpHostname(host: string | null | undefined): boolean {
  const name = hostHeaderName(host).replace(/^\[|\]$/g, "");
  if (!name) return false;
  if (name.includes(":")) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name);
}

/**
 * cookie Domain：**只有带点的非 IP host** 才设 `.<host>`（Host 模式让实例子域共享会话）；
 * bare `localhost` / `127.0.0.1` / `[::1]` 一律 host-only。
 */
export function cookieDomainFor(host: string | null | undefined): string | null {
  const name = hostHeaderName(host);
  if (!name || !name.includes(".")) return null;
  if (isIpHostname(name)) return null;
  return `.${name}`;
}

/** `Secure`：https 或非回环 Host（公网隧道落地到本机 http 时浏览器侧仍是 https）。 */
export function cookieSecureFor(host: string | null | undefined, protocol: string): boolean {
  return String(protocol).toLowerCase() === "https:" || !isLoopbackHostname(host);
}

export interface CookieAttributes {
  secure: boolean;
  domain: string | null;
}

/** 由请求推导 cookie 属性（Secure/Domain 条件）。 */
export function cookieAttributesFor(
  req: Pick<Request, "url" | "headers">,
): CookieAttributes {
  let protocol = "http:";
  let urlHost = "";
  try {
    const url = new URL(req.url);
    protocol = url.protocol;
    urlHost = url.hostname;
  } catch {
    // 非法 URL：按 http + 空 host 处理（→ host-only、不 Secure）
  }
  const host = hostHeaderName(req.headers.get("host") ?? "") || hostHeaderName(urlHost);
  return { secure: cookieSecureFor(host, protocol), domain: cookieDomainFor(host) };
}

/** `Set-Cookie` 值（会话）。 */
export function buildSessionCookie(
  id: string,
  attrs: CookieAttributes,
  maxAgeMs = DAEMON_SESSION_TTL_MS,
): string {
  const parts = [
    `${DAEMON_SESSION_COOKIE}=${id}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (attrs.domain) parts.push(`Domain=${attrs.domain}`);
  if (attrs.secure) parts.push("Secure");
  return parts.join("; ");
}

/** `Set-Cookie` 值（清 cookie）。 */
export function buildClearSessionCookie(attrs: CookieAttributes): string {
  const parts = [`${DAEMON_SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (attrs.domain) parts.push(`Domain=${attrs.domain}`);
  if (attrs.secure) parts.push("Secure");
  return parts.join("; ");
}

export class DaemonSetupUnavailableError extends Error {
  readonly code = "SETUP_UNAVAILABLE";
  constructor() {
    super("daemon 账号已存在；首启创建只对「无账号」的 stateDir 开放");
    this.name = "DaemonSetupUnavailableError";
  }
}

/**
 * daemon 鉴权门面（账号 + 会话 + cookie）：`run.ts` 建一个实例，同时交给
 * HTTP app（登录/退出/首启）与 router（路由门）。两者共享同一份内存台账。
 */
export class DaemonAuth {
  readonly stateDir: string;
  readonly sessions: DaemonSessionStore;

  constructor(opts: {
    stateDir: string;
    now?: () => number;
    sessions?: DaemonSessionStore;
    ttlMs?: number;
    flushDelayMs?: number;
  }) {
    this.stateDir = opts.stateDir;
    this.sessions =
      opts.sessions ??
      new DaemonSessionStore({
        stateDir: opts.stateDir,
        now: opts.now,
        ttlMs: opts.ttlMs,
        flushDelayMs: opts.flushDelayMs,
      });
  }

  configured(): boolean {
    return daemonAccountConfigured(this.stateDir);
  }

  /** 只报用户名/时间（无密码无哈希）。 */
  status(): DaemonAccountStatus {
    return daemonAccountStatus(this.stateDir);
  }

  /** 首启创建（仅账号数=0）：抛 `DaemonSetupUnavailableError` 当已配置。 */
  async setup(input: { username?: string | null; password: unknown }): Promise<DaemonAccount> {
    if (this.configured()) throw new DaemonSetupUnavailableError();
    const out = await setDaemonAccount(this.stateDir, {
      username: input.username ?? null,
      password: input.password,
    });
    return out.account;
  }

  async login(
    username: string | null | undefined,
    password: string,
  ): Promise<DaemonAccount | null> {
    return await verifyDaemonLogin(this.stateDir, username, password);
  }

  startSession(username: string): DaemonSession {
    return this.sessions.create(username);
  }

  sessionIdOf(req: Pick<Request, "headers">): string | null {
    return sessionIdFromRequest(req);
  }

  sessionFor(req: Pick<Request, "headers">): DaemonSession | null {
    return this.sessions.get(sessionIdFromRequest(req));
  }

  /** 路由门判定：只认 cookie 会话。 */
  authenticated(req: Pick<Request, "headers">): boolean {
    return this.sessionFor(req) !== null;
  }

  /** 退出登录：删台账（立即落盘）+ 调用方清 cookie。 */
  endSession(req: Pick<Request, "headers">): boolean {
    return this.sessions.remove(sessionIdFromRequest(req));
  }

  cookieFor(req: Pick<Request, "headers" | "url">, sessionId: string): string {
    return buildSessionCookie(sessionId, cookieAttributesFor(req));
  }

  clearCookieFor(req: Pick<Request, "headers" | "url">): string {
    return buildClearSessionCookie(cookieAttributesFor(req));
  }

  flush(): void {
    this.sessions.flush();
  }

  dispose(): void {
    this.sessions.dispose();
  }
}

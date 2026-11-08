/**
 * ep（endpoint）契约 —— design §11 / spec report-surface。
 *
 * - 只接受 `https://…` 或 `http://localhost|127.0.0.1|\[::1\]`（其余 http 会被
 *   mixed content 拦死，且会把明文 token 发给内网地址）
 * - 当前 ep 存 localStorage(`report.ep`)；历史存 `report.ep.history`（最多 8 条）
 * - URL 上的 `?ep=` 覆盖本地值；覆盖前同样过校验
 * - 壳自身不硬编码任何后端地址（dist 可被任意静态宿主托管）
 */

export const EP_KEY = "report.ep";
export const EP_HISTORY_KEY = "report.ep.history";

export interface EpCheck {
  ok: boolean;
  /** normalized origin(+base path), no trailing slash */
  url?: string;
  error?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Validate/normalize one user-supplied endpoint. */
export function checkEp(raw: string): EpCheck {
  const input = raw.trim();
  if (!input) return { ok: false, error: "请输入后端地址" };

  let candidate = input;
  // 允许用户直接贴域名：默认 https（仍不放开 http）
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: "地址格式不正确" };
  }
  if (url.username || url.password) return { ok: false, error: "地址不能携带用户名或密码" };
  if (url.search || url.hash) return { ok: false, error: "ep 只接受站点根地址（不要带 ? 或 #）" };

  if (url.protocol === "https:") {
    // ok
  } else if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    // 本机回环放行（开发实例）
  } else if (url.protocol === "http:") {
    return { ok: false, error: "必须使用 https（仅 localhost / 127.0.0.1 可用 http）" };
  } else {
    return { ok: false, error: "只支持 https:// 或 http://localhost|127.0.0.1" };
  }

  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${url.origin}${path}` };
}

/** `?ep=` in the current URL wins over localStorage. */
export function epFromLocation(search = window.location.search): { raw: string | null; checked: EpCheck | null } {
  const params = new URLSearchParams(search);
  if (!params.has("ep")) return { raw: null, checked: null };
  const raw = params.get("ep") ?? "";
  return { raw, checked: checkEp(raw) };
}

/**
 * 同源后端探测：页面本身由 report 后端托管时（`GET /healthz` 返回 report 协议），
 * 首访直接连本站，不再要求用户手输地址。
 *
 * 这里刻意不套 checkEp：同源请求不存在 mixed-content，也不把 token 发给第三方；
 * 只有响应确实是 report 协议（ok + instanceId + protocol/dataDir）才算命中。
 */
export async function probeSameOriginEp(): Promise<EpCheck> {
  if (typeof window === "undefined") return { ok: false, error: "无 window 环境" };
  const { protocol, origin } = window.location;
  if (protocol !== "http:" && protocol !== "https:") {
    return { ok: false, error: "当前页面不是 http(s) 托管" };
  }
  try {
    const res = await fetch(`${origin}/healthz`, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { ok: false, error: `本站 /healthz 返回 HTTP ${res.status}` };
    const data = (await res.json()) as {
      ok?: unknown;
      instanceId?: unknown;
      protocol?: unknown;
      dataDir?: unknown;
    };
    const isReport =
      data?.ok === true &&
      typeof data.instanceId === "string" &&
      (typeof data.protocol === "number" || typeof data.dataDir === "string");
    return isReport ? { ok: true, url: origin } : { ok: false, error: "本站不是 report 后端" };
  } catch {
    return { ok: false, error: "本站未提供 /healthz" };
  }
}

/** 用户主动连接前的健康探测结果（不打印/不回显响应体，也不回显任何凭据）。 */
export interface EpHealth {
  ok: boolean;
  error?: string;
  instanceId?: string;
  version?: string;
}

/**
 * 探测任意已校验 ep 的 `/healthz`：只有 report 协议（ok + instanceId）才算在线。
 * 超时/HTTP 错误/非 JSON/网络错误都给出可读错误，供实例管理页就地 Alert。
 */
export async function probeEpHealth(url: string, timeoutMs = 5000): Promise<EpHealth> {
  const checked = checkEp(url);
  if (!checked.ok || !checked.url) {
    return { ok: false, error: checked.error ?? "地址不合法" };
  }
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  let res: Response;
  try {
    res = await fetch(`${checked.url}/healthz`, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: `连接超时（${seconds} 秒内没有响应）` };
    }
    return { ok: false, error: "无法访问该地址（网络错误、CORS 或证书问题）" };
  }
  if (!res.ok) return { ok: false, error: `目标 /healthz 返回 HTTP ${res.status}` };

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "/healthz 返回的不是 JSON" };
  }
  const record = (data ?? {}) as Record<string, unknown>;
  if (record.ok !== true || typeof record.instanceId !== "string" || !record.instanceId) {
    return { ok: false, error: "目标不是 report 实例（/healthz 响应不符合协议）" };
  }
  return {
    ok: true,
    instanceId: record.instanceId,
    version: typeof record.version === "string" ? record.version : undefined,
  };
}

export function loadCurrentEp(): string | null {
  try {
    const raw = localStorage.getItem(EP_KEY);
    if (!raw) return null;
    const checked = checkEp(raw);
    return checked.ok ? checked.url! : null;
  } catch {
    return null;
  }
}

export function saveCurrentEp(url: string): void {
  try {
    localStorage.setItem(EP_KEY, url);
  } catch {
    // private mode / storage denied: the session still works
  }
}

export function clearCurrentEp(): void {
  try {
    localStorage.removeItem(EP_KEY);
  } catch {
    // ignore
  }
}

/** 实例历史条目；`lastUsedAt=0` 表示旧版纯字符串条目（时间未知）。 */
export interface EpHistoryEntry {
  url: string;
  lastUsedAt: number;
}

const EP_HISTORY_LIMIT = 8;

/** 兼容旧格式 `string[]` 与新版 `{url,lastUsedAt}[]`（可混排）。 */
function parseEpHistory(raw: string | null): EpHistoryEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const entries: EpHistoryEntry[] = [];
  for (const item of parsed) {
    let candidateUrl: unknown;
    let candidateTime: unknown;
    if (typeof item === "string") {
      candidateUrl = item;
    } else if (item && typeof item === "object") {
      candidateUrl = (item as { url?: unknown }).url;
      candidateTime = (item as { lastUsedAt?: unknown }).lastUsedAt;
    }
    if (typeof candidateUrl !== "string") continue;
    const checked = checkEp(candidateUrl);
    if (!checked.ok || !checked.url || seen.has(checked.url)) continue;
    seen.add(checked.url);
    entries.push({
      url: checked.url,
      lastUsedAt:
        typeof candidateTime === "number" && Number.isFinite(candidateTime) && candidateTime > 0
          ? candidateTime
          : 0,
    });
    if (entries.length >= EP_HISTORY_LIMIT) break;
  }
  return entries;
}

export function loadEpHistoryEntries(): EpHistoryEntry[] {
  try {
    return parseEpHistory(localStorage.getItem(EP_HISTORY_KEY));
  } catch {
    return [];
  }
}

/** 旧调用面（只关心地址）：保留给非管理页消费者。 */
export function loadEpHistory(): string[] {
  return loadEpHistoryEntries().map((entry) => entry.url);
}

export function rememberEp(url: string): void {
  const checked = checkEp(url);
  if (!checked.ok || !checked.url) return;
  const normalized = checked.url;
  const list = [
    { url: normalized, lastUsedAt: Date.now() },
    ...loadEpHistoryEntries().filter((entry) => entry.url !== normalized),
  ].slice(0, EP_HISTORY_LIMIT);
  try {
    localStorage.setItem(EP_HISTORY_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

export function forgetEp(url: string): void {
  const list = loadEpHistoryEntries().filter((entry) => entry.url !== url);
  try {
    localStorage.setItem(EP_HISTORY_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

export function clearEpHistory(): void {
  try {
    localStorage.removeItem(EP_HISTORY_KEY);
  } catch {
    // ignore
  }
}

export function tokenKey(url: string): string {
  return `report.token.${url}`;
}

export function loadToken(url: string): string | null {
  try {
    return localStorage.getItem(tokenKey(url)) || null;
  } catch {
    return null;
  }
}

export function saveToken(url: string, token: string, exp?: number): void {
  try {
    localStorage.setItem(tokenKey(url), token);
    if (exp) localStorage.setItem(`${tokenKey(url)}.exp`, String(exp));
  } catch {
    // ignore
  }
}

export function clearToken(url: string): void {
  try {
    localStorage.removeItem(tokenKey(url));
    localStorage.removeItem(`${tokenKey(url)}.exp`);
  } catch {
    // ignore
  }
}

export function tokenExpired(url: string): boolean {
  try {
    const raw = localStorage.getItem(`${tokenKey(url)}.exp`);
    if (!raw) return false;
    const exp = Number(raw);
    return Number.isFinite(exp) && exp <= Date.now();
  } catch {
    return false;
  }
}

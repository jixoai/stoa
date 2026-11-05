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

export function loadEpHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EP_HISTORY_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && checkEp(item).ok).slice(0, 8);
  } catch {
    return [];
  }
}

export function rememberEp(url: string): void {
  const list = [url, ...loadEpHistory().filter((item) => item !== url)].slice(0, 8);
  try {
    localStorage.setItem(EP_HISTORY_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

export function forgetEp(url: string): void {
  const list = loadEpHistory().filter((item) => item !== url);
  try {
    localStorage.setItem(EP_HISTORY_KEY, JSON.stringify(list));
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

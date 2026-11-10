/**
 * daemon HTTP 客户端（CLI / 测试共用）：健康探测与 JSON 请求。
 * daemon 面只绑回环、无凭据，因此这里不涉及任何密钥处理。
 */

export interface DaemonHealth {
  ok: boolean;
  daemon: boolean;
  pid: number;
  port: number;
  url: string;
  stateDir: string;
  version: string;
  startedAt: number;
  services: { total: number; running: number };
}

/** 探测 daemon `/healthz`；非 daemon 或不可达返回 null（绝不抛错）。 */
export async function probeDaemon(url: string, timeoutMs = 800): Promise<DaemonHealth | null> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as DaemonHealth;
    return body && body.ok === true && body.daemon === true ? body : null;
  } catch {
    return null;
  }
}

/** daemon API 请求（JSON in/out）；非 2xx 或 {ok:false} 一律抛错（message 来自服务端）。 */
export async function daemonRequest<T>(
  url: string,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const record = (typeof body === "object" && body !== null ? body : {}) as {
    ok?: boolean;
    error?: string;
    code?: string;
  };
  if (!res.ok || record.ok === false) {
    const detail = record.error ?? `HTTP ${res.status}`;
    throw new Error(record.code ? `${detail} (${record.code})` : detail);
  }
  return body as T;
}

/**
 * daemon 单入口路由与反向代理（daemon-unified-port design §2/§3，P1）。
 *
 * 四优先级（顺序固定）：
 *   1. `Host` ∈ daemon host 集合 → daemon app（控制台/API）；
 *   2. `Host` 精确命中实例 `hostnames[]` → 代理该实例（路径原样透传）；
 *   3. 路径前缀 `/i/<idOrSlug>/` → 剥前缀代理；`/i/<idOrSlug>`（无尾斜杠）→ 302 补斜杠；
 *   4. 其它 → daemon app（SPA fallback / 404）。
 *
 * 反代语义（§3.1/§3.2）：
 *   - GET/HEAD **不传 body**（传 `req.body` 会炸）；
 *   - 请求头：删 hop-by-hop → 删客户端自带的 `x-stoa-service`/`x-stoa-daemon-proxy`/`cookie`
 *     → 注入 `x-stoa-service:<slug>`、`x-stoa-daemon-proxy:<serviceId>`；**不注入 `x-forwarded-*`**；
 *   - `authorization`/`x-report-account` 在 P1 **透传**（实例凭据注入是 P2/S3-4，见 `injectServiceCredentials` seam）；
 *   - 响应：透传 status/headers，但删 `content-encoding`/`content-length`（Bun fetch 会解压上游
 *     body 却保留这两个头）与 hop-by-hop；**不注入 CORS**；
 *   - SSE/流式：`return new Response(upstream.body, …)` 不缓冲；普通请求 60s 超时，
 *     `text/event-stream` 与下载不设上限；
 *   - 实例不可达 → 502 + 可读原因（实例名/slug/状态/重启指引），不静默回落控制台。
 */
import { readServices, findServiceByIdOrSlug, findServiceByHostname, type ServiceRecord } from "./state.ts";
import { BASE_DAEMON_HOSTS, hostHeaderName, normalizeHostname } from "./slug.ts";
import { instanceFetch, type InstanceEndpoint } from "../server/instance-client.ts";

/** 普通（非流式/非下载）反代请求的超时预算。 */
export const PROXY_TIMEOUT_MS = 60_000;

/** 反代注入的服务标记头（实例侧据此识别 daemon 代理）。 */
export const SERVICE_HEADER = "x-stoa-service";
export const DAEMON_PROXY_HEADER = "x-stoa-daemon-proxy";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

export interface DaemonRouterOptions {
  stateDir: string;
  /** daemon 自己占用的 host 集合（`BASE_DAEMON_HOSTS` ∪ `--host`）。 */
  daemonHosts?: Iterable<string>;
  /** daemon 自己的 app fetch（Hono 实例的 fetch）。 */
  appFetch: (req: Request) => Response | Promise<Response>;
  log?: (line: string) => void;
  /** 覆盖普通请求超时（测试用）。 */
  timeoutMs?: number;
}

export type DaemonRouter = (req: Request) => Promise<Response>;

/** 归一化后的 daemon host 集合（小写、去端口、去尾点）。 */
export function daemonHostSet(extra: Iterable<string> = []): Set<string> {
  const out = new Set<string>();
  for (const host of BASE_DAEMON_HOSTS) out.add(normalizeHostname(host));
  for (const host of extra) {
    const name = normalizeHostname(host);
    if (name) out.add(name);
  }
  return out;
}

function isHopByHop(name: string): boolean {
  const lower = name.toLowerCase();
  return HOP_BY_HOP.has(lower) || lower.startsWith("proxy-");
}

/**
 * P1 的凭据 seam：daemon 尚未实现账号/会话，因此**不注入**、`authorization`/
 * `x-report-account` 原样透传（浏览器直连实例的 open 模式身份/令牌继续可用）。
 * P2/S3-4 会在这里改成：先删客户端自带凭据，再按 `record.authAccount` 读实例 0600 env
 * 注入 `Authorization: Bearer …` + `x-report-account`。
 */
function injectServiceCredentials(headers: Headers, record: ServiceRecord): void {
  void headers;
  void record;
}

function requestHeadersFor(req: Request, record: ServiceRecord): Headers {
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (isHopByHop(lower)) return;
    // 防冒充：客户端自带的代理标记一律丢弃，由 daemon 重新注入。
    if (lower === SERVICE_HEADER || lower === DAEMON_PROXY_HEADER) return;
    // daemon 会话 cookie（P2 引入）不得泄漏给实例；实例生产代码只认 Bearer/开放模式头。
    if (lower === "cookie") return;
    headers.set(lower, value);
  });
  injectServiceCredentials(headers, record);
  headers.set(SERVICE_HEADER, record.slug);
  headers.set(DAEMON_PROXY_HEADER, record.id);
  return headers;
}

function responseHeadersFor(upstream: Response): Headers {
  const headers = new Headers();
  const hasGetSetCookie = typeof upstream.headers.getSetCookie === "function";
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (isHopByHop(lower)) return;
    // Bun/Node fetch 都会解压上游 body，却可能保留这两个头（下游可能报 ZlibError）。
    if (lower === "content-encoding" || lower === "content-length") return;
    if (lower === "set-cookie" && hasGetSetCookie) return;
    headers.append(lower, value);
  });
  if (hasGetSetCookie) {
    for (const cookie of upstream.headers.getSetCookie()) headers.append("set-cookie", cookie);
  }
  return headers;
}

/** 流式/下载类请求不设超时：SSE 长连接与媒体下载天然超过 60s。 */
function isUnboundedRequest(req: Request, pathname: string): boolean {
  const accept = (req.headers.get("accept") ?? "").toLowerCase();
  if (accept.includes("text/event-stream")) return true;
  if (req.headers.has("range")) return true;
  return (
    pathname === "/api/stream" ||
    pathname.startsWith("/api/stream/") ||
    pathname.startsWith("/api/media/") ||
    pathname.startsWith("/media/")
  );
}

/**
 * 代理端点：UDS 实例只看 `socket`；收编的 standalone 实例用 `port` + TCP `url`。
 * 托管实例没有 socket（停止/启动中）时返回空端点 → 502 NO_ENDPOINT，
 * **绝不**把逻辑链接 `/i/<slug>/` 当机器通道拨回 daemon 自己。
 */
function endpointFor(record: ServiceRecord): InstanceEndpoint {
  if (record.socket) return { unix: record.socket };
  if (typeof record.port === "number") return { port: record.port, url: record.url ?? null };
  return {};
}

function proxyErrorResponse(record: ServiceRecord, err: unknown): Response {
  const detail = err instanceof Error ? err.message : String(err);
  const body = {
    ok: false,
    code: "INSTANCE_UNREACHABLE",
    error:
      `实例「${record.name}」(${record.slug}) 当前不可达：${detail}。` +
      ` 请在 daemon 控制台停止该服务后重新打开（或重新运行 stoa serve）以重建实例通道。`,
    service: { id: record.id, slug: record.slug, status: record.status },
  };
  return new Response(JSON.stringify(body), {
    status: 502,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function notFoundResponse(idOrSlug: string): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      code: "SERVICE_NOT_FOUND",
      error: `没有匹配「${idOrSlug}」的实例（按 id 或 slug 精确匹配）`,
    }),
    {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

/** 代理一次请求：`prefix` 为要剥掉的路径前缀（Host 模式为空）。 */
export async function proxyToService(
  req: Request,
  record: ServiceRecord,
  opts: { prefix?: string; timeoutMs?: number } = {},
): Promise<Response> {
  const url = new URL(req.url);
  const prefix = opts.prefix ?? "";
  let pathname = url.pathname;
  if (prefix && pathname.startsWith(prefix)) {
    pathname = pathname.slice(prefix.length) || "/";
  }
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  const target = `${pathname}${url.search}`;
  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const timeoutMs = isUnboundedRequest(req, pathname) ? null : (opts.timeoutMs ?? PROXY_TIMEOUT_MS);

  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: requestHeadersFor(req, record),
    body: hasBody ? (req.body ?? undefined) : undefined,
    signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
  };
  // 流式请求体（浏览器上传）在 Node fetch 语义下需要 duplex；Bun 也接受该字段。
  if (hasBody && init.body) init.duplex = "half";

  try {
    const upstream = await instanceFetch(endpointFor(record), target, init);
    const status = upstream.status;
    const headers = responseHeadersFor(upstream);
    // SSE / 下载：直接把上游流交给下游，不缓冲、不读取。
    // 204/205/304 与 HEAD 必须 null body（Node 对带 body 的 204 抛 TypeError；HEAD 不发 body）。
    const noBody =
      method === "HEAD" || status === 204 || status === 205 || status === 304;
    const body = noBody ? null : upstream.body;
    return new Response(body, { status, headers });
  } catch (err) {
    // 不可达（ENOENT/ECONNREFUSED/socket 超时）与其它传输错误一律 502：绝不静默回落控制台。
    return proxyErrorResponse(record, err);
  }
}

/**
 * 创建 daemon 路由：返回的 fetch 直接交给 `Bun.serve`。
 * 注意：反代响应绕过 Hono 中间件，因此**不会**带上 daemon 的 CORS 头（§3.2 要求）。
 */
export function createDaemonRouter(opts: DaemonRouterOptions): DaemonRouter {
  const hosts = daemonHostSet(opts.daemonHosts ?? []);
  const log = opts.log ?? (() => {});

  /** 路径模式 `/i/<idOrSlug>/`（3）：任何 Host 上都生效——daemon host 上的 `/i/…`
   *  就是实例入口（否则路径模式在默认入口上永远不可达）。 */
  const pathRoute = async (req: Request, url: URL): Promise<Response | null> => {
    const match = /^\/i\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return null;
    const rawKey = match[1]!;
    const rest = match[2] ?? "";
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      key = rawKey;
    }
    if (!rest) {
      // `/i/<key>` → `/i/<key>/`：页面里的相对资源按带斜杠的基址解析。
      return new Response(null, {
        status: 302,
        headers: { location: `/i/${rawKey}/${url.search}`, "cache-control": "no-store" },
      });
    }
    const services = readServices(opts.stateDir);
    const record = findServiceByIdOrSlug(services, key);
    if (!record) {
      log(`proxy 404: no instance matches ${key}`);
      return notFoundResponse(key);
    }
    return await proxyToService(req, record, {
      prefix: `/i/${rawKey}`,
      timeoutMs: opts.timeoutMs,
    });
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const host = hostHeaderName(req.headers.get("host"));
    const onDaemonHost = !host || hosts.has(host);

    // 2. 实例自定义 hostname（Host 模式：路径原样透传）。
    if (!onDaemonHost) {
      const byHost = findServiceByHostname(readServices(opts.stateDir), host);
      if (byHost) return await proxyToService(req, byHost, { timeoutMs: opts.timeoutMs });
    }

    // 3. 路径模式 `/i/<idOrSlug>/`（含 daemon host 自身：默认入口必须能开实例）。
    const routed = await pathRoute(req, url);
    if (routed) return routed;

    // 1/4. daemon host → daemon app；未知 host 的其它路径同样回落 app（SPA/404）。
    return await opts.appFetch(req);
  };
}

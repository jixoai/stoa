/**
 * daemon 单入口路由与反向代理（daemon-unified-port design §2/§3/§4.1/§5）。
 *
 * 四优先级（顺序固定）：
 *   1. `Host` 精确命中实例 `hostnames[]` → 代理该实例（路径原样透传）；
 *   2. 路径前缀 `/i/<idOrSlug>/` → 剥前缀代理；`/i/<idOrSlug>`（无尾斜杠）→ 302 补斜杠；
 *      **对任何 Host 都生效（含 daemon host）**；
 *   3. `Host` ∈ daemon host 集合（否则未知 Host 的其它路径）→ daemon app（SPA/404）。
 *
 * 路由门（P2/S3-3，先于一切路由执行，daemon app 与反代同等对待）：
 *   见 `gate.ts` 的豁免清单与机器通道 Host 条件；未登录页面 302 `/login?next=`，API 401 JSON。
 *
 * 反代语义（§3.1/§3.2）：
 *   - GET/HEAD **不传 body**（传 `req.body` 会炸）；有 body 的请求缓冲 ≤8 MiB 以便
 *     凭据兜底后重放（超过上限则流式直传、不重放）；
 *   - 请求头：删 hop-by-hop → 删客户端自带的 `authorization`/`x-report-account`/`cookie`/
 *     `x-stoa-*`（防冒充）→ 注入实例凭据（§5）→ 注入 `x-stoa-service`/`x-stoa-daemon-proxy`；
 *     **不注入 `x-forwarded-*`**；
 *   - 实例 401 → `fallbackAccessToken`（读实例口令登录）→ 重放一次；仍 401 → 502
 *     「实例凭据不可用（daemon 代理）」（`/api/auth/login` 自身除外：401 语义透传）；
 *   - `/i/<slug>/healthz`（含 Host 模式 `/healthz`）响应体过滤为
 *     `{ok,instanceId,dataDir,uiVersion}`——健康探测不泄漏数据面；
 *   - 响应：透传 status/headers，但删 `content-encoding`/`content-length`（Bun fetch 会解压上游
 *     body 却保留这两个头）与 hop-by-hop；**不注入 CORS**；
 *   - SSE/流式：`return new Response(upstream.body, …)` 不缓冲；普通请求 60s 超时，
 *     `text/event-stream` 与下载不设上限；
 *   - 实例不可达 → 502 + 可读原因（实例名/slug/状态/重启指引），不静默回落控制台。
 */
import { readServices, findServiceByIdOrSlug, findServiceByHostname, type ServiceRecord } from "./state.ts";
import { BASE_DAEMON_HOSTS, hostHeaderName, normalizeHostname } from "./slug.ts";
import { instanceFetch, type InstanceEndpoint } from "../server/instance-client.ts";
import { decideDaemonGate, loginLocationFor } from "./gate.ts";
import {
  applyServiceCredentials,
  credentialUnavailableMessage,
  fallbackAccessToken,
  serviceEndpoint,
} from "./credentials.ts";

/** 普通（非流式/非下载）反代请求的超时预算。 */
export const PROXY_TIMEOUT_MS = 60_000;
/** 可重放的请求体上限（凭据兜底后重放需要内存缓冲；媒体上限 2 MiB，8 MiB 够用）。 */
export const PROXY_RETRY_BODY_LIMIT = 8 * 1024 * 1024;

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

/** 路由门所需的最小鉴权面（`DaemonAuth` 天然满足）。 */
export interface DaemonRouterAuth {
  authenticated(req: Request): boolean;
}

/** Bun `server.requestIP(req)` 的最小形状（测试可直接给）。 */
export interface DaemonPeer {
  address: string | null;
}

export interface DaemonRouterOptions {
  stateDir: string;
  /** daemon 自己占用的 host 集合（`BASE_DAEMON_HOSTS` ∪ `--host`）。 */
  daemonHosts?: Iterable<string>;
  /** daemon 自己的 app fetch（Hono 实例的 fetch）。 */
  appFetch: (req: Request) => Response | Promise<Response>;
  log?: (line: string) => void;
  /** 覆盖普通请求超时（测试用）。 */
  timeoutMs?: number;
  /** 会话校验（路由门）。**必填**：缺省即编译期拒绝，避免误配成无门 daemon。 */
  auth: DaemonRouterAuth;
  /** 凭据兜底/缓存时钟（测试注入）。 */
  now?: () => number;
}

export type DaemonRouter = (req: Request, peer?: DaemonPeer | null) => Promise<Response>;

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

function requestHeadersFor(req: Request, record: ServiceRecord): Headers {
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (isHopByHop(lower)) return;
    // 防冒充：客户端自带的代理标记一律丢弃，由 daemon 重新注入。
    if (lower === SERVICE_HEADER || lower === DAEMON_PROXY_HEADER) return;
    // 客户端身份/凭据一律丢弃：daemon 注入自己的（open 模式的 x-report-account 是声明式
    // 身份，透传=越权；Bearer 透传=绕过凭据注入）。
    if (lower === "authorization" || lower === "x-report-account") return;
    // daemon 会话 cookie 不得泄漏给实例；实例生产代码只认 Bearer/开放模式头。
    if (lower === "cookie") return;
    headers.set(lower, value);
  });
  applyServiceCredentials(headers, record);
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function proxyErrorResponse(record: ServiceRecord, err: unknown): Response {
  const detail = err instanceof Error ? err.message : String(err);
  return jsonResponse(502, {
    ok: false,
    code: "INSTANCE_UNREACHABLE",
    error:
      `实例「${record.name}」(${record.slug}) 当前不可达：${detail}。` +
      ` 请在 daemon 控制台停止该服务后重新打开（或重新运行 stoa serve）以重建实例通道。`,
    service: { id: record.id, slug: record.slug, status: record.status },
  });
}

function credentialErrorResponse(record: ServiceRecord, detail: string | null): Response {
  return jsonResponse(502, {
    ok: false,
    code: "SERVICE_CREDENTIALS_UNAVAILABLE",
    error: credentialUnavailableMessage(record, detail),
    proxied: true,
    service: { id: record.id, slug: record.slug, status: record.status },
  });
}

function notFoundResponse(idOrSlug: string): Response {
  return jsonResponse(404, {
    ok: false,
    code: "SERVICE_NOT_FOUND",
    error: `没有匹配「${idOrSlug}」的实例（按 id 或 slug 精确匹配）`,
  });
}

function unauthorizedResponse(): Response {
  return jsonResponse(401, {
    ok: false,
    code: "UNAUTHORIZED",
    error: "daemon 登录已失效或未登录（浏览器访问 /login，API 请带 daemon 会话 cookie）",
  });
}

function redirectLogin(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}

interface ProxyBody {
  /** 第一次请求用的 body。 */
  body: BodyInit | undefined;
  /** 可重放的缓冲（null = 不可重放：GET/HEAD 之外的大 body）。 */
  buffered: Uint8Array | null;
  /** true = 请求带 body 但没有可重放缓冲。 */
  streamed: boolean;
}

/** 准备 request body：≤8 MiB 缓冲（可重放），超过则流式直传。 */
async function prepareBody(req: Request, method: string): Promise<ProxyBody> {
  if (method === "GET" || method === "HEAD") {
    return { body: undefined, buffered: null, streamed: false };
  }
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > PROXY_RETRY_BODY_LIMIT) {
    return { body: req.body ?? undefined, buffered: null, streamed: true };
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) return { body: undefined, buffered: bytes, streamed: false };
  // TS 的 BodyInit 对 Uint8Array<ArrayBufferLike> 过窄；两个 runtime 都接受字节体。
  return { body: bytes as unknown as BodyInit, buffered: bytes, streamed: false };
}

/**
 * `/i/<slug>/healthz` 的健康体过滤（design §4.1）：只回 `{ok,instanceId,dataDir,uiVersion}`。
 * 非 200 / 非 JSON 原样透传（不可达仍由 catch 映射 502）。
 */
async function filterHealthBody(upstream: Response, headers: Headers): Promise<Response> {
  const text = await upstream.text();
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (upstream.status === 200 && body && body.ok === true) {
    return jsonResponse(200, {
      ok: true,
      instanceId: body.instanceId ?? null,
      dataDir: body.dataDir ?? null,
      uiVersion: body.uiVersion ?? body.version ?? null,
    });
  }
  return new Response(text, { status: upstream.status, headers });
}

/** 代理一次请求：`prefix` 为要剥掉的路径前缀（Host 模式为空）。 */
export async function proxyToService(
  req: Request,
  record: ServiceRecord,
  opts: {
    prefix?: string;
    timeoutMs?: number;
    /** 健康检查体过滤（`/i/<slug>/healthz` 与 Host 模式 `/healthz`）。 */
    healthz?: boolean;
    now?: () => number;
  } = {},
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
  const endpoint = endpointFor(record);
  const headers = requestHeadersFor(req, record);
  const prepared = await prepareBody(req, method);

  const signal = timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs);
  const send = (body: BodyInit | undefined, stream: boolean): Promise<Response> => {
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      body: hasBody ? body : undefined,
      signal,
    };
    // 流式请求体（浏览器上传）在 Node fetch 语义下需要 duplex；Bun 也接受该字段。
    if (hasBody && body && stream) init.duplex = "half";
    return instanceFetch(endpoint, target, init);
  };

  try {
    let upstream = await send(prepared.body, prepared.streamed);
    // 401 兜底：env 缺失/token 轮换 → 读实例口令登录换 access token 后重放一次。
    // `/api/auth/login` 的 401 是「口令不对」的语义，必须原样透传。
    if (upstream.status === 401 && pathname !== "/api/auth/login") {
      await upstream.body?.cancel().catch(() => undefined);
      if (prepared.buffered === null) {
        return credentialErrorResponse(record, "请求体过大，凭据刷新后无法重放该请求");
      }
      const token = await fallbackAccessToken(record, { now: opts.now, endpoint });
      if (token) {
        headers.set("authorization", `Bearer ${token}`);
        upstream = await send(
          prepared.buffered.byteLength > 0
            ? (prepared.buffered as unknown as BodyInit)
            : undefined,
          false,
        );
      }
      if (upstream.status === 401) {
        await upstream.body?.cancel().catch(() => undefined);
        return credentialErrorResponse(record, null);
      }
    }
    const status = upstream.status;
    const responseHeaders = responseHeadersFor(upstream);
    if (opts.healthz) return await filterHealthBody(upstream, responseHeaders);
    // SSE / 下载：直接把上游流交给下游，不缓冲、不读取。
    // 204/205/304 与 HEAD 必须 null body（Node 对带 body 的 204 抛 TypeError；HEAD 不发 body）。
    const noBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
    const body = noBody ? null : upstream.body;
    return new Response(body, { status, headers: responseHeaders });
  } catch (err) {
    // 不可达（ENOENT/ECONNREFUSED/socket 超时）与其它传输错误一律 502：绝不静默回落控制台。
    return proxyErrorResponse(record, err);
  }
}

/**
 * 创建 daemon 路由：返回的 fetch 直接交给 `Bun.serve`（`peer` 来自 `server.requestIP`）。
 * 注意：反代响应绕过 Hono 中间件，因此**不会**带上 daemon 的 CORS 头（§3.2 要求）。
 */
export function createDaemonRouter(opts: DaemonRouterOptions): DaemonRouter {
  const hosts = daemonHostSet(opts.daemonHosts ?? []);
  const log = opts.log ?? (() => {});

  return async (req: Request, peer: DaemonPeer | null = null): Promise<Response> => {
    const url = new URL(req.url);
    const host = hostHeaderName(req.headers.get("host"));
    const onDaemonHost = !host || hosts.has(host);
    const services = readServices(opts.stateDir);
    const byHost = onDaemonHost ? null : findServiceByHostname(services, host);

    // 路由门：先于一切路由（daemon app 与 /i/ 反代同等对待）。
    const gate = decideDaemonGate({
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      host,
      peerAddress: peer?.address ?? null,
      authenticated: opts.auth.authenticated(req),
      hostRoutesToInstance: byHost !== null,
    });
    if (gate.action === "login") return redirectLogin(gate.location);
    if (gate.action === "unauthorized") return unauthorizedResponse();

    // 1. 实例自定义 hostname（Host 模式：路径原样透传）。
    if (byHost) {
      return await proxyToService(req, byHost, {
        timeoutMs: opts.timeoutMs,
        healthz: url.pathname === "/healthz",
        now: opts.now,
      });
    }

    // 2. 路径模式 `/i/<idOrSlug>/`（含 daemon host 自身：默认入口必须能开实例）。
    const match = /^\/i\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match) {
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
      const record = findServiceByIdOrSlug(services, key);
      if (!record) {
        log(`proxy 404: no instance matches ${key}`);
        return notFoundResponse(key);
      }
      return await proxyToService(req, record, {
        prefix: `/i/${rawKey}`,
        timeoutMs: opts.timeoutMs,
        healthz: rest === "/healthz",
        now: opts.now,
      });
    }

    // 3. daemon host → daemon app；未知 host 的其它路径同样回落 app（SPA/404）。
    return await opts.appFetch(req);
  };
}

/** 供 app 层复用：未登录 JSON 401 的形状（保持两端一致）。 */
export function daemonUnauthorizedResponse(): Response {
  return unauthorizedResponse();
}

/** 供测试/诊断：登录跳转地址（与 gate 同口径）。 */
export function daemonLoginLocation(pathname: string, search = ""): string {
  return loginLocationFor(pathname, search);
}

/** 记录端点（server.json 优先）——代理外的调用方（凭据兜底）共用。 */
export function proxyEndpointOf(record: ServiceRecord): InstanceEndpoint {
  return serviceEndpoint(record);
}

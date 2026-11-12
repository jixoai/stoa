/**
 * 实例通道（daemon-unified-port design §1.2/§1.4，P1）。
 *
 * 机器消费者（CLI / MCP / adapters / dsh / QA）访问实例的唯一入口：
 *   - `info.unix` 存在 → **Unix domain socket**（daemon 托管实例，不占 TCP）；
 *   - 否则 → `info.url`（standalone 实例的 TCP origin）。
 *
 * 关键实现约束（2026-11-12 设计复核实测）：**不能**用 `fetch(url,{unix})`——
 * Node 26 的全局 fetch 忽略 `unix` 选项并静默拨 `127.0.0.1:80`（拿到无关服务的 404）。
 * 因此 UDS 通道用 `node:http` 的 `request({socketPath})` + `Readable.toWeb`，
 * 在 Bun 与 Node 两个 runtime 下行为一致；TCP 通道仍走全局 `fetch`。
 *
 * 不可达统一抛 `InstanceUnreachableError`（带 `code`：ENOENT/ECONNREFUSED/…）；
 * 探测类调用方自己 catch 并映射为「实例不可达」。
 */
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import type { ServerInfo } from "./discovery.ts";

/** 实例端点：UDS 优先，其次 URL/端口（`ServerInfo` 天然满足该形状）。 */
export interface InstanceEndpoint {
  unix?: string | null;
  url?: string | null;
  port?: number | null;
}

/** 绑定到某个实例的请求函数（target 可为 `/path` 或绝对 http(s) URL）。 */
export type InstanceChannel = (target: string, init?: RequestInit) => Promise<Response>;

export class InstanceUnreachableError extends Error {
  readonly code: string;
  readonly transport: "unix" | "tcp";
  readonly socket: string | null;

  constructor(
    message: string,
    opts: { code?: string; transport: "unix" | "tcp"; socket?: string | null; cause?: unknown },
  ) {
    super(message);
    this.name = "InstanceUnreachableError";
    this.code = opts.code ?? "UNREACHABLE";
    this.transport = opts.transport;
    this.socket = opts.socket ?? null;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export function isInstanceUnreachable(err: unknown): err is InstanceUnreachableError {
  return err instanceof InstanceUnreachableError;
}

/** 从任意错误里抽取可识别的连接错误码（ENOENT/ECONNREFUSED/…）。 */
export function unreachableCodeOf(err: unknown): string | null {
  if (err instanceof InstanceUnreachableError) return err.code;
  const read = (value: unknown): string | null => {
    if (typeof value !== "object" || value === null) return null;
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  };
  return read(err) ?? read((err as { cause?: unknown } | null)?.cause);
}

/** 端点是否走 UDS（daemon 托管）。 */
export function instanceUsesUnix(info: InstanceEndpoint | null | undefined): boolean {
  return Boolean(info && typeof info.unix === "string" && info.unix.trim() !== "");
}

/**
 * 实例的 TCP 基址：显式 `url` 优先，其次 `port`。
 * UDS 端点没有 TCP 地址（返回空串），调用方必须先用 `instanceUsesUnix` 分支。
 */
export function instanceBaseUrl(info: InstanceEndpoint | null | undefined): string {
  if (!info) return "";
  const url = (info.url ?? "").trim();
  if (url && !url.startsWith("unix:")) return url.replace(/\/+$/, "");
  if (typeof info.port === "number") return `http://127.0.0.1:${info.port}`;
  return "";
}

/** 目标归一化为 `path?query`（绝对 URL 取其 pathname+search）。 */
export function instanceRequestPath(target: string): string {
  const raw = String(target ?? "");
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    return `${url.pathname}${url.search}`;
  }
  if (!raw.startsWith("/")) return `/${raw}`;
  return raw;
}

function headersToRecord(input: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  new Headers(input).forEach((value, key) => {
    const lower = key.toLowerCase();
    // 上游一律按 identity 取回：不做压缩协商，代理层再按 §3.2 删 content-encoding。
    if (lower === "accept-encoding") return;
    if (lower === "host" || lower === "content-length" || lower === "connection") return;
    out[lower] = value;
  });
  return out;
}

function isStreamBody(body: BodyInit | null | undefined): body is ReadableStream<Uint8Array> {
  return typeof body === "object" && body !== null && typeof (body as ReadableStream).getReader === "function";
}

/** 把请求体转成 Buffer（字符串/字节/Blob/URLSearchParams）；流式体单独处理。 */
async function bodyToBuffer(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return Buffer.from(body.toString());
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const res = new Response(body);
    return Buffer.from(await res.arrayBuffer());
  }
  return null;
}

function connectionErrorCode(err: unknown): string {
  const code = unreachableCodeOf(err);
  return code ?? "UNREACHABLE";
}

function timeoutError(): Error {
  const err = new Error("instance request aborted");
  err.name = "AbortError";
  return err;
}

/** UDS 通道：node:http `request({socketPath})` → web Response（Bun/Node 通用）。 */
async function unixFetch(
  socketPath: string,
  target: string,
  init: RequestInit = {},
): Promise<Response> {
  const path = instanceRequestPath(target);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = headersToRecord(init.headers);
  const streamBody = isStreamBody(init.body) ? init.body : null;
  const buffered = streamBody ? null : await bodyToBuffer(init.body);
  if (buffered) headers["content-length"] = String(buffered.byteLength);

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      const code = connectionErrorCode(err);
      reject(
        new InstanceUnreachableError(
          `instance socket ${socketPath} is unreachable (${code}): ${(err as Error)?.message ?? String(err)}`,
          { code, transport: "unix", socket: socketPath, cause: err },
        ),
      );
    };
    const req = httpRequest({ socketPath, path, method, headers }, (res) => {
      if (settled) return;
      settled = true;
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers as IncomingHttpHeaders)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
        else responseHeaders.set(key, value);
      }
      const status = res.statusCode ?? 502;
      // 204/205/304 与 HEAD 一律 null body：Node 的 Response 构造器对带 body 的 204 直接
      // TypeError（Bun 不抛）——跨 runtime 一致必须显式判。
      const noBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
      const body = noBody
        ? null
        : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
      resolve(new Response(body, { status, headers: responseHeaders }));
    });
    req.on("error", fail);
    const signal = init.signal ?? null;
    if (signal) {
      if (signal.aborted) {
        fail(timeoutError());
        req.destroy();
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          fail(timeoutError());
          req.destroy();
        },
        { once: true },
      );
    }
    if (streamBody) {
      const nodeStream = Readable.fromWeb(streamBody as unknown as Parameters<typeof Readable.fromWeb>[0]);
      nodeStream.on("error", fail);
      nodeStream.pipe(req);
    } else {
      if (buffered) req.write(buffered);
      req.end();
    }
  });
}

/**
 * 实例请求的唯一入口。
 * @param info 端点（`server.json` 的 `ServerInfo` 即可）
 * @param target `/api/who` 或绝对 URL（取 pathname+search）
 * @param init fetch 语义的 RequestInit（signal 走同样的超时/取消语义）
 */
export async function instanceFetch(
  info: InstanceEndpoint,
  target: string,
  init: RequestInit = {},
): Promise<Response> {
  if (instanceUsesUnix(info)) return await unixFetch(String(info.unix), target, init);
  const base = instanceBaseUrl(info);
  if (!base) {
    throw new InstanceUnreachableError("instance endpoint has neither unix socket nor url/port", {
      code: "NO_ENDPOINT",
      transport: "tcp",
    });
  }
  try {
    return await fetch(`${base}${instanceRequestPath(target)}`, init);
  } catch (err) {
    const code = connectionErrorCode(err);
    throw new InstanceUnreachableError(
      `instance at ${base} is unreachable (${code}): ${(err as Error)?.message ?? String(err)}`,
      { code, transport: "tcp", cause: err },
    );
  }
}

/** 把 `instanceFetch` 绑定到端点，供需要 `(path, init)=>Response` 的客户端使用。 */
export function instanceChannel(info: InstanceEndpoint): InstanceChannel {
  return (target, init) => instanceFetch(info, target, init);
}

/** 便捷判断：该端点是否可达（探测类调用，绝不抛错）。 */
export async function instanceReachable(endpoint: InstanceEndpoint): Promise<boolean> {
  try {
    const res = await instanceFetch(endpoint, "/healthz", { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 服务记录（daemon registry）→ 端点：优先 UDS `socket`；收编的 standalone 实例用
 * `port` + TCP `url`。**daemon 托管但当前没有 socket**（已停止/启动中）的登记返回空端点——
 * 它的 `url` 是 `/i/<slug>/` 逻辑链接（会绕回 daemon 自己），绝不能当机器通道拨号。
 */
export function endpointOfRecord(record: {
  socket?: string | null;
  url?: string | null;
  port?: number | null;
}): InstanceEndpoint {
  const port = typeof record.port === "number" ? record.port : null;
  return {
    unix: record.socket ?? null,
    url: port === null ? null : (record.url ?? null),
    port,
  };
}

/** `ServerInfo` → 端点（类型收窄，读起来比裸传更清楚）。 */
export function endpointOfInfo(
  info: Pick<ServerInfo, "unix" | "url" | "port"> | null | undefined,
): InstanceEndpoint {
  if (!info) return {};
  return { unix: info.unix ?? null, url: info.url ?? null, port: info.port ?? null };
}

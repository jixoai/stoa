/**
 * 有界抓取器（design §6.2 / §7.3 / P1-9）。
 *
 * - HEAD 优先、GET 回退（405/501/网络错误/缺 content-type）；
 * - 重定向 ≤5 跳、逐跳重验 SSRF、拒绝 https→http；
 * - 3s HEAD / 8s 总截止 / socket idle 3s / `Accept-Encoding: identity`；
 * - 页面 512KiB、声明 >2MiB 直接 blocked_size；媒体只读前 512B（最多 64KiB）；
 * - 不发 Cookie/Authorization/Referer，不保存 Set-Cookie，忽略代理环境变量；
 * - DNS 一次解析 + IP pinning（连接层不再解析）。
 */
import { request as httpRequest, type IncomingMessage, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { PreviewErrorCode, PreviewFetchResponse, PreviewTransport, TransportContext } from "../../core/plugins/types.ts";
import {
  PreviewPolicyError,
  normalizeIpLiteral,
  resolvePinnedTarget,
  validatePreviewUrl,
  type LookupFn,
  type ResolvedTarget,
} from "./ssrf.ts";

export const PREVIEW_USER_AGENT = "fde2e-report-link-preview/1.0";
export const MAX_REDIRECTS = 5;
export const HEAD_TIMEOUT_MS = 3000;
export const TOTAL_TIMEOUT_MS = 8000;
export const SOCKET_IDLE_TIMEOUT_MS = 3000;
export const MAX_PAGE_BYTES = 512 * 1024;
export const MAX_DECLARED_BYTES = 2 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 64 * 1024;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export class PreviewFetchError extends Error {
  readonly code: PreviewErrorCode;
  constructor(code: PreviewErrorCode, message: string) {
    super(message);
    this.name = "PreviewFetchError";
    this.code = code;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PreviewFetchError("timeout", "aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new PreviewFetchError("timeout", "aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 每域名令牌桶 1 req/s（突发 2）+ 429/503 冷却 60s（design §6.6）。
 */
export class DomainRateLimiter {
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly cooldowns = new Map<string, number>();

  constructor(opts: { ratePerSec?: number; burst?: number; now?: () => number } = {}) {
    this.ratePerSec = opts.ratePerSec ?? 1;
    this.burst = opts.burst ?? 2;
    this.now = opts.now ?? Date.now;
  }

  cooldown(host: string, ms: number): void {
    this.cooldowns.set(host, this.now() + ms);
  }

  cooldownUntil(host: string): number {
    return this.cooldowns.get(host) ?? 0;
  }

  /** 等到可用令牌；冷却中先睡到冷却结束。 */
  async take(host: string, signal?: AbortSignal): Promise<void> {
    const cooldownUntil = this.cooldowns.get(host) ?? 0;
    const now = this.now();
    if (cooldownUntil > now) await sleep(cooldownUntil - now, signal);
    for (;;) {
      const tick = this.now();
      const bucket = this.buckets.get(host) ?? { tokens: this.burst, at: tick };
      const refill = ((tick - bucket.at) / 1000) * this.ratePerSec;
      bucket.tokens = Math.min(this.burst, bucket.tokens + refill);
      bucket.at = tick;
      this.buckets.set(host, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(1000 / this.ratePerSec), signal);
    }
  }
}

export interface HttpPreviewTransportOptions {
  /** QA 精确 origin 白名单（仅回环、非曝光；由 serve.ts 决定是否传入）。 */
  testAllowOrigins?: readonly string[];
  allowedPorts?: readonly number[];
  lookup?: LookupFn;
  rateLimiter?: DomainRateLimiter | null;
  now?: () => number;
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | null;
  final_url: string;
}

export class HttpPreviewTransport implements PreviewTransport {
  private readonly testOrigins: Set<string>;
  private readonly allowedPorts: readonly number[];
  private readonly lookup: LookupFn | undefined;
  private readonly limiter: DomainRateLimiter | null;
  private readonly now: () => number;

  constructor(opts: HttpPreviewTransportOptions = {}) {
    this.testOrigins = new Set(opts.testAllowOrigins ?? []);
    this.allowedPorts = opts.allowedPorts ?? [];
    this.lookup = opts.lookup;
    this.limiter = opts.rateLimiter === undefined ? new DomainRateLimiter() : opts.rateLimiter;
    this.now = opts.now ?? Date.now;
  }

  async head(url: string, ctx: TransportContext = {}): Promise<PreviewFetchResponse> {
    let head: RawResponse | null = null;
    try {
      head = await this.execute(url, {
        method: "HEAD",
        maxBytes: 0,
        declaredMax: MAX_DECLARED_BYTES,
        signal: ctx.signal,
        deadlineAt: ctx.deadlineAt,
        timeoutMs: HEAD_TIMEOUT_MS,
        tolerateStatuses: [405, 501],
      });
    } catch (err) {
      if (err instanceof PreviewPolicyError || err instanceof PreviewFetchError) {
        if (err instanceof PreviewFetchError && err.code !== "network") throw err;
        if (err instanceof PreviewPolicyError) throw err;
      }
    }
    if (head && head.status !== 405 && head.status !== 501 && head.headers["content-type"]) {
      return head;
    }
    return this.execute(url, {
      method: "GET",
      maxBytes: MAX_PAGE_BYTES,
      declaredMax: MAX_DECLARED_BYTES,
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
      timeoutMs: TOTAL_TIMEOUT_MS,
    });
  }

  async page(url: string, ctx: TransportContext = {}): Promise<PreviewFetchResponse> {
    return this.execute(url, {
      method: "GET",
      maxBytes: MAX_PAGE_BYTES,
      declaredMax: MAX_DECLARED_BYTES,
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
      timeoutMs: TOTAL_TIMEOUT_MS,
    });
  }

  async probe(url: string, ctx: TransportContext = {}): Promise<PreviewFetchResponse> {
    const response = await this.execute(url, {
      method: "GET",
      range: "bytes=0-511",
      maxBytes: MAX_MEDIA_BYTES,
      declaredMax: Number.POSITIVE_INFINITY,
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
      timeoutMs: TOTAL_TIMEOUT_MS,
    });
    // 忽略 Range 的服务器会回 200 全量：只保留前 64KiB 嗅探。
    if (response.body && response.body.byteLength > MAX_MEDIA_BYTES) {
      return { ...response, body: response.body.slice(0, MAX_MEDIA_BYTES) };
    }
    return response;
  }

  private isTestOrigin(origin: string): boolean {
    return this.testOrigins.has(origin);
  }

  private async execute(
    rawUrl: string,
    opts: {
      method: "HEAD" | "GET";
      range?: string;
      maxBytes: number;
      declaredMax: number;
      signal?: AbortSignal;
      deadlineAt?: number;
      timeoutMs: number;
      tolerateStatuses?: readonly number[];
    },
  ): Promise<RawResponse> {
    let current = rawUrl;
    let method = opts.method;
    let range = opts.range;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let url: URL;
      try {
        url = new URL(current);
      } catch {
        throw new PreviewFetchError("blocked_scheme", "invalid redirect url");
      }
      const testAllowed = this.isTestOrigin(url.origin);
      if (testAllowed) {
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new PreviewFetchError("blocked_scheme", "only http/https");
        }
      } else {
        try {
          validatePreviewUrl(current, { allowedPorts: this.allowedPorts });
        } catch (err) {
          if (err instanceof PreviewPolicyError) {
            throw new PreviewFetchError(err.code, err.message);
          }
          throw new PreviewFetchError("blocked_scheme", "url policy failed");
        }
      }
      let target: ResolvedTarget;
      if (testAllowed) {
        target = this.loopbackTarget(url);
      } else {
        try {
          target = await resolvePinnedTarget(url.hostname, { lookup: this.lookup });
        } catch (err) {
          if (err instanceof PreviewPolicyError) {
            throw new PreviewFetchError(err.code, err.message);
          }
          throw new PreviewFetchError("network", "dns resolution failed");
        }
      }
      if (this.limiter) await this.limiter.take(url.hostname, opts.signal);
      const response = await this.requestOnce(url, target, {
        method,
        range,
        maxBytes: opts.maxBytes,
        declaredMax: opts.declaredMax,
        signal: opts.signal,
        deadlineAt: opts.deadlineAt,
        timeoutMs: opts.timeoutMs,
      });
      if (REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.location;
        if (!location) throw new PreviewFetchError("http_error", "redirect without location");
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new PreviewFetchError("http_error", "invalid redirect location");
        }
        if (url.protocol === "https:" && next.protocol === "http:") {
          throw new PreviewFetchError("blocked_scheme", "https downgrade");
        }
        if (hop === MAX_REDIRECTS) {
          throw new PreviewFetchError("too_many_redirects", "redirect limit");
        }
        current = next.toString();
        if (response.status === 303 && method !== "HEAD") {
          method = "GET";
          range = undefined;
        }
        continue;
      }
      if (response.status === 429 || response.status === 503) {
        this.limiter?.cooldown(url.hostname, 60_000);
      }
      if (response.status >= 400 && !(opts.tolerateStatuses ?? []).includes(response.status)) {
        throw new PreviewFetchError("http_error", `HTTP ${response.status}`);
      }
      return response;
    }
    throw new PreviewFetchError("too_many_redirects", "redirect limit");
  }

  private loopbackTarget(url: URL): ResolvedTarget {
    const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
    return { hostname, address: hostname, family: hostname.includes(":") ? 6 : 4 };
  }

  private requestOnce(
    url: URL,
    target: ResolvedTarget,
    opts: {
      method: "HEAD" | "GET";
      range?: string;
      maxBytes: number;
      declaredMax: number;
      signal?: AbortSignal;
      deadlineAt?: number;
      timeoutMs: number;
    },
  ): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      const isHttps = url.protocol === "https:";
      const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
      // N9：IPv6 Host 头必须带方括号，否则 node:http 会拼出非法 Host。
      const displayHost = target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname;
      const hostHeader =
        port === (isHttps ? 443 : 80) ? displayHost : `${displayHost}:${port}`;
      const headers: Record<string, string> = {
        host: hostHeader,
        "user-agent": PREVIEW_USER_AGENT,
        accept: "*/*",
        "accept-encoding": "identity",
        connection: "close",
      };
      if (opts.range) headers.range = opts.range;
      const options: Record<string, unknown> = {
        protocol: url.protocol,
        hostname: target.address,
        port,
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        headers,
        agent: false,
        // DNS pin：连接层只使用已校验地址（不让系统二次解析）。
        lookup: (_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
          callback(null, target.address, target.family);
        },
      };
      if (isHttps) {
        // Host/SNI 保持原主机名；IP 字面量（v4/v6）不设 SNI（按 IP SAN 校验证书）。
        const literal =
          Boolean(normalizeIpLiteral(target.hostname)) || target.hostname.includes(":");
        if (literal) delete options.servername;
        else options.servername = target.hostname;
      }
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        opts.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const fail = (err: Error): void => finish(() => reject(err));
      const onAbort = (): void => {
        try {
          req.destroy();
        } catch {
          /* already destroyed */
        }
        fail(new PreviewFetchError("timeout", "aborted"));
      };
      const deadline = Math.min(
        opts.deadlineAt ?? Number.POSITIVE_INFINITY,
        this.now() + opts.timeoutMs,
      );
      const deadlineTimer = setTimeout(() => {
        try {
          req.destroy();
        } catch {
          /* already destroyed */
        }
        fail(new PreviewFetchError("timeout", "request deadline"));
      }, Math.max(1, deadline - this.now()));

      let req: ClientRequest;
      const onResponse = (res: IncomingMessage): void => {
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (name === "set-cookie") continue;
          if (value === undefined) continue;
          responseHeaders[name] = Array.isArray(value) ? value.join(", ") : String(value);
        }
        // N2：只接受 identity（我们发 Accept-Encoding: identity）；gzip/br 一律 unsupported。
        const encoding = (responseHeaders["content-encoding"] ?? "").trim().toLowerCase();
        if (encoding && encoding !== "identity") {
          res.destroy();
          fail(new PreviewFetchError("unsupported", "content-encoding is not identity"));
          return;
        }
        const declared = Number(responseHeaders["content-length"] ?? "0");
        if (Number.isFinite(declared) && declared > opts.declaredMax) {
          res.destroy();
          fail(new PreviewFetchError("blocked_size", "declared size too large"));
          return;
        }
        if (opts.method === "HEAD" || opts.maxBytes === 0) {
          res.resume();
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: responseHeaders,
              body: null,
              final_url: url.toString(),
            }),
          );
          return;
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          const bytes = new Uint8Array(chunk);
          const room = opts.maxBytes - total;
          if (room <= 0) {
            res.destroy();
            return;
          }
          const slice = bytes.byteLength > room ? bytes.slice(0, room) : bytes;
          chunks.push(slice);
          total += slice.byteLength;
          if (total >= opts.maxBytes) {
            res.destroy();
            finish(() =>
              resolve({
                status: res.statusCode ?? 0,
                headers: responseHeaders,
                body: concat(chunks),
                final_url: url.toString(),
              }),
            );
          }
        });
        res.on("end", () => {
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: responseHeaders,
              body: concat(chunks),
              final_url: url.toString(),
            }),
          );
        });
        res.on("error", (err) => {
          if (settled) return;
          fail(new PreviewFetchError("network", err.message));
        });
      };
      try {
        req = (isHttps ? httpsRequest : httpRequest)(options as never, onResponse);
      } catch (err) {
        fail(new PreviewFetchError("network", (err as Error).message));
        return;
      }
      req.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => {
        try {
          req.destroy();
        } catch {
          /* already destroyed */
        }
        fail(new PreviewFetchError("timeout", "socket idle"));
      });
      req.on("error", (err) => {
        if (settled) return;
        const code = (err as NodeJS.ErrnoException).code ?? "";
        fail(
          new PreviewFetchError(
            code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" ? "timeout" : "network",
            err.message,
          ),
        );
      });
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      req.end();
    });
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

import { EXT_CONTENT_TYPE } from "../core/validation.ts";
import { fail } from "../core/errors.ts";
import {
  instanceFetch,
  isInstanceUnreachable,
  type InstanceEndpoint,
} from "../server/instance-client.ts";

export class CliError extends Error {
  readonly detail: Record<string, unknown> | undefined;
  constructor(message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "CliError";
    this.detail = detail;
  }
}

export interface ApiClientOptions {
  /** 展示/报错用的基址（UDS 实例为逻辑 URL；standalone 为 TCP origin）。 */
  baseUrl: string;
  account: string;
  token?: string | null;
  defaultTimeoutMs?: number;
  /**
   * 显式实例端点（daemon 托管的 UDS 实例）：请求走 `instanceFetch`（socket 通道），
   * 此时 `baseUrl` 只用于展示/报错，不再参与 URL 拼接。
   */
  endpoint?: InstanceEndpoint | null;
}

interface RequestOptions {
  body?: unknown;
  rawBody?: Uint8Array;
  contentType?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  method?: string;
  path: string;
}

export class ApiClient {
  readonly baseUrl: string;
  readonly account: string;
  readonly token: string | null;
  readonly endpoint: InstanceEndpoint | null;
  private readonly defaultTimeoutMs: number;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.account = opts.account;
    this.token = opts.token ?? null;
    this.endpoint = opts.endpoint ?? null;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 20_000;
  }

  private headers(opts: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-report-account": this.account,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts.rawBody) {
      headers["content-type"] = opts.contentType ?? "application/octet-stream";
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    return { ...headers, ...(opts.extraHeaders ?? {}) };
  }

  async request<T = Record<string, unknown>>(opts: RequestOptions): Promise<T> {
    const url = `${this.baseUrl}${opts.path}`;
    const init: RequestInit = {
      method: opts.method ?? (opts.body !== undefined || opts.rawBody ? "POST" : "GET"),
      headers: this.headers(opts),
      body:
        opts.rawBody !== undefined
          ? new Blob([opts.rawBody as unknown as BlobPart])
          : opts.body !== undefined
            ? JSON.stringify(opts.body)
            : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs),
    };
    let res: Response;
    try {
      // daemon 托管实例走 UDS 通道（instanceFetch）；standalone/直连走普通 fetch。
      res = this.endpoint ? await instanceFetch(this.endpoint, opts.path, init) : await fetch(url, init);
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new CliError(
          `request timed out after ${opts.timeoutMs ?? this.defaultTimeoutMs}ms`,
          { timeout: true },
        );
      }
      if (isInstanceUnreachable(err)) {
        fail(
          "UNAVAILABLE",
          `service unavailable at ${err.socket ?? this.baseUrl} (${err.code}: ${err.message}); is it running?`,
        );
      }
      fail(
        "UNAVAILABLE",
        `service unavailable at ${this.baseUrl} (${(err as Error).message}); is it running?`,
      );
    }
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    if (!res.ok) {
      const message =
        typeof body?.error === "string" ? body.error : `HTTP ${res.status} from ${opts.path}`;
      throw new CliError(message, {
        status: res.status,
        base_url: this.baseUrl,
        account: this.account,
        had_token: Boolean(this.token),
      });
    }
    if (body && body.ok === false) {
      throw new CliError(String(body.error ?? "request failed"));
    }
    return (body ?? {}) as T;
  }

  get<T = Record<string, unknown>>(path: string, timeoutMs?: number): Promise<T> {
    return this.request<T>({ path, method: "GET", timeoutMs });
  }

  post<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    return this.request<T>({ path, method: "POST", body: body ?? {}, timeoutMs });
  }

  put<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
    return this.request<T>({ path, method: "PUT", body: body ?? {} });
  }

  delete<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.request<T>({ path, method: "DELETE" });
  }

  async uploadMedia(bytes: Uint8Array, filename: string): Promise<{ hash: string; ext: string }> {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    const contentType = EXT_CONTENT_TYPE[ext] ?? "application/octet-stream";
    const result = await this.request<{ hash: string; ext: string }>({
      path: "/api/media",
      method: "POST",
      rawBody: bytes,
      contentType,
      extraHeaders: { "x-filename": filename },
      timeoutMs: 60_000,
    });
    return { hash: result.hash, ext: result.ext };
  }
}

export async function fetchAuthMode(
  baseUrl: string,
  endpoint?: InstanceEndpoint | null,
): Promise<{
  mode: "open" | "auth";
  env_files_loaded: string[];
  auth_value_masked: string;
}> {
  const init: RequestInit = {
    signal: AbortSignal.timeout(5000),
    headers: { accept: "application/json" },
  };
  const res = endpoint
    ? await instanceFetch(endpoint, "/api/auth/status", init)
    : await fetch(`${baseUrl.replace(/\/$/, "")}/api/auth/status`, init);
  if (!res.ok) fail("UNAVAILABLE", `cannot read auth status from ${baseUrl} (HTTP ${res.status})`);
  const body = (await res.json()) as {
    mode: "open" | "auth";
    env_files_loaded: string[];
    auth_value_masked: string;
  };
  return body;
}

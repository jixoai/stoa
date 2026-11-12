/**
 * 代理侧的实例凭据（daemon-unified-port design §5，S3-4）。
 *
 * 浏览器经 daemon 访问实例时**不持有实例 token**：daemon 在服务端按服务记录的
 * `authAccount`（默认 `owner`）读 `<dataDir>/accounts/<acct>.env`（0600）并注入：
 *   - auth 模式（env 里有 token）→ `Authorization: Bearer <token>` + `x-report-account`
 *   - open 模式（无 token）→ 仅 `x-report-account`
 * 客户端自带的 `authorization`/`x-report-account` 一律先删（防冒充）。
 *
 * env 读取带 **≤1s TTL 缓存**（负结果也缓存）；token 轮换导致实例 401 时，用 daemon 既有
 * `tryLogin` 语义（读实例 `STOA_AUTH` → `POST /api/auth/login`）换 access token 兜底，
 * 拿到后短缓存复用；仍失败 → 502「实例凭据不可用」。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accountTokenEnvKey, legacyAccountTokenEnvKey } from "../core/auth.ts";
import { parseEnv } from "../core/env.ts";
import { endpointOfInfo, endpointOfRecord, instanceFetch, type InstanceEndpoint } from "../server/instance-client.ts";
import { readServerInfo } from "../server/discovery.ts";
import { DEFAULT_AUTH_ACCOUNT, type ServiceRecord } from "./state.ts";
import { findAuthKey } from "./sessions.ts";

/** env 读取缓存 TTL（design §5：≤1s）。 */
export const CREDENTIAL_CACHE_TTL_MS = 1_000;
/** tryLogin 兜底 token 的短缓存：避免每请求都打一次登录。 */
export const FALLBACK_TOKEN_TTL_MS = 60_000;

interface CachedToken {
  expiresAt: number;
  token: string | null;
}

const envCache = new Map<string, CachedToken>();
const fallbackCache = new Map<string, CachedToken>();

/** 测试/轮换后清缓存（`file` 省略 = 全清）。 */
export function resetCredentialCaches(file?: string | null): void {
  if (file) {
    envCache.delete(file);
    fallbackCache.delete(file);
    for (const key of fallbackCache.keys()) if (key.startsWith(`${file}::`)) fallbackCache.delete(key);
    return;
  }
  envCache.clear();
  fallbackCache.clear();
}

/** 实例账号的 env 文件路径（`<dataDir>/accounts/<acct>.env`）。 */
export function accountEnvPath(dataDir: string, account: string): string {
  return join(dataDir, "accounts", `${account}.env`);
}

function tokenFromEnvFile(file: string, account: string): string | null {
  try {
    const values = parseEnv(readFileSync(file, "utf8"));
    const preferred = values[accountTokenEnvKey(account)] ?? values[legacyAccountTokenEnvKey(account)] ?? "";
    return preferred.trim() || null;
  } catch {
    return null;
  }
}

export interface ServiceCredential {
  /** 注入的实例账号（`x-report-account`）。 */
  account: string;
  /** 实例 token（auth 模式）；open 模式为 null。 */
  token: string | null;
  /** 读到的 env 文件（诊断用，不返回给浏览器）。 */
  envFile: string | null;
  mode: "auth" | "open";
}

/** 读实例凭据（`≤1s` TTL；文件缺失/无 token → open 模式，负结果也缓存）。 */
export function serviceCredentials(
  record: Pick<ServiceRecord, "dataDir" | "authAccount">,
  opts: { now?: () => number } = {},
): ServiceCredential {
  const account = (record.authAccount ?? "").trim() || DEFAULT_AUTH_ACCOUNT;
  const file = accountEnvPath(record.dataDir, account);
  const now = (opts.now ?? Date.now)();
  const cached = envCache.get(file);
  let token: string | null;
  if (cached && cached.expiresAt > now) {
    token = cached.token;
  } else {
    token = existsSync(file) ? tokenFromEnvFile(file, account) : null;
    envCache.set(file, { expiresAt: now + CREDENTIAL_CACHE_TTL_MS, token });
  }
  return {
    account,
    token,
    envFile: existsSync(file) ? file : null,
    mode: token ? "auth" : "open",
  };
}

/**
 * 覆盖式注入：先删客户端自带的 `authorization`/`x-report-account`（防身份冒充），
 * 再按账号写回。返回值与注入内容一致（401 兜底需要知道 account）。
 */
export function applyServiceCredentials(headers: Headers, record: ServiceRecord): ServiceCredential {
  const credential = serviceCredentials(record);
  headers.delete("authorization");
  headers.delete("x-report-account");
  headers.set("x-report-account", credential.account);
  if (credential.token) headers.set("authorization", `Bearer ${credential.token}`);
  return credential;
}

/** 服务记录的当前端点：`server.json` 自报优先（重启换 socket 后仍准确），否则登记值。 */
export function serviceEndpoint(record: ServiceRecord): InstanceEndpoint {
  const info = readServerInfo(record.dataDir);
  if (info) return endpointOfInfo(info);
  return endpointOfRecord(record);
}

/** 服务口令文件候选（与 `GET …/secret` 同口径）。 */
export function secretFilesFor(record: ServiceRecord): string[] {
  const out: string[] = [];
  for (const raw of [record.secretFile, ...(record.envFiles ?? []), join(record.dataDir, ".env")]) {
    const file = (raw ?? "").trim();
    if (file && !out.includes(file)) out.push(file);
  }
  return out;
}

/** 实例登录换 access token（`POST /api/auth/login`）；失败返回 null（绝不抛）。 */
export async function loginForToken(
  record: ServiceRecord,
  secret: string,
  opts: { endpoint?: InstanceEndpoint; timeoutMs?: number } = {},
): Promise<string | null> {
  if (!secret) return null;
  try {
    const res = await instanceFetch(opts.endpoint ?? serviceEndpoint(record), "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1_500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    return typeof body.token === "string" && body.token ? body.token : null;
  } catch {
    return null;
  }
}

/**
 * 401 兜底：读实例 `STOA_AUTH` 登录换 access token（60s 短缓存，key 含账号）。
 * 没有口令文件 / 登录失败返回 null（调用方据此给 502）。
 */
export async function fallbackAccessToken(
  record: ServiceRecord,
  opts: { now?: () => number; endpoint?: InstanceEndpoint } = {},
): Promise<string | null> {
  const account = (record.authAccount ?? "").trim() || DEFAULT_AUTH_ACCOUNT;
  const found = findAuthKey(secretFilesFor(record));
  if (!found) return null;
  const cacheKey = `${found.file}::${account}`;
  const now = (opts.now ?? Date.now)();
  const cached = fallbackCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.token;
  const token = await loginForToken(record, found.key, { endpoint: opts.endpoint });
  // 失败也短缓存（避免每次请求都打一次登录）；下一个 TTL 窗口再试。
  fallbackCache.set(cacheKey, { expiresAt: now + FALLBACK_TOKEN_TTL_MS, token });
  return token;
}

/** 代理/页面给用户的「凭据不可用」文案（含实例名与下一步）。 */
export function credentialUnavailableMessage(record: ServiceRecord, detail: string | null): string {
  const suffix = detail ? `（${detail}）` : "";
  return (
    `实例凭据不可用（daemon 代理）：实例「${record.name}」(${record.slug}) 拒绝注入的身份${suffix}。` +
    ` 请在 daemon 控制台检查该服务的口令（重新生成后重试），或重新挂载该实例。`
  );
}

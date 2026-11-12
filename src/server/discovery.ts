import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fail } from "../core/errors.ts";
import { envKeys, envValue } from "../core/env.ts";
import { VERSION } from "../core/protocol.ts";
import type { LeaseSnapshot } from "./lease.ts";
import { instanceFetch, type InstanceEndpoint } from "./instance-client.ts";

export interface ServerInfo {
  /**
   * TCP 端口：`--standalone` 实例的真实监听端口；daemon 托管（UDS）实例为 `null`
   * （daemon-unified-port design §1.2 的兼容字段）。
   */
  port: number | null;
  /** daemon 托管实例的 Unix domain socket 路径（standalone 缺省）。 */
  unix?: string | null;
  pid: number;
  /** 逻辑 URL：standalone 为 TCP origin；UDS 为 daemon 注入的逻辑 URL（如 `/i/<slug>/`）。 */
  url: string;
  startedAt: number;
  dataDir: string;
  instanceId: string;
  version: string;
  host: string;
  envFiles: string[];
  openMode: boolean;
  /** set right before an idle-timeout shutdown removes server.json (design §1) */
  closedAt?: number;
}

export const SERVER_JSON = "server.json";
export const LOCK_JSON = "serve.lock";
export const POINTER_FILE = ".report-pointer";
export const DATA_DIR_ENV = "STOA_DATA_DIR";
/** Legacy data-dir env key (`FDE2E_REPORT_DATA_DIR`), still read as fallback. */
export const LEGACY_DATA_DIR_ENV = "FDE2E_REPORT_DATA_DIR";

export function serverInfoPath(dataDir: string): string {
  return join(dataDir, SERVER_JSON);
}

// ── instance sockets (daemon-unified-port design §1.1) ───────────────────────
/** daemon 托管实例的 socket 目录名（`<stateDir>/sockets`，0700）。 */
export const SOCKET_DIR_NAME = "sockets";
/**
 * UDS 路径软上限：macOS 实测 117 字符可 bind，但自定义深路径（含 stateDir 在
 * `~/Library/...` 的深层目录）容易越过；超过即 fallback 到 `os.tmpdir()` 短目录。
 */
export const SOCKET_PATH_SOFT_LIMIT = 90;

export function socketsDir(stateDir: string): string {
  return join(stateDir, SOCKET_DIR_NAME);
}

/** 默认 socket 路径：`<stateDir>/sockets/<serviceId>.sock`。 */
export function defaultSocketPath(stateDir: string, serviceId: string): string {
  return join(socketsDir(stateDir), `${serviceId}.sock`);
}

/** 超长路径的短目录 fallback：`<tmpdir>/stoa-sock-<hash8>/<name>.sock`（原路径哈希，稳定可复现）。 */
export function socketPathFallback(requested: string): string {
  const hash = createHash("sha256").update(requested).digest("hex").slice(0, 8);
  const name = requested.split(/[\\/]/).pop() || "instance.sock";
  return join(tmpdir(), `stoa-sock-${hash}`, name);
}

/**
 * 生成实际监听路径并确保父目录存在（0700）：
 * `Bun.serve({unix})` 在父目录缺失时直接 ENOENT，不会自动建目录。
 * 超软上限时落到 tmpdir 短目录；返回值就是真实监听路径（写进 server.json）。
 */
export function prepareSocketPath(requested: string): string {
  const chosen =
    Buffer.byteLength(requested, "utf8") > SOCKET_PATH_SOFT_LIMIT
      ? socketPathFallback(requested)
      : requested;
  mkdirSync(dirname(chosen), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(chosen), 0o700);
  } catch {
    // best effort: 已有目录可能属于他人（tmpdir 场景），权限不是判据
  }
  // best-effort 收紧 socket 文件本人权限；Bun 会在 bind 后创建它。
  return chosen;
}

/** 删除残留 socket 文件（best effort；正常停机 Bun 会自己 unlink）。 */
export function removeSocketFile(path: string | null | undefined): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

export function writeServerInfo(dataDir: string, info: ServerInfo): void {
  const target = serverInfoPath(dataDir);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSyncSecure(tmp, JSON.stringify(info, null, 2));
  renameSync(tmp, target);
}

function writeFileSyncSecure(path: string, content: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

/**
 * 读 `server.json`（daemon-unified-port design §1.2 放宽契约）：
 *   - `port` 允许为 `null`（daemon 托管实例不占 TCP）；
 *   - `unix` 可选字符串；
 *   - `port` 与 `unix` **至少一个**存在；旧文件（纯 port）继续有效。
 */
export function readServerInfo(dataDir: string): ServerInfo | null {
  const path = serverInfoPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ServerInfo;
    const portOk = typeof parsed.port === "number" || parsed.port === null || parsed.port === undefined;
    const unixOk = parsed.unix === undefined || parsed.unix === null || typeof parsed.unix === "string";
    const hasPort = typeof parsed.port === "number";
    const hasUnix = typeof parsed.unix === "string" && parsed.unix.trim() !== "";
    if (
      !portOk ||
      !unixOk ||
      (!hasPort && !hasUnix) ||
      typeof parsed.pid !== "number" ||
      typeof parsed.url !== "string" ||
      typeof parsed.dataDir !== "string" ||
      typeof parsed.instanceId !== "string"
    ) {
      return null;
    }
    return { ...parsed, port: typeof parsed.port === "number" ? parsed.port : null };
  } catch {
    return null;
  }
}

export function clearServerInfo(dataDir: string, instanceId: string): void {
  const info = readServerInfo(dataDir);
  if (!info || info.instanceId !== instanceId) return;
  try {
    unlinkSync(serverInfoPath(dataDir));
  } catch {
    // already gone
  }
}

/**
 * Stamp `closedAt` into server.json right before an idle-timeout shutdown
 * removes it (design §1). Best effort: the file may already be gone.
 */
export function markServerClosed(dataDir: string, instanceId: string, closedAt: number): void {
  const info = readServerInfo(dataDir);
  if (!info || info.instanceId !== instanceId) return;
  try {
    writeServerInfo(dataDir, { ...info, closedAt });
  } catch {
    // the shutdown path must not fail because the marker could not be written
  }
}

export interface HealthBody {
  ok?: boolean;
  dataDir?: string;
  instanceId?: string;
  pid?: number;
  port?: number | null;
  unix?: string | null;
  lease?: LeaseSnapshot | null;
}

/**
 * Probe `/healthz` and return the body. Every probe that reaches the server
 * renews its idle lease (a CLI touch counts as activity).
 *
 * 通道走 `instanceFetch`（UDS 优先；standalone 回落 TCP），因此 UDS 实例同样可探测。
 */
export async function probeHealthBody(
  info: Pick<ServerInfo, "dataDir" | "instanceId"> & InstanceEndpoint,
  timeoutMs = 1500,
): Promise<HealthBody | null> {
  try {
    const res = await instanceFetch(info, "/healthz", {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as HealthBody;
    if (!body.ok || body.dataDir !== info.dataDir || body.instanceId !== info.instanceId) {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

export async function probeHealth(
  info: Pick<ServerInfo, "dataDir" | "instanceId"> & InstanceEndpoint,
  timeoutMs = 1500,
): Promise<boolean> {
  return (await probeHealthBody(info, timeoutMs)) !== null;
}

/** Discover the running instance for a data dir, verifying healthz + dataDir. */
export async function discoverServer(dataDir: string, timeoutMs = 1500): Promise<ServerInfo> {
  const info = readServerInfo(dataDir);
  if (!info) {
    fail(
      "UNAVAILABLE",
      `report service is not running for ${dataDir} (no server.json); start it with: stoa serve --data-dir ${dataDir}`,
    );
  }
  if (!(await probeHealth(info, timeoutMs))) {
    const where = info.unix ? `unix socket ${info.unix}` : `url ${info.url}`;
    fail(
      "UNAVAILABLE",
      `report service at ${where} is not healthy (stale server.json for ${dataDir}); ` +
        `start it with: stoa serve --data-dir ${dataDir}`,
    );
  }
  return info;
}

// ── data dir resolution (design §15) ─────────────────────────────────────────
export function resolveDataDir(opts: {
  flag?: string | null;
  env?: Record<string, string | undefined>;
  cwd?: string;
  allowPointer?: boolean;
}): string {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.flag) return resolve(cwd, opts.flag);
  const fromEnv = envValue(opts.env ?? process.env, envKeys("DATA_DIR"));
  if (fromEnv) return resolve(cwd, fromEnv);
  if (opts.allowPointer !== false) {
    const pointerPath = join(cwd, POINTER_FILE);
    if (existsSync(pointerPath)) {
      const content = readFileSync(pointerPath, "utf8").trim();
      if (content) return resolve(cwd, content);
    }
  }
  fail(
    "BAD_REQUEST",
    `cannot resolve data directory: pass --data-dir, set ${DATA_DIR_ENV} ` +
      `(legacy ${LEGACY_DATA_DIR_ENV} is also read), ` +
      `or run init in this working directory (it writes ${POINTER_FILE})`,
  );
}

export function writePointer(cwd: string, dataDir: string): string {
  const path = join(cwd, POINTER_FILE);
  writeFileSyncSecure(path, `${dataDir}\n`);
  return path;
}

export function readPointer(cwd: string): string | null {
  const path = join(cwd, POINTER_FILE);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8").trim();
  return content ? resolve(cwd, content) : null;
}

// ── data dir safety (design §19) ─────────────────────────────────────────────
const PUBLIC_SEGMENTS = ["reports"];

function normalizedSegments(path: string): string[] {
  return resolve(path)
    .split(sep)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

/**
 * Refuse data dirs inside public static roots. The known offender is
 * `.agents/reports/` (served + tunnel-exposed for HTML reports). Extra roots may
 * be supplied via STOA_PUBLIC_ROOTS (comma separated; legacy
 * FDE2E_REPORT_PUBLIC_ROOTS is also read).
 */
export function assertSafeDataDir(
  path: string,
  opts: { env?: Record<string, string | undefined>; cwd?: string } = {},
): string {
  const resolved = resolve(opts.cwd ?? process.cwd(), path);
  if (resolved === sep) fail("BAD_REQUEST", "refusing to use filesystem root as data dir");
  const segments = normalizedSegments(resolved);
  for (let i = 0; i + 1 < segments.length; i++) {
    if (segments[i] === ".agents" && PUBLIC_SEGMENTS.includes(segments[i + 1]!)) {
      fail(
        "BAD_REQUEST",
        `refusing data dir ${resolved}: .agents/reports/ is a public static root ` +
          `(credentials + SQLite would be exposed). Use .agents/workers/report/<session>/ instead`,
      );
    }
  }
  const extraRoots = (envValue(opts.env ?? process.env, envKeys("PUBLIC_ROOTS")) ?? "")
    .split(",")
    .map((root) => root.trim())
    .filter(Boolean);
  const candidates = [resolved];
  try {
    candidates.push(realpathSync(resolved));
  } catch {
    try {
      candidates.push(join(realpathSync(dirname(resolved)), "x"));
    } catch {
      // parent does not exist yet; resolved is enough
    }
  }
  for (const root of extraRoots) {
    const realRoot = resolve(root);
    for (const candidate of candidates) {
      if (candidate === realRoot || candidate.startsWith(realRoot + sep)) {
        fail(
          "BAD_REQUEST",
          `refusing data dir ${resolved}: it is inside configured public root ${realRoot}`,
        );
      }
    }
  }
  return resolved;
}

// ── single-instance lock (O_EXCL; flock-equivalent for this single-writer service) ──
export interface LockHandle {
  path: string;
  instanceId: string;
  release: () => void;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(dataDir: string, instanceId: string, now = Date.now()): LockHandle {
  const path = join(dataDir, LOCK_JSON);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, instanceId, startedAt: now }));
      } finally {
        closeSync(fd);
      }
      return {
        path,
        instanceId,
        release: () => {
          try {
            const content = JSON.parse(readFileSync(path, "utf8")) as { instanceId?: string };
            if (content.instanceId === instanceId) unlinkSync(path);
          } catch {
            // already gone / unreadable: nothing to release
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: { pid?: number; instanceId?: string } | null = null;
      try {
        holder = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
      } catch {
        holder = null;
      }
      if (holder?.pid && pidAlive(holder.pid) && holder.instanceId !== instanceId) {
        fail(
          "CONFLICT",
          `another report instance (pid ${holder.pid}) already owns ${dataDir}; ` +
            `only one server per data dir is allowed`,
        );
      }
      try {
        unlinkSync(path);
      } catch {
        // race: someone else removed it
      }
    }
  }
  fail("CONFLICT", `could not acquire ${path} (another instance is racing for it)`);
}

export function readLock(dataDir: string): { pid?: number; instanceId?: string } | null {
  const path = join(dataDir, LOCK_JSON);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { pid?: number; instanceId?: string };
  } catch {
    return null;
  }
}

export function versionString(): string {
  return VERSION;
}

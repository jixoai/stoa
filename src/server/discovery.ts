import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fail } from "../core/errors.ts";
import { VERSION } from "../core/protocol.ts";
import type { LeaseSnapshot } from "./lease.ts";

export interface ServerInfo {
  port: number;
  pid: number;
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
export const DATA_DIR_ENV = "FDE2E_REPORT_DATA_DIR";

export function serverInfoPath(dataDir: string): string {
  return join(dataDir, SERVER_JSON);
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

export function readServerInfo(dataDir: string): ServerInfo | null {
  const path = serverInfoPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ServerInfo;
    if (
      typeof parsed.port !== "number" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.url !== "string" ||
      typeof parsed.dataDir !== "string" ||
      typeof parsed.instanceId !== "string"
    ) {
      return null;
    }
    return parsed;
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
  port?: number;
  lease?: LeaseSnapshot | null;
}

/**
 * Probe `/healthz` and return the body. Every probe that reaches the server
 * renews its idle lease (a CLI touch counts as activity).
 */
export async function probeHealthBody(
  info: Pick<ServerInfo, "url" | "dataDir" | "instanceId">,
  timeoutMs = 1500,
): Promise<HealthBody | null> {
  try {
    const res = await fetch(`${info.url}/healthz`, {
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
  info: Pick<ServerInfo, "url" | "dataDir" | "instanceId">,
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
    fail(
      "UNAVAILABLE",
      `report service at ${info.url} is not healthy (stale server.json for ${dataDir}); ` +
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
  const fromEnv = (opts.env ?? process.env)[DATA_DIR_ENV];
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
    `cannot resolve data directory: pass --data-dir, set ${DATA_DIR_ENV}, ` +
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
 * be supplied via FDE2E_REPORT_PUBLIC_ROOTS (comma separated).
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
  const extraRoots = ((opts.env ?? process.env).FDE2E_REPORT_PUBLIC_ROOTS ?? "")
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

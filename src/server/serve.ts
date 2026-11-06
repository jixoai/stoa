import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fail } from "../core/errors.ts";
import { parseEnv } from "../core/env.ts";
import type { Server } from "bun";
import { AuthManager } from "./auth.ts";
import { Presence } from "./presence.ts";
import { Store } from "./store.ts";
import { openDatabase, migrate } from "./db.ts";
import { createApp } from "./http.ts";
import {
  acquireLock,
  assertSafeDataDir,
  clearServerInfo,
  markServerClosed,
  probeHealthBody,
  readServerInfo,
  writeServerInfo,
  type HealthBody,
  type LockHandle,
  type ServerInfo,
} from "./discovery.ts";
import { isLoopbackHost, listenInRange } from "./ports.ts";
import { cleanupStaleExports, runExport } from "./export.ts";
import { DEFAULT_IDLE_TIMEOUT_SEC, IdleLease } from "./lease.ts";
import { VERSION } from "../core/protocol.ts";

/** Default idle lease: 30 minutes (design §1). */
export const DEFAULT_IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_SEC * 1000;

export interface StartServerOptions {
  dataDir: string;
  port?: number | null;
  host?: string;
  envFiles: string[];
  expose?: boolean;
  allowOpenExpose?: boolean;
  processEnv?: Record<string, string | undefined>;
  now?: number;
  quiet?: boolean;
  /** 0 disables the idle lease; omitted means the 30-minute default */
  idleTimeoutMs?: number;
}

export interface RunningServer {
  url: string;
  port: number;
  instanceId: string;
  startedAt: number;
  info: ServerInfo;
  store: Store;
  auth: AuthManager;
  server: Server<undefined>;
  banner: string;
  /** resolved once the server closed (signal or idle timeout) */
  closed: Promise<void>;
  close: (opts?: { keepServerJson?: boolean }) => Promise<void>;
}

function readSecret(dataDir: string): string {
  const envPath = join(dataDir, ".env");
  if (!existsSync(envPath)) {
    fail("BAD_REQUEST", `data dir ${dataDir} is not initialized (missing .env); run init first`);
  }
  const values = parseEnv(readFileSync(envPath, "utf8"));
  const secret = values.FDE2E_REPORT_SECRET ?? "";
  if (!secret) fail("BAD_REQUEST", `FDE2E_REPORT_SECRET missing in ${envPath}; re-run init`);
  return secret;
}

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 0) {
    fail("BAD_REQUEST", `--idle-timeout must be a non-negative integer of seconds`);
  }
  const dataDir = assertSafeDataDir(opts.dataDir);
  if (!existsSync(join(dataDir, "report.sqlite"))) {
    fail("BAD_REQUEST", `data dir ${dataDir} is not initialized; run: fde2e-report-worker init --data-dir ${dataDir}`);
  }
  const startedAt = opts.now ?? Date.now();
  const instanceId = randomBytes(8).toString("hex");
  const secretSalt = readSecret(dataDir);
  const db = openDatabase({ dataDir });
  migrate(db);
  const store = new Store({ dataDir, db });
  const backfilled = store.backfillMediaSizes();
  if (backfilled > 0) console.log(`[report] media sizes backfilled: ${backfilled}`);
  const auth = new AuthManager({
    store,
    envFiles: opts.envFiles,
    secretSalt,
    processEnv: opts.processEnv,
  });
  const host = opts.host ?? "127.0.0.1";
  const loopback = isLoopbackHost(host);
  const exposed = Boolean(opts.expose) || !loopback;
  const mode = auth.current().mode;
  if (exposed && mode === "open" && !opts.allowOpenExpose) {
    db.close();
    fail(
      "FORBIDDEN",
      `refusing to expose without authentication: bind is ${host}${opts.expose ? " + --expose" : ""} ` +
        `and FDE2E_REPORT_AUTH is empty. Set FDE2E_REPORT_AUTH in an env file, or pass --allow-open-expose (OPEN MODE).`,
    );
  }

  let lock: LockHandle | null = null;
  try {
    lock = acquireLock(dataDir, instanceId);
  } catch (err) {
    db.close();
    throw err;
  }

  const presence = new Presence();
  const deps = {
    store,
    auth,
    presence,
    dataDir,
    instanceId,
    startedAt,
    openExposed: exposed && mode === "open",
    port: null as number | null,
    uiDir: join(import.meta.dir, "..", "..", "dist"),
    // Assigned once the lease exists; createApp reads it lazily per request.
    lease: null as IdleLease | null,
  };
  const app = createApp(deps);

  let listening;
  try {
    listening = await listenInRange({
      host,
      port: opts.port ?? null,
      fetch: (req) => app.fetch(req),
      idleTimeout: 60,
    });
  } catch (err) {
    lock.release();
    db.close();
    throw err;
  }
  const url = `http://127.0.0.1:${listening.port}`;
  deps.port = listening.port;
  const info: ServerInfo = {
    port: listening.port,
    pid: process.pid,
    url,
    startedAt,
    dataDir,
    instanceId,
    version: VERSION,
    host,
    envFiles: opts.envFiles,
    openMode: mode === "open",
  };
  writeServerInfo(dataDir, info);

  const authStatus = auth.status(exposed && mode === "open");
  const banner = [
    `fde2e-report-worker ${VERSION}`,
    `data dir : ${dataDir}`,
    `env files: ${authStatus.env_files_loaded.join(", ") || "(none)"}` +
      (authStatus.env_files_missing.length
        ? ` (missing: ${authStatus.env_files_missing.join(", ")})`
        : ""),
    `auth     : ${authStatus.mode === "auth" ? "ON (FDE2E_REPORT_AUTH set)" : "OPEN MODE"}` +
      (authStatus.open_mode_warning ? ` — ${authStatus.open_mode_warning}` : ""),
    `listen   : ${host}:${listening.port}`,
    `url      : ${url}`,
  ].join("\n");

  let closed = false;
  let resolveClosed = (): void => {};
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let lease: IdleLease | null = null;
  const close = async (closeOpts?: { keepServerJson?: boolean }) => {
    if (closed) return;
    closed = true;
    lease?.stop();
    try {
      // No idle shutdown ever runs with a request in flight, but `stop(true)`
      // also covers an in-flight request racing the signal path.
      listening.server.stop(true);
    } catch {
      // already stopped
    }
    if (!closeOpts?.keepServerJson) clearServerInfo(dataDir, instanceId);
    lock.release();
    try {
      db.close();
    } catch {
      // already closed
    }
    resolveClosed();
  };

  const shutdownForIdle = async (): Promise<void> => {
    if (closed) return;
    process.stderr.write("[report] idle timeout, shutting down\n");
    markServerClosed(dataDir, instanceId, Date.now());
    await close();
  };

  if (idleTimeoutMs > 0) {
    lease = new IdleLease({ idleTimeoutMs, onIdle: shutdownForIdle });
    deps.lease = lease;
    lease.start();
  }

  // Pending export retry (design §14): never block startup, never swallow errors.
  cleanupStaleExports(dataDir);
  if (store.pendingExport()) {
    setTimeout(() => {
      try {
        runExport({ dataDir });
        store.setPendingExport(false);
        if (!opts.quiet) process.stderr.write("[report] pending export retried successfully\n");
      } catch (err) {
        if (!opts.quiet) {
          process.stderr.write(`[report] pending export retry failed: ${(err as Error).message}\n`);
        }
      }
    }, 50);
  }

  return {
    url,
    port: listening.port,
    instanceId,
    startedAt,
    info,
    store,
    auth,
    server: listening.server,
    banner,
    closed: closedPromise,
    close,
  };
}

export interface ServeStatus {
  running: boolean;
  url?: string;
  port?: number;
  pid?: number;
  dataDir: string;
  instanceId?: string;
  startedAt?: number;
  stale?: boolean;
  /** idle lease info reported by the live instance's `/healthz` */
  lease?: HealthBody["lease"];
  lease_remaining_ms?: number | null;
  idle_timeout_ms?: number | null;
}

export async function serverStatus(dataDir: string): Promise<ServeStatus> {
  const info = readServerInfo(dataDir);
  if (!info) return { running: false, dataDir };
  const health = await probeHealthBody(info);
  if (!health) {
    return {
      running: false,
      dataDir,
      url: info.url,
      port: info.port,
      pid: info.pid,
      instanceId: info.instanceId,
      startedAt: info.startedAt,
      stale: true,
    };
  }
  return {
    running: true,
    dataDir,
    url: info.url,
    port: info.port,
    pid: info.pid,
    instanceId: info.instanceId,
    startedAt: info.startedAt,
    lease: health.lease ?? null,
    lease_remaining_ms: health.lease?.lease_remaining_ms ?? null,
    idle_timeout_ms: health.lease?.idle_timeout_ms ?? null,
  };
}

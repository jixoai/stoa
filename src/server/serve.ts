import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fail } from "../core/errors.ts";
import { envKeys, envValue, parseEnv } from "../core/env.ts";
import type { Server } from "bun";
import { AuthManager } from "./auth.ts";
import { Presence } from "./presence.ts";
import { Store } from "./store.ts";
import { openDatabase, migrate, DB_FILE_NAME } from "./db.ts";
import { createApp } from "./http.ts";
import { Hub } from "./hub.ts";
import {
  acquireLock,
  assertSafeDataDir,
  clearServerInfo,
  markServerClosed,
  prepareSocketPath,
  removeSocketFile,
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
import { HttpPreviewTransport } from "./preview/fetch.ts";
import { LINK_PREVIEW_PROVIDER } from "./preview/link-preview/provider.ts";
import { PreviewService } from "./preview/service.ts";
import { parseTestAllowOrigins } from "./preview/ssrf.ts";

/** Default idle lease: 30 minutes (design §1). */
export const DEFAULT_IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_SEC * 1000;

export interface StartServerOptions {
  dataDir: string;
  port?: number | null;
  host?: string;
  /**
   * daemon 托管：监听 Unix domain socket（不占 TCP，daemon-unified-port design §1.1）。
   * 传了它就不再用 `port`；父目录由 serve 自己建（0700）。
   */
  unix?: string | null;
  /**
   * UDS 模式下的逻辑 URL（daemon 注入，如 `http://127.0.0.1:13679/i/<slug>/`）。
   * 只用于展示/链接生成与 `server.json` 的 `url` 字段；机器通道始终是 socket。
   */
  logicalUrl?: string | null;
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
  /** TCP 端口；UDS 模式为 `null`。 */
  port: number | null;
  /** UDS 模式的实际监听路径；standalone 为 `null`。 */
  unix: string | null;
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
  const secret = envValue(values, envKeys("SECRET")) ?? "";
  if (!secret) {
    fail(
      "BAD_REQUEST",
      `STOA_SECRET missing in ${envPath} (legacy FDE2E_REPORT_SECRET is also read); re-run init`,
    );
  }
  return secret;
}

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 0) {
    fail("BAD_REQUEST", `--idle-timeout must be a non-negative integer of seconds`);
  }
  const dataDir = assertSafeDataDir(opts.dataDir);
  if (!existsSync(join(dataDir, DB_FILE_NAME))) {
    fail("BAD_REQUEST", `data dir ${dataDir} is not initialized; run: stoa init --data-dir ${dataDir}`);
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
        `and the auth key (STOA_AUTH) is empty. Set STOA_AUTH in an env file, or pass --allow-open-expose (OPEN MODE).`,
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
  const hub = new Hub({ store, presence, instanceId });
  // 预览 worker/抓取器：曝光或非回环时测试白名单强制失效（design §7.5）。
  const env = opts.processEnv ?? process.env;
  const previewTestOrigins = exposed
    ? []
    : parseTestAllowOrigins(envValue(env, envKeys("PREVIEW_TEST_ALLOW_ORIGINS")));
  const previewTransport = new HttpPreviewTransport({
    testAllowOrigins: previewTestOrigins,
    allowedPorts: [8080, 8443],
  });
  const previews = new PreviewService({
    store,
    provider: LINK_PREVIEW_PROVIDER,
    transport: previewTransport,
    instanceId,
    workerEnabled: envValue(env, envKeys("PREVIEW_WORKER")) !== "0",
    policy: { test_allowlist_enabled: previewTestOrigins.length > 0, exposed },
  });
  const deps = {
    store,
    auth,
    presence,
    dataDir,
    instanceId,
    startedAt,
    openExposed: exposed && mode === "open",
    port: null as number | null,
    /** daemon 托管（UDS）时非 null——P2 的 proxied 判定与后续代理逻辑都读它。 */
    unix: null as string | null,
    logicalUrl: null as string | null,
    uiDir: join(import.meta.dir, "..", "..", "dist"),
    // Assigned once the lease exists; createApp reads it lazily per request.
    lease: null as IdleLease | null,
    hub,
    previews,
  };
  const app = createApp(deps);

  /**
   * 绑定成功 ≠ 端口归我们：本机实测（macOS/Bun 1.4）两个进程可以同时 bind 同一回环端口，
   * 后 bind 者接走全部连接。用 `/healthz` 自证归属（instanceId），不通过就换端口；
   * 显式 `--port` 被他人占用时直接 CONFLICT，绝不静默共享端口。
   *
   * UDS 模式整段跳过（design §1.1）：重复 bind 直接 EADDRINUSE，「bind 成功≠归属」不存在。
   */
  const verifyOwnership = async (port: number): Promise<boolean> => {
    if (!isLoopbackHost(host)) return true; // 非回环地址无法用 127.0.0.1 自证
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1200),
        headers: { accept: "application/json" },
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { instanceId?: unknown };
      return body.instanceId === instanceId;
    } catch {
      return false;
    }
  };

  /**
   * 请求处理器：显式接住 `Bun.serve` 的第二个参数（server 引用）。
   * 现在用不到，但先把签名定下来——P2 的 proxied 判定/连接数统计要用时不必再改两处调用点。
   */
  const fetchHandler = (req: Request, _server?: Server<undefined>): Response | Promise<Response> =>
    app.fetch(req);

  const unixRequested = (opts.unix ?? "").trim() || null;
  let server: Server<undefined>;
  let listenPort: number | null = null;
  let socketPath: string | null = null;
  try {
    if (unixRequested) {
      // 父目录不存在时 Bun.serve({unix}) 直接 ENOENT，必须先建（0700）。
      // UDS 不接受 TCP 专属选项（idleTimeout 等）：socket 连接没有空闲超时。
      socketPath = prepareSocketPath(unixRequested);
      server = Bun.serve({
        unix: socketPath,
        fetch: fetchHandler,
      });
    } else {
      let listening: Awaited<ReturnType<typeof listenInRange>> | undefined;
      for (let attempt = 0; ; attempt++) {
        listening = await listenInRange({
          host,
          port: opts.port ?? null,
          fetch: fetchHandler,
          idleTimeout: 60,
        });
        if (await verifyOwnership(listening.port)) break;
        try {
          listening.server.stop(true);
        } catch {
          // already stopped
        }
        listening = undefined;
        if (opts.port !== undefined && opts.port !== null) {
          fail(
            "CONFLICT",
            `port ${opts.port} is served by another process on this machine ` +
              `(bind succeeded but /healthz answered a different instance)`,
          );
        }
        if (attempt >= 8) {
          fail("UNAVAILABLE", "could not find a port owned by this instance (ports appear shared)");
        }
      }
      server = listening!.server;
      listenPort = listening!.port;
    }
  } catch (err) {
    lock.release();
    db.close();
    throw err;
  }
  const url = socketPath
    ? (opts.logicalUrl ?? "").trim() || `unix://${socketPath}`
    : `http://127.0.0.1:${listenPort}`;
  deps.port = listenPort;
  deps.unix = socketPath;
  deps.logicalUrl = url;
  const info: ServerInfo = {
    port: listenPort,
    unix: socketPath,
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

  // serve ready 之后才启动预览 worker（导出/静态路径永不启动，design §12）。
  previews.start();

  const authStatus = auth.status(exposed && mode === "open");
  const banner = [
    `stoa ${VERSION}`,
    `data dir : ${dataDir}`,
    `env files: ${authStatus.env_files_loaded.join(", ") || "(none)"}` +
      (authStatus.env_files_missing.length
        ? ` (missing: ${authStatus.env_files_missing.join(", ")})`
        : ""),
    `auth     : ${authStatus.mode === "auth" ? "ON (STOA_AUTH set)" : "OPEN MODE"}` +
      (authStatus.open_mode_warning ? ` — ${authStatus.open_mode_warning}` : ""),
    socketPath ? `listen   : unix ${socketPath}` : `listen   : ${host}:${listenPort}`,
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
    await previews.stop();
    // Give live SSE clients a `bye{shutdown}` before the socket is torn down.
    try {
      await Promise.race([
        hub.shutdown(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          timer.unref?.();
        }),
      ]);
    } catch {
      // shutdown frames are best-effort
    }
    hub.dispose();
    try {
      // No idle shutdown ever runs with a request in flight, but `stop(true)`
      // also covers an in-flight request racing the signal path.
      // UDS 模式：Bun 在 stop 时自动 unlink socket 文件（design §1.1）。
      server.stop(true);
    } catch {
      // already stopped
    }
    if (socketPath) removeSocketFile(socketPath);
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
    hub.setLease(lease);
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
    port: listenPort,
    unix: socketPath,
    instanceId,
    startedAt,
    info,
    store,
    auth,
    server,
    banner,
    closed: closedPromise,
    close,
  };
}

export interface ServeStatus {
  running: boolean;
  url?: string;
  /** UDS 实例为 null（daemon 托管）；standalone 为真实 TCP 端口。 */
  port?: number | null;
  unix?: string | null;
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
      unix: info.unix ?? null,
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
    unix: info.unix ?? null,
    pid: info.pid,
    instanceId: info.instanceId,
    startedAt: info.startedAt,
    lease: health.lease ?? null,
    lease_remaining_ms: health.lease?.lease_remaining_ms ?? null,
    idle_timeout_ms: health.lease?.idle_timeout_ms ?? null,
  };
}

/**
 * `stoa daemon run` — daemon 前台进程本体（stoa-daemon design §1）。
 *
 * 写 daemon.json → 绑回环端口 → 挂信号处理器（SIGINT/SIGTERM/SIGHUP 都走同一清理：
 * 停全部挂载服务 → 移除 daemon.json → 关服退出）。`stoa daemon start` 与
 * `stoa serve`（默认模式）都以 detached 方式拉起它，因此它必须能安静地在后台活。
 */
import { chmodSync, existsSync, openSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import type { Server } from "bun";
import { fail } from "../core/errors.ts";
import { VERSION } from "../core/protocol.ts";
import { probeDaemon } from "./client.ts";
import { createDaemonApp, defaultDaemonUiDir, shutdownAll, type DaemonContext, type DaemonEntry } from "./server.ts";
import { createDaemonRouter } from "./router.ts";
import {
  appendDaemonLog,
  assertDaemonPort,
  daemonLogPath,
  ensureDaemonDirs,
  readDaemonInfo,
  removeDaemonInfo,
  writeDaemonInfo,
} from "./state.ts";

/**
 * 用当前进程自身当子服务入口：bin = 解释器（bun），args = [CLI 脚本]。
 * `stoa serve --standalone` / `stoa serve --stop` 都靠它拉起。
 */
export function daemonEntryFromProcess(): DaemonEntry {
  const script = resolve(process.argv[1] ?? "");
  if (!script || !existsSync(script)) {
    fail("INTERNAL", "cannot locate the stoa CLI entry for daemon spawning (process.argv[1])");
  }
  return { bin: process.execPath, args: [script] };
}

export interface RunDaemonOptions {
  stateDir: string;
  port: number;
  host?: string;
  cwd?: string;
  uiDir?: string | null;
  entry?: DaemonEntry;
}

export async function runDaemon(opts: RunDaemonOptions): Promise<number> {
  let port: number;
  try {
    port = assertDaemonPort(opts.port);
  } catch (err) {
    fail("BAD_REQUEST", (err as Error).message);
  }
  const host = opts.host ?? "127.0.0.1";
  const stateDir = resolve(opts.stateDir);
  ensureDaemonDirs(stateDir);

  const existing = readDaemonInfo(stateDir);
  if (existing) {
    if (await probeDaemon(existing.url, 600)) {
      fail("CONFLICT", `daemon already running at ${existing.url} (pid ${existing.pid}) for ${stateDir}`);
    }
    removeDaemonInfo(stateDir); // stale（进程已死）
  }

  const startedAt = Date.now();
  const url = `http://${host}:${port}`;
  let server: Server<undefined> | null = null;
  /** `[::1]:<port>` 次监听（尽力而为；失败为 null）。 */
  let secondary: Server<undefined> | null = null;
  let shuttingDown = false;

  const ctx: DaemonContext = {
    stateDir,
    version: VERSION,
    startedAt,
    url,
    host,
    entry: opts.entry ?? daemonEntryFromProcess(),
    uiDir: opts.uiDir === undefined ? defaultDaemonUiDir() : opts.uiDir,
    log: (line) => appendDaemonLog(stateDir, line),
    shutdown: async () => {
      await shutdown("api");
    },
  };

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.log(`shutdown (${reason})`);
    try {
      await shutdownAll(ctx);
    } catch (err) {
      ctx.log(`shutdownAll failed: ${(err as Error).message}`);
    }
    removeDaemonInfo(stateDir);
    try {
      secondary?.stop(true);
    } catch {
      // already stopped
    }
    try {
      server?.stop(true);
    } catch {
      // already stopped
    }
    ctx.log("daemon exited");
    process.exit(0);
  }

  const app = createDaemonApp(ctx);
  // 单入口路由：daemon host → 实例 hostnames → /i/<idOrSlug>/ → daemon app（design §2）。
  // 反代响应绕过 Hono，因此 daemon 的 CORS 中间件不会作用于实例响应（§3.2）。
  const route = createDaemonRouter({
    stateDir,
    daemonHosts: [host],
    appFetch: (req) => app.fetch(req),
    log: ctx.log,
  });
  try {
    server = Bun.serve({
      hostname: host,
      port,
      fetch: (req) => route(req),
      idleTimeout: 0,
      development: false,
    });
  } catch (err) {
    fail("CONFLICT", `cannot bind ${host}:${port}: ${(err as Error).message}`);
  }

  // 尽力加 `[::1]` 次监听（`localhost` 在部分客户端解析到 IPv6）：失败仅告警，不影响主监听。
  if (host === "127.0.0.1") {
    try {
      secondary = Bun.serve({
        hostname: "::1",
        port,
        fetch: (req) => route(req),
        idleTimeout: 0,
        development: false,
      });
      ctx.log(`secondary listen on [::1]:${port}`);
    } catch (err) {
      ctx.log(`secondary listen on [::1]:${port} skipped: ${(err as Error).message}`);
    }
  }

  // 绑定成功 ≠ 端口归我们（本机 Bun 可静默共享回环端口）：用 /healthz 的 pid 自证。
  try {
    if (host === "127.0.0.1" || host === "localhost") {
      const res = await fetch(`${url}/healthz`, {
        signal: AbortSignal.timeout(1500),
        headers: { accept: "application/json" },
      });
      const body = (await res.json()) as { pid?: unknown };
      if (!res.ok || body.pid !== process.pid) {
        try {
          server.stop(true);
        } catch {
          // already stopped
        }
        fail("CONFLICT", `port ${port} is served by another process on this machine`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("served by another")) throw err;
  }

  writeDaemonInfo(stateDir, {
    pid: process.pid,
    port,
    url,
    stateDir,
    version: VERSION,
    startedAt,
  });
  ctx.log(`daemon listening on ${url} (pid ${process.pid})`);
  // 常驻进程把发现信息放 stdout 首行（detached 拉起时落 daemon.log）。
  process.stdout.write(`STOA_DAEMON_URL=${url}\n`);
  // detached 进程不应被终端的挂断信号带走（新会话已隔离；这里再兜一层保险）。
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise(() => {});
  return 0;
}

/** CLI detached 拉起 daemon 前调用：确保目录/文件存在并以 0600 追加模式打开日志 fd（调用方负责 close）。 */
export function openDaemonLogFd(stateDir: string): number {
  ensureDaemonDirs(stateDir);
  const logPath = daemonLogPath(stateDir);
  const fd = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  return fd;
}

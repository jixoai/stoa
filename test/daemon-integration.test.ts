/**
 * daemon 真实进程集成（stoa-daemon design §5）：
 *   daemon run → mount（spawn `serve --standalone`）→ 服务 /healthz 200 → 列表 →
 *   serve --stop（daemon 感知）→ DELETE 登记 → daemon shutdown；以及 CLI 默认
 *   `serve` 的 detached 语义（stdout 单行 JSON、终端立即返回）。
 *
 * 隔离纪律：全部状态写进 mkdtemp 的 state-dir（STOA_DAEMON_STATE_DIR），
 * 端到端回收（daemon 与所有子服务进程）后才删目录；绝不触碰真实 daemon。
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonRequest, probeDaemon } from "../src/daemon/client.ts";
import { readDaemonInfo, readServices, type ServiceRecord } from "../src/daemon/state.ts";
import { BUN, CLI, initWorkspace, runCli, type TestWorkspace } from "./helpers.ts";

/** 其它会话/生产占用的端口（qa-serve 的 RESERVED_PORTS 同表）。 */
const RESERVED = new Set([13689, 13690, 13696, 13697]);

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
});

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** 端口可用性用真实 bind 判定（关闭后立即可复用）。 */
async function pickFreePort(min: number, max: number, exclude: Set<number>): Promise<number> {
  for (let port = max; port >= min; port--) {
    if (exclude.has(port)) continue;
    try {
      const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("x") });
      await server.stop(true);
      return port;
    } catch {
      // busy
    }
  }
  throw new Error(`no free port in ${min}-${max}`);
}

function pidAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 把一个 workspace+state-dir 的整套资源（含任何残留进程）注册进 afterAll 回收。 */
function registerCleanup(ws: TestWorkspace, stateDir: string, alsoPids: Array<number | null>): void {
  cleanups.push(() => {
    const pids = [
      ...readServices(stateDir).flatMap((service) => [service.pid]),
      ...alsoPids,
    ];
    for (const pid of pids) {
      if (pid !== null && pidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
    ws.cleanup();
  });
}

test(
  "daemon lifecycle: run → mount → healthz → list → stop → delete → shutdown",
  async () => {
    const ws = initWorkspace({ open: true });
    const stateDir = mkdtempSync(join(tmpdir(), "stoa-daemon-state-"));
    const daemonPort = await pickFreePort(13670, 13679, RESERVED);
    const servicePort = await pickFreePort(13680, 13699, new Set([...RESERVED, daemonPort]));
    const url = `http://127.0.0.1:${daemonPort}`;

    const proc = Bun.spawn({
      cmd: [BUN, CLI, "daemon", "run", "--port", String(daemonPort), "--state-dir", stateDir],
      cwd: ws.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, STOA_DAEMON_STATE_DIR: stateDir },
    });
    registerCleanup(ws, stateDir, [proc.pid]);

    await waitFor(async () => Boolean(await probeDaemon(url, 400)), 15_000, "daemon healthz");

    // mount
    const mounted = await daemonRequest<{ service: ServiceRecord; reused: boolean; adopted: boolean }>(
      url,
      "/api/daemon/services",
      { method: "POST", body: { dataDir: ws.dataDir, port: servicePort, name: "it-board" } },
    );
    expect(mounted.reused).toBe(false);
    expect(mounted.adopted).toBe(false);
    expect(mounted.service.name).toBe("it-board");
    expect(mounted.service.port).toBe(servicePort);
    expect(mounted.service.status).toBe("running");
    const health = (await (await fetch(`${mounted.service.url}/healthz`)).json()) as {
      ok: boolean;
      dataDir: string;
    };
    expect(health.ok).toBe(true);
    expect(health.dataDir).toBe(ws.dataDir);

    // 幂等重挂载：不加新进程，直接复用既有登记
    const again = await daemonRequest<{ service: ServiceRecord; reused: boolean }>(
      url,
      "/api/daemon/services",
      { method: "POST", body: { dataDir: ws.dataDir, port: servicePort } },
    );
    expect(again.reused).toBe(true);
    expect(again.service.id).toBe(mounted.service.id);
    expect(again.service.pid).toBe(mounted.service.pid);

    // 列表（含登记文件视角）
    const list = await daemonRequest<{ services: ServiceRecord[] }>(url, "/api/daemon/services");
    expect(list.services.filter((s) => s.status === "running")).toHaveLength(1);
    expect(readServices(stateDir).filter((s) => s.status === "running")).toHaveLength(1);

    // 未初始化目录拒绝
    await expect(
      daemonRequest(url, "/api/daemon/services", {
        method: "POST",
        body: { dataDir: join(ws.root, "not-initialized") },
      }),
    ).rejects.toThrow("not initialized");

    // stop（含登记降级为 stopped）。时限断言＝回归守卫：stop 子进程若回调 daemon 会重入死锁
    // （实测悬挂到 20s HTTP 超时才回落），正常应在数秒内完成。
    const stopStarted = Date.now();
    const stopped = await daemonRequest<{ service: ServiceRecord }>(
      url,
      `/api/daemon/services/${mounted.service.id}/stop`,
      { method: "POST" },
    );
    expect(Date.now() - stopStarted).toBeLessThan(8_000);
    expect(stopped.service.status).toBe("stopped");
    await waitFor(
      async () => {
        try {
          await fetch(`${mounted.service.url}/healthz`, { signal: AbortSignal.timeout(300) });
          return false;
        } catch {
          return true;
        }
      },
      8_000,
      "service death",
    );
    expect(pidAlive(mounted.service.pid)).toBe(false);

    // 已停 → 可以移除登记；移除后列表为空
    const removed = await daemonRequest<{ removed: string }>(
      url,
      `/api/daemon/services/${mounted.service.id}`,
      { method: "DELETE" },
    );
    expect(removed.removed).toBe(mounted.service.id);
    expect(readServices(stateDir)).toHaveLength(0);

    // shutdown：daemon 退出并清掉 daemon.json
    await daemonRequest(url, "/api/daemon/shutdown", { method: "POST" });
    await waitFor(async () => !(await probeDaemon(url, 300)), 20_000, "daemon exit");
    expect(readDaemonInfo(stateDir)).toBeNull();
    expect(existsSync(join(stateDir, "daemon.json"))).toBe(false);
  },
  120_000,
);

test(
  "cli serve (default) detaches into the daemon; daemon stop reclaims everything",
  async () => {
    const ws = initWorkspace({ open: true });
    const stateDir = mkdtempSync(join(tmpdir(), "stoa-daemon-state-"));
    const daemonPort = await pickFreePort(13670, 13679, RESERVED);
    const servicePort = await pickFreePort(13680, 13699, new Set([...RESERVED, daemonPort]));
    registerCleanup(ws, stateDir, []);

    const env = {
      STOA_DAEMON_STATE_DIR: stateDir,
      STOA_DAEMON_PORT: String(daemonPort),
    };

    // 默认 serve：终端立即返回，stdout 单行 JSON（detached）
    const res = await runCli(["serve", "--data-dir", ws.dataDir, "--port", String(servicePort)], {
      cwd: ws.cwd,
      env,
      timeoutMs: 60_000,
    });
    expect(res.code).toBe(0);
    const line = res.stdout.split("\n").find((l) => l.trim().startsWith("{"));
    expect(line).toBeTruthy();
    const out = JSON.parse(line!) as {
      ok: boolean;
      detached: boolean;
      service_url: string;
      daemon_url: string;
      service: { port: number; status: string };
      daemon: { pid: number };
    };
    expect(out.ok).toBe(true);
    expect(out.detached).toBe(true);
    expect(out.service.port).toBe(servicePort);
    expect(out.service_url).toBe(`http://127.0.0.1:${servicePort}`);
    expect(out.daemon_url).toBe(`http://127.0.0.1:${daemonPort}`);

    const health = (await (await fetch(`${out.service_url}/healthz`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);

    // daemon status（CLI）
    const status = await runCli(["daemon", "status", "--state-dir", stateDir], {
      cwd: ws.cwd,
      timeoutMs: 30_000,
    });
    const statusOut = JSON.parse(status.stdout.trim().split("\n").pop()!) as {
      running: boolean;
      services: ServiceRecord[];
    };
    expect(statusOut.running).toBe(true);
    expect(statusOut.services.filter((s) => s.status === "running")).toHaveLength(1);

    // serve --stop 走 daemon（登记同步收口；时限守卫防重入死锁回归）
    const stopStarted = Date.now();
    const stop = await runCli(["serve", "--stop", "--data-dir", ws.dataDir, "--state-dir", stateDir], {
      cwd: ws.cwd,
      timeoutMs: 60_000,
    });
    expect(Date.now() - stopStarted).toBeLessThan(10_000);
    const stopOut = JSON.parse(stop.stdout.trim().split("\n").pop()!) as {
      stopped: boolean;
      via_daemon?: boolean;
    };
    expect(stopOut.stopped).toBe(true);
    expect(stopOut.via_daemon).toBe(true);

    // daemon stop：daemon 走 API 退出
    const dstop = await runCli(["daemon", "stop", "--state-dir", stateDir], {
      cwd: ws.cwd,
      timeoutMs: 60_000,
    });
    const dstopOut = JSON.parse(dstop.stdout.trim().split("\n").pop()!) as {
      stopped: boolean;
      forced: boolean;
    };
    expect(dstopOut.stopped).toBe(true);
    expect(dstopOut.forced).toBe(false);

    await waitFor(
      async () => !(await probeDaemon(`http://127.0.0.1:${daemonPort}`, 300)),
      15_000,
      "daemon exit",
    );
    expect(readDaemonInfo(stateDir)).toBeNull();
    // 服务与登记都已收口
    for (const service of readServices(stateDir)) {
      expect(pidAlive(service.pid)).toBe(false);
    }
    await expect(fetch(`${out.service_url}/healthz`, { signal: AbortSignal.timeout(400) })).rejects.toThrow();
  },
  180_000,
);

/**
 * daemon 真实进程集成（daemon-unified-port design §1/§2，P1）：
 *   daemon run → mount（spawn `serve --unix …`，**不占 TCP 端口**）→ 服务 healthz（经 UDS）→
 *   列表（slug/socket/逻辑 URL）→ serve --stop（daemon 感知）→ DELETE 登记 → daemon shutdown；
 *   以及 CLI 默认 `serve` 的 detached 语义（stdout 单行 JSON、终端立即返回）。
 *
 * 隔离纪律：全部状态写进 mkdtemp 的 state-dir（STOA_DAEMON_STATE_DIR），
 * 端到端回收（daemon 与所有子服务进程）后才删目录；绝不触碰真实 daemon 或生产板端口。
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { daemonRequest, probeDaemon } from "../src/daemon/client.ts";
import { readDaemonInfo, readServices, type ServiceRecord } from "../src/daemon/state.ts";
import { readServerInfo } from "../src/server/discovery.ts";
import { instanceFetch } from "../src/server/instance-client.ts";
import { BUN, CLI, initWorkspace, runCli, type TestWorkspace } from "./helpers.ts";
import { portIsListening } from "../src/server/ports.ts";

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
    // Bun 对已占用端口不抛错（会静默共享），所以用 TCP 探测判定空闲。
    if (await portIsListening("127.0.0.1", port)) continue;
    return port;
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

/**
 * 把一个 workspace+state-dir 的整套资源（含任何残留进程）注册进 afterAll 回收。
 * `readDaemonInfo` 里的 daemon 也要杀：CLI 默认 `serve` 会 **detached** 拉起 daemon，
 * 测试中途失败时它不会随子进程退出（2026-11-12 实证：失败跑残留两个孤儿 daemon 占端口）。
 */
function registerCleanup(ws: TestWorkspace, stateDir: string, alsoPids: Array<number | null>): void {
  cleanups.push(() => {
    const pids = [
      ...readServices(stateDir).flatMap((service) => [service.pid]),
      readDaemonInfo(stateDir)?.pid ?? null,
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
  "daemon lifecycle: run → mount(UDS) → healthz via socket → list → stop → delete → shutdown",
  async () => {
    const ws = initWorkspace({ open: true });
    const stateDir = mkdtempSync(join(tmpdir(), "stoa-daemon-state-"));
    const daemonPort = await pickFreePort(13670, 13679, RESERVED);
    // 兼容参数：daemon 托管模式下端口已退役，显式给值必须被忽略并提示（不静默失败）。
    const retiredPort = await pickFreePort(13680, 13699, new Set([...RESERVED, daemonPort]));
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

    // mount：daemon 托管实例只监听 UDS（不占 TCP），slug/逻辑 URL/socket 三件套齐备。
    const mounted = await daemonRequest<{
      service: ServiceRecord;
      reused: boolean;
      adopted: boolean;
      warnings: string[];
    }>(url, "/api/daemon/services", {
      method: "POST",
      body: { dataDir: ws.dataDir, port: retiredPort, name: "it-board" },
    });
    expect(mounted.reused).toBe(false);
    expect(mounted.adopted).toBe(false);
    expect(mounted.service.name).toBe("it-board");
    expect(mounted.service.slug).toBe("it-board");
    expect(mounted.service.hostnames).toEqual([]);
    expect(mounted.service.authAccount).toBe("owner");
    // 端口已退役：记录为 null，且给出可见提示（显式请求不静默丢失）
    expect(mounted.service.port).toBeNull();
    expect(mounted.warnings.join(" ")).toContain("已退役");
    // socket 落在 `<stateDir>/sockets/<id>.sock`；tmpdir 深路径超 90 字符会 fallback 到
    // `os.tmpdir()/stoa-sock-<hash>/<id>.sock`（design §1.1）——两种情况都以 server.json 为准。
    expect(mounted.service.socket!.endsWith(`${mounted.service.id}.sock`)).toBe(true);
    expect(existsSync(mounted.service.socket!)).toBe(true);
    expect(statSync(dirname(mounted.service.socket!)).mode & 0o777).toBe(0o700);
    const socketDir = dirname(mounted.service.socket!);
    expect(
      socketDir === join(stateDir, "sockets") || /stoa-sock-[0-9a-f]{8}$/.test(socketDir),
    ).toBe(true);
    // 逻辑 URL = daemon 基址 + /i/<slug>/（浏览器通道，不再有自己的 TCP 端口）
    expect(mounted.service.url).toBe(`${url}/i/it-board/`);
    expect(new URL(mounted.service.url!).port).toBe(String(daemonPort));
    // server.json 自证：port=null + unix
    const info = readServerInfo(ws.dataDir)!;
    expect(info.port).toBeNull();
    expect(info.unix).toBe(mounted.service.socket);
    // 健康探测走 UDS（instanceFetch）
    const health = (await (await instanceFetch({ unix: info.unix }, "/healthz")).json()) as {
      ok: boolean;
      dataDir: string;
    };
    expect(health.ok).toBe(true);
    expect(health.dataDir).toBe(ws.dataDir);
    // 实例进程**没有任何 TCP 监听**（单端口目标；lsof 存在时做机器断言）
    const lsof = Bun.which("lsof");
    if (lsof) {
      const out = Bun.spawnSync([
        lsof,
        "-nP",
        "-iTCP",
        "-a",
        "-p",
        String(mounted.service.pid),
      ]);
      expect(out.stdout.toString().trim()).toBe("");
    }
    // 同一 daemon 端口的路径模式也能到达实例（P1 单入口）
    const viaProxy = await fetch(`${url}/i/it-board/healthz`);
    expect(viaProxy.status).toBe(200);
    expect(((await viaProxy.json()) as { dataDir: string }).dataDir).toBe(ws.dataDir);

    // 幂等重挂载：不加新进程，直接复用既有登记
    const again = await daemonRequest<{ service: ServiceRecord; reused: boolean }>(
      url,
      "/api/daemon/services",
      { method: "POST", body: { dataDir: ws.dataDir } },
    );
    expect(again.reused).toBe(true);
    expect(again.service.id).toBe(mounted.service.id);
    expect(again.service.pid).toBe(mounted.service.pid);

    // 列表（含登记文件视角）
    const list = await daemonRequest<{ services: ServiceRecord[] }>(url, "/api/daemon/services");
    expect(list.services.filter((s) => s.status === "running")).toHaveLength(1);
    expect(readServices(stateDir).filter((s) => s.status === "running")).toHaveLength(1);

    // 临时会话（stoa-session-ux）：无 dataDir、自动初始化、默认开口令；停止后目录删除
    const temp = await daemonRequest<{ service: ServiceRecord }>(url, "/api/daemon/services", {
      method: "POST",
      body: { location: "temp", name: "it-temp" },
    });
    expect(temp.service.ephemeral).toBe(true);
    expect(temp.service.port).toBeNull();
    expect(temp.service.slug).toBe("it-temp");
    expect(existsSync(join(temp.service.dataDir, "report.sqlite"))).toBe(true);
    const tempSecret = await daemonRequest<{ mode: string; key: string | null; key_link: string | null }>(
      url,
      `/api/daemon/services/${temp.service.id}/secret`,
    );
    expect(tempSecret.mode).toBe("auth");
    expect(typeof tempSecret.key).toBe("string");
    expect(tempSecret.key_link).toBeNull(); // 托管实例无 #key 链接（仅 standalone 直连）
    await daemonRequest(url, `/api/daemon/services/${temp.service.id}/stop`, { method: "POST" });
    expect(existsSync(temp.service.dataDir)).toBe(false);
    expect(readServices(stateDir).some((s) => s.id === temp.service.id)).toBe(false);

    // stop（含登记降级为 stopped + socket 清理）。时限断言＝回归守卫：stop 子进程若回调
    // daemon 会重入死锁（实测悬挂到 20s HTTP 超时才回落），正常应在数秒内完成。
    const stopStarted = Date.now();
    const stopped = await daemonRequest<{ service: ServiceRecord }>(
      url,
      `/api/daemon/services/${mounted.service.id}/stop`,
      { method: "POST" },
    );
    expect(Date.now() - stopStarted).toBeLessThan(8_000);
    expect(stopped.service.status).toBe("stopped");
    expect(stopped.service.socket).toBeNull();
    expect(pidAlive(mounted.service.pid)).toBe(false);
    // socket 文件已清理：经 UDS 不再可达
    expect(existsSync(mounted.service.socket!)).toBe(false);
    const deadBytes = await instanceFetch({ unix: mounted.service.socket! }, "/healthz").then(
      () => null,
      (err) => err as Error,
    );
    expect(deadBytes).not.toBeNull();
    // 路径模式也变成 502（不再回落控制台 HTML）
    const deadProxy = await fetch(`${url}/i/it-board/healthz`);
    expect(deadProxy.status).toBe(502);

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
    registerCleanup(ws, stateDir, []);

    const env = {
      STOA_DAEMON_STATE_DIR: stateDir,
      STOA_DAEMON_PORT: String(daemonPort),
    };

    // 默认 serve：终端立即返回，stdout 单行 JSON（detached）
    const res = await runCli(["serve", "--data-dir", ws.dataDir], {
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
      service: { port: number | null; status: string; slug: string; socket?: string | null; url: string };
      daemon: { pid: number };
    };
    expect(out.ok).toBe(true);
    expect(out.detached).toBe(true);
    // 单端口契约：托管实例不占 TCP，入口是 daemon 同一端口的 /i/<slug>/
    expect(out.service.port).toBeNull();
    expect(out.service_url).toBe(`http://127.0.0.1:${daemonPort}/i/${out.service.slug}/`);
    expect(out.service_url).toBe(out.service.url);
    expect(out.daemon_url).toBe(`http://127.0.0.1:${daemonPort}`);
    expect(typeof out.service.socket).toBe("string");

    const info = readServerInfo(ws.dataDir)!;
    expect(info.port).toBeNull();
    expect(info.unix).toBe(out.service.socket);
    const health = (await (await instanceFetch({ unix: info.unix }, "/healthz")).json()) as {
      ok: boolean;
    };
    expect(health.ok).toBe(true);
    // 浏览器通道（路径模式）同样可用
    expect((await fetch(`${out.service_url}healthz`)).status).toBe(200);

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
    expect(statusOut.services[0]!.port).toBeNull();
    expect(statusOut.services[0]!.slug).toBe(out.service.slug);

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
    // 路径模式在 daemon 退出后不再可用（不静默回落到别的实例）
    const leftover = await fetch(`${out.service_url}healthz`, { signal: AbortSignal.timeout(500) })
      .then(() => true)
      .catch(() => false);
    expect(leftover).toBe(false);
  },
  180_000,
);

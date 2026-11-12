/**
 * 读时校正（reconcile）的安全边界（实现复核 B1）与 healthz 过滤一致性（B2）。
 *
 * B1：实例忙于同步导出（>600ms）时软探测会超时——校正**只降级、不得删 socket/清通道**，
 *     否则活实例永久失联且重新挂载撞锁；探测通过后应自愈回 running。
 * B2：`/i/<slug>/healthz/`（尾斜杠）也必须走四字段过滤，不能把上游 body 原样透传。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonApp, type DaemonContext } from "../src/daemon/server.ts";
import { createDaemonRouter } from "../src/daemon/router.ts";
import { DaemonAuth } from "../src/daemon/daemon-auth.ts";
import { writeServerInfo } from "../src/server/discovery.ts";
import {
  DEFAULT_AUTH_ACCOUNT,
  readServices,
  writeServices,
  type ServiceRecord,
} from "../src/daemon/state.ts";

const dirs: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterAll(() => {
  for (const server of servers.reverse()) {
    try {
      server.stop(true);
    } catch {
      // ignore
    }
  }
  for (const dir of dirs.reverse()) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function record(overrides: Partial<ServiceRecord> & { id: string }): ServiceRecord {
  return {
    name: overrides.id,
    slug: overrides.id,
    hostnames: [],
    dataDir: `/tmp/${overrides.id}`,
    port: null,
    pid: null,
    url: `http://127.0.0.1:13679/i/${overrides.id}/`,
    socket: null,
    authAccount: DEFAULT_AUTH_ACCOUNT,
    log: null,
    startedAt: 1,
    status: "running",
    ...overrides,
  };
}

function ctxFor(stateDir: string): DaemonContext {
  return {
    stateDir,
    version: "0.7.0",
    startedAt: 1,
    url: "http://127.0.0.1:13679",
    host: "127.0.0.1",
    entry: { bin: process.execPath, args: [] },
    uiDir: null,
    log: () => {},
    auth: new DaemonAuth({ stateDir, flushDelayMs: 0 }),
    shutdown: async () => {},
  };
}

/** 慢健康检查上游：模拟「实例正忙于同步导出」（>600ms 才会触发旧缺陷）。 */
function slowUpstream(
  dir: string,
  delayMs: number,
  health: { dataDir: string; instanceId: string },
): { socket: string; stop: () => void } {
  const socketPath = join(dir, "slow.sock");
  const server = Bun.serve({
    unix: socketPath,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return Response.json({
          ok: true,
          instanceId: health.instanceId,
          dataDir: health.dataDir,
          version: "0.7.0",
          port: null,
          lease: { mode: "idle" },
          hub: { clients: 0 },
          preview_policy: "static",
        });
      }
      return Response.json({ ok: true, path: url.pathname });
    },
  });
  servers.push(server);
  return { socket: socketPath, stop: () => server.stop(true) };
}

describe("reconcile 安全边界（B1）", () => {
  test("慢实例（900ms）不被误降级，socket 保留", async () => {
    const stateDir = tempDir("stoa-reconcile-state-");
    const dataDir = tempDir("stoa-reconcile-data-");
    const upstream = slowUpstream(tempDir("stoa-reconcile-up-"), 900, {
      dataDir,
      instanceId: "inst-slow",
    });
    writeServerInfo(dataDir, {
      instanceId: "inst-slow",
      dataDir,
      port: null,
      unix: upstream.socket,
      url: "http://127.0.0.1:13679/i/slow/",
      pid: 4242,
      version: "0.7.0",
      host: "127.0.0.1",
      envFiles: [],
      openMode: false,
      startedAt: 1,
    });
    writeServices(stateDir, [record({ id: "slow", slug: "slow", socket: upstream.socket, dataDir })]);
    const app = createDaemonApp(ctxFor(stateDir));

    const res = await app.fetch(new Request("http://127.0.0.1:13679/api/daemon/services"));
    const body = (await res.json()) as { services: Array<{ status: string; socket: string | null }> };
    expect(body.services[0]!.status).toBe("running");
    expect(body.services[0]!.socket).toBe(upstream.socket);
    expect(existsSync(upstream.socket)).toBe(true);
  }, 20_000);

  test("实例真死：降级 stopped 但**不删** socket；复活后自愈回 running", async () => {
    const stateDir = tempDir("stoa-reconcile-state-");
    const upDir = tempDir("stoa-reconcile-up-");
    const dataDir = tempDir("stoa-reconcile-data-");
    const upstream = slowUpstream(upDir, 0, { dataDir, instanceId: "inst-slow" });
    const socket = upstream.socket;
    writeServerInfo(dataDir, {
      instanceId: "inst-slow",
      dataDir,
      port: null,
      unix: socket,
      url: "http://127.0.0.1:13679/i/slow/",
      pid: 4242,
      version: "0.7.0",
      host: "127.0.0.1",
      envFiles: [],
      openMode: false,
      startedAt: 1,
    });
    writeServices(stateDir, [record({ id: "slow", slug: "slow", socket, dataDir })]);
    const app = createDaemonApp(ctxFor(stateDir));

    upstream.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const down = await app.fetch(new Request("http://127.0.0.1:13679/api/daemon/services"));
    const downBody = (await down.json()) as {
      services: Array<{ status: string; socket: string | null }>;
    };
    expect(downBody.services[0]!.status).toBe("stopped");
    // 破坏性清理已移除：登记通道保留（socket 文件由上游进程 stop 自己删除，不是 daemon 动作）
    expect(downBody.services[0]!.socket).toBe(socket);
    expect(readServices(stateDir)[0]!.socket).toBe(socket);

    // 同 socket 复活 → 读时校正自愈回 running（不需要重新挂载）
    const revived = slowUpstream(upDir, 0, { dataDir, instanceId: "inst-slow" });
    expect(revived.socket).toBe(socket);
    const up = await app.fetch(new Request("http://127.0.0.1:13679/api/daemon/services"));
    const upBody = (await up.json()) as { services: Array<{ status: string }> };
    expect(upBody.services[0]!.status).toBe("running");
  }, 30_000);
});

describe("healthz 过滤一致性（B2）", () => {
  test("/healthz 与 /healthz/ 都过滤为四字段（未登录/已登录同口径）", async () => {
    const stateDir = tempDir("stoa-hz-state-");
    const hzDataDir = tempDir("stoa-hz-data-");
    const upstream = slowUpstream(tempDir("stoa-hz-up-"), 0, {
      dataDir: hzDataDir,
      instanceId: "inst-slow",
    });
    writeServices(stateDir, [record({ id: "board", slug: "board", socket: upstream.socket })]);
    const app = createDaemonApp(ctxFor(stateDir));
    const router = createDaemonRouter({
      stateDir,
      daemonHosts: ["127.0.0.1"],
      auth: { authenticated: () => false },
      appFetch: (req) => app.fetch(req),
    });

    for (const path of ["/i/board/healthz", "/i/board/healthz/"]) {
      const res = await router(
        new Request(`http://127.0.0.1:13679${path}`, { headers: { host: "127.0.0.1" } }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["dataDir", "instanceId", "ok", "uiVersion"]);
      expect(body.port).toBeUndefined();
      expect(body.lease).toBeUndefined();
    }
  }, 20_000);
});

/**
 * daemon 路由门与豁免（daemon-unified-port design §4.1 / spec「daemon 路由门与豁免」，S3-3）。
 *
 * 覆盖：页面 302（带 next）/ API 401、任何来源豁免（healthz / login / auth API / 静态资产 /
 * 实例 healthz）、机器通道「loopback peer **且** loopback Host」双条件（公网 Host 必须登录）、
 * Host 模式的 `/healthz` 豁免、登录后放行。
 *
 * 全部在 mkdtemp 状态目录 + 真实 UDS 上游上跑；不碰既有 daemon/端口。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideDaemonGate } from "../src/daemon/gate.ts";
import { createDaemonRouter } from "../src/daemon/router.ts";
import {
  DEFAULT_AUTH_ACCOUNT,
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
      // already stopped
    }
  }
  for (const dir of dirs.reverse()) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function startUpstream(dir: string, name: string): string {
  const socketPath = join(dir, `${name}.sock`);
  const server = Bun.serve({
    unix: socketPath,
    fetch: (req) => {
      const url = new URL(req.url);
      return Response.json({ upstream: name, path: url.pathname, method: req.method });
    },
  });
  servers.push(server);
  return socketPath;
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

const daemonAuth = { authenticated: () => false };
const loggedIn = { authenticated: () => true };

function routerFor(stateDir: string, auth = daemonAuth) {
  return createDaemonRouter({
    stateDir,
    daemonHosts: ["127.0.0.1"],
    auth,
    appFetch: (req) => Response.json({ daemon: true, path: new URL(req.url).pathname }),
  });
}

describe("decideDaemonGate（纯判定矩阵）", () => {
  const base = {
    method: "GET",
    pathname: "/",
    host: "127.0.0.1",
    peerAddress: "127.0.0.1",
    authenticated: false,
  };

  test("登录后一律放行（含 API 与页面）", () => {
    expect(decideDaemonGate({ ...base, authenticated: true }).action).toBe("allow");
    expect(
      decideDaemonGate({ ...base, authenticated: true, pathname: "/api/daemon/services" }).action,
    ).toBe("allow");
  });

  test("任何来源豁免：healthz / login / auth API / 静态资产", () => {
    for (const pathname of ["/healthz", "/login", "/api/daemon/auth/login", "/api/daemon/auth/status"]) {
      expect(decideDaemonGate({ ...base, pathname }).action).toBe("allow");
    }
    expect(decideDaemonGate({ ...base, pathname: "/assets/app-abc.js" }).action).toBe("allow");
    expect(decideDaemonGate({ ...base, pathname: "/favicon.ico" }).action).toBe("allow");
  });

  test("实例 healthz 任何来源放行；实例页面/其它 API 不放行", () => {
    expect(decideDaemonGate({ ...base, pathname: "/i/board/healthz" }).action).toBe("allow");
    expect(decideDaemonGate({ ...base, pathname: "/i/board/healthz", method: "POST" }).action).toBe(
      "login",
    );
    expect(decideDaemonGate({ ...base, pathname: "/i/board/api/posts" }).action).toBe(
      "unauthorized",
    );
    expect(decideDaemonGate({ ...base, pathname: "/i/board/" })).toEqual({
      action: "login",
      location: "/login?next=%2Fi%2Fboard%2F",
    });
  });

  test("Host 模式：实例 hostname 上的 /healthz 免登录，其它页面仍要登录", () => {
    expect(
      decideDaemonGate({ ...base, host: "board.localhost", hostRoutesToInstance: true, pathname: "/healthz" })
        .action,
    ).toBe("allow");
    expect(
      decideDaemonGate({ ...base, host: "board.localhost", hostRoutesToInstance: true, pathname: "/" })
        .action,
    ).toBe("login");
  });

  test("机器通道双条件：回环 peer + 回环 Host 才放行", () => {
    const machine = { ...base, pathname: "/api/daemon/services" };
    expect(decideDaemonGate(machine).action).toBe("allow");
    // 公网域名 Host（经 frp 落地，peer 仍是 127.0.0.1）→ 必须登录
    expect(decideDaemonGate({ ...machine, host: "stoa.fde2e.com" }).action).toBe("unauthorized");
    // 非回环 peer（直连网卡）→ 必须登录
    expect(decideDaemonGate({ ...machine, peerAddress: "192.168.1.20" }).action).toBe(
      "unauthorized",
    );
    // UDS 上 requestIP 为 null → 不放行
    expect(decideDaemonGate({ ...machine, peerAddress: null }).action).toBe("unauthorized");
    // preview 是页面面：未放行时 302 而不是 401（非回环 peer）
    expect(
      decideDaemonGate({ ...machine, pathname: "/preview/svc-1/", peerAddress: "10.0.0.5" }).action,
    ).toBe("login");
    expect(
      decideDaemonGate({ ...machine, pathname: "/preview/svc-1/", host: "stoa.fde2e.com" }).action,
    ).toBe("login");
    // 回环 peer + 回环 Host 的 preview 走机器通道（本机静态预览直开）
    expect(decideDaemonGate({ ...machine, pathname: "/preview/svc-1/" }).action).toBe("allow");
  });

  test("stoa.localhost 与自定义实例 hostname 不属于机器通道", () => {
    expect(
      decideDaemonGate({ ...base, pathname: "/api/daemon/services", host: "stoa.localhost" }).action,
    ).toBe("unauthorized");
    expect(
      decideDaemonGate({ ...base, pathname: "/api/daemon/services", host: "board.localhost" }).action,
    ).toBe("unauthorized");
  });

  test("next 保留 path+query", () => {
    expect(
      decideDaemonGate({ ...base, pathname: "/shell/board", search: "?tab=1" }),
    ).toEqual({ action: "login", location: "/login?next=%2Fshell%2Fboard%3Ftab%3D1" });
  });
});

describe("router 集成：门先于路由", () => {
  test("未登录：页面 302、API 401、实例 healthz 200（经代理）", async () => {
    const stateDir = tempDir("stoa-gate-state-");
    const socket = startUpstream(tempDir("stoa-gate-up-"), "board");
    writeServices(stateDir, [record({ id: "board", slug: "board", socket })]);
    const router = routerFor(stateDir);

    const page = await router(new Request("http://127.0.0.1:13679/", { headers: { host: "127.0.0.1" } }));
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login?next=%2F");

    const api = await router(
      new Request("http://127.0.0.1:13679/api/daemon/services", { headers: { host: "127.0.0.1" } }),
    );
    expect(api.status).toBe(401);
    expect(((await api.json()) as { ok: boolean }).ok).toBe(false);

    const healthz = await router(
      new Request("http://127.0.0.1:13679/i/board/healthz", { headers: { host: "127.0.0.1" } }),
    );
    expect(healthz.status).toBe(200);
    expect(((await healthz.json()) as { upstream: string }).upstream).toBe("board");

    const instancePage = await router(
      new Request("http://127.0.0.1:13679/i/board/", { headers: { host: "127.0.0.1" } }),
    );
    expect(instancePage.status).toBe(302);
    expect(instancePage.headers.get("location")).toBe("/login?next=%2Fi%2Fboard%2F");
  });

  test("登录后：页面与实例 API 都放行；机器通道 Host 条件对公网 Host 生效", async () => {
    const stateDir = tempDir("stoa-gate-state-");
    const socket = startUpstream(tempDir("stoa-gate-up-"), "board");
    writeServices(stateDir, [record({ id: "board", slug: "board", socket })]);
    const router = routerFor(stateDir, loggedIn);

    const page = await router(new Request("http://127.0.0.1:13679/", { headers: { host: "127.0.0.1" } }));
    expect(page.status).toBe(200);
    expect(((await page.json()) as { daemon: boolean }).daemon).toBe(true);

    const api = await router(
      new Request("http://127.0.0.1:13679/i/board/api/posts", { headers: { host: "127.0.0.1" } }),
    );
    expect(api.status).toBe(200);
    expect(((await api.json()) as { upstream: string }).upstream).toBe("board");
  });

  test("机器通道需要 peer 回环：无 peer 的请求必须登录", async () => {
    const stateDir = tempDir("stoa-gate-state-");
    writeServices(stateDir, []);
    const router = routerFor(stateDir);
    const res = await router(
      new Request("http://127.0.0.1:13679/api/daemon/services", { headers: { host: "127.0.0.1" } }),
    );
    expect(res.status).toBe(401);
  });
});

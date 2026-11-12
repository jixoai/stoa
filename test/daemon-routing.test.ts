/**
 * daemon 单入口路由（daemon-unified-port design §2，P1）：
 *   四优先级（daemon host → 实例 hostnames → `/i/<idOrSlug>/` → daemon app）、
 *   `/i/<key>` 302 补斜杠、未知实例 404；
 *   以及 slug 生成（1 字符/尾随 `-`/保留字/冲突后缀）与 hostname 校验（RFC1123/跨实例唯一/
 *   daemon host 保留）、服务登记的新旧兼容与 PATCH 编辑。
 *
 * 全部在 mkdtemp 状态目录 + 真实 UDS 上游上跑；不碰既有 daemon/端口。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonRouter } from "../src/daemon/router.ts";
import { createDaemonApp, type DaemonContext } from "../src/daemon/server.ts";
import {
  readServices,
  writeDaemonInfo,
  writeServices,
  type ServiceRecord,
  DEFAULT_AUTH_ACCOUNT,
} from "../src/daemon/state.ts";
import { DEFAULT_BASE_URL, resolveMcpConfig } from "../src/mcp/config.ts";
import {
  isValidHostname,
  isValidSlug,
  RESERVED_SLUGS,
  serviceSlug,
  slugBase,
  validateHostnames,
} from "../src/daemon/slug.ts";

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

/** 上游实例桩：把收到的 path/method/头原样回显（验证剥前缀与头语义）。 */
function startUpstream(dir: string, name: string): string {
  const socketPath = join(dir, `${name}.sock`);
  const server = Bun.serve({
    unix: socketPath,
    fetch: (req) => {
      const url = new URL(req.url);
      return Response.json({
        upstream: name,
        path: url.pathname,
        search: url.search,
        method: req.method,
        service: req.headers.get("x-stoa-service"),
        proxy: req.headers.get("x-stoa-daemon-proxy"),
      });
    },
  });
  servers.push(server);
  return socketPath;
}

function record(overrides: Partial<ServiceRecord> & { id: string }): ServiceRecord {
  return {
    name: overrides.id,
    slug: overrides.id.replace(/^svc-/, ""),
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

function seed(records: ServiceRecord[]): string {
  const stateDir = tempDir("stoa-route-state-");
  writeServices(stateDir, records);
  return stateDir;
}

const DAEMON_URL = "http://127.0.0.1:13679";
const appCalls: string[] = [];

function routerFor(stateDir: string) {
  return createDaemonRouter({
    stateDir,
    daemonHosts: ["127.0.0.1"],
    appFetch: (req) => {
      const path = new URL(req.url).pathname;
      appCalls.push(path);
      return Response.json({ daemon: true, path });
    },
  });
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("slug 生成（独立于会话目录 slugify）", () => {
  test("1 字符补 x；尾随/前导 - 去掉；非字母数字折叠并压缩", () => {
    expect(slugBase("a")).toBe("ax");
    expect(slugBase("-a-")).toBe("ax");
    expect(slugBase("Board -- One!!")).toBe("board-one");
    expect(slugBase("")).toBe("board");
    expect(slugBase("!!!")).toBe("board");
  });

  test("超长截断到 32 且不留尾随 -", () => {
    const long = "a".repeat(40);
    expect(serviceSlug(long).length).toBe(32);
    expect(serviceSlug(`${"a".repeat(31)} b`).endsWith("-")).toBe(false);
  });

  test("保留字顺延后缀（api/assets/i/healthz/favicon.ico…）", () => {
    for (const reserved of RESERVED_SLUGS) {
      const slug = serviceSlug(reserved);
      expect(RESERVED_SLUGS.has(slug)).toBe(false);
      expect(isValidSlug(slug)).toBe(true);
    }
    expect(serviceSlug("api")).toBe("api-2");
    // 1 字符先补 `x`（`i` → `ix`）——已不是保留字，无需后缀。
    expect(serviceSlug("i")).toBe("ix");
    expect(serviceSlug("shell")).toBe("shell-2");
  });

  test("冲突后缀 -2/-3…；后缀不破坏 32 字符上限", () => {
    expect(serviceSlug("board", ["board"])).toBe("board-2");
    expect(serviceSlug("board", ["board", "board-2"])).toBe("board-3");
    const base = "b".repeat(32);
    const withSuffix = serviceSlug(base, [base, `${"b".repeat(30)}-2`]);
    expect(withSuffix.length).toBeLessThanOrEqual(32);
    expect(withSuffix).toBe(`${"b".repeat(30)}-3`);
  });

  test("slug 形状校验", () => {
    expect(isValidSlug("ab")).toBe(true);
    expect(isValidSlug("a")).toBe(false);
    expect(isValidSlug("board-1")).toBe(true);
    expect(isValidSlug("board-")).toBe(false);
    expect(isValidSlug("Board")).toBe(false);
    expect(isValidSlug("a".repeat(33))).toBe(false);
  });
});

describe("hostname 校验（RFC1123 + 唯一性 + daemon host 保留）", () => {
  test("合法/非法形状", () => {
    expect(isValidHostname("board.localhost")).toBe(true);
    expect(isValidHostname("Board.LocalHost")).toBe(true);
    expect(isValidHostname("board")).toBe(true);
    expect(isValidHostname("board-1.example.com")).toBe(true);
    expect(isValidHostname("127.0.0.1")).toBe(true);
    expect(isValidHostname("board_.local")).toBe(false);
    expect(isValidHostname("board:13679")).toBe(false);
    expect(isValidHostname("board/path")).toBe(false);
    expect(isValidHostname("*.localhost")).toBe(false);
    expect(isValidHostname("-board")).toBe(false);
    expect(isValidHostname("board-")).toBe(false);
    expect(isValidHostname("a..b")).toBe(false);
  });

  test("归一化 + 去重 + daemon host 拒绝 + 跨实例冲突拒绝", () => {
    expect(validateHostnames(["Board.LocalHost.", "board.localhost"], {})).toEqual([
      "board.localhost",
    ]);
    expect(() => validateHostnames(["localhost"], {})).toThrow(/daemon's own host/);
    expect(() => validateHostnames(["stoa.localhost"], {})).toThrow(/daemon's own host/);
    expect(() => validateHostnames(["127.0.0.1"], {})).toThrow(/daemon's own host/);
    expect(() =>
      validateHostnames(["taken.localhost"], { takenByOthers: ["TAKEN.localhost"] }),
    ).toThrow(/already assigned/);
    expect(validateHostnames("a.localhost, b.localhost", {})).toEqual([
      "a.localhost",
      "b.localhost",
    ]);
    expect(() => validateHostnames(["bad host"], {})).toThrow(/invalid hostname/);
  });
});

describe("服务登记新旧兼容", () => {
  test("旧记录（无 slug/hostnames/port null）读出即归一化", () => {
    const stateDir = tempDir("stoa-route-legacy-");
    writeServices(stateDir, [
      { id: "svc-old", name: "Old Board", dataDir: "/tmp/old", status: "running", port: undefined } as unknown as ServiceRecord,
    ]);
    const [old] = readServices(stateDir);
    expect(old!.slug).toBe("old-board");
    expect(old!.hostnames).toEqual([]);
    expect(old!.port).toBeNull();
    expect(old!.authAccount).toBe(DEFAULT_AUTH_ACCOUNT);
  });

  test("表内 slug 冲突时补后缀", () => {
    const stateDir = tempDir("stoa-route-dup-");
    writeServices(stateDir, [
      { id: "svc-a", name: "board", dataDir: "/tmp/a", status: "stopped" } as unknown as ServiceRecord,
      { id: "svc-b", name: "board", dataDir: "/tmp/b", status: "stopped" } as unknown as ServiceRecord,
    ]);
    const list = readServices(stateDir);
    expect(list.map((item) => item.slug)).toEqual(["board", "board-2"]);
  });
});

describe("路由四优先级", () => {
  test("daemon host → daemon app；/i/<key> 302；未知实例 404；未知 host 回落 app", async () => {
    const dir = tempDir("stoa-route-");
    const socketPath = startUpstream(dir, "up-a");
    const stateDir = seed([record({ id: "svc-a", slug: "board", socket: socketPath })]);
    const route = routerFor(stateDir);
    appCalls.length = 0;

    // 1. daemon host + 非 /i/ 路径 → app
    const appRes = await route(new Request(`${DAEMON_URL}/api/daemon/services`));
    expect(await body(appRes)).toEqual({ daemon: true, path: "/api/daemon/services" });

    // 3. daemon host + `/i/<slug>` 无斜杠 → 302
    const redirect = await route(new Request(`${DAEMON_URL}/i/board?x=1`));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/i/board/?x=1");

    // 3. 未知实例 → 404 JSON（不回落控制台 HTML）
    const missing = await route(new Request(`${DAEMON_URL}/i/nope/api/who`));
    expect(missing.status).toBe(404);
    expect((await body(missing)).code).toBe("SERVICE_NOT_FOUND");

    // 4. 未知 host + 其它路径 → app（SPA fallback）
    const unknownHost = await route(
      new Request("http://nope.localhost/whatever", { headers: { host: "nope.localhost" } }),
    );
    expect(await body(unknownHost)).toEqual({ daemon: true, path: "/whatever" });
    expect(appCalls).toContain("/whatever");
  });

  test("路径模式剥前缀（slug 与 id 都认），query 原样", async () => {
    const dir = tempDir("stoa-route-");
    const socketA = startUpstream(dir, "up-a");
    const stateDir = seed([
      record({ id: "svc-a", slug: "board", socket: socketA }),
      record({ id: "svc-b", slug: "second", socket: socketA }),
    ]);
    const route = routerFor(stateDir);

    const bySlug = await body(await route(new Request(`${DAEMON_URL}/i/board/api/who?a=1&b=2`)));
    expect(bySlug).toMatchObject({
      upstream: "up-a",
      path: "/api/who",
      search: "?a=1&b=2",
      method: "GET",
      service: "board",
      proxy: "svc-a",
    });

    const byId = await body(await route(new Request(`${DAEMON_URL}/i/svc-a/assets/app.js`)));
    expect(byId).toMatchObject({ path: "/assets/app.js", service: "board" });

    const second = await body(await route(new Request(`${DAEMON_URL}/i/second/`)));
    expect(second).toMatchObject({ path: "/", service: "second" });
  });

  test("Host 模式命中实例 hostnames → 路径原样透传（不剥前缀）", async () => {
    const dir = tempDir("stoa-route-");
    const socketPath = startUpstream(dir, "up-a");
    const stateDir = seed([
      record({ id: "svc-a", slug: "board", socket: socketPath, hostnames: ["board.localhost"] }),
    ]);
    const route = routerFor(stateDir);
    appCalls.length = 0;

    const res = await route(
      new Request("http://board.localhost/i/other/api/who", {
        headers: { host: "board.localhost:13679" },
      }),
    );
    expect(await body(res)).toMatchObject({
      path: "/i/other/api/who",
      service: "board",
      proxy: "svc-a",
    });
    // 没有被当成 daemon app。
    expect(appCalls).toEqual([]);
  });

  test("自定义 --host 也属于 daemon host 集合", async () => {
    const stateDir = seed([]);
    const route = createDaemonRouter({
      stateDir,
      daemonHosts: ["devbox.local"],
      appFetch: (req) => Response.json({ daemon: true, path: new URL(req.url).pathname }),
    });
    const res = await route(
      new Request("http://devbox.local/api/daemon/info", { headers: { host: "devbox.local" } }),
    );
    expect((await body(res)).daemon).toBe(true);
  });
});

describe("服务登记编辑（PATCH slug/hostnames）", () => {
  function ctxFor(stateDir: string): DaemonContext {
    return {
      stateDir,
      version: "0.7.0",
      startedAt: 1,
      url: DAEMON_URL,
      host: "127.0.0.1",
      entry: { bin: process.execPath, args: [] },
      uiDir: null,
      log: () => {},
      shutdown: async () => {},
    };
  }

  async function patch(
    stateDir: string,
    id: string,
    payload: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const app = createDaemonApp(ctxFor(stateDir));
    const res = await app.fetch(
      new Request(`${DAEMON_URL}/api/daemon/services/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  test("非法/保留/冲突 slug 与非法 hostname 一律 4xx，合法编辑落盘", async () => {
    const stateDir = seed([
      record({ id: "svc-a", slug: "board" }),
      record({ id: "svc-b", slug: "second", hostnames: ["taken.localhost"] }),
    ]);

    expect((await patch(stateDir, "svc-a", { slug: "A!" })).body.code).toBe("BAD_SLUG");
    expect((await patch(stateDir, "svc-a", { slug: "assets" })).body.code).toBe("RESERVED_SLUG");
    const conflict = await patch(stateDir, "svc-a", { slug: "second" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("CONFLICT");

    const daemonHost = await patch(stateDir, "svc-a", { hostnames: ["localhost"] });
    expect(daemonHost.status).toBe(400);
    expect(daemonHost.body.code).toBe("BAD_HOSTNAME");

    const takenHost = await patch(stateDir, "svc-a", { hostnames: ["taken.localhost"] });
    expect(takenHost.status).toBe(400);
    expect(takenHost.body.error).toContain("already assigned");

    const badShape = await patch(stateDir, "svc-a", { hostnames: ["bad host"] });
    expect(badShape.status).toBe(400);

    // 合法编辑：slug 改了 → 逻辑 URL 跟着改；hostnames 归一化落地
    const ok = await patch(stateDir, "svc-a", {
      slug: "renamed",
      hostnames: ["Board.LocalHost", "second.example.com"],
    });
    expect(ok.status).toBe(200);
    const service = ok.body.service as ServiceRecord;
    expect(service.slug).toBe("renamed");
    expect(service.hostnames).toEqual(["board.localhost", "second.example.com"]);
    expect(service.url).toBe(`${DAEMON_URL}/i/renamed/`);

    const persisted = readServices(stateDir).find((item) => item.id === "svc-a")!;
    expect(persisted.slug).toBe("renamed");
    expect(persisted.hostnames).toContain("board.localhost");
  });

  test("PATCH 后路由即时生效（新 slug 可访问，旧 slug 404）", async () => {
    const dir = tempDir("stoa-route-");
    const socketPath = startUpstream(dir, "up-a");
    const stateDir = seed([record({ id: "svc-a", slug: "board", socket: socketPath })]);
    expect((await patch(stateDir, "svc-a", { slug: "renamed" })).status).toBe(200);
    const route = routerFor(stateDir);
    expect((await body(await route(new Request(`${DAEMON_URL}/i/renamed/api/who`)))).service).toBe(
      "renamed",
    );
    expect((await route(new Request(`${DAEMON_URL}/i/board/api/who`))).status).toBe(404);
  });
});

describe("MCP 默认机器通道（daemon.json → socket，design §1.4）", () => {
  function seedDaemon(): { stateDir: string; socket: string } {
    const stateDir = tempDir("stoa-mcp-channel-");
    const socket = join(stateDir, "sockets", "svc-live.sock");
    writeDaemonInfo(stateDir, {
      pid: 1,
      port: 13679,
      url: DAEMON_URL,
      stateDir,
      version: "0.7.0",
      startedAt: 1,
    });
    writeServices(stateDir, [
      record({ id: "svc-dead", slug: "dead", status: "stopped", socket: null }),
      record({ id: "svc-live", slug: "board", socket }),
    ]);
    return { stateDir, socket };
  }

  test("发现首个 running 服务的 socket；logicalUrl 是浏览器通道 /i/<slug>/", () => {
    const { stateDir, socket } = seedDaemon();
    const home = tempDir("stoa-mcp-home-");
    const cfg = resolveMcpConfig({
      flags: {},
      env: { STOA_DAEMON_STATE_DIR: stateDir },
      home,
    });
    expect(cfg.socket).toBe(socket);
    expect(cfg.logicalUrl).toBe(`${DAEMON_URL}/i/board/`);
    expect(cfg.baseUrl).toBe(cfg.logicalUrl);
  });

  test("显式 --base-url 优先（不读 daemon 通道）；无 daemon 记录回退 13689", () => {
    const { stateDir } = seedDaemon();
    const home = tempDir("stoa-mcp-home-");
    const explicit = resolveMcpConfig({
      flags: { baseUrl: "http://127.0.0.1:13689" },
      env: { STOA_DAEMON_STATE_DIR: stateDir },
      home,
    });
    expect(explicit.socket).toBe("");
    expect(explicit.baseUrl).toBe("http://127.0.0.1:13689");
    expect(explicit.logicalUrl).toBe("http://127.0.0.1:13689");

    const bare = resolveMcpConfig({ flags: {}, env: {}, home: tempDir("stoa-mcp-home-") });
    expect(bare.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(bare.socket).toBe("");
  });

  test("只有一个 stopped 服务时不算机器通道（回退默认）", () => {
    const stateDir = tempDir("stoa-mcp-channel-");
    const home = tempDir("stoa-mcp-home-");
    writeDaemonInfo(stateDir, {
      pid: 1,
      port: 13679,
      url: DAEMON_URL,
      stateDir,
      version: "0.7.0",
      startedAt: 1,
    });
    writeServices(stateDir, [
      record({ id: "svc-dead", slug: "dead", status: "stopped", socket: null }),
    ]);
    const cfg = resolveMcpConfig({ flags: {}, env: { STOA_DAEMON_STATE_DIR: stateDir }, home });
    expect(cfg.socket).toBe("");
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
  });
});

/**
 * daemon 壳页（daemon-unified-port design §7 / spec「实例壳与浮动小球」，S4）。
 *
 * 覆盖：`/shell/<idOrSlug>` 直出 HTML（`<base href="/">`、`__STOA_SHELL__`、CSP frame-src、
 * 不含 `__STOA_DAEMON__` 与实例 token）、`/shell` 未知服务 404、`/login` 注入 base、
 * 缺失 `/assets/*` 返回 404 而不是 SPA fallback 的 HTML（防白屏）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonApp, type DaemonContext } from "../src/daemon/server.ts";
import { createDaemonRouter } from "../src/daemon/router.ts";
import { DaemonAuth } from "../src/daemon/daemon-auth.ts";
import {
  DEFAULT_AUTH_ACCOUNT,
  writeServices,
  type ServiceRecord,
} from "../src/daemon/state.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs.reverse()) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function fakeUiDir(): string {
  const dir = tempDir("stoa-shell-ui-");
  writeFileSync(
    join(dir, "index.html"),
    "<!doctype html><html><head><title>stoa</title></head><body><div id=\"root\"></div></body></html>",
  );
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "app-test.js"), "console.log('ok')\n");
  return dir;
}

function ctxFor(stateDir: string, uiDir: string): DaemonContext {
  return {
    stateDir,
    version: "0.7.0",
    startedAt: 1,
    url: "http://127.0.0.1:13679",
    host: "127.0.0.1",
    entry: { bin: process.execPath, args: [] },
    uiDir,
    log: () => {},
    auth: new DaemonAuth({ stateDir, flushDelayMs: 0 }),
    shutdown: async () => {},
  };
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

function routerFor(stateDir: string, uiDir: string) {
  const app = createDaemonApp(ctxFor(stateDir, uiDir));
  return createDaemonRouter({
    stateDir,
    daemonHosts: ["127.0.0.1"],
    auth: { authenticated: () => true },
    appFetch: (req) => app.fetch(req),
  });
}

function get(router: ReturnType<typeof routerFor>, path: string): Promise<Response> {
  return router(new Request(`http://127.0.0.1:13679${path}`, { headers: { host: "127.0.0.1" } }));
}

describe("壳页（S4）", () => {
  test("/shell/<slug> 直出壳 HTML：base/CSP/boot，且不含 daemon boot 与 token", async () => {
    const stateDir = tempDir("stoa-shell-state-");
    const uiDir = fakeUiDir();
    writeServices(stateDir, [
      record({ id: "board", slug: "board", name: "Board One", hostnames: ["board.example.com"] }),
      record({ id: "other", slug: "other", name: "Other", status: "stopped" }),
    ]);
    const router = routerFor(stateDir, uiDir);

    const res = await get(router, "/shell/board");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-src");
    expect(csp).toContain("'self'");
    expect(csp).toContain("https://board.example.com");
    expect(csp).toContain("frame-ancestors 'self'");

    const html = await res.text();
    expect(html).toContain('<base href="/">');
    expect(html).toContain("window.__STOA_SHELL__=");
    expect(html).not.toContain("__STOA_DAEMON__");
    expect(html).not.toContain("STOA_TOKEN");
    const boot = JSON.parse(
      /window\.__STOA_SHELL__=(\{.*?\});<\/script>/s.exec(html)![1]!,
    ) as {
      current: { slug: string; iframeUrl: string };
      instances: Array<{ slug: string }>;
    };
    expect(boot.current.slug).toBe("board");
    expect(boot.current.iframeUrl).toBe("/i/board/");
    // 只列运行中的实例；当前实例恒在
    expect(boot.instances.map((item) => item.slug)).toEqual(["board"]);
  });

  test("/shell/<id> 也能打开（id 与 slug 同解）；未知服务 404", async () => {
    const stateDir = tempDir("stoa-shell-state-");
    const uiDir = fakeUiDir();
    writeServices(stateDir, [record({ id: "svc-abc", slug: "board", name: "Board" })]);
    const router = routerFor(stateDir, uiDir);

    expect((await get(router, "/shell/svc-abc")).status).toBe(200);
    expect((await get(router, "/shell/board/")).status).toBe(200);
    const missing = await get(router, "/shell/nope");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("no such service");
  });

  test("/login 注入 base 但不注入任何 boot", async () => {
    const stateDir = tempDir("stoa-shell-state-");
    const uiDir = fakeUiDir();
    const router = routerFor(stateDir, uiDir);
    const res = await get(router, "/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<base href="/">');
    expect(html).not.toContain("__STOA_DAEMON__");
    expect(html).not.toContain("__STOA_SHELL__");
  });

  test("缺失的 /assets/* 返回 404 而不是 HTML（防 MIME 报错白屏）", async () => {
    const stateDir = tempDir("stoa-shell-state-");
    const uiDir = fakeUiDir();
    const router = routerFor(stateDir, uiDir);

    const ok = await get(router, "/assets/app-test.js");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type") ?? "").toContain("javascript");

    const missing = await get(router, "/assets/app-missing.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type") ?? "").toContain("text/plain");
    expect(await missing.text()).not.toContain("<html");
  });
});

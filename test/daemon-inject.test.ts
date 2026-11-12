/**
 * 实例凭据注入（daemon-unified-port design §5 / spec「实例凭据注入」，S3-4）。
 *
 * 覆盖：auth 模式注入 Bearer + x-report-account；open 模式只注入 x-report-account；
 * 客户端自带的 authorization/x-report-account/cookie 一律被覆盖或删除（防冒充/防泄漏）；
 * 实例 401 → 用口令登录换 token 重放一次；无法兜底 → 502 SERVICE_CREDENTIALS_UNAVAILABLE。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface Seen {
  authorization: string | null;
  account: string | null;
  cookie: string | null;
  service: string | null;
  proxy: string | null;
}

/** 上游桩：回显收到的凭据头；可选地模拟「只有 fallback token 才放行」。 */
function startUpstream(
  dir: string,
  opts: { requireFallback?: boolean; loginSecret?: string } = {},
): { socket: string; seen: Seen[] } {
  const socketPath = join(dir, "board.sock");
  const seen: Seen[] = [];
  const server = Bun.serve({
    unix: socketPath,
    fetch: async (req) => {
      const url = new URL(req.url);
      seen.push({
        authorization: req.headers.get("authorization"),
        account: req.headers.get("x-report-account"),
        cookie: req.headers.get("cookie"),
        service: req.headers.get("x-stoa-service"),
        proxy: req.headers.get("x-stoa-daemon-proxy"),
      });
      if (url.pathname === "/api/auth/login") {
        const body = (await req.json()) as { secret?: string };
        if (opts.loginSecret && body.secret === opts.loginSecret) {
          return Response.json({ ok: true, token: "fallback-token", sub: "owner" });
        }
        return Response.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
      }
      if (opts.requireFallback) {
        if (req.headers.get("authorization") === "Bearer fallback-token") {
          return Response.json({ ok: true, via: "fallback" });
        }
        return Response.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
      }
      return Response.json({ ok: true });
    },
  });
  servers.push(server);
  return { socket: socketPath, seen };
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

function routerFor(stateDir: string) {
  return createDaemonRouter({
    stateDir,
    daemonHosts: ["127.0.0.1"],
    auth: { authenticated: () => true },
    appFetch: () => Response.json({ daemon: true }),
  });
}

function withOwnerEnv(dataDir: string, token: string): void {
  mkdirSync(join(dataDir, "accounts"), { recursive: true });
  writeFileSync(join(dataDir, "accounts", "owner.env"), `STOA_TOKEN_OWNER=${token}\n`, { mode: 0o600 });
}

describe("凭据注入（S3-4）", () => {
  test("auth 模式：注入 owner Bearer + x-report-account；伪造头与 cookie 被覆盖/删除", async () => {
    const stateDir = tempDir("stoa-inject-state-");
    const dataDir = tempDir("stoa-inject-data-");
    withOwnerEnv(dataDir, "owner-token-123");
    const { socket, seen } = startUpstream(tempDir("stoa-inject-up-"));
    writeServices(stateDir, [record({ id: "board", slug: "board", socket, dataDir })]);
    const router = routerFor(stateDir);

    const res = await router(
      new Request("http://127.0.0.1:13679/i/board/api/posts", {
        headers: {
          host: "127.0.0.1",
          authorization: "Bearer forged",
          "x-report-account": "manager",
          cookie: "stoa_daemon=deadbeef"
        },
      }),
    );
    expect(res.status).toBe(200);
    const got = seen.at(-1)!;
    expect(got.authorization).toBe("Bearer owner-token-123");
    expect(got.account).toBe("owner");
    expect(got.cookie).toBeNull();
    expect(got.service).toBe("board");
    expect(got.proxy).toBe("board");
  });

  test("open 模式（无 owner.env）：只注入 x-report-account，不带 authorization", async () => {
    const stateDir = tempDir("stoa-inject-state-");
    const dataDir = tempDir("stoa-inject-data-");
    const { socket, seen } = startUpstream(tempDir("stoa-inject-up-"));
    writeServices(stateDir, [record({ id: "board", slug: "board", socket, dataDir })]);
    const router = routerFor(stateDir);

    const res = await router(
      new Request("http://127.0.0.1:13679/i/board/api/posts", {
        headers: { host: "127.0.0.1", authorization: "Bearer forged", "x-report-account": "manager" },
      }),
    );
    expect(res.status).toBe(200);
    const got = seen.at(-1)!;
    expect(got.authorization).toBeNull();
    expect(got.account).toBe("owner");
  });

  test("实例 401 → 用口令登录换 token 重放一次；请求体被保留", async () => {
    const stateDir = tempDir("stoa-inject-state-");
    const dataDir = tempDir("stoa-inject-data-");
    writeFileSync(join(dataDir, ".env"), "STOA_AUTH=instance-secret\n", { mode: 0o600 });
    const { socket, seen } = startUpstream(tempDir("stoa-inject-up-"), {
      requireFallback: true,
      loginSecret: "instance-secret",
    });
    writeServices(stateDir, [record({ id: "board", slug: "board", socket, dataDir })]);
    const router = routerFor(stateDir);

    const res = await router(
      new Request("http://127.0.0.1:13679/i/board/api/posts", {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        body: JSON.stringify({ body: "hello" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { via?: string }).via).toBe("fallback");
    const posts = seen.filter((item) => item.authorization === "Bearer fallback-token");
    expect(posts.length).toBeGreaterThan(0);
  });

  test("实例持续 401 且无口令可兜底 → 502 SERVICE_CREDENTIALS_UNAVAILABLE", async () => {
    const stateDir = tempDir("stoa-inject-state-");
    const dataDir = tempDir("stoa-inject-data-");
    const { socket } = startUpstream(tempDir("stoa-inject-up-"), { requireFallback: true });
    writeServices(stateDir, [record({ id: "board", slug: "board", socket, dataDir })]);
    const router = routerFor(stateDir);

    const res = await router(
      new Request("http://127.0.0.1:13679/i/board/api/posts", { headers: { host: "127.0.0.1" } }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; proxied: boolean; error: string };
    expect(body.code).toBe("SERVICE_CREDENTIALS_UNAVAILABLE");
    expect(body.proxied).toBe(true);
    expect(body.error).toContain("实例凭据不可用");
  });
});

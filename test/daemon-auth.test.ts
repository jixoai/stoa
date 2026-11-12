/**
 * daemon 账号与登录会话（daemon-unified-port S3-1/S3-2）。
 *
 * 覆盖：
 *   - argon2id 哈希（显式 algorithm）、无明文落盘、0600 权限；
 *   - 首启创建只对「账号数=0」开放；重置需 force；
 *   - 登录/退出/状态 API（经 createDaemonApp，无端口）；
 *   - 会话 TTL 7 天滑动（注入时钟）、内存台账 + 批量落盘、重启后仍有效；
 *   - cookie 标志：HttpOnly/SameSite=Lax/Path=/、Secure 条件、Domain 仅带点非 IP。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  daemonAccountStatus,
  daemonAccountsPath,
  DaemonAccountExistsError,
  readDaemonAccounts,
  setDaemonAccount,
  verifyDaemonLogin,
} from "../src/daemon/accounts.ts";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  cookieAttributesFor,
  cookieDomainFor,
  cookieSecureFor,
  DAEMON_SESSION_COOKIE,
  DAEMON_SESSION_TTL_MS,
  DaemonAuth,
  DaemonSessionStore,
  sessionIdFromRequest,
} from "../src/daemon/daemon-auth.ts";
import { createDaemonApp, type DaemonContext } from "../src/daemon/server.ts";
import { tempDir } from "./helpers.ts";

const PASSWORD = "correct-horse-9";
const PASSWORD_2 = "another-pass-1";
const DAY = 24 * 60 * 60 * 1000;

function ctxFor(stateDir: string, auth: DaemonAuth): DaemonContext {
  return {
    stateDir,
    version: "0.7.0",
    startedAt: 1,
    url: "http://127.0.0.1:13679",
    host: "127.0.0.1",
    entry: { bin: process.execPath, args: [] },
    uiDir: null,
    log: () => {},
    auth,
    shutdown: async () => {},
  };
}

function cookieId(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${DAEMON_SESSION_COOKIE}=([^;]+)`).exec(raw);
  if (!match) throw new Error(`no session cookie in ${JSON.stringify(raw)}`);
  return match[1]!;
}

describe("daemon 账号（S3-1）", () => {
  test("创建：argon2id 哈希、0600、无明文；status 不含密码/哈希", async () => {
    const stateDir = tempDir("stoa-accounts-");
    const out = await setDaemonAccount(stateDir, { password: PASSWORD });
    expect(out.created).toBe(true);
    expect(out.account.username).toBe("daemon");

    const file = daemonAccountsPath(stateDir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("$argon2id$");
    expect(raw).not.toContain(PASSWORD);
    const parsed = JSON.parse(raw) as { accounts: Array<Record<string, unknown>> };
    expect(Object.keys(parsed.accounts[0]!).sort()).toEqual([
      "createdAt",
      "passwordHash",
      "updatedAt",
      "username",
    ]);

    const status = daemonAccountStatus(stateDir);
    expect(status).toMatchObject({ configured: true, username: "daemon" });
    const asJson = JSON.stringify(status);
    expect(asJson).not.toContain(PASSWORD);
    expect(asJson).not.toContain("argon2");
    expect(asJson).not.toContain("passwordHash");
  });

  test("有账号再 set 需 --force；force 重置沿用 createdAt 并更新 updatedAt", async () => {
    const stateDir = tempDir("stoa-accounts-");
    const first = await setDaemonAccount(stateDir, { password: PASSWORD, now: 1_000 });
    await expect(setDaemonAccount(stateDir, { password: PASSWORD_2 })).rejects.toBeInstanceOf(
      DaemonAccountExistsError,
    );
    const second = await setDaemonAccount(stateDir, {
      password: PASSWORD_2,
      force: true,
      now: 5_000,
    });
    expect(second.created).toBe(false);
    expect(second.account.createdAt).toBe(first.account.createdAt);
    expect(second.account.updatedAt).toBe(5_000);
    expect(await verifyDaemonLogin(stateDir, "daemon", PASSWORD_2)).not.toBeNull();
    expect(await verifyDaemonLogin(stateDir, "daemon", PASSWORD)).toBeNull();
    expect(readDaemonAccounts(stateDir)).toHaveLength(1);
  });

  test("用户名/密码校验与登录失败统一为 null", async () => {
    const stateDir = tempDir("stoa-accounts-");
    await expect(setDaemonAccount(stateDir, { password: "short" })).rejects.toThrow(/至少 8/);
    await expect(
      setDaemonAccount(stateDir, { password: PASSWORD, username: "-bad name" }),
    ).rejects.toThrow(/用户名/);
    await setDaemonAccount(stateDir, { password: PASSWORD, username: "ops.team" });
    expect(await verifyDaemonLogin(stateDir, "ops.team", PASSWORD)).not.toBeNull();
    // username 省略且只有一个账号 → 用它
    expect(await verifyDaemonLogin(stateDir, null, PASSWORD)).not.toBeNull();
    expect(await verifyDaemonLogin(stateDir, "nobody", PASSWORD)).toBeNull();
    expect(await verifyDaemonLogin(stateDir, "ops.team", "wrong-password")).toBeNull();
  });
});

describe("登录会话台账（S3-2）", () => {
  test("创建即可命中；退出后立即失效；sessions 文件 0600", () => {
    const stateDir = tempDir("stoa-sessions-");
    const store = new DaemonSessionStore({ stateDir, flushDelayMs: 0 });
    const session = store.create("daemon");
    expect(session.id).toMatch(/^[0-9a-f]{32}$/);
    expect(store.get(session.id)?.username).toBe("daemon");

    const file = join(stateDir, "daemon-sessions.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(session.id);

    expect(store.remove(session.id)).toBe(true);
    expect(store.get(session.id)).toBeNull();
    expect(readFileSync(file, "utf8")).not.toContain(session.id);
  });

  test("TTL 7 天滑动：持续命中不过期；闲置超过 7 天过期", () => {
    const stateDir = tempDir("stoa-sessions-");
    let now = 1_000_000;
    const store = new DaemonSessionStore({
      stateDir,
      now: () => now,
      flushDelayMs: 0,
      renewMs: 60_000,
    });
    const session = store.create("daemon");
    expect(session.expiresAt).toBe(now + DAEMON_SESSION_TTL_MS);

    now += 6 * DAY;
    expect(store.get(session.id)).not.toBeNull();
    now += 6 * DAY; // T0+12d：没有滑动就早过期了
    expect(store.get(session.id)).not.toBeNull();
    now += 8 * DAY; // T0+20d > 上次续期 + 7d
    expect(store.get(session.id)).toBeNull();

    const idleDir = tempDir("stoa-sessions-");
    let idleNow = 5_000;
    const idle = new DaemonSessionStore({
      stateDir: idleDir,
      now: () => idleNow,
      flushDelayMs: 0,
    });
    const idleSession = idle.create("daemon");
    idleNow += DAEMON_SESSION_TTL_MS + 1;
    expect(idle.get(idleSession.id)).toBeNull();
    expect(idle.list()).toHaveLength(0);
  });

  test("重启后会话仍有效（落盘快照可回读）；过期条目在加载时丢弃", () => {
    const stateDir = tempDir("stoa-sessions-");
    let now = 10_000;
    const first = new DaemonSessionStore({ stateDir, now: () => now, flushDelayMs: 0 });
    const session = first.create("daemon");
    first.flush();

    const reopened = new DaemonSessionStore({ stateDir, now: () => now, flushDelayMs: 0 });
    expect(reopened.get(session.id)).not.toBeNull();

    now += DAEMON_SESSION_TTL_MS + 1;
    const afterExpiry = new DaemonSessionStore({ stateDir, now: () => now, flushDelayMs: 0 });
    expect(afterExpiry.get(session.id)).toBeNull();
    expect(afterExpiry.list()).toHaveLength(0);
  });

  test("批量落盘：变更去抖后的 flush 把滑动结果写盘（不每请求写）", () => {
    const stateDir = tempDir("stoa-sessions-");
    let now = 20_000;
    const store = new DaemonSessionStore({
      stateDir,
      now: () => now,
      flushDelayMs: 30,
      renewMs: 60_000,
    });
    const session = store.create("daemon");
    now += 2 * DAY;
    store.get(session.id); // 滑动续期 → 标脏
    // 还没到去抖窗口：文件仍是创建时的 expiresAt（T0+7d）
    const before = readFileSync(join(stateDir, "daemon-sessions.json"), "utf8");
    expect(JSON.parse(before).sessions[0].expiresAt).toBe(20_000 + DAEMON_SESSION_TTL_MS);
    store.flush();
    const after = JSON.parse(readFileSync(join(stateDir, "daemon-sessions.json"), "utf8"));
    expect(after.sessions[0].expiresAt).toBe(now + DAEMON_SESSION_TTL_MS);
    store.dispose();
  });
});

describe("cookie 语义", () => {
  test("HttpOnly/SameSite=Lax/Path=/；Domain 仅带点非 IP host", () => {
    expect(cookieDomainFor("stoa.localhost")).toBe(".stoa.localhost");
    expect(cookieDomainFor("board.example.com")).toBe(".board.example.com");
    expect(cookieDomainFor("localhost")).toBeNull();
    expect(cookieDomainFor("127.0.0.1")).toBeNull();
    expect(cookieDomainFor("[::1]")).toBeNull();
    expect(cookieDomainFor("")).toBeNull();

    const cookie = buildSessionCookie("abc123", { secure: false, domain: null });
    expect(cookie).toContain(`${DAEMON_SESSION_COOKIE}=abc123`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${DAEMON_SESSION_TTL_MS / 1000}`);
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain("Secure");

    const domainCookie = buildSessionCookie("abc123", { secure: true, domain: ".stoa.localhost" });
    expect(domainCookie).toContain("Domain=.stoa.localhost");
    expect(domainCookie).toContain("Secure");
  });

  test("Secure：https 或非回环 Host（含 *.localhost 视为回环）", () => {
    expect(cookieSecureFor("127.0.0.1", "http:")).toBe(false);
    expect(cookieSecureFor("localhost", "http:")).toBe(false);
    expect(cookieSecureFor("stoa.localhost", "http:")).toBe(false);
    expect(cookieSecureFor("board.example.com", "http:")).toBe(true);
    expect(cookieSecureFor("127.0.0.1", "https:")).toBe(true);

    const attrs = cookieAttributesFor(
      new Request("http://stoa.localhost:13679/api/daemon/auth/login", {
        headers: { host: "stoa.localhost:13679" },
      }),
    );
    expect(attrs).toEqual({ secure: false, domain: ".stoa.localhost" });

    const cleared = buildClearSessionCookie({ secure: true, domain: ".example.com" });
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Secure");
    expect(cleared).toContain("Domain=.example.com");
  });

  test("从 Cookie 头取会话 id（同名取第一个）", () => {
    const req = new Request("http://127.0.0.1:13679/", {
      headers: { cookie: `a=1; ${DAEMON_SESSION_COOKIE}=sid-1; ${DAEMON_SESSION_COOKIE}=sid-2` },
    });
    expect(sessionIdFromRequest(req)).toBe("sid-1");
    expect(sessionIdFromRequest(new Request("http://127.0.0.1:13679/"))).toBeNull();
  });
});

describe("账号/登录 HTTP API", () => {
  test("首启 setup 仅账号数=0；下发 HttpOnly cookie；登录/退出闭环", async () => {
    const stateDir = tempDir("stoa-auth-api-");
    const auth = new DaemonAuth({ stateDir, flushDelayMs: 0 });
    const app = createDaemonApp(ctxFor(stateDir, auth));
    const base = "http://127.0.0.1:13679";
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      app.fetch(
        new Request(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      );

    const status0 = await app.fetch(new Request(`${base}/api/daemon/auth/status`));
    const status0Body = (await status0.json()) as Record<string, unknown>;
    expect(status0Body).toMatchObject({
      configured: false,
      setup_available: true,
      authenticated: false,
    });
    expect(JSON.stringify(status0Body)).not.toContain("argon2");

    const setup = await post("/api/daemon/auth/setup", { password: PASSWORD });
    expect(setup.status).toBe(200);
    const cookie = cookieId(setup);
    const setCookie = setup.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");

    // 已配置后 setup 关闭
    const again = await post("/api/daemon/auth/setup", { password: PASSWORD_2 });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("SETUP_UNAVAILABLE");

    // 会话态
    const authed = await app.fetch(
      new Request(`${base}/api/daemon/auth/status`, { headers: { cookie: `stoa_daemon=${cookie}` } }),
    );
    expect(((await authed.json()) as { authenticated: boolean }).authenticated).toBe(true);

    // 错误密码 401（不区分用户名/密码）
    const bad = await post("/api/daemon/auth/login", { password: "nope-nope-1" });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { code: string }).code).toBe("UNAUTHORIZED");

    const ok = await post("/api/daemon/auth/login", { password: PASSWORD });
    expect(ok.status).toBe(200);
    const loginCookie = cookieId(ok);

    // 退出登录：立即失效
    const logout = await post("/api/daemon/auth/logout", {}, { cookie: `stoa_daemon=${loginCookie}` });
    expect(logout.status).toBe(200);
    expect((logout.headers.get("set-cookie") ?? "")).toContain("Max-Age=0");
    const afterLogout = await app.fetch(
      new Request(`${base}/api/daemon/auth/status`, {
        headers: { cookie: `stoa_daemon=${loginCookie}` },
      }),
    );
    expect(((await afterLogout.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });

  test("未配置时 login 返回 SETUP_REQUIRED；setup 校验密码长度", async () => {
    const stateDir = tempDir("stoa-auth-api-");
    const auth = new DaemonAuth({ stateDir, flushDelayMs: 0 });
    const app = createDaemonApp(ctxFor(stateDir, auth));
    const res = await app.fetch(
      new Request("http://127.0.0.1:13679/api/daemon/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("SETUP_REQUIRED");

    const short = await app.fetch(
      new Request("http://127.0.0.1:13679/api/daemon/auth/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "short" }),
      }),
    );
    expect(short.status).toBe(400);
    expect(JSON.stringify(await short.json())).not.toContain(PASSWORD);
  });
});

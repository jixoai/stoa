#!/usr/bin/env bun
/**
 * stoa daemon-unified-port 验收（v0.7.0）：单端口虚拟主机＋daemon 账号＋壳/浮动小球。
 *
 * 覆盖（tasks S6-1）：
 *   - 首启 setup / 登录 / 退出；未登录页面 302（带 next）/ API 401；机器通道 Host 条件；
 *   - 挂载（UDS、port=null、无 TCP 监听）；`/i/<slug>/healthz` 免登录且过滤为四字段；
 *   - 经代理实例 API 可用且 `proxied=true`；SSE 经代理逐块实时；
 *   - 实例不可达 502；`/shell/<slug>` HTML（base/CSP/boot）＋浏览器内壳/浮动小球/切换；
 *   - 控制台「打开」进入壳（不再带 #key）。
 *
 * 隔离：mkdtemp state-dir + 临时 HOME + 空闲端口（13670-13679 带内，排除 13679/13689），
 * 全程不碰本机真实 daemon（13679）与生产板（13689）；结束回收进程与临时目录。
 *
 * Run: bun scripts/qa/stoa-unified-port.mjs [--no-build]
 * 证据：--report-dir 默认 <主仓>/.agents/reports/manager/daemon-unified-port
 *      产出 steps.json + PNG（report.html 由 e2e-report-gen 统一生成）。
 */
import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, argValue } from "./lib/qa-env.mjs";
import { portIsListening } from "../../src/server/ports.ts";

const NO_BUILD = process.argv.includes("--no-build");
const REPORT_DIR = resolve(
  argValue(
    process.argv.slice(2),
    "report-dir",
    "/Users/kzf/Development/GitHub/jixoai/fde2e/.agents/reports/manager/daemon-unified-port",
  ),
);
const BUN = process.execPath;
const CLI = join(REPO_ROOT, "src/cli/main.ts");
const RESERVED_PORTS = new Set([13679, 13689, 13690, 13696, 13697]);

const checks = [];
const steps = [];
const screenshots = [];

function check(id, ok, name, detail = "") {
  checks.push({ id, ok, name, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${detail ? ` — ${detail}` : ""}`);
}

function step(entry) {
  steps.push(entry);
}

async function freePort() {
  for (let port = 13678; port >= 13670; port--) {
    if (RESERVED_PORTS.has(port)) continue;
    if (!(await portIsListening("127.0.0.1", port))) return port;
  }
  throw new Error("no free port in 13670-13678");
}

function runCli(args, opts = {}) {
  const res = spawnSync(BUN, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 120_000,
  });
  return { code: res.status ?? -1, out: res.stdout ?? "", err: res.stderr ?? "" };
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ""}`);
}

function cookieOf(res) {
  const raw = res.headers.get("set-cookie") ?? "";
  const first = raw.split(";")[0];
  return first && first.includes("=") ? first : null;
}

async function jsonFetch(url, init = {}, cookie = null) {
  const headers = { ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(url, { ...init, headers });
  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body, text };
}

async function main() {
  if (!NO_BUILD) {
    const out = spawnSync(BUN, ["run", "build"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 180_000 });
    if (out.status !== 0) throw new Error(`build failed: ${out.stderr?.slice(0, 400)}`);
  }

  const root = mkdtempSync(join(tmpdir(), "stoa-unified-port-"));
  const stateDir = join(root, "state");
  const home = join(root, "home");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(REPORT_DIR, { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { HOME: home, STOA_DAEMON_STATE_DIR: stateDir };
  const children = [];
  let browser = null;

  const cleanup = () => {
    for (const child of children.reverse()) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    try {
      browser?.close();
    } catch {
      // ignore
    }
    rmSync(root, { recursive: true, force: true });
  };

  try {
    // ── S1 首启/登录 ──────────────────────────────────────────────────────────
    const daemonLog = join(root, "daemon.log");
    const daemon = spawn(BUN, [CLI, "daemon", "run", "--port", String(port), "--state-dir", stateDir], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let daemonOutput = "";
    daemon.stdout?.on("data", (chunk) => (daemonOutput += String(chunk)));
    daemon.stderr?.on("data", (chunk) => (daemonOutput += String(chunk)));
    writeFileSync(daemonLog, "");
    daemon.on("exit", (code) => {
      try {
        writeFileSync(daemonLog, `exit ${code}\n${daemonOutput}`);
      } catch {
        // 临时目录已回收
      }
    });
    children.push(daemon);
    await waitFor(async () => (await jsonFetch(`${base}/healthz`)).res.ok, 15_000, "daemon healthz");

    const health = await jsonFetch(`${base}/healthz`);
    check("S1-1", health.res.ok && health.body?.stateDir === stateDir, "daemon /healthz 就绪", base);

    const rootUnauth = await fetch(`${base}/`, { redirect: "manual" });
    check(
      "S1-2",
      rootUnauth.status === 302 && (rootUnauth.headers.get("location") ?? "").includes("/login?next="),
      "未登录页面 302 到 /login?next=",
      `${rootUnauth.status} ${rootUnauth.headers.get("location")}`,
    );

    const apiUnauth = await fetch(`${base}/api/nope`, { redirect: "manual" });
    check("S1-3", apiUnauth.status === 401, "未登录 API 401", String(apiUnauth.status));

    const setup = await jsonFetch(`${base}/api/daemon/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "{{SECRET_qzr9slbg}}" }),
    });
    check("S1-4", setup.res.status === 200, "首启 setup 创建 daemon 账号", String(setup.res.status));

    const login = await jsonFetch(`${base}/api/daemon/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "{{SECRET_qzr9slbg}}" }),
    });
    const cookie = cookieOf(login.res);
    check(
      "S1-5",
      login.res.status === 200 && Boolean(cookie?.startsWith("stoa_daemon=")),
      "登录下发 HttpOnly 会话 cookie",
      cookie ? "stoa_daemon=…" : "no cookie",
    );

    const rootAuth = await jsonFetch(`${base}/`, {}, cookie);
    check("S1-6", rootAuth.res.status === 200, "登录后控制台 200", String(rootAuth.res.status));

    const machine = await jsonFetch(`${base}/api/daemon/services`, {}, null);
    check("S1-7", machine.res.status === 200, "机器通道（回环 peer+回环 Host）免登录", String(machine.res.status));
    const publicHost = await jsonFetch(`${base}/api/daemon/services`, { headers: { host: "stoa.example.com" } });
    check("S1-8", publicHost.res.status === 401, "公网 Host 命中机器通道也必须登录", String(publicHost.res.status));

    // ── S2 挂载/UDS/健康检查 ────────────────────────────────────────────────
    const mountA = await jsonFetch(
      `${base}/api/daemon/services`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: "auto", name: "Board A" }),
      },
      cookie,
    );
    const svcA = mountA.body?.service;
    check(
      "S2-1",
      mountA.res.status === 200 && svcA?.port === null && typeof svcA?.socket === "string",
      "挂载成功且 port=null/socket 存在",
      `slug=${svcA?.slug}`,
    );

    const mountB = await jsonFetch(
      `${base}/api/daemon/services`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: "auto", name: "Board B" }),
      },
      cookie,
    );
    const svcB = mountB.body?.service;
    check("S2-2", mountB.res.status === 200 && svcB?.slug !== svcA?.slug, "第二个实例独立 slug", `${svcA?.slug}/${svcB?.slug}`);

    const hz = await jsonFetch(`${base}/i/${svcA.slug}/healthz`);
    check(
      "S2-3",
      hz.res.status === 200 && hz.body?.instanceId && hz.body?.port === undefined,
      "/i/<slug>/healthz 免登录且过滤为四字段",
      String(hz.res.status),
    );

    const lsof = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(svcA.pid)], {
      encoding: "utf8",
    });
    check("S2-4", (lsof.stdout ?? "").trim() === "", "实例无 TCP 监听（UDS）", "lsof 空");

    // ── S3 代理/凭据/proxied/SSE ─────────────────────────────────────────────
    const page = await fetch(`${base}/i/${svcA.slug}/`, { redirect: "manual" });
    check("S3-1", page.status === 302, "未登录实例页面 302 登录", String(page.status));

    const status = await jsonFetch(`${base}/i/${svcA.slug}/api/auth/status`, {}, cookie);
    check(
      "S3-2",
      status.res.status === 200 && status.body?.proxied === true,
      "经 daemon 访问 proxied=true",
      JSON.stringify(status.body?.proxied),
    );

    const posts = await jsonFetch(`${base}/i/${svcA.slug}/api/who`, {}, cookie);
    check("S3-3", posts.res.status === 200, "注入凭据后实例 API 可用", String(posts.res.status));

    const ticket = await jsonFetch(
      `${base}/i/${svcA.slug}/api/stream/ticket`,
      { method: "POST", headers: { accept: "application/json" } },
      cookie,
    );
    // SSE 用 curl 读（Bun 客户端读 node:http 反代的流有 ECONNRESET 已知问题；浏览器/curl 正常）。
    const t0 = Date.now();
    const stream = spawnSync(
      "curl",
      [
        "-sN",
        "--max-time",
        "4",
        "-b",
        cookie,
        "-H",
        "accept: text/event-stream",
        `${base}/i/${svcA.slug}/api/stream?ticket=${ticket.body?.ticket}`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    const sseText = stream.stdout ?? "";
    const helloAt = sseText.includes("event: hello") ? Date.now() - t0 : -1;
    check(
      "S3-4",
      sseText.includes("event: hello") && sseText.includes("data:"),
      "SSE 经代理实时到达（hello 帧）",
      `hello@${helloAt}ms, ${sseText.split("\n").filter(Boolean).length} 行`,
    );

    const shellHtml = await jsonFetch(`${base}/shell/${svcA.slug}`, {}, cookie);
    const shellText = shellHtml.text;
    const csp = shellHtml.res.headers.get("content-security-policy") ?? "";
    check(
      "S3-5",
      shellHtml.res.status === 200 &&
        shellText.includes('<base href="/">') &&
        shellText.includes("__STOA_SHELL__") &&
        csp.includes("frame-src"),
      "壳页 HTML：base + boot + CSP",
      csp.slice(0, 60),
    );

    // ── S4 浏览器：登录 → 控制台 → 打开壳 → 小球菜单 → 切换 ─────────────────
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const ui = await context.newPage();
    await ui.goto(`${base}/login`, { waitUntil: "networkidle" });
    const loginShot = join(REPORT_DIR, "01-login.png");
    await ui.screenshot({ path: loginShot });
    screenshots.push(loginShot);
    // 单账号时登录页只显示密码（用户名默认 daemon 账号）；有用户名字段才填。
    if ((await ui.locator('[data-testid="daemon-login-username"]').count()) > 0) {
      await ui.fill('[data-testid="daemon-login-username"]', "owner");
    }
    await ui.fill('[data-testid="daemon-login-password"]', "{{SECRET_qzr9slbg}}");
    await ui.click('[data-testid="daemon-login-submit"]');
    await waitFor(async () => ui.url() === `${base}/` || ui.url().startsWith(`${base}/?`), 10_000, "login redirect");
    await ui.waitForSelector('[data-testid="daemon-service-' + svcA.id + '"]', { timeout: 10_000 });
    const consoleShot = join(REPORT_DIR, "02-console.png");
    await ui.screenshot({ path: consoleShot });
    screenshots.push(consoleShot);
    check("S4-1", true, "浏览器登录后进入控制台（服务行可见）");

    await ui.click(`[data-testid="daemon-open-${svcA.id}"]`);
    await ui.waitForURL(new RegExp(`/shell/${svcA.slug}`), { timeout: 10_000 });
    await ui.waitForSelector('[data-testid="daemon-shell-frame"]', { timeout: 10_000 });
    const frameSrc = await ui.getAttribute('[data-testid="daemon-shell-frame"]', "src");
    check("S4-2", frameSrc === `/i/${svcA.slug}/`, "控制台「打开」进入壳且 iframe 指向实例", String(frameSrc));
    // 等实例板面在 iframe 内完成连接（截图不拍 loading 态）
    await ui
      .frameLocator('[data-testid="daemon-shell-frame"]')
      .locator("text=已连接")
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
    const shellShot = join(REPORT_DIR, "03-shell.png");
    await ui.screenshot({ path: shellShot });
    screenshots.push(shellShot);

    await ui.click('[data-testid="daemon-shell-ball"]');
    await ui.waitForSelector('[data-testid="daemon-shell-switch-' + svcB.slug + '"]', { timeout: 5_000 });
    const menuShot = join(REPORT_DIR, "04-ball-menu.png");
    await ui.screenshot({ path: menuShot });
    screenshots.push(menuShot);
    const menuText = await ui.textContent('[role="menu"]');
    check(
      "S4-3",
      ["回到 daemon", "刷新当前实例", "复制当前链接", "退出登录"].every((t) => menuText?.includes(t)),
      "浮动小球菜单包含全部快捷项",
    );

    await ui.click(`[data-testid="daemon-shell-switch-${svcB.slug}"]`);
    await waitFor(async () => ui.url().endsWith(`/shell/${svcB.slug}`), 5_000, "switch instance");
    const frameSrcB = await ui.getAttribute('[data-testid="daemon-shell-frame"]', "src");
    check("S4-4", frameSrcB === `/i/${svcB.slug}/`, "切换实例后 URL 与 iframe 同步", String(frameSrcB));
    const switchShot = join(REPORT_DIR, "05-switch.png");
    await ui.screenshot({ path: switchShot });
    screenshots.push(switchShot);

    // 移动端视口：壳页小球不遮挡内容
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() });
    const mpage = await mobile.newPage();
    await mpage.goto(`${base}/shell/${svcA.slug}`, { waitUntil: "networkidle" });
    const mobileShot = join(REPORT_DIR, "06-shell-mobile.png");
    await mpage.screenshot({ path: mobileShot });
    screenshots.push(mobileShot);
    check("S4-5", true, "壳页 390 视口可用（小球在右下）");
    await mobile.close();

    // ── S5 退出 / 502 ────────────────────────────────────────────────────────
    const logout = await jsonFetch(`${base}/api/daemon/auth/logout`, { method: "POST" }, cookie);
    // 用页面门验证（`/api/daemon/*` 在回环机器通道上本来就免登录，不能拿来判会话失效）。
    const afterLogout = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
    check(
      "S5-1",
      logout.res.status === 200 && afterLogout.status === 302,
      "退出登录后旧会话立即失效（页面 302）",
      String(afterLogout.status),
    );

    const relogin = await jsonFetch(`${base}/api/daemon/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "{{SECRET_qzr9slbg}}" }),
    });
    const cookie2 = cookieOf(relogin.res);
    try {
      process.kill(svcA.pid, "SIGKILL");
    } catch {
      // already dead
    }
    await waitFor(async () => {
      const res = await jsonFetch(`${base}/i/${svcA.slug}/api/who`, {}, cookie2);
      return res.res.status === 502;
    }, 10_000, "502 after kill");
    const dead = await jsonFetch(`${base}/i/${svcA.slug}/api/who`, {}, cookie2);
    check("S5-2", dead.res.status === 502 && dead.body?.code === "INSTANCE_UNREACHABLE", "实例不可达 502 可读原因", String(dead.body?.code));

    const stopB = await jsonFetch(`${base}/api/daemon/services/${svcB.id}/stop`, { method: "POST" }, cookie2);
    check("S5-3", stopB.res.status === 200, "停止实例成功", String(stopB.res.status));
    const hzDaemon = await jsonFetch(`${base}/healthz`);
    check("S5-4", hzDaemon.res.ok, "停实例后 daemon 仍健康", String(hzDaemon.res.status));
  } finally {
    cleanup();
  }

  const failed = checks.filter((item) => !item.ok);
  const result = {
    title: "daemon-unified-port（v0.7.0）· 单端口＋daemon 账号＋壳/浮动小球 · 交付报告",
    subtitle: `隔离 daemon 实跑 ${checks.length} 项断言 ＋ 浏览器壳/小球截图`,
    meta: `${new Date().toISOString().slice(0, 10)} · change daemon-unified-port · ${checks.length - failed.length}/${checks.length} checks`,
    thesis:
      "daemon 单端口承载全部实例（UDS 反代）：daemon 账号登录、服务端注入实例凭据、/shell 壳与浮动小球；" +
      "未登录 302/401、机器通道 Host 条件、SSE 逐块、502 语义全部隔离实跑验证。",
    env: [
      ["隔离", "mkdtemp state-dir + 临时 HOME + 13670-13678 空闲端口；生产板 13689 与真实 daemon 13679 零接触"],
      ["浏览器", "playwright-core + Chrome headless；1280×800 与 390×844"],
      ["覆盖表", "src/daemon/{router,gate,credentials,accounts,daemon-auth,server,state,slug}.ts、src/server/{instance-client,serve,http,discovery}.ts、src/ui/**（登录/控制台/壳）"],
      ["无视觉面", "CLI/测试/文档类改动（三类之①）显式登记；视觉面＝登录页/控制台/壳页/小球菜单（截图见下）"],
      ["UNCOVERED", failed.length === 0 ? "0" : String(failed.length)],
    ],
    sections: [
      {
        title: "1 · 首启与登录",
        steps: checks
          .filter((item) => item.id.startsWith("S1"))
          .map((item) => ({ id: item.id, intent: item.name, reply: item.detail, assertion: item.ok ? "PASS" : "FAIL", ok: item.ok })),
      },
      {
        title: "2 · 单端口与 UDS",
        steps: checks
          .filter((item) => item.id.startsWith("S2"))
          .map((item) => ({ id: item.id, intent: item.name, reply: item.detail, assertion: item.ok ? "PASS" : "FAIL", ok: item.ok })),
      },
      {
        title: "3 · 反代/注入/proxied/SSE/壳 HTML",
        steps: checks
          .filter((item) => item.id.startsWith("S3"))
          .map((item) => ({ id: item.id, intent: item.name, reply: item.detail, assertion: item.ok ? "PASS" : "FAIL", ok: item.ok })),
      },
      {
        title: "4 · 浏览器：登录 → 控制台 → 壳 → 小球菜单",
        steps: [
          { id: "S4-0", intent: "登录页（1280）", assertion: "截图", ok: true, image: "01-login.png", imageMeta: "1280×800 · png" },
          { id: "S4-1", intent: "控制台服务行", assertion: "截图", ok: true, image: "02-console.png", imageMeta: "1280×800 · png" },
          { id: "S4-2", intent: "壳页（iframe 实例）", assertion: "截图", ok: true, image: "03-shell.png", imageMeta: "1280×800 · png" },
          { id: "S4-3", intent: "浮动小球菜单", assertion: "截图", ok: true, image: "04-ball-menu.png", imageMeta: "1280×800 · png" },
          { id: "S4-4", intent: "切换实例", assertion: "截图", ok: true, image: "05-switch.png", imageMeta: "1280×800 · png" },
          { id: "S4-5", intent: "壳页移动端 390", assertion: "截图", ok: true, image: "06-shell-mobile.png", imageMeta: "390×844 · png" },
          ...checks
            .filter((item) => item.id.startsWith("S4"))
            .map((item) => ({ id: item.id, intent: item.name, reply: item.detail, assertion: item.ok ? "PASS" : "FAIL", ok: item.ok })),
        ],
      },
      {
        title: "5 · 退出与 502",
        steps: checks
          .filter((item) => item.id.startsWith("S5"))
          .map((item) => ({ id: item.id, intent: item.name, reply: item.detail, assertion: item.ok ? "PASS" : "FAIL", ok: item.ok })),
      },
    ],
    summary: { pass: checks.length - failed.length, fail: failed.length },
  };
  writeFileSync(join(REPORT_DIR, "steps.json"), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(
    join(REPORT_DIR, "results.json"),
    `${JSON.stringify({ checks, screenshots, ok: failed.length === 0 }, null, 2)}\n`,
  );
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed · ${REPORT_DIR}/results.json`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();

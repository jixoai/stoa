#!/usr/bin/env bun
/**
 * stoa-daemon E2E 验收（D1/D2/D3）：daemon 模式（CLI 默认挂载、终端释放、幂等）、
 * `--standalone` 前台契约、daemon-webui（390/1280 真实操作：空态/挂载/停止/移除/关闭）。
 *
 * Isolation: 全部状态在 mkdtemp 的 state-dir（STOA_DAEMON_STATE_DIR）与临时 data-dir；
 * 生产板 127.0.0.1:13689 与本机真实 daemon 零接触（显式 --state-dir / env）。
 *
 * Run:
 *   bun scripts/qa/stoa-daemon.mjs
 *   bun scripts/qa/stoa-daemon.mjs --no-build
 *
 * 证据：--report-dir 默认 <主仓>/.agents/reports/manager/stoa-daemon
 *      产出 results.json + steps.json + PNG；统一生成器再把 steps.json 变 report.html。
 */
import { chromium } from "playwright-core";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, argValue } from "./lib/qa-env.mjs";

const NO_BUILD = process.argv.includes("--no-build");
const REPORT_DIR = resolve(
  argValue(process.argv.slice(2), "report-dir") ??
    join(REPO_ROOT, "..", "..", ".agents", "reports", "manager", "stoa-daemon"),
);
mkdirSync(REPORT_DIR, { recursive: true });

const CLI = join(REPO_ROOT, "src/cli/main.ts");
const BUN = process.execPath;
const RESERVED_PORTS = new Set([13689, 13690, 13696, 13697]);
const KEEP = process.argv.includes("--keep");

if (!NO_BUILD) {
  execFileSync("bun", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
}

const startedAt = Date.now();
const checks = [];
const steps = [];
const screenshots = [];
const pids = { daemon: null, services: [] };
const spawned = [];

function check(name, ok, detail = "", extra = {}) {
  const item = { name, ok: Boolean(ok), detail, at: Date.now() - startedAt };
  checks.push(item);
  steps.push({
    id: extra.id,
    intent: name,
    expect: extra.expect,
    assertion: detail || (ok ? "PASS" : "FAIL"),
    ok: Boolean(ok),
    image: extra.image,
    imageMeta: extra.image ? `${extra.imageWidth ?? ""} · PNG` : undefined,
  });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function shot(page, name) {
  // animations:"disabled" 让 CSS 动画快进到终态（否则会抓到 toast/对话框的进场中间帧）。
  await page.waitForTimeout(250);
  const path = join(REPORT_DIR, name);
  await page.screenshot({ path, animations: "disabled" });
  screenshots.push(name);
  return name;
}

/**
 * 等页面上的官方 toast 全部消失（避免覆盖服务行/页脚，保证截图可验收）。
 * 注意：Base UI toast 悬停会暂停自动消失计时——先把鼠标移开，否则永远等不到。
 */
async function waitToastsGone(page) {
  await page.mouse.move(2, 2);
  await waitFor(
    () => page.locator('[data-slot="toast"]').count().then((n) => n === 0),
    10_000,
    "toasts cleared",
  ).catch(() => undefined);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(checkFn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await checkFn()) return true;
    if (Date.now() > deadline) {
      console.log(`WAIT-TIMEOUT ${label}`);
      return false;
    }
    await sleep(150);
  }
}

async function pickFreePort(min, max, exclude) {
  for (let port = max; port >= min; port--) {
    if (exclude.has(port)) continue;
    try {
      const server = await Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("x") });
      await server.stop(true);
      return port;
    } catch {
      // busy
    }
  }
  throw new Error(`no free port in ${min}-${max}`);
}

function cliRun(args, env = {}) {
  const res = spawnSync(BUN, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, STOA_DAEMON_STATE_DIR: undefined, ...env },
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function cliJson(args, env = {}) {
  const res = cliRun(args, env);
  const line = res.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`CLI ${args.join(" ")} printed no JSON: ${res.stdout.slice(0, 300)} ${res.stderr.slice(0, 300)}`);
  return { ...res, json: JSON.parse(line) };
}

async function fetchJson(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── sandbox ─────────────────────────────────────────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), "stoa-daemon-qa-"));
const stateDir = join(sandbox, "state");
const dirs = {
  a: join(sandbox, "board-a"),
  b: join(sandbox, "board-b"),
  c: join(sandbox, "board-c"),
};

function initBoard(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const res = cliRun(["init", "--data-dir", dir]);
  if (res.code !== 0) throw new Error(`init ${dir} failed: ${res.stderr || res.stdout}`);
}

async function cleanup() {
  for (const proc of spawned) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  for (const pid of [pids.daemon, ...pids.services]) {
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  if (!KEEP) rmSync(sandbox, { recursive: true, force: true });
}

let failed = false;
let browser = null;
let daemonUrl = null;

try {
  for (const dir of [dirs.a, dirs.b, dirs.c]) initBoard(dir);
  check("夹具：三个隔离 data-dir 初始化完成（init 走真实 CLI）", true, sandbox, {
    id: "S0-1",
    expect: "init 退出码 0；目录树在 /tmp 沙箱内",
  });

  const daemonPort = await pickFreePort(13670, 13679, RESERVED_PORTS);
  const portA = await pickFreePort(13680, 13699, new Set([...RESERVED_PORTS, daemonPort]));
  const portB = await pickFreePort(13680, 13699, new Set([...RESERVED_PORTS, daemonPort, portA]));
  const portC = await pickFreePort(13680, 13699, new Set([...RESERVED_PORTS, daemonPort, portA, portB]));
  daemonUrl = `http://127.0.0.1:${daemonPort}`;

  // ── S1: daemon start（CLI） ────────────────────────────────────────────────
  const start1 = cliJson(["daemon", "start", "--state-dir", stateDir, "--port", String(daemonPort)]);
  pids.daemon = Number(start1.json.pid) || null;
  const health1 = await fetchJson(`${daemonUrl}/healthz`);
  check(
    "S1-1 `daemon start` 拉起 daemon，/healthz 就绪（stateDir 归属正确）",
    start1.code === 0 &&
      health1?.ok === true &&
      health1?.daemon === true &&
      health1?.stateDir === stateDir,
    `pid=${pids.daemon} url=${daemonUrl} stateDir=${health1?.stateDir}`,
    { id: "S1-1", expect: "退出码 0；healthz {ok:true,daemon:true,stateDir=隔离目录}" },
  );

  const start2 = cliJson(["daemon", "start", "--state-dir", stateDir, "--port", String(daemonPort)]);
  check(
    "S1-2 `daemon start` 幂等：复用同一 daemon 进程",
    start2.json.pid === pids.daemon,
    `pid=${start2.json.pid}`,
    { id: "S1-2", expect: "第二次 start 返回同一 pid" },
  );

  // ── S4a: daemon-webui 空态（先于任何 CLI 挂载） ───────────────────────────
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const consoleErrors = [];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));
  await page.goto(daemonUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Stoa Daemon", { timeout: 10_000 });
  const bootOk = await page.evaluate(() => Boolean(window.__STOA_DAEMON__));
  const emptyVisible = await page.locator("text=还没有挂载的服务").isVisible().catch(() => false);
  const imgEmpty390 = await shot(page, "daemon-empty-390.png");
  check(
    "S4-1 daemon-webui 注入生效（390×844）：控制台渲染 + 空态呈现",
    bootOk && emptyVisible,
    `boot=${bootOk} empty=${emptyVisible}`,
    { id: "S4-1", expect: "window.__STOA_DAEMON__ 注入；空态文案可见（尚无挂载）", image: imgEmpty390, imageWidth: "390×844" },
  );

  // ── S2: CLI 默认 serve = daemon 模式 ───────────────────────────────────────
  const serveStart = Date.now();
  const serve1 = cliJson(["serve", "--data-dir", dirs.a, "--port", String(portA)], {
    STOA_DAEMON_STATE_DIR: stateDir,
  });
  const serveMs = Date.now() - serveStart;
  const serviceA = serve1.json.service ?? {};
  pids.services.push(Number(serviceA.pid) || 0);
  check(
    "S2-1 `stoa serve` 默认模式：终端立即释放 + stdout 单行 detached JSON",
    serve1.code === 0 && serve1.json.detached === true && serveMs < 30_000,
    `${serveMs}ms · stdout=${serve1.stdout.trim().slice(0, 200)}`,
    { id: "S2-1", expect: "退出码 0（终端释放）；stdout 单行 JSON detached:true" },
  );
  check(
    "S2-2 服务已挂载：service_url/daemon_url 正确且 /healthz 200",
    serve1.json.service_url === `http://127.0.0.1:${portA}` &&
      serve1.json.daemon_url === daemonUrl &&
      (await fetchJson(`http://127.0.0.1:${portA}/healthz`))?.ok === true,
    `service_url=${serve1.json.service_url} daemon_url=${serve1.json.daemon_url}`,
    { id: "S2-2", expect: "两链接与预期端口一致；服务 healthz dataDir 匹配" },
  );

  const serve2 = cliJson(["serve", "--data-dir", dirs.a, "--port", String(portA)], {
    STOA_DAEMON_STATE_DIR: stateDir,
  });
  const serviceA2 = serve2.json.service ?? {};
  check(
    "S2-3 重复 serve 幂等：同一 service.id / pid，不新起进程",
    serviceA2.id === serviceA.id && serviceA2.pid === serviceA.pid,
    `id=${serviceA2.id} pid=${serviceA2.pid}`,
    { id: "S2-3", expect: "第二次 serve 返回既有登记（reused）" },
  );

  // ── S4b: 列表（390/1280）——CLI 已挂载 A 板，刷新后可见 ─────────────────────
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Stoa Daemon", { timeout: 10_000 });
  const rowA = await waitFor(
    () => page.locator("[data-testid^=daemon-service-]").count().then((n) => n >= 1),
    15_000,
    "row A visible",
  );
  const imgList390 = await shot(page, "daemon-list-390.png");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(200);
  const imgList1280 = await shot(page, "daemon-list-1280.png");
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    "S4-2 daemon-webui 列表（390/1280）：CLI 挂载的 A 板出现且状态为运行中",
    rowA && (await page.locator("text=运行中").count()) >= 1,
    "rows>=1 · badge=运行中",
    { id: "S4-2", expect: "列表行（名称/运行中/URL/端口/启动时间）两视口截图", image: imgList390, imageWidth: "390×844" },
  );
  check("S4-2b 桌面 1280×900 列表截图", true, imgList1280, {
    id: "S4-2b",
    expect: "桌面视口行布局（操作按钮右置）",
    image: imgList1280,
    imageWidth: "1280×900",
  });

  // ── S3: --standalone 前台契约 ─────────────────────────────────────────────
  const standalone = spawn(BUN, [CLI, "serve", "--standalone", "--data-dir", dirs.b, "--port", String(portB)], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, STOA_DAEMON_STATE_DIR: stateDir },
  });
  spawned.push(standalone);
  const stdOut = [];
  standalone.stdout.on("data", (chunk) => stdOut.push(chunk.toString()));
  const standaloneReady = await waitFor(
    () => stdOut.join("").includes("REPORT_URL="),
    20_000,
    "standalone REPORT_URL",
  );
  const aliveWhileForeground = standalone.exitCode === null;
  const healthB = await fetchJson(`http://127.0.0.1:${portB}/healthz`);
  const registryAfterStandalone = cliJson(["daemon", "status", "--state-dir", stateDir]).json;
  check(
    "S3-1 `--standalone` 前台：占用终端（进程存活）、打印 REPORT_URL、healthz 200",
    standaloneReady && aliveWhileForeground && healthB?.ok === true,
    `pid=${standalone.pid} url=http://127.0.0.1:${portB}`,
    { id: "S3-1", expect: "进程不退出；stdout 首行 REPORT_URL=；(B 板)healthz 200" },
  );
  check(
    "S3-2 `--standalone` 与 daemon 脱钩：登记表里没有 B 板",
    !(registryAfterStandalone.services ?? []).some((s) => s.dataDir === dirs.b),
    `services=${JSON.stringify((registryAfterStandalone.services ?? []).map((s) => s.dataDir))}`,
    { id: "S3-2", expect: "daemon 登记仅 A 板一条" },
  );
  standalone.kill("SIGINT");
  const standaloneExited = await waitFor(() => standalone.exitCode !== null, 8_000, "standalone SIGINT exit");
  check("S3-3 `--standalone` Ctrl-C（SIGINT）即退，端口释放", standaloneExited, `exitCode=${standalone.exitCode}`,
    { id: "S3-3", expect: "SIGINT 后进程退出（exitCode 0）" });

  // 表单校验：空 dataDir 提交 → 内联错误（不发请求）
  await page.getByTestId("daemon-mount-submit").click();
  const formErrorVisible = await page
    .getByTestId("daemon-mount-error")
    .isVisible()
    .catch(() => false);
  const imgFormError = await shot(page, "daemon-form-error-390.png");
  check(
    "S4-3 表单校验：空 dataDir 提交给出内联错误（不发起挂载请求）",
    formErrorVisible,
    "inline error shown",
    { id: "S4-3", expect: "Alert 内联提示；服务列表无新增", image: imgFormError, imageWidth: "390×844" },
  );

  // UI 挂载 C 板（表单）
  await page.getByTestId("daemon-mount-data-dir").fill(dirs.c);
  await page.getByTestId("daemon-mount-port").fill(String(portC));
  await page.getByTestId("daemon-mount-name").fill("ui-board");
  await page.getByTestId("daemon-mount-submit").click();
  const uiMounted = await waitFor(
    () => page.locator("text=ui-board").count().then((n) => n > 0),
    20_000,
    "ui mount row",
  );
  const listAfterMount = cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? [];
  const uiRecord = listAfterMount.find((s) => s.name === "ui-board");
  if (uiRecord?.pid) pids.services.push(Number(uiRecord.pid));
  await waitToastsGone(page);
  const imgMount390 = await shot(page, "daemon-mounted-390.png");
  check(
    "S4-4 控制台表单挂载 C 板：UI 行出现 + daemon 登记 running + healthz 200",
    uiMounted &&
      uiRecord?.status === "running" &&
      (await fetchJson(`http://127.0.0.1:${portC}/healthz`))?.ok === true,
    `name=ui-board port=${portC} pid=${uiRecord?.pid}`,
    { id: "S4-4", expect: "表单交互真实打到 POST /api/daemon/services", image: imgMount390, imageWidth: "390×844" },
  );

  // UI 停止 C 板
  const stopBtn = page.locator(`[data-testid="daemon-stop-${uiRecord?.id ?? ""}"]`);
  await stopBtn.click();
  const uiStopped = await waitFor(
    async () =>
      (cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? []).find(
        (s) => s.id === uiRecord?.id,
      )?.status === "stopped",
    25_000,
    "ui stop service",
  );
  await waitToastsGone(page);
  const imgStopped = await shot(page, "daemon-stopped-390.png");
  check(
    "S4-5 控制台「停止」按钮：服务真停（进程死 + 登记降级 stopped）",
    uiStopped && !pidAlive(uiRecord?.pid),
    `pid ${uiRecord?.pid} alive=${pidAlive(uiRecord?.pid)}`,
    { id: "S4-5", expect: "POST /:id/stop 生效；登记 status=stopped", image: imgStopped, imageWidth: "390×844" },
  );

  // UI 移除登记 C 板
  await page.locator(`[data-testid="daemon-remove-${uiRecord?.id ?? ""}"]`).click();
  const uiRemoved = await waitFor(
    () => page.locator("text=ui-board").count().then((n) => n === 0),
    15_000,
    "ui remove row",
  );
  const registryAfterRemove = cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? [];
  check(
    "S4-6 控制台「移除登记」：DELETE 生效，登记消失",
    uiRemoved && !registryAfterRemove.some((s) => s.id === uiRecord?.id),
    `remaining=${registryAfterRemove.length}`,
    { id: "S4-6", expect: "已停服务可移除登记（409 不再出现）" },
  );

  // ── S5: serve --stop（daemon 感知）与 daemon stop 全回收 ───────────────────
  const stopA = cliJson(["serve", "--stop", "--data-dir", dirs.a, "--state-dir", stateDir]);
  check(
    "S5-1 `serve --stop` 走 daemon（via_daemon:true），A 板进程死亡",
    stopA.code === 0 && stopA.json.via_daemon === true && !pidAlive(serviceA.pid),
    `via_daemon=${stopA.json.via_daemon} pid ${serviceA.pid} alive=${pidAlive(serviceA.pid)}`,
    { id: "S5-1", expect: "停止 + 登记收口；服务 healthz 不再 200" },
  );

  // 重新挂载 A 板，验证关闭对话框后 daemon 退出且服务被一并回收
  const serve3 = cliJson(["serve", "--data-dir", dirs.a, "--port", String(portA)], {
    STOA_DAEMON_STATE_DIR: stateDir,
  });
  const serviceA3 = serve3.json.service ?? {};
  if (serviceA3.pid) pids.services.push(serviceA3.pid);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Stoa Daemon", { timeout: 10_000 });
  await page.getByTestId("daemon-shutdown-open").click();
  await page.waitForSelector("text=关闭 daemon？", { timeout: 5_000 });
  await waitToastsGone(page);
  await page.waitForTimeout(400); // 对话框入场动画（duration-100）+ 背景 blur 稳定
  const imgDialog = await shot(page, "daemon-shutdown-dialog-390.png");
  await page.getByTestId("daemon-shutdown-confirm").click();
  const daemonGone = await waitFor(
    async () => (await fetchJson(`${daemonUrl}/healthz`, 400)) === null,
    30_000,
    "daemon shutdown",
  );
  const serviceGone = await waitFor(
    async () => (await fetchJson(`http://127.0.0.1:${portA}/healthz`, 400)) === null,
    15_000,
    "service shutdown",
  );
  check(
    "S5-2 控制台「关闭 daemon」：对话框确认 → daemon 退出并连带停止全部挂载服务",
    daemonGone && serviceGone && !pidAlive(pids.daemon) && !pidAlive(serviceA3.pid),
    `daemon pid ${pids.daemon} alive=${pidAlive(pids.daemon)}；service pid ${serviceA3.pid} alive=${pidAlive(serviceA3.pid)}`,
    { id: "S5-2", expect: "POST /api/daemon/shutdown → 全回收（无孤儿）", image: imgDialog, imageWidth: "390×844" },
  );

  check("S6-1 前端零 console error / pageerror", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "clean", {
    id: "S6-1",
    expect: "浏览器控制台无错误",
  });
} catch (err) {
  check("未捕获异常", false, String(err?.stack ?? err), { id: "FATAL" });
} finally {
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  await cleanup();
  const leftovers = [pids.daemon, ...pids.services].filter((pid) => pidAlive(pid));
  check("S7-1 进程回收：daemon 与全部子服务 pid 均不存活", leftovers.length === 0, leftovers.length ? `alive=${leftovers.join(",")}` : "all reclaimed", {
    id: "cleanup-1",
    expect: "脚本结束时零残留进程；沙箱目录删除",
  });

  failed = checks.some((item) => !item.ok);
  const durationMs = Date.now() - startedAt;
  const result = {
    ok: !failed,
    ranAt: new Date().toISOString(),
    daemonUrl,
    stateDir,
    viewports: ["390×844", "1280×900"],
    durationMs,
    pids,
    checks: checks.map(({ name, ok, detail, at }) => ({ name, ok, detail, at })),
    screenshots,
  };
  writeFileSync(join(REPORT_DIR, "results.json"), JSON.stringify(result, null, 2));
  const failedChecks = checks.filter((item) => !item.ok);
  writeFileSync(
    join(REPORT_DIR, "steps.json"),
    JSON.stringify(
      {
        title: "stoa-daemon — daemon 服务 + daemon-webui E2E 验收",
        brand: "Stoa（人机公示板）· stoa-daemon 交付报告",
        subtitle:
          "daemon 模式默认启用：`stoa serve` 按需拉起本机 daemon、挂载实例、打印服务+daemon 链接并释放终端；`--standalone` 解耦（前台占用）；daemon-webui 统一管理（挂载/停止/移除/关闭）并作为插件可视化入口。",
        meta: `2026-11-10 · ${checks.length} 断言 / ${failedChecks.length} FAIL · 390×844 + 1280×900 · 隔离 stateDir=${stateDir} · 临时 data-dir ×3 · 真实 daemon/服务进程全程回收`,
        thesis:
          failedChecks.length === 0
            ? "结论：CLI 默认 daemon 模式（终端释放、双链接、幂等）、`--standalone` 前台契约、daemon-webui 390/1280 真操作（表单挂载/停止/移除/关闭对话框）与全回收路径全部实测通过；浏览器零 console error。"
            : `结论：${failedChecks.length} 项断言失败（见 FAIL 步骤），不得视为交付。`,
        env: [
          ["隔离沙箱", sandbox],
          ["daemon", `state-dir=${stateDir}（STOA_DAEMON_STATE_DIR；默认 13679 段自选）`],
          ["data-dir", `${dirs.a} / ${dirs.b} / ${dirs.c}（init 真实 CLI）`],
          ["视口", "390×844（移动，hasTouch）／1280×900（桌面）；Chrome"],
          ["生产板/真实 daemon", "127.0.0.1:13689 与默认 state-dir 零接触"],
          ["断言", `${checks.length - failedChecks.length}/${checks.length} PASS · ${durationMs}ms`],
          ["截图", `${screenshots.length} 张 PNG（与 steps.json 同目录）`],
        ],
        sections: [
          {
            title: "1 · CLI daemon 模式（S1/S2）",
            note: "daemon start 幂等；默认 serve 挂载并释放终端，stdout 单行 JSON。",
            steps: steps.filter((step) => /^(S0|S1|S2)/.test(step.id ?? "")),
          },
          {
            title: "2 · --standalone 前台契约（S3）",
            note: "占用终端、REPORT_URL、SIGINT 即退；与 daemon 登记脱钩。",
            steps: steps.filter((step) => /^S3/.test(step.id ?? "")),
          },
          {
            title: "3 · daemon-webui（S4，390/1280 真操作）",
            note: "注入开关、列表、表单挂载、停止、移除登记；截图同目录。",
            steps: steps.filter((step) => /^(S4|S6)/.test(step.id ?? "")),
          },
          {
            title: "4 · 收口与回收（S5/S7）",
            note: "`serve --stop` 走 daemon；控制台关闭 daemon 全回收；零残留进程。",
            steps: steps.filter((step) => /^(S5|S7|cleanup)/.test(step.id ?? "")),
          },
        ],
        summary: { pass: checks.length - failedChecks.length, fail: failedChecks.length },
      },
      null,
      2,
    ),
  );
  console.log(
    `\n${checks.length - failedChecks.length}/${checks.length} checks passed · ${REPORT_DIR}/results.json`,
  );
  process.exitCode = failed ? 1 : 0;
}

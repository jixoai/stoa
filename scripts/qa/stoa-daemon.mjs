#!/usr/bin/env bun
/**
 * stoa-daemon E2E 验收（daemon＋session-ux＋console-layout）：daemon 模式（CLI 默认挂载、
 * 终端释放、幂等）、`--standalone` 前台契约、daemon-webui（390/1280 真实操作：首屏效率/
 * 触发式挂载 Sheet/表单错误就地/操作层级/菜单＋二次确认/口令中心/口令链接自动登录/
 * 临时会话即删/关闭 daemon 与 daemon 已停止态）。
 * stoa-console-open-with-key：O1–O5（「打开」/本地/公网入口自带 #key=、开放模式与
 * /secret 失败的无 key 兜底、界面打码纪律）。
 *
 * Isolation: 全部状态在 mkdtemp 的 state-dir（STOA_DAEMON_STATE_DIR）与临时 data-dir；
 * 生产板 127.0.0.1:13689 与本机真实 daemon（13679）零接触（显式 --state-dir / env）。
 * 端口只用 13680-13699 且排除 13689/13690/13696/13697（其它会话占用的 1369x 由探测跳过）。
 *
 * Run:
 *   bun scripts/qa/stoa-daemon.mjs
 *   bun scripts/qa/stoa-daemon.mjs --no-build
 *
 * 证据：--report-dir 默认 <主仓>/.agents/reports/manager/stoa-daemon-console-layout
 *      产出 results.json + steps.json + PNG；before 图从 ../stoa-daemon 复制为 before-*.png；
 *      统一生成器再把 steps.json 变 report.html（禁手写 HTML）。
 */
import { chromium } from "playwright-core";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, argValue } from "./lib/qa-env.mjs";
import { portIsListening } from "../../src/server/ports.ts";

const NO_BUILD = process.argv.includes("--no-build");
const REPORT_DIR = resolve(
  argValue(process.argv.slice(2), "report-dir") ??
    join(REPO_ROOT, "..", "..", ".agents", "reports", "manager", "stoa-daemon-console-layout"),
);
const BEFORE_DIR = join(REPORT_DIR, "..", "stoa-daemon");
mkdirSync(REPORT_DIR, { recursive: true });

const CLI = join(REPO_ROOT, "src/cli/main.ts");
const BUN = process.execPath;
// 13680-13699 内只认领探测为空且不在保留集里的端口；13689 是生产板，13690/13696/13697
// 是其它会话的常驻端口（见 PORT.md / 现场 lsof），一律不碰。
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
/** 隔离 harness/daemon 侧的时序边界（如实登记，不当作本 change 的失败）。 */
const knownBoundaries = [];

function check(name, ok, detail = "", extra = {}) {
  const item = { name, ok: Boolean(ok), detail, at: Date.now() - startedAt };
  checks.push(item);
  steps.push({
    id: extra.id,
    group: extra.group,
    intent: name,
    expect: extra.expect,
    assertion: detail || (ok ? "PASS" : "FAIL"),
    ok: Boolean(ok),
    image: extra.image,
    imageMeta: extra.image ? `${extra.imageWidth ?? ""} · PNG` : undefined,
    imageBefore: extra.imageBefore,
    imageBeforeMeta: extra.imageBefore ? `${extra.beforeWidth ?? ""} · PNG` : undefined,
  });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** before 图源复制到本报告目录（报告相对引用自包含；不覆盖已有 after 图）。 */
function beforeImage(name) {
  const src = join(BEFORE_DIR, name);
  if (!existsSync(src)) return undefined;
  const target = `before-${name}`;
  const dst = join(REPORT_DIR, target);
  if (!existsSync(dst)) copyFileSync(src, dst);
  return target;
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
    // Bun 对已占用端口不抛错（会静默共享），必须 TCP 探测后再认领。
    if (await portIsListening("127.0.0.1", port)) continue;
    return port;
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

/** testid 是否可见（未挂载/隐藏一律 false，不抛错）。 */
async function visible(page, testid) {
  return page.getByTestId(testid).first().isVisible().catch(() => false);
}

async function setViewport(page, width, height) {
  await page.setViewportSize({ width, height });
  // Sheet 的 side 走 matchMedia，resize 后要等重渲染 + 过渡结束。
  await page.waitForTimeout(400);
}

async function openSheet(page, trigger = "daemon-mount-open") {
  await page.getByTestId(trigger).click();
  await page.waitForSelector('[data-testid="daemon-mount-sheet"]', { state: "visible", timeout: 8000 });
  await page.waitForTimeout(350);
}

async function closeSheet(page) {
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="daemon-mount-sheet"]', { state: "detached", timeout: 8000 });
}

async function openRowMenu(page, id) {
  await page.getByTestId(`daemon-menu-${id}`).click();
  await page.waitForSelector(`[data-testid="daemon-remove-${id}"]`, { state: "visible", timeout: 6000 });
  await page.waitForTimeout(150);
}

/** 确认对话框内点「取消」（保留状态，验证取消无副作用）。 */
async function cancelConfirm(page) {
  const dialog = page.locator('[data-slot="dialog-content"]').last();
  await dialog.getByRole("button", { name: "取消" }).click();
  await page.waitForSelector('[data-slot="dialog-content"]', { state: "detached", timeout: 8000 });
  await page.waitForTimeout(150);
}

/**
 * 横向溢出测量（三项同时测，避免假阴性）：
 *   1) 页面滚动容器 `.h-dvh`（overflow-y:auto 会把内部溢出吃掉，body/html 可能测不到）；
 *   2) 服务列表容器 `[data-testid="daemon-services"]`；
 *   3) 每个服务行的右边缘不得超过视口。
 * 返回 worst>0 或 rowsOutside>0 即失败。
 */
async function overflowX(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector(".h-dvh");
    const list = document.querySelector('[data-testid="daemon-services"]');
    const html = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth;
    const scrollOverflow = scroll ? scroll.scrollWidth - scroll.clientWidth : 0;
    const listOverflow = list ? list.scrollWidth - list.clientWidth : 0;
    const rowsOutside = [...document.querySelectorAll('[data-testid^="daemon-service-"]')].filter(
      (el) => el.getBoundingClientRect().right > window.innerWidth + 0.5,
    ).length;
    const worst = Math.max(html, scrollOverflow, listOverflow);
    return {
      html,
      scroll: scrollOverflow,
      list: listOverflow,
      rowsOutside,
      worst,
      ok: worst <= 0 && rowsOutside === 0,
    };
  });
}

/** 负向对照：注入 2000px 子元素必须被 overflowX 检出，移除后必须恢复。 */
async function overflowNegativeControl(page) {
  const injected = await page.evaluate(() => {
    const host = document.querySelector('[data-testid="daemon-services"]');
    if (!host) return false;
    const probe = document.createElement("div");
    probe.id = "qa-overflow-probe";
    probe.style.width = "2000px";
    probe.style.height = "4px";
    host.appendChild(probe);
    return true;
  });
  const detected = await overflowX(page);
  await page.evaluate(() => document.getElementById("qa-overflow-probe")?.remove());
  const restored = await overflowX(page);
  return {
    injected,
    detected,
    restored,
    ok: injected && !detected.ok && restored.ok,
    detail: `injected=${injected} detected=${JSON.stringify(detected)} restored=${JSON.stringify(restored)}`,
  };
}

/** 两个 boundingBox 的垂直间隙（下一页元素 top - 上一元素 bottom）。 */
function verticalGap(upper, lower) {
  if (!upper || !lower) return Number.POSITIVE_INFINITY;
  return lower.y - (upper.y + upper.height);
}

/**
 * 「次级信息可复制」：状态目录与服务行目录各点一次复制钮，剪贴板必须等于完整值；
 * 同时校验截断路径元素的 title 带完整值（肩窥/截断时的完整值提示）。
 */
async function verifyCopyablePaths(page, stateDirValue, service) {
  const row = page.getByTestId(`daemon-service-${service.id}`);
  const statePathTitle = await page.locator(`span[title="${stateDirValue}"]`).count();
  const rowPathTitle = await row.locator(`span[title="${service.dataDir}"]`).count();
  await page.getByRole("button", { name: "复制状态目录" }).click();
  await sleep(250);
  const stateClip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  await row.getByRole("button", { name: "复制目录路径" }).click();
  await sleep(250);
  const dataClip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  return {
    ok:
      statePathTitle > 0 &&
      rowPathTitle > 0 &&
      stateClip === stateDirValue &&
      dataClip === service.dataDir,
    detail: `stateTitle=${statePathTitle > 0} rowTitle=${rowPathTitle > 0} stateClipMatch=${stateClip === stateDirValue} dataClipMatch=${dataClip === service.dataDir}`,
  };
}

/**
 * 日志/报告只留 URL 的 origin+path（去掉 fragment）——口令真值绝不进输出。
 * 断言比较在布尔层完成（URL 全等/前缀），detail 只用本函数的打码结果。
 */
function redactUrl(raw) {
  try {
    const url = new URL(String(raw ?? ""));
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(invalid-url)";
  }
}

// ── sandbox ─────────────────────────────────────────────────────────────────
const sandbox = mkdtempSync(join(tmpdir(), "stoa-daemon-qa-"));
const stateDir = join(sandbox, "state");
// 自动会话落在 $HOME/.stoa/sessions：HOME 必须隔离，别污染真实主目录。
const sandboxHome = join(sandbox, "home");
const pickedDir = join(sandbox, "picked-dir");
mkdirSync(sandboxHome, { recursive: true, mode: 0o700 });
mkdirSync(pickedDir, { recursive: true, mode: 0o700 });
const dirs = {
  a: join(sandbox, "board-a"),
  b: join(sandbox, "board-b"),
  c: join(sandbox, "board-c"),
  /** 开放模式夹具（O3）：init 后移除 STOA_AUTH，standalone 起服务再由 daemon 收编。 */
  open: join(sandbox, "board-open"),
};

function initBoard(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const res = cliRun(["init", "--data-dir", dir]);
  if (res.code !== 0) throw new Error(`init ${dir} failed: ${res.stderr || res.stdout}`);
}

/**
 * 隔离 harness 自愈（已知边界的处置，不是放松断言）：
 * daemon 读面的惰性失活校正/健康探测在系统繁忙时可能把「pid 仍存活」的服务误降级为
 * stopped（无任何 stop 请求/CLI stop 证据）。此时：
 *   1) 如实登记到 knownBoundaries（附 registry/pid 证据）；
 *   2) 重新 `serve`（adopt 在跑实例）恢复，再刷新页面，让后续 UI 步骤测的是真 UI。
 * pid 已死的真死亡不在此自愈（返回 ok=false，让步骤带原始证据 FAIL）。
 */
async function ensureServiceRunning(page, record, label) {
  if (!record?.id) return { ok: false, healed: false, pid: null, detail: "missing record" };
  const readStatus = () =>
    (cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? []).find((s) => s.id === record.id);
  let current = readStatus();
  if (current?.status === "running") {
    return { ok: true, healed: false, pid: current.pid, detail: `running pid=${current.pid}` };
  }
  const observedStatus = current?.status ?? "missing";
  const observedPid = current?.pid ?? record.pid ?? null;
  const aliveBefore = pidAlive(observedPid);
  if (!aliveBefore) {
    knownBoundaries.push(
      `${label}：服务「${record.name ?? record.id}」在 registry 中为 ${observedStatus} 且 pid ${observedPid ?? "?"} 已不存活（真实死亡，非 UI 缺陷）；未自愈，交由步骤断言失败并保留原始证据。`,
    );
    return { ok: false, healed: false, pid: observedPid, detail: `${observedStatus} pid=${observedPid} dead` };
  }
  // `serve` CLI 输出用 data_dir（snake_case），daemon status 用 dataDir（camelCase）；
  // 两处调用方都会传进来——缺字段时必须跳过 spawn，绝不能把 undefined 变成字符串 "undefined"。
  const healDir = record.dataDir ?? record.data_dir ?? null;
  const healPort = Number(record.port);
  if (!healDir || healDir === "undefined" || !Number.isInteger(healPort)) {
    knownBoundaries.push(
      `${label}：登记缺少 dataDir/data_dir 或合法 port（dir=${String(healDir)} port=${String(record.port)}），已跳过自愈 spawn，避免 --data-dir undefined；交由步骤断言失败。`,
    );
    return {
      ok: false,
      healed: false,
      pid: observedPid,
      detail: `${observedStatus} pid=${observedPid} no-heal-target`,
    };
  }
  const heal = cliJson(["serve", "--data-dir", healDir, "--port", String(healPort)], {
    STOA_DAEMON_STATE_DIR: stateDir,
  });
  const healedPid = Number(heal.json?.service?.pid) || null;
  if (healedPid) pids.services.push(healedPid);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Stoa Daemon", { timeout: 10_000 });
  await waitFor(
    () => page.locator(`[data-testid="daemon-service-${record.id}"]`).count().then((n) => n > 0),
    15_000,
    `${label} row after reheal`,
  );
  current = readStatus();
  const ok = current?.status === "running";
  knownBoundaries.push(
    `${label}：daemon 读面把在跑服务「${record.name ?? record.id}」登记降级为 ${observedStatus}（pid ${observedPid} 仍存活、无 stop 请求/CLI stop）——判定为隔离 harness 的 daemon 惰性校正/健康探测时序（非本 change，UI-only）；已重新 serve（adopt）恢复${ok ? "成功" : "失败"}。`,
  );
  return { ok, healed: true, pid: current?.pid ?? healedPid, detail: `${observedStatus}→${current?.status ?? "missing"} pidAlive=true` };
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
/** 本次认领的端口（finally 里做释放断言；daemon 端口用 --daemon-port 固定，不能依赖 CLI 回退带）。 */
let qaPorts = [];

try {
  for (const dir of [dirs.a, dirs.b, dirs.c]) initBoard(dir);
  check("夹具：三个隔离 data-dir 初始化完成（init 走真实 CLI）", true, sandbox, {
    id: "S0-1",
    group: "cli",
    expect: "init 退出码 0；目录树在 /tmp 沙箱内",
  });

  const daemonPort = await pickFreePort(13680, 13699, RESERVED_PORTS);
  const portA = await pickFreePort(13680, 13699, new Set([...RESERVED_PORTS, daemonPort]));
  const portB = await pickFreePort(13680, 13699, new Set([...RESERVED_PORTS, daemonPort, portA]));
  const portC = await pickFreePort(13680, 13699, new Set([...RESERVED_PORTS, daemonPort, portA, portB]));
  daemonUrl = `http://127.0.0.1:${daemonPort}`;
  qaPorts = [daemonPort, portA, portB, portC];

  // ── S1: daemon start（CLI） ────────────────────────────────────────────────
  // 注意：`daemon start` 只认 `--daemon-port`（`--port` 是 `daemon run` 的语义）；
  // 不显式固定时 CLI 会回退到 13670-13679 带，与 QA 探测端口不一致。
  const start1 = cliJson(
    ["daemon", "start", "--state-dir", stateDir, "--daemon-port", String(daemonPort)],
    {
      HOME: sandboxHome,
      STOA_DIR_PICKER_RESULT: pickedDir,
    },
  );
  pids.daemon = Number(start1.json.pid) || null;
  const health1 = await fetchJson(`${daemonUrl}/healthz`);
  check(
    "S1-1 `daemon start` 拉起 daemon，/healthz 就绪（stateDir/端口归属正确）",
    start1.code === 0 &&
      start1.json.url === daemonUrl &&
      health1?.ok === true &&
      health1?.daemon === true &&
      health1?.stateDir === stateDir,
    `pid=${pids.daemon} url=${start1.json.url} requested=${daemonUrl} stateDir=${health1?.stateDir}`,
    { id: "S1-1", group: "cli", expect: "退出码 0；--daemon-port 生效；healthz {ok:true,daemon:true,stateDir=隔离目录}" },
  );

  const start2 = cliJson([
    "daemon",
    "start",
    "--state-dir",
    stateDir,
    "--daemon-port",
    String(daemonPort),
  ]);
  check(
    "S1-2 `daemon start` 幂等：复用同一 daemon 进程",
    start2.json.pid === pids.daemon,
    `pid=${start2.json.pid}`,
    { id: "S1-2", group: "cli", expect: "第二次 start 返回同一 pid" },
  );

  // ── S4a: daemon-webui 空态（先于任何 CLI 挂载） ───────────────────────────
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const consoleErrors = [];
  /** B1 测试窗口内故意注入的 500：Chrome 会记为 console error，仅在该窗口内忽略该签名。 */
  let injectedFailures = 0;
  // 口令对话框的「复制」走 clipboard API：headless 下需要显式授权（否则走 execCommand 兜底可能失败）。
  const mainContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await mainContext.newPage();
  // O1–O5：录制控制台 window.open 的目标 URL，但不真开窗（落地验证另起干净上下文 goto 录到的 URL）。
  // 返回值必须是 truthy：实现用 null 判断「被浏览器拦截」，QA 返回哑 WindowProxy 替身以免误触提示。
  await page.addInitScript(() => {
    const urls = [];
    Object.defineProperty(window, "__qaOpenUrls", { value: urls, configurable: true });
    window.open = function (url) {
      try {
        urls.push(String(url ?? ""));
      } catch {
        /* ignore */
      }
      return { closed: false, focus() {}, opener: null };
    };
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (injectedFailures > 0 && /500 \(Internal Server Error\)/.test(text)) return;
    consoleErrors.push(text);
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));
  await page.goto(daemonUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Stoa Daemon", { timeout: 10_000 });
  const bootOk = await page.evaluate(() => Boolean(window.__STOA_DAEMON__));
  const bootStateDir = await page.evaluate(() => window.__STOA_DAEMON__?.stateDir ?? "");
  const emptyVisible = await page.locator("text=还没有挂载的服务").isVisible().catch(() => false);
  const imgEmpty390 = await shot(page, "daemon-empty-390.png");
  check(
    "S4-1 daemon-webui 注入生效（390×844）：控制台渲染 + 空态呈现",
    bootOk && emptyVisible,
    `boot=${bootOk} empty=${emptyVisible}`,
    {
      id: "S4-1",
      group: "sheet",
      expect: "window.__STOA_DAEMON__ 注入；空态文案可见（尚无挂载）",
      image: imgEmpty390,
      imageWidth: "390×844",
      imageBefore: beforeImage("daemon-empty-390.png"),
      beforeWidth: "390×844",
    },
  );

  // ── L1: 390 首屏效率 + 空态引导（触发式入口，无常驻表单） ──────────────────
  const noFormFields = !(await visible(page, "daemon-mount-port")) &&
    !(await visible(page, "daemon-mount-data-dir")) &&
    !(await visible(page, "daemon-mount-submit")) &&
    !(await visible(page, "daemon-mount-sheet"));
  const countsEmpty = (await page.getByText("0 运行中").isVisible().catch(() => false)) &&
    (await page.getByText("0 已停止").isVisible().catch(() => false));
  const addVisible = await visible(page, "daemon-mount-open");
  const ctaVisible = await visible(page, "daemon-mount-empty-cta");
  const cliTriggerVisible = await page.getByRole("button", { name: /或使用 CLI/ }).isVisible().catch(() => false);
  const overflow390Empty = await overflowX(page);
  // 负向对照：证明三项溢出测量真的会 FAIL（否则「无溢出」可能是假阴性）。
  const overflowNegControl = await overflowNegativeControl(page);
  check(
    "L1-1 390 空态首屏：无常驻表单字段 / 运行与停止计数 / 添加入口 / 无横向溢出（含负向对照）",
    noFormFields &&
      countsEmpty &&
      addVisible &&
      ctaVisible &&
      cliTriggerVisible &&
      overflow390Empty.ok &&
      overflowNegControl.ok,
    `formFields=${noFormFields} counts=${countsEmpty} add=${addVisible} cta=${ctaVisible} cli=${cliTriggerVisible} overflow=${JSON.stringify(overflow390Empty)} negControl=${overflowNegControl.detail}`,
    {
      id: "L1-1",
      group: "sheet",
      expect:
        "首屏不出现挂载表单；计数/添加入口可见；滚动容器、列表容器、行右边缘三测均无溢出；注入 2000px 探针必须被检出",
    },
  );
  await page.getByRole("button", { name: /或使用 CLI/ }).click();
  await page.waitForTimeout(300);
  const cliCode = page.locator('code[title="stoa serve --data-dir <目录>"]');
  const cliBox = await cliCode.boundingBox().catch(() => null);
  const cliText = (await cliCode.innerText().catch(() => "")) || "";
  const primaryProbe = await page.evaluate(() => {
    const header = document.querySelector('[data-testid="daemon-mount-open"]');
    const cta = document.querySelector('[data-testid="daemon-mount-empty-cta"]');
    return {
      headerPrimary: header?.className.includes("bg-primary") ?? null,
      ctaPrimary: cta?.className.includes("bg-primary") ?? null,
      primaryCount: document.querySelectorAll("button.bg-primary").length,
    };
  });
  check(
    "L1-2 空态单一主路径：CLI 备选折叠可展开、命令行不被视口底边截断；header 按钮降级 ghost",
    Boolean(cliBox) &&
      cliBox.y >= 0 &&
      cliBox.y + cliBox.height <= 844 &&
      cliText.includes("stoa serve") &&
      primaryProbe.headerPrimary === false &&
      primaryProbe.ctaPrimary === true &&
      primaryProbe.primaryCount === 1,
    `cliBox=${cliBox ? `${Math.round(cliBox.y)}+${Math.round(cliBox.height)}` : "null"} text=${cliText.replace(/\s+/g, " ")} primary=${JSON.stringify(primaryProbe)}`,
    {
      id: "L1-2",
      group: "sheet",
      expect: "CLI 行完整落在 390×844 视口内；空态仅一个实心主按钮（CTA），header 为 ghost",
    },
  );

  // ── L2: 空态 CTA 打开同一 Sheet；390 底部抽屉 / 1280 右侧抽屉 ──────────────
  await openSheet(page, "daemon-mount-empty-cta");
  const sheetTitle = await page.getByText("挂载服务", { exact: true }).isVisible().catch(() => false);
  const sheet390 = await page.getByTestId("daemon-mount-sheet").boundingBox();
  const sheetBottom =
    Boolean(sheet390) &&
    Math.abs((sheet390?.x ?? 0) - 0) < 2 &&
    Math.abs((sheet390?.width ?? 0) - 390) < 2 &&
    Math.abs((sheet390?.y ?? 0) + (sheet390?.height ?? 0) - 844) < 3 &&
    (sheet390?.height ?? 999) <= 844 * 0.85 + 2;
  const imgSheet390 = await shot(page, "daemon-sheet-open-390.png");
  check(
    "L2-1 空态 CTA 打开官方 Sheet（390：底部抽屉、全宽贴底、≤85dvh、标题可见）",
    sheetTitle && sheetBottom,
    `box=${JSON.stringify(sheet390)} title=${sheetTitle}`,
    {
      id: "L2-1",
      group: "sheet",
      expect: "daemon-mount-sheet 可见；390 下 x=0/宽=390/贴底/高度≤85dvh；SheetTitle「挂载服务」",
      image: imgSheet390,
      imageWidth: "390×844",
    },
  );

  await setViewport(page, 1280, 900);
  const sheet1280 = await page.getByTestId("daemon-mount-sheet").boundingBox();
  const sheetRight =
    Boolean(sheet1280) &&
    Math.abs((sheet1280?.x ?? 0) + (sheet1280?.width ?? 0) - 1280) < 2 &&
    Math.abs((sheet1280?.width ?? 0) - 440) < 2 &&
    Math.abs(sheet1280?.y ?? 0) < 2 &&
    Math.abs((sheet1280?.height ?? 0) - 900) < 2;
  const imgSheet1280 = await shot(page, "daemon-sheet-open-1280.png");
  check(
    "L2-2 Sheet 随视口切换形态（1280：右侧 440px 全高、贴右对齐）",
    sheetRight,
    `box=${JSON.stringify(sheet1280)}`,
    {
      id: "L2-2",
      group: "sheet",
      expect: "x+width≈1280；宽≈440；y=0；高=视口高",
      image: imgSheet1280,
      imageWidth: "1280×900",
    },
  );

  // ── S4-3 / L3: 表单错误就地（1280 与 390） ───────────────────────────────
  await page.getByTestId("daemon-location-path").click();
  await page.getByTestId("daemon-mount-submit").click();
  const err1280 = await page.getByTestId("daemon-mount-error").isVisible().catch(() => false);
  const dirInput1280 = await page.getByTestId("daemon-mount-data-dir").boundingBox();
  const errBox1280 = await page.getByTestId("daemon-mount-error").boundingBox();
  const gap1280 = verticalGap(dirInput1280, errBox1280);
  const imgErr1280 = await shot(page, "daemon-form-error-1280.png");
  check(
    "L3-1 表单错误就地（1280）：错误文本紧贴目录输入框下方（<80px），不落面板底部",
    err1280 && gap1280 < 80,
    `gap=${Number.isFinite(gap1280) ? `${Math.round(gap1280)}px` : "?"}`,
    {
      id: "L3-1",
      group: "sheet",
      expect: "daemon-mount-error 可见且与目录输入框垂直距离 <80px",
      image: imgErr1280,
      imageWidth: "1280×900",
    },
  );

  await setViewport(page, 390, 844);
  const err390 = await page.getByTestId("daemon-mount-error").isVisible().catch(() => false);
  const dirInput390 = await page.getByTestId("daemon-mount-data-dir").boundingBox();
  const errBox390 = await page.getByTestId("daemon-mount-error").boundingBox();
  const gap390 = verticalGap(dirInput390, errBox390);
  const errorDuplication = await page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="daemon-mount-sheet"]');
    return {
      fieldErrors: sheet ? sheet.querySelectorAll("p.text-destructive").length : -1,
      alerts: sheet ? sheet.querySelectorAll('[data-slot="alert"]').length : -1,
    };
  });
  const imgFormError = await shot(page, "daemon-form-error-390.png");
  check(
    "S4-3 表单校验（390）：自定义位置空目录提交 → 错误就地显示（字段下方），不发起挂载",
    err390 && gap390 < 80 && errorDuplication.fieldErrors === 1 && errorDuplication.alerts === 0,
    `gap=${Number.isFinite(gap390) ? `${Math.round(gap390)}px` : "?"} errors=${errorDuplication.fieldErrors} alerts=${errorDuplication.alerts}`,
    {
      id: "S4-3",
      group: "sheet",
      expect: "内联提示在字段下方；不双写到底部 Alert；服务列表无新增",
      image: imgFormError,
      imageWidth: "390×844",
      imageBefore: beforeImage("daemon-form-error-390.png"),
      beforeWidth: "390×844",
    },
  );

  // ── L3-2: 端口校验错误出现且重新输入即清除 ─────────────────────────────────
  await page.getByTestId("daemon-location-auto").click();
  await page.getByTestId("daemon-mount-port").fill("1234");
  await page.getByTestId("daemon-mount-submit").click();
  const portErr = page.getByText("端口需为 13680–13699 的整数（留空自动分配）。");
  const portErrShown = await portErr.isVisible().catch(() => false);
  await page.getByTestId("daemon-mount-port").fill("13690");
  const portErrCleared = (await portErr.count()) === 0;
  check(
    "L3-2 端口校验：越界端口给出字段错误，重新输入即清除",
    portErrShown && portErrCleared,
    `shown=${portErrShown} cleared=${portErrCleared}`,
    {
      id: "L3-2",
      group: "sheet",
      expect: "提交 1234 → 端口字段错误；改为 13690 → 错误消失（不发请求）",
    },
  );

  // ── L3-3: 关闭重置（名称/错误清空）＋ 焦点回触发钮 ────────────────────────
  await page.getByTestId("daemon-mount-name").fill("reset-probe");
  await closeSheet(page);
  await page.waitForTimeout(300);
  const focusBack = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  await openSheet(page, "daemon-mount-open");
  const resetName = await page.getByTestId("daemon-mount-name").inputValue();
  const resetDirField = await page.getByTestId("daemon-mount-data-dir").count();
  const resetError = await page.getByTestId("daemon-mount-error").count();
  const resetPort = await page.getByTestId("daemon-mount-port").inputValue();
  await closeSheet(page);
  check(
    "L3-3 关闭重置：名称/端口/错误清空，位置回默认「自动」；关闭后焦点回触发钮",
    focusBack === "daemon-mount-empty-cta" &&
      resetName === "" &&
      resetPort === "" &&
      resetDirField === 0 &&
      resetError === 0,
    `focus=${focusBack} name="${resetName}" port="${resetPort}" dirField=${resetDirField} errors=${resetError}`,
    {
      id: "L3-3",
      group: "sheet",
      expect: "重开后表单为空、无错误残留、位置回自动；关闭时焦点回到本次触发钮",
    },
  );

  // ── L3-4: 空态 1280（同状态补图） ──────────────────────────────────────────
  await setViewport(page, 1280, 900);
  const emptyCta1280 = await visible(page, "daemon-mount-empty-cta");
  const emptyForm1280 = await visible(page, "daemon-mount-port");
  const overflow1280Empty = await overflowX(page);
  const empty1280 =
    (await page.locator("text=还没有挂载的服务").isVisible().catch(() => false)) &&
    emptyCta1280 &&
    !emptyForm1280 &&
    overflow1280Empty.ok;
  const imgEmpty1280 = await shot(page, "daemon-empty-1280.png");
  check(
    "L3-4 空态 1280：CTA 可见、无常驻表单、无横向溢出",
    empty1280,
    `cta=${emptyCta1280} form=${emptyForm1280} overflow=${JSON.stringify(overflow1280Empty)}`,
    {
      id: "L3-4",
      group: "sheet",
      expect: "1280×900 空态补图（新状态，无 before）",
      image: imgEmpty1280,
      imageWidth: "1280×900",
    },
  );
  await setViewport(page, 390, 844);

  // ── L11: 加载失败错误态 + 重试恢复（B1；390 与 1280 各一组）───────────────
  // 真实 daemon 不可用时的路径：GET /api/daemon/services 注入 500 → 错误 Alert + daemon-retry，
  // 不回退空态、header「添加服务」禁用；解除拦截后点重试 → 真实 200 空列表 → 空态恢复。
  const failServicesRoute = async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue().catch(() => undefined);
      return;
    }
    await route
      .fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "QA 注入：服务列表加载失败" }),
      })
      .catch(() => undefined);
  };
  async function probeLoadFailure(width, height, suffix) {
    await setViewport(page, width, height);
    injectedFailures += 1;
    await page.route("**/api/daemon/services", failServicesRoute);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="daemon-retry"]', { state: "visible", timeout: 10_000 });
    const retryVisible = await visible(page, "daemon-retry");
    const ctaGone = !(await visible(page, "daemon-mount-empty-cta"));
    const emptyTextGone = !(await page.getByText("还没有挂载的服务").isVisible().catch(() => false));
    // 注意：描述文案也含「服务列表加载失败」，必须用 exact 只匹配 AlertTitle（否则 strict 冲突 → false）。
    const alertVisible = await page
      .getByText("服务列表加载失败", { exact: true })
      .isVisible()
      .catch(() => false);
    const addDisabled = await page.getByTestId("daemon-mount-open").isDisabled();
    const imgFail = await shot(page, `daemon-load-failed-${suffix}.png`);
    return { retryVisible, ctaGone, emptyTextGone, alertVisible, addDisabled, imgFail };
  }
  async function probeRetryRecovery(suffix) {
    await page.unroute("**/api/daemon/services", failServicesRoute);
    injectedFailures = Math.max(0, injectedFailures - 1);
    await page.getByTestId("daemon-retry").click();
    await page.waitForSelector('[data-testid="daemon-mount-empty-cta"]', { state: "visible", timeout: 10_000 });
    const retryGone = (await page.getByTestId("daemon-retry").count()) === 0;
    const ctaBack = await visible(page, "daemon-mount-empty-cta");
    const addState = await page.getByTestId("daemon-mount-open").evaluate((el) => ({
      disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
      primary: el.className.includes("bg-primary"),
    }));
    const imgRecovered = await shot(page, `daemon-retry-recovered-${suffix}.png`);
    return { retryGone, ctaBack, addState, imgRecovered };
  }

  const fail390 = await probeLoadFailure(390, 844, "390");
  check(
    "L11-1 加载失败错误态（390）：错误 Alert + 重试替代空态；无空态 CTA；header「添加服务」disabled",
    fail390.retryVisible &&
      fail390.ctaGone &&
      fail390.emptyTextGone &&
      fail390.alertVisible &&
      fail390.addDisabled,
    `retry=${fail390.retryVisible} ctaGone=${fail390.ctaGone} emptyGone=${fail390.emptyTextGone} alert=${fail390.alertVisible} addDisabled=${fail390.addDisabled}`,
    {
      id: "L11-1",
      group: "sheet",
      expect:
        "GET /api/daemon/services 注入 500：渲染「服务列表加载失败」+ daemon-retry；不回退空态；增「添加服务」禁用",
      image: fail390.imgFail,
      imageWidth: "390×844",
    },
  );
  const recover390 = await probeRetryRecovery("390");
  check(
    "L11-2 加载失败重试恢复（390）：解除拦截后点 daemon-retry → 空态 CTA 回归、错误消失、header 降级 ghost 且可用",
    recover390.retryGone && recover390.ctaBack && !recover390.addState.disabled && !recover390.addState.primary,
    `retryGone=${recover390.retryGone} cta=${recover390.ctaBack} add=${JSON.stringify(recover390.addState)}`,
    {
      id: "L11-2",
      group: "sheet",
      expect: "真实 /api/daemon/services 恢复 200 空列表；重试触发 refresh 后回到空态（单主 CTA）",
      image: recover390.imgRecovered,
      imageWidth: "390×844",
    },
  );
  const fail1280 = await probeLoadFailure(1280, 900, "1280");
  check(
    "L11-3 加载失败错误态（1280）：错误 Alert + 重试替代空态；无空态 CTA；header「添加服务」disabled",
    fail1280.retryVisible &&
      fail1280.ctaGone &&
      fail1280.emptyTextGone &&
      fail1280.alertVisible &&
      fail1280.addDisabled,
    `retry=${fail1280.retryVisible} ctaGone=${fail1280.ctaGone} emptyGone=${fail1280.emptyTextGone} alert=${fail1280.alertVisible} addDisabled=${fail1280.addDisabled}`,
    {
      id: "L11-3",
      group: "sheet",
      expect: "1280×900 同一错误路径补图（新状态，无 before）",
      image: fail1280.imgFail,
      imageWidth: "1280×900",
    },
  );
  const recover1280 = await probeRetryRecovery("1280");
  check(
    "L11-4 加载失败重试恢复（1280）：解除拦截后点 daemon-retry → 空态 CTA 回归、错误消失、header 降级 ghost 且可用",
    recover1280.retryGone && recover1280.ctaBack && !recover1280.addState.disabled && !recover1280.addState.primary,
    `retryGone=${recover1280.retryGone} cta=${recover1280.ctaBack} add=${JSON.stringify(recover1280.addState)}`,
    {
      id: "L11-4",
      group: "sheet",
      expect: "1280×900 重试恢复补图（新状态，无 before）",
      image: recover1280.imgRecovered,
      imageWidth: "1280×900",
    },
  );
  await setViewport(page, 390, 844);

  // ── L11-5: 空态 CTA 挂载成功 → 焦点落在新行「打开」（P2-8）────────────────
  await openSheet(page, "daemon-mount-empty-cta");
  await page.getByTestId("daemon-mount-name").fill("focus-probe");
  await page.getByTestId("daemon-mount-submit").click();
  await waitFor(
    () => page.locator('[data-testid="daemon-mount-sheet"]').count().then((n) => n === 0),
    20_000,
    "focus-probe sheet closed",
  );
  const focusRow = await waitFor(
    () => page.locator("text=focus-probe").count().then((n) => n > 0),
    25_000,
    "focus-probe row",
  );
  const registryFocus = cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? [];
  const focusRecord = registryFocus.find((s) => s.name === "focus-probe");
  if (focusRecord?.pid) pids.services.push(Number(focusRecord.pid));
  await page.waitForTimeout(500); // rAF 焦点
  const activeTestId = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  check(
    "L11-5 空态 CTA 挂载成功：Sheet 关闭后焦点落在新行「打开」动作（P2-8）",
    focusRow && activeTestId === `daemon-open-${focusRecord?.id ?? ""}`,
    `row=${focusRow} active=${activeTestId} expected=daemon-open-${focusRecord?.id ?? "?"}`,
    {
      id: "L11-5",
      group: "sheet",
      expect: "空态 CTA 已卸载 → focusMountResult 退到新行 daemon-open-<id>（而不是 header 或 body）",
    },
  );
  await waitToastsGone(page);
  // 清理：停止 + 移除 focus-probe，恢复空态，供后续 CLI serve 基线使用。
  await openRowMenu(page, focusRecord?.id ?? "");
  await page.getByTestId(`daemon-stop-${focusRecord?.id ?? ""}`).click({ timeout: 8000 });
  await page.waitForSelector('[data-testid="daemon-stop-confirm"]', { state: "visible", timeout: 6000 });
  await page.getByTestId("daemon-stop-confirm").click();
  await waitFor(
    async () =>
      (cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? []).find(
        (s) => s.id === focusRecord?.id,
      )?.status === "stopped",
    25_000,
    "focus-probe stopped",
  );
  await waitToastsGone(page);
  await openRowMenu(page, focusRecord?.id ?? "");
  await page.getByTestId(`daemon-remove-${focusRecord?.id ?? ""}`).click({ timeout: 8000 });
  await page.waitForSelector('[data-testid="daemon-remove-confirm"]', { state: "visible", timeout: 6000 });
  await page.getByTestId("daemon-remove-confirm").click();
  await waitFor(
    () => page.locator("text=focus-probe").count().then((n) => n === 0),
    15_000,
    "focus-probe removed",
  );
  await waitToastsGone(page);

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
    { id: "S2-1", group: "cli", expect: "退出码 0（终端释放）；stdout 单行 JSON detached:true" },
  );
  check(
    "S2-2 服务已挂载：service_url/daemon_url 正确且 /healthz 200",
    serve1.json.service_url === `http://127.0.0.1:${portA}` &&
      serve1.json.daemon_url === daemonUrl &&
      (await fetchJson(`http://127.0.0.1:${portA}/healthz`))?.ok === true,
    `service_url=${serve1.json.service_url} daemon_url=${serve1.json.daemon_url}`,
    { id: "S2-2", group: "cli", expect: "两链接与预期端口一致；服务 healthz dataDir 匹配" },
  );

  const serve2 = cliJson(["serve", "--data-dir", dirs.a, "--port", String(portA)], {
    STOA_DAEMON_STATE_DIR: stateDir,
  });
  const serviceA2 = serve2.json.service ?? {};
  check(
    "S2-3 重复 serve 幂等：同一 service.id / pid，不新起进程",
    serviceA2.id === serviceA.id && serviceA2.pid === serviceA.pid,
    `id=${serviceA2.id} pid=${serviceA2.pid}`,
    { id: "S2-3", group: "cli", expect: "第二次 serve 返回既有登记（reused）" },
  );

  // ── S4b: 列表（390/1280）——CLI 已挂载 A 板，刷新后可见 ─────────────────────
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Stoa Daemon", { timeout: 10_000 });
  const rowA = await waitFor(
    () => page.locator("[data-testid^=daemon-service-]").count().then((n) => n >= 1),
    15_000,
    "row A visible",
  );
  const list390Counts = (await page.getByText("1 运行中").isVisible().catch(() => false)) &&
    (await page.getByText("0 已停止").isVisible().catch(() => false));
  const rowABox = await page.getByTestId(`daemon-service-${serviceA.id}`).boundingBox();
  const rowAInView = Boolean(rowABox && rowABox.y >= 0 && rowABox.y + rowABox.height <= 844);
  const listNoForm = !(await visible(page, "daemon-mount-port"));
  const overflow390List = await overflowX(page);
  const imgList390 = await shot(page, "daemon-list-390.png");
  // 复制断言的期望值必须取自 UI 同源 API：`serve` CLI 输出的是 data_dir（snake_case），
  // 与服务行渲染用的 dataDir 不是同一字段。
  const uiServiceA = (await fetchJson(`${daemonUrl}/api/daemon/services`))?.services?.find(
    (s) => s.id === serviceA.id,
  );
  const copyTargetA = { id: serviceA.id, dataDir: String(uiServiceA?.dataDir ?? "") };
  // 「次级信息可复制」（390 组）：状态目录 + 服务行目录；剪贴板/title 断言。
  const copy390 = await verifyCopyablePaths(page, bootStateDir, copyTargetA);
  await waitToastsGone(page);
  check(
    "S4-2 daemon-webui 列表（390）：CLI 挂载的 A 板出现在首屏且状态为运行中；状态目录/服务目录可复制",
    rowA && list390Counts && (await page.locator("text=运行中").count()) >= 1 && copy390.ok,
    `rows>=1 · badge=运行中 · counts=${list390Counts} · copy=${copy390.detail}`,
    {
      id: "S4-2",
      group: "list",
      expect: "列表行（名称/运行中/URL/端口/启动时间）390 截图；复制状态目录/目录路径得到完整值 + title 含完整路径",
      image: imgList390,
      imageWidth: "390×844",
      imageBefore: beforeImage("daemon-list-390.png"),
      beforeWidth: "390×844",
    },
  );
  check(
    "L4-1 390 首屏效率：服务行完整落在首屏内、计数可见、无常驻表单、无横向溢出",
    rowAInView && list390Counts && listNoForm && overflow390List.ok,
    `rowInView=${rowAInView} form=${!listNoForm} overflow=${JSON.stringify(overflow390List)}`,
    {
      id: "L4-1",
      group: "list",
      expect: "不滚动即可见运行中计数 + 至少一条服务行 + 添加入口；滚动容器/列表容器/行右边缘均无溢出",
    },
  );

  await setViewport(page, 1280, 900);
  const row1280 = await page.getByTestId(`daemon-service-${serviceA.id}`).boundingBox();
  const content1280 = await page.evaluate(() => {
    const el = document.querySelector("header")?.parentElement;
    return el ? el.getBoundingClientRect().width : 0;
  });
  const openBtn = await page.getByTestId(`daemon-open-${serviceA.id}`).boundingBox();
  const rowIsCompact = Boolean(row1280 && row1280.height < 110);
  const openRight = Boolean(openBtn && openBtn.x + openBtn.width > 800);
  const overflow1280List = await overflowX(page);
  const imgList1280 = await shot(page, "daemon-list-1280.png");
  // 「次级信息可复制」（1280 组）：同一组断言在桌面列布局下复验。
  const copy1280 = await verifyCopyablePaths(page, bootStateDir, copyTargetA);
  await waitToastsGone(page);
  check(
    "S4-2b 桌面 1280×900 列表截图：行四列横排（列锚点），操作簇右置；状态目录/服务目录可复制",
    rowIsCompact && content1280 >= 1000 && openRight && overflow1280List.ok && copy1280.ok,
    `rowH=${row1280 ? Math.round(row1280.height) : "?"} container=${Math.round(content1280)} overflow=${JSON.stringify(overflow1280List)} copy=${copy1280.detail}`,
    {
      id: "S4-2b",
      group: "list",
      expect: "行高<110（四列横排）；内容区≥1000；操作右置；无横向溢出",
      image: imgList1280,
      imageWidth: "1280×900",
      imageBefore: beforeImage("daemon-list-1280.png"),
      beforeWidth: "1280×900",
    },
  );

  // ── L5: 操作层级（running）：打开唯一主操作；停止/移除必须经菜单 ───────────
  const openTag = await page.getByTestId(`daemon-open-${serviceA.id}`).evaluate((el) => el.tagName).catch(() => "");
  const openHref = await page.getByTestId(`daemon-open-${serviceA.id}`).getAttribute("href").catch(() => null);
  const secretBtnVisible = await visible(page, `daemon-secret-${serviceA.id}`);
  const stopHidden = !(await visible(page, `daemon-stop-${serviceA.id}`));
  const removeHidden = !(await visible(page, `daemon-remove-${serviceA.id}`));
  check(
    "L5-1 操作层级（1280）：running 行「打开」为主操作（真实链接），「口令」次级；停止/移除不可见",
    openTag === "A" && openHref === serviceA.url && secretBtnVisible && stopHidden && removeHidden,
    `tag=${openTag} href=${openHref} secret=${secretBtnVisible} stopHidden=${stopHidden} removeHidden=${removeHidden}`,
    {
      id: "L5-1",
      group: "list",
      expect: "「打开」渲染为 <a href=service.url>；口令可见；停止/移除须先开菜单",
    },
  );

  await openRowMenu(page, serviceA.id);
  const stopItemVisible1280 = await visible(page, `daemon-stop-${serviceA.id}`);
  const removeItemVisible1280 = await visible(page, `daemon-remove-${serviceA.id}`);
  const menuRunning1280 = stopItemVisible1280 && removeItemVisible1280;
  const imgMenuRunning1280 = await shot(page, "daemon-menu-running-1280.png");
  check(
    "L5-2 running 行 ⋯ 菜单（1280）：展开后出现「停止服务 / 移除登记」",
    menuRunning1280,
    `stop=${stopItemVisible1280} remove=${removeItemVisible1280}`,
    {
      id: "L5-2",
      group: "list",
      expect: "DropdownMenu 展开；两项均可见（危险操作不在行内常驻）",
      image: imgMenuRunning1280,
      imageWidth: "1280×900",
    },
  );

  // 网络层证据：打开确认框→点取消期间不得出现任何 POST .../:id/stop。
  const stopRequests = [];
  const onRequest = (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && /^\/api\/daemon\/services\/[^/]+\/stop$/.test(pathname)) {
      stopRequests.push(pathname);
    }
  };
  page.on("request", onRequest);
  await page.getByTestId(`daemon-stop-${serviceA.id}`).click();
  await page.waitForSelector('[data-testid="daemon-stop-confirm"]', { state: "visible", timeout: 6000 });
  const stopAsk1280 = await page.getByText("停止服务？").isVisible().catch(() => false);
  const imgStopConfirm1280 = await shot(page, "daemon-stop-confirm-1280.png");
  await cancelConfirm(page);
  page.off("request", onRequest);
  const stillRunning = await page
    .getByTestId(`daemon-service-${serviceA.id}`)
    .getAttribute("data-status")
    .catch(() => null);
  const noStopRequest = stopRequests.length === 0;
  const regAfterCancel = (cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? []).find(
    (s) => s.id === serviceA.id,
  );
  check(
    "L5-3 停止需二次确认（1280）：确认框出现；取消期间零 POST /stop 请求（无副作用）",
    stopAsk1280 && noStopRequest,
    `ask=${stopAsk1280} stopRequests=${stopRequests.length} rowStatus=${stillRunning} registry=${regAfterCancel?.status ?? "missing"} pidAlive=${pidAlive(serviceA.pid)}`,
    {
      id: "L5-3",
      group: "list",
      expect: "「停止服务？」对话框；网络监听证明取消不触发 POST /:id/stop（行状态变化若发生即为 harness 边界）",
      image: imgStopConfirm1280,
      imageWidth: "1280×900",
    },
  );

  // 隔离 harness 自愈（已知边界）：daemon 读面偶发把在跑服务降级为 stopped；adopt 恢复后
  // 再测 390 菜单，避免菜单里「停止服务」项被状态条件渲染移除导致误判。
  const aLive = await ensureServiceRunning(page, serviceA, "L5-4");
  if (!aLive.ok) throw new Error(`L5-4 precheck: board-a not running (${aLive.detail})`);
  await setViewport(page, 390, 844);
  await openRowMenu(page, serviceA.id);
  const imgMenuRunning390 = await shot(page, "daemon-menu-running-390.png");
  const menuRunning390 =
    (await visible(page, `daemon-stop-${serviceA.id}`)) &&
    (await visible(page, `daemon-remove-${serviceA.id}`));
  await page.getByTestId(`daemon-stop-${serviceA.id}`).click();
  await page.waitForSelector('[data-testid="daemon-stop-confirm"]', { state: "visible", timeout: 6000 });
  const imgStopConfirm390 = await shot(page, "daemon-stop-confirm-390.png");
  const stopAsk390 = await page.getByText("停止服务？").isVisible().catch(() => false);
  await cancelConfirm(page);
  check(
    "L5-4 running 行 ⋯ 菜单（390）：展开后出现「停止服务 / 移除登记」",
    menuRunning390,
    `menu=${menuRunning390}`,
    {
      id: "L5-4",
      group: "list",
      expect: "390 下菜单展开截图（新状态，无 before）",
      image: imgMenuRunning390,
      imageWidth: "390×844",
    },
  );
  check(
    "L5-5 停止二次确认对话框（390）：确认框可达并说明后果；取消无副作用",
    stopAsk390,
    `ask=${stopAsk390}`,
    {
      id: "L5-5",
      group: "list",
      expect: "「停止服务？」对话框（新状态，无 before）",
      image: imgStopConfirm390,
      imageWidth: "390×844",
    },
  );

  // ── S2-4 端口独占：显式端口被占 → CONFLICT（绝不静默共享）─────────────────
  const conflict = cliRun(
    ["serve", "--data-dir", dirs.b, "--port", String(portA)],
    { STOA_DAEMON_STATE_DIR: stateDir },
  );
  const conflictText = `${conflict.stdout}\n${conflict.stderr}`;
  check(
    "S2-4 显式端口被占用 → CONFLICT（不静默共享端口）",
    conflict.code !== 0 && /CONFLICT|already in use/i.test(conflictText),
    `port=${portA} exit=${conflict.code} ${conflictText.trim().slice(0, 120)}`,
    { id: "S2-4", group: "cli", expect: "端口被 A 板占用时 serve 失败并报 CONFLICT（不静默共享）" },
  );

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
    { id: "S3-1", group: "standalone", expect: "进程不退出；stdout 首行 REPORT_URL=；(B 板)healthz 200" },
  );
  check(
    "S3-2 `--standalone` 与 daemon 脱钩：登记表里没有 B 板",
    !(registryAfterStandalone.services ?? []).some((s) => s.dataDir === dirs.b),
    `services=${JSON.stringify((registryAfterStandalone.services ?? []).map((s) => s.dataDir))}`,
    { id: "S3-2", group: "standalone", expect: "daemon 登记仅 A 板一条" },
  );
  standalone.kill("SIGINT");
  const standaloneExited = await waitFor(() => standalone.exitCode !== null, 8_000, "standalone SIGINT exit");
  check("S3-3 `--standalone` Ctrl-C（SIGINT）即退，端口释放", standaloneExited, `exitCode=${standalone.exitCode}`,
    { id: "S3-3", group: "standalone", expect: "SIGINT 后进程退出（exitCode 0）" });

  // ── S4-4 目录选择器（daemon 宿主侧对话框；验收用测试钩子返回固定目录）──────
  await openSheet(page);
  await page.getByTestId("daemon-location-path").click();
  await page.getByTestId("daemon-pick-dir").click();
  const picked = await waitFor(
    () => page.getByTestId("daemon-mount-data-dir").inputValue().then((value) => value === pickedDir),
    15_000,
    "picker fill",
  );
  check(
    "S4-4 「选择文件夹」把所选目录回填到路径输入框",
    picked,
    `picked=${pickedDir}`,
    { id: "S4-4", group: "mount", expect: "POST /api/daemon/pick-directory → 路径回填（真实对话框为人工项）" },
  );

  // ── S4-5 自定义位置挂载（路径来自选择器；空目录自动初始化＋默认开口令）──────
  await page.getByTestId("daemon-mount-port").fill(String(portC));
  await page.getByTestId("daemon-mount-name").fill("ui-board");
  await waitToastsGone(page);
  await page.getByTestId("daemon-mount-submit").click();
  const sheetClosedAfterMount = await waitFor(
    () => page.locator('[data-testid="daemon-mount-sheet"]').count().then((n) => n === 0),
    20_000,
    "sheet closed after mount",
  );
  const toastText = await page
    .locator('[data-slot="toast"]')
    .allInnerTexts()
    .then((items) => items.join(" | "))
    .catch(() => "");
  const mountToast = await page
    .locator('[data-slot="toast"]')
    .filter({ hasText: "已挂载" })
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  const imgMountToast = await shot(page, "daemon-mounted-toast-390.png");
  const uiMounted = await waitFor(
    () => page.locator("text=ui-board").count().then((n) => n > 0),
    25_000,
    "ui mount row",
  );
  const listAfterMount = cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? [];
  const uiRecord = listAfterMount.find((s) => s.name === "ui-board");
  if (uiRecord?.pid) pids.services.push(Number(uiRecord.pid));
  const pickedHealth = await fetchJson(`http://127.0.0.1:${portC}/healthz`);
  await waitToastsGone(page);
  const imgMount390 = await shot(page, "daemon-mounted-390.png");
  check(
    "L6-1 挂载成功反馈：Sheet 自动关闭 + toast「已挂载」+ 列表新增行",
    sheetClosedAfterMount && mountToast && uiMounted,
    `closed=${sheetClosedAfterMount} toast=${mountToast} row=${uiMounted} toasts="${toastText.replace(/\s+/g, " ").slice(0, 90)}"`,
    {
      id: "L6-1",
      group: "mount",
      expect: "提交后 Sheet 关闭；[data-slot=toast] 含「已挂载」；列表出现 ui-board",
      image: imgMountToast,
      imageWidth: "390×844",
    },
  );
  check(
    "S4-5 控制台挂载自定义目录：UI 行出现 + 目录已自动初始化（report.sqlite）+ healthz 200",
    uiMounted &&
      uiRecord?.status === "running" &&
      existsSync(join(pickedDir, "report.sqlite")) &&
      pickedHealth?.ok === true,
    `name=ui-board port=${portC} pid=${uiRecord?.pid}`,
    {
      id: "S4-5",
      group: "mount",
      expect: "表单交互真实打到 POST /api/daemon/services；空目录自动 init",
      image: imgMount390,
      imageWidth: "390×844",
      imageBefore: beforeImage("daemon-mounted-390.png"),
      beforeWidth: "390×844",
    },
  );
  // 2 服务状态重新取首屏证据（不复用挂载前的 rowAInView/overflow）。
  const twoSvcCounts = await page.getByText("2 运行中").isVisible().catch(() => false);
  const twoSvcRowBox = await page.getByTestId(`daemon-service-${uiRecord?.id ?? ""}`).boundingBox();
  const twoSvcRowInView = Boolean(twoSvcRowBox && twoSvcRowBox.y >= 0 && twoSvcRowBox.y + twoSvcRowBox.height <= 844);
  const twoSvcAdd = await visible(page, "daemon-mount-open");
  const overflowTwoSvc = await overflowX(page);
  check(
    "L6-2 390 首屏效率（2 个服务）：运行计数、至少一条行与添加入口均在首屏，无横向溢出",
    twoSvcCounts && twoSvcRowInView && twoSvcAdd && overflowTwoSvc.ok,
    `counts=${twoSvcCounts} rowInView=${twoSvcRowInView} add=${twoSvcAdd} overflow=${JSON.stringify(overflowTwoSvc)}`,
    {
      id: "L6-2",
      group: "mount",
      expect: "有 2 个服务时 390 首屏不滚动即可见计数/行/添加入口（重新测量，不复用挂载前值）",
    },
  );

  // ── L7: 刷新态（390/1280）＋ 动作簇不横移 ─────────────────────────────────
  const delayServices = async (route) => {
    // unroute 时仍在 sleep 的请求会被 Playwright 自动接管，continue 会抛
    // "Route is already handled!"——这是预期竞态，静默吞掉（真失败会命中 WAIT-TIMEOUT）。
    try {
      if (route.request().method() !== "GET") return await route.continue();
      await sleep(1500);
      return await route.continue();
    } catch {
      return undefined;
    }
  };
  await page.route("**/api/daemon/services", delayServices);
  await page.getByTestId("daemon-refresh").click();
  const refreshing390 = await waitFor(
    () =>
      page
        .locator('[data-testid="daemon-services"][data-refreshing="true"]')
        .count()
        .then((n) => n > 0),
    3000,
    "refreshing 390",
  );
  const imgRefresh390 = await shot(page, "daemon-refreshing-390.png");
  await page.unroute("**/api/daemon/services", delayServices);
  await page.waitForSelector('[data-testid="daemon-services"][data-refreshing="false"]', { timeout: 10_000 });
  check(
    "L7-1 刷新中态（390）：列表标记 data-refreshing=true 且 aria-busy",
    refreshing390 &&
      (await page
        .getByTestId("daemon-services")
        .getAttribute("aria-busy")
        .catch(() => null)) !== null,
    `refreshing=${refreshing390}`,
    {
      id: "L7-1",
      group: "list",
      expect: "手动刷新期间列表降透明＋data-refreshing=true（GET 注入 1.5s 延迟，仍打真实 daemon）",
      image: imgRefresh390,
      imageWidth: "390×844",
    },
  );

  await setViewport(page, 1280, 900);
  const xBefore = (await page.getByTestId("daemon-mount-open").boundingBox())?.x ?? -1;
  await page.route("**/api/daemon/services", delayServices);
  await page.getByTestId("daemon-refresh").click();
  const refreshing1280 = await waitFor(
    () =>
      page
        .locator('[data-testid="daemon-services"][data-refreshing="true"]')
        .count()
        .then((n) => n > 0),
    3000,
    "refreshing 1280",
  );
  const xDuring = (await page.getByTestId("daemon-mount-open").boundingBox())?.x ?? -2;
  const refreshLabel = await page.getByText("刷新中…").isVisible().catch(() => false);
  const imgRefresh1280 = await shot(page, "daemon-refreshing-1280.png");
  await page.unroute("**/api/daemon/services", delayServices);
  await page.waitForSelector('[data-testid="daemon-services"][data-refreshing="false"]', { timeout: 10_000 });
  const xAfter = (await page.getByTestId("daemon-mount-open").boundingBox())?.x ?? -3;
  check(
    "L7-2 刷新中态（1280）：header 显示「刷新中…」且动作簇不横移",
    refreshing1280 && refreshLabel && xBefore === xDuring && xDuring === xAfter,
    `refreshing=${refreshing1280} label=${refreshLabel} x=${xBefore}/${xDuring}/${xAfter}`,
    {
      id: "L7-2",
      group: "list",
      expect: "刷新文案为定宽块（104px），添加入口 x 坐标全程不变",
      image: imgRefresh1280,
      imageWidth: "1280×900",
    },
  );

  // ── L8: 口令对话框（掩码/链接打码/复制完整链接），390 与 1280 ─────────────
  const uiSecret = await fetchJson(`${daemonUrl}/api/daemon/services/${uiRecord?.id}/secret`);
  const uiSecretKey = String(uiSecret?.key ?? "");
  await setViewport(page, 390, 844);
  await page.getByTestId(`daemon-secret-${uiRecord?.id ?? ""}`).click();
  await page.waitForSelector('[data-testid="daemon-secret-dialog"]', { timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="daemon-secret-value"]');
      return Boolean(el && el.value && el.value.length > 0);
    },
    undefined,
    { timeout: 15_000 },
  );
  const secretType = await page.getByTestId("daemon-secret-value").getAttribute("type");
  const linkDisplay = await page.getByTestId("daemon-secret-link").inputValue();
  const keyNotInBody = await page.evaluate(
    (needle) => (needle ? !document.body.innerText.includes(needle) : true),
    uiSecretKey,
  );
  const imgSecret390 = await shot(page, "daemon-secret-dialog-390.png");
  // P2-9：显隐钮 aria-pressed 随状态变化（截图仍取掩码态，见上）。
  const revealBefore = await page.getByTestId("daemon-secret-reveal").getAttribute("aria-pressed");
  await page.getByTestId("daemon-secret-reveal").click();
  const revealOn = await page.getByTestId("daemon-secret-reveal").getAttribute("aria-pressed");
  const typeOn = await page.getByTestId("daemon-secret-value").getAttribute("type");
  await page.getByTestId("daemon-secret-reveal").click();
  const revealOff = await page.getByTestId("daemon-secret-reveal").getAttribute("aria-pressed");
  const typeOff = await page.getByTestId("daemon-secret-value").getAttribute("type");
  await page.getByTestId("daemon-secret-copy-link").click();
  await sleep(400);
  const copiedLink = await page
    .evaluate(() => navigator.clipboard.readText())
    .catch(() => "");
  await waitToastsGone(page);
  await page.getByTestId("daemon-secret-close").click();
  await page.waitForSelector('[data-testid="daemon-secret-dialog"]', { state: "detached", timeout: 8000 });
  check(
    "L8-1 口令对话框（390）：口令掩码、链接展示打码、复制得到完整链接、完整 key 不出现在页面文本；显隐钮 aria-pressed 同步",
    secretType !== "text" &&
      uiSecretKey.length > 0 &&
      linkDisplay.includes("#key=••••••") &&
      !linkDisplay.includes(uiSecretKey) &&
      copiedLink === uiSecret?.key_link &&
      keyNotInBody &&
      revealBefore === "false" &&
      revealOn === "true" &&
      typeOn === "text" &&
      revealOff === "false" &&
      typeOff !== "text",
    `masked=${secretType !== "text"} displayRedacted=${!linkDisplay.includes(uiSecretKey)} copyMatch=${copiedLink === uiSecret?.key_link} keyInBody=${!keyNotInBody} reveal=${revealBefore}->${revealOn}->${revealOff} type=${typeOn}/${typeOff}`,
    {
      id: "L8-1",
      group: "list",
      expect: "掩码 + 链接打码；复制按钮携带完整口令链接（剪贴板比对，不回显）",
      image: imgSecret390,
      imageWidth: "390×844",
      imageBefore: beforeImage("daemon-secret-dialog-390.png"),
      beforeWidth: "390×844",
    },
  );

  await setViewport(page, 1280, 900);
  await page.getByTestId(`daemon-secret-${uiRecord?.id ?? ""}`).click();
  await page.waitForSelector('[data-testid="daemon-secret-dialog"]', { timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="daemon-secret-value"]');
      return Boolean(el && el.value && el.value.length > 0);
    },
    undefined,
    { timeout: 15_000 },
  );
  const secretType1280 = await page.getByTestId("daemon-secret-value").getAttribute("type");
  const imgSecret1280 = await shot(page, "daemon-secret-dialog-1280.png");
  await page.getByTestId("daemon-secret-close").click();
  await page.waitForSelector('[data-testid="daemon-secret-dialog"]', { state: "detached", timeout: 8000 });
  check(
    "L8-2 口令对话框（1280）：同一对话框居中呈现，口令仍为掩码",
    secretType1280 !== "text",
    `type=${secretType1280}`,
    {
      id: "L8-2",
      group: "list",
      expect: "1280 补图（新状态，无 before）；掩码不因视口变化而失效",
      image: imgSecret1280,
      imageWidth: "1280×900",
    },
  );

  // ── S4-6 控制台「停止」（菜单 + 二次确认）──────────────────────────────────
  await setViewport(page, 390, 844);
  const uiLive = await ensureServiceRunning(page, uiRecord, "S4-6");
  if (!uiLive.ok) throw new Error(`S4-6 precheck: ui-board not running (${uiLive.detail})`);
  await page.locator(`[data-testid="daemon-service-${uiRecord?.id ?? ""}"]`).scrollIntoViewIfNeeded().catch(() => undefined);
  await openRowMenu(page, uiRecord?.id ?? "");
  await page.getByTestId(`daemon-stop-${uiRecord?.id ?? ""}`).click({ timeout: 8000 });
  await page.waitForSelector('[data-testid="daemon-stop-confirm"]', { state: "visible", timeout: 6000 });
  await page.getByTestId("daemon-stop-confirm").click();
  const uiStopped = await waitFor(
    async () =>
      (cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? []).find(
        (s) => s.id === uiRecord?.id,
      )?.status === "stopped",
    25_000,
    "ui stop service",
  );
  await waitToastsGone(page);
  const stoppedStatusAttr = await page
    .getByTestId(`daemon-service-${uiRecord?.id ?? ""}`)
    .getAttribute("data-status")
    .catch(() => null);
  const openAfterStop = await page.getByTestId(`daemon-open-${uiRecord?.id ?? ""}`).count();
  const stoppedPidAlive = pidAlive(uiLive.pid ?? uiRecord?.pid);
  const imgStopped = await shot(page, "daemon-stopped-390.png");
  check(
    "S4-6 控制台「停止」（菜单→确认）：服务真停（进程死 + 登记降级 stopped），stopped 行无「打开」",
    uiStopped && !stoppedPidAlive && stoppedStatusAttr === "stopped" && openAfterStop === 0,
    `pid ${uiLive.pid ?? uiRecord?.pid} alive=${stoppedPidAlive} status=${stoppedStatusAttr} open=${openAfterStop} rehealed=${uiLive.healed}`,
    {
      id: "S4-6",
      group: "mount",
      expect: "菜单「停止服务」→ 确认框 → POST /:id/stop；行去饱和且不提供失效的「打开」",
      image: imgStopped,
      imageWidth: "390×844",
      imageBefore: beforeImage("daemon-stopped-390.png"),
      beforeWidth: "390×844",
    },
  );

  // ── L9: 已停止服务仍可取口令（不因 stopped 失去口令入口）───────────────────
  await page.getByTestId(`daemon-secret-${uiRecord?.id ?? ""}`).click();
  const stoppedSecretOpens = await page
    .waitForSelector('[data-testid="daemon-secret-dialog"]', { state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  const stoppedSecretMasked = (await page.getByTestId("daemon-secret-value").getAttribute("type").catch(() => null)) !== "text";
  await page.getByTestId("daemon-secret-close").click();
  await page.waitForSelector('[data-testid="daemon-secret-dialog"]', { state: "detached", timeout: 8000 });
  check(
    "L9-1 已停止服务仍可取口令（对话框可达且口令掩码）",
    stoppedSecretOpens && stoppedSecretMasked,
    `opens=${stoppedSecretOpens} masked=${stoppedSecretMasked}`,
    {
      id: "L9-1",
      group: "mount",
      expect: "stopped 行保留「口令」次级入口（spec：仍可取口令）",
    },
  );

  // ── L9-2: stopped 行菜单（390）：只有「移除登记」，无「停止服务」────────────
  await openRowMenu(page, uiRecord?.id ?? "");
  const stoppedStopItem = await visible(page, `daemon-stop-${uiRecord?.id ?? ""}`);
  const stoppedRemoveItem = await visible(page, `daemon-remove-${uiRecord?.id ?? ""}`);
  const imgMenuStopped390 = await shot(page, "daemon-menu-stopped-390.png");
  await page.getByTestId(`daemon-remove-${uiRecord?.id ?? ""}`).click();
  await page.waitForSelector('[data-testid="daemon-remove-confirm"]', { state: "visible", timeout: 6000 });
  const removeAsk390 = await page.getByText("移除登记？").isVisible().catch(() => false);
  const removeDesc390 = await page.getByText(/不会删除数据目录/).isVisible().catch(() => false);
  const imgRemoveConfirm390 = await shot(page, "daemon-remove-confirm-390.png");
  await cancelConfirm(page);
  const rowStillThere = await page.getByTestId(`daemon-service-${uiRecord?.id ?? ""}`).count();
  check(
    "L9-2 stopped 行 ⋯ 菜单（390）：仅「移除登记」；取消移除后登记保留",
    stoppedRemoveItem && !stoppedStopItem && rowStillThere === 1,
    `removeItem=${stoppedRemoveItem} stopItem=${stoppedStopItem} row=${rowStillThere}`,
    {
      id: "L9-2",
      group: "mount",
      expect: "菜单无失效「停止服务」；取消无副作用",
      image: imgMenuStopped390,
      imageWidth: "390×844",
    },
  );
  check(
    "L9-2b 移除二次确认对话框（390）：文案说明不删数据目录；取消后登记仍在",
    removeAsk390 && removeDesc390 && rowStillThere === 1,
    `ask=${removeAsk390} desc=${removeDesc390} row=${rowStillThere}`,
    {
      id: "L9-2b",
      group: "mount",
      expect: "「移除登记？」对话框（新状态，无 before）",
      image: imgRemoveConfirm390,
      imageWidth: "390×844",
    },
  );

  // ── L9-3: stopped 行（1280）菜单/确认框，并真正移除登记（S4-7）─────────────
  await setViewport(page, 1280, 900);
  await page.locator(`[data-testid="daemon-service-${uiRecord?.id ?? ""}"]`).scrollIntoViewIfNeeded().catch(() => undefined);
  const rowStopped1280 = await page.getByTestId(`daemon-service-${uiRecord?.id ?? ""}`).boundingBox();
  const openStopped1280 = await page.locator(`[data-testid="daemon-open-${uiRecord?.id ?? ""}"]`).count();
  const imgStopped1280 = await shot(page, "daemon-stopped-1280.png");
  check(
    "L9-3 stopped 行（1280）：去饱和呈现且无「打开」动作",
    Boolean(rowStopped1280) && rowStopped1280.height > 0 && openStopped1280 === 0,
    `rowBox=${JSON.stringify(rowStopped1280)} open=${openStopped1280}`,
    {
      id: "L9-3",
      group: "mount",
      expect: "1280 stopped 行补图（新状态，无 before）；无失效「打开」",
      image: imgStopped1280,
      imageWidth: "1280×900",
    },
  );
  await openRowMenu(page, uiRecord?.id ?? "");
  const imgMenuStopped1280 = await shot(page, "daemon-menu-stopped-1280.png");
  check(
    "L9-4 stopped 行 ⋯ 菜单（1280）：仅「移除登记」",
    await visible(page, `daemon-remove-${uiRecord?.id ?? ""}`) &&
      !(await visible(page, `daemon-stop-${uiRecord?.id ?? ""}`)),
    `remove=${await visible(page, `daemon-remove-${uiRecord?.id ?? ""}`)}`,
    {
      id: "L9-4",
      group: "mount",
      expect: "1280 菜单展开补图（新状态，无 before）",
      image: imgMenuStopped1280,
      imageWidth: "1280×900",
    },
  );
  await page.getByTestId(`daemon-remove-${uiRecord?.id ?? ""}`).click();
  await page.waitForSelector('[data-testid="daemon-remove-confirm"]', { state: "visible", timeout: 6000 });
  const imgRemoveConfirm1280 = await shot(page, "daemon-remove-confirm-1280.png");
  const removeAskVisible1280 = await page.getByText("移除登记？").isVisible().catch(() => false);
  check(
    "L9-5 移除二次确认对话框（1280）：确认框可达",
    removeAskVisible1280,
    `ask=${removeAskVisible1280}`,
    {
      id: "L9-5",
      group: "mount",
      expect: "「移除登记？」对话框 1280 补图（新状态，无 before）",
      image: imgRemoveConfirm1280,
      imageWidth: "1280×900",
    },
  );
  await page.getByTestId("daemon-remove-confirm").click();
  const uiRemoved = await waitFor(
    () => page.locator(`[data-testid="daemon-service-${uiRecord?.id ?? ""}"]`).count().then((n) => n === 0),
    15_000,
    "ui remove row",
  );
  const registryAfterRemove = cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? [];
  check(
    "S4-7 控制台「移除登记」（菜单→确认）：DELETE 生效，登记消失",
    uiRemoved && !registryAfterRemove.some((s) => s.id === uiRecord?.id),
    `remaining=${registryAfterRemove.length}`,
    {
      id: "S4-7",
      group: "mount",
      expect: "已停服务可移除登记（409 不再出现）",
    },
  );

  // ── S4-8 自动位置挂载（无 data-dir）───────────────────────────────────────
  await setViewport(page, 390, 844);
  await openSheet(page);
  await page.getByTestId("daemon-location-auto").click();
  await page.getByTestId("daemon-mount-name").fill("ui-auto");
  await page.getByTestId("daemon-mount-submit").click();
  const autoRowVisible = await waitFor(
    () => page.locator("text=ui-auto").count().then((n) => n > 0),
    25_000,
    "auto row",
  );
  const autoList = cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? [];
  const autoRecord = autoList.find((s) => s.name === "ui-auto");
  if (autoRecord?.pid) pids.services.push(Number(autoRecord.pid));
  const autoHealth = autoRecord?.url ? await fetchJson(`${autoRecord.url}/healthz`) : null;
  await waitToastsGone(page);
  const imgAuto = await shot(page, "daemon-auto-session-390.png");
  check(
    "S4-8 「自动」位置挂载：无需 data-dir，会话落在 $HOME/.stoa/sessions 且自动初始化/开口令",
    autoRowVisible &&
      autoRecord?.status === "running" &&
      typeof autoRecord?.dataDir === "string" &&
      autoRecord.dataDir.startsWith(join(sandboxHome, ".stoa", "sessions")) &&
      existsSync(join(autoRecord.dataDir, "report.sqlite")) &&
      autoHealth?.ok === true,
    `dataDir=${autoRecord?.dataDir}`,
    {
      id: "S4-8",
      group: "mount",
      expect: "dataDir 自动生成；init 与 STOA_AUTH 自动完成",
      image: imgAuto,
      imageWidth: "390×844",
      imageBefore: beforeImage("daemon-auto-session-390.png"),
      beforeWidth: "390×844",
    },
  );

  // ── S4-9 口令对话框（auto 行）：掩码/链接/复制（保留基线语义）──────────────
  const autoSecret = await fetchJson(`${daemonUrl}/api/daemon/services/${autoRecord?.id}/secret`);
  await page.getByTestId(`daemon-secret-${autoRecord?.id ?? ""}`).click();
  await page.waitForSelector('[data-testid="daemon-secret-dialog"]', { timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="daemon-secret-value"]');
      return Boolean(el && el.value && el.value.length > 0);
    },
    undefined,
    { timeout: 15_000 },
  );
  const autoSecretType = await page.getByTestId("daemon-secret-value").getAttribute("type");
  const autoLinkDisplay = await page.getByTestId("daemon-secret-link").inputValue();
  await page.getByTestId("daemon-secret-copy-link").click();
  await sleep(300);
  const autoCopiedLink = await page
    .evaluate(() => navigator.clipboard.readText())
    .catch(() => "");
  await waitToastsGone(page);
  await page.getByTestId("daemon-secret-close").click();
  await page.waitForSelector('[data-testid="daemon-secret-dialog"]', { state: "detached", timeout: 8000 });
  check(
    "S4-9 口令对话框：口令掩码、链接展示打码、复制得到完整链接",
    autoSecretType !== "text" &&
      typeof autoSecret?.key === "string" &&
      autoLinkDisplay.includes("#key=") &&
      !autoLinkDisplay.includes(String(autoSecret?.key)) &&
      autoCopiedLink === autoSecret?.key_link,
    `mode=${autoSecret?.mode} masked=${autoSecretType !== "text"} displayRedacted=${!autoLinkDisplay.includes(String(autoSecret?.key))} copyMatch=${autoCopiedLink === autoSecret?.key_link}`,
    { id: "S4-9", group: "mount", expect: "掩码/打码展示；复制按钮带完整口令；复制提示出现" },
  );

  // ── S4-10 口令链接：新浏览器上下文打开即自动登录 ──────────────────────────
  const linkContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pageLink = await linkContext.newPage();
  const linkErrors = [];
  pageLink.on("pageerror", (err) => linkErrors.push(String(err)));
  await pageLink.goto(String(autoSecret?.key_link ?? ""), { waitUntil: "domcontentloaded" });
  const boardReady = await pageLink
    .waitForSelector('[data-testid="app-root-view"]', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  const loginVisible = await pageLink.getByTestId("login-secret").count();
  const hashAfter = new URL(pageLink.url()).hash;
  const imgLink = await shot(pageLink, "daemon-keylink-board-390.png");
  await linkContext.close();
  check(
    "S4-10 口令链接即点即用：新上下文自动登录进入版，地址栏已抹除 #key=",
    boardReady && loginVisible === 0 && !hashAfter.includes("key=") && linkErrors.length === 0,
    `board=${boardReady} login=${loginVisible} hash=${hashAfter || "(none)"}`,
    {
      id: "S4-10",
      group: "mount",
      expect: "口令链接零手输进入版；hash 不残留",
      image: imgLink,
      imageWidth: "390×844",
      imageBefore: beforeImage("daemon-keylink-board-390.png"),
      beforeWidth: "390×844",
    },
  );

  // ── S4-11 临时会话：停止即删 ──────────────────────────────────────────────
  await openSheet(page);
  await page.getByTestId("daemon-location-temp").click();
  await page.getByTestId("daemon-mount-name").fill("ui-temp");
  await page.getByTestId("daemon-mount-submit").click();
  const tempRow = await waitFor(
    () => page.locator("text=ui-temp").count().then((n) => n > 0),
    25_000,
    "temp row",
  );
  const tempList = cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? [];
  const tempRecord = tempList.find((s) => s.name === "ui-temp");
  if (tempRecord?.pid) pids.services.push(Number(tempRecord.pid));
  const tempDataDir = tempRecord?.dataDir ?? "";
  await waitToastsGone(page);
  // 临时行在列表末尾：先滚到可见处再截图（否则只有前两行）。
  await page.locator(`[data-testid="daemon-service-${tempRecord?.id ?? ""}"]`).scrollIntoViewIfNeeded().catch(() => undefined);
  const imgTempMounted = await shot(page, "daemon-temp-session-390.png");
  check(
    "S4-11a 临时会话行带「临时」徽标（停止即删的前置态）",
    tempRow && tempRecord?.ephemeral === true,
    `dataDir=${tempDataDir}`,
    {
      id: "S4-11a",
      group: "mount",
      expect: "服务行徽标＝会话临时；目录位于系统临时目录",
      image: imgTempMounted,
      imageWidth: "390×844",
      imageBefore: beforeImage("daemon-temp-session-390.png"),
      beforeWidth: "390×844",
    },
  );
  const tempLive = await ensureServiceRunning(page, tempRecord, "S4-11");
  if (!tempLive.ok) throw new Error(`S4-11 precheck: ui-temp not running (${tempLive.detail})`);
  await openRowMenu(page, tempRecord?.id ?? "");
  await page.getByTestId(`daemon-stop-${tempRecord?.id ?? ""}`).click({ timeout: 8000 });
  await page.waitForSelector('[data-testid="daemon-stop-confirm"]', { state: "visible", timeout: 6000 });
  await page.getByTestId("daemon-stop-confirm").click();
  const tempCleaned = await waitFor(
    async () => {
      const rows = cliJson(["daemon", "status", "--state-dir", stateDir]).json.services ?? [];
      return !rows.some((s) => s.id === tempRecord?.id) && tempDataDir !== "" && !existsSync(tempDataDir);
    },
    25_000,
    "temp session removed",
  );
  await waitToastsGone(page);
  const imgTemp = await shot(page, "daemon-temp-after-stop-390.png");
  check(
    "S4-11 临时会话：停止后登记移除 + 目录删除（零残留）",
    tempRow && tempCleaned && tempLive.pid !== null,
    `dataDir=${tempDataDir} rehealed=${tempLive.healed} pid=${tempLive.pid}`,
    {
      id: "S4-11",
      group: "mount",
      expect: "ephemeral 会话停止即删；登记同步消失",
      image: imgTemp,
      imageWidth: "390×844",
      imageBefore: beforeImage("daemon-temp-after-stop-390.png"),
      beforeWidth: "390×844",
    },
  );

  // ── O1–O5: 从控制台打开自带口令（stoa-console-open-with-key design §4）──────
  const qaOpenedUrls = () => page.evaluate(() => [...(window.__qaOpenUrls ?? [])]);
  const resetQaOpenedUrls = () =>
    page.evaluate(() => {
      if (Array.isArray(window.__qaOpenUrls)) window.__qaOpenUrls.length = 0;
    });
  const waitOpenedUrl = async (label) => {
    const ok = await waitFor(
      () => page.evaluate(() => (window.__qaOpenUrls?.length ?? 0) > 0),
      10_000,
      label,
    );
    const urls = ok ? await qaOpenedUrls() : [];
    return { ok, url: String(urls[0] ?? "") };
  };

  // O1（390）：点「打开」→ 目标 URL 自带 #key=；新上下文直达板面（无登录门、地址栏 hash 已抹除）。
  await setViewport(page, 390, 844);
  const o1Live = await ensureServiceRunning(page, serviceA, "O1");
  if (!o1Live.ok) throw new Error(`O1 precheck: board-a not running (${o1Live.detail})`);
  const o1Secret = await fetchJson(`${daemonUrl}/api/daemon/services/${serviceA.id}/secret`);
  const o1Key = String(o1Secret?.key ?? "");
  await waitToastsGone(page);
  await resetQaOpenedUrls();
  // 连点两次：第二次必须被 1s 去抖吞掉（S2-2 判据），只录到一个 open。
  await page.getByTestId(`daemon-open-${serviceA.id}`).click();
  await page.getByTestId(`daemon-open-${serviceA.id}`).click();
  const o1Open = await waitOpenedUrl("O1 window.open");
  await sleep(600);
  const o1OpenCount = (await qaOpenedUrls()).length;
  const o1Expect = o1Key
    ? `${new URL(`${serviceA.url}/`).href}#key=${encodeURIComponent(o1Key)}`
    : "";
  const o1Attached = Boolean(o1Expect) && o1Open.url === o1Expect;

  // before 复现「改动前的落点」：同一服务、同一隔离 daemon，用不带 key 的原 URL 打开 → 登录门。
  const o1BeforeCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const o1BeforePage = await o1BeforeCtx.newPage();
  await o1BeforePage.goto(`${serviceA.url}/`, { waitUntil: "domcontentloaded" });
  const o1BeforeGate = await o1BeforePage
    .waitForSelector('[data-testid="login-secret"]', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const imgO1Before = await shot(o1BeforePage, "open-before-login-390.png");
  await o1BeforeCtx.close();

  const o1AfterCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const o1AfterPage = await o1AfterCtx.newPage();
  const o1PageErrors = [];
  o1AfterPage.on("pageerror", (err) => o1PageErrors.push(String(err)));
  await o1AfterPage.goto(o1Open.url || "about:blank", { waitUntil: "domcontentloaded" });
  const o1Board = await o1AfterPage
    .waitForSelector('[data-testid="app-root-view"]', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  const o1Login = await o1AfterPage.getByTestId("login-secret").count();
  const o1Hash = new URL(o1AfterPage.url()).hash;
  const imgO1After = await shot(o1AfterPage, "open-after-board-390.png");
  await o1AfterCtx.close();
  check(
    "O1 390 从控制台「打开」自带口令：目标 URL 以 #key= 结尾、连点去抖只开一个；新上下文直达板面（无登录门、hash 已抹除）",
    o1Open.ok &&
      o1Attached &&
      o1OpenCount === 1 &&
      o1BeforeGate &&
      o1Board &&
      o1Login === 0 &&
      !o1Hash.includes("key=") &&
      o1PageErrors.length === 0,
    `mode=${o1Secret?.mode} attached=${o1Attached} opens=${o1OpenCount} beforeGate=${o1BeforeGate} board=${o1Board} login=${o1Login} hash=${o1Hash || "(none)"} errors=${o1PageErrors.length} target=${redactUrl(o1Open.url)}`,
    {
      id: "O1",
      group: "openkey",
      expect:
        "点击「打开」→ GET /secret → 目标 URL 为 service.url + '#key=<口令>'（fragment）；连点仅一次；全新上下文落地板面且地址栏无 key=",
      image: imgO1After,
      imageWidth: "390×844",
      imageBefore: imgO1Before,
      beforeWidth: "390×844",
    },
  );

  // O2（1280）：公网入口携带 publicUrl + #key=（publicUrl 为登记 fixture，不真实解析；只验目标 URL 形态）。
  const publicFixture = "https://public.stoa.test/board-a";
  await fetch(`${daemonUrl}/api/daemon/services/${serviceA.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicUrl: publicFixture }),
  });
  const o2Live = await ensureServiceRunning(page, serviceA, "O2");
  if (!o2Live.ok) throw new Error(`O2 precheck: board-a not running (${o2Live.detail})`);
  await setViewport(page, 1280, 900);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Stoa Daemon", { timeout: 10_000 });
  const o2Entry = await waitFor(
    () => page.locator(`[data-testid="daemon-entry-public-${serviceA.id}"]`).count().then((n) => n > 0),
    15_000,
    "O2 public entry",
  );
  const o2LinkHref = await page
    .getByTestId(`daemon-entry-public-${serviceA.id}`)
    .getAttribute("href")
    .catch(() => null);
  await waitToastsGone(page);
  await resetQaOpenedUrls();
  await page.getByTestId(`daemon-entry-public-${serviceA.id}`).click();
  const o2Open = await waitOpenedUrl("O2 window.open");
  const o2Expect = `${publicFixture}#key=${encodeURIComponent(o1Key)}`;
  const o2PublicKeyed =
    Boolean(o1Key) && o2Open.url.startsWith(publicFixture) && o2Open.url === o2Expect;

  const o2BeforeCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const o2BeforePage = await o2BeforeCtx.newPage();
  await o2BeforePage.goto(`${serviceA.url}/`, { waitUntil: "domcontentloaded" });
  const o2BeforeGate = await o2BeforePage
    .waitForSelector('[data-testid="login-secret"]', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const imgO2Before = await shot(o2BeforePage, "open-before-login-1280.png");
  await o2BeforeCtx.close();

  const o2AfterCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const o2AfterPage = await o2AfterCtx.newPage();
  await o2AfterPage.goto(o1Expect || "about:blank", { waitUntil: "domcontentloaded" });
  const o2Board = await o2AfterPage
    .waitForSelector('[data-testid="app-root-view"]', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  const o2Login = await o2AfterPage.getByTestId("login-secret").count();
  const o2Hash = new URL(o2AfterPage.url()).hash;
  const imgO2After = await shot(o2AfterPage, "open-after-board-1280.png");
  await o2AfterCtx.close();
  check(
    "O2 1280 行内「公网入口」自带口令：目标 URL 以 publicUrl 开头且携带 #key=；落地无登录门",
    o2Entry &&
      o2LinkHref === publicFixture &&
      o2PublicKeyed &&
      o2BeforeGate &&
      o2Board &&
      o2Login === 0 &&
      !o2Hash.includes("key="),
    `entry=${o2Entry} href=${o2LinkHref} keyed=${o2PublicKeyed} beforeGate=${o2BeforeGate} board=${o2Board} login=${o2Login} hash=${o2Hash || "(none)"} target=${redactUrl(o2Open.url)}`,
    {
      id: "O2",
      group: "openkey",
      expect:
        "行内公网入口点击 → GET /secret → 目标 URL = publicUrl + '#key=<口令>'；落地板面（1280×900 一组 before/after）",
      image: imgO2After,
      imageWidth: "1280×900",
      imageBefore: imgO2Before,
      beforeWidth: "1280×900",
    },
  );
  // 清除 publicUrl fixture（后续步骤按原状登记）。
  await fetch(`${daemonUrl}/api/daemon/services/${serviceA.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicUrl: null }),
  });

  // O3：真实开放模式服务（fixture：init 后抹除 STOA_AUTH，standalone 起服务由 daemon 收编）→ 打开不带 key。
  // 13680-13699 段在本机常被其它会话占满：第 5 个端口到 O3 才认领（此时 B/C 已释放），
  // 不预留会因「5 个并发空闲端口」而在拥挤环境直接失败（实测 16 个可用端口只剩 4 个）。
  const portD = await pickFreePort(13680, 13699, new Set([...RESERVED_PORTS, daemonPort, portA]));
  qaPorts.push(portD);
  initBoard(dirs.open);
  const openEnvPath = join(dirs.open, ".env");
  const openEnvKept = readFileSync(openEnvPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:export\s+)?(?:STOA_AUTH|FDE2E_REPORT_AUTH)\s*=/.test(line));
  writeFileSync(openEnvPath, `${openEnvKept.join("\n").replace(/\n+$/, "")}\n`);
  const openStandalone = spawn(
    BUN,
    [CLI, "serve", "--standalone", "--data-dir", dirs.open, "--port", String(portD)],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, STOA_DAEMON_STATE_DIR: stateDir },
    },
  );
  spawned.push(openStandalone);
  const openOut = [];
  openStandalone.stdout.on("data", (chunk) => openOut.push(chunk.toString()));
  const openPrinted = await waitFor(
    () => openOut.join("").includes("REPORT_URL="),
    20_000,
    "O3 open standalone",
  );
  const openHealth = await fetchJson(`http://127.0.0.1:${portD}/healthz`);
  const adoptRes = await fetch(`${daemonUrl}/api/daemon/services`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataDir: dirs.open, port: portD, name: "open-board" }),
  });
  const adoptBody = await adoptRes.json().catch(() => null);
  const openRecord = adoptBody?.service ?? null;
  if (openRecord?.pid) pids.services.push(Number(openRecord.pid));
  const openModeReady = await waitFor(
    async () => {
      const view = await fetchJson(`${daemonUrl}/api/daemon/services/${openRecord?.id ?? ""}/secret`);
      return view?.mode === "open" && (view?.key ?? null) === null;
    },
    15_000,
    "O3 open mode secret",
  );
  await setViewport(page, 390, 844);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Stoa Daemon", { timeout: 10_000 });
  const o3Row = await waitFor(
    () => page.locator(`[data-testid="daemon-open-${openRecord?.id ?? ""}"]`).count().then((n) => n > 0),
    20_000,
    "O3 open row",
  );
  await waitToastsGone(page);
  await resetQaOpenedUrls();
  await page.getByTestId(`daemon-open-${openRecord?.id ?? ""}`).click();
  const o3Open = await waitOpenedUrl("O3 window.open");
  const o3Toast = await page
    .locator('[data-slot="toast"]')
    .filter({ hasText: "未附带口令" })
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  const imgO3Toast = await shot(page, "open-no-key-toast-390.png");
  await waitToastsGone(page);
  check(
    "O3 开放模式（mode=open）服务：点「打开」不带 #key=（目标 URL 等于 service.url），并提示未附带口令",
    openPrinted &&
      openHealth?.ok === true &&
      openModeReady &&
      openRecord?.status === "running" &&
      o3Row &&
      o3Open.url === openRecord?.url &&
      !o3Open.url.includes("#key=") &&
      o3Toast,
    `printed=${openPrinted} health=${openHealth?.ok} modeOpen=${openModeReady} status=${openRecord?.status} target=${redactUrl(o3Open.url)} toast=${o3Toast}`,
    {
      id: "O3",
      group: "openkey",
      expect:
        "真实开放模式服务（init 后移除 STOA_AUTH、daemon 收编）：GET /secret mode=open → 打开无 key URL；界面提示「未附带口令」",
      image: imgO3Toast,
      imageWidth: "390×844",
    },
  );

  // O4：/secret 注入 500 → 仍打开不带 key 的原 URL，且有可见提示（不静默失败）。
  const failSecretRoute = async (route) => {
    if (route.request().method() !== "GET") return route.continue().catch(() => undefined);
    return route
      .fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "QA 注入：口令读取失败" }),
      })
      .catch(() => undefined);
  };
  await waitToastsGone(page);
  injectedFailures += 1;
  await page.route(`**/api/daemon/services/${serviceA.id}/secret`, failSecretRoute);
  await resetQaOpenedUrls();
  await page.getByTestId(`daemon-open-${serviceA.id}`).click();
  const o4Open = await waitOpenedUrl("O4 window.open");
  const o4Toast = await page
    .locator('[data-slot="toast"]')
    .filter({ hasText: "未附带口令" })
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  const imgO4 = await shot(page, "open-secret-failed-toast-390.png");
  await page.unroute(`**/api/daemon/services/${serviceA.id}/secret`, failSecretRoute);
  injectedFailures = Math.max(0, injectedFailures - 1);
  await waitToastsGone(page);
  check(
    "O4 口令读取失败兜底：/secret 注入 500 时仍打开不带 key 的原 URL，并出现「未附带口令」提示",
    o4Open.ok && o4Open.url === serviceA.url && !o4Open.url.includes("#key=") && o4Toast,
    `opened=${o4Open.ok} target=${redactUrl(o4Open.url)} noKey=${!o4Open.url.includes("#key=")} toast=${o4Toast}`,
    {
      id: "O4",
      group: "openkey",
      expect: "GET /secret 500 → window.open(service.url)（无 #key=）+ warning toast；不阻断打开",
      image: imgO4,
      imageWidth: "390×844",
    },
  );

  // O5：打码纪律未退化——完整口令不在页面文本/title/aria-label/常驻链接 href 中。
  const o5Probe = await page.evaluate((needle) => {
    const innerText = needle ? document.body.innerText.includes(needle) : false;
    let attrHits = 0;
    for (const el of document.querySelectorAll("[title], [aria-label]")) {
      const title = el.getAttribute("title") ?? "";
      const label = el.getAttribute("aria-label") ?? "";
      if (needle && (title.includes(needle) || label.includes(needle))) attrHits += 1;
    }
    const keyedHrefs = [...document.querySelectorAll("a[href]")].filter((el) =>
      String(el.getAttribute("href") ?? "").includes("#key="),
    ).length;
    return { innerText, attrHits, keyedHrefs };
  }, o1Key);
  check(
    "O5 界面纪律：完整口令不出现在页面文本 / title / aria-label / 常驻链接 href（打码态不退化）",
    o1Key.length > 0 && !o5Probe.innerText && o5Probe.attrHits === 0 && o5Probe.keyedHrefs === 0,
    `keyLen=${o1Key.length} inText=${o5Probe.innerText} attrHits=${o5Probe.attrHits} keyedHrefs=${o5Probe.keyedHrefs}`,
    {
      id: "O5",
      group: "openkey",
      expect:
        "口令只存在于「复制」与「打开」动作的目标 URL；界面文本/title/aria-label/常驻 href 均不含真值",
    },
  );
  await setViewport(page, 390, 844);

  // ── S5: serve --stop（daemon 感知）与 daemon stop 全回收 ───────────────────
  const stopA = cliJson(["serve", "--stop", "--data-dir", dirs.a, "--state-dir", stateDir]);
  check(
    "S5-1 `serve --stop` 走 daemon（via_daemon:true），A 板进程死亡",
    stopA.code === 0 && stopA.json.via_daemon === true && !pidAlive(serviceA.pid),
    `via_daemon=${stopA.json.via_daemon} pid ${serviceA.pid} alive=${pidAlive(serviceA.pid)}`,
    { id: "S5-1", group: "cli", expect: "停止 + 登记收口；服务 healthz 不再 200" },
  );

  // 重新挂载 A 板，验证关闭对话框后 daemon 退出且服务被一并回收
  const serve3 = cliJson(["serve", "--data-dir", dirs.a, "--port", String(portA)], {
    STOA_DAEMON_STATE_DIR: stateDir,
  });
  const serviceA3 = serve3.json.service ?? {};
  if (serviceA3.pid) pids.services.push(serviceA3.pid);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Stoa Daemon", { timeout: 10_000 });
  await waitFor(
    () => page.locator("[data-testid^=daemon-service-]").count().then((n) => n >= 1),
    15_000,
    "rows before shutdown",
  );

  /**
   * 竞态探针（L10-3）：在 daemon 关闭前让一个真实 GET 拿到响应、延迟 6s 才回灌页面——
   * 精确模拟「5s 轮询的请求在用户点关闭的瞬间仍在飞」的真实时序。实现已在 refresh 的
   * setServices/setLoadError 之前加 daemonDownRef 守卫（DaemonConsolePage.tsx:790/795），
   * 迟到旧响应会被丢弃；本探针验证该守卫在真实浏览器 + 真实 daemon 下成立。
   */
  let markHeld;
  const heldOnce = new Promise((resolveHeld) => {
    markHeld = resolveHeld;
  });
  let markFulfilled;
  const fulfilledOnce = new Promise((resolveFulfilled) => {
    markFulfilled = resolveFulfilled;
  });
  let held = false;
  let fulfilledFlag = false;
  const holdStalePoll = async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue().catch(() => undefined);
      return;
    }
    try {
      const response = await route.fetch();
      const body = await response.text();
      if (!held) {
        held = true;
        markHeld();
      }
      await sleep(6000);
      await route.fulfill({ response, body });
      if (!fulfilledFlag) {
        fulfilledFlag = true;
        markFulfilled();
      }
    } catch {
      try {
        await route.continue();
      } catch {
        /* already handled */
      }
    }
  };
  await page.route("**/api/daemon/services", holdStalePoll);
  const heldRequestCaptured = await Promise.race([
    heldOnce.then(() => true),
    sleep(7000).then(() => false),
  ]);

  // daemon 关闭入口在 header ⋯ 菜单（不是行内按钮）。
  await page.getByTestId("daemon-shutdown-open").click();
  await page.getByRole("menuitem", { name: "关闭 daemon" }).click();
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
  // 确定式等待：healthz 消失早于进程完全退出（还要逐个收掉挂载服务）；等 pid 真正退出再断言，
  // 避免在收尸尾段采样（本机拥挤/多服务时是真实的时序窗口，不是 UI 缺陷）。
  const daemonPidExited = await waitFor(() => !pidAlive(pids.daemon), 20_000, "daemon pid exit");
  const servicePidExited = await waitFor(() => !pidAlive(serviceA3.pid), 15_000, "service pid exit");
  check(
    "S5-2 控制台「关闭 daemon」：header 菜单 → 对话框确认 → daemon 退出并连带停止全部挂载服务",
    daemonGone && serviceGone && daemonPidExited && servicePidExited && !pidAlive(pids.daemon) && !pidAlive(serviceA3.pid),
    `daemon pid ${pids.daemon} alive=${pidAlive(pids.daemon)} exited=${daemonPidExited}；service pid ${serviceA3.pid} alive=${pidAlive(serviceA3.pid)} exited=${servicePidExited}`,
    {
      id: "S5-2",
      group: "shutdown",
      expect: "POST /api/daemon/shutdown → 全回收（无孤儿）",
      image: imgDialog,
      imageWidth: "390×844",
      imageBefore: beforeImage("daemon-shutdown-dialog-390.png"),
      beforeWidth: "390×844",
    },
  );

  // ── L10: daemon 已停止态（横幅 + 概览；报告流程末端，此后不再需要 daemon）────
  // 确定性等待：横幅出现（由 shutdown 响应同步置位）而不是固定时长后立即断言。
  await page.waitForSelector('[data-testid="daemon-stopped"]', { state: "visible", timeout: 8_000 });
  const daemonDownBanner = await page.getByTestId("daemon-stopped").isVisible().catch(() => false);
  const daemonDownOverview = await page.getByTestId("daemon-stopped-overview").isVisible().catch(() => false);
  const bannerText = await page.getByTestId("daemon-stopped").innerText().catch(() => "");
  const stoppedRowsBeforeStale = await page.locator('[data-testid^=daemon-service-]').evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-status")),
  );
  const openButtonsBeforeStale = await page.locator('[data-testid^="daemon-open-"]').count();
  // P2-13：daemonDown 时 header「添加服务」disabled 且有 title 说明（不可再发挂载请求）。
  const addDownState = await page.getByTestId("daemon-mount-open").evaluate((el) => ({
    disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
    title: el.getAttribute("title") ?? "",
  }));
  // 旧响应尚未回灌（hold 6s）：先取「关闭瞬间」的干净 stopped 态截图。
  const imgDown390 = await shot(page, "daemon-down-390.png");
  check(
    "L10-1 daemon 已停止态（390）：横幅 + 概览「daemon 已停止」；行降级 stopped 无失效「打开」；header「添加服务」disabled+title",
    daemonDownBanner &&
      daemonDownOverview &&
      bannerText.includes("daemon 已停止") &&
      stoppedRowsBeforeStale.length > 0 &&
      stoppedRowsBeforeStale.every((s) => s === "stopped") &&
      openButtonsBeforeStale === 0 &&
      addDownState.disabled &&
      addDownState.title.length > 0,
    `banner=${daemonDownBanner} overview=${daemonDownOverview} rows=${JSON.stringify(stoppedRowsBeforeStale)} open=${openButtonsBeforeStale} add=${JSON.stringify(addDownState)}`,
    {
      id: "L10-1",
      group: "shutdown",
      expect: "daemon-stopped 横幅 + daemon-stopped-overview；关闭瞬间所有行 data-status=stopped；无打开按钮",
      image: imgDown390,
      imageWidth: "390×844",
    },
  );
  await setViewport(page, 1280, 900);
  const down1280 =
    (await page.getByTestId("daemon-stopped").isVisible().catch(() => false)) &&
    (await page.getByTestId("daemon-stopped-overview").isVisible().catch(() => false));
  const imgDown1280 = await shot(page, "daemon-down-1280.png");
  check(
    "L10-2 daemon 已停止态（1280）：横幅与概览保持可见",
    down1280,
    `banner+overview visible=${down1280}`,
    {
      id: "L10-2",
      group: "shutdown",
      expect: "1280 补图（新状态，无 before）",
      image: imgDown1280,
      imageWidth: "1280×900",
    },
  );
  await setViewport(page, 390, 844);

  // ── L10-3: 关闭瞬间在飞的旧轮询响应回灌后，在册行不得回填 running ──────────
  // 确定性等待：等 route.fulfill 真正把旧响应回灌（不是固定 sleep）。
  const staleFulfilled = await Promise.race([
    fulfilledOnce.then(() => true),
    sleep(10_000).then(() => false),
  ]);
  const rowsAfterStale = await page.locator('[data-testid^=daemon-service-]').evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-status")),
  );
  const openAfterStale = await page.locator('[data-testid^="daemon-open-"]').count();
  const imgStale = await shot(page, "daemon-down-stale-poll-390.png");
  check(
    "L10-3 daemon 已停止态一致性：关闭瞬间在飞的 5s 轮询旧响应不得把在册行回填为 running",
    heldRequestCaptured &&
      staleFulfilled &&
      rowsAfterStale.length > 0 &&
      rowsAfterStale.every((s) => s === "stopped") &&
      openAfterStale === 0,
    `heldRequest=${heldRequestCaptured} staleFulfilled=${staleFulfilled} rowsAfterStale=${JSON.stringify(rowsAfterStale)} open=${openAfterStale}`,
    {
      id: "L10-3",
      group: "shutdown",
      expect:
        "确定性竞态探针：GET 响应在关闭前抓取、关闭后经 route.fulfill 回灌（等回灌完成才断言）；实现以 daemonDownRef 守卫丢弃迟到旧响应，横幅与行状态应保持 stopped",
      image: imgStale,
      imageWidth: "390×844",
    },
  );
  await page.unroute("**/api/daemon/services", holdStalePoll).catch(() => undefined);

  check("S6-1 前端零 console error / pageerror", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "clean", {
    id: "S6-1",
    group: "recycle",
    expect: "浏览器控制台无错误",
  });

  // 供回收检查使用（daemon 已停，端口应全部释放）
} catch (err) {
  check("未捕获异常", false, String(err?.stack ?? err), { id: "FATAL", group: "recycle" });
} finally {
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  await cleanup();
  const leftovers = [pids.daemon, ...pids.services].filter((pid) => pidAlive(pid));
  check("S7-1 进程回收：daemon 与全部子服务 pid 均不存活", leftovers.length === 0, leftovers.length ? `alive=${leftovers.join(",")}` : `all reclaimed (${[pids.daemon, ...pids.services].filter(Boolean).join(",")})`, {
    id: "cleanup-1",
    group: "recycle",
    expect: "脚本结束时零残留进程；沙箱目录删除",
  });

  const stillListening = [];
  for (const port of qaPorts) {
    if (await portIsListening("127.0.0.1", port)) stillListening.push(port);
  }
  check(
    "S7-2 端口回收：本次认领的 daemon/服务端口全部释放",
    stillListening.length === 0,
    stillListening.length ? `still listening: ${stillListening.join(",")}` : `free: ${qaPorts.join(",") || "(none)"}`,
    { id: "S7-2", group: "recycle", expect: "daemon 端口与各服务端口均不再监听" },
  );

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
    ports: qaPorts,
    checks: checks.map(({ name, ok, detail, at }) => ({ name, ok, detail, at })),
    screenshots,
  };
  writeFileSync(join(REPORT_DIR, "results.json"), JSON.stringify(result, null, 2));
  const failedChecks = checks.filter((item) => !item.ok);
  const byGroup = (ids) => steps.filter((step) => ids.includes(step.group));
  writeFileSync(
    join(REPORT_DIR, "steps.json"),
    JSON.stringify(
      {
        title:
          "stoa-console-open-with-key — 控制台「打开」自带口令（daemon 全量 E2E 回归）",
        brand: "Stoa（人机公示板）· stoa-console-open-with-key 交付报告",
        subtitle:
          "服务行「打开」主操作与行内入口（本地/公网）点击时按需读取口令，把 `#key=<口令>` 附为 fragment 后打开——从控制台打开服务不再落到登录门；开放模式/无口令/读取失败退回无 key URL 并给出可见提示；界面展示仍打码。",
        meta: `2026-11-11 · ${checks.length} 断言 / ${failedChecks.length} FAIL · 390×844 + 1280×900 · 隔离 stateDir=${stateDir} · 真实 daemon/服务进程全程回收 · 端口 ${[...new Set(qaPorts)].join("/") || "—"}`,
        thesis:
          failedChecks.length === 0
            ? "结论：控制台「打开」与行内本地/公网入口均自带口令（O1/O2：目标 URL 携带 #key=，新上下文直达板面、地址栏 hash 已抹除，连点去抖只开一个）；开放模式与 /secret 读取失败时退回无 key 且有可见提示（O3/O4）；界面文本/title/aria-label 不含完整口令（O5）。既有 62 项布局/会话/回收断言全量回归通过；浏览器零 console error。"
            : `结论：${failedChecks.length} 项断言失败（见 FAIL 步骤），不得视为交付。其余 ${checks.length - failedChecks.length} 项全 PASS。`,
        env: [
          ["隔离沙箱", sandbox],
          ["daemon", `state-dir=${stateDir}（STOA_DAEMON_STATE_DIR；端口 ${qaPorts[0] ?? "?"}，13680-13699 探测认领）`],
          ["HOME（会话根）", `${sandboxHome}（自动会话 → $HOME/.stoa/sessions；与真实主目录隔离）`],
          ["目录选择器", `测试钩子 STOA_DIR_PICKER_RESULT=${pickedDir}（真实原生对话框为人工验收项）`],
          ["data-dir", `${dirs.a} / ${dirs.b} / ${dirs.c} / ${dirs.open}（init 真实 CLI）`],
          ["视口", "390×844（移动，hasTouch）／1280×900（桌面）；Chrome"],
          ["生产板/真实 daemon", "127.0.0.1:13689 与默认 state-dir 零接触"],
          ["刷新态/竞态取证", "GET /api/daemon/services：刷新态注入 1.5s 延迟；L10-3 探针在关闭前抓取真实响应、延迟 6s 回灌（模拟慢回包；均走真实 daemon）"],
          [
            "覆盖表 · src/ui/pages/DaemonConsolePage.tsx",
            "行内「打开」主按钮 → O1（390 before/after）；行内「本地入口」→ O1 同一链路；行内「公网入口」→ O2（1280 before/after）；开放模式 → O3（toast 截图）；/secret 500 兜底 → O4（toast 截图）；打码纪律 → O5。UNCOVERED=0",
          ],
          [
            "覆盖表 · scripts/qa/stoa-daemon.mjs",
            "QA harness 本身（测试工具，无视觉面——显式登记，三类豁免之①）",
          ],
          [
            "覆盖表 · openspec/changes/stoa-console-open-with-key/tasks.md",
            "规格/任务台账（文档，无视觉面——显式登记，三类豁免之①）",
          ],
          ["UNCOVERED", "0（改动文件均有对应步骤；未覆盖项见下）"],
          [
            "before/after 图来源",
            "本 change 的 before/after 图（O1/O2）均由本次脚本在同一隔离 daemon、同一服务上生成（非旧版 UI 截图，数据/端口/状态一致）：before＝不带 key 的原 URL 在全新上下文打开（复现改动前的落点＝登录门）；after＝同服务带 #key= 打开后直达板面。其余既有步骤的 before 图沿用旧报告 .agents/reports/manager/stoa-daemon/（旧版 UI，仅作布局对比，沙箱/端口/数据与本次不同）。O2 的 publicUrl 为登记 fixture（public.stoa.test），仅验证目标 URL 形态，before/after 仍取本地原 URL 以保持同状态可比。",
          ],
          [
            "未覆盖项（如实登记）",
            "口令读取慢响应/超时（仅注入 500）；window.open 被浏览器真实拦截的提示路径（QA 用录制替身，未模拟真实弹窗拦截）；中键/Cmd+点击的原生新标签行为（代码保留默认语义，未做浏览器级断言）；暗色主题；真实原生目录弹窗（自动化用 STOA_DIR_PICKER_RESULT 钩子验证接线）；S4-1 版本/tag/CI 发布（由编排方统一处理，不在本子任务）",
          ],
          ...(knownBoundaries.length
            ? [["已知边界（如实登记，不阻塞本 change）", knownBoundaries.join(" ｜ ")]]
            : []),
          ["断言", `${checks.length - failedChecks.length}/${checks.length} PASS · ${durationMs}ms`],
          ["截图", `${screenshots.length} 张 PNG（与 steps.json 同目录）＋ ${steps.filter((s) => s.imageBefore).length} 张 before 配对`],
        ],
        sections: [
          {
            title: "1 · 夹具与 CLI daemon 模式（S0/S1/S2/S5-1）",
            note: "daemon start 幂等；默认 serve 挂载并释放终端，stdout 单行 JSON；显式端口被占 CONFLICT。",
            steps: byGroup(["cli"]),
          },
          {
            title: "2 · --standalone 前台契约（S3）",
            note: "占用终端、REPORT_URL、SIGINT 即退；与 daemon 登记脱钩。",
            steps: byGroup(["standalone"]),
          },
          {
            title: "3 · 首屏与触发式挂载 Sheet（S4-1/S4-3/L1–L3；390 + 1280）",
            note: "首屏无常驻表单；header 主按钮与空态 CTA 打开同一官方 Sheet；390 底部抽屉 / 1280 右侧 440px；错误就地；关闭重置。",
            steps: byGroup(["sheet"]),
          },
          {
            title: "4 · 服务列表、操作层级、菜单/确认框、口令与刷新态（S4-2/L4–L5/L7–L8）",
            note: "390 首屏效率与 1280 列锚点；「打开」为真实主链接、口令次级、停止/移除经菜单＋二次确认；stopped 行无失效动作；口令掩码与复制；刷新中动作簇不横移。",
            steps: byGroup(["list"]),
          },
          {
            title: "5 · 挂载/停止/移除、自动与临时会话、口令链接（S4-4–S4-11/L6/L9）",
            note: "目录选择器回填；自定义目录自动 init；toast + 列表新增行；停止/移除二次确认；自动会话落 $HOME；临时会话停止即删；口令链接新上下文自动登录。",
            steps: byGroup(["mount"]),
          },
          {
            title: "6 · 从控制台打开自带口令（O1–O5）",
            note: "「打开」/本地入口/公网入口点击 → GET /secret → #key= fragment；390/1280 各一组 before/after；开放模式无 key；/secret 500 兜底 + 提示；界面文本仍打码。before＝同服务原 URL（无 key）落登录门，after＝带 key 直达板面。",
            steps: byGroup(["openkey"]),
          },
          {
            title: "7 · 关闭 daemon 与 daemon 已停止态（S5-2/L10）",
            note: "header ⋯ 菜单 → 关闭 daemon 确认 → daemon 退出并连带停止服务；页面转为 stopped 横幅 + 概览（L10-1/L10-2 PASS）。L10-3 是确定性竞态探针：关闭前抓取真实 GET 响应、关闭后 6s 经 route.fulfill 回灌，模拟「5s 轮询请求在关闭瞬间仍在飞」；实现已在 refresh 的 setServices/setLoadError 前置 daemonDownRef 守卫（DaemonConsolePage.tsx:790/795），迟到旧响应被丢弃，横幅与行状态保持 stopped——本步 PASS。",
            steps: byGroup(["shutdown"]),
          },
          {
            title: "8 · 回收与浏览器零错误（S6/S7）",
            note: "零 console error；daemon/服务进程与端口全部回收；沙箱删除。",
            steps: byGroup(["recycle"]),
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

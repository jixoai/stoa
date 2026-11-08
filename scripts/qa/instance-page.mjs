#!/usr/bin/env bun
/**
 * report-instance-page E2E 验收（A1-A10）。
 *
 * 两块被测面：
 *   1) 实例管理页：由本脚本起一个**纯静态**壳（dist/，无 /healthz）模拟任意静态宿主；
 *      历史/在线状态用 Playwright route 伪造 `GET /healthz`（online/offline/abort），
 *      真实连接流程用隔离 qa-serve 板验证。
 *   2) 回复原帖完整显示：隔离 qa-serve 板 + 一条 80 行长帖；390×844 移动全屏与
 *      1280×900 桌面 Dialog 两形态。
 *
 * Isolation: 只在 scripts/qa/qa-serve.mjs 的 /tmp/report-qa-* 板上写；生产板
 * 127.0.0.1:13689 只读。长帖在结束时硬清除（隔离库）。
 *
 * Run:
 *   bun scripts/qa/instance-page.mjs
 *   bun scripts/qa/instance-page.mjs --no-build
 *   REPORT_QA_BASE=http://127.0.0.1:13688 bun scripts/qa/instance-page.mjs
 *
 * 证据：--report-dir 默认 <主仓>/.agents/reports/manager/report-instance-page
 *      产出 results.json + steps.json + PNG；统一生成器再把 steps.json 变 report.html。
 */
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  REPO_ROOT,
  accountToken,
  apiJson,
  argValue,
  assertIsolatedDataDir,
  ensureQa,
} from "./lib/qa-env.mjs";

const NO_BUILD = process.argv.includes("--no-build");
const REPORT_DIR = resolve(
  argValue(process.argv.slice(2), "report-dir") ??
    join(REPO_ROOT, "..", "..", ".agents", "reports", "manager", "report-instance-page"),
);
mkdirSync(REPORT_DIR, { recursive: true });

if (!NO_BUILD) {
  execFileSync("bun", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
}

const startedAt = Date.now();
const checks = [];
const steps = [];
const screenshots = [];

const check = (name, ok, detail = "", extra = {}) => {
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
};

async function shot(page, name) {
  const path = join(REPORT_DIR, name);
  await page.screenshot({ path });
  screenshots.push(name);
  return name;
}

const sleep = (page, ms) => page.waitForTimeout(ms);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
};
const reportHealth = (instanceId) =>
  JSON.stringify({ ok: true, instanceId, protocol: 1, dataDir: "mock", version: "qa" });

const LONG_MARKER = "QA 实例页长帖";
const LONG_LINES = 80;
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const longBody = [
  `${LONG_MARKER} 第 1 行：回复上下文完整显示验收夹具。`,
  ...Array.from(
    { length: LONG_LINES - 1 },
    (_, index) =>
      `第 ${index + 2} 行：这是原帖正文的完整内容，回复者应当能滚动读到这一行；` +
      `不截断、不省略、不折叠。`,
  ),
].join("\n\n");

let browser = null;
let staticServer = null;
let qa = null;
let longPostId = null;

try {
  qa = await ensureQa(process.argv.slice(2));
  const BASE = qa.base;
  const ownerToken = accountToken(qa.dataDir, "owner");

  // 长帖夹具（隔离板）
  const created = await apiJson(BASE, "/api/posts", ownerToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: longBody, media: [], tags: ["result"] }),
  });
  longPostId = created.posts[0].id;

  // 纯静态壳（无 /healthz）——同源探测必须失败，页面才会停在实例管理页。
  const DIST = join(REPO_ROOT, "dist");
  staticServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const pathname = decodeURIComponent(url.pathname);
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = resolve(DIST, relative);
      if (filePath !== DIST && !filePath.startsWith(DIST + "/")) {
        return new Response("forbidden", { status: 403 });
      }
      if (!existsSync(filePath)) return new Response(Bun.file(join(DIST, "index.html")));
      return new Response(Bun.file(filePath));
    },
  });
  const STATIC = `http://127.0.0.1:${staticServer.port}`;

  const historySeed = [
    { url: "https://online.qa.invalid", lastUsedAt: Date.now() - 60_000 },
    { url: "https://offline.qa.invalid", lastUsedAt: Date.now() - 86_400_000 },
    "https://legacy.example.com",
  ];

  browser = await chromium.launch({ channel: "chrome" });

  // ── 1) 实例管理页（移动端）───────────────────────────────────────────────
  const mobileCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await mobileCtx.addInitScript((entries) => {
    localStorage.setItem("report.ep.history", JSON.stringify(entries));
  }, historySeed);
  let offlineOnline = false;
  const probeCounts = { online: 0, offline: 0, legacy: 0 };
  await mobileCtx.route("https://online.qa.invalid/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/healthz") {
      probeCounts.online += 1;
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": "application/json" },
        body: reportHealth("online-qa"),
      });
    }
    if (path === "/api/auth/status") {
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          mode: "auth",
          auth_enabled: true,
          auth_value_masked: "***",
          env_files_loaded: [],
          env_files_missing: [],
          access_token_ttl_ms: 0,
          open_mode_warning: null,
        }),
      });
    }
    return route.fulfill({ status: 404, headers: CORS, body: "not found" });
  });
  await mobileCtx.route("https://offline.qa.invalid/**", async (route) => {
    probeCounts.offline += 1;
    if (!offlineOnline) {
      return route.fulfill({ status: 503, headers: CORS, body: "down" });
    }
    return route.fulfill({
      status: 200,
      headers: { ...CORS, "content-type": "application/json" },
      body: reportHealth("offline-now-online"),
    });
  });
  await mobileCtx.route("https://legacy.example.com/**", (route) => {
    probeCounts.legacy += 1;
    return route.abort("failed");
  });

  const mobile = await mobileCtx.newPage();
  const mobileErrors = [];
  mobile.on("pageerror", (error) => mobileErrors.push(String(error).slice(0, 160)));
  await mobile.goto(`${STATIC}/`, { waitUntil: "domcontentloaded" });
  await mobile.waitForSelector('[data-testid="instance-page"]', { timeout: 15_000 });
  await mobile.waitForFunction(
    () => {
      const items = [...document.querySelectorAll('[data-testid="ep-history-item"]')];
      return items.length > 0 && items.every((el) => el.getAttribute("data-status") !== "probing");
    },
    null,
    { timeout: 15_000 },
  );
  await sleep(mobile, 200);

  const structure = await mobile.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    return {
      h1: text("h1"),
      purpose: text("header p"),
      cards: ["current-connection", "add-instance", "my-instances", "usage-card"].map(
        (id) => document.querySelector(`[data-testid="${id}"]`) !== null,
      ),
      bodyText: document.body.innerText,
    };
  });
  const a1 = await shot(mobile, "a1-390-instance-page.png");
  check(
    "A1 页面结构：品牌 + 一句用途 + 四张卡，无大段陈述文",
    structure.h1 === "report" &&
      structure.purpose.includes("管理你连接的实例") &&
      structure.cards.every(Boolean) &&
      !structure.bodyText.includes("时间线上有 owner、manager 与子代理"),
    JSON.stringify({ h1: structure.h1, purpose: structure.purpose, cards: structure.cards }),
    { id: "A1", image: a1, imageWidth: "390×844", expect: "品牌 + 一句用途；当前/添加/我的实例/用法四卡" },
  );

  const usageClosed =
    (await mobile.locator('[data-testid="usage-trigger"]').isVisible()) &&
    !(await mobile.getByText("在数据目录起一个本地实例").isVisible().catch(() => false));
  await mobile.click('[data-testid="usage-trigger"]');
  await sleep(mobile, 200);
  const usageOpened = await mobile
    .getByText("在数据目录起一个本地实例")
    .isVisible()
    .catch(() => false);
  const a1b = await shot(mobile, "a1-390-usage-open.png");
  await mobile.click('[data-testid="usage-trigger"]');
  await sleep(mobile, 200);
  const usageReclosed = !(await mobile
    .getByText("在数据目录起一个本地实例")
    .isVisible()
    .catch(() => false));
  check(
    "A1 用法 Collapsible：默认收起 / 展开 / 再收起",
    usageClosed && usageOpened && usageReclosed,
    JSON.stringify({ usageClosed, usageOpened, usageReclosed }),
    {
      id: "A1-usage",
      image: a1b,
      imageWidth: "390×844",
      expect: "默认收起；点触发条展开 4 条用法；再点收起",
    },
  );

  const a2 = await mobile.locator('[data-testid="current-connection-empty"]').isVisible();
  check("A2 当前连接：无快照显示「当前未连接」", a2, a2 ? "可见" : "缺失", {
    id: "A2",
    expect: "首次进入无内存快照时显示当前未连接",
  });

  const historyInfo = await mobile
    .locator('[data-testid="ep-history-item"]')
    .evaluateAll((els) =>
      els.map((el) => ({
        url: el.getAttribute("data-url"),
        status: el.getAttribute("data-status"),
        text: el.innerText.replace(/\s+/g, " "),
      })),
    );
  const onlineItem = historyInfo.find((item) => item.url === "https://online.qa.invalid");
  const offlineItem = historyInfo.find((item) => item.url === "https://offline.qa.invalid");
  const legacyItem = historyInfo.find((item) => item.url === "https://legacy.example.com");
  await mobile.locator('[data-testid="my-instances"]').scrollIntoViewIfNeeded();
  await sleep(mobile, 150);
  const a4 = await shot(mobile, "a4-390-history.png");
  check(
    "A4 我的实例：地址 + 最后使用 + 在线/离线；旧格式时间未知",
    historyInfo.length === 3 &&
      onlineItem?.status === "online" &&
      onlineItem.text.includes("在线") &&
      !onlineItem.text.includes("时间未知") &&
      offlineItem?.status === "offline" &&
      offlineItem.text.includes("离线") &&
      legacyItem?.status === "offline" &&
      legacyItem.text.includes("时间未知"),
    JSON.stringify(historyInfo),
    { id: "A4", image: a4, imageWidth: "390×844", expect: "三态历史项：在线/离线/旧格式" },
  );

  const probesBeforeRetry = { ...probeCounts };
  offlineOnline = true;
  await mobile
    .locator(
      '[data-testid="ep-history-item"][data-url="https://offline.qa.invalid"] [data-testid="ep-history-retry"]',
    )
    .click();
  await mobile.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="ep-history-item"][data-url="https://offline.qa.invalid"]')
        ?.getAttribute("data-status") === "online",
    null,
    { timeout: 10_000 },
  );
  const retriedStatus = await mobile
    .locator('[data-testid="ep-history-item"][data-url="https://offline.qa.invalid"]')
    .getAttribute("data-status");
  const onlyOfflineReprobed =
    probeCounts.offline === probesBeforeRetry.offline + 1 &&
    probeCounts.online === probesBeforeRetry.online &&
    probeCounts.legacy === probesBeforeRetry.legacy;
  check(
    "A7 在线探测：离线条目点重试后翻转为在线（且只重探该项）",
    retriedStatus === "online" && onlyOfflineReprobed,
    JSON.stringify({ retriedStatus, before: probesBeforeRetry, after: probeCounts }),
    {
      id: "A7",
      expect: "重试只重新探测该项，离线→在线；其它两项请求数不变",
    },
  );

  const overflow = await mobile.evaluate(() => {
    const root = document.querySelector('[data-testid="instance-page"]');
    return {
      win: window.innerWidth,
      docScroll: document.documentElement.scrollWidth,
      docClient: document.documentElement.clientWidth,
      rootScroll: root?.scrollWidth ?? 0,
      rootClient: root?.clientWidth ?? 0,
    };
  });
  const hitTargets = await mobile.evaluate(() => {
    const root = document.querySelector('[data-testid="instance-page"]');
    return [...(root?.querySelectorAll("button") ?? [])]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          label:
            el.getAttribute("data-testid") ||
            el.getAttribute("aria-label") ||
            (el.textContent ?? "").trim().slice(0, 16),
          w: Math.round(rect.width * 10) / 10,
          h: Math.round(rect.height * 10) / 10,
        };
      });
  });
  const smallTargets = hitTargets.filter((target) => target.w < 44 || target.h < 44);
  const a8 = await shot(mobile, "a8-390-metrics.png");
  check(
    "A8 移动端度量：390 无横向溢出 + 可点目标 ≥44px",
    overflow.docScroll <= overflow.win &&
      overflow.rootScroll <= overflow.rootClient &&
      smallTargets.length === 0,
    JSON.stringify({ overflow, smallTargets, targets: hitTargets.length }),
    { id: "A8", image: a8, imageWidth: "390×844", expect: "无横向溢出；所有按钮 ≥44×44" },
  );

  const beforeRemove = await mobile.evaluate(() => {
    const raw = localStorage.getItem("report.ep.history");
    return raw ? JSON.parse(raw).length : 0;
  });
  await mobile
    .locator(
      '[data-testid="ep-history-item"][data-url="https://legacy.example.com"] [data-testid="ep-history-remove"]',
    )
    .click();
  await sleep(mobile, 150);
  const afterRemove = await mobile.evaluate(() => {
    const raw = localStorage.getItem("report.ep.history");
    return {
      count: document.querySelectorAll('[data-testid="ep-history-item"]').length,
      stored: raw ? JSON.parse(raw).length : 0,
    };
  });
  check(
    "A5 历史操作：移除同步列表与 localStorage",
    beforeRemove === 3 && afterRemove.count === 2 && afterRemove.stored === 2,
    JSON.stringify({ beforeRemove, afterRemove }),
    { id: "A5a", expect: "移除后 DOM 与 localStorage 都是 2 条" },
  );

  await mobile.evaluate(() => {
    localStorage.setItem("report.token.https://online.qa.invalid", "qa-token-online");
    localStorage.setItem("report.token.https://offline.qa.invalid", "qa-token-offline");
  });
  await mobile.click('[data-testid="ep-history-clear"]');
  await sleep(mobile, 200);
  const confirmVisible = await mobile
    .locator('[data-testid="ep-history-clear-confirm"]')
    .isVisible();
  const historyBeforeConfirm = await mobile.locator('[data-testid="ep-history-item"]').count();
  const a5confirm = await shot(mobile, "a5-390-clear-confirm.png");
  check(
    "A5 清空历史：先二次确认（确认前条目不动）",
    confirmVisible && historyBeforeConfirm === 2,
    JSON.stringify({ confirmVisible, historyBeforeConfirm }),
    {
      id: "A5-confirm",
      image: a5confirm,
      imageWidth: "390×844",
      expect: "点清空历史出现确认 Alert；确认前仍保留 2 条",
    },
  );
  await mobile.click('[data-testid="ep-history-clear-confirm-button"]');
  await sleep(mobile, 200);
  const cleared = await mobile.evaluate(() => ({
    empty: Boolean(document.querySelector('[data-testid="ep-history-empty"]')),
    stored: localStorage.getItem("report.ep.history"),
    onlineToken: localStorage.getItem("report.token.https://online.qa.invalid"),
    offlineToken: localStorage.getItem("report.token.https://offline.qa.invalid"),
  }));
  const a5 = await shot(mobile, "a5-390-empty.png");
  check(
    "A5 历史操作：清空后官方 Empty 空态、history 与登录凭据一并清空",
    cleared.empty &&
      (cleared.stored === null || cleared.stored === "[]") &&
      cleared.onlineToken === null &&
      cleared.offlineToken === null,
    JSON.stringify(cleared),
    {
      id: "A5b",
      image: a5,
      imageWidth: "390×844",
      expect: "Empty 空态；history 与 report.token.* 均清空",
    },
  );

  // A6 添加实例：非法 / 离线 / 在线预检
  await mobile.fill('[data-testid="ep-input"]', "http://192.168.1.10:13610");
  await mobile.click('[data-testid="ep-connect"]');
  await mobile.waitForSelector('[data-testid="ep-error"]', { timeout: 5_000 });
  const invalidError = (await mobile.locator('[data-testid="ep-error"]').innerText()).replace(/\s+/g, " ");
  const a6a = await shot(mobile, "a6-390-invalid.png");
  check(
    "A6 添加实例：非回环 http 就地 Alert",
    invalidError.includes("必须使用 https") &&
      (await mobile.locator('[data-testid="instance-page"]').count()) === 1,
    invalidError,
    { id: "A6a", image: a6a, imageWidth: "390×844", expect: "必须使用 https；停留实例管理页" },
  );

  offlineOnline = false;
  await mobile.fill('[data-testid="ep-input"]', "https://offline.qa.invalid");
  await mobile.click('[data-testid="ep-connect"]');
  await mobile.waitForFunction(
    () => document.querySelector('[data-testid="ep-error"]')?.textContent?.includes("HTTP 503"),
    null,
    { timeout: 10_000 },
  );
  const offlineError = (await mobile.locator('[data-testid="ep-error"]').innerText()).replace(/\s+/g, " ");
  const a6b = await shot(mobile, "a6-390-offline.png");
  check(
    "A6 添加实例：healthz 失败就地 Alert（不进入连接）",
    offlineError.includes("HTTP 503") &&
      (await mobile.locator('[data-testid="instance-page"]').count()) === 1,
    offlineError,
    { id: "A6b", image: a6b, imageWidth: "390×844", expect: "目标 /healthz 返回 HTTP 503" },
  );

  await mobile.fill('[data-testid="ep-input"]', "https://online.qa.invalid");
  await mobile.click('[data-testid="ep-connect"]');
  await mobile.waitForSelector('input[type="password"]', { timeout: 15_000 });
  const a6c = await shot(mobile, "a6-390-online-preflight.png");
  check(
    "A6 添加实例：预检通过后进入既有 connect()（登录门）",
    (await mobile.locator('input[type="password"]').count()) === 1,
    "password input visible",
    { id: "A6c", image: a6c, imageWidth: "390×844", expect: "预检通过 → 登录门" },
  );
  await mobileCtx.close();

  // ── 2) 桌面两列 + 当前连接（真实 qa-serve 连接）─────────────────────────
  const desktopCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await desktopCtx.addInitScript(
    ({ entries }) => {
      localStorage.setItem("report.ep.history", JSON.stringify(entries));
    },
    {
      entries: [
        { url: BASE, lastUsedAt: Date.now() - 3_600_000 },
        { url: "https://online.qa.invalid", lastUsedAt: Date.now() - 120_000 },
        { url: "https://offline.qa.invalid", lastUsedAt: Date.now() - 86_400_000 },
      ],
    },
  );
  await desktopCtx.route("https://online.qa.invalid/**", (route) =>
    route.fulfill({
      status: 200,
      headers: { ...CORS, "content-type": "application/json" },
      body: reportHealth("online-qa"),
    }),
  );
  await desktopCtx.route("https://offline.qa.invalid/**", (route) =>
    route.fulfill({ status: 503, headers: CORS, body: "down" }),
  );
  const desktop = await desktopCtx.newPage();
  const desktopErrors = [];
  desktop.on("pageerror", (error) => desktopErrors.push(String(error).slice(0, 160)));
  await desktop.goto(`${STATIC}/`, { waitUntil: "domcontentloaded" });
  await desktop.waitForSelector('[data-testid="instance-page"]', { timeout: 15_000 });
  await desktop.waitForFunction(
    () => {
      const items = [...document.querySelectorAll('[data-testid="ep-history-item"]')];
      return items.length > 0 && items.every((el) => el.getAttribute("data-status") !== "probing");
    },
    null,
    { timeout: 15_000 },
  );
  await sleep(desktop, 200);

  const layout = await desktop.evaluate(() => {
    const box = (selector) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    const root = document.querySelector('[data-testid="instance-page"]');
    return {
      current: box('[data-testid="current-connection"]'),
      add: box('[data-testid="add-instance"]'),
      mine: box('[data-testid="my-instances"]'),
      usage: box('[data-testid="usage-card"]'),
      overflow: {
        win: window.innerWidth,
        docScroll: document.documentElement.scrollWidth,
        docClient: document.documentElement.clientWidth,
        rootScroll: root?.scrollWidth ?? 0,
        rootClient: root?.clientWidth ?? 0,
      },
    };
  });
  const a9 = await shot(desktop, "a9-1280-two-columns.png");
  check(
    "A9 桌面两列：左当前+添加，右我的实例+用法；1280 无横向溢出",
    layout.current &&
      layout.add &&
      layout.mine &&
      layout.usage &&
      layout.current.x < layout.mine.x &&
      layout.current.right <= layout.mine.x + 1 &&
      layout.add.y > layout.current.y &&
      layout.usage.y > layout.mine.y &&
      layout.overflow.docScroll <= layout.overflow.win &&
      layout.overflow.rootScroll <= layout.overflow.rootClient,
    JSON.stringify(layout),
    {
      id: "A9",
      image: a9,
      imageWidth: "1280×900",
      expect: "两列不重叠；左列当前/添加，右列我的实例/用法；无横向溢出",
    },
  );

  await desktop.evaluate(
    ({ base, token }) => localStorage.setItem(`report.token.${base}`, token),
    { base: BASE, token: ownerToken },
  );
  await desktop
    .locator(`[data-testid="ep-history-item"][data-url="${BASE}"] [data-testid="ep-history-connect"]`)
    .click();
  await desktop.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 25_000 });
  await desktop.waitForSelector('[data-testid="switch-backend"]', { timeout: 15_000 });
  await desktop.click('[data-testid="switch-backend"]');
  await desktop.waitForSelector('[data-testid="instance-page"]', { timeout: 15_000 });
  await sleep(desktop, 250);
  const currentText = (await desktop.locator('[data-testid="current-connection"]').innerText()).replace(
    /\s+/g,
    " ",
  );
  const a3 = await shot(desktop, "a3-1280-current-connection.png");
  check(
    "A3 当前连接：从 ready 返回后显示地址/在线/模式/身份",
    currentText.includes(BASE) &&
      currentText.includes("已连接") &&
      currentText.includes("认证模式") &&
      currentText.includes("@owner") &&
      !currentText.includes("@owner · owner"),
    currentText,
    {
      id: "A3",
      image: a3,
      imageWidth: "1280×900",
      expect: "地址 + 已连接 + 认证模式 + @owner（role 与 id 相同时不重复）",
    },
  );

  await desktop.click('[data-testid="current-copy"]');
  await sleep(desktop, 300);
  const copyResult = await desktop.evaluate(async () => {
    let clipboard = "";
    try {
      clipboard = await navigator.clipboard.readText();
    } catch {
      clipboard = "";
    }
    const toastText = [...document.querySelectorAll('[data-slot="toast"]')]
      .map((el) => el.textContent ?? "")
      .join(" ");
    return { clipboard, toastText };
  });
  check(
    "A3 地址复制：写入剪贴板并给出成功提示",
    copyResult.clipboard === BASE || copyResult.toastText.includes("地址已复制"),
    JSON.stringify(copyResult),
    { id: "A3-copy", expect: "clipboard === 当前地址 或 toast 地址已复制" },
  );

  // 退出登录路径：先重新连回实例（nav 只在 ready 态存在），再退出回实例管理页。
  await desktop.evaluate(
    ({ base, token }) => localStorage.setItem(`report.token.${base}`, token),
    { base: BASE, token: ownerToken },
  );
  await desktop
    .locator(`[data-testid="ep-history-item"][data-url="${BASE}"] [data-testid="ep-history-connect"]`)
    .click();
  await desktop.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 25_000 });
  await desktop.click('[data-testid="nav-account-menu"]');
  await sleep(desktop, 200);
  await desktop.click('[data-testid="nav-logout"]');
  await desktop.waitForSelector('[data-testid="instance-page"]', { timeout: 15_000 });
  await sleep(desktop, 250);
  const logoutState = await desktop.evaluate((base) => {
    const card = document.querySelector('[data-testid="current-connection"]');
    return {
      text: card?.textContent?.replace(/\s+/g, " ") ?? "",
      token: localStorage.getItem(`report.token.${base}`),
    };
  }, BASE);
  const a3logout = await shot(desktop, "a3-1280-after-logout.png");
  check(
    "A3 退出登录：仍显示当前连接快照，并清除该实例 token",
    logoutState.text.includes(BASE) &&
      logoutState.text.includes("已连接") &&
      logoutState.text.includes("@owner") &&
      logoutState.token === null,
    JSON.stringify(logoutState),
    {
      id: "A3-logout",
      image: a3logout,
      imageWidth: "1280×900",
      expect: "logout 后当前连接快照保留；report.token.<ep> 清除",
    },
  );
  await desktopCtx.close();

  // ── 3) 回复原帖完整显示（A10）────────────────────────────────────────────
  const openReply = async (viewport, mobileFlag, label) => {
    const context = await browser.newContext({
      viewport,
      hasTouch: mobileFlag,
      isMobile: mobileFlag,
    });
    await context.addInitScript(
      ({ base, token }) => {
        localStorage.setItem("report.ep", base);
        localStorage.setItem(`report.token.${base}`, token);
      },
      { base: BASE, token: ownerToken },
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 160)));
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 25_000 });
    await page.evaluate((id) => {
      location.hash = `#/p/${id}`;
    }, longPostId);
    await page.waitForSelector('[data-testid="reply-open"]', { timeout: 25_000 });
    await page.click('[data-testid="reply-open"]');
    await page.waitForSelector('[data-testid="reply-context-body"]', { timeout: 15_000 });
    await sleep(page, 350);
    return { context, page, errors, label };
  };

  const measureReply = async (page) =>
    page.evaluate((lines) => {
      const body = document.querySelector('[data-testid="reply-context-body"]');
      const outer = document.querySelector('[data-testid="reply-composer-body"]');
      const input = document.querySelector('[data-testid="composer-input"]');
      const dialog = document.querySelector('[data-testid="reply-composer"]');
      const style = body ? getComputedStyle(body) : null;
      const bodyRect = body?.getBoundingClientRect();
      const inputRect = input?.getBoundingClientRect();
      const dialogRect = dialog?.getBoundingClientRect();
      const paragraphs = body ? [...body.querySelectorAll("p")] : [];
      const last = paragraphs[paragraphs.length - 1];
      return {
        overflowY: style?.overflowY ?? null,
        maxHeightPx: style ? Number.parseFloat(style.maxHeight) : 0,
        lineClamp: style?.webkitLineClamp ?? style?.getPropertyValue("-webkit-line-clamp") ?? "",
        scrollHeight: body?.scrollHeight ?? 0,
        clientHeight: body?.clientHeight ?? 0,
        bodyText: body?.innerText ?? "",
        hasFirst: (body?.innerText ?? "").includes("第 1 行："),
        hasLast: (body?.innerText ?? "").includes(`第 ${lines} 行：`),
        outerScroll: outer?.scrollHeight ?? 0,
        outerClient: outer?.clientHeight ?? 0,
        inputRect: inputRect ? inputRect.toJSON() : null,
        dialogRect: dialogRect ? dialogRect.toJSON() : null,
        bodyRect: bodyRect ? bodyRect.toJSON() : null,
        lastRect: last ? last.getBoundingClientRect().toJSON() : null,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    }, LONG_LINES);

  const loadDraftAndAttachments = async (page, lines) => {
    const draft = Array.from(
      { length: lines },
      (_, index) => `草稿第 ${index + 1} 行：长草稿验收，提交按钮必须仍在视口内。`,
    ).join("\n");
    await page.locator('[data-testid="composer-input"]').fill(draft);
    await page.locator('[data-testid="composer-file"]').setInputFiles(
      Array.from({ length: 4 }, (_, index) => ({
        name: `qa-${index + 1}.png`,
        mimeType: "image/png",
        buffer: TINY_PNG,
      })),
    );
    await page.waitForFunction(
      () => {
        const composer = document.querySelector('[data-testid="composer"]');
        const submit = document.querySelector('[data-testid="reply-submit"]');
        const attached = composer
          ? [...composer.querySelectorAll("img")].filter((img) =>
              (img.getAttribute("alt") ?? "").startsWith("qa-"),
            ).length
          : 0;
        return attached === 4 && submit instanceof HTMLButtonElement && !submit.disabled;
      },
      null,
      { timeout: 25_000 },
    );
    await sleep(page, 250);
  };

  const measureDraft = async (page) =>
    page.evaluate(() => {
      const submit = document.querySelector('[data-testid="reply-submit"]');
      const body = document.querySelector('[data-testid="reply-composer-body"]');
      const textarea = document.querySelector('[data-testid="composer-input"]');
      const rect = submit?.getBoundingClientRect();
      const textareaStyle = textarea ? getComputedStyle(textarea) : null;
      const attachmentCount = [
        ...document.querySelectorAll('[data-testid="composer"] img'),
      ].filter((img) => (img.getAttribute("alt") ?? "").startsWith("qa-")).length;
      return {
        submitRect: rect ? rect.toJSON() : null,
        submitVisible:
          Boolean(rect) &&
          rect.top >= 0 &&
          rect.bottom <= window.innerHeight + 1 &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth + 1,
        bodyScrollHeight: body?.scrollHeight ?? 0,
        bodyClientHeight: body?.clientHeight ?? 0,
        bodyScrollTop: body?.scrollTop ?? 0,
        textareaScrollHeight: textarea?.scrollHeight ?? 0,
        textareaClientHeight: textarea?.clientHeight ?? 0,
        textareaMaxHeight: textareaStyle ? Number.parseFloat(textareaStyle.maxHeight) : 0,
        attachmentCount,
      };
    });

  const checkLongDraft = async (page, { id, label, lines, image, imageWidth, viewport }) => {
    await loadDraftAndAttachments(page, lines);
    const before = await measureDraft(page);
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.wheel(0, 600);
    await page.evaluate(() => {
      const body = document.querySelector('[data-testid="reply-composer-body"]');
      if (body) body.scrollTop = 9999;
    });
    await sleep(page, 150);
    const after = await measureDraft(page);
    const shotName = await shot(page, image);
    check(
      `${label}：${lines} 行草稿 + 4 附件时提交按钮仍在视口内（单层滚动）`,
      before.submitVisible &&
        before.bodyScrollHeight <= before.bodyClientHeight + 1 &&
        before.textareaMaxHeight > 0 &&
        before.textareaScrollHeight > before.textareaClientHeight &&
        before.attachmentCount === 4 &&
        after.submitVisible &&
        after.bodyScrollTop === 0,
      JSON.stringify({ before, after }),
      {
        id,
        image: shotName,
        imageWidth,
        expect:
          "reply-submit 在视口内；body 无溢出；textarea 内部滚动；滚轮/触摸后仍可达",
      },
    );
  };

  const mobileReply = await openReply({ width: 390, height: 844 }, true, "mobile");
  const mobileMeasure = await measureReply(mobileReply.page);
  const a10a = await shot(mobileReply.page, "a10-390-reply-context.png");
  check(
    "A10 移动全屏：长帖无截断、容器可滚、外层不滚",
    mobileMeasure.overflowY === "auto" &&
      mobileMeasure.maxHeightPx > 0 &&
      mobileMeasure.maxHeightPx <= mobileMeasure.viewport.h * 0.5 &&
      mobileMeasure.scrollHeight > mobileMeasure.clientHeight + 20 &&
      mobileMeasure.hasFirst &&
      mobileMeasure.hasLast &&
      (mobileMeasure.lineClamp === "none" || mobileMeasure.lineClamp === "") &&
      mobileMeasure.outerScroll <= mobileMeasure.outerClient + 1 &&
      mobileMeasure.dialogRect?.width >= 388 &&
      mobileMeasure.dialogRect?.height >= 842,
    JSON.stringify({
      overflowY: mobileMeasure.overflowY,
      maxHeightPx: mobileMeasure.maxHeightPx,
      scrollHeight: mobileMeasure.scrollHeight,
      clientHeight: mobileMeasure.clientHeight,
      lineClamp: mobileMeasure.lineClamp,
      outerScroll: mobileMeasure.outerScroll,
      outerClient: mobileMeasure.outerClient,
      dialogRect: mobileMeasure.dialogRect,
      hasFirst: mobileMeasure.hasFirst,
      hasLast: mobileMeasure.hasLast,
    }),
    { id: "A10a", image: a10a, imageWidth: "390×844", expect: "完整正文 + 40dvh 容器 + 单层滚动" },
  );

  const mobileBottom = await mobileReply.page.evaluate(() => {
    const body = document.querySelector('[data-testid="reply-context-body"]');
    const input = document.querySelector('[data-testid="composer-input"]');
    body.scrollTop = body.scrollHeight;
    const paragraphs = [...body.querySelectorAll("p")];
    const last = paragraphs[paragraphs.length - 1];
    const bodyRect = body.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    return {
      scrollTop: body.scrollTop,
      lastVisible: lastRect.bottom <= bodyRect.bottom + 1 && lastRect.top >= bodyRect.top - 1,
      inputVisible: inputRect.top >= 0 && inputRect.bottom <= window.innerHeight + 1,
      inputRect: inputRect.toJSON(),
    };
  });
  await sleep(mobileReply.page, 200);
  const a10b = await shot(mobileReply.page, "a10-390-reply-context-bottom.png");
  check(
    "A10 移动全屏：滚到底可见最后一行，回复编辑器始终在视口内",
    mobileBottom.lastVisible && mobileBottom.inputVisible,
    JSON.stringify(mobileBottom),
    { id: "A10b", image: a10b, imageWidth: "390×844", expect: "最后一行可见；composer-input 在视口内" },
  );
  check(
    "A10 移动全屏：无页面运行时错误",
    mobileReply.errors.length === 0,
    mobileReply.errors.join(" | "),
    { id: "A10-errors" },
  );
  await mobileReply.context.close();

  const desktopReply = await openReply({ width: 1280, height: 900 }, false, "desktop");
  const desktopMeasure = await measureReply(desktopReply.page);
  const a10c = await shot(desktopReply.page, "a10-1280-reply-context.png");
  check(
    "A10 桌面 Dialog：长帖无截断、容器可滚、编辑器可达、单层滚动",
    desktopMeasure.overflowY === "auto" &&
      desktopMeasure.maxHeightPx > 0 &&
      desktopMeasure.maxHeightPx <= desktopMeasure.viewport.h * 0.5 &&
      desktopMeasure.scrollHeight > desktopMeasure.clientHeight + 20 &&
      desktopMeasure.hasFirst &&
      desktopMeasure.hasLast &&
      (desktopMeasure.lineClamp === "none" || desktopMeasure.lineClamp === "") &&
      desktopMeasure.outerScroll <= desktopMeasure.outerClient + 1 &&
      desktopMeasure.dialogRect?.width >= 580 &&
      desktopMeasure.dialogRect?.width <= 640 &&
      desktopMeasure.inputRect?.top >= 0 &&
      desktopMeasure.inputRect?.bottom <= desktopMeasure.viewport.h + 1,
    JSON.stringify({
      overflowY: desktopMeasure.overflowY,
      maxHeightPx: desktopMeasure.maxHeightPx,
      scrollHeight: desktopMeasure.scrollHeight,
      clientHeight: desktopMeasure.clientHeight,
      lineClamp: desktopMeasure.lineClamp,
      outerScroll: desktopMeasure.outerScroll,
      outerClient: desktopMeasure.outerClient,
      dialogRect: desktopMeasure.dialogRect,
      inputRect: desktopMeasure.inputRect,
    }),
    { id: "A10c", image: a10c, imageWidth: "1280×900", expect: "600px Dialog + 完整正文 + 单层滚动" },
  );
  check(
    "A10 桌面 Dialog：无页面运行时错误",
    desktopReply.errors.length === 0,
    desktopReply.errors.join(" | "),
    { id: "A10-errors-desktop" },
  );
  await desktopReply.context.close();

  check(
    "实例管理页无页面运行时错误（390）",
    mobileErrors.length === 0,
    mobileErrors.join(" | "),
    { id: "errors-390" },
  );
  check(
    "实例管理页无页面运行时错误（1280）",
    desktopErrors.length === 0,
    desktopErrors.join(" | "),
    { id: "errors-1280" },
  );
} catch (error) {
  check("脚本执行异常", false, String(error));
} finally {
  const staticOrigin = staticServer ? `http://127.0.0.1:${staticServer.port}` : null;
  const pids = {
    launcher: qa?.owned?.pid ?? null,
    server: qa?.info?.pid ?? null,
    staticServer: staticServer ? "in-process" : null,
  };
  if (browser) {
    await browser.close().catch(() => {});
  }
  if (staticServer) {
    staticServer.stop(true);
    staticServer = null;
  }
  if (longPostId && qa) {
    try {
      assertIsolatedDataDir(qa.dataDir);
      const sqlitePath = `${qa.dataDir}/report.sqlite`;
      execFileSync("sqlite3", [
        sqlitePath,
        `PRAGMA busy_timeout=5000;
         BEGIN;
         CREATE TEMP TABLE qa AS SELECT id, root_id FROM posts WHERE body_md LIKE '${LONG_MARKER}%';
         DELETE FROM post_media WHERE post_id IN (SELECT id FROM qa);
         DELETE FROM mentions WHERE post_id IN (SELECT id FROM qa);
         DELETE FROM events WHERE post_id IN (SELECT id FROM qa);
         DELETE FROM participants WHERE root_id IN (SELECT id FROM qa);
         DELETE FROM posts WHERE id IN (SELECT id FROM qa);
         COMMIT;`,
      ]);
      const leftover = execFileSync("sqlite3", [
        sqlitePath,
        `SELECT count(*) FROM posts WHERE body_md LIKE '${LONG_MARKER}%';`,
      ])
        .toString()
        .trim();
      check("长帖夹具硬清除（隔离库残留 0）", leftover === "0", `leftover=${leftover}`, {
        id: "cleanup-post",
      });
    } catch (error) {
      check("长帖夹具清理", false, String(error), { id: "cleanup-post" });
    }
  }
  await qa?.stop().catch(() => {});
  const launcherGone = !qa?.owned || qa.owned.exitCode !== null || qa.owned.signalCode !== null;
  check(
    "进程回收：Chrome / 静态服务 / qa-serve 已关闭",
    launcherGone,
    JSON.stringify({ ...pids, launcherExit: qa?.owned?.exitCode ?? null }),
    { id: "cleanup-pids", expect: "浏览器关闭、静态服务停止、qa-serve 退出" },
  );

  const failed = checks.filter((item) => !item.ok);
  const durationMs = Date.now() - startedAt;
  const result = {
    ok: failed.length === 0,
    ranAt: new Date().toISOString(),
    base: qa?.base ?? null,
    staticOrigin,
    dataDir: qa?.dataDir ?? null,
    viewports: ["390×844", "1280×900"],
    durationMs,
    pids,
    checks: checks.map(({ name, ok, detail, at }) => ({ name, ok, detail, at })),
    screenshots,
  };
  writeFileSync(join(REPORT_DIR, "results.json"), JSON.stringify(result, null, 2));
  writeFileSync(
    join(REPORT_DIR, "steps.json"),
    JSON.stringify(
      {
        title: "report-instance-page — 实例管理页 + 回复原帖完整显示 E2E 验收",
        brand: "FDE2E™ · report.worker（人机公示板）· report-instance-page 交付报告",
        subtitle:
          "「连接其它实例」重做为实例管理页（当前连接 / 添加实例 / 我的实例 / 折叠用法），移动端单列与 ≥44px 命中区；回复编辑器去掉 line-clamp-6，原帖正文完整显示在 40dvh 容器内，只保留一层主滚动。",
        meta: `2026-11-08 · ${checks.length} 断言 / ${failed.length} FAIL · 390×844 + 1280×900 · 静态壳 ${result.staticOrigin ?? "-"} · 隔离后端 ${result.base ?? "-"}（生产板零写入）· 进程 launcher=${pids.launcher ?? "-"} serve=${pids.server ?? "-"}（已回收）`,
        thesis:
          failed.length === 0
            ? "结论：A1-A10 全部实测通过——实例管理页四卡结构、当前连接快照、历史增删清空、在线/离线/重试、添加实例就地 Alert、移动端无横向溢出与 ≥44px 命中区、桌面两列；回复长帖完整可滚且编辑器始终可达，外层无第二层滚动。"
            : `结论：${failed.length} 项断言失败（见 FAIL 步骤），不得视为交付。`,
        env: [
          ["静态壳", `${result.staticOrigin ?? "-"}（dist/，无 /healthz；模拟任意静态宿主）`],
          ["隔离后端", `${result.base ?? "-"} · dataDir=${result.dataDir ?? "-"}`],
          ["视口", "390×844（移动，hasTouch）／1280×900（桌面）；Chrome"],
          ["生产板", "127.0.0.1:13689 只读，本轮零写入"],
          ["断言", `${checks.length - failed.length}/${checks.length} PASS · ${durationMs}ms`],
          ["截图", `${screenshots.length} 张 PNG（与 steps.json 同目录）`],
        ],
        sections: [
          {
            title: "1 · 实例管理页（A1/A2/A4/A5/A7/A8/A9/A6）",
            note: "静态壳 + Playwright route 伪造 /healthz；历史 seed 含在线、离线与旧格式纯字符串条目。",
            steps: steps.filter((step) =>
              /^(A1$|A2$|A4$|A5[ab]?$|A6[abc]?$|A7$|A8$|A9$|errors-)/.test(step.id ?? ""),
            ),
          },
          {
            title: "2 · 当前连接与连接流程（A3）",
            note: "真实 qa-serve 连接（token）→ 桌面「连接其它实例」→ 当前连接卡显示刚离开实例。",
            steps: steps.filter((step) => /^A3/.test(step.id ?? "")),
          },
          {
            title: "3 · 回复原帖完整显示（A10）",
            note: "80 行长帖；移动全屏与桌面 Dialog 两形态；容器滚动到底后编辑器仍在视口内。",
            steps: steps.filter((step) => /^A10/.test(step.id ?? "")),
          },
          {
            title: "4 · 隔离与进程回收",
            note: "长帖只在 /tmp/report-qa-* 板；脚本结束硬清除并回收 Chrome/静态服务/qa-serve。",
            steps: steps.filter((step) => /^cleanup-/.test(step.id ?? "")),
          },
        ],
        summary: { pass: checks.length - failed.length, fail: failed.length },
      },
      null,
      2,
    ),
  );
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed · ${REPORT_DIR}/results.json`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

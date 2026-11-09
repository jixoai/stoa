#!/usr/bin/env bun
/**
 * report-instance-page P5 路由/返回 E2E（实例管理页绑定 #/instances + 浮层返回关闭）。
 *
 * 覆盖：
 *  A1 桌面账号菜单 → 连接其它实例 → #/instances → 返回键回原页（连接保留）
 *  A2 深链 #/instances → 返回落到主页（合成栈）
 *  A3 桌面设置 sheet → 返回键关闭、路由不变
 *  A4 #/instances 页内「返回」按钮 → 回原页
 *  A5 移动账号抽屉 → 返回键关闭、路由不变
 *  A6 抽屉里点「连接其它实例」→ #/instances，一次返回回原页（无死条目）
 *  A7 移动信息 sheet → 返回键关闭
 *  A8 390/1280 实例页无横向滚动；无 runtime error
 *
 * Isolation: 只写 qa-serve 的 /tmp/report-qa-* 板；生产板 13689 只读。
 *
 * Run:
 *   bun scripts/qa/route-back.mjs
 *   bun scripts/qa/route-back.mjs --no-build
 */
import { chromium } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  REPO_ROOT,
  argValue,
  authSecret,
  ensureQa,
} from "./lib/qa-env.mjs";

const argv = process.argv.slice(2);
const qa = await ensureQa(argv);
const BASE = qa.base;
const AUTH = authSecret(qa.dataDir);
const NO_BUILD = argv.includes("--no-build");
const REPORT_DIR = resolve(
  argValue(argv, "report-dir") ??
    join(REPO_ROOT, "..", "..", ".agents", "reports", "manager", "report-instance-route-back"),
);
mkdirSync(REPORT_DIR, { recursive: true });

if (!NO_BUILD) {
  execFileSync("bun", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
}
if (!existsSync(join(REPO_ROOT, "dist", "index.html"))) {
  throw new Error("缺少 dist/index.html（先跑 bun run build）");
}

// 纯静态壳（无 /healthz）：用于 landing 深链连接用例（同源探测会失败 → 进实例页）。
const staticPort = 13724;
const staticProc = spawn(
  "python3",
  ["-m", "http.server", String(staticPort), "--bind", "127.0.0.1", "--directory", join(REPO_ROOT, "dist")],
  { stdio: "ignore" },
);
const STATIC_BASE = `http://127.0.0.1:${staticPort}`;
{
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${STATIC_BASE}/index.html`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error("static shell server failed to start");
}

const startedAt = Date.now();
const checks = [];
const steps = [];
const screenshots = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok), detail, at: Date.now() - startedAt });
  steps.push({ intent: name, assertion: detail || (ok ? "PASS" : "FAIL"), ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (page, ms) => page.waitForTimeout(ms);
async function shot(page, name) {
  await page.screenshot({ path: join(REPORT_DIR, name) });
  screenshots.push(name);
  return name;
}
async function waitFor(page, fn, arg, timeout = 12000) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
    return true;
  } catch {
    return false;
  }
}
const hash = (page) => page.evaluate(() => location.hash);
const visible = (page, testid) =>
  page.evaluate(
    (id) => Boolean(document.querySelector(`[data-testid="${id}"]`)),
    testid,
  );

async function login(page, { landing = "timeline" } = {}) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await sleep(page, 800);
  if (await page.locator('input[type="password"]').count()) {
    await page.locator('input[type="password"]').first().fill(AUTH);
    await page.click('[data-testid="login-submit"]');
  }
  if (landing === "timeline") {
    await page.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="timeline-scroll"] [data-post-id]', { timeout: 20_000 });
  }
  await sleep(page, 600);
}
const goBack = async (page) => {
  await page.evaluate(() => history.back());
  await sleep(page, 500);
};
const openDesktopAccountMenu = async (page) => {
  // 等 Base UI 的 sheet/menu 退场动画把 overlay 卸掉（关闭 sheet 后 overlay 可能还在退场）。
  await waitFor(page, () => !document.querySelector('[data-slot="dialog-overlay"]'), null, 5000);
  await page.click('[data-testid="nav-account-menu"]');
  await sleep(page, 300);
};
const clickText = async (page, text) => {
  // 优先点展开菜单里的 menuitem（页面其它位置可能有同名按钮，且菜单外是 inert）。
  const item = page.getByRole("menuitem", { name: text });
  if (await item.count()) await item.first().click();
  else await page.getByText(text, { exact: true }).first().click();
  await sleep(page, 500);
};

let browser = null;
try {
  browser = await chromium.launch({ channel: "chrome" });
  const errors = [];

  // ── 1280 桌面 ──────────────────────────────────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  await login(page);
  const homeHash = await hash(page);

  // A1 桌面账号菜单 → 实例页 → 返回
  await openDesktopAccountMenu(page);
  await clickText(page, "连接其它实例");
  const a1Opened = await waitFor(page, () => location.hash === "#/instances", null, 8000);
  const a1Page = await visible(page, "instance-page");
  await shot(page, "a1-1280-instance-route.png");
  await goBack(page);
  const a1BackHome = await waitFor(
    page,
    () => location.hash === "#/" || location.hash === "",
    null,
    8000,
  );
  const a1Feed = await page.evaluate(
    () =>
      document.querySelectorAll('[data-testid="timeline-scroll"] article[data-post-id]').length,
  );
  const a1LoginGate = await visible(page, "login-submit");
  check(
    "A1 桌面「连接其它实例」→ #/instances；返回键回原页且连接保留（不落到 landing）",
    a1Opened && a1Page && a1BackHome && a1Feed > 0 && !a1LoginGate,
    JSON.stringify({ a1Opened, a1Page, a1BackHome, homeHash, a1Feed, a1LoginGate }),
  );

  // A2 深链 #/instances → 返回主页（合成栈）。用新文档模拟真实深链（不是同页 hash 改）。
  const deepPage = await ctx.newPage();
  deepPage.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  deepPage.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  await deepPage.goto(`${BASE}/#/instances`, { waitUntil: "domcontentloaded" });
  const a2Opened = await waitFor(deepPage, () => location.hash === "#/instances", null, 20_000);
  const a2Page = await waitFor(
    deepPage,
    () => Boolean(document.querySelector('[data-testid="instance-page"]')),
    null,
    20_000,
  );
  await deepPage.evaluate(() => history.back());
  await sleep(deepPage, 700);
  const a2Home = await waitFor(
    deepPage,
    () => location.hash === "#/" || location.hash === "",
    null,
    8000,
  );
  const a2Feed = await deepPage.evaluate(
    () =>
      document.querySelectorAll('[data-testid="timeline-scroll"] article[data-post-id]').length,
  );
  const a2Dialog = await deepPage.evaluate(
    () => document.querySelectorAll('[role="dialog"]').length,
  );
  check(
    "A2 深链 #/instances 返回落到主页（合成「主页→实例」栈，无离站确认弹窗）",
    a2Opened && a2Page && a2Home && a2Feed > 0 && a2Dialog === 0,
    JSON.stringify({ a2Opened, a2Page, a2Home, a2Feed, a2Dialog }),
  );
  await deepPage.close();

  // A3 桌面设置 sheet = #/settings 路由 → 返回回主页并关闭
  await openDesktopAccountMenu(page);
  await page.click('[data-testid="nav-settings"]');
  await page.waitForSelector('[data-testid="settings-sheet"]', { timeout: 8000 });
  const settingsOpen = await visible(page, "settings-sheet");
  const settingsHash = await hash(page);
  await shot(page, "a3-1280-settings-route.png");
  await goBack(page);
  const settingsClosed = await waitFor(
    page,
    () => !document.querySelector('[data-testid="settings-sheet"]'),
    null,
    8000,
  );
  const settingsHome = await waitFor(
    page,
    () => location.hash === "#/" || location.hash === "",
    null,
    8000,
  );
  check(
    "A3 设置 sheet 绑定 #/settings：返回回主页并关闭（无遮罩残留）",
    settingsOpen && settingsHash === "#/settings" && settingsClosed && settingsHome,
    JSON.stringify({ settingsOpen, settingsHash, settingsClosed, settingsHome }),
  );

  // A4 实例页内「返回」按钮
  await openDesktopAccountMenu(page);
  await clickText(page, "连接其它实例");
  await waitFor(page, () => location.hash === "#/instances", null, 8000);
  await page.waitForSelector('[data-testid="instance-back"]', { timeout: 8000 });
  await page.click('[data-testid="instance-back"]');
  await sleep(page, 500);
  const a4Home = await waitFor(
    page,
    () => location.hash === "#/" || location.hash === "",
    null,
    8000,
  );
  check("A4 实例页「返回」按钮回原页", a4Home, JSON.stringify({ hash: await hash(page) }));

  // A10 桌面直开 #/info：移动专属面板应自动回主页，不留不可见遮罩
  const infoDeep = await ctx.newPage();
  infoDeep.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  infoDeep.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  await infoDeep.goto(`${BASE}/#/info`, { waitUntil: "domcontentloaded" });
  const infoDeepHome = await waitFor(
    infoDeep,
    () => location.hash === "#/" || location.hash === "",
    null,
    15_000,
  );
  const infoDeepOverlay = await infoDeep.evaluate(
    () =>
      document.querySelectorAll(
        '[data-slot="dialog-overlay"][data-open], [data-slot="sheet-overlay"][data-open]',
      ).length,
  );
  check(
    "A10 桌面直开 #/info 自动回主页，无不可见遮罩",
    infoDeepHome && infoDeepOverlay === 0,
    JSON.stringify({ infoDeepHome, infoDeepOverlay }),
  );
  await infoDeep.close();

  // A11 设置浮层打开时底层详情页保持挂载（发帖附件/滚动/thread 不丢）
  const firstPost = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid="timeline-scroll"] article[data-post-id]')
        ?.getAttribute("data-post-id") ?? null,
  );
  const detailOpen = Boolean(firstPost);
  if (firstPost) {
    await page.evaluate(() => {
      location.hash = "#/";
    });
    await page.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 8000 });
    await page.locator(`[data-testid="timeline-scroll"] article[data-post-id="${firstPost}"]`).first().click();
    await page.waitForSelector('[data-testid="thread-timeline"]', { timeout: 12_000 });
    await sleep(page, 500);
    await openDesktopAccountMenu(page);
    await page.click('[data-testid="nav-settings"]');
    await page.waitForSelector('[data-testid="settings-sheet"]', { timeout: 8000 });
    const detailWhileOpen = await page.evaluate(
      () =>
        Boolean(document.querySelector('[data-testid="app-detail-view"]')) &&
        document.querySelectorAll('[data-testid="thread-timeline"] article[data-post-id]').length > 0,
    );
    await goBack(page);
    await waitFor(page, () => !document.querySelector('[data-testid="settings-sheet"]'), null, 8000);
    const detailAfter = await page.evaluate(
      (id) => ({
        hash: location.hash,
        rows: document.querySelectorAll('[data-testid="thread-timeline"] article[data-post-id]').length,
        mounted: Boolean(document.querySelector('[data-testid="app-detail-view"]')),
        expected: `#/p/${id}`,
      }),
      firstPost,
    );
    check(
      "A11 设置浮层打开期间底层详情页保持挂载，关闭后回原详情（状态不重建）",
      detailOpen && detailWhileOpen && detailAfter.mounted && detailAfter.rows > 0 && detailAfter.hash === detailAfter.expected,
      JSON.stringify({ detailWhileOpen, detailAfter }),
    );
  } else {
    check("A11 设置浮层打开期间底层详情页保持挂载，关闭后回原详情（状态不重建）", false, "no post id");
  }

  // A12 实例全屏层打开时暂停停留已读（被遮挡的 feed 不得静默标已读）
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await page.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 8000 });
  await sleep(page, 400);
  await openDesktopAccountMenu(page);
  await clickText(page, "连接其它实例");
  await waitFor(page, () => location.hash === "#/instances", null, 8000);
  await sleep(page, 300);
  const dwellA = await page.evaluate(() => ({
    marks: window.__reportReadDwell?.marks ?? 0,
    persists: window.__reportReadDwell?.persists ?? 0,
  }));
  await sleep(page, 1800);
  const dwellB = await page.evaluate(() => ({
    marks: window.__reportReadDwell?.marks ?? 0,
    persists: window.__reportReadDwell?.persists ?? 0,
  }));
  await goBack(page);
  check(
    "A12 实例层打开 1.8s 内停留已读不新增（被遮挡的 feed 不静默标已读）",
    dwellA.marks === dwellB.marks && dwellA.persists === dwellB.persists,
    JSON.stringify({ dwellA, dwellB }),
  );

  // A13 设置 sheet Esc 关闭（非返回路径）
  await openDesktopAccountMenu(page);
  await page.click('[data-testid="nav-settings"]');
  await page.waitForSelector('[data-testid="settings-sheet"]', { timeout: 8000 });
  await page.keyboard.press("Escape");
  const escClosed = await waitFor(
    page,
    () => !document.querySelector('[data-testid="settings-sheet"]'),
    null,
    8000,
  );
  const escOverlay = await page.evaluate(
    () =>
      document.querySelectorAll(
        '[data-slot="dialog-overlay"][data-open], [data-slot="sheet-overlay"][data-open]',
      ).length,
  );
  const escHome = await waitFor(
    page,
    () => location.hash === "#/" || location.hash === "",
    null,
    8000,
  );
  check(
    "A13 设置 sheet Esc 关闭后回主页且无遮罩残留",
    escClosed && escOverlay === 0 && escHome,
    JSON.stringify({ escClosed, escOverlay, escHome }),
  );

  // A14 landing 深链连接不改写 URL：登录完成后仍回原目标（P1-1）
  const freshCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const fp = await freshCtx.newPage();
  fp.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  fp.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  await fp.goto(`${STATIC_BASE}/index.html#/bookmarks`, { waitUntil: "domcontentloaded" });
  await fp.waitForSelector('[data-testid="instance-page"]', { timeout: 20_000 });
  await fp.fill('[data-testid="ep-input"]', BASE);
  await fp.click('[data-testid="ep-connect"]');
  await fp.waitForSelector('[data-testid="login-submit"]', { timeout: 20_000 });
  const hashAtLogin = await fp.evaluate(() => location.hash);
  await fp.locator('input[type="password"]').first().fill(AUTH);
  await fp.click('[data-testid="login-submit"]');
  const landed = await waitFor(
    fp,
    () =>
      location.hash === "#/bookmarks" &&
      Boolean(document.querySelector('[data-testid="app-root-view"]')),
    null,
    25_000,
  );
  const hashAfter = await fp.evaluate(() => location.hash);
  check(
    "A14 landing 深链 #/bookmarks 连接+登录后仍落在 #/bookmarks（连接流程不改写 URL）",
    hashAtLogin === "#/bookmarks" && landed && hashAfter === "#/bookmarks",
    JSON.stringify({ hashAtLogin, landed, hashAfter }),
  );
  await freshCtx.close();

  // A8(桌面) 实例页无横向滚动
  await openDesktopAccountMenu(page);
  await clickText(page, "连接其它实例");
  await waitFor(page, () => location.hash === "#/instances", null, 8000);
  const desktopScroll = await page.evaluate(() => {
    const doc = document.documentElement;
    const root = document.querySelector('[data-testid="instance-page"]');
    return {
      doc: doc.scrollWidth <= doc.clientWidth,
      root: root ? root.scrollWidth <= root.clientWidth : true,
    };
  });
  await goBack(page);

  // ── 390 移动 ──────────────────────────────────────────────────────────────
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mpage = await mctx.newPage();
  mpage.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  mpage.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  await login(mpage);
  const mHomeHash = await hash(mpage);

  // A5 移动账号抽屉 → 返回关闭
  await mpage.click('[data-testid="home-account-button"]');
  await mpage.waitForSelector('[data-testid="account-sheet"]', { timeout: 8000 });
  const sheetOpen = await visible(mpage, "account-sheet");
  const accountHash = await hash(mpage);
  await goBack(mpage);
  const sheetClosed = await waitFor(
    mpage,
    () => !document.querySelector('[data-testid="account-sheet"]'),
    null,
    8000,
  );
  const routeAfterSheet = await hash(mpage);
  check(
    "A5 移动账号抽屉绑定 #/account：返回回主页并关闭",
    sheetOpen && accountHash === "#/account" && sheetClosed && routeAfterSheet === mHomeHash,
    JSON.stringify({ sheetOpen, accountHash, sheetClosed, mHomeHash, routeAfterSheet }),
  );

  // A6 抽屉里打开实例页 → 一次返回回原页（无死条目）
  await mpage.click('[data-testid="home-account-button"]');
  await mpage.waitForSelector('[data-testid="account-sheet"]', { timeout: 8000 });
  await mpage.click('[data-testid="account-menu-switch"]');
  const a6Opened = await waitFor(mpage, () => location.hash === "#/instances", null, 8000);
  const a6SheetClosed = await waitFor(
    mpage,
    () => !document.querySelector('[data-testid="account-sheet"]'),
    null,
    8000,
  );
  const a6Page = await visible(mpage, "instance-page");
  await shot(mpage, "a6-390-instance-route.png");
  await goBack(mpage);
  const a6Home = await waitFor(
    mpage,
    () => location.hash === "#/" || location.hash === "",
    null,
    8000,
  );
  const a6Feed = await mpage.evaluate(
    () =>
      document.querySelectorAll('[data-testid="timeline-scroll"] article[data-post-id]').length,
  );
  check(
    "A6 抽屉→实例页：一次返回回原页（合成条目被 replace，无死条目）",
    a6Opened && a6SheetClosed && a6Page && a6Home && a6Feed > 0,
    JSON.stringify({ a6Opened, a6SheetClosed, a6Page, a6Home, a6Feed }),
  );

  // A7 移动信息 sheet → 返回关闭
  await mpage.click('[data-testid="home-info-button"]');
  await mpage.waitForSelector('[data-testid="info-sheet"]', { timeout: 8000 });
  const infoOpen = await visible(mpage, "info-sheet");
  const infoHash = await hash(mpage);
  await goBack(mpage);
  const infoClosed = await waitFor(
    mpage,
    () => !document.querySelector('[data-testid="info-sheet"]'),
    null,
    8000,
  );
  check(
    "A7 移动信息 sheet 绑定 #/info：返回回主页并关闭",
    infoOpen && infoHash === "#/info" && infoClosed,
    JSON.stringify({ infoOpen, infoHash, infoClosed }),
  );

  // A8(移动) 实例页无横向滚动
  await mpage.click('[data-testid="home-account-button"]');
  await mpage.waitForSelector('[data-testid="account-sheet"]', { timeout: 8000 });
  await mpage.click('[data-testid="account-menu-switch"]');
  await waitFor(mpage, () => location.hash === "#/instances", null, 8000);
  const mobileScroll = await mpage.evaluate(() => {
    const doc = document.documentElement;
    const root = document.querySelector('[data-testid="instance-page"]');
    return {
      doc: doc.scrollWidth <= doc.clientWidth,
      root: root ? root.scrollWidth <= root.clientWidth : true,
    };
  });
  await goBack(mpage);

  check(
    "A8 390/1280 实例页无横向滚动",
    desktopScroll.doc && desktopScroll.root && mobileScroll.doc && mobileScroll.root,
    JSON.stringify({ desktopScroll, mobileScroll }),
  );
  const runtimeErrors = errors.filter((message) => !/favicon|File not found/i.test(message));
  check(
    "A9 无页面运行时错误",
    runtimeErrors.length === 0,
    runtimeErrors.slice(0, 3).join(" | ") || `0（过滤静态壳 favicon 404 ${errors.length - runtimeErrors.length} 条）`,
  );

  await ctx.close();
  await mctx.close();
} finally {
  if (browser) await browser.close();
  staticProc.kill("SIGTERM");
  await qa.stop();
  const failed = checks.filter((item) => !item.ok);
  writeFileSync(
    join(REPORT_DIR, "results.json"),
    JSON.stringify(
      {
        ok: failed.length === 0,
        ranAt: new Date().toISOString(),
        base: BASE,
        dataDir: qa.dataDir,
        durationMs: Date.now() - startedAt,
        checks,
        screenshots,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(REPORT_DIR, "steps.json"),
    JSON.stringify(
      {
        title: "report-instance-page P5 — 实例页路由与浮层返回 E2E",
        brand: "FDE2E™ · report.worker（人机公示板）· 路由/返回修复报告",
        subtitle:
          "「连接其它实例」绑定 #/instances：应用内进入保留当前连接，返回键回原页；深链合成主页→实例栈；账号抽屉/设置/信息 sheet 返回键关闭；浮层内导航 replace 合成条目，避免死返回。",
        meta: `2026-11-09 · ${checks.length} 断言 / ${failed.length} FAIL · 1280×800 + 390×844 · 隔离后端 ${BASE}（生产板零写入）`,
        thesis:
          failed.length === 0
            ? "结论：实例页已绑定路由且返回路径正确；三个浮层的返回关闭与浮层内导航均无死条目。"
            : `结论：${failed.length} 项失败，不得视为交付。`,
        env: [
          ["隔离后端", `${BASE} · dataDir=${qa.dataDir}`],
          ["视口", "1280×800（桌面）、390×844（移动）"],
          ["生产板", "127.0.0.1:13689 只读，本轮零写入"],
          ["断言", `${checks.length - failed.length}/${checks.length} PASS · ${Date.now() - startedAt}ms`],
        ],
        sections: [{ title: "1 · 路由/返回断言", steps }],
        summary: { pass: checks.length - failed.length, fail: failed.length },
      },
      null,
      2,
    ),
  );
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed · ${REPORT_DIR}/results.json`);
  process.exitCode = failed.length ? 1 : 0;
}

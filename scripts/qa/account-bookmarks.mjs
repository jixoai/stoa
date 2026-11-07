/**
 * 账号抽屉 + 收藏 + InputGroup 重组验收（真实浏览器，可复现版）。
 *
 * Isolation: reads/writes ONLY the disposable backend from REPORT_QA_BASE, or
 * auto-starts scripts/qa/qa-serve.mjs (fresh /tmp/report-qa-* board). Bookmark
 * toggles stay inside the temp SQLite; the production board is never touched.
 *
 * Run:
 *   bun scripts/qa/account-bookmarks.mjs
 *   REPORT_QA_BASE=http://127.0.0.1:13688 bun scripts/qa/account-bookmarks.mjs
 *
 * a) 390 首页左上角是账号头像；点开账号抽屉（个人资料/收藏/连接与成员/主题/退出）
 * b) 收藏：卡片按钮 → 收藏页出现 → 取消收藏后即时移除
 * c) 搜索 / 发帖 / 登录的输入区全部是官方 InputGroup（input 在 [data-slot=input-group] 内）
 * d) 桌面：左栏账号菜单含个人资料/收藏
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, authSecret, ensureQa } from "./lib/qa-env.mjs";

const qa = await ensureQa(process.argv.slice(2));
const BASE = qa.base;
const EP = qa.base;
const AUTH = authSecret(qa.dataDir);
const OUT = process.env.REPORT_QA_OUT ?? path.join(REPO_ROOT, "src/ui/.qa/account-bookmarks");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

let browser = null;
const errors = [];
try {
  browser = await chromium.launch({ channel: "chrome" });

  async function makePage(viewport, mobile) {
    const ctx = await browser.newContext(
      mobile ? { viewport, hasTouch: true, isMobile: true } : { viewport },
    );
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text().slice(0, 200));
    });
    await page.goto(`${BASE}/?ep=${encodeURIComponent(EP)}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    if (await page.locator('input[type="password"]').count()) {
      await page.locator('input[type="password"]').first().fill(AUTH);
      await page.click('[data-testid="login-submit"]');
      await page.waitForTimeout(2500);
    }
    return { ctx, page };
  }

  const shot = (page, name) =>
    page.screenshot({ path: `${OUT}/${name}.png` }).then(() => console.log("shot", name));

  // ── a) 移动端账号头像 + 抽屉 ─────────────────────────────────────────────
  const { ctx, page } = await makePage({ width: 390, height: 844 }, true);
  // 清空既有收藏，保证「空态」断言可重复（隔离板内）
  await page.evaluate(() => {
    location.hash = "#/bookmarks";
  });
  await page.waitForTimeout(1300);
  for (let i = 0; i < 20; i++) {
    const btn = page
      .locator('[data-post-id] [data-testid="action-bookmark"][aria-pressed="true"]')
      .first();
    if ((await btn.count()) === 0) break;
    await btn.click();
    await page.waitForTimeout(450);
  }
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await page.waitForTimeout(900);

  check(
    "首页左上角是账号头像",
    (await page.locator('[data-testid="home-account-button"] img').count()) === 1,
  );
  check("首页不再显示 report 品牌字", !(await page.locator('[data-testid="home-brand"]').count()));
  await shot(page, "a1-home-avatar-390");

  await page.click('[data-testid="home-account-button"]');
  await page.waitForSelector('[data-testid="account-sheet"]', { timeout: 5000 });
  await page.waitForTimeout(400);
  const menu = await page.locator('[data-testid="account-sheet"]').innerText();
  check("抽屉含身份与菜单", /@owner/.test(menu) && /个人资料/.test(menu) && /收藏/.test(menu));
  check(
    "抽屉含连接与成员/主题/退出",
    /连接与成员/.test(menu) && /切换到深色|切换到浅色/.test(menu) && /退出登录/.test(menu),
  );
  await shot(page, "a2-account-sheet-390");

  const beforeDark = await page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  await page.click('[data-testid="account-menu-theme"]');
  const afterDark = await page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  check("抽屉可切换主题", beforeDark !== afterDark);
  await page.click('[data-testid="account-menu-theme"]');

  await page.click('[data-testid="account-menu-info"]');
  await page.waitForSelector('[data-testid="info-sheet"]', { timeout: 5000 });
  check("抽屉可打开连接与成员", true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // ── b) 收藏闭环 ───────────────────────────────────────────────────────────
  const card = page.locator("[data-post-id]").first();
  const postId = await card.getAttribute("data-post-id");
  await card.locator('[data-testid="action-bookmark"]').click();
  await page.waitForTimeout(700);
  const pressed = await card
    .locator('[data-testid="action-bookmark"]')
    .getAttribute("aria-pressed");
  check("卡片收藏按钮切换为已收藏", pressed === "true");
  await shot(page, "b1-bookmarked-390");

  await page.click('[data-testid="home-account-button"]');
  await page.waitForSelector('[data-testid="account-sheet"]');
  await page.click('[data-testid="account-menu-bookmarks"]');
  await page.waitForTimeout(1200);
  check("账号菜单进入收藏页", (await page.evaluate(() => location.hash)) === "#/bookmarks");
  check("收藏页列出刚收藏的帖子", (await page.locator(`[data-post-id="${postId}"]`).count()) === 1);
  await shot(page, "b2-bookmarks-390");

  await page.locator(`[data-post-id="${postId}"] [data-testid="action-bookmark"]`).click();
  await page.waitForTimeout(900);
  check("取消收藏后即时从列表移除", (await page.locator(`[data-post-id="${postId}"]`).count()) === 0);
  check(
    "收藏页显示空态",
    (await page.locator('[data-testid="feed-swap"]').innerText()).includes("还没有收藏"),
  );
  await shot(page, "b3-bookmarks-empty-390");
  await page.click('[data-testid="bookmarks-back"]');
  await page.waitForTimeout(900);

  // ── c) 搜索输入区 = InputGroup ───────────────────────────────────────────
  await page.locator('[data-testid="mobile-nav"] button:has-text("搜索")').click();
  await page.waitForTimeout(1000);
  const searchGroup = page.locator('[data-slot="input-group"] [data-testid="search-input"]');
  check("搜索输入在官方 InputGroup 内", (await searchGroup.count()) === 1);
  check(
    "搜索按钮在 InputGroup addon 内",
    (await page.locator('[data-slot="input-group"] [data-slot="input-group-addon"] button').count()) >=
      1,
  );
  await page.fill('[data-testid="search-input"]', "成果");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  check("搜索仍可用", (await page.evaluate(() => location.hash)).includes("q="));
  await shot(page, "c1-search-inputgroup-390");

  await page.evaluate(() => {
    location.hash = "#/compose";
  });
  await page.waitForTimeout(1200);
  check(
    "发帖正文在官方 InputGroup 内",
    (await page.locator('[data-slot="input-group"] [data-testid="composer-input"]').count()) === 1,
  );
  check(
    "发布按钮在 InputGroup 内",
    (await page.locator('[data-slot="input-group"] [data-testid="composer-submit"]').count()) === 1,
  );
  await shot(page, "c2-composer-inputgroup-390");
  await ctx.close();

  // ── 登录页 InputGroup（新会话） ──────────────────────────────────────────
  const fresh = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const lp = await fresh.newPage();
  lp.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await lp.goto(`${BASE}/?ep=${encodeURIComponent(EP)}`, { waitUntil: "domcontentloaded" });
  await lp.waitForTimeout(1200);
  if (await lp.locator('input[type="password"]').count()) {
    check(
      "登录密码框在 InputGroup 内",
      (await lp.locator('[data-slot="input-group"] [data-testid="login-secret"]').count()) === 1,
    );
    check(
      "登录按钮在 InputGroup addon 内",
      (await lp.locator('[data-slot="input-group"] [data-testid="login-submit"]').count()) === 1,
    );
    await lp.screenshot({ path: `${OUT}/d1-login-inputgroup-390.png` });
  } else {
    check("登录页出现（可验收）", false, "未进入登录门");
  }
  await fresh.close();

  // ── d) 桌面左栏账号菜单 ──────────────────────────────────────────────────
  const { ctx: dctx, page: dp } = await makePage({ width: 1440, height: 900 }, false);
  await dp.click('aside button:has-text("@owner")').catch(async () => {
    await dp.locator("aside button").last().click();
  });
  await dp.waitForTimeout(400);
  const dm = await dp.locator('[role="menu"]').innerText().catch(() => "");
  check(
    "桌面账号菜单含个人资料/收藏",
    /个人资料/.test(dm) && /收藏/.test(dm),
    dm.slice(0, 60).replace(/\n/g, " / "),
  );
  await dp.screenshot({ path: `${OUT}/e1-desktop-menu-1440.png` });
  await dctx.close();

  check("无页面运行时错误", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  if (browser) await browser.close();
  await qa.stop();
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, errors }, null, 2));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;

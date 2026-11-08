/**
 * 沉浸式回复编辑器验收：默认收起 / 意图展开 / 移动全屏 / 桌面 Dialog / 提交 / 返回关闭。
 *
 * Isolation: writes ONLY the disposable backend from REPORT_QA_BASE, or
 * auto-starts scripts/qa/qa-serve.mjs (fresh /tmp/report-qa-* board). The QA
 * reply is deleted through the API and hard-purged from the temp SQLite store;
 * the production board is never contacted.
 *
 * Run:
 *   bun scripts/qa/reply-composer.mjs
 *   REPORT_QA_BASE=http://127.0.0.1:13688 bun scripts/qa/reply-composer.mjs
 *   bun scripts/qa/reply-composer.mjs --post=<id>     # override target post
 */
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import {
  accountToken,
  apiJson,
  argValue,
  assertIsolatedDataDir,
  authSecret,
  ensureQa,
} from "./lib/qa-env.mjs";

const qa = await ensureQa(process.argv.slice(2));
const BASE = qa.base;
const AUTH = authSecret(qa.dataDir);
const ownerToken = accountToken(qa.dataDir, "owner");

let POST = argValue(process.argv.slice(2), "post");
if (!POST) {
  const read = await apiJson(BASE, "/api/read?limit=50", ownerToken);
  const root = (read.posts ?? []).find((post) => post.parent_id === null && !post.deleted_at);
  if (!root) throw new Error("isolated fixtures have no root post to reply to");
  POST = root.id;
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

let browser = null;
let text = "";
try {
  browser = await chromium.launch({ channel: "chrome" });
  const errors = [];
  const openPage = async (viewport, mobile) => {
    const ctx = await browser.newContext({
      viewport,
      hasTouch: mobile,
      isMobile: mobile,
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text().slice(0, 160));
    });
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    if (await page.locator('input[type="password"]').count()) {
      await page.locator('input[type="password"]').first().fill(AUTH);
      await page.click('[data-testid="login-submit"]');
      await page.waitForTimeout(2400);
    }
    return { ctx, page };
  };
  const goto = async (page, hash) => {
    await page.evaluate((h) => {
      location.hash = h;
    }, hash);
    await page.waitForTimeout(1400);
  };

  // ── 移动端 ────────────────────────────────────────────────────────────────
  const mobile = await openPage({ width: 390, height: 844 }, true);
  const page = mobile.page;
  await goto(page, `#/p/${POST}`);

  check(
    "默认不展示回复输入框",
    (await page.locator('[data-testid="composer-input"]').count()) === 0,
  );
  check("默认展示收起入口", await page.locator('[data-testid="reply-open"]').isVisible());
  check("旧常驻回复框已移除", (await page.locator('[data-testid="reply-box"]').count()) === 0);

  await page.click('[data-testid="reply-open"]');
  await page.waitForTimeout(450);
  check(
    "点击意图入口展开编辑器",
    await page.locator('[data-testid="reply-composer"]').isVisible(),
  );
  const box = await page.locator('[data-testid="reply-composer"]').boundingBox();
  check(
    "移动端全屏（390×844）",
    box && Math.abs(box.width - 390) <= 2 && Math.abs(box.height - 844) <= 2,
    JSON.stringify(box),
  );
  const replyTo = (await page.locator('[data-testid="reply-to-line"]').innerText()).replace(
    /\s+/g,
    " ",
  );
  check("展示回复给 @author", /回复给 @\w+/.test(replyTo), replyTo);
  const submitButton = page.locator('[data-testid="reply-submit"]');
  const submitOwnership = await page.evaluate(() => {
    const shell = document.querySelector('[data-testid="reply-composer"]');
    const submit = document.querySelector('[data-testid="reply-submit"]');
    const topbar = shell?.querySelector("header");
    return {
      submitExists: Boolean(submit),
      inInputGroup: Boolean(submit?.closest('[data-slot="input-group"]')),
      topbarSubmitCount: topbar
        ? topbar.querySelectorAll('[data-testid="reply-submit"], [data-testid="composer-submit"]').length
        : -1,
    };
  });
  check("顶部只有关闭（X）", (await page.locator('[data-testid="reply-close"]').count()) === 1);
  check(
    "提交按钮祖先含 [data-slot=input-group]",
    submitOwnership.submitExists && submitOwnership.inInputGroup,
    JSON.stringify(submitOwnership),
  );
  check(
    "顶部栏内 submit 数 = 0",
    submitOwnership.topbarSubmitCount === 0,
    JSON.stringify(submitOwnership),
  );
  check("空正文提交禁用", await submitButton.isDisabled());
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return el?.getAttribute("data-testid") ?? el?.tagName ?? null;
  });
  check("编辑器自动聚焦", focused === "composer-input", String(focused));

  text = `QA 沉浸式回复自检 ${Date.now()}`;
  await page.locator('[data-testid="composer-input"]').fill(text);
  await page.waitForTimeout(150);
  check("有正文后可提交", await submitButton.isEnabled());

  // 上传中禁用：拦截媒体请求制造 1.2s 上传窗口，验证 busy/uploadsPending 态。
  await page.route("**/api/media**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await page.locator('[data-testid="composer-file"]').setInputFiles({
    name: "qa.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await page.waitForTimeout(250);
  check("上传中提交禁用", await submitButton.isDisabled());
  await page.waitForTimeout(1800);
  await page.unroute("**/api/media**");
  check("上传完成且有正文后可提交", await submitButton.isEnabled());
  const removeAttachment = page.locator('button[aria-label="移除 qa.png"]');
  if ((await removeAttachment.count()) > 0) {
    await removeAttachment.first().click();
    await page.waitForTimeout(200);
  }

  const parseReplyCount = (value) => {
    const match = /(\d+)\s*条回复/.exec(value);
    return match ? Number(match[1]) : 0;
  };
  const countBeforeText = await page.locator('[data-testid="reply-count"]').innerText();
  const countBefore = parseReplyCount(countBeforeText);
  await page.click('[data-testid="reply-submit"]');
  await page.waitForTimeout(1600);
  check("提交后编辑器关闭", (await page.locator('[data-testid="reply-composer"]').count()) === 0);
  const threadText = await page.locator('[data-testid="thread-scroll"]').innerText();
  check("新回复出现在列表", threadText.includes(text), text);
  const countAfter = parseReplyCount(
    await page.locator('[data-testid="reply-count"]').innerText(),
  );
  check(
    "回复计数已刷新（数值 +1）",
    countAfter === countBefore + 1,
    `${countBeforeText} → ${countAfter}`,
  );

  // 清理：删掉刚才的 QA 回复（API 软删 + 隔离库硬清除）
  const cleanup = await page.evaluate(async (needle) => {
    const card = [...document.querySelectorAll("[data-post-id]")].find((el) =>
      el.textContent?.includes(needle),
    );
    const id = card?.getAttribute("data-post-id");
    if (!id) return "no-card";
    const ep = new URL(location.href).searchParams.get("ep") ?? "";
    const token = Object.entries(localStorage).find(
      ([key, value]) => /token/i.test(key) && typeof value === "string" && value.length > 20,
    )?.[1];
    const res = await fetch(`${ep}/api/posts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return `${id}:${res.status}`;
  }, text);
  check("QA 回复已清理", cleanup.endsWith(":200"), cleanup);

  // 返回键关闭（再次打开）
  await page.click('[data-testid="reply-open"]');
  await page.waitForTimeout(450);
  const hashBefore = await page.evaluate(() => location.hash);
  check("再次打开编辑器", await page.locator('[data-testid="reply-composer"]').isVisible());
  await page.evaluate(() => history.back());
  await page.waitForTimeout(700);
  check("返回键关闭编辑器", (await page.locator('[data-testid="reply-composer"]').count()) === 0);
  check(
    "返回关闭后仍在帖子详情",
    (await page.evaluate(() => location.hash)) === hashBefore,
    hashBefore,
  );

  // X 关闭
  await page.click('[data-testid="reply-open"]');
  await page.waitForTimeout(450);
  await page.click('[data-testid="reply-close"]');
  await page.waitForTimeout(500);
  check("X 关闭编辑器", (await page.locator('[data-testid="reply-composer"]').count()) === 0);

  // ?reply=1 深链意图
  await goto(page, `#/p/${POST}?reply=1`);
  check("?reply=1 自动展开", await page.locator('[data-testid="reply-composer"]').isVisible());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check("Esc 关闭编辑器", (await page.locator('[data-testid="reply-composer"]').count()) === 0);
  await mobile.ctx.close();

  // ── 桌面端 ────────────────────────────────────────────────────────────────
  const desktop = await openPage({ width: 1280, height: 900 }, false);
  await goto(desktop.page, `#/p/${POST}`);
  check(
    "桌面：默认收起",
    (await desktop.page.locator('[data-testid="reply-open"]').isVisible()) &&
      (await desktop.page.locator('[data-testid="composer-input"]').count()) === 0,
  );
  await desktop.page.click('[data-testid="reply-open"]');
  await desktop.page.waitForTimeout(450);
  const dbox = await desktop.page.locator('[data-testid="reply-composer"]').boundingBox();
  check(
    "桌面：居中 Dialog（约 600px，不铺满）",
    dbox && dbox.width >= 580 && dbox.width <= 640 && dbox.width < 1200,
    JSON.stringify(dbox),
  );
  check(
    "桌面：上下文与回复目标可见",
    await desktop.page.locator('[data-testid="reply-to-line"]').isVisible(),
  );
  await desktop.page.keyboard.press("Escape");
  await desktop.page.waitForTimeout(400);
  check(
    "桌面：Esc 关闭",
    (await desktop.page.locator('[data-testid="reply-composer"]').count()) === 0,
  );
  await desktop.ctx.close();

  check("无页面运行时错误", errors.length === 0, errors.slice(0, 3).join(" | "));

  // 硬清除本次 QA 回复（只允许隔离数据目录）
  assertIsolatedDataDir(qa.dataDir);
  const sqlitePath = `${qa.dataDir}/report.sqlite`;
  execFileSync("sqlite3", [
    sqlitePath,
    `PRAGMA busy_timeout=5000;
     BEGIN;
     CREATE TEMP TABLE qa AS SELECT id FROM posts WHERE body_md LIKE 'QA 沉浸式回复自检%';
     DELETE FROM events WHERE post_id IN (SELECT id FROM qa);
     DELETE FROM mentions WHERE post_id IN (SELECT id FROM qa);
     DELETE FROM posts WHERE id IN (SELECT id FROM qa);
     COMMIT;`,
  ]);
  const leftover = execFileSync("sqlite3", [
    sqlitePath,
    "SELECT count(*) FROM posts WHERE body_md LIKE 'QA 沉浸式回复自检%';",
  ])
    .toString()
    .trim();
  check("QA 回复硬清除（隔离库残留 0）", leftover === "0", `leftover=${leftover}`);
} finally {
  if (browser) await browser.close();
  await qa.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;

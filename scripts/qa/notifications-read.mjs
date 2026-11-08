/**
 * 「打开详情即已读」+「未读/全部筛选」验收（Owner 2026-11-07 两条要求）。
 *
 * Isolation: this script NEVER touches the production board. It uses the
 * backend from REPORT_QA_BASE (or auto-starts scripts/qa/qa-serve.mjs, which
 * seeds a disposable /tmp/report-qa-* board). Seeded QA replies are hard-purged
 * from that temp SQLite store at the end — never from production.
 *
 * Run:
 *   bun scripts/qa/notifications-read.mjs
 *   REPORT_QA_BASE=http://127.0.0.1:13688 bun scripts/qa/notifications-read.mjs
 *
 * 种子策略：以 manager 身份在自有的汇报帖下回一条 @owner 的 QA 回复 → 产生 owner 的通知；
 * 跑完把种子帖与事件硬清除（隔离板内不留墓碑、不留通知）。
 */
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import {
  accountToken,
  apiJson,
  assertIsolatedDataDir,
  authSecret,
  ensureQa,
} from "./lib/qa-env.mjs";

const qa = await ensureQa(process.argv.slice(2));
const BASE = qa.base;
const AUTH = authSecret(qa.dataDir);
const managerToken = accountToken(qa.dataDir, "manager");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// Pick a manager root post from the isolated fixtures (no hardcoded prod ids).
const read = await apiJson(BASE, "/api/read?author=manager&limit=50", managerToken);
const parent = (read.posts ?? []).find((post) => post.parent_id === null && !post.deleted_at);
if (!parent) throw new Error("isolated fixtures have no manager root post");
const PARENT = parent.id;

const SEED_TAG = `QA-READ-${Date.now()}`;

async function seedReply() {
  const body = await apiJson(BASE, `/api/posts/${PARENT}/replies`, managerToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: `@owner ${SEED_TAG} 读态验收种子`, media: [], tags: [] }),
  });
  return body.posts[0].id;
}

let browser = null;
try {
  browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const errors = [];
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

  const seedA = await seedReply();
  await page.evaluate(() => {
    location.hash = "#/notifications";
  });
  await page.waitForTimeout(1800);

  const badgeText = async () => {
    const badge = page.locator('[data-testid="notifications-unread-badge"]');
    return (await badge.count()) ? Number((await badge.innerText()).trim()) : 0;
  };
  const unreadIds = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="notification-row"][data-read="0"]')].map((el) =>
        el.getAttribute("data-post-id"),
      ),
    );

  const before = await badgeText();
  check("种子后角标 ≥1", before >= 1, `badge=${before}`);
  check("种子帖在未读列表里", (await unreadIds()).includes(seedA), `seed=${seedA}`);

  // ① 从通知点进详情 → 返回：该帖离开未读、角标 -1
  await page.locator(`[data-testid="notification-row"][data-post-id="${seedA}"]`).first().click();
  await page.waitForTimeout(1200);
  check("点通知进入详情", (await page.evaluate(() => location.hash)).includes(seedA));
  await page.click('[data-testid="thread-back"]');
  await page.waitForTimeout(1200);
  const after1 = await badgeText();
  check("返回后角标 -1", after1 === before - 1, `${before} → ${after1}`);
  check("该帖不在未读筛选里", !(await unreadIds()).includes(seedA));

  // 全部筛选里保留且标已读
  await page.click('[data-testid="notifications-scope-all"]');
  await page.waitForTimeout(600);
  const rowAll = page.locator(`[data-testid="notification-row"][data-post-id="${seedA}"]`);
  check("「全部」里保留该行", (await rowAll.count()) >= 1);
  check("该行标为已读（降噪）", (await rowAll.first().getAttribute("data-read")) === "1");
  await page.click('[data-testid="notifications-scope-unread"]');
  await page.waitForTimeout(400);

  // ② 从时间线（非通知）进详情同样标已读
  const seedB = await seedReply();
  // 让通知页重新取一次（页面只在进入时 re-peek）：回主页再进通知页
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    location.hash = "#/notifications";
  });
  await page.waitForTimeout(1600);
  const beforeB = await badgeText();
  check("②种子进入未读（前提）", beforeB >= 1, `badge=${beforeB}`);
  await page.evaluate((id) => {
    location.hash = `#/p/${id}`;
  }, seedB);
  // report-read-dwell：已读不再由路由进入触发，改由卡片视窗停留达标（阈值上限
  // 1500ms）——显式等 data-read="1"，不再用固定 1600ms（余量仅 100ms）。
  await page.waitForFunction(
    (id) =>
      Boolean(
        document.querySelector(
          `[data-testid="thread-timeline"] [data-post-id="${CSS.escape(id)}"][data-read="1"]`,
        ),
      ),
    seedB,
    { timeout: 6000 },
  );
  check("直接进详情（非通知入口）", (await page.evaluate(() => location.hash)).includes(seedB));
  check(
    "详情停留达标后标已读",
    (await page.locator(`[data-testid="thread-timeline"] [data-post-id="${seedB}"][data-read="1"]`).count()) >= 1,
  );
  await page.evaluate(() => {
    location.hash = "#/notifications";
  });
  await page.waitForTimeout(1500);
  const afterB = await badgeText();
  check("时间线入口同样标已读（角标 -1）", afterB === beforeB - 1, `${beforeB} → ${afterB}`);
  check("该帖也不在未读筛选里", !(await unreadIds()).includes(seedB));

  check("无页面运行时错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();

  // 清理：只在隔离数据目录内硬清除种子（临时目录，跑完即可丢弃）。
  assertIsolatedDataDir(qa.dataDir);
  const sqlitePath = `${qa.dataDir}/report.sqlite`;
  execFileSync("sqlite3", [
    sqlitePath,
    `PRAGMA busy_timeout=5000;
     BEGIN;
     CREATE TEMP TABLE qa AS SELECT id, root_id, author FROM posts WHERE body_md LIKE '%${SEED_TAG}%';
     DELETE FROM events WHERE post_id IN (SELECT id FROM qa);
     DELETE FROM mentions WHERE post_id IN (SELECT id FROM qa);
     DELETE FROM participants WHERE root_id IN (SELECT root_id FROM qa) OR account_id IN (SELECT author FROM qa);
     DELETE FROM posts WHERE id IN (SELECT id FROM qa);
     COMMIT;`,
  ]);
  const leftover = execFileSync("sqlite3", [
    sqlitePath,
    `SELECT (SELECT count(*) FROM posts WHERE body_md LIKE '%${SEED_TAG}%') || '/' ||
            (SELECT count(*) FROM events WHERE post_id IN (SELECT id FROM posts WHERE body_md LIKE '%${SEED_TAG}%')) || '/' ||
            (SELECT count(*) FROM mentions WHERE post_id IN (SELECT id FROM posts WHERE body_md LIKE '%${SEED_TAG}%'));`,
  ])
    .toString()
    .trim();
  check("种子已清（posts/events/mentions 残留）", leftover === "0/0/0", `leftover=${leftover}`);
} finally {
  if (browser) await browser.close();
  await qa.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;

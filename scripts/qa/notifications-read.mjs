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
  // report-notification-stacks：种子可能落进多成员叠（共同未读祖先）——未读集合要同时
  // 读单成员行与叠的 data-unread-member-ids（叠内成员行始终在 DOM，`*` 标记兼容）。
  const unreadIds = async () =>
    page.evaluate(() => {
      const ids = [...document.querySelectorAll('[data-testid="notification-row"][data-read="0"]')]
        .map((el) => el.getAttribute("data-post-id"))
        .filter(Boolean);
      for (const stack of document.querySelectorAll('[data-testid="notification-stack"]')) {
        const raw = stack.getAttribute("data-unread-member-ids") ?? "";
        for (const id of raw.split(",")) if (id) ids.push(id);
      }
      return ids;
    });
  /** 某帖的入口存在性（单成员行或叠成员）。 */
  const entryCount = async (postId) =>
    page.evaluate((id) => {
      if (document.querySelector(`[data-testid="notification-row"][data-post-id="${CSS.escape(id)}"]`)) return 1;
      const stacks = [...document.querySelectorAll('[data-testid="notification-stack"]')];
      return stacks.filter((el) => (el.getAttribute("data-member-ids") ?? "").split(",").includes(id)).length;
    }, postId);
  /** 某帖的已读态：单成员行 data-read，或叠成员行 data-read（折叠也渲染，可直读）。 */
  const readStateOf = async (postId) =>
    page.evaluate((id) => {
      const row = document.querySelector(`[data-testid="notification-row"][data-post-id="${CSS.escape(id)}"]`);
      if (row) return row.getAttribute("data-read");
      const member = document.querySelector(
        `[data-testid="notification-stack-member"][data-post-id="${CSS.escape(id)}"]`,
      );
      return member ? member.getAttribute("data-read") : null;
    }, postId);
  /** 点击某帖的通知入口：单成员行直接点；多成员叠先展开再点成员行。 */
  const openNotificationFor = async (postId) => {
    const rowLoc = page.locator(`[data-testid="notification-row"][data-post-id="${postId}"]`);
    if (await rowLoc.count()) {
      await rowLoc.first().click();
      return "row";
    }
    const stackIndex = await page.evaluate((id) => {
      const stacks = [...document.querySelectorAll('[data-testid="notification-stack"]')];
      return stacks.findIndex((el) => (el.getAttribute("data-member-ids") ?? "").split(",").includes(id));
    }, postId);
    if (stackIndex < 0) throw new Error(`no notification entry for ${postId}`);
    const stack = page.locator('[data-testid="notification-stack"]').nth(stackIndex);
    const toggle = stack.locator('[data-testid="notification-stack-toggle"]');
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
      await page.waitForTimeout(260); // 180ms 展开动画余量
    }
    await stack
      .locator(`[data-testid="notification-stack-member"][data-post-id="${postId}"]`)
      .first()
      .click();
    return "stack-member";
  };
  /** 点击后等 dwell 把该帖读掉（D11：点击本身不写已读）。 */
  const waitThreadRead = (postId) =>
    page.waitForFunction(
      (id) =>
        Boolean(
          document.querySelector(
            `[data-testid="thread-timeline"] article[data-post-id="${CSS.escape(id)}"][data-read="1"]`,
          ),
        ),
      postId,
      { timeout: 8000 },
    );

  const before = await badgeText();
  check("种子后角标 ≥1", before >= 1, `badge=${before}`);
  check("种子帖在未读列表里", (await unreadIds()).includes(seedA), `seed=${seedA}`);

  // ① 从通知点进详情 → 停留达标已读 → 返回：该帖离开未读、角标 -1
  const entryKind = await openNotificationFor(seedA);
  await waitThreadRead(seedA);
  check("点通知进入详情", (await page.evaluate(() => location.hash)).includes(seedA));
  await page.click('[data-testid="thread-back"]');
  await page.waitForTimeout(1200);
  const after1 = await badgeText();
  check("返回后角标 -1", after1 === before - 1, `${before} → ${after1}（entry=${entryKind}）`);
  check("该帖不在未读筛选里", !(await unreadIds()).includes(seedA));

  // 全部筛选里保留且标已读
  await page.click('[data-testid="notifications-scope-all"]');
  await page.waitForTimeout(600);
  check("「全部」里保留该行", (await entryCount(seedA)) >= 1);
  check("该行标为已读（降噪）", (await readStateOf(seedA)) === "1");
  await page.click('[data-testid="notifications-scope-unread"]');
  await page.waitForTimeout(400);

  // ② 从时间线（非通知）进详情同样标已读
  const seedB = await seedReply();
  // 登录后首屏 fixture 早已被停留读完：另种两个全新根帖作为「可见邻居卡」，
  // 用于断言详情覆盖层不会误标底层 feed。
  const seedNeighbors = [];
  for (let i = 0; i < 2; i += 1) {
    const result = await apiJson(BASE, "/api/posts", managerToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
          body: `@owner ${SEED_TAG} 邻居卡 ${i + 1}（详情覆盖层隔离）\n${"长正文用于把停留阈值拉到 1500ms。".repeat(12)}`,
        media: [],
        tags: ["result"],
      }),
    });
    seedNeighbors.push(result.posts[0].id);
  }
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

  // 从 home feed 出发进详情（不是通知页起点）；记录底层根页可见未读卡，
  // report-read-dwell 的详情覆盖层 scoped hold 必须让它们保持未读。
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await page.waitForSelector('[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id]', {
    timeout: 15_000,
  });
  await page.waitForSelector(
    `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${seedNeighbors[0]}"]`,
    { timeout: 10_000 },
  );
  await page.evaluate(() => {
    const scroller = document.querySelector(
      '[data-testid="app-root-view"] [data-testid="timeline-scroll"]',
    );
    if (scroller) scroller.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  const neighborIds = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="app-root-view"] article[data-post-id][data-read="0"]')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0) > 0;
      })
      .map((el) => el.getAttribute("data-post-id")),
  );
  check(
    "② home feed 有可见未读邻居卡（前提）",
    neighborIds.length > 0 && seedNeighbors.some((id) => neighborIds.includes(id)),
    `neighbors=${neighborIds.length} seeds=${seedNeighbors.join(",")}`,
  );

  await page.evaluate((id) => {
    location.hash = `#/p/${id}`;
  }, seedB);
  // report-read-dwell：已读不再由路由进入触发，改由卡片视窗停留达标（阈值上限
  // 1500ms）——显式等 data-read="1"，不再用固定 1600ms（余量仅 100ms）。
  await page.waitForFunction(
    (id) =>
      Boolean(
        document.querySelector(
          `[data-testid="thread-timeline"] article[data-post-id="${CSS.escape(id)}"][data-read="1"]`,
        ),
      ),
    seedB,
    { timeout: 6000 },
  );
  check("直接进详情（非通知入口）", (await page.evaluate(() => location.hash)).includes(seedB));
  check(
    "详情停留达标后标已读",
    (await page.locator(`[data-testid="thread-timeline"] article[data-post-id="${seedB}"][data-read="1"]`).count()) >= 1,
  );
  const neighborAfter = await page.evaluate((ids) => {
    const readSet = new Set();
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith("report.read.v1:")) continue;
        try {
          for (const id of JSON.parse(localStorage.getItem(key) ?? "[]")) readSet.add(id);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return ids.map((id) => ({
      id,
      attr: document
        .querySelector(
          `[data-testid="app-root-view"] article[data-post-id="${CSS.escape(id)}"]`,
        )
        ?.getAttribute("data-read"),
      inReadSet: readSet.has(id),
    }));
  }, neighborIds);
  check(
    "②详情停留不误标底层邻居卡",
    neighborAfter.every((row) => row.attr === "0" && !row.inReadSet),
    JSON.stringify(neighborAfter),
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

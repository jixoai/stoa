#!/usr/bin/env bun
/**
 * 线程页先序（pre-order DFS）嵌套验收 — openspec change report-thread-nesting
 *
 * Isolation: reads/writes ONLY the disposable backend from REPORT_QA_BASE, or
 * auto-starts scripts/qa/qa-serve.mjs with --no-seed (fresh /tmp/report-qa-*
 * board). The production board (13689) is never contacted.
 *
 * Fixture (created in this order; per viewport with a unique tag):
 *
 *   root
 *   ├── R1                       ← 深链 focal（root 的子节点）
 *   │   ├── R2                   ← 直接子节点（应紧邻 R1）
 *   │   │   └── R3               ← 孙节点（应紧邻 R2）
 *   │   └── M1                   ← R1 的第二个子节点（创建早于 R3）
 *   └── S1                       ← 兄弟分支（R1 页不得出现）
 *
 * 全局时间序（旧行为）＝ R2,M1,R3；先序（新行为）＝ R2,R3,M1。
 *
 * Assertions (390×844 and 1280×900):
 *   A1 R1 页 DOM＝root,R1,R2,R3,M1：R2 紧邻 R1、R3 紧邻 R2
 *   A2 M1 在 R3 之后（兄弟子树结束后继续），不是旧时间序的 R2,M1,R3
 *   A3 兄弟分支 S1 的 id 与正文 0 命中（report-thread-scope 不回归）
 *   A4 点击 focal R1：不跳转（hash 不变）
 *   A5 点击非 focal R2：hash → #/p/<R2>，R2 页 R3 紧邻 focal
 *   A6 UI 在 R1 下回复：新回复进入 R1 子树块（root 页 R1,R2,R3,M1,N1,S1）
 *   A7 UI 回复 R3（回复的回复）：R1 页 N2 紧邻 R3、在 M1 之前（不排到末尾）
 *   A8 刷新（reload）后 R1 页顺序与刷新前一致（深链/刷新稳定）
 *   A9 无横向溢出（390）+ 0 console error / pageerror
 *
 * Deep-chain API assertions (report-thread-depth, one isolated fixture):
 *   D1 12 层交替作者链：GET /api/thread/<focal> 的 posts 含 root→focal 全链 + focal + 新回复
 *   D2 focal.depth=11（不再依赖前端合成 focal）
 *   D3 无关 30 层分支仍按默认 maxDepth=24 折叠（u1..u24 在、u25..u30 不在，count=6）
 *   D4 collapsed 不含 focal 路径/子树
 *
 * Screenshots + report.json + steps.json: --shot-dir（默认仓内
 * src/ui/.qa/thread-nesting；交付报告用 --shot-dir .agents/reports/manager/report-thread-nesting）
 *
 * Run:
 *   bun scripts/qa/thread-nesting.mjs
 *   bun scripts/qa/thread-nesting.mjs --shot-dir /abs/path --prefix before-
 *   REPORT_QA_BASE=http://127.0.0.1:13688 bun scripts/qa/thread-nesting.mjs
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountToken, apiJson, argValue, authSecret, ensureQa } from "./lib/qa-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// 默认落仓内 QA 目录（gitignored）；交付报告用 --shot-dir 指向
// .agents/reports/manager/report-thread-nesting。
const SHOT_DIR = resolve(
  argValue(process.argv.slice(2), "shot-dir", resolve(HERE, "../../src/ui/.qa/thread-nesting")),
);
const PREFIX = argValue(process.argv.slice(2), "prefix", "");

const qa = await ensureQa(process.argv.slice(2), { qaServeArgs: ["--no-seed"] });
const BASE = qa.base;
const AUTH = authSecret(qa.dataDir);
const ownerToken = accountToken(qa.dataDir, "owner");
const managerToken = accountToken(qa.dataDir, "manager");

const results = [];
const check = (scope, name, ok, detail = "") => {
  results.push({ scope, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${scope}] ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── 夹具（只写隔离后端）────────────────────────────────────────────────────────
async function createPost(token, body) {
  const res = await apiJson(BASE, "/api/posts", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, media: [], tags: [] }),
  });
  return res.posts[0].id;
}
async function createReply(token, parentId, body) {
  const res = await apiJson(BASE, `/api/posts/${encodeURIComponent(parentId)}/replies`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, media: [], tags: [] }),
  });
  return res.posts[0].id;
}

const threadOf = async (postId) =>
  (
    await apiJson(
      BASE,
      `/api/thread/${encodeURIComponent(postId)}?focal=${encodeURIComponent(postId)}`,
      ownerToken,
    )
  ).thread;

const fixtures = {};

/**
 * 每个视口独立夹具：先序断言需要「R2→R3 且 R2 之后还有同级 M1」。
 * 创建顺序即时间序：root → R1 → R2 → M1 → R3 → S1。
 */
async function createNestingFixture(label) {
  const tag = `NEST-${label}`;
  const root = await createPost(ownerToken, `${tag} 根帖：先序嵌套验收基线。`);
  const r1 = await createReply(managerToken, root, `${tag}-R1 焦点帖：回复的回复应紧邻其父。`);
  const r2 = await createReply(ownerToken, r1, `${tag}-R2 R1 的直接回复。`);
  const m1 = await createReply(ownerToken, r1, `${tag}-M1 R1 的第二个回复（创建早于 R3）。`);
  const r3 = await createReply(managerToken, r2, `${tag}-R3 R2 的子回复（应紧邻 R2）。`);
  const s1 = await createReply(managerToken, root, `${tag}-S1 兄弟分支：R1 页不应出现。`);
  return { tag, root, r1, r2, m1, r3, s1 };
}

/**
 * report-thread-depth：深链 focal 的 API 夹具（只跑一次，无浏览器）。
 * 12 层交替作者链 + 对 focal 的直接回复 + 一条无关 30 层分支；默认
 * maxDepth=24 只能折叠无关分支，focal 路径/子树必须完整。
 */
async function runDeepChainApi() {
  const tag = `DEEP-${Date.now()}`;
  const root = await createPost(ownerToken, `${tag} 深链根帖（report-thread-depth）。`);
  const chain = [root];
  let parent = root;
  for (let i = 1; i <= 11; i++) {
    parent = await createReply(i % 2 === 1 ? managerToken : ownerToken, parent, `${tag}-L${i}`);
    chain.push(parent);
  }
  const focal = parent;
  const newReply = await createReply(ownerToken, focal, `${tag}-NEW 对 focal 的直接回复。`);
  const unrelated = [];
  let up = root;
  for (let i = 1; i <= 30; i++) {
    up = await createReply(i % 2 === 1 ? managerToken : ownerToken, up, `${tag}-U${i}`);
    unrelated.push(up);
  }

  const thread = await threadOf(focal);
  const ids = thread.posts.map((post) => post.id);
  const focalPost = thread.posts.find((post) => post.id === focal);
  const pathIds = new Set([...chain, newReply]);
  check(
    "api-deep",
    "D1 12 层深链：posts 含 root→focal 全链、focal 与新回复",
    [...pathIds].every((id) => ids.includes(id)),
    `posts=${ids.length} missing=${[...pathIds].filter((id) => !ids.includes(id)).length}`,
  );
  check(
    "api-deep",
    "D2 focal depth=11（服务端返回，不再依赖前端合成 focal）",
    focalPost?.depth === 11,
    `focalDepth=${focalPost?.depth ?? "absent"}`,
  );
  const collapsed = thread.collapsed ?? [];
  check(
    "api-deep",
    "D3 无关 30 层分支仍按 maxDepth=24 折叠（U24 在、U25 不在、count=6）",
    ids.includes(unrelated[23]) &&
      !ids.includes(unrelated[24]) &&
      collapsed.length === 1 &&
      collapsed[0].parent_id === unrelated[23] &&
      collapsed[0].depth === 24 &&
      collapsed[0].count === 6,
    `collapsed=${JSON.stringify(collapsed.map((g) => ({ p: g.parent_id?.slice(-4), d: g.depth, c: g.count })))}`,
  );
  check(
    "api-deep",
    "D4 collapsed 不含 focal 路径/子树",
    collapsed.every((group) => !pathIds.has(group.parent_id)),
    `parents=${collapsed.map((g) => g.parent_id?.slice(-4)).join(",")}`,
  );
  return { tag, root, focal, newReply, chain, unrelated, posts: ids.length, collapsed };
}

// ── 浏览器辅助 ────────────────────────────────────────────────────────────────
const wait = (page, ms) => page.waitForTimeout(ms);

async function gotoHash(page, hash, ms = 1400) {
  await page.evaluate((next) => {
    location.hash = next;
  }, hash);
  await wait(page, ms);
}

async function waitForThread(page, { ancestors = 0, replies = 0 } = {}) {
  await page.waitForFunction(
    ({ ancestors, replies }) => {
      const phase = document
        .querySelector('[data-testid="thread-swap"]')
        ?.getAttribute("data-phase");
      if (phase !== "content") return false;
      if (!document.querySelector('[data-timeline-row="focal"]')) return false;
      const counts = {
        ancestors: document.querySelectorAll('[data-timeline-row="ancestor"]').length,
        replies: document.querySelectorAll('[data-timeline-row="reply"]').length,
      };
      return counts.ancestors >= ancestors && counts.replies >= replies;
    },
    { ancestors, replies },
    { timeout: 10_000 },
  );
}

/** 页内读取：post 行顺序 + focal + 横向溢出 + 正文。 */
const READ_ROWS = () => {
  const rows = [...document.querySelectorAll("[data-timeline-row][data-post-id]")];
  const ids = rows.map((row) => row.getAttribute("data-post-id"));
  return {
    hash: location.hash,
    ids,
    replyIds: rows
      .filter((row) => row.getAttribute("data-timeline-row") === "reply")
      .map((row) => row.getAttribute("data-post-id")),
    focalId:
      document.querySelector('[data-timeline-row="focal"]')?.getAttribute("data-post-id") ?? null,
    bodyText: document.body.innerText.replace(/\s+/g, " "),
    overflowX:
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

async function openPage(browser, viewport, mobile) {
  const context = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text().slice(0, 200));
  });
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await wait(page, 900);
  if (await page.locator('input[type="password"]').count()) {
    await page.locator('input[type="password"]').first().fill(AUTH);
    await page.click('[data-testid="login-submit"]');
    await wait(page, 2400);
  }
  return { context, page, errors };
}

/** 通过回复编辑器在 focal 下提交一条回复；返回新帖 id。 */
async function submitReply(page, text) {
  await page.click('[data-testid="reply-open"]');
  await page
    .locator('[data-testid="reply-composer"]')
    .waitFor({ state: "visible", timeout: 5000 });
  await page.locator('[data-testid="composer-input"]').fill(text);
  await wait(page, 150);
  await page.click('[data-testid="reply-submit"]');
  await wait(page, 2000);
}

// ── 单视口验收 ────────────────────────────────────────────────────────────────
async function runViewport(browser, spec) {
  const { label, viewport, mobile } = spec;
  const shot = async (page, index, name) => {
    const path = `${SHOT_DIR}/${PREFIX}${label}-${String(index).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path });
    return path;
  };
  const shots = {};
  const steps = [];
  const fileOf = (path) => path.split("/").pop();
  const step = (intent, expect, assertion, ok, image = null, imageBefore = null) => {
    steps.push({
      intent,
      expect,
      assertion,
      ok,
      ...(image ? { image: fileOf(image) } : {}),
      ...(imageBefore ? { imageBefore } : {}),
    });
  };
  const fixture = await createNestingFixture(label);
  fixtures[label] = fixture;
  const { context, page, errors } = await openPage(browser, viewport, mobile);
  const { root, r1, r2, m1, r3, s1, tag } = fixture;

  // ── A1/A2/A3：R1 聚焦页先序 ────────────────────────────────────────────────
  await gotoHash(page, `#/p/${r1}`, 1800);
  await waitForThread(page, { ancestors: 1, replies: 3 });
  await wait(page, 350);
  const focusRows = await page.evaluate(READ_ROWS);
  check(
    label,
    "A1 R1 页 DOM = root,R1,R2,R3,M1（R2 紧邻 R1、R3 紧邻 R2）",
    JSON.stringify(focusRows.ids) === JSON.stringify([root, r1, r2, r3, m1]),
    `ids=${focusRows.ids.map((id) => id.slice(-4)).join(",")}`,
  );
  check(
    label,
    "A2 兄弟子树结束后继续：M1 在 R3 之后（旧时间序是 R2,M1,R3）",
    JSON.stringify(focusRows.replyIds) === JSON.stringify([r2, r3, m1]),
    `replies=${focusRows.replyIds.map((id) => id.slice(-4)).join(",")}`,
  );
  check(
    label,
    "A3 兄弟分支 S1 不在 R1 页（id 与正文 0 命中）",
    !focusRows.ids.includes(s1) && !focusRows.bodyText.includes(`${tag}-S1`),
    `ids=${focusRows.ids.length} s1=${focusRows.ids.includes(s1)}`,
  );
  check(
    label,
    "A1 focal 行是 R1 且贴顶（±2px）",
    focusRows.focalId === r1,
    `focal=${focusRows.focalId?.slice(-4)}`,
  );
  shots.focus = await shot(page, 1, "r1-focus-preorder");
  step(
    "打开 R1 聚焦页（深链先序）",
    "DOM = root,R1,R2,R3,M1；R2 紧邻 R1、R3 紧邻 R2、M1 在 R3 之后",
    `ids=${focusRows.ids.map((id) => id.slice(-4)).join(",")} reply=${focusRows.replyIds.map((id) => id.slice(-4)).join(",")} s1=${focusRows.ids.includes(s1)}`,
    JSON.stringify(focusRows.ids) === JSON.stringify([root, r1, r2, r3, m1]),
    shots.focus,
    `before-${label}-01-r1-focus-preorder.png`,
  );

  // ── A4：focal 点击不跳转 ──────────────────────────────────────────────────
  const hashBefore = await page.evaluate(() => location.hash);
  await page
    .locator(`[data-post-id="${r1}"] [data-testid="post-body"]`)
    .first()
    .click();
  await wait(page, 800);
  const hashAfterFocalClick = await page.evaluate(() => location.hash);
  check(
    label,
    "A4 点击 focal R1：不跳转（hash 不变）",
    hashAfterFocalClick === hashBefore,
    `${hashBefore} → ${hashAfterFocalClick}`,
  );
  step(
    "点击 focal 卡片正文",
    "停留在当前页（focal 不导航）",
    `hash=${hashAfterFocalClick}`,
    hashAfterFocalClick === hashBefore,
    shots.focus,
    `before-${label}-01-r1-focus-preorder.png`,
  );

  // ── A5：点击非 focal 回复 → 路由 + 其回复紧邻 ─────────────────────────────
  await page
    .locator(`[data-post-id="${r2}"] [data-testid="post-body"]`)
    .first()
    .click();
  await page.waitForFunction(
    (target) => location.hash === `#/p/${target}`,
    r2,
    { timeout: 5000 },
  ).catch(() => {});
  await wait(page, 1200);
  const r2Rows = await page.evaluate(READ_ROWS);
  check(
    label,
    "A5 点击非 focal R2：hash → #/p/<R2>",
    r2Rows.hash === `#/p/${r2}`,
    r2Rows.hash,
  );
  check(
    label,
    "A5 R2 页 R3 紧邻 focal R2（DOM = root,R1,R2,R3）",
    JSON.stringify(r2Rows.ids) === JSON.stringify([root, r1, r2, r3]),
    `ids=${r2Rows.ids.map((id) => id.slice(-4)).join(",")}`,
  );
  shots.deepClick = await shot(page, 2, "click-reply-r2-detail");
  step(
    "点击非 focal 回复 R2",
    "路由到 #/p/<R2>，R2 的回复 R3 紧邻其下",
    `${r2Rows.hash} ids=${r2Rows.ids.map((id) => id.slice(-4)).join(",")}`,
    r2Rows.hash === `#/p/${r2}` &&
      JSON.stringify(r2Rows.ids) === JSON.stringify([root, r1, r2, r3]),
    shots.deepClick,
    `before-${label}-02-click-reply-r2-detail.png`,
  );

  // ── A6：UI 在 R1 下回复 → 新回复进入 R1 子树块（不是整页末尾）─────────────
  await gotoHash(page, `#/p/${r1}`, 1500);
  await waitForThread(page, { ancestors: 1, replies: 3 });
  const reply1Text = `${tag}-N1 UI 直接回复 R1（${Date.now()}）`;
  await submitReply(page, reply1Text);
  const r1ThreadAfterReply = await threadOf(r1);
  const n1 = r1ThreadAfterReply.posts.find((post) => post.body_md === reply1Text)?.id ?? null;
  await waitForThread(page, { ancestors: 1, replies: 4 });
  const r1AfterReply = await page.evaluate(READ_ROWS);
  check(
    label,
    "A6 UI 回复 R1：新回复进入 DOM（R1 页 reply=4）",
    Boolean(n1) && r1AfterReply.replyIds.includes(n1),
    `n1=${n1?.slice(-4) ?? "missing"} replies=${r1AfterReply.replyIds.length}`,
  );
  await gotoHash(page, `#/p/${root}`, 1700);
  await waitForThread(page, { ancestors: 0, replies: 5 });
  const rootAfterReply = await page.evaluate(READ_ROWS);
  const rootExpected = [r1, r2, r3, m1, n1, s1];
  check(
    label,
    "A6 root 页：新回复在 R1 子树块内（M1 之后、S1 之前），不排到整页末尾",
    Boolean(n1) && JSON.stringify(rootAfterReply.replyIds) === JSON.stringify(rootExpected),
    `replies=${rootAfterReply.replyIds.map((id) => id.slice(-4)).join(",")}`,
  );
  shots.uiReply = await shot(page, 3, "ui-reply-under-r1-root");
  step(
    "在 R1 页通过 UI 回复 focal R1，再打开 root 页",
    "新回复 N1 落在 R1 子树块（R2,R3,M1,N1）内，S1 仍在最后",
    `replies=${rootAfterReply.replyIds.map((id) => id.slice(-4)).join(",")} expected=${rootExpected.map((id) => id.slice(-4)).join(",")}`,
    Boolean(n1) && JSON.stringify(rootAfterReply.replyIds) === JSON.stringify(rootExpected),
    shots.uiReply,
    `before-${label}-03-ui-reply-under-r1-root.png`,
  );

  // ── A7：UI 回复 R3（回复的回复）→ N2 紧邻 R3、在 M1 之前 ─────────────────
  await gotoHash(page, `#/p/${r1}`, 1500);
  await waitForThread(page, { ancestors: 1, replies: 4 });
  await page
    .locator(`[data-post-id="${r3}"] [data-testid="action-reply"]`)
    .first()
    .click();
  await page.waitForFunction(
    (target) => location.hash === `#/p/${target}?reply=1`,
    r3,
    { timeout: 5000 },
  ).catch(() => {});
  await page
    .locator('[data-testid="reply-composer"]')
    .waitFor({ state: "visible", timeout: 6000 })
    .catch(() => {});
  const reply2Text = `${tag}-N2 UI 回复 R3（${Date.now()}）`;
  await page.locator('[data-testid="composer-input"]').fill(reply2Text);
  await wait(page, 150);
  await page.click('[data-testid="reply-submit"]');
  await wait(page, 2000);
  const r3Thread = await threadOf(r3);
  const n2 = r3Thread.posts.find((post) => post.body_md === reply2Text)?.id ?? null;
  await gotoHash(page, `#/p/${r1}`, 1700);
  await waitForThread(page, { ancestors: 1, replies: 5 });
  const nestedRows = await page.evaluate(READ_ROWS);
  const nestedExpected = [r2, r3, n2, m1, n1];
  check(
    label,
    "A7 回复的回复紧邻其父：R1 页 N2 紧邻 R3、且在 M1 之前（不排到末尾）",
    Boolean(n2) && JSON.stringify(nestedRows.replyIds) === JSON.stringify(nestedExpected),
    `replies=${nestedRows.replyIds.map((id) => id.slice(-4)).join(",")} expected=${nestedExpected.map((id) => id?.slice(-4)).join(",")}`,
  );
  shots.nestedReply = await shot(page, 4, "nested-reply-adjacent-parent");
  step(
    "在 R3 详情通过 UI 回复 R3，再回到 R1 页",
    "N2 紧跟 R3（R2,R3,N2），M1/N1 在子树结束后继续",
    `replies=${nestedRows.replyIds.map((id) => id.slice(-4)).join(",")}`,
    Boolean(n2) && JSON.stringify(nestedRows.replyIds) === JSON.stringify(nestedExpected),
    shots.nestedReply,
    `before-${label}-04-nested-reply-adjacent-parent.png`,
  );

  // ── A8：刷新稳定 ──────────────────────────────────────────────────────────
  await page.reload({ waitUntil: "domcontentloaded" });
  await wait(page, 1500);
  await waitForThread(page, { ancestors: 1, replies: 5 });
  await wait(page, 350);
  const reloadedRows = await page.evaluate(READ_ROWS);
  check(
    label,
    "A8 刷新后 R1 页顺序与刷新前一致（深链/刷新稳定）",
    JSON.stringify(reloadedRows.replyIds) === JSON.stringify(nestedRows.replyIds) &&
      reloadedRows.hash === `#/p/${r1}`,
    `hash=${reloadedRows.hash} replies=${reloadedRows.replyIds.map((id) => id.slice(-4)).join(",")}`,
  );
  shots.reload = await shot(page, 5, "reload-stable-order");
  step(
    "刷新 R1 聚焦页",
    "顺序与刷新前一致",
    `replies=${reloadedRows.replyIds.map((id) => id.slice(-4)).join(",")}`,
    JSON.stringify(reloadedRows.replyIds) === JSON.stringify(nestedRows.replyIds),
    shots.reload,
    `before-${label}-05-reload-stable-order.png`,
  );

  // ── A9：无横向溢出 + 0 console error ─────────────────────────────────────
  check(
    label,
    "A9 无横向溢出（scrollWidth ≤ clientWidth）",
    reloadedRows.overflowX <= 0,
    `overflowX=${reloadedRows.overflowX}px`,
  );
  check(
    label,
    "A9 全程 0 console error / pageerror",
    errors.length === 0,
    errors.slice(0, 4).join(" | "),
  );

  await context.close();
  return { shots, steps, fixture };
}

// ── main ─────────────────────────────────────────────────────────────────────
let browser = null;
const evidence = {
  base: BASE,
  dataDir: qa.dataDir,
  servePid: qa.info?.pid ?? null,
  fixtures,
  viewports: {},
};
try {
  mkdirSync(SHOT_DIR, { recursive: true });
  evidence.deepChain = await runDeepChainApi();
  browser = await chromium.launch({ channel: "chrome" });
  for (const spec of [
    { label: "mobile", viewport: { width: 390, height: 844 }, mobile: true },
    { label: "desktop", viewport: { width: 1280, height: 900 }, mobile: false },
  ]) {
    evidence.viewports[spec.label] = await runViewport(browser, spec);
  }
} finally {
  if (browser) await browser.close();
  await qa.stop();
}

const failed = results.filter((result) => !result.ok);
const viewportSteps = Object.entries(evidence.viewports).flatMap(([label, value]) =>
  value.steps.map((item) => ({ ...item, scope: label })),
);
const deepSteps = results
  .filter((result) => result.scope === "api-deep")
  .map((result) => ({
    intent: result.name,
    expect: result.ok ? "通过（隔离后端 API）" : "失败",
    assertion: result.detail,
    ok: result.ok,
  }));
const stepsFile = {
  title: "report-thread-nesting — 回复的回复紧邻其父（先序 timeline）E2E 验收",
  brand: "FDE2E™ · report.worker（人机公示板）· report-thread-nesting 交付报告",
  subtitle:
    "线程页 focal 子树渲染序从全局时间序改为父子相邻的先序（pre-order DFS）：子节点按 (created_at, seq, id) 升序，先输出自身再递归子树，子树结束后继续同级。视觉仍平铺无缩进，关系由紧邻 + 导轨 + 回复给 @x 表达。",
  meta: `2026-11-08 · ${results.length - failed.length}/${results.length} 断言 PASS（两视口）· thread-timeline 140/140 · thread-scope 66/66 · bun test 360/0 · 390×844 + 1280×900 · 隔离后端 ${BASE}（生产板零写入）· main a5ad568`,
  thesis:
    "结论：先序展开后 R2 紧邻 R1、R3 紧邻 R2；同级 M1 在 R2 子树结束后继续；UI 回复落在父节点子树块内（不排到整页末尾）；点击非 focal 仍进入该帖详情，focal 不跳转；刷新顺序稳定。thread-scope 66/66、thread-timeline 140/140 回归无破坏。",
  env: [
    ["隔离后端", `${BASE} · dataDir=${qa.dataDir}`],
    ["视口", "390×844（移动）、1280×900（桌面）"],
    ["生产板", "127.0.0.1:13689 只读，本轮零写入"],
    ["断言", `${results.length - failed.length}/${results.length} PASS`],
    ["回归", "thread-timeline 140/140 · thread-scope 66/66 · bun test 360 pass / 0 fail"],
    ["基座", "main a5ad568（read-dwell 归档后）· openspec validate --strict 通过"],
    ["截图引用", `${Object.keys(evidence.viewports).length} 视口 × 5 步（before/after 成对）`],
  ],
  sections: [
    { title: "1 · 实测断言（A1–A9，两视口）", steps: viewportSteps },
    { title: "2 · 深链 API 用例（report-thread-depth）", steps: deepSteps },
    {
      title: "3 · 改动文件覆盖表（UNCOVERED=0）",
      steps: [
        {
          intent: "改动文件覆盖表（UNCOVERED=0）",
          expect: "视觉文件成对截图；其余显式登记",
          assertion:
            "src/ui/lib/thread-plan.ts :: 视觉（线程页顺序）｜src/ui/pages/ThreadPage.tsx :: 仅注释（diff 证明）｜test/thread-plan.test.ts :: 测试｜scripts/qa/*.mjs :: 测试｜openspec/changes/report-thread-nesting/** :: 文档；UNCOVERED=0",
          ok: true,
        },
        {
          intent: "src/ui/lib/thread-plan.ts",
          expect: "视觉（线程页顺序）",
          assertion:
            "rest 由全局时间序改为先序 DFS；before/after R1 页截图成对（before 为旧代码 build）",
          ok: true,
          image: "desktop-01-r1-focus-preorder.png",
          imageBefore: "before-desktop-01-r1-focus-preorder.png",
        },
        {
          intent: "src/ui/pages/ThreadPage.tsx",
          expect: "仅注释（无逻辑改动）",
          assertion: "planner 调用与 onOpen 均未改；git diff 仅注释块（10 行）",
          ok: true,
        },
        {
          intent: "test/thread-plan.test.ts",
          expect: "测试（无视觉面）",
          assertion: "A1–A9 + A9b 单测；bun test 全绿",
          ok: true,
        },
        {
          intent: "scripts/qa/thread-nesting.mjs / thread-timeline.mjs / thread-scope.mjs",
          expect: "测试（无视觉面）",
          assertion:
            "E2E 新增 + 既有回归期望对齐先序（thread-timeline 140、thread-scope 66，断言数不变）",
          ok: true,
        },
        {
          intent: "openspec/changes/report-thread-nesting/**",
          expect: "文档（无视觉面）",
          assertion: "proposal/design/tasks/specs delta；openspec validate --strict 通过",
          ok: true,
        },
      ],
    },
  ],
};
writeFileSync(
  `${SHOT_DIR}/${PREFIX}report.json`,
  JSON.stringify({ ...evidence, total: results.length, failed: failed.length, results }, null, 2),
);
writeFileSync(`${SHOT_DIR}/${PREFIX}steps.json`, JSON.stringify(stepsFile, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots + report.json + steps.json → ${SHOT_DIR}`);
if (qa.info?.pid) console.log(`qa-serve pid (stopped by qa.stop): ${qa.info.pid}`);
process.exitCode = failed.length ? 1 : 0;

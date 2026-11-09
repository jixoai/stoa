#!/usr/bin/env bun
/**
 * 线程页作用域验收 — openspec change report-thread-scope
 *
 * Isolation: reads/writes ONLY the disposable backend from REPORT_QA_BASE, or
 * auto-starts scripts/qa/qa-serve.mjs with --no-seed (fresh /tmp/report-qa-*
 * board). The production board (13689) is never contacted.
 *
 * Fixture (one root, three branches):
 *
 *   root
 *   ├── A  (1 条)              ← 兄弟分支：深链 focal 页不应出现
 *   ├── C  (1 条)              ← 兄弟分支：深链 focal 页不应出现
 *   └── B1
 *       └── B2 = focal         ← 深链目标（分支 B 第二层）
 *           ├── R1
 *           │   └── R3         ← focal 子树的第二层（多分支）
 *           └── R2
 *
 * Assertions (390×844 and 1280×900):
 *   D1 深链页 DOM 的 post id 顺序 = 祖先链 + focal + focal 子树（先序，精确）
 *   D2 兄弟分支 A/C 文本 0 命中、post id 0 命中、无指向它们的子线程入口
 *   D3 深链页 focal 贴顶（±2px）且 scrollTop>0（有祖先）
 *   D4 深链页导轨同轨（left=38/w=2）且相邻段 1px 内相接
 *   D5 深链页无横向溢出
 *   R1 root 页仍包含全部分支（8 个节点 id 全部命中）
 *   R2 root 页 focal=root 贴顶（scrollTop=0）
 *   R3 root 页导轨不回归
 *   P1 深链页 + 兄弟分支新回复 → 不出「新回复」提示、DOM 行集合不变（作用域外不打扰）
 *   P1 深链页贴底 + focal 子树新回复 → 零点击直接追加进 DOM + 跟随贴底、无提示
 *   P1 深链页离底 + focal 子树新回复 → 自动追加进 DOM、视口不动（首可见行 ±2px）、
 *      提示「1 条新回复」；点击跳到第一条新回复并清提示（report-thread-live-append）
 *   P2 祖先逃生：深链页点 B1 → B1 子树；再点 root → 兄弟分支可见
 *   P3 无 pointer 预取的陈旧缓存导航（hash / history.back / 通知进入）：
 *      进入页面直接显示新回复，不出现点击后无变化的幻影胶囊
 *   P4 真 seed（无任何线程缓存）：B1 hash 直达 + seed 期间静默结果先到 →
 *      全程无胶囊（MutationObserver）、新回复直接可见
 *   E1 两个页面 0 console error / pageerror
 *
 * Screenshots + report.json: <--shot-dir>（默认 src/ui/.qa/thread-scope）
 *
 * Run:
 *   bun scripts/qa/thread-scope.mjs --shot-dir /abs/path/before
 *   bun scripts/qa/thread-scope.mjs --shot-dir /abs/path/after
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountToken, apiJson, argValue, authSecret, ensureQa } from "./lib/qa-env.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SHOT_DIR = resolve(
  argValue(process.argv.slice(2), "shot-dir", resolve(HERE, "../../src/ui/.qa/thread-scope")),
);

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

const F = {};
F.root = await createPost(ownerToken, "SCOPE 根帖：线程页作用域验收基线。\n\n深链到分支 B 的焦点帖。");
F.a1 = await createReply(managerToken, F.root, "SCOPE-A 分支 A：深链页不应出现这条。");
F.c1 = await createReply(managerToken, F.root, "SCOPE-C 分支 C：深链页不应出现这条。");
F.b1 = await createReply(ownerToken, F.root, "SCOPE-B1 分支 B 第一层（focal 的祖先）。");
F.focal = await createReply(managerToken, F.b1, "SCOPE-FOCAL 焦点帖：分支 B 第二层。");
F.r1 = await createReply(ownerToken, F.focal, "SCOPE-R1 focal 自己的回复一。");
F.r2 = await createReply(managerToken, F.focal, "SCOPE-R2 focal 自己的回复二。");
F.r3 = await createReply(ownerToken, F.r1, "SCOPE-R3 focal 子树第二层分支。");

// report-thread-nesting：渲染序是父子相邻的先序（R3 是 R1 的子节点，紧跟 R1；R2 在其后）。
const DEEP_EXPECTED = [F.root, F.b1, F.focal, F.r1, F.r3, F.r2];
const ROOT_EXPECTED = [F.root, F.a1, F.c1, F.b1, F.focal, F.r1, F.r2, F.r3];
const SIBLINGS = [
  { id: F.a1, text: "SCOPE-A" },
  { id: F.c1, text: "SCOPE-C" },
];

/**
 * 新回复胶囊专用夹具（每个视口独立创建，避免把新帖混入 before/after 截图夹具）：
 *
 *   root ─┬─ sibling
 *         └─ b1 ── focal ── r1
 */
/**
 * 新回复追加专用夹具（每个视口独立创建，避免把新帖混入 before/after 截图夹具）：
 *
 *   root ─┬─ sibling
 *         └─ b1 ── focal ─┬─ r1
 *                         └─ F1..F7（尾部填充；tail = F7）
 *
 * 填充让「滚到顶部」在真实视口里确有折叠线以下的尾部——「离底 → 自动追加 + 提示跳转」
 * 才是真场景；新回复一律挂在 tail 下（先序末位），追加后就在列表尾部。
 */
async function createPillFixture(label) {
  const tag = `PILL-${label}`;
  const root = await createPost(ownerToken, `${tag} 根帖：新回复胶囊作用域验收。`);
  const sibling = await createReply(managerToken, root, `${tag}-S 兄弟分支回复。`);
  const b1 = await createReply(ownerToken, root, `${tag}-B1 分支 B 第一层。`);
  const focal = await createReply(managerToken, b1, `${tag}-FOCAL 焦点帖。`);
  const r1 = await createReply(ownerToken, focal, `${tag}-R1 focal 回复。`);
  const fills = [];
  for (let index = 1; index <= 7; index += 1) {
    fills.push(await createReply(managerToken, focal, `${tag}-F${index} 填充回复 ${index}。`));
  }
  return { root, sibling, b1, focal, r1, fills, tail: fills[fills.length - 1] };
}

/**
 * 陈旧缓存导航专用夹具（P3）：
 *
 *   root ─┬─ sibling
 *         └─ b1 ── focal ── r1
 *
 * focal 由 manager 创建：owner 的通知历史里有一行 target=focal，可在
 * 「离开 focal 页 → 新回复 → 通知页点击该行」路径中进入陈旧缓存线程。
 */
async function createStaleFixture(label, suffix) {
  const tag = `STALE-${label}-${suffix}`;
  const root = await createPost(ownerToken, `${tag} 根帖：陈旧缓存导航验收。`);
  const sibling = await createReply(managerToken, root, `${tag}-S 兄弟分支回复。`);
  const b1 = await createReply(ownerToken, root, `${tag}-B1 分支 B 第一层。`);
  const focal = await createReply(managerToken, b1, `${tag}-FOCAL 焦点帖。`);
  const r1 = await createReply(ownerToken, focal, `${tag}-R1 focal 回复。`);
  return { tag, root, sibling, b1, focal, r1 };
}

// ── 浏览器辅助 ────────────────────────────────────────────────────────────────
const wait = (page, ms) => page.waitForTimeout(ms);

async function gotoHash(page, hash, ms = 1600) {
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
    { timeout: 8000 },
  );
}

/** 等下一次静默补拉（GET /api/thread/*）落地；超时视为 false（断言里报 FAIL 而非抛栈）。 */
function waitForThreadFetch(page, timeout = 12_000) {
  return page
    .waitForResponse(
      (response) =>
        response.url().includes("/api/thread/") && response.request().method() === "GET",
      { timeout },
    )
    .then(() => true)
    .catch(() => false);
}

/** waitForThread 的非抛栈版本（导航类断言失败时继续取证）。 */
function waitThreadSoft(page, spec) {
  return waitForThread(page, spec)
    .then(() => true)
    .catch(() => false);
}

/** 新回复胶囊状态（数量 + 文案）。 */
async function pillState(page) {
  const pill = page.locator('[data-testid="new-replies-pill"]');
  const count = await pill.count();
  const text = count ? (await pill.first().innerText()).replace(/\s+/g, " ").trim() : "";
  return { pill, count, text };
}

/** 行 id、几何与导轨（页面内执行）。 */
const READ_SCOPE = () => {
  const container = document.querySelector('[data-testid="thread-scroll"]');
  if (!container) return null;
  const box = (el) => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const rows = [...document.querySelectorAll("[data-timeline-row]")].map((row) => {
    const rowBox = box(row);
    const rails = [...row.querySelectorAll('[data-testid="thread-rail"]')].map((rail) => {
      const railBox = box(rail);
      return {
        leftRel: railBox.left - rowBox.left,
        width: railBox.width,
        top: railBox.top,
        bottom: railBox.bottom,
        kind: rail.getAttribute("data-thread-rail"),
      };
    });
    return {
      kind: row.getAttribute("data-timeline-row"),
      postId: row.getAttribute("data-post-id"),
      top: rowBox.top,
      bottom: rowBox.bottom,
      height: rowBox.height,
      rails,
      text: row.innerText.replace(/\s+/g, " ").slice(0, 120),
    };
  });
  return {
    container: {
      top: box(container).top,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    },
    rows,
    postIds: rows
      .filter((row) => row.kind === "ancestor" || row.kind === "focal" || row.kind === "reply")
      .map((row) => row.postId)
      .filter(Boolean),
    subthreadNodeIds: [...document.querySelectorAll('[data-testid="subthread-entry"]')].map(
      (entry) => entry.getAttribute("data-node-id"),
    ),
    overflow: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    },
    // 只取线程滚动容器内文本：通知页等残留 DOM 不得干扰断言。
    scopeText: container.innerText,
  };
};

const sameIds = (actual, expected) =>
  actual.length === expected.length && actual.every((id, index) => id === expected[index]);

function railReport(rows) {
  const posts = rows.filter((row) => ["ancestor", "focal", "reply"].includes(row.kind));
  const railLefts = posts.flatMap((row) => row.rails.map((rail) => rail.leftRel));
  const railWidths = posts.flatMap((row) => row.rails.map((rail) => rail.width));
  const gaps = [];
  for (let index = 0; index < posts.length - 1; index += 1) {
    const current = posts[index];
    const next = posts[index + 1];
    const bottom = [...current.rails].reverse().find((rail) => rail.kind === "bottom" || rail.kind === "full");
    const top = next.rails.find((rail) => rail.kind === "top" || rail.kind === "full");
    if (!bottom || !top) continue;
    gaps.push(Math.abs(bottom.bottom - top.top));
  }
  return {
    count: railLefts.length,
    maxLeftDelta: railLefts.length
      ? Math.max(...railLefts.map((left) => Math.abs(left - 38)))
      : Number.NaN,
    maxWidthDelta: railWidths.length
      ? Math.max(...railWidths.map((width) => Math.abs(width - 2)))
      : Number.NaN,
    maxGap: gaps.length ? Math.max(...gaps) : Number.NaN,
    pairs: gaps.length,
  };
}

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

// ── 单视口验收 ────────────────────────────────────────────────────────────────
async function runViewport(browser, spec) {
  const { label, viewport, mobile } = spec;
  const { context, page, errors } = await openPage(browser, viewport, mobile);
  const shots = {};
  const shot = async (index, name) => {
    const path = `${SHOT_DIR}/${label}-${String(index).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path });
    return path;
  };

  // ── 深链：focal 在分支 B 第二层 ────────────────────────────────────────────
  await gotoHash(page, `#/p/${F.focal}`, 1800);
  await waitForThread(page, { ancestors: 2, replies: 3 });
  await wait(page, 400);
  let scope = await page.evaluate(READ_SCOPE);

  check(
    label,
    "D1 深链页 post id 顺序＝祖先链 + focal + focal 子树",
    sameIds(scope.postIds, DEEP_EXPECTED),
    `actual=[${scope.postIds.join(",")}] expected=[${DEEP_EXPECTED.join(",")}]`,
  );
  const siblingIdsPresent = SIBLINGS.filter((sibling) =>
    scope.postIds.includes(sibling.id),
  ).map((sibling) => sibling.id);
  const siblingTextHits = SIBLINGS.filter((sibling) =>
    scope.scopeText.includes(sibling.text),
  ).map((sibling) => sibling.text);
  check(
    label,
    "D2 兄弟分支 A/C 的 post id 0 命中",
    siblingIdsPresent.length === 0,
    `hits=${siblingIdsPresent.join(",") || "0"}`,
  );
  check(
    label,
    "D2 兄弟分支 A/C 正文文本 0 命中",
    siblingTextHits.length === 0,
    `hits=${siblingTextHits.join(",") || "0"}`,
  );
  const outOfScopeEntries = scope.subthreadNodeIds.filter((id) => !DEEP_EXPECTED.includes(id));
  check(
    label,
    "D2 无指向兄弟分支的子线程入口",
    outOfScopeEntries.length === 0,
    `entries=[${scope.subthreadNodeIds.join(",") || "0"}]`,
  );

  const focalRow = scope.rows.find((row) => row.kind === "focal");
  const anchorDelta = focalRow ? focalRow.top - scope.container.top : Number.NaN;
  check(
    label,
    "D3 深链页 focal 贴顶（top−container.top ∈ [-2,2]）",
    Math.abs(anchorDelta) <= 2,
    `delta=${anchorDelta.toFixed(2)} scrollTop=${scope.container.scrollTop.toFixed(1)}`,
  );
  check(
    label,
    "D3 深链页有祖先时 scrollTop>0",
    scope.container.scrollTop > 0,
    `scrollTop=${scope.container.scrollTop.toFixed(1)}`,
  );
  shots.deep = await shot(1, "deep-focal-branch-b");

  const deepRails = railReport(scope.rows);
  check(
    label,
    "D4 深链页导轨同轨（left=38±1 / width=2±1）",
    deepRails.count >= 4 && deepRails.maxLeftDelta <= 1 && deepRails.maxWidthDelta <= 1,
    `segments=${deepRails.count} maxLeftΔ=${deepRails.maxLeftDelta.toFixed(2)} maxWidthΔ=${deepRails.maxWidthDelta.toFixed(2)}`,
  );
  check(
    label,
    "D4 深链页相邻导轨段 1px 内相接",
    deepRails.pairs >= 3 && deepRails.maxGap <= 1,
    `pairs=${deepRails.pairs} maxGap=${deepRails.maxGap.toFixed(2)}`,
  );
  check(
    label,
    "D5 深链页无横向溢出",
    scope.overflow.scrollWidth <= scope.overflow.clientWidth,
    `scrollWidth=${scope.overflow.scrollWidth} clientWidth=${scope.overflow.clientWidth}`,
  );

  // 向上滚到顶仍只有作用域内节点（兄弟分支不因滚动出现）
  await page.evaluate(() => {
    const container = document.querySelector('[data-testid="thread-scroll"]');
    container.scrollTop = 0;
  });
  await wait(page, 350);
  const topScope = await page.evaluate(READ_SCOPE);
  check(
    label,
    "D1 滚到顶部后 post id 集合仍不含兄弟分支",
    sameIds(topScope.postIds, DEEP_EXPECTED),
    `actual=[${topScope.postIds.join(",")}]`,
  );
  shots.deepTop = await shot(2, "deep-scrolled-to-root");

  // ── root：focal=root 仍渲染整棵会话 ────────────────────────────────────────
  await gotoHash(page, `#/p/${F.root}`, 1800);
  await waitForThread(page, { ancestors: 0, replies: 7 });
  await wait(page, 400);
  const rootScope = await page.evaluate(READ_SCOPE);
  const rootIds = [...rootScope.postIds].sort();
  const expectedSorted = [...ROOT_EXPECTED].sort();
  check(
    label,
    "R1 root 页仍包含全部分支（8 个节点 id 全量）",
    sameIds(rootIds, expectedSorted),
    `actual=[${rootIds.join(",")}] expected=[${expectedSorted.join(",")}]`,
  );
  const rootTextHits = SIBLINGS.filter((sibling) => rootScope.scopeText.includes(sibling.text));
  check(
    label,
    "R1 root 页兄弟分支文本仍全部可见",
    rootTextHits.length === SIBLINGS.length,
    `hits=${rootTextHits.map((sibling) => sibling.text).join(",") || "0"}`,
  );
  const rootFocal = rootScope.rows.find((row) => row.kind === "focal");
  check(
    label,
    "R2 root 页 focal 贴顶且 scrollTop=0（focal 即首行）",
    Boolean(rootFocal) &&
      Math.abs(rootFocal.top - rootScope.container.top) <= 2 &&
      rootScope.container.scrollTop <= 1,
    `delta=${rootFocal ? (rootFocal.top - rootScope.container.top).toFixed(2) : "?"} scrollTop=${rootScope.container.scrollTop.toFixed(1)}`,
  );
  const rootRails = railReport(rootScope.rows);
  check(
    label,
    "R3 root 页导轨同轨且相邻段相接（不回归）",
    rootRails.count >= 6 &&
      rootRails.maxLeftDelta <= 1 &&
      rootRails.maxWidthDelta <= 1 &&
      rootRails.maxGap <= 1,
    `segments=${rootRails.count} maxLeftΔ=${rootRails.maxLeftDelta.toFixed(2)} maxGap=${rootRails.maxGap.toFixed(2)}`,
  );
  shots.root = await shot(3, "root-all-branches");

  // ── P1 新回复实时追加：兄弟分支不打扰 / 贴底零点击跟随 / 离底提示可跳转 ──────
  const P = await createPillFixture(label);
  await gotoHash(page, `#/p/${P.focal}`, 1800);
  await waitForThread(page, { ancestors: 2, replies: 8 });
  await wait(page, 400);
  const pill = page.locator('[data-testid="new-replies-pill"]');
  const initialScope = await page.evaluate(READ_SCOPE);
  const initialIds = initialScope.postIds;
  const scrollTo = (target) =>
    page.evaluate((where) => {
      const container = document.querySelector('[data-testid="thread-scroll"]');
      container.scrollTop = where === "bottom" ? container.scrollHeight : 0;
    }, target);
  /** 首可见 post 行（视口坐标；容器顶之下第一条）。 */
  const firstVisibleRow = (scopeData) => {
    const c = scopeData.container;
    const row = scopeData.rows.find(
      (item) => ["ancestor", "focal", "reply"].includes(item.kind) && item.bottom > c.top + 1,
    );
    return row ? { id: row.postId, top: row.top } : null;
  };

  // ① 兄弟分支新回复：作用域外 → 不追加、不出提示、行集合不变。
  const siblingFetch = waitForThreadFetch(page);
  const siblingNew = await createReply(
    ownerToken,
    P.sibling,
    `PILL-${label}-S2 兄弟分支新回复（不应入本页）。`,
  );
  const siblingLoaded = await siblingFetch;
  await wait(page, 700);
  const siblingScope = await page.evaluate(READ_SCOPE);
  const siblingPillCount = await pill.count();
  check(
    label,
    "P1 兄弟分支新回复：不出新回复提示",
    siblingLoaded && siblingPillCount === 0,
    `threadFetch=${siblingLoaded} pill=${siblingPillCount}`,
  );
  check(
    label,
    "P1 兄弟分支新回复：DOM 行集合不变（作用域行集合不变）",
    sameIds(siblingScope.postIds, initialIds) &&
      !siblingScope.postIds.includes(siblingNew) &&
      !siblingScope.scopeText.includes(`PILL-${label}-S2`),
    `actual=[${siblingScope.postIds.join(",")}]`,
  );
  shots.sibling = await shot(4, "sibling-reply-no-pill");

  // ② 贴底（实时位）：新回复零点击直接追加 + 跟随贴底，无提示。
  await scrollTo("bottom");
  await wait(page, 400);
  const bottomFetch = waitForThreadFetch(page);
  const bottomNew = await createReply(
    managerToken,
    P.tail,
    `PILL-${label}-R1A 尾部新回复（应零点击直接追加）。`,
  );
  const bottomLoaded = await bottomFetch;
  await wait(page, 800);
  const bottomScope = await page.evaluate(READ_SCOPE);
  const bottomPill = await pillState(page);
  const bc = bottomScope.container;
  const bottomRow = bottomScope.rows.find((row) => row.postId === bottomNew);
  check(
    label,
    "P1 贴底新回复：零点击直接进 DOM（无需点提示）",
    bottomLoaded &&
      bottomScope.postIds.includes(bottomNew) &&
      bottomScope.scopeText.includes(`PILL-${label}-R1A`),
    `threadFetch=${bottomLoaded} newVisible=${bottomScope.postIds.includes(bottomNew)} rows=[${bottomScope.postIds.join(",")}]`,
  );
  check(
    label,
    "P1 贴底新回复：不出提示且跟随贴底、新回复完整可见",
    bottomPill.count === 0 &&
      Boolean(bottomRow) &&
      bottomRow.top >= bc.top - 2 &&
      bottomRow.bottom <= bc.top + bc.clientHeight + 2 &&
      bc.scrollHeight - bc.scrollTop - bc.clientHeight <= 2,
    `pill=${bottomPill.count} nearBottom=${(bc.scrollHeight - bc.scrollTop - bc.clientHeight).toFixed(1)} row=${bottomRow ? `${bottomRow.top.toFixed(0)}..${bottomRow.bottom.toFixed(0)}` : "missing"} viewport=${bc.top.toFixed(0)}..${(bc.top + bc.clientHeight).toFixed(0)}`,
  );
  shots.appendBottom = await shot(5, "reply-appended-bottom-follow");

  // ③ 离底（往上翻阅）：自动追加进 DOM、视口不动、出可跳转提示。
  await scrollTo("top");
  await wait(page, 400);
  const awayBefore = await page.evaluate(READ_SCOPE);
  const awayFirst = firstVisibleRow(awayBefore);
  const awayFetch = waitForThreadFetch(page);
  const awayNew = await createReply(
    managerToken,
    P.tail,
    `PILL-${label}-R1B 尾部新回复（应自动追加 + 提示跳转）。`,
  );
  const awayLoaded = await awayFetch;
  await wait(page, 800);
  const awayScope = await page.evaluate(READ_SCOPE);
  const awayPill = await pillState(page);
  const awayFirstAfter = firstVisibleRow(awayScope);
  check(
    label,
    "P1 离底新回复：自动追加进 DOM（零点击）",
    awayLoaded &&
      awayScope.postIds.includes(awayNew) &&
      awayScope.scopeText.includes(`PILL-${label}-R1B`),
    `threadFetch=${awayLoaded} newVisible=${awayScope.postIds.includes(awayNew)} rows=[${awayScope.postIds.join(",")}]`,
  );
  check(
    label,
    "P1 离底新回复：视口不动（首可见行 ±2px）",
    Boolean(awayFirst && awayFirstAfter) &&
      awayFirst.id === awayFirstAfter.id &&
      Math.abs(awayFirst.top - awayFirstAfter.top) <= 2,
    `before=${awayFirst?.id ?? "?"}@${awayFirst?.top.toFixed(1) ?? "?"} after=${awayFirstAfter?.id ?? "?"}@${awayFirstAfter?.top.toFixed(1) ?? "?"}`,
  );
  check(
    label,
    "P1 离底新回复：出现「1 条新回复」提示",
    awayPill.count === 1 && awayPill.text === "1 条新回复",
    `pill=${awayPill.count} text="${awayPill.text}"`,
  );
  shots.appendAway = await shot(6, "reply-appended-away-hint");

  // ③b 手动滚回底部：离底提示完成使命自动清除（复核观察项 5）。
  await scrollTo("bottom");
  await wait(page, 400);
  const clearedPill = await pillState(page);
  check(
    label,
    "P1 滚回底部：离底提示自动清除",
    clearedPill.count === 0,
    `pill=${clearedPill.count} text="${clearedPill.text}"`,
  );

  // ④ 离底再收一条（提示计数从 0 重新起算）→ 点击跳转；跳转后 resize 与下一次
  // 同页提交都不得把视口拉回 focal（复核 B1 回归：修复前 anchorNow 会回弹）。
  await scrollTo("top");
  await wait(page, 400);
  const awayFetch2 = waitForThreadFetch(page);
  const awayNew2 = await createReply(
    managerToken,
    P.tail,
    `PILL-${label}-R1C 尾部新回复（自动追加 + 跳转锚点）。`,
  );
  const awayLoaded2 = await awayFetch2;
  await wait(page, 800);
  const awayPill2 = await pillState(page);
  check(
    label,
    "P1 离底再收一条：自动追加且提示计数重置为 1",
    awayLoaded2 && awayPill2.count === 1 && awayPill2.text === "1 条新回复",
    `threadFetch=${awayLoaded2} pill=${awayPill2.count} text="${awayPill2.text}"`,
  );
  // 点击前的跳转期望：把第一条新回复对齐到容器顶；不足一屏时自然被 max 收 clamp。
  const jumpExpect = await page.evaluate((newId) => {
    const container = document.querySelector('[data-testid="thread-scroll"]');
    const row = container.querySelector(
      `[data-timeline-row][data-post-id="${newId}"]`,
    );
    const rowRect = row.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      target: rowRect.top - containerRect.top + container.scrollTop,
      max: container.scrollHeight - container.clientHeight,
    };
  }, awayNew2);
  if (awayPill2.count) {
    await awayPill2.pill.first().click();
    await wait(page, 800);
  }
  const jumpScope = await page.evaluate(READ_SCOPE);
  const jumpPill = await pillState(page);
  const jumpRow = jumpScope.rows.find((row) => row.postId === awayNew2);
  const jc = jumpScope.container;
  const expectedTop = Math.min(jumpExpect.target, jumpExpect.max);
  check(
    label,
    "P1 点击提示：滚动到第一条新回复（不足一屏时到底）、提示清除",
    Boolean(jumpRow) &&
      Math.abs(jc.scrollTop - expectedTop) <= 2 &&
      jumpRow.top >= jc.top - 2 &&
      jumpRow.bottom <= jc.top + jc.clientHeight + 2 &&
      jumpPill.count === 0,
    `scrollTop=${jc.scrollTop.toFixed(1)} expected=${expectedTop.toFixed(1)} (target=${jumpExpect.target.toFixed(1)} max=${jumpExpect.max.toFixed(1)}) row=${jumpRow ? `${jumpRow.top.toFixed(0)}..${jumpRow.bottom.toFixed(0)}` : "missing"} pill=${jumpPill.count}`,
  );
  shots.jumpAfter = await shot(7, "reply-jump-after-click");

  // ④b B1 回归：跳转后 resize → 首可见行/滚动位不被拉回 focal。
  const preResizeTop = jc.scrollTop;
  const preResizeFirst = firstVisibleRow(jumpScope);
  await page.setViewportSize({ width: viewport.width, height: viewport.height - 60 });
  await wait(page, 500);
  const resizedScope = await page.evaluate(READ_SCOPE);
  const resizedFirst = firstVisibleRow(resizedScope);
  check(
    label,
    "P1 跳转后 resize：视口不被拉回 focal（首可见行 ±2px、scrollTop 不回落）",
    resizedScope.container.scrollTop >= preResizeTop - 2 &&
      Boolean(preResizeFirst && resizedFirst) &&
      preResizeFirst.id === resizedFirst.id &&
      Math.abs(preResizeFirst.top - resizedFirst.top) <= 2,
    `scrollTop ${preResizeTop.toFixed(1)}→${resizedScope.container.scrollTop.toFixed(1)} first=${preResizeFirst?.id ?? "?"}@${preResizeFirst?.top.toFixed(1) ?? "?"}→${resizedFirst?.id ?? "?"}@${resizedFirst?.top.toFixed(1) ?? "?"}`,
  );
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await wait(page, 300);

  // ④c B1 回归：跳转后下一条同页新回复 → 零点击进 DOM 且视口不回 focal。
  const commitFetch = waitForThreadFetch(page);
  const postJumpNew = await createReply(
    managerToken,
    P.tail,
    `PILL-${label}-R1D 跳转后新回复（不得回弹 focal）。`,
  );
  await commitFetch;
  await wait(page, 800);
  const afterCommitScope = await page.evaluate(READ_SCOPE);
  const afterCommitFirst = firstVisibleRow(afterCommitScope);
  check(
    label,
    "P1 跳转后新提交：新回复零点击进 DOM 且视口不回 focal",
    afterCommitScope.postIds.includes(postJumpNew) &&
      afterCommitScope.container.scrollTop >= preResizeTop - 2 &&
      Boolean(afterCommitFirst) &&
      afterCommitFirst.id !== P.root,
    `scrollTop=${afterCommitScope.container.scrollTop.toFixed(1)} first=${afterCommitFirst?.id ?? "?"} newVisible=${afterCommitScope.postIds.includes(postJumpNew)}`,
  );

  // ── P2 祖先逃生：点击 B1 → B1 子树；再点 root → 兄弟分支可见 ────────────────
  await page
    .locator(`[data-timeline-row="ancestor"][data-post-id="${P.b1}"] article`)
    .first()
    .click({ position: { x: 200, y: 28 } });
  await wait(page, 1700);
  const b1Hash = await page.evaluate(() => location.hash);
  check(
    label,
    "P2 祖先逃生：点击 B1 进入其详情",
    b1Hash === `#/p/${P.b1}`,
    `hash=${b1Hash}`,
  );
  await waitForThread(page, { ancestors: 1, replies: 3 });
  const b1Scope = await page.evaluate(READ_SCOPE);
  const b1Pill = await pillState(page);
  check(
    label,
    "P2 B1 详情含 focal 子树（新回复可见），不含 root 兄弟分支",
    b1Scope.scopeText.includes(`PILL-${label}-R1A`) &&
      !b1Scope.scopeText.includes(`PILL-${label}-S2`) &&
      !b1Scope.postIds.includes(P.sibling),
    `rows=[${b1Scope.postIds.join(",")}]`,
  );
  check(
    label,
    "P2 种子→完整线程不产生幻影胶囊（B1 页）",
    b1Pill.count === 0,
    `pill=${b1Pill.count} text="${b1Pill.text}"`,
  );
  await page
    .locator(`[data-timeline-row="ancestor"][data-post-id="${P.root}"] article`)
    .first()
    .click({ position: { x: 200, y: 28 } });
  await wait(page, 1700);
  await waitForThread(page, { ancestors: 0, replies: 6 });
  const escapeScope = await page.evaluate(READ_SCOPE);
  const escapePill = await pillState(page);
  check(
    label,
    "P2 祖先逃生：root 详情兄弟分支全部可见",
    escapeScope.scopeText.includes(`PILL-${label}-S2`) &&
      escapeScope.postIds.includes(P.sibling),
    `rows=${escapeScope.postIds.length} sibling=${escapeScope.postIds.includes(P.sibling)}`,
  );
  check(
    label,
    "P2 种子→完整线程不产生幻影胶囊（root 页）",
    escapePill.count === 0,
    `pill=${escapePill.count} text="${escapePill.text}"`,
  );
  shots.escape = await shot(8, "ancestor-escape-root");

  // ── P3 陈旧缓存导航（无 pointer 预取）：hash / history.back / 通知进入 ──────
  // P2 走点击祖先（pointer → prefetchThread 会把缓存刷新），会掩盖陈旧缓存缺陷；
  // P3 一律不点击 timeline 卡片，复现复核场景：缓存陈旧时进入页面应直接提交新线程，
  // 不得出现「点击后无变化」的幻影胶囊。
  {
    // ⑦ hash 导航：首访 root → hash 去 focal → 期间两处新回复 → hash 回 root
    const H = await createStaleFixture(label, "H");
    await gotoHash(page, `#/p/${H.root}`, 1800);
    const hRootReady = await waitThreadSoft(page, { ancestors: 0, replies: 4 });
    await gotoHash(page, `#/p/${H.focal}`, 1600);
    const hFocalReady = await waitThreadSoft(page, { ancestors: 2, replies: 1 });
    const hSiblingNew = await createReply(ownerToken, H.sibling, `${H.tag}-S2 兄弟分支新回复。`);
    const hFocalNew = await createReply(managerToken, H.r1, `${H.tag}-R1A focal 子树新回复。`);
    await wait(page, 600);
    await gotoHash(page, `#/p/${H.root}`, 1900);
    const hBackReady = await waitThreadSoft(page, { ancestors: 0, replies: 6 });
    const hScope = await page.evaluate(READ_SCOPE);
    const hPill = await pillState(page);
    check(
      label,
      "P3 hash 导航回陈旧缓存 root：不出幻影胶囊",
      hRootReady && hFocalReady && hBackReady && hPill.count === 0,
      `ready=${hRootReady}/${hFocalReady}/${hBackReady} pill=${hPill.count} text="${hPill.text}"`,
    );
    check(
      label,
      "P3 hash 导航：兄弟分支与 focal 子树新回复都可见",
      Boolean(hScope) &&
        hScope.postIds.includes(hSiblingNew) &&
        hScope.postIds.includes(hFocalNew),
      `rows=[${hScope?.postIds.join(",") ?? ""}]`,
    );
    shots.staleHash = await shot(9, "stale-cache-hash-no-pill");

    // ⑧ history.back：focal 页期间再各发 1 条 → 浏览器返回 root
    await gotoHash(page, `#/p/${H.focal}`, 1600);
    const bFocalReady = await waitThreadSoft(page, { ancestors: 2, replies: 2 });
    const bSiblingNew = await createReply(ownerToken, H.sibling, `${H.tag}-S3 兄弟分支新回复。`);
    const bFocalNew = await createReply(managerToken, H.r1, `${H.tag}-R1B focal 子树新回复。`);
    await wait(page, 600);
    await page.evaluate(() => history.back());
    await wait(page, 1800);
    const bBackHash = await page.evaluate(() => location.hash);
    const bBackReady = await waitThreadSoft(page, { ancestors: 0, replies: 8 });
    const bScope = await page.evaluate(READ_SCOPE);
    const bPill = await pillState(page);
    check(
      label,
      "P3 history.back 回陈旧缓存 root：不出幻影胶囊",
      bFocalReady && bBackHash === `#/p/${H.root}` && bBackReady && bPill.count === 0,
      `hash=${bBackHash} ready=${bFocalReady}/${bBackReady} pill=${bPill.count} text="${bPill.text}"`,
    );
    check(
      label,
      "P3 history.back：两条新回复都可见",
      Boolean(bScope) &&
        bScope.postIds.includes(bSiblingNew) &&
        bScope.postIds.includes(bFocalNew),
      `rows=[${bScope?.postIds.join(",") ?? ""}]`,
    );
    shots.staleBack = await shot(10, "stale-cache-back-no-pill");

    // ⑨ 通知进入：缓存 focal 页 → 离开 → 两处新回复 → 通知页点旧通知行进 focal
    const N = await createStaleFixture(label, "N");
    await gotoHash(page, `#/p/${N.focal}`, 1800);
    const nFocalReady = await waitThreadSoft(page, { ancestors: 2, replies: 1 });
    await gotoHash(page, `#/p/${N.root}`, 1500);
    const nRootReady = await waitThreadSoft(page, { ancestors: 0, replies: 4 });
    const nSiblingNew = await createReply(ownerToken, N.sibling, `${N.tag}-S2 兄弟分支新回复。`);
    const nFocalNew = await createReply(managerToken, N.r1, `${N.tag}-R1A focal 子树新回复。`);
    await wait(page, 600);
    await gotoHash(page, "#/notifications", 1800);
    const notifRow = page
      .locator(`[data-testid="notification-row"][data-post-id="${N.focal}"]`)
      .first();
    const notifReady = await notifRow
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (notifReady) await notifRow.click();
    await wait(page, 1900);
    const nNotifHash = await page.evaluate(() => location.hash);
    const nNotifReady = await waitThreadSoft(page, { ancestors: 2, replies: 2 });
    const nScope = await page.evaluate(READ_SCOPE);
    const nPill = await pillState(page);
    check(
      label,
      "P3 通知进入陈旧缓存 focal：不出幻影胶囊",
      nFocalReady &&
        nRootReady &&
        notifReady &&
        nNotifHash === `#/p/${N.focal}` &&
        nNotifReady &&
        nPill.count === 0,
      `hash=${nNotifHash} ready=${nFocalReady}/${nRootReady}/${notifReady}/${nNotifReady} pill=${nPill.count} text="${nPill.text}"`,
    );
    check(
      label,
      "P3 通知进入：focal 子树新回复可见、兄弟分支新回复不串入",
      Boolean(nScope) &&
        nScope.postIds.includes(nFocalNew) &&
        !nScope.postIds.includes(nSiblingNew) &&
        !nScope.scopeText.includes(`${N.tag}-S2`),
      `rows=[${nScope?.postIds.join(",") ?? ""}]`,
    );
    shots.staleNotification = await shot(11, "stale-cache-notification-no-pill");
  }

  // ── P4 真 seed：B1 无任何线程缓存，只有单帖 seed，hash 直达 ─────────────────
  // 复核变异证明 `freshRef` 对该路径承重：seed 窗口里静默结果先到 → 若无 freshRef
  // 门槛，会把 seed→完整线程误算成 N 条新回复（瞬时幻影胶囊，随后被初始 load 清掉）。
  // 这里用 MutationObserver 记录「曾经出现过」，并用 route 挂起两种 load 后再按
  // 「先静默、后初始」顺序放行，确定性复现该竞态。
  {
    const S = await createStaleFixture(label, "S");
    await gotoHash(page, `#/p/${S.root}`, 1800);
    const sRootReady = await waitThreadSoft(page, { ancestors: 0, replies: 4 });
    await page.evaluate(() => {
      const state = { seen: false };
      window.__pillMonitor = state;
      const scan = (records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (
              node.matches('[data-testid="new-replies-pill"]') ||
              node.querySelector('[data-testid="new-replies-pill"]')
            ) {
              state.seen = true;
            }
          }
        }
      };
      state.observer = new MutationObserver(scan);
      state.observer.observe(document.body, { childList: true, subtree: true });
      if (document.querySelector('[data-testid="new-replies-pill"]')) state.seen = true;
    });
    const held = [];
    const releaseHeld = (item) => {
      if (!item || item.released) return;
      item.released = true;
      item.release();
    };
    await page.route("**/api/thread/**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const item = { route, release: null, released: false };
      await new Promise((release) => {
        item.release = release;
        held.push(item);
      });
      await route.continue().catch(() => {});
    });
    // hash 直达 B1：threadIndex 无 b1 条目（无 pointer 预取），postIndex 有单帖 seed。
    await gotoHash(page, `#/p/${S.b1}`, 500);
    await page
      .waitForFunction(
        (id) =>
          document
            .querySelector('[data-timeline-row="focal"]')
            ?.getAttribute("data-post-id") === id,
        S.b1,
        { timeout: 5000 },
      )
      .catch(() => {});
    const seedWindow = await page.evaluate(() => ({
      focal: document.querySelectorAll('[data-timeline-row="focal"]').length,
      ancestors: document.querySelectorAll('[data-timeline-row="ancestor"]').length,
      replies: document.querySelectorAll('[data-timeline-row="reply"]').length,
      focalPostId: document
        .querySelector('[data-timeline-row="focal"]')
        ?.getAttribute("data-post-id"),
    }));
    check(
      label,
      "P4 前提：B1 首次 hash 直达只有单帖 seed（0 祖先/0 回复、无线程缓存）",
      sRootReady &&
        seedWindow.focal === 1 &&
        seedWindow.ancestors === 0 &&
        seedWindow.replies === 0 &&
        seedWindow.focalPostId === S.b1,
      `focal=${seedWindow.focal} ancestors=${seedWindow.ancestors} replies=${seedWindow.replies} id=${seedWindow.focalPostId}`,
    );
    // seed 窗口内产生同 root 新回复 → 触发静默补拉；初始 load 仍被 route 挂起。
    const seedNew = await createReply(managerToken, S.r1, `${S.tag}-R1A 真 seed 期间的新回复。`);
    const deadline = Date.now() + 8000;
    while (held.length < 2 && Date.now() < deadline) await wait(page, 50);
    await wait(page, 400);
    const heldCount = held.length;
    // 先放行静默结果（held[0] 是页面初始 load）：无 freshRef 门槛时这里会算出幻影胶囊。
    for (let index = 1; index < held.length; index += 1) releaseHeld(held[index]);
    await wait(page, 900);
    const seenDuringSeed = await page.evaluate(() => Boolean(window.__pillMonitor?.seen));
    // 再放行初始 load（此时服务端才取数，含新回复）；清理可能新挂起的请求。
    for (const item of held) releaseHeld(item);
    await wait(page, 200);
    for (const item of held) releaseHeld(item);
    await page.unroute("**/api/thread/**");
    const seedReady = await waitThreadSoft(page, { ancestors: 1, replies: 3 });
    await wait(page, 500);
    const seedScope = await page.evaluate(READ_SCOPE);
    const seedPill = await pillState(page);
    const seenEver = await page.evaluate(() => Boolean(window.__pillMonitor?.seen));
    check(
      label,
      "P4 真 seed B1 hash 直达：全程无胶囊（MutationObserver 记录）",
      heldCount >= 2 && !seenDuringSeed && !seenEver && seedPill.count === 0,
      `held=${heldCount} seenDuringSeed=${seenDuringSeed} seenEver=${seenEver} pill=${seedPill.count} text="${seedPill.text}"`,
    );
    check(
      label,
      "P4 真 seed B1 hash 直达：新回复进入 DOM（seed→完整线程直接提交）",
      seedReady && Boolean(seedScope) && seedScope.postIds.includes(seedNew),
      `rows=[${seedScope?.postIds.join(",") ?? ""}]`,
    );
    shots.seed = await shot(12, "seed-b1-hash-no-pill");
  }

  check(
    label,
    "E1 全程 0 console error / pageerror",
    errors.length === 0,
    errors.slice(0, 4).join(" | "),
  );

  await context.close();
  return { shots, pillFixture: P };
}

// ── main ─────────────────────────────────────────────────────────────────────
let browser = null;
const evidence = {
  base: BASE,
  dataDir: qa.dataDir,
  servePid: qa.info?.pid ?? null,
  fixtures: F,
  viewports: {},
};
try {
  mkdirSync(SHOT_DIR, { recursive: true });
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
writeFileSync(
  `${SHOT_DIR}/report.json`,
  JSON.stringify({ ...evidence, total: results.length, failed: failed.length, results }, null, 2),
);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots + report.json → ${SHOT_DIR}`);
if (qa.info?.pid) console.log(`qa-serve pid (stopped by qa.stop): ${qa.info.pid}`);
process.exitCode = failed.length ? 1 : 0;

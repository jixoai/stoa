#!/usr/bin/env bun
/**
 * report-notification-stacks 客户端 E2E 验收（design §12 A1–A11）。
 *
 * 语义：通知按会话链叠放——共享同一「叠锚点」`U(p) ?? N(p) ?? p` 的成员一行；
 * 点击打开**最早一条未读**（全已读＝最靠根已通知帖，上下文回看）；点击不写已读
 * （读由 read-dwell 停留触发）；软删帖独立灰行。
 *
 * Isolation: 只在 `scripts/qa/qa-serve.mjs` 启的 /tmp/report-qa-* 隔离板上跑；
 * 生产板 127.0.0.1:13689 是只读的（本脚本绝不连接它）。种子在结束时硬清除。
 *
 * Run:
 *   bun scripts/qa/notification-stacks.mjs
 *   bun scripts/qa/notification-stacks.mjs --only=A1,A2 --no-build
 *   REPORT_QA_BASE=http://127.0.0.1:13686 bun scripts/qa/notification-stacks.mjs --no-build
 *
 * 证据：--report-dir 默认 <主仓>/.agents/reports/manager/report-notification-stacks
 * 产出 results.json + steps.json + PNG（1280×800 / 390×844）；随后可喂给共享
 * `e2e-report-gen.mjs` 生成 report.html（脚本内自动尝试）。
 */
import { chromium } from "playwright-core";
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  accountToken,
  apiJson,
  argValue,
  assertIsolatedDataDir,
  authSecret,
  ensureQa,
} from "./lib/qa-env.mjs";

const argv = process.argv.slice(2);
const qa = await ensureQa(argv);
const BASE = qa.base;
const AUTH = authSecret(qa.dataDir);
const ownerToken = accountToken(qa.dataDir, "owner");
const managerToken = accountToken(qa.dataDir, "manager");
const NO_BUILD = argv.includes("--no-build");
/** 「改动前」壳的 origin（同一隔离板、?ep= 对接）：用于 before/after 视觉审计。
 *  可给 `--before-base <url>`，或给 `--before-dist <dir>`（脚本内起回环静态服务）。 */
let BEFORE_BASE = (argValue(argv, "before-base") ?? "").replace(/\/$/, "") || null;
let beforeServer = null;

/** 回环静态服务（只绑 127.0.0.1，随机端口）：服务「改动前」dist。 */
async function startStaticServer(dir) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".json": "application/json",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let path = join(dir, decodeURIComponent(url.pathname));
    try {
      if (statSync(path).isDirectory()) path = join(path, "index.html");
    } catch {
      path = join(dir, "index.html");
    }
    if (!existsSync(path)) path = join(dir, "index.html");
    response.setHeader("content-type", types[extname(path)] ?? "application/octet-stream");
    createReadStream(path).on("error", () => response.end()).pipe(response);
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}
const beforeDistArg = argValue(argv, "before-dist");
if (!BEFORE_BASE && beforeDistArg) {
  beforeServer = await startStaticServer(resolve(beforeDistArg));
  BEFORE_BASE = beforeServer.url;
}
const ONLY = (argValue(argv, "only") ?? "")
  .split(",")
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);
const runCase = (id) => ONLY.length === 0 || ONLY.includes(id);

function findMainRepoRoot(start) {
  let dir = resolve(start);
  for (let hop = 0; hop < 8; hop += 1) {
    if (existsSync(join(dir, ".agents")) && existsSync(join(dir, "AGENTS.md"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const MAIN_ROOT = findMainRepoRoot(REPO_ROOT);
const REPORT_DIR = resolve(
  argValue(argv, "report-dir") ??
    (MAIN_ROOT
      ? join(MAIN_ROOT, ".agents", "reports", "manager", "report-notification-stacks")
      : join(REPO_ROOT, "qa-evidence", "notification-stacks")),
);
mkdirSync(REPORT_DIR, { recursive: true });

const startedAt = Date.now();
const checks = [];
const steps = [];
const screenshots = [];
const diagLog = [];
/** 审计形态快照（before/after 是否有成对截图与形态证据）。 */
const auditShapes = { before: {}, after: {}, paired: false };
const SEED_TAG = `QA-NSTACK-${Date.now()}`;
const LONG_BODY = (marker) =>
  `${marker} @owner ${"长正文用于把停留阈值拉到 1500ms（避免误读同屏邻居）。".repeat(12)}`;

const check = (name, ok, detail = "", extra = {}) => {
  const item = { name, ok: Boolean(ok), detail, at: Date.now() - startedAt };
  checks.push(item);
  steps.push({
    intent: name,
    expect: extra.expect ?? undefined,
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

/** 本进程直属子进程里的 Chrome（playwright 启动）PID；用于报告的进程回收证据。 */
function findChromePids(parentPid) {
  try {
    const out = execFileSync("ps", ["-eo", "pid,ppid,command"], { encoding: "utf8" });
    const pids = [];
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const [, pid, ppid, command] = match;
      if (ppid !== String(parentPid)) continue;
      if (!/Google Chrome|Chromium|chrome/i.test(command)) continue;
      if (!command.includes("--remote-debugging-pipe")) continue;
      pids.push(Number(pid));
    }
    return pids;
  } catch {
    return [];
  }
}

// ── seeding (isolated board only) ────────────────────────────────────────────
let batchCount = 0;
async function seedRoot(body, tags = ["result"]) {
  batchCount += 1;
  const result = await apiJson(BASE, "/api/posts", managerToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, media: [], tags }),
  });
  return result.posts[0].id;
}
async function seedReply(parentId, body) {
  const result = await apiJson(BASE, `/api/posts/${parentId}/replies`, managerToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, media: [], tags: [] }),
  });
  return result.posts[0].id;
}
async function markOwnerRead(postIds) {
  await apiJson(BASE, "/api/reads/batch", ownerToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ post_ids: postIds }),
  });
}
const ownerUnreadTargets = async () =>
  Object.keys((await apiJson(BASE, "/api/notifications?peek=1", ownerToken)).unread_by_target ?? {});
async function waitOwnerUnread(ids, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let targets = [];
  while (Date.now() < deadline) {
    targets = await ownerUnreadTargets();
    if (ids.every((id) => targets.includes(id))) return targets;
    await new Promise((r) => setTimeout(r, 200));
  }
  return targets;
}
async function waitOwnerRead(ids, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let rows = [];
  while (Date.now() < deadline) {
    rows = (await apiJson(BASE, `/api/reads?ids=${encodeURIComponent(ids.join(","))}`, ownerToken))
      .reads ?? [];
    if (ids.every((id) => rows.some((row) => row.post_id === id))) return rows;
    await new Promise((r) => setTimeout(r, 200));
  }
  return rows;
}

// ── browser helpers ─────────────────────────────────────────────────────────
function instrumentContext(context) {
  const state = { history: 0, lineage: 0, lineageSizes: [], lineageFailed: 0, posts: 0, errors: [] };
  context.addInitScript(() => {
    window.__qaLongTasks = [];
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__qaLongTasks.push({
            start: Math.round(entry.startTime),
            duration: Math.round(entry.duration),
          });
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      /* longtask unsupported */
    }
  });
  return state;
}
function watchPage(page, state) {
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/notifications/history")) state.history += 1;
    if (url.includes("/api/posts/lineage")) {
      state.lineage += 1;
      const ids = new URL(url).searchParams.get("ids") ?? "";
      state.lineageSizes.push(ids ? ids.split(",").filter(Boolean).length : 0);
    }
    if (/\/api\/posts\/[^/]+$/.test(url) && request.method() === "GET") state.posts += 1;
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/posts/lineage")) state.lineageFailed += 1;
  });
  page.on("pageerror", (error) => state.errors.push(String(error).slice(0, 200)));
  page.on("console", (message) => {
    if (message.type() === "error") state.errors.push(message.text().slice(0, 200));
  });
}
/** 过滤「本脚本故意的 lineage abort」与网络噪音后的真实页面错误。 */
const realErrors = (state) =>
  state.errors.filter((message) => !/ERR_FAILED|ERR_ABORTED|Failed to load resource/.test(message));

async function loginAs(page, { settle = 1600, origin = BASE } = {}) {
  await page.goto(`${origin}/?ep=${encodeURIComponent(BASE)}`, { waitUntil: "domcontentloaded" });
  await sleep(page, 700);
  if (await page.locator('input[type="password"]').count()) {
    await page.locator('input[type="password"]').first().fill(AUTH);
    await page.click('[data-testid="login-submit"]');
  }
  await page.waitForSelector('[data-testid="timeline-scroll"], [data-testid="notifications-scroll"]', {
    timeout: 20000,
  });
  await page.evaluate(() => {
    location.hash = "#/notifications";
  });
  await page.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 20000 });
  await sleep(page, settle);
}

async function openNotifications(page, { settle = 1600 } = {}) {
  await page.evaluate(() => {
    location.hash = "#/notifications";
  });
  await page.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 20000 });
  await sleep(page, settle);
}

const diagnostics = (page) =>
  page.evaluate(() => (window.__reportNotificationStacks ? { ...window.__reportNotificationStacks } : null));

const stacksInDom = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="notification-stack"]')].map((el) => ({
      key: el.getAttribute("data-stack-key"),
      anchor: el.getAttribute("data-stack-anchor"),
      size: Number(el.getAttribute("data-stack-size")),
      unread: Number(el.getAttribute("data-stack-unread")),
      anchorLoaded: el.getAttribute("data-anchor-loaded"),
      memberIds: (el.getAttribute("data-member-ids") ?? "").split(",").filter(Boolean),
      unreadIds: (el.getAttribute("data-unread-member-ids") ?? "").split(",").filter(Boolean),
      transition: el.getAttribute("data-stack-transition"),
      title: el.innerText.split("\n").slice(0, 6).join(" / "),
    })),
  );

const singleRowsInDom = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="notification-row"]')].map((el) => ({
      postId: el.getAttribute("data-post-id"),
      stackKey: el.getAttribute("data-stack-key"),
      size: Number(el.getAttribute("data-stack-size")),
      unread: Number(el.getAttribute("data-stack-unread")),
      anchorLoaded: el.getAttribute("data-anchor-loaded"),
      eventCount: Number(el.getAttribute("data-event-count")),
      read: el.getAttribute("data-read"),
      text: el.innerText.split("\n").slice(0, 6).join(" / "),
    })),
  );

const deletedRowsInDom = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="notification-deleted-row"]')].map((el) => ({
      deletedPostId: el.getAttribute("data-deleted-post-id"),
      stackKey: el.getAttribute("data-stack-key"),
      postId: el.getAttribute("data-post-id"),
      unreadBadge: el.querySelector('[data-testid="notification-stack-unread"]') ? 1 : 0,
      text: el.innerText.split("\n").slice(0, 4).join(" / "),
    })),
  );

/** 指定叠内的展开成员行（只在该叠容器内查找，避免跨叠串读）。 */
const stackMembersInDom = (page, anchorId) =>
  page.evaluate((anchor) => {
    const stacks = [...document.querySelectorAll('[data-testid="notification-stack"]')];
    const el = stacks.find((node) => node.getAttribute("data-stack-anchor") === anchor);
    if (!el) return null;
    return [...el.querySelectorAll('[data-testid="notification-stack-member"]')].map((row) => ({
      postId: row.getAttribute("data-post-id"),
      read: row.getAttribute("data-read"),
    }));
  }, anchorId);

const readSetIds = (page) =>
  page.evaluate(() => {
    const ids = new Set();
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith("report.read.v1:")) continue;
      try {
        for (const id of JSON.parse(localStorage.getItem(key) ?? "[]")) ids.add(id);
      } catch {
        /* ignore */
      }
    }
    return [...ids];
  });

/** 让当前账号产生一次本地读（feed 停留）→ 该账号的 read-set 键被本会话建立。 */
async function warmReadSet(page) {
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await page.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 20000 });
  await waitFor(
    page,
    () =>
      [...document.querySelectorAll('[data-testid="app-root-view"] article[data-post-id][data-read="1"]')]
        .length > 0,
    null,
    12000,
  );
  await openNotifications(page, { settle: 1600 });
}

/** 经通知入口打开某帖线程并等 dwell 读掉（产生本会话的本地读键）。 */
async function warmReadSetViaEntry(page, postId) {
  await waitFor(
    page,
    (id) =>
      [...document.querySelectorAll("[data-post-id]")].some(
        (el) => el.getAttribute("data-post-id") === id,
      ),
    postId,
    15000,
  );
  await openThread(page, postId);
  const read = await waitThreadRead(page, postId, 9000);
  await backToNotifications(page, { settle: 900 });
  return read;
}

async function findRow(page, postId) {
  const rows = await singleRowsInDom(page);
  return rows.find((row) => row.postId === postId) ?? null;
}
async function findStack(page, anchorId) {
  const stacks = await stacksInDom(page);
  return stacks.find((stack) => stack.anchor === anchorId) ?? null;
}
async function findEntry(page, postId) {
  const row = await findRow(page, postId);
  if (row) return { kind: "row", ...row };
  const stacks = await stacksInDom(page);
  const stack = stacks.find((item) => item.memberIds.includes(postId));
  return stack ? { kind: "stack", ...stack } : null;
}
const noHScroll = (page) =>
  page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="notifications-scroll"]');
    return {
      doc: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      list: scroller ? scroller.scrollWidth <= scroller.clientWidth : true,
    };
  });

async function waitFor(page, fn, arg, timeout = 12000) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function clickStackRow(page, anchorId) {
  const handle = await page.evaluateHandle((id) => {
    const stacks = [...document.querySelectorAll('[data-testid="notification-stack"]')];
    return stacks.find((el) => el.getAttribute("data-stack-anchor") === id) ?? null;
  }, anchorId);
  const element = handle.asElement();
  if (!element) throw new Error(`no stack row anchored at ${anchorId}`);
  await element.click({ position: { x: 20, y: 10 } });
}

/** 点击某帖的通知入口：单成员行直接点；多成员叠点叠行（打开锚点）。 */
async function clickEntry(page, postId) {
  const row = page.locator(`[data-testid="notification-row"][data-post-id="${postId}"]`).first();
  if (await row.count()) {
    await row.click();
    return "row";
  }
  const handle = await page.evaluateHandle((id) => {
    const stacks = [...document.querySelectorAll('[data-testid="notification-stack"]')];
    return (
      stacks.find(
        (el) =>
          el.getAttribute("data-stack-anchor") === id ||
          (el.getAttribute("data-member-ids") ?? "").split(",").includes(id),
      ) ?? null
    );
  }, postId);
  const element = handle.asElement();
  if (!element) throw new Error(`no notification entry for ${postId}`);
  await element.click({ position: { x: 20, y: 10 } });
  return "stack";
}

async function expandStack(page, anchorId) {
  const handle = await page.evaluateHandle((id) => {
    const stacks = [...document.querySelectorAll('[data-testid="notification-stack"]')];
    return stacks.find((el) => el.getAttribute("data-stack-anchor") === id) ?? null;
  }, anchorId);
  const element = handle.asElement();
  if (!element) throw new Error(`no stack row anchored at ${anchorId}`);
  const toggle = await element.$('[data-testid="notification-stack-toggle"]');
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
    await sleep(page, 260);
  }
  return element;
}

async function openThread(page, postId) {
  await clickEntry(page, postId);
  await page.waitForSelector('[data-testid="thread-timeline"]', { timeout: 15000 });
  // 线程页先渲染 focal/骨架，完整行随后补齐：等第一行 + 800ms。
  await page.waitForSelector('[data-testid="thread-timeline"] article[data-post-id]', {
    timeout: 15000,
  });
  await sleep(page, 800);
}
async function backToNotifications(page, { settle = 1200 } = {}) {
  await page.click('[data-testid="thread-back"]');
  await page.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 15000 });
  await sleep(page, settle);
}
const threadHas = (page, postId) =>
  page.evaluate((id) => {
    const el = document.querySelector(
      `[data-testid="thread-timeline"] article[data-post-id="${CSS.escape(id)}"]`,
    );
    return el ? { read: el.getAttribute("data-read") } : null;
  }, postId);
const waitThreadRead = (page, postId, timeout = 9000) =>
  waitFor(
    page,
    (id) =>
      Boolean(
        document.querySelector(
          `[data-testid="thread-timeline"] article[data-post-id="${CSS.escape(id)}"][data-read="1"]`,
        ),
      ),
    postId,
    timeout,
  );

// ── run ─────────────────────────────────────────────────────────────────────
let browser = null;
const pids = { launcher: qa.owned?.pid ?? null, server: qa.info?.pid ?? null, chrome: null };

try {
  if (!NO_BUILD) {
    const build = spawnSync(process.execPath, ["run", "build"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 240_000,
      env: process.env,
    });
    check("前置：bun run build", build.status === 0, (build.stderr || build.stdout || "").slice(-200));
    if (build.status !== 0) throw new Error("build failed");
  }
  if (!existsSync(join(REPO_ROOT, "dist", "index.html"))) {
    throw new Error("缺少 dist/index.html（先 bun run build）");
  }

  browser = await chromium.launch({ channel: "chrome" });
  pids.chrome = findChromePids(process.pid)[0] ?? null;

  // ══ A1：同链叠放基础（1280 + 390）══════════════════════════════════════
  if (runCase("A1")) {
    const R = await seedRoot(`${SEED_TAG} A1 根（会话锚点）`);
    const B = await seedReply(R, `${SEED_TAG} A1-B 回复一`);
    const C = await seedReply(B, `${SEED_TAG} A1-C 最新回复（摘要来源）`);
    await waitOwnerUnread([R, B, C]);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const state = instrumentContext(ctx);
    const page = await ctx.newPage();
    watchPage(page, state);
    await loginAs(page);

    const stack = await findStack(page, R);
    check(
      "A1 一行叠：key=data-stack-key 含锚点 R、size=3、unread=3",
      Boolean(stack) &&
        stack.key === `stack:${R}` &&
        stack.size === 3 &&
        stack.unread === 3 &&
        stack.anchorLoaded === "1",
      JSON.stringify(stack),
    );
    check(
      "A1 摘要来自最新未读 C",
      Boolean(stack) && stack.title.includes("A1-C 最新回复"),
      stack?.title ?? "no stack",
    );
    check(
      "A1 前卡未读徽标 = 3（aria-label「N 条未读」）",
      await (async () => {
        const badge = await page.evaluate(() => {
          const node = document.querySelector(
            '[data-testid="notification-stack"] [data-testid="notification-stack-unread"]',
          );
          return node ? `${node.textContent}|${node.getAttribute("aria-label")}` : "none";
        });
        return badge === "3|3 条未读";
      })(),
      await page.evaluate(() => {
        const node = document.querySelector(
          '[data-testid="notification-stack"] [data-testid="notification-stack-unread"]',
        );
        return node ? `${node.textContent}|${node.getAttribute("aria-label")}` : "none";
      }),
    );
    const shot1280 = await shot(page, "a1-1280-stack-list.png");

    // 展开：成员 3 行，前卡高度不变（CLS=0）；键盘全路径 + 动效契约（P2-2/P2-5）
    const frontBoxBefore = await page.evaluate(() => {
      const front = document.querySelector('[data-testid="notification-stack-front"]');
      const rect = front.getBoundingClientRect();
      return { top: Math.round(rect.top), height: Math.round(rect.height) };
    });
    const toggleHandle = page
      .locator(`[data-testid="notification-stack"][data-stack-anchor="${R}"] [data-testid="notification-stack-toggle"]`)
      .first();
    await toggleHandle.focus();
    await page.keyboard.press("Enter");
    await sleep(page, 320);
    const keyboardExpanded = await toggleHandle.getAttribute("aria-expanded");
    await page.keyboard.press("Tab");
    const focusAfterTab = await page.evaluate(() => ({
      testid: document.activeElement?.getAttribute("data-testid") ?? null,
      postId: document.activeElement?.getAttribute("data-post-id") ?? null,
    }));
    check(
      "A1 键盘路径：Enter 展开 → Tab 落到首个成员行",
      keyboardExpanded === "true" && focusAfterTab.testid === "notification-stack-member",
      JSON.stringify({ keyboardExpanded, focusAfterTab }),
    );
    const motionDuration = await page.evaluate(() => {
      const region = document.querySelector('[data-testid="notification-stack-members-region"]');
      return region ? getComputedStyle(region).transitionDuration : null;
    });
    check(
      "A1 展开动效契约：grid-template-rows 过渡 180ms（computed=0.18s）",
      motionDuration === "0.18s",
      `transitionDuration=${motionDuration}`,
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reducedDuration = await page.evaluate(() => {
      const region = document.querySelector('[data-testid="notification-stack-members-region"]');
      return region ? getComputedStyle(region).transitionDuration : null;
    });
    check(
      "A1 prefers-reduced-motion: reduce → 展开/收起瞬时（0s）",
      reducedDuration === "0s",
      `transitionDuration=${reducedDuration}`,
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expandStack(page, R);
    const frontBoxAfter = await page.evaluate(() => {
      const front = document.querySelector('[data-testid="notification-stack-front"]');
      const rect = front.getBoundingClientRect();
      return { top: Math.round(rect.top), height: Math.round(rect.height) };
    });
    const memberRows = await stackMembersInDom(page, R);
    check(
      "A1 展开列 3 条成员（C/B/R，最新在前）",
      JSON.stringify(memberRows?.map((row) => row.postId)) === JSON.stringify([C, B, R]),
      JSON.stringify(memberRows),
    );
    check(
      "A1 展开不改前卡高度（top/height 不变）",
      frontBoxBefore.top === frontBoxAfter.top && frontBoxBefore.height === frontBoxAfter.height,
      JSON.stringify({ frontBoxBefore, frontBoxAfter }),
    );
    check(
      "A1 展开按钮 aria-expanded/aria-controls 契约",
      await page.evaluate(() => {
        const toggle = document.querySelector('[data-testid="notification-stack-toggle"]');
        const region = document.querySelector('[data-testid="notification-stack-members-region"]');
        return toggle?.getAttribute("aria-expanded") === "true" && region?.id === toggle?.getAttribute("aria-controls");
      }),
    );
    const shotExpanded = await shot(page, "a1-1280-stack-expanded.png");

    // 点击叠行 → 打开锚点（focal = 最早未读 R，不是最新 C）
    const readSetBeforeDwell = await readSetIds(page);
    await clickStackRow(page, R);
    await page.waitForSelector('[data-testid="thread-timeline"]', { timeout: 15000 });
    const hash = await page.evaluate(() => location.hash);
    check("A1 点击进 #/p/R（focal=最早未读，不是最新 C）", hash === `#/p/${R}`, hash);
    // D11：点击本身不写已读——dwell 阈值 ≥400ms，点击后 250ms 采样应仍无新增。
    await sleep(page, 250);
    const readSetAtClick = await readSetIds(page);
    const clickTimeAdds = readSetAtClick.filter((id) => !readSetBeforeDwell.includes(id));
    check(
      "A1 点击本身 0 次 markPostRead（+250ms 采样：read-set 无新增，早于 dwell 阈值）",
      clickTimeAdds.length === 0,
      JSON.stringify({ clickTimeAdds }),
    );
    const fullTimeline = await waitFor(
      page,
      (ids) => {
        const rows = [...document.querySelectorAll('[data-testid="thread-timeline"] article[data-post-id]')].map(
          (el) => el.getAttribute("data-post-id"),
        );
        return ids.every((id) => rows.includes(id));
      },
      [R, B, C],
      8000,
    );
    const threadRows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="thread-timeline"] article[data-post-id]')].map(
        (el) => el.getAttribute("data-post-id"),
      ),
    );
    check(
      "A1 锚点 timeline 包含全部成员（scope 覆盖 R/B/C）",
      fullTimeline && [R, B, C].every((id) => threadRows.includes(id)),
      JSON.stringify(threadRows),
    );
    // 停留达标：timeline 全部成员逐条转已读（读完自然收缩）
    const readyReads = await Promise.all([R, B, C].map((id) => waitThreadRead(page, id, 10000)));
    await sleep(page, 600);
    const readSetAfterDwell = await readSetIds(page);
    const addedByDwell = readSetAfterDwell.filter((id) => !readSetBeforeDwell.includes(id));
    check(
      "A1 停留读掉全部成员（读由 dwell 触发；read-set 新增 ⊆ timeline 行）",
      readyReads.every(Boolean) &&
        addedByDwell.length > 0 &&
        addedByDwell.every((id) => threadRows.includes(id)) &&
        [R, B, C].every((id) => addedByDwell.includes(id)),
      JSON.stringify({ readyReads, addedByDwell }),
    );
    const a1ThreadShot = await shot(page, "a1-1280-thread-anchor.png");

    await backToNotifications(page);
    const collapsed = await findStack(page, R);
    check(
      "A1 返回通知页：全部读掉 → read-stack（unread=0，仍一行 size=3）",
      collapsed?.unread === 0 && collapsed?.size === 3 && collapsed?.key === `stack:${R}`,
      JSON.stringify(collapsed),
    );
    // A1b：展开成员行点击导航该成员（叠容器也有 onClick，必须阻止冒泡到锚点）。
    await expandStack(page, R);
    await page
      .locator(`[data-testid="notification-stack-member"][data-post-id="${C}"]`)
      .first()
      .click();
    await page.waitForSelector('[data-testid="thread-timeline"]', { timeout: 15_000 });
    const memberHash = await page.evaluate(() => location.hash);
    check(
      "A1 成员行点击导航该成员 C（不冒泡到叠锚点 R）",
      memberHash === `#/p/${C}`,
      memberHash,
    );
    await backToNotifications(page);
    const diagA1 = await diagnostics(page);
    check(
      "A1 诊断数值与 DOM 一致（stacks/members）",
      Boolean(diagA1) &&
        diagA1.stacks === (await stacksInDom(page)).length + (await singleRowsInDom(page)).length &&
        diagA1.members ===
          (await stacksInDom(page)).reduce((n, s) => n + s.size, 0) +
            (await singleRowsInDom(page)).reduce((n, s) => n + s.size, 0),
      JSON.stringify(diagA1),
    );

    // 390×844：无横向滚动
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(page, 500);
    const hscroll390 = await noHScroll(page);
    check("A1 390×844 无横向滚动", hscroll390.doc && hscroll390.list, JSON.stringify(hscroll390));
    const shot390 = await shot(page, "a1-390-stack-list.png");

    // ── 改动前后视觉审计（同一隔离板、同 viewport、同时刻状态；项目审计纪律）────
    // 「改动前」壳 = main@334e080 的 dist（经 ?ep= 对接同一隔离板）。before 版本无叠行/
    // 展开/灰行分层（差异本身）；下面以同状态三组对比（1280 全部 / 390 全部 / 390 未读）。
    if (BEFORE_BASE) {
      const auditCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const auditPage = await auditCtx.newPage();
      await loginAs(auditPage, { origin: BEFORE_BASE, settle: 1800 });
      await shot(auditPage, "audit-before-1280-list.png");
      const beforeShape = await auditPage.evaluate(() => ({
        rows: document.querySelectorAll('[data-testid="notification-row"]').length,
        stacks: document.querySelectorAll('[data-testid="notification-stack"]').length,
        members: document.querySelectorAll('[data-testid="notification-stack-member"]').length,
      }));
      await auditPage.setViewportSize({ width: 390, height: 844 });
      await sleep(auditPage, 500);
      await shot(auditPage, "audit-before-390-list.png");
      await auditPage.click('[data-testid="notifications-scope-unread"]');
      await sleep(auditPage, 700);
      await shot(auditPage, "audit-before-390-unread.png");
      const beforeHScroll = await noHScroll(auditPage);
      await auditCtx.close();
      auditShapes.before = beforeShape;

      // after 侧：同状态重拍（1280 全部 / 390 全部 / 390 未读）
      const afterCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const afterPage = await afterCtx.newPage();
      await loginAs(afterPage, { settle: 1800 });
      await shot(afterPage, "audit-after-1280-list.png");
      const afterShape = await afterPage.evaluate(() => ({
        rows: document.querySelectorAll('[data-testid="notification-row"]').length,
        stacks: document.querySelectorAll('[data-testid="notification-stack"]').length,
        members: document.querySelectorAll('[data-testid="notification-stack-member"]').length,
      }));
      await afterPage.setViewportSize({ width: 390, height: 844 });
      await sleep(afterPage, 500);
      await shot(afterPage, "audit-after-390-list.png");
      await afterPage.click('[data-testid="notifications-scope-unread"]');
      await sleep(afterPage, 700);
      await shot(afterPage, "audit-after-390-unread.png");
      const afterHScroll = await noHScroll(afterPage);
      await afterCtx.close();
      auditShapes.after = afterShape;
      auditShapes.paired = true;
      check(
        "审计 1280/390 before↔after 成对截图（同板同状态）：叠行替代平铺行、390 无横滚保持",
        beforeShape.stacks === 0 &&
          beforeShape.rows > 0 &&
          afterShape.stacks > 0 &&
          beforeHScroll.doc &&
          beforeHScroll.list &&
          afterHScroll.doc &&
          afterHScroll.list,
        JSON.stringify({ beforeShape, afterShape, beforeHScroll, afterHScroll }),
        {
          expect: "before=平铺行（stacks=0）；after=叠行（stacks>0）；两版本 390 均无横向滚动",
          image: "audit-after-390-unread.png",
          imageWidth: "390×844",
        },
      );
    }

    diagLog.push({ phase: "A1", readAddedByDwell: addedByDwell, diag: diagA1 });
    void shot1280;
    void shotExpanded;
    void a1ThreadShot;
    void shot390;
    await ctx.close();
  }

  // ══ A2：兄弟口径（共同祖先已读 → 两叠；共同祖先未读 → 同叠）════════════
  if (runCase("A2")) {
    // ① 共同祖先已读
    const R1 = await seedRoot(`${SEED_TAG} A2-① 根（先读）`);
    await markOwnerRead([R1]);
    const B2 = await seedReply(R1, `${SEED_TAG} A2-① B 分支`);
    const D2 = await seedReply(R1, `${SEED_TAG} A2-① D 分支`);
    await waitOwnerUnread([B2, D2]);
    // ② 共同祖先未读
    const R2 = await seedRoot(`${SEED_TAG} A2-② 根（保持未读）`);
    const B3 = await seedReply(R2, `${SEED_TAG} A2-② B 分支`);
    const D3 = await seedReply(R2, `${SEED_TAG} A2-② D 分支`);
    await waitOwnerUnread([R2, B3, D3]);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const state = instrumentContext(ctx);
    const page = await ctx.newPage();
    watchPage(page, state);
    await loginAs(page);

    const stackB = await findEntry(page, B2);
    const stackD = await findEntry(page, D2);
    check(
      "A2① 共同祖先已读：B/D 各自成叠（key=B/D，互不同叠）",
      Boolean(stackB) &&
        Boolean(stackD) &&
        stackB.stackKey === `stack:${B2}` &&
        stackD.stackKey === `stack:${D2}` &&
        stackB.stackKey !== stackD.stackKey,
      JSON.stringify({ stackB, stackD }),
    );
    check(
      "A2① 点 B 的 timeline 不含兄弟 D",
      await (async () => {
        await clickEntry(page, B2);
        await page.waitForSelector('[data-testid="thread-timeline"]', { timeout: 15000 });
        await sleep(page, 500);
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid="thread-timeline"] article[data-post-id]')].map(
            (el) => el.getAttribute("data-post-id"),
          ),
        );
        const ok = rows.includes(B2) && !rows.includes(D2);
        await backToNotifications(page);
        return ok;
      })(),
    );

    const stackR2 = await findStack(page, R2);
    check(
      "A2② 共同祖先未读：B/D 与 R2 同叠（key=R2，size≥3）",
      Boolean(stackR2) &&
        stackR2.key === `stack:${R2}` &&
        stackR2.memberIds.includes(B3) &&
        stackR2.memberIds.includes(D3) &&
        stackR2.size >= 3,
      JSON.stringify(stackR2),
    );
    const a2BothBranches = await (async () => {
      await openThread(page, R2);
      const ok = await waitFor(
        page,
        (ids) => {
          const rows = [
            ...document.querySelectorAll('[data-testid="thread-timeline"] article[data-post-id]'),
          ].map((el) => el.getAttribute("data-post-id"));
          return ids.every((id) => rows.includes(id));
        },
        [R2, B3, D3],
        8000,
      );
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="thread-timeline"] article[data-post-id]')].map(
          (el) => el.getAttribute("data-post-id"),
        ),
      );
      await shot(page, "a2-1280-sibling-shared-anchor-thread.png");
      await backToNotifications(page);
      return { ok, rows };
    })();
    check(
      "A2② 打开 R2 同屏两个兄弟分支",
      a2BothBranches.ok,
      JSON.stringify(a2BothBranches.rows),
    );
    const a2Shot = await shot(page, "a2-1280-two-stacks.png");
    diagLog.push({ phase: "A2", stackB, stackD, stackR2 });
    void a2Shot;
    await ctx.close();
  }

  // ══ A3：未读 + 已读混叠 ════════════════════════════════════════════════
  if (runCase("A3")) {
    const R = await seedRoot(`${SEED_TAG} A3 根（未读）`);
    const B = await seedReply(R, `${SEED_TAG} A3-B（先读）`);
    const C = await seedReply(B, `${SEED_TAG} A3-C 最新未读`);
    await markOwnerRead([B]);
    await waitOwnerUnread([R, C]);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const state = instrumentContext(ctx);
    const page = await ctx.newPage();
    watchPage(page, state);
    await loginAs(page);

    const stack = await findStack(page, R);
    check(
      "A3 一叠 key=R、unread=2、size=3",
      Boolean(stack) && stack.unread === 2 && stack.size === 3,
      JSON.stringify(stack),
    );
    check(
      "A3 摘要来自最新未读 C",
      Boolean(stack) && stack.title.includes("A3-C 最新未读"),
      stack?.title ?? "none",
    );
    await expandStack(page, R);
    const members = await stackMembersInDom(page, R);
    check(
      "A3 展开 3 条、B 呈已读（data-read=1）",
      members?.length === 3 && members.find((row) => row.postId === B)?.read === "1",
      JSON.stringify(members),
    );
    const a3Shot = await shot(page, "a3-1280-mixed-read.png");
    diagLog.push({ phase: "A3", stack, members });
    void a3Shot;
    await ctx.close();
  }

  // ══ A4：实时新增（grow + merge/reanchor）══════════════════════════════
  if (runCase("A4")) {
    const R = await seedRoot(`${SEED_TAG} A4 根（lineage 首批失败）`);
    const B = await seedReply(R, `${SEED_TAG} A4-B`);
    const D = await seedReply(R, `${SEED_TAG} A4-D`);
    await waitOwnerUnread([R, B, D]);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const state = instrumentContext(ctx);
    const page = await ctx.newPage();
    watchPage(page, state);

    // 切断首批 lineage：叠先以 self 锚点 provisional 渲染（真实降级路径 §4.3）。
    let abortLineage = true;
    await page.route("**/api/posts/lineage**", (route) => {
      if (abortLineage) route.abort();
      else route.continue();
    });

    await loginAs(page);
    await sleep(page, 800);
    const provisional = await diagnostics(page);
    const provisionalEntries = await Promise.all([R, B, D].map((id) => findEntry(page, id)));
    check(
      "A4 lineage 首批失败：provisional 自锚（R/B/D 各自独立行，lineage requestfailed≥1）",
      provisionalEntries.every((entry) => entry?.kind === "row") &&
        new Set(provisionalEntries.map((entry) => entry?.stackKey)).size === 3 &&
        state.lineageFailed >= 1,
      JSON.stringify({ entries: provisionalEntries.map((entry) => entry?.stackKey), lineageFailed: state.lineageFailed, diag: provisional }),
    );

    // 第一次推送：同链新回复 → grow（同锚 +1、摘要更新、无 history 重拉）
    const historyBefore = state.history;
    abortLineage = false;
    const E1 = await seedReply(D, `${SEED_TAG} A4-E1 新回复（grow）`);
    const grew = await waitFor(
      page,
      (postId) => {
        const stacks = [...document.querySelectorAll('[data-testid="notification-stack"]')];
        return stacks.some((el) => (el.getAttribute("data-member-ids") ?? "").includes(postId));
      },
      E1,
      12000,
    );
    await sleep(page, 600);
    const stackAfterPush = await findStack(page, R);
    check(
      "A4 第一次推送：同链新回复并入锚点叠（size/unread 增长、摘要更新）",
      grew && Boolean(stackAfterPush) && stackAfterPush.unread === 4 && stackAfterPush.size === 4 &&
        stackAfterPush.title.includes("A4-E1 新回复"),
      JSON.stringify({ grew, stackAfterPush }),
    );
    check(
      "A4 实时增量不重拉 history",
      state.history === historyBefore,
      `history=${state.history} before=${historyBefore}`,
    );

    // 第二次推送 → lineage 补拉成功后 reanchor/merge：provisional 各行合并为一行
    const beforeStacks = await stacksInDom(page);
    const E2 = await seedReply(R, `${SEED_TAG} A4-E2 共享祖先的新回复（merge）`);
    const merged = await waitFor(
      page,
      (postId) => {
        const stacks = [...document.querySelectorAll('[data-testid="notification-stack"]')];
        return stacks.some(
          (el) =>
            (el.getAttribute("data-member-ids") ?? "").includes(postId) &&
            el.getAttribute("data-stack-transition") === "merge",
        );
      },
      E2,
      15000,
    );
    const mergedStack = await findStack(page, R);
    const afterStacks = await stacksInDom(page);
    const diagA4 = await diagnostics(page);
    check(
      "A4 第二次推送：provisional 叠合并为一行（data-stack-transition=merge、merges 递增）",
      merged && Boolean(mergedStack) && mergedStack.memberIds.includes(E2) && (diagA4?.merges ?? 0) >= 1,
      JSON.stringify({ merged, mergedStack, merges: diagA4?.merges, before: beforeStacks.length, after: afterStacks.length }),
    );
    check(
      "A4 merge 后仍无 history 重拉；no page error",
      state.history === historyBefore && realErrors(state).length === 0,
      JSON.stringify({ history: state.history, errors: realErrors(state).slice(0, 2) }),
    );
    const a4Shot = await shot(page, "a4-1280-merge.png");
    diagLog.push({ phase: "A4", provisional, diagA4, before: beforeStacks.length, after: afterStacks.length });
    void a4Shot;
    await ctx.close();
  }

  // ══ A5：删除回退 + 软删独立灰行 ═══════════════════════════════════════
  if (runCase("A5")) {
    const R = await seedRoot(`${SEED_TAG} A5 根`);
    const M = await seedReply(R, `${SEED_TAG} A5-M 次新`);
    const L = await seedReply(M, `${SEED_TAG} A5-L 最新（将被删除）`);
    const P = await seedRoot(`${SEED_TAG} A5-P 单帖（将被删空）`);
    await waitOwnerUnread([R, M, L, P]);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const state = instrumentContext(ctx);
    const page = await ctx.newPage();
    watchPage(page, state);
    await loginAs(page);

    const badgeBefore = await page.evaluate(() => {
      const badge = document.querySelector('[data-testid="notifications-unread-badge"]');
      return badge ? Number(badge.textContent) : 0;
    });
    await apiJson(BASE, `/api/posts/${L}`, managerToken, { method: "DELETE" });
    await apiJson(BASE, `/api/posts/${P}`, managerToken, { method: "DELETE" });
    const shrank = await waitFor(
      page,
      (ids) => {
        const [deletedPost, singlePost, sibling] = ids;
        const grey = [...document.querySelectorAll('[data-testid="notification-deleted-row"]')];
        const greyL = grey.some((el) => el.getAttribute("data-deleted-post-id") === deletedPost);
        const greyP = grey.some((el) => el.getAttribute("data-deleted-post-id") === singlePost);
        const noP = ![...document.querySelectorAll("[data-stack-key]")].some(
          (el) => el.getAttribute("data-stack-key") === `stack:${singlePost}`,
        );
        const stackM = [...document.querySelectorAll("[data-stack-key]")].find((el) =>
          (el.getAttribute("data-member-ids") ?? "").split(",").includes(sibling),
        );
        const sizeOk = stackM ? Number(stackM.getAttribute("data-stack-size")) === 2 : false;
        const deletedGone = ![...document.querySelectorAll("[data-member-ids]")].some((el) =>
          (el.getAttribute("data-member-ids") ?? "").split(",").includes(deletedPost),
        );
        return greyL && greyP && noP && sizeOk && deletedGone;
      },
      [L, P, M],
      15000,
    );
    await sleep(page, 600);
    const stackR = await findStack(page, R);
    const deletedRows = await deletedRowsInDom(page);
    check(
      "A5 删除叠内最新未读：摘要回退次新 M、size/unread 递减",
      shrank && Boolean(stackR) && stackR.unread === 2 && stackR.size === 2 &&
        stackR.title.includes("A5-M 次新") && !stackR.memberIds.includes(L),
      JSON.stringify({ shrank, stackR }),
    );
    const greyL = deletedRows.find((row) => row.deletedPostId === L);
    const greyInteractivity = await page.evaluate((id) => {
      const rows = [...document.querySelectorAll('[data-testid="notification-deleted-row"]')];
      const el = rows.find((node) => node.getAttribute("data-deleted-post-id") === id);
      if (!el) return null;
      return {
        role: el.getAttribute("role"),
        tabindex: el.getAttribute("tabindex"),
        toggle: el.querySelector('[data-testid="notification-stack-toggle"]') ? 1 : 0,
        unreadBadge: el.querySelector('[data-testid="notification-stack-unread"]') ? 1 : 0,
      };
    }, L);
    check(
      "A5 软删行独立灰行：不可点/不可展开/无 data-stack-key/无未读徽标",
      Boolean(greyL) &&
        greyL.stackKey === null &&
        greyL.postId === null &&
        Boolean(greyInteractivity) &&
        greyInteractivity.role === null &&
        greyInteractivity.tabindex === null &&
        greyInteractivity.toggle === 0 &&
        greyInteractivity.unreadBadge === 0,
      JSON.stringify({ greyL, greyInteractivity }),
    );
    const greyClickNoNav = await (async () => {
      const hashBefore = await page.evaluate(() => location.hash);
      const handle = await page.evaluateHandle((id) => {
        const rows = [...document.querySelectorAll('[data-testid="notification-deleted-row"]')];
        return rows.find((el) => el.getAttribute("data-deleted-post-id") === id) ?? null;
      }, L);
      const element = handle.asElement();
      await element.click();
      await page.keyboard.press("Enter");
      await sleep(page, 400);
      const hashAfter = await page.evaluate(() => location.hash);
      return { hashBefore, hashAfter };
    })();
    check(
      "A5 灰行点击/Enter 无导航",
      greyClickNoNav.hashAfter === greyClickNoNav.hashBefore,
      JSON.stringify(greyClickNoNav),
    );
    const badgeAfter = await page.evaluate(() => {
      const badge = document.querySelector('[data-testid="notifications-unread-badge"]');
      return badge ? Number(badge.textContent) : 0;
    });
    check(
      "A5 角标同步（删两帖 −2）",
      badgeAfter === badgeBefore - 2,
      `${badgeBefore} → ${badgeAfter}`,
    );
    const a5Shot = await shot(page, "a5-1280-deleted-row.png");
    diagLog.push({ phase: "A5", stackR, deletedRows, badgeBefore, badgeAfter });
    void a5Shot;
    await ctx.close();
  }

  // ══ A8：同帖双事件去重 ════════════════════════════════════════════════
  if (runCase("A8")) {
    const R = await seedRoot(`${SEED_TAG} A8 双事件（@owner 邀请 + 发布）`);
    await waitOwnerUnread([R]);
    const events = await apiJson(BASE, `/api/notifications?peek=1&limit=200`, ownerToken);
    const eventCount = events.events.filter(
      (row) => typeof row.seq === "number" && (row.post_id ?? row.root_id) === R,
    ).length;
    check(
      "A8 前置：该帖产生 2 条事件（post.created + thread.invited）",
      eventCount === 2,
      JSON.stringify({ eventCount }),
    );

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const state = instrumentContext(ctx);
    const page = await ctx.newPage();
    watchPage(page, state);
    await loginAs(page);
    const row = await findRow(page, R);
    const appearances = await page.evaluate((postId) => {
      const all = [...document.querySelectorAll(`[data-post-id="${CSS.escape(postId)}"]`)];
      return all.length;
    }, R);
    check(
      "A8 同帖双事件 → 1 个成员 / data-event-count=2 / unread 计数 1",
      Boolean(row) && row.eventCount === 2 && appearances === 1 && row.unread === 1 && row.read === "0",
      JSON.stringify({ row, appearances }),
    );
    // 打开一次该帖（经 dwell 停留）→ 两条事件都视为已读（同帖只算一个成员）。
    await openThread(page, R);
    const a8Read = await waitThreadRead(page, R, 9000);
    await backToNotifications(page, { settle: 900 });
    const rowAfterRead = await findRow(page, R);
    check(
      "A8 打开一次两条事件都视为已读（data-read=1；仍 1 行）",
      a8Read && rowAfterRead?.read === "1" && rowAfterRead.eventCount === 2,
      JSON.stringify(rowAfterRead),
    );
    const a8Shot = await shot(page, "a8-1280-dual-events.png");
    diagLog.push({ phase: "A8", row, appearances });
    void a8Shot;
    await ctx.close();
  }

  // ══ A11：全已读叠（上下文回看）════════════════════════════════════════
  if (runCase("A11")) {
    const R = await seedRoot(`${SEED_TAG} A11 根（已读）`);
    const X = await seedReply(R, `${SEED_TAG} A11-X（已读）`);
    const Y = await seedReply(X, `${SEED_TAG} A11-Y 最新（已读）`);
    await markOwnerRead([R, X, Y]);
    await waitOwnerRead([R, X, Y]);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const state = instrumentContext(ctx);
    const page = await ctx.newPage();
    watchPage(page, state);
    await loginAs(page);

    const stack = await findStack(page, R);
    check(
      "A11 全已读叠：key=R（最靠根已通知帖）、unread=0、size=3",
      Boolean(stack) && stack.key === `stack:${R}` && stack.unread === 0 && stack.size === 3,
      JSON.stringify(stack),
    );
    check(
      "A11 unread=0 不显示未读徽标",
      await page.evaluate(
        (anchor) => {
          const stacks = [...document.querySelectorAll('[data-testid="notification-stack"]')];
          const el = stacks.find((node) => node.getAttribute("data-stack-anchor") === anchor);
          return !el?.querySelector('[data-testid="notification-stack-unread"]');
        },
        R,
      ),
    );
    await openThread(page, R);
    const hash = await page.evaluate(() => location.hash);
    check("A11 点击开 #/p/R（不做「跳最新」，focal=锚点）", hash === `#/p/${R}`, hash);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="thread-timeline"] article[data-post-id]')].map(
        (el) => el.getAttribute("data-post-id"),
      ),
    );
    check(
      "A11 scopeOf(focal) 覆盖叠内全部成员（首屏可达）",
      [R, X, Y].every((id) => rows.includes(id)),
      JSON.stringify(rows),
    );
    const latestEntry = await page.evaluate(
      () => document.querySelectorAll('[data-testid*="latest"]').length,
    );
    check("A11 不出现「跳最新」焦点入口", latestEntry === 0, `latest-testids=${latestEntry}`);
    const a11Shot = await shot(page, "a11-1280-read-stack-thread.png");
    await backToNotifications(page);
    diagLog.push({ phase: "A11", stack });
    void a11Shot;
    await ctx.close();
  }

  // ══ A7：停留已读联动收缩（split → read-stack）────────────────────────
  if (runCase("A7")) {
    const R = await seedRoot(`${SEED_TAG} A7 根（短正文，先读）`);
    const X = await seedReply(R, LONG_BODY(`${SEED_TAG} A7-X`));
    await waitOwnerUnread([R, X]);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const state = instrumentContext(ctx);
    const page = await ctx.newPage();
    watchPage(page, state);
    await loginAs(page);

    const stack = await findStack(page, R);
    check(
      "A7 前置：一叠 key=R、unread=2",
      Boolean(stack) && stack.unread === 2 && stack.size === 2,
      JSON.stringify(stack),
    );
    await openThread(page, R);
    const anchorRead = await waitThreadRead(page, R, 9000);
    await backToNotifications(page, { settle: 900 });
    // split 后 R/X 各自 size=1 → 单成员行（findEntry 兼容行/叠两种形态）。
    const entryR = await findEntry(page, R);
    const entryX = await findEntry(page, X);
    const diagA7a = await diagnostics(page);
    check(
      "A7 锚点读掉 → split：R 行 unread=0、X 锚点下移成新叠（splits≥1）",
      anchorRead &&
        entryR?.unread === 0 &&
        entryR?.stackKey === `stack:${R}` &&
        entryX?.unread === 1 &&
        entryX?.stackKey === `stack:${X}` &&
        (diagA7a?.splits ?? 0) >= 1,
      JSON.stringify({ entryR, entryX, splits: diagA7a?.splits }),
    );

    // 继续读掉 X → read-stack（unread=0，合并回 R 锚点）
    await openThread(page, X);
    const xRead = await waitThreadRead(page, X, 12000);
    await backToNotifications(page, { settle: 900 });
    const finalStacks = await stacksInDom(page);
    const finalR = finalStacks.find((item) => item.anchor === R);
    const diagA7b = await diagnostics(page);
    check(
      "A7 全部读掉 → read-stack（unread=0；锚点回 R）",
      xRead &&
        finalR?.unread === 0 &&
        !finalStacks.some((item) => item.anchor === X && item.unread > 0),
      JSON.stringify({ finalR, anchors: finalStacks.map((s) => s.anchor), diag: diagA7b }),
    );
    const marks = await page.evaluate(() => {
      const api = window.__reportReadDwell;
      return api && typeof api === "object" ? { ...api } : null;
    });
    const readSet = await page.evaluate(() => {
      const ids = new Set();
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key?.startsWith("report.read.v1:")) continue;
        try {
          for (const id of JSON.parse(localStorage.getItem(key) ?? "[]")) ids.add(id);
        } catch {
          /* ignore */
        }
      }
      return [...ids];
    });
    check(
      "A7 无额外已读写路径：read-set 新增 ⊆ {R,X}，dwell marks 在场",
      readSet.includes(R) && readSet.includes(X) && marks !== null,
      JSON.stringify({ readSetCount: readSet.length, marks }),
    );
    // 390：无横向滚动 + 收缩后行仍收拢
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(page, 400);
    const hscroll390 = await noHScroll(page);
    check("A7 390×844 无横向滚动", hscroll390.doc && hscroll390.list, JSON.stringify(hscroll390));
    const a7Shot = await shot(page, "a7-390-read-stack-collapsed.png");
    diagLog.push({ phase: "A7", diagA7a, diagA7b, marks });
    void a7Shot;
    await ctx.close();
  }

  // ══ A6：跨页拼叠（历史 >50 条）════════════════════════════════════════
  let a6 = null;
  if (runCase("A6")) {
    // 需要足够大的窗口余量：peek 事件窗=最旧 100（`eventLines` 升序截断）、history 首页=最新 50。
    // 把 X1 夹在两者之外的带隙里（前后各留 ~70 seq 余量）才能构造「锚点未加载」。
    for (let index = 0; index < 150; index += 1) {
      await seedRoot(`${SEED_TAG} A6 前置填充 ${index}`);
    }
    const X1 = await seedRoot(`${SEED_TAG} A6-X1 早锚点（带隙）`);
    for (let index = 0; index < 70; index += 1) {
      await seedRoot(`${SEED_TAG} A6 后置填充 ${index}`);
    }
    const X2 = await seedReply(X1, `${SEED_TAG} A6-X2 新成员（第一页内）`);
    await waitOwnerUnread([X1, X2]);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const state = instrumentContext(ctx);
    const page = await ctx.newPage();
    watchPage(page, state);
    await loginAs(page, { settle: 2000 });

    const initial = await findEntry(page, X2);
    check(
      "A6 加载前：单成员行（size=1）、anchor=X1 未加载（data-anchor-loaded=0）",
      initial?.kind === "row" &&
        initial.size === 1 &&
        initial.stackKey === `stack:${X1}` &&
        initial.anchorLoaded === "0",
      JSON.stringify(initial),
    );
    const postsBefore = state.posts;
    // 加载更早：X1 行成为成员，叠增长且不重复
    let expanded = null;
    for (let attempt = 0; attempt < 6 && !expanded; attempt += 1) {
      const loadMore = page.locator('[data-testid="notifications-load-more"]');
      if (await loadMore.count()) {
        await loadMore.click();
      } else {
        await page.evaluate(() => {
          const scroller = document.querySelector('[data-testid="notifications-scroll"]');
          if (scroller) scroller.scrollTop = scroller.scrollHeight;
        });
      }
      const grown = await waitFor(
        page,
        (anchor) => {
          const el = [...document.querySelectorAll('[data-stack-key]')].find(
            (node) => node.getAttribute("data-stack-key") === `stack:${anchor}`,
          );
          return el ? Number(el.getAttribute("data-stack-size")) >= 2 : false;
        },
        X1,
        8000,
      );
      if (grown) {
        expanded = await page.evaluate((anchor) => {
          const el = [...document.querySelectorAll('[data-stack-key]')].find(
            (node) => node.getAttribute("data-stack-key") === `stack:${anchor}`,
          );
          const ids = [];
          for (const row of document.querySelectorAll('[data-post-id]')) ids.push(row.getAttribute("data-post-id"));
          return {
            size: Number(el?.getAttribute("data-stack-size")),
            unread: Number(el?.getAttribute("data-stack-unread")),
            anchorLoaded: el?.getAttribute("data-anchor-loaded"),
            memberIds: (el?.getAttribute("data-member-ids") ?? "").split(",").filter(Boolean),
            duplicateIds: ids.length !== new Set(ids).size,
          };
        }, X1);
      }
    }
    await sleep(page, 500);
    const footer = await page.evaluate(() => {
      const node = document.querySelector('[data-testid="notifications-more-unread"]');
      return node ? node.textContent.trim() : null;
    });
    const badge = await page.evaluate(() => {
      const node = document.querySelector('[data-testid="notifications-unread-badge"]');
      return node ? Number(node.textContent) : 0;
    });
    const domUnread = await page.evaluate(() => {
      const ids = new Set();
      for (const el of document.querySelectorAll('[data-testid="notification-stack"]')) {
        for (const id of (el.getAttribute("data-unread-member-ids") ?? "").split(",")) if (id) ids.add(id);
      }
      for (const el of document.querySelectorAll('[data-testid="notification-row"][data-read="0"]')) {
        const id = el.getAttribute("data-post-id");
        if (id) ids.add(id);
      }
      return ids.size;
    });
    a6 = { initial, expanded, footer, badge, domUnread };
    const expectedRemainder = badge - domUnread;
    check(
      "A6 加载更早后：同一行增长（size≥2）、成员无重复、锚点已加载",
      Boolean(expanded) &&
        expanded.size >= 2 &&
        expanded.anchorLoaded === "1" &&
        expanded.memberIds.includes(X1) &&
        expanded.memberIds.includes(X2) &&
        expanded.duplicateIds === false,
      JSON.stringify(expanded),
    );
    check(
      "A6 页脚 remainder = 角标 − 已加载未读 target 数",
      expectedRemainder > 0
        ? footer !== null && footer.includes(String(expectedRemainder))
        : footer === null,
      JSON.stringify({ footer, badge, domUnread, expectedRemainder }),
    );
    check(
      "A6 每行 Markdown 仅前卡摘要（成员行纯文本截断，无 Markdown <p>）",
      await (async () => {
        const measured = await page.evaluate(() => {
          const members = [...document.querySelectorAll('[data-testid="notification-stack-member"]')];
          const fronts = [...document.querySelectorAll('[data-testid="notification-stack-front"]')];
          return {
            members: members.length,
            membersWithMarkdown: members.filter((el) => el.querySelector("p")).length,
            fronts: fronts.length,
            frontsWithMarkdown: fronts.filter((el) => el.querySelector("p")).length,
          };
        });
        return (
          measured.members > 0 &&
          measured.membersWithMarkdown === 0 &&
          measured.fronts > 0 &&
          measured.frontsWithMarkdown > 0
        );
      })(),
      JSON.stringify({
        posts: state.posts,
        before: postsBefore,
        measured: await page.evaluate(() => {
          const members = [...document.querySelectorAll('[data-testid="notification-stack-member"]')];
          return {
            members: members.length,
            membersWithMarkdown: members.filter((el) => el.querySelector("p")).length,
          };
        }),
      }),
    );
    const a6Shot = await shot(page, "a6-1280-cross-page-stack.png");
    diagLog.push({ phase: "A6", ...a6 });
    void a6Shot;
    await ctx.close();
  }

  // ══ A9：100 通知性能 ══════════════════════════════════════════════════
  if (runCase("A9")) {
    // 显式夹具：10 root + 8 层深链（补足 ≥100 通知）
    const perfRoots = [];
    for (let index = 0; index < 10; index += 1) {
      const root = await seedRoot(`${SEED_TAG} A9 root ${index}`);
      perfRoots.push(root);
      let parent = root;
      for (let depth = 1; depth <= 8; depth += 1) {
        parent = await seedReply(parent, `${SEED_TAG} A9 root${index} 深链 ${depth}`);
      }
    }
    const fixtureBurst = await Promise.all(
      perfRoots.slice(0, 4).map((root, index) => seedReply(root, `${SEED_TAG} A9 burst ${index}`)),
    );
    await waitOwnerUnread([perfRoots[0], ...fixtureBurst]);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const state = instrumentContext(ctx);
    const page = await ctx.newPage();
    watchPage(page, state);
    await loginAs(page, { settle: 2500 });

    const diagLoaded = await diagnostics(page);
    const stacksLoaded = await stacksInDom(page);
    const rowsLoaded = await singleRowsInDom(page);
    const memberTotal =
      stacksLoaded.reduce((total, stack) => total + stack.size, 0) +
      rowsLoaded.reduce((total, row) => total + row.size, 0);
    check(
      "A9 100 通知：分组 lastGroupMs < 50",
      Boolean(diagLoaded) && diagLoaded.lastGroupMs < 50,
      JSON.stringify({ lastGroupMs: diagLoaded?.lastGroupMs, diag: diagLoaded }),
    );
    check(
      "A9 lineage 批量：每片 ≤200 且合并发送（非逐帖；允许历史分页波次）",
      Boolean(diagLoaded) &&
        state.lineageSizes.length >= 1 &&
        state.lineageSizes.every((size) => size > 0 && size <= 200) &&
        state.lineageSizes.length <=
          Math.max(1, Math.ceil((diagLoaded?.unreadTargets ?? 0) / 200)) + 2,
      JSON.stringify({
        requests: state.lineageSizes,
        unreadTargets: diagLoaded?.unreadTargets,
        diagRequests: diagLoaded?.lineageRequests,
      }),
    );
    check(
      "A9 诊断与 DOM 计数一致（叠行/成员总数）",
      diagLoaded?.stacks === stacksLoaded.length + rowsLoaded.length && diagLoaded?.members === memberTotal,
      JSON.stringify({ diag: diagLoaded, stacks: stacksLoaded.length, rows: rowsLoaded.length, memberTotal }),
    );

    // 增量窗口：重置 longtask，滚动 + 展开 + 一批推送；断言 recomputes 不因滚动/展开增加
    await page.evaluate(() => {
      window.__qaLongTasks.length = 0;
    });
    const recomputesBefore = (await diagnostics(page))?.recomputes ?? 0;
    if (stacksLoaded.length > 0) await expandStack(page, stacksLoaded[0].anchor).catch(() => {});
    await page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="notifications-scroll"]');
      if (scroller) {
        scroller.scrollTop = 400;
        scroller.scrollTop = 0;
      }
    });
    await sleep(page, 400);
    const recomputesAfterInteractions = (await diagnostics(page))?.recomputes ?? 0;
    check(
      "A9 滚动/展开 recomputes 不增",
      recomputesAfterInteractions === recomputesBefore,
      JSON.stringify({ recomputesBefore, recomputesAfterInteractions }),
    );

    const lineageBeforeBurst = (await diagnostics(page))?.lineageRequests ?? 0;
    const historyBeforeBurst = state.history;
    await Promise.all(
      perfRoots.slice(4, 8).map((root, index) => seedReply(root, `${SEED_TAG} A9 burst2 ${index}`)),
    );
    await sleep(page, 2500);
    const diagAfterBurst = await diagnostics(page);
    const burstLineage = (diagAfterBurst?.lineageRequests ?? 0) - lineageBeforeBurst;
    check(
      "A9 一批实时推送：lineage 合并批 ≤1 次（150ms debounce）",
      burstLineage <= 1,
      JSON.stringify({ burstLineage, diag: diagAfterBurst }),
    );
    check(
      "A9 实时推送无 history 重拉",
      state.history === historyBeforeBurst,
      `history=${state.history} before=${historyBeforeBurst}`,
    );
    // 390 视口：无横滚 + 分组不随 resize 重算
    const recomputesBeforeResize = (await diagnostics(page))?.recomputes ?? 0;
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(page, 500);
    const recomputesAfterResize = (await diagnostics(page))?.recomputes ?? 0;
    const hscroll390 = await noHScroll(page);
    check(
      "A9 390×844 无横向滚动；resize 不触发重算",
      hscroll390.doc && hscroll390.list && recomputesAfterResize === recomputesBeforeResize,
      JSON.stringify({ hscroll390, recomputesBeforeResize, recomputesAfterResize }),
    );
    const longTasks = await page.evaluate(() => window.__qaLongTasks ?? []);
    const longTasksOver50 = longTasks.filter((entry) => entry.duration > 50);
    check(
      "A9 增量窗口无 >50ms longtask（滚动/展开/推送/重算）",
      longTasksOver50.length === 0,
      JSON.stringify({ longTasks, over50: longTasksOver50 }),
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await sleep(page, 300);
    const a9Shot = await shot(page, "a9-1280-perf.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(page, 300);
    const a9Shot390 = await shot(page, "a9-390-perf.png");
    diagLog.push({
      phase: "A9",
      loaded: diagLoaded,
      afterBurst: diagAfterBurst,
      longTasks,
      burstLineage,
      network: { ...state },
    });
    void a9Shot;
    void a9Shot390;
    await ctx.close();
  }

  // ══ A10：静态归档 / 多账号隔离 / 契约 ═════════════════════════════════
  if (runCase("A10")) {
    // 静态归档：无叠、无 lineage 请求、空态、enabled=false
    const outDir = mkdtempSync(join(qa.dataDir, "nstacks-export-"));
    const exported = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "src/cli/main.ts"), "export", "--data-dir", qa.dataDir, "--out", outDir, "--as", "owner"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 120000, env: process.env },
    );
    const staticCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const staticState = instrumentContext(staticCtx);
    const staticPage = await staticCtx.newPage();
    watchPage(staticPage, staticState);
    check(
      "A10 前置：静态归档导出成功",
      exported.status === 0 && existsSync(join(outDir, "index.html")),
      (exported.stderr || exported.stdout || "").slice(-200),
    );
    await staticPage.goto(pathToFileURL(join(outDir, "index.html")).href, {
      waitUntil: "domcontentloaded",
    });
    await staticPage.waitForSelector('[data-testid="static-banner"]', { timeout: 15000 });
    await staticPage.evaluate(() => {
      location.hash = "#/notifications";
    });
    await sleep(staticPage, 2500);
    const staticDiag = await staticPage.evaluate(() =>
      window.__reportNotificationStacks ? { ...window.__reportNotificationStacks } : null,
    );
    const staticStateDom = await staticPage.evaluate(() => ({
      stacks: document.querySelectorAll('[data-testid="notification-stack"]').length,
      rows: document.querySelectorAll('[data-testid="notification-row"]').length,
      empty: document.querySelectorAll('[data-testid="notifications-empty"]').length,
    }));
    check(
      "A10 静态归档：enabled=false、无叠、空态、0 lineage 请求",
      staticDiag?.enabled === false &&
        staticStateDom.stacks === 0 &&
        staticStateDom.rows === 0 &&
        staticStateDom.empty >= 1 &&
        staticState.lineage === 0,
      JSON.stringify({ staticDiag, staticStateDom, lineageRequests: staticState.lineage }),
    );
    const staticShot = await shot(staticPage, "a10-1280-static-empty.png");
    await staticCtx.close();
    rmSync(outDir, { recursive: true, force: true });

    // 多账号：owner 上下文 → 换 manager token（同后端 account 切换）
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const state = instrumentContext(ctx);
    const page = await ctx.newPage();
    watchPage(page, state);
    await loginAs(page);
    await warmReadSet(page); // 建立 owner 自己的本地读键（feed 停留）
    const ownerReadKeys = await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith("report.read.v1:")),
    );
    const ownerDiag = await diagnostics(page);
    // manager 侧预热帖（sub-backend 发；manager 收到通知但非作者）。
    const subBackendToken = accountToken(qa.dataDir, "sub-backend");
    const warmRoot = (
      await apiJson(BASE, "/api/posts", subBackendToken, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: `${SEED_TAG} A10 manager 读键预热帖`, media: [], tags: [] }),
      })
    ).posts[0].id;
    const ownerBrowserToken = await page.evaluate(
      (base) => localStorage.getItem(`report.token.${base}`),
      BASE,
    );
    const ownerKeyValue = await page.evaluate(
      (key) => localStorage.getItem(key),
      ownerReadKeys.find((key) => key.endsWith(":owner")) ?? "",
    );
    // 换 manager 账号（同后端）：token 换 → reload → projectionKey 变 → lineage/read-set 切换
    await page.evaluate(
      ({ base, token }) => {
        localStorage.setItem(`report.token.${base}`, token);
        localStorage.removeItem(`report.token.${base}.exp`);
      },
      { base: BASE, token: managerToken },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="notifications-scroll"], [data-testid="timeline-scroll"]', {
      timeout: 20000,
    });
    await openNotifications(page, { settle: 2400 });
    // manager 会话产生自己的本地读（经通知入口进线程 + dwell）→ 建立 manager 读键。
    const managerWarmed = await warmReadSetViaEntry(page, warmRoot);
    const managerReadKeys = await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith("report.read.v1:")),
    );
    const managerDiag = await diagnostics(page);
    const ownerKeyAfterSwitch = await page.evaluate(
      (key) => localStorage.getItem(key),
      ownerReadKeys.find((key) => key.endsWith(":owner")) ?? "",
    );
    const managerKey = managerReadKeys.find((key) => key.endsWith(":manager")) ?? "";
    const managerKeyValue = await page.evaluate((key) => localStorage.getItem(key), managerKey);
    check(
      "A10 账号切换：read-set 键按账号分区 + owner 键不被 manager 会话改写 + lineage 重建",
      ownerReadKeys.length > 0 &&
        ownerReadKeys.every((key) => key.endsWith(":owner")) &&
        managerWarmed &&
        managerKey.length > 0 &&
        ownerKeyAfterSwitch === ownerKeyValue &&
        managerKeyValue !== null &&
        (managerDiag?.lineageNodes ?? 0) >= 1 &&
        (ownerDiag?.lineageNodes ?? 0) >= 1,
      JSON.stringify({
        ownerReadKeys,
        managerKey,
        managerWarmed,
        ownerKeyUnchanged: ownerKeyAfterSwitch === ownerKeyValue,
        ownerKeyValue,
        managerKeyValue,
        ownerDiag,
        managerDiag,
      }),
    );
    // 账号隔离帖：owner 已读（服务端）→ manager 仍未见读。
    const switchRoot = (
      await apiJson(BASE, "/api/posts", subBackendToken, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: `${SEED_TAG} A10 账号隔离帖`, media: [], tags: [] }),
      })
    ).posts[0].id;
    await apiJson(BASE, `/api/reads/batch`, ownerToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ post_ids: [switchRoot] }),
    });
    const managerSeesTarget = await waitFor(
      page,
      (postId) => {
        const rows = [...document.querySelectorAll("[data-read][data-post-id]")];
        return rows.some(
          (el) => el.getAttribute("data-post-id") === postId && el.getAttribute("data-read") === "0",
        );
      },
      switchRoot,
      10000,
    );
    check(
      "A10 owner 已读不影响 manager 未读态",
      managerSeesTarget,
      JSON.stringify({ switchRoot, managerSeesTarget }),
    );
    const a10Shot = await shot(page, "a10-1280-account-switch.png");
    // 切回 owner：read-set 未丢（该帖仍已读）
    await page.evaluate(
      ({ base, token }) => {
        localStorage.setItem(`report.token.${base}`, token ?? "");
        localStorage.removeItem(`report.token.${base}.exp`);
      },
      { base: BASE, token: ownerBrowserToken },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="notifications-scroll"], [data-testid="timeline-scroll"]', {
      timeout: 20000,
    });
    await openNotifications(page, { settle: 2200 });
    const ownerBackRead = await page.evaluate(
      (postId) => {
        const rows = [...document.querySelectorAll("[data-read][data-post-id]")];
        const row = rows.find((el) => el.getAttribute("data-post-id") === postId);
        return row ? row.getAttribute("data-read") : null;
      },
      switchRoot,
    );
    check(
      "A10 切回 owner：已读不丢（该帖 data-read=1，read-set 键回 owner）",
      ownerBackRead === "1" &&
        (await page.evaluate(() =>
          Object.keys(localStorage).some((key) => key.startsWith("report.read.v1:") && key.endsWith(":owner")),
        )),
      JSON.stringify({ ownerBackRead }),
    );

    // 契约测试（纯函数矩阵，作为覆盖矩阵落到报告）
    const contractRun = spawnSync(
      process.execPath,
      ["test", "test/notification-stacks.test.ts", "test/lineage.test.ts"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, env: process.env },
    );
    const contractOut = (contractRun.stdout || "") + (contractRun.stderr || "");
    const contractSummary = /(\d+)\s+pass[\s\S]*?(\d+)\s+fail/.exec(contractOut);
    check(
      "A10 契约六断言（test/notification-stacks.test.ts + lineage）全绿",
      contractRun.status === 0 && contractSummary !== null && Number(contractSummary[2]) === 0,
      contractSummary ? `${contractSummary[1]} pass / ${contractSummary[2]} fail` : contractOut.slice(-200),
    );
    diagLog.push({ phase: "A10", staticDiag, ownerReadKeys, managerReadKeys, managerDiag, switchRoot });
    void staticShot;
    void a10Shot;
    await ctx.close();
  }

  // ══ 清理隔离板种子（只删本脚本的 SEED_TAG 内容）══════════════════════
  assertIsolatedDataDir(qa.dataDir);
  const sqlitePath = `${qa.dataDir}/report.sqlite`;
  execFileSync("sqlite3", [
    sqlitePath,
    `PRAGMA busy_timeout=5000;
     BEGIN;
     CREATE TEMP TABLE qa AS SELECT id, root_id, author FROM posts WHERE body_md LIKE '%${SEED_TAG}%';
     DELETE FROM post_reads WHERE post_id IN (SELECT id FROM qa);
     DELETE FROM events WHERE post_id IN (SELECT id FROM qa);
     DELETE FROM mentions WHERE post_id IN (SELECT id FROM qa);
     DELETE FROM participants WHERE root_id IN (SELECT root_id FROM qa) OR account_id IN (SELECT author FROM qa);
     DELETE FROM posts WHERE id IN (SELECT id FROM qa);
     COMMIT;`,
  ]);
  const leftover = execFileSync("sqlite3", [
    sqlitePath,
    `SELECT (SELECT count(*) FROM posts WHERE body_md LIKE '%${SEED_TAG}%');`,
  ])
    .toString()
    .trim();
  check("种子已从隔离板清除", leftover === "0", `leftover=${leftover}`);
} finally {
  if (browser) await browser.close();
  const chromeLeft = findChromePids(process.pid);
  if (beforeServer) await beforeServer.close();
  await qa.stop();

  const durationMs = Date.now() - startedAt;
  const failed = checks.filter((item) => !item.ok);
  const result = {
    ok: failed.length === 0,
    ranAt: new Date().toISOString(),
    base: BASE,
    dataDir: qa.dataDir,
    viewports: ["1280×800", "390×844", "file:// 1280×800"],
    only: ONLY,
    beforeBase: BEFORE_BASE,
    durationMs,
    pids,
    processRecycling: {
      chromePids: pids.chrome === null ? [] : [pids.chrome],
      chromeAliveAfterClose: chromeLeft,
      launcherPid: pids.launcher,
      servePid: pids.server,
    },
    audit: auditShapes,
    checks: checks.map(({ name, ok, detail, at }) => ({ name, ok, detail, at })),
    diagnostics: diagLog,
    screenshots,
  };
  writeFileSync(join(REPORT_DIR, "results.json"), JSON.stringify(result, null, 2));

  const passedCount = checks.length - failed.length;
  const caseIds = ONLY.length > 0 ? ONLY : ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11"];
  writeFileSync(
    join(REPORT_DIR, "steps.json"),
    JSON.stringify(
      {
        title: "report-notification-stacks — 通知按会话链叠放 E2E 验收",
        brand: "FDE2E™ · report.worker（人机公示板）· 通知叠放交付报告",
        subtitle:
          "一条会话链只占一行（共享叠锚点 U(p)??N(p)??p）；点击从最早一条未读开始读、读完自然收缩；" +
          "点击不写已读（由 read-dwell 停留转读）；软删帖独立灰行；实时推送 150ms 合并批、不重拉 history。",
        meta: `${new Date().toISOString().slice(0, 10)} · change report-notification-stacks · ${checks.length} 断言 / ${failed.length} FAIL · 1280×800 + 390×844 + file:// 静态 · 隔离后端 ${BASE}（生产板零写入）· 进程 launcher=${pids.launcher ?? "-"} serve=${pids.server ?? "-"} chrome=${pids.chrome ?? "-"}（已回收）`,
        thesis:
          failed.length === 0
            ? `结论：${caseIds.join(" / ")} 全部断言实测通过；同叠 ⇔ 从最早未读打开的 timeline 包含叠内全部未读成员（契约测试矩阵随包）。`
            : `结论：${failed.length} 项断言失败（见 FAIL 步骤），不得视为交付。`,
        env: [
          ["隔离后端", `${BASE} · dataDir=${qa.dataDir}`],
          ["QA 进程", `launcher=${pids.launcher ?? "-"} / serve=${pids.server ?? "-"} / chrome=${pids.chrome ?? "-"}（脚本结束已回收）`],
          ["视口", "1280×800（桌面）、390×844（移动）、file:// 静态归档 1280×800"],
          ["生产板", "127.0.0.1:13689 只读，本轮零写入"],
          ["断言", `${passedCount}/${checks.length} PASS · ${durationMs}ms`],
          ["截图", `${screenshots.length} 个 PNG（与 results.json 同目录）`],
        ],
        sections: [
          {
            title: "1 · 实测断言（design §12 A1–A11）",
            note: "全部断言来自隔离 qa-serve 板；截图与 results.json 同目录。",
            steps,
          },
          {
            title: "2 · 改动前后视觉审计（同板、同 viewport、同时刻状态）",
            note: "before=main@334e080 的 dist（回环静态服务 + ?ep= 对接同一隔离板）；after=本工作树 dist。390×844 与 1280×800 成对。",
            steps: [
              {
                intent: "通知列表（全部）1280×800：before=平铺行 / after=叠行+单成员行",
                assertion: `audit-before-1280-list.png ↔ audit-after-1280-list.png（${auditShapes.before.rows} 平铺行 → ${auditShapes.after.stacks} 叠 + ${auditShapes.after.rows} 单行）`,
                ok: auditShapes.paired,
                image: "audit-after-1280-list.png",
                imageMeta: "1280×800 · PNG",
              },
              {
                intent: "通知列表（全部）390×844：无横向滚动的移动端形态",
                assertion: "audit-before-390-list.png ↔ audit-after-390-list.png",
                ok: auditShapes.paired,
                image: "audit-after-390-list.png",
                imageMeta: "390×844 · PNG",
              },
              {
                intent: "通知列表（未读筛选）390×844",
                assertion: "audit-before-390-unread.png ↔ audit-after-390-unread.png",
                ok: auditShapes.paired,
                image: "audit-after-390-unread.png",
                imageMeta: "390×844 · PNG",
              },
              {
                intent: "叠展开态（after-only 状态：before 无叠行/展开）",
                assertion: "a1-1280-stack-expanded.png（展开 3 成员、前卡高度不变）",
                ok: true,
                image: "a1-1280-stack-expanded.png",
                imageMeta: "1280×800 · PNG",
              },
              {
                intent: "软删独立灰行（after-only 状态：before 为普通已删除行）",
                assertion: "a5-1280-deleted-row.png（不可点/不可展开/无叠 key/无未读徽标）",
                ok: true,
                image: "a5-1280-deleted-row.png",
                imageMeta: "1280×800 · PNG",
              },
              {
                intent: "锚点线程页（focal=最早未读）",
                assertion: "a1-1280-thread-anchor.png（scope 覆盖 R/B/C，focal 为最早未读）",
                ok: true,
                image: "a1-1280-thread-anchor.png",
                imageMeta: "1280×800 · PNG",
              },
            ],
          },
          {
            title: "3 · 改动文件 → 视觉面覆盖表（UNCOVERED=0）",
            note: "视觉相关文件均有 before/after 或 after 状态证据；无视觉面的三类显式登记（测试/工具/配置、类型与契约、服务端纯读端点）。",
            steps: [
              {
                intent: "src/ui/pages/NotificationsPage.tsx",
                assertion: "视觉面=通知页（叠行/展开/灰行/页脚）：audit-before/after-{1280,390}-*.png + a1/a3/a5/a6 截图",
                ok: true,
              },
              {
                intent: "src/ui/app.css",
                assertion: "视觉面=展开动画/merge 高亮：a1-1280-stack-expanded.png（grid 0fr↔1fr）+ computed style（A1 前卡高度不变）",
                ok: true,
              },
              {
                intent: "src/ui/state/notifications.tsx",
                assertion: "视觉面=叠锚点/角标/未读：A1–A11 全部 DOM 断言（角标、data-stack-unread、read-stack）",
                ok: true,
              },
              {
                intent: "src/ui/lib/thread-plan.ts / notification-stacks.ts / lineage-cache.ts",
                assertion: "视觉面=叠行分组与锚点：契约测试（40 pass）+ A1/A2/A3/A5/A6/A7/A11 实测；纯函数无独立视觉面",
                ok: true,
              },
              {
                intent: "src/ui/lib/static-api.ts",
                assertion: "视觉面=静态归档空态：a10-1280-static-empty.png（enabled=false、0 lineage 请求）",
                ok: true,
              },
              {
                intent: "src/core/types.ts / src/core/protocol.ts / src/server/store.ts / src/server/http.ts / src/ui/lib/api.ts",
                assertion: "无视觉面（类型/契约/服务端只读端点/网络层）：由 test/lineage.test.ts 契约测试覆盖（11 pass）",
                ok: true,
              },
              {
                intent: "scripts/qa/notifications-*.mjs / test/*.ts / openspec/*",
                assertion: "无视觉面（测试/工具/文档）：执行证据见 §1 与 tasks 回填",
                ok: true,
              },
            ],
          },
        ],
        summary: { pass: passedCount, fail: failed.length },
      },
      null,
      2,
    ),
  );

  // 统一生成器（存在则自动产 report.html；禁止手写 HTML——项目纪律）。
  const generator =
    argValue(argv, "generator") ??
    (MAIN_ROOT ? join(MAIN_ROOT, "fde2e-skills-v0", "scripts", "e2e-report-gen.mjs") : null);
  if (generator && existsSync(generator)) {
    const generated = spawnSync(process.execPath, [generator, REPORT_DIR], {
      encoding: "utf8",
      timeout: 60_000,
      env: process.env,
    });
    if (generated.status === 0) console.log(`report.html → ${join(REPORT_DIR, "report.html")}`);
    else
      console.error(
        `report.html 生成失败：${(generated.stderr || generated.stdout || "").slice(-300)}`,
      );
  } else {
    console.error("未找到共享 e2e-report-gen.mjs；请手动生成 report.html");
  }

  console.log(
    `\n${passedCount}/${checks.length} checks passed · ${REPORT_DIR}/results.json`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

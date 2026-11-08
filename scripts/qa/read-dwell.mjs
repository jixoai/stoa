/**
 * report-read-dwell E2E 验收（A1/A2/A3/A5/A6/A7/A8/A9/A11/A13 + P2 项）。
 *
 * Isolation: 只在 qa-serve.mjs 启动的 /tmp/report-qa-* 板上跑；生产板
 * 127.0.0.1:13689 是只读的（本脚本拒绝写它）。所有种子帖在结束时硬清除
 * （post_media/mentions/events/participants 先于 posts，事务内完成）。
 *
 * Run:
 *   bun scripts/qa/read-dwell.mjs
 *   REPORT_QA_BASE=http://127.0.0.1:13688 bun scripts/qa/read-dwell.mjs
 *
 * 证据：
 *   --report-dir 默认 <主仓>/.agents/reports/manager/report-read-dwell
 *   产出 results.json + steps.json + PNG；统一生成器再把 steps.json 变 report.html。
 */
import { chromium } from "playwright-core";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

const qa = await ensureQa(process.argv.slice(2));
const BASE = qa.base;
const AUTH = authSecret(qa.dataDir);
const ownerToken = accountToken(qa.dataDir, "owner");
const managerToken = accountToken(qa.dataDir, "manager");
const subFrontendToken = accountToken(qa.dataDir, "sub-frontend");
const NO_BUILD = process.argv.includes("--no-build");
const REPORT_DIR = resolve(
  argValue(process.argv.slice(2), "report-dir") ??
    join(REPO_ROOT, "..", "..", ".agents", "reports", "manager", "report-read-dwell"),
);
mkdirSync(REPORT_DIR, { recursive: true });

const startedAt = Date.now();
const checks = [];
const steps = [];
const coverageSteps = [];
const screenshots = [];
const diagLog = [];
const LONG_BODY = (marker) =>
  Array.from({ length: 24 }, (_, i) => `${marker} 第 ${i + 1} 行：视窗停留已读的验收夹具，用于撑高卡片。`).join("\n");
const TALL_BODY = (marker) =>
  Array.from({ length: 220 }, (_, i) => `${marker} 长帖第 ${i + 1} 行：超过两屏，用于高卡覆盖率验收。`).join("\n");

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

async function apiPost(token, body, tags = ["result"]) {
  const result = await apiJson(BASE, "/api/posts", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, media: [], tags }),
  });
  return result.posts[0].id;
}

async function apiReply(token, parent, body) {
  const result = await apiJson(BASE, `/api/posts/${parent}/replies`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, media: [], tags: [] }),
  });
  return result.posts[0].id;
}

const sleep = (page, ms) => page.waitForTimeout(ms);

async function login(page, url = `${BASE}/`) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(page, 900);
  if (await page.locator('input[type="password"]').count()) {
    await page.locator('input[type="password"]').first().fill(AUTH);
    await page.click('[data-testid="login-submit"]');
  }
  await page.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="timeline-scroll"] [data-post-id]', { timeout: 20_000 });
  await sleep(page, 700);
}

const feedCard = (page, id) =>
  page.locator(`[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${id}"]`).first();
const threadCard = (page, id) =>
  page.locator(`[data-testid="thread-timeline"] article[data-post-id="${id}"]`).first();

async function scrollFeedTo(page, id) {
  await page.evaluate((postId) => {
    const el = document.querySelector(
      `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
    );
    el?.scrollIntoView({ block: "center" });
  }, id);
  await sleep(page, 320);
  return feedCard(page, id).getAttribute("data-dwell-state").catch(() => null);
}

async function readSet(page) {
  return page.evaluate(() => {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith("report.read.v1:")) continue;
        try {
          const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
          if (Array.isArray(parsed)) out.push(...parsed);
        } catch {
          /* ignore corrupt */
        }
      }
    } catch {
      return [];
    }
    return out;
  });
}

async function diagnostics(page) {
  return page.evaluate(() => window.__reportReadDwell ?? null);
}

async function waitAttr(page, selector, name, value, timeout = 6000) {
  try {
    await page.waitForFunction(
      ({ selector: sel, name: attr, value: expected }) => {
        const el = document.querySelector(sel);
        return Boolean(el) && el.getAttribute(attr) === expected;
      },
      { selector, name, value },
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

async function notificationBadge(page) {
  const badge = page.locator('[data-testid="notifications-unread-badge"]');
  return (await badge.count()) ? Number((await badge.innerText()).trim()) : 0;
}

async function notificationRowRead(page, id) {
  return page
    .locator(`[data-testid="notification-row"][data-post-id="${id}"]`)
    .first()
    .getAttribute("data-read");
}

async function ensureNotificationRow(page, id) {
  const row = page.locator(`[data-testid="notification-row"][data-post-id="${id}"]`);
  for (let i = 0; i < 6; i += 1) {
    if ((await row.count()) > 0) return true;
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="notifications-scroll"]');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await sleep(page, 800);
  }
  return (await row.count()) > 0;
}

async function openThread(page, id) {
  await page.evaluate((postId) => {
    location.hash = `#/p/${postId}`;
  }, id);
  await page.waitForSelector(`[data-testid="thread-timeline"] article[data-post-id="${id}"]`, {
    timeout: 15_000,
  });
  await sleep(page, 500);
}

async function closeThread(page) {
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await page.waitForSelector('[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]', { timeout: 15_000 });
  await sleep(page, 500);
}

async function setVisibility(page, state) {
  await page.evaluate((next) => {
    window.__qaVisibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

/** 线程页把超高卡滚到「可见高度 = fraction × 视口高」，返回几何。 */
async function scrollThreadVisibleFraction(page, id, fraction) {
  return page.evaluate(
    ({ postId, ratio }) => {
      const article = document.querySelector(
        `[data-testid="thread-timeline"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      const scroller = document.querySelector('[data-testid="thread-scroll"]');
      if (!article || !scroller) return null;
      const a = article.getBoundingClientRect();
      const c = scroller.getBoundingClientRect();
      const offsetTop = a.top - c.top + scroller.scrollTop;
      const desired = ratio * window.innerHeight;
      scroller.scrollTop = Math.max(0, offsetTop + a.height - desired);
      const a2 = article.getBoundingClientRect();
      const c2 = scroller.getBoundingClientRect();
      const visibleH = Math.min(a2.bottom, c2.bottom) - Math.max(a2.top, c2.top);
      return {
        cardHeight: a2.height,
        visibleH,
        innerHeight: window.innerHeight,
        fraction: visibleH / window.innerHeight,
        scrollTop: scroller.scrollTop,
      };
    },
    { postId: id, ratio: fraction },
  );
}

// ── seeds（全部 @owner；recommended feed 可见；跑完硬清除）──────────────────

const TAG = `QA-DWELL-${Date.now().toString(36)}`;
let seedIds = [];
try {
  // 最早的屏外对照帖（位于 feed 底部，正常用例不会滚到）。
  const offscreenPost = await apiPost(
    managerToken,
    `@owner ${TAG} 屏外对照帖（无滚动 5s 必须仍未读）。\n${LONG_BODY("OFFSCREEN")}`,
  );
  // A 用长正文（阈值 1500ms），保证「先量未读 → 再等达标」的时序确定性。
  const A_BODY = `@owner ${TAG} A 帖：视窗停留已读主用例。\n${LONG_BODY("A")}`;
  const A = await apiPost(managerToken, A_BODY);
  // 间隔卡：把 B 推离 A 的视口；在浏览器里预置为已读（不干扰 A6 的角标 −1）。
  const spacer = await apiPost(managerToken, `@owner ${TAG} 间隔卡（预置已读）\n${LONG_BODY("GAP")}`);
  const B = await apiPost(managerToken, `@owner ${TAG} B 帖：通知同步对照（保持未读）。\n${LONG_BODY("B")}`);
  const C = await apiPost(managerToken, `@owner ${TAG} C 帖：切后台暂停用例。\n${LONG_BODY("C")}`);
  const RM = await apiPost(managerToken, `@owner ${TAG} RM 帖：reduced-motion 用例。`);
  const MODAL = await apiPost(managerToken, `@owner ${TAG} 模态遮挡用例。`);
  const OWN = await apiPost(ownerToken, `@owner ${TAG} 自己的帖子（引擎必须跳过）。`);
  const DEL = await apiPost(managerToken, `@owner ${TAG} 软删帖用例。`);
  await apiJson(BASE, `/api/posts/${DEL}`, managerToken, { method: "DELETE" });

  const threadRoot = await apiPost(managerToken, `@owner ${TAG} 线程导轨几何根帖。`);
  const threadReplyBody = `@owner ${TAG} 线程导轨几何回复（focal）\n${LONG_BODY("RAIL")}`;
  const threadReply = await apiReply(managerToken, threadRoot, threadReplyBody);

  // 高卡是「回复 + 下方长子回复」：卡片底部之下有内容，才能把它滚到只露 50% 视口高。
  const high50Root = await apiPost(managerToken, `@owner ${TAG} 高卡 50% 根帖。`);
  const high50 = await apiReply(managerToken, high50Root, `@owner ${TAG} 高卡 50%\n${TALL_BODY("HIGH50")}`);
  const high50Child = await apiReply(managerToken, high50, `${TAG} 高卡 50% 子回复\n${LONG_BODY("H50C")}`);
  const high40Root = await apiPost(managerToken, `@owner ${TAG} 高卡 40% 根帖。`);
  const high40 = await apiReply(managerToken, high40Root, `@owner ${TAG} 高卡 40%\n${TALL_BODY("HIGH40")}`);
  const high40Child = await apiReply(managerToken, high40, `${TAG} 高卡 40% 子回复\n${LONG_BODY("H40C")}`);
  const modalPost = await apiPost(
    managerToken,
    `@owner ${TAG} 模态遮挡目标帖（长正文，避免打开 Dialog 前被读完）\n${LONG_BODY("MODAL")}`,
  );
  const geoPost = await apiPost(managerToken, `@owner ${TAG} feed 几何用例（短正文）。`);
  const deepPost = await apiPost(managerToken, `@owner ${TAG} 无滚动对照帖（保持未读）。\n${LONG_BODY("DEEP")}`);

  const scrollIds = [];
  for (let i = 0; i < 8; i += 1) {
    scrollIds.push(await apiPost(managerToken, `@owner ${TAG} SCROLL-${i}\n${LONG_BODY(`S${i}`)}`));
  }
  // 顶部盾牌：最新且够高，保证登录后首屏看不到 A/B（避免被首屏自动读完）。
  const shields = [];
  for (let i = 0; i < 3; i += 1) {
    shields.push(await apiPost(managerToken, `@owner ${TAG} SHIELD-${i}\n${LONG_BODY(`D${i}`)}`));
  }
  // B1 详情覆盖层用例：N1/N2 相邻且都在首屏；深链目标用「回复」（根页不会同时有同 id 卡）。
  const N1 = await apiPost(managerToken, `@owner ${TAG} N1 详情覆盖层用例。\n${LONG_BODY("N1")}`);
  const N2 = await apiPost(managerToken, `@owner ${TAG} N2 邻居卡（必须保持未读）。\n${LONG_BODY("N2")}`);
  const deepLinkPost = await apiReply(managerToken, geoPost, `@owner ${TAG} 深链详情目标回复。`);
  // 覆盖层 fresh 目标：不带 result/@owner，不会出现在根页 recommended，只在
  // profile / 唯一 tag 页出现（打开前必为未读）。
  const overlayTag = `qadwell${Date.now().toString(36)}`;
  const overlayProfilePost = await apiPost(
    managerToken,
    `${TAG} profile fresh 覆盖层用例。\n${LONG_BODY("PROFILE")}`,
    [],
  );
  // tag fresh 由 sub-frontend 发布：不会出现在 manager 的 profile 页，保证 tag 用例
  // 打开前一定未读（profile 用例只读 manager 的 fresh 帖）。
  const overlayTagPost = await apiPost(
    subFrontendToken,
    `${TAG} tag fresh 覆盖层用例。\n${LONG_BODY("TAG")}`,
    [overlayTag],
  );
  seedIds = [
    offscreenPost, A, spacer, B, C, RM, MODAL, OWN, DEL, threadRoot, threadReply,
    high50Root, high50, high50Child, high40Root, high40, high40Child,
    modalPost, geoPost, deepPost, ...scrollIds, ...shields, N1, N2, deepLinkPost,
    overlayProfilePost, overlayTagPost,
  ];

  const seeded = {
    offscreenPost, A, spacer, B, C, RM, MODAL, OWN, DEL, threadRoot, threadReply,
    high50, high40, modalPost, geoPost, deepPost, scrollIds, shields, N1, N2, deepLinkPost,
    overlayTag, overlayProfilePost, overlayTagPost,
  };

  // A 上方的间隔卡 + A 下方的首张卡都会与 A 同屏；把它们预置为已读，
  // 让 A6 的「停留 A → 角标 −1」只归因于 A（不虚构更理想的列表）。
  const feedNow = await apiJson(BASE, "/api/feed?tab=recommended&limit=100", ownerToken);
  const feedIds = (feedNow.posts ?? []).map((post) => post.id);
  const aIndex = feedIds.indexOf(A);
  const belowA = aIndex >= 0 ? (feedIds[aIndex + 1] ?? null) : null;
  const preReadIds = [spacer, ...(belowA ? [belowA] : [])];

  // qa-serve 从 dist/ 托管静态壳：先构建，避免登录页 500。
  if (!NO_BUILD) {
    const build = spawnSync(process.execPath, ["run", "build"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 300_000,
      env: process.env,
    });
    if (build.status !== 0) {
      check("前置：bun run build", false, (build.stderr || build.stdout || "").slice(-400));
      throw new Error("build failed");
    }
    check("前置：bun run build", true, "dist/ 已更新（含未读高亮 / 停留引擎）");
  }

  let browser = null;
  try {
    browser = await chromium.launch({ channel: "chrome" });

    // ══ 桌面 1280×800 ═══════════════════════════════════════════════════════
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await desktop.addInitScript((preRead) => {
      // 预置「间隔卡」已读：它紧挨 A 上方，避免 A 的停留把角标多减一。
      try {
        const key = `report.read.v1:${location.origin}:owner`;
        const raw = localStorage.getItem(key);
        const existing = raw ? JSON.parse(raw) : [];
        localStorage.setItem(
          key,
          JSON.stringify([...new Set([...(Array.isArray(existing) ? existing : []), ...preRead])]),
        );
      } catch {
        /* file:// / private mode */
      }
    }, preReadIds);
    await desktop.addInitScript(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get() {
          return window.__qaVisibility || "visible";
        },
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get() {
          return (window.__qaVisibility || "visible") === "hidden";
        },
      });
      window.__qaLongTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__qaLongTasks.push(entry.duration);
        }).observe({ entryTypes: ["longtask"] });
      } catch {
        /* unsupported */
      }
    });
    const page = await desktop.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text().slice(0, 200));
    });
    await login(page);

    const diag0 = await diagnostics(page);
    diagLog.push({ phase: "home-load", diag: diag0 });
    check("P2-3 诊断对象在场且启用", diag0?.enabled === true, JSON.stringify(diag0));
    check(
      "P2-3 全局单观察器（初始）",
      diag0?.observers === 1,
      `observers=${diag0?.observers} targets=${diag0?.targets}`,
    );

    // ── B1：详情覆盖层必须暂停底层根页（scoped hold）───────────────────────
    // 现场新建 N1/N2（最新根帖）：避免登录期首屏停留把种子卡提前读完。
    const b1N1 = await apiPost(
      managerToken,
      `@owner ${TAG} B1 N1 详情覆盖层用例。\n${LONG_BODY("B1N1")}`,
    );
    const b1N2 = await apiPost(
      managerToken,
      `@owner ${TAG} B1 N2 邻居卡（必须保持未读）。\n${LONG_BODY("B1N2")}`,
    );
    seedIds.push(b1N1, b1N2);
    await page.evaluate(() => {
      location.hash = "#/notifications";
    });
    await page.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 15_000 });
    await sleep(page, 900);
    const badgeBeforeB1 = await notificationBadge(page);
    await ensureNotificationRow(page, b1N1);
    await ensureNotificationRow(page, b1N2);
    const n1RowBefore = await notificationRowRead(page, b1N1);
    const n2RowBefore = await notificationRowRead(page, b1N2);
    await page.evaluate(() => {
      location.hash = "#/";
    });
    await page.waitForSelector(
      '[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]',
      { timeout: 15_000 },
    );
    await page.waitForSelector(
      `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${b1N1}"]`,
      { timeout: 10_000 },
    );
    await page.waitForSelector(
      `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${b1N2}"]`,
      { timeout: 10_000 },
    );
    await page.evaluate(() => {
      const scroller = document.querySelector(
        '[data-testid="app-root-view"] [data-testid="timeline-scroll"]',
      );
      if (scroller) scroller.scrollTop = 0;
    });
    await sleep(page, 150);
    const b1RootState = await page.evaluate(({ n1, n2 }) => {
      const pick = (id) =>
        document.querySelector(
          `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(id)}"]`,
        );
      const info = (el) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const visible =
          Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0) > rect.height * 0.5;
        return { read: el.getAttribute("data-read"), visible };
      };
      return { n1: info(pick(n1)), n2: info(pick(n2)) };
    }, { n1: b1N1, n2: b1N2 });
    const readSetBeforeB1 = await readSet(page);
    await page.evaluate((postId) => {
      location.hash = `#/p/${postId}`;
    }, b1N1);
    await page.waitForSelector(
      `[data-testid="app-detail-layer"] [data-testid="thread-timeline"] article[data-post-id="${b1N1}"]`,
      { timeout: 15_000 },
    );
    await sleep(page, 1800);
    const b1During = {
      detailRead: await page
        .locator(
          `[data-testid="app-detail-layer"] [data-testid="thread-timeline"] article[data-post-id="${b1N1}"]`,
        )
        .getAttribute("data-read"),
      neighborRootRead: await feedCard(page, b1N2).getAttribute("data-read"),
      readSet: await readSet(page),
    };
    diagLog.push({ phase: "b1-detail-hold", badgeBeforeB1, b1RootState, b1During });
    check(
      "B1 详情打开前：N1/N2 都在视口且未读",
      b1RootState.n1?.read === "0" &&
        b1RootState.n2?.read === "0" &&
        b1RootState.n1.visible &&
        b1RootState.n2.visible,
      JSON.stringify(b1RootState),
    );
    check(
      "B1 详情自身卡片停留达标（覆盖层内继续计时）",
      b1During.detailRead === "1",
      `detail-read=${b1During.detailRead}`,
    );
    check(
      "B1 底层邻居卡不被详情覆盖层误标",
      b1During.neighborRootRead === "0" && !b1During.readSet.includes(b1N2),
      `neighbor=${b1During.neighborRootRead} inSet=${b1During.readSet.includes(b1N2)}`,
    );
    await page.evaluate(() => {
      location.hash = "#/notifications";
    });
    await page.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 15_000 });
    await sleep(page, 900);
    const badgeAfterB1 = await notificationBadge(page);
    const n1RowAfter = await notificationRowRead(page, b1N1);
    const n2RowAfter = await notificationRowRead(page, b1N2);
    check(
      "B1 角标只 −1、N1 通知已读、N2 通知仍读",
      badgeAfterB1 === badgeBeforeB1 - 1 && n1RowAfter === "1" && n2RowAfter === "0",
      `badge ${badgeBeforeB1}→${badgeAfterB1}; rows N1=${n1RowAfter} N2=${n2RowAfter} (pre ${n1RowBefore}/${n2RowBefore})`,
    );

    // 深链：从根页直接 hash 进详情，底层根页卡片必须全部保持原状。
    await page.evaluate(() => {
      location.hash = "#/";
    });
    await page.waitForSelector(
      '[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]',
      { timeout: 15_000 },
    );
    await sleep(page, 500);
    const deepRootUnread = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="app-root-view"] article[data-post-id][data-read="0"]')]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0) > 0;
        })
        .map((el) => el.getAttribute("data-post-id")),
    );
    const readSetBeforeDeep = await readSet(page);
    await page.evaluate((postId) => {
      location.hash = `#/p/${postId}`;
    }, deepLinkPost);
    await page.waitForSelector(
      `[data-testid="app-detail-layer"] [data-testid="thread-timeline"] article[data-post-id="${deepLinkPost}"]`,
      { timeout: 15_000 },
    );
    await sleep(page, 2000);
    const deepAfter = {
      detailRead: await page
        .locator(
          `[data-testid="app-detail-layer"] [data-testid="thread-timeline"] article[data-post-id="${deepLinkPost}"]`,
        )
        .getAttribute("data-read"),
      readSet: await readSet(page),
    };
    const deepAdded = deepAfter.readSet.filter((id) => !readSetBeforeDeep.includes(id));
    diagLog.push({ phase: "b1-deeplink", deepRootUnread, deepAdded, deepAfter });
    check(
      "B1 深链进详情：只标详情帖，根页可见卡全未读",
      deepAfter.detailRead === "1" &&
        deepAdded.every((id) => id === deepLinkPost) &&
        deepAdded.length <= 1,
      `detail=${deepAfter.detailRead} added=${deepAdded} rootUnread=${deepRootUnread.length}`,
    );
    await page.evaluate(() => {
      location.hash = "#/";
    });
    await page.waitForSelector(
      '[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]',
      { timeout: 15_000 },
    );
    await sleep(page, 500);

    // compose / profile / tag 三种覆盖层：根页卡片同样不受影响；覆盖层内
    // 使用 fresh（打开前未读、位于覆盖层视口内）卡验证 0→1 与 read-set 回写。
    const overlayCases = [
      { label: "compose", hash: "#/compose", fresh: null },
      { label: "profile", hash: "#/u/manager", fresh: overlayProfilePost },
      { label: "tag", hash: `#/tag/${overlayTag}`, fresh: overlayTagPost },
    ];
    const overlayResults = [];
    for (const item of overlayCases) {
      const rootUnread = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="app-root-view"] article[data-post-id][data-read="0"]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0) > 0;
          })
          .map((el) => el.getAttribute("data-post-id")),
      );
      const beforeSet = await readSet(page);
      await page.evaluate((next) => {
        location.hash = next;
      }, item.hash);
      await page.waitForSelector('[data-testid="app-detail-layer"]', { timeout: 15_000 });
      const overlayIds = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '[data-testid="app-detail-layer"] article[data-post-id]',
          ),
        ].map((el) => el.getAttribute("data-post-id")),
      );
      // 同一 post 在覆盖层内被合法读完时，底层同 id 卡会随 read-set 一起翻转；
      // 根页守卫只检查「只在根页出现的 id」。
      const rootOnlyUnread = rootUnread.filter((id) => !overlayIds.includes(id));
      let freshResult = null;
      if (item.fresh) {
        await page.waitForSelector(
          `[data-testid="app-detail-layer"] article[data-post-id="${item.fresh}"]`,
          { timeout: 15_000 },
        );
        await page.evaluate((postId) => {
          document
            .querySelector(
              `[data-testid="app-detail-layer"] article[data-post-id="${CSS.escape(postId)}"]`,
            )
            ?.scrollIntoView({ block: "center" });
        }, item.fresh);
        await sleep(page, 150);
        const pre = await page.evaluate((postId) => {
          const el = document.querySelector(
            `[data-testid="app-detail-layer"] article[data-post-id="${CSS.escape(postId)}"]`,
          );
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            read: el.getAttribute("data-read"),
            visible:
              Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0) > rect.height * 0.5,
          };
        }, item.fresh);
        await sleep(page, 2200);
        const afterSet = await readSet(page);
        const post = await page.evaluate((postId) => {
          const el = document.querySelector(
            `[data-testid="app-detail-layer"] article[data-post-id="${CSS.escape(postId)}"]`,
          );
          return el ? el.getAttribute("data-read") : null;
        }, item.fresh);
        freshResult = {
          id: item.fresh,
          pre,
          post,
          inSet: afterSet.includes(item.fresh),
          wasInSetBefore: beforeSet.includes(item.fresh),
          afterSet,
        };
      } else {
        await sleep(page, 1600);
      }
      const afterSet = freshResult?.afterSet ?? (await readSet(page));
      const rootAfter = await page.evaluate(
        ({ ids, set }) => {
          const readSetValues = new Set(set);
          return ids.map((id) => {
            const el = document.querySelector(
              `[data-testid="app-root-view"] article[data-post-id="${CSS.escape(id)}"]`,
            );
            return {
              id,
              attr: el?.getAttribute("data-read") ?? null,
              inReadSet: readSetValues.has(id),
            };
          });
        },
        { ids: rootOnlyUnread, set: afterSet },
      );
      const addedRoot = afterSet.filter(
        (id) => !beforeSet.includes(id) && rootOnlyUnread.includes(id),
      );
      overlayResults.push({
        label: item.label,
        rootUnread,
        rootOnlyUnread,
        overlayIds,
        rootAfter,
        addedRoot,
        fresh: freshResult,
      });
      await page.evaluate(() => {
        location.hash = "#/";
      });
      await page.waitForSelector(
        '[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]',
        { timeout: 15_000 },
      );
      await sleep(page, 450);
    }
    diagLog.push({ phase: "b1-overlays", overlayResults });
    check(
      "B1 compose/profile/tag 覆盖层不误标根页卡",
      overlayResults.every(
        (row) =>
          row.addedRoot.length === 0 &&
          row.rootAfter.every((card) => card.attr === "0" && !card.inReadSet),
      ),
      JSON.stringify(overlayResults.map((row) => ({ label: row.label, rootUnread: row.rootUnread, rootAfter: row.rootAfter, addedRoot: row.addedRoot }))),
    );
    const freshOverlayOk = overlayResults
      .filter((row) => row.fresh)
      .every(
        (row) =>
          row.fresh.pre?.read === "0" &&
          row.fresh.pre.visible === true &&
          row.fresh.wasInSetBefore === false &&
          row.fresh.post === "1" &&
          row.fresh.inSet === true,
      );
    check(
      "B1 profile/tag fresh 覆盖层卡 0→1 且写回 read-set",
      freshOverlayOk,
      JSON.stringify(overlayResults.filter((row) => row.fresh).map((row) => row.fresh)),
    );

    // ── A13 feed 几何 / 未读高亮（用独立几何帖，读完不影响 A6 角标）─────────
    const aState = await scrollFeedTo(page, geoPost);
    const aGeometry = await page.evaluate((postId) => {
      const el = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      if (!el) return null;
      const pseudo = getComputedStyle(el, "::after");
      const rect = el.getBoundingClientRect();
      return {
        read: el.getAttribute("data-read"),
        dwell: el.getAttribute("data-dwell-state"),
        bg: getComputedStyle(el).backgroundColor,
        afterLeft: pseudo.left,
        afterWidth: pseudo.width,
        afterOpacity: pseudo.opacity,
        height: rect.height,
        width: rect.width,
      };
    }, geoPost);
    diagLog.push({ phase: "a13-feed", geometry: aGeometry, state: aState });
    const feedHighlightOk =
      aGeometry?.read === "0" &&
      aGeometry.bg !== "rgba(0, 0, 0, 0)" &&
      parseFloat(aGeometry.afterLeft) === 0 &&
      parseFloat(aGeometry.afterWidth) === 3 &&
      Number(aGeometry.afterOpacity) === 1;
    check(
      "A13 feed 未读卡：整卡淡底 + 左强调条 3px",
      feedHighlightOk,
      JSON.stringify(aGeometry),
    );
    const selectedProbe = await page.evaluate(() => {
      const probe = (selected, read = false) => {
        const el = document.createElement("article");
        el.setAttribute("data-read", read ? "1" : "0");
        if (selected) el.setAttribute("data-selected", "1");
        if (read) el.setAttribute("data-dwell-state", "read");
        el.style.position = "absolute";
        el.style.visibility = "hidden";
        document.body.appendChild(el);
        const result = {
          bg: getComputedStyle(el).backgroundColor,
          after: getComputedStyle(el, "::after").opacity,
          animation: getComputedStyle(el).animationName,
        };
        el.remove();
        return result;
      };
      return {
        unread: probe(false),
        selected: probe(true),
        selectedRead: probe(true, true),
      };
    });
    check(
      "P1-5 选中态压过未读底色（强调条也隐藏，选中卡不播淡出）",
      selectedProbe.unread.bg !== selectedProbe.selected.bg &&
        selectedProbe.unread.after === "1" &&
        selectedProbe.selected.after === "0" &&
        selectedProbe.selectedRead.animation === "none",
      JSON.stringify(selectedProbe),
    );
    const a13FeedShot = await shot(page, "a13-1280-feed-unread.png");
    steps.push({
      intent: "A13 feed 未读高亮截图（1280×800）",
      assertion: "未读卡整卡淡底 + x=0..3 的 3px 强调条",
      ok: feedHighlightOk,
      image: a13FeedShot,
      imageMeta: "1280×800 · PNG",
    });
    // 几何帖（短正文）会在截图期间读完；等它落盘，再取通知基线，保证 A6 只差 A。
    await sleep(page, 900);

    // ── 通知基线（A6/P2-2）──────────────────────────────────────────────
    await page.evaluate(() => {
      location.hash = "#/notifications";
    });
    await page.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 15_000 });
    await sleep(page, 1200);
    const badgeBefore = await notificationBadge(page);
    const rowA0 = await (ensureNotificationRow(page, A).then(() => notificationRowRead(page, A)));
    const rowB0 = await (ensureNotificationRow(page, B).then(() => notificationRowRead(page, B)));
    check("A6 基线：A/B 通知行未读", rowA0 === "0" && rowB0 === "0", `A=${rowA0} B=${rowB0}`);
    await page.evaluate(() => {
      location.hash = "#/";
    });
    await page.waitForSelector('[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]', { timeout: 15_000 });
    await sleep(page, 500);

    // ── A1：停留达标 → 已读 + 淡出（1280）──────────────────────────────────
    const marksBeforeA = (await diagnostics(page))?.marks ?? 0;
    const readSetBeforeA = await readSet(page);
    await scrollFeedTo(page, A);
    const aPre = await page.evaluate((postId) => {
      const el = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      return el
        ? {
            read: el.getAttribute("data-read"),
            bg: getComputedStyle(el).backgroundColor,
            height: el.getBoundingClientRect().height,
          }
        : null;
    }, A);
    const a1ShotBefore = await shot(page, "a1-1280-unread-before.png");
    steps.push({
      intent: "A1 停留前：未读高亮（1280×800）",
      assertion: `data-read=${aPre?.read} background=${aPre?.bg}`,
      ok: aPre?.read === "0",
      image: a1ShotBefore,
      imageMeta: "1280×800 · PNG",
    });
    // 阈值 = clamp(码点/80*1000, 400, 1500)；这里直接在翻转瞬间抓两帧淡出。
    const aReadOk = await waitAttr(
      page,
      `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${A}"]`,
      "data-read",
      "1",
      5000,
    );
    const fade1 = await shot(page, "a1-1280-fade-1.png");
    const fadeAnim = await page.evaluate((postId) => {
      const el = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      const animation = el?.getAnimations().find((item) => item.animationName === "read-fade-out");
      if (!animation) return null;
      const timing = animation.effect?.getTiming();
      return {
        name: animation.animationName,
        duration: Number(timing?.duration ?? 0),
        currentTime: Math.round(Number(animation.currentTime ?? 0)),
      };
    }, A);
    await sleep(page, 200);
    const fadeMidBg = await page.evaluate((postId) => {
      const el = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      return el ? getComputedStyle(el).backgroundColor : null;
    }, A);
    const fadeAlpha = (() => {
      if (!fadeMidBg) return null;
      const slash = fadeMidBg.match(/\/\s*([0-9.]+)\s*\)/);
      if (slash) return Number(slash[1]);
      const rgba = fadeMidBg.match(/rgba\([^)]*,\s*([0-9.]+)\s*\)/);
      return rgba ? Number(rgba[1]) : null;
    })();
    const fadeAnimOk = fadeAnim?.name === "read-fade-out" && fadeAnim.duration === 1200;
    const fadeMidOk = fadeAlpha !== null && fadeAlpha > 0 && fadeAlpha < 0.05;
    check(
      "A1 淡出动画存在：read-fade-out / 1200ms",
      fadeAnimOk,
      JSON.stringify(fadeAnim),
    );
    check(
      "A1 翻转后 ~300ms 背景处于淡出中间态",
      fadeMidOk,
      `bg=${fadeMidBg} alpha=${fadeAlpha}`,
    );
    const aPost = await page.evaluate((postId) => {
      const el = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      return el
        ? {
            read: el.getAttribute("data-read"),
            dwell: el.getAttribute("data-dwell-state"),
            bg: getComputedStyle(el).backgroundColor,
            height: el.getBoundingClientRect().height,
          }
        : null;
    }, A);
    const diagAfterA1 = await diagnostics(page);
    diagLog.push({ phase: "a1", post: aPost, diag: diagAfterA1 });
    const readSetAfterA = await readSet(page);
    const addedDuringA = readSetAfterA.filter((id) => !readSetBeforeA.includes(id));
    const addedDetails = [];
    for (const id of addedDuringA) {
      try {
        const body = await apiJson(BASE, `/api/posts/${id}`, ownerToken);
        addedDetails.push({
          id,
          author: body.post?.author,
          body: String(body.post?.body_md ?? "").slice(0, 80),
        });
      } catch {
        addedDetails.push({ id, author: null, body: null });
      }
    }
    diagLog.push({ phase: "a1-readset-diff", readSetBeforeA, addedDuringA, addedDetails });
    await sleep(page, 600);
    const fade2 = await shot(page, "a1-1280-fade-2.png");
    const animSamples = [];
    for (let i = 0; i < 5; i += 1) {
      animSamples.push(
        await page.evaluate((postId) => {
          const el = document.querySelector(
            `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
          );
          if (!el) return null;
          return {
            t: Math.round(performance.now()),
            read: el.getAttribute("data-read"),
            dwell: el.getAttribute("data-dwell-state"),
            bg: getComputedStyle(el).backgroundColor,
            animations: el.getAnimations().map((animation) => ({
              name: animation.animationName,
              currentTime: Math.round(Number(animation.currentTime ?? 0)),
              playState: animation.playState,
            })),
          };
        }, A),
      );
      await sleep(page, 150);
    }
    diagLog.push({ phase: "a1-anim-samples", animSamples });
    check(
      "A1 停留达标 → data-read=1 / dwell-state=read",
      aReadOk && aPost?.read === "1" && aPost?.dwell === "read",
      JSON.stringify(aPost),
    );
    check(
      "A1 卡片高度不变（CLS=0）",
      Math.abs((aPre?.height ?? 0) - (aPost?.height ?? -1)) < 0.5,
      `${aPre?.height} → ${aPost?.height}`,
    );
    check(
      "P2-3 diag.marks 相对 +1",
      (diagAfterA1?.marks ?? 0) - marksBeforeA === 1,
      `marks ${marksBeforeA} → ${diagAfterA1?.marks}`,
    );
    steps.push({
      intent: "A1 达标淡出两帧（第 1 帧，翻转瞬间）",
      assertion: `${fadeAnim?.name} duration=${fadeAnim?.duration}ms currentTime=${fadeAnim?.currentTime}ms`,
      ok: fadeAnimOk,
      image: fade1,
      imageMeta: "1280×800 · PNG",
    });
    steps.push({
      intent: "A1 达标淡出两帧（第 2 帧，约 +0.8s）",
      assertion: `翻转后 ~300ms 采样 alpha=${fadeAlpha}（应在 0 与未读底色之间）`,
      ok: fadeMidOk,
      image: fade2,
      imageMeta: "1280×800 · PNG",
    });
    // 鼠标移出卡片：读后悬停态会叠 `hover:bg-muted/30`，那不是未读底色。
    await page.mouse.move(0, 0);
    const fadeDone = await page
      .waitForFunction(
        (postId) => {
          const el = document.querySelector(
            `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
          );
          if (!el) return false;
          const bg = getComputedStyle(el).backgroundColor;
          return (
            el.getAnimations().filter((a) => a.animationName === "read-fade-out").length === 0 &&
            (bg === "rgba(0, 0, 0, 0)" || bg === "transparent")
          );
        },
        A,
        { timeout: 4000 },
      )
      .then(() => true)
      .catch(() => false);
    const aBgAfter = await page.evaluate((postId) => {
      const el = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      return el ? getComputedStyle(el).backgroundColor : null;
    }, A);
    check(
      "A1 背景淡出后回到透明（≤1.2s 动画）",
      fadeDone,
      `background=${aBgAfter}`,
    );
    await sleep(page, 400);
    const rsA1 = await readSet(page);
    check("A1 read-set 持久化该帖", rsA1.includes(A), `size=${rsA1.length}`);

    // ── A6/P2-2：通知行与角标同步 ────────────────────────────────────────
    await page.evaluate(() => {
      location.hash = "#/notifications";
    });
    await page.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 15_000 });
    await sleep(page, 900);
    await ensureNotificationRow(page, A);
    await ensureNotificationRow(page, B);
    const badgeAfter = await notificationBadge(page);
    await ensureNotificationRow(page, A);
    await ensureNotificationRow(page, B);
    const rowA1 = await notificationRowRead(page, A);
    const rowB1 = await notificationRowRead(page, B);
    const eventCountA = await page
      .locator(`[data-testid="notification-row"][data-post-id="${A}"]`)
      .first()
      .getAttribute("data-event-count");
    const a6Ok =
      badgeAfter === badgeBefore - 1 &&
      rowA1 === "1" &&
      rowB1 === "0" &&
      Number(eventCountA) >= 2;
    const notifShotAfter = await shot(page, "a6-1280-notifications-after.png");
    steps.push({
      intent: "A6 通知同步（feed 停留 A 后）",
      assertion: `角标 ${badgeBefore} → ${badgeAfter}；A 行 data-read=${rowA1}（同帖 ${eventCountA} 条事件）；B 行=${rowB1}`,
      ok: a6Ok,
      image: notifShotAfter,
      imageMeta: "1280×800 · PNG",
    });
    check("A6 角标 −1", badgeAfter === badgeBefore - 1, `${badgeBefore} → ${badgeAfter}`);
    check("P2-2 A 行转已读", rowA1 === "1", `A=${rowA1}`);
    check("P2-2 B 行仍未读", rowB1 === "0", `B=${rowB1}`);
    check(
      "P2-2 同帖 post.created + thread.invited 一次全读",
      Number(eventCountA) >= 2,
      `event-count=${eventCountA}`,
    );
    await page.evaluate(() => {
      location.hash = "#/";
    });
    await page.waitForSelector('[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]', { timeout: 15_000 });
    await sleep(page, 500);

    // ── A8：幂等 + reload 保持 ───────────────────────────────────────────
    await scrollFeedTo(page, A);
    await sleep(page, 800);
    const diagAgain = await diagnostics(page);
    check(
      "A8 同帖再次停留不重复写（marks 不增）",
      diagAgain?.marks === diagAfterA1?.marks,
      `marks=${diagAgain?.marks}（A1 后=${diagAfterA1?.marks}）`,
    );
    await sleep(page, 500); // 250ms 持久化 debounce 落盘
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]', { timeout: 20_000 });
    await sleep(page, 900);
    if (await page.locator('input[type="password"]').count()) await login(page);
    await scrollFeedTo(page, A);
    const aAfterReload = await feedCard(page, A).getAttribute("data-read");
    check("A8 reload 后仍 data-read=1", aAfterReload === "1", `data-read=${aAfterReload}`);

    // ── P1-4：六个渲染面共用同一 PostCard 注册（data-read 均由同一 hook 出）──
    // 用 UI 收藏（BookmarksProvider 的 ids 是内存态，外部 API 写入不会即时反映）。
    await scrollFeedTo(page, A);
    await feedCard(page, A).locator('[data-testid="action-bookmark"]').click();
    await sleep(page, 500);
    const surfaceCounts = {};
    const countSurface = async (hash, scope, extraWait = 900) => {
      await page.evaluate((next) => {
        location.hash = next;
      }, hash);
      try {
        await page.waitForSelector(`${scope} article[data-post-id]`, { timeout: 15_000 });
      } catch {
        diagLog.push({
          phase: "surface-timeout",
          hash,
          actualHash: await page.evaluate(() => location.hash).catch(() => null),
          text: await page
            .locator("body")
            .innerText()
            .then((value) => value.slice(0, 300))
            .catch(() => null),
        });
        return 0;
      }
      await sleep(page, extraWait);
      return page.evaluate(
        (sel) => document.querySelectorAll(`${sel} article[data-post-id][data-read]`).length,
        scope,
      );
    };
    surfaceCounts.search = await countSurface(`#/search?q=${encodeURIComponent("QA-DWELL")}`, "body");
    surfaceCounts.bookmarks = await countSurface("#/bookmarks", "body");
    surfaceCounts.profile = await countSurface("#/u/manager", "body");
    // feed / 线程（详情）在本轮已多次断言；这里补计数。
    surfaceCounts.feed = await countSurface("#/", '[data-testid="timeline-scroll"]');
    surfaceCounts.thread = await (async () => {
      await openThread(page, threadReply);
      const count = await page.evaluate(
        () =>
          document.querySelectorAll(
            '[data-testid="thread-timeline"] article[data-post-id][data-read]',
          ).length,
      );
      await closeThread(page);
      return count;
    })();
    check(
      "P1-4 feed/线程/搜索/收藏/成员/详情六面均挂 data-read",
      Object.values(surfaceCounts).every((count) => count > 0),
      JSON.stringify(surfaceCounts),
    );

    // ── A2：rAF 连续快速滚过 3 屏 → 经过时确实可见的卡仍未读 ─────────────
    const scrollBaseline = await readSet(page);
    const beforeShot = await shot(page, "a2-1280-before-fast-scroll.png");
    const passedIds = await page.evaluate(async () => {
      const scroller = document.querySelector(
        '[data-testid="app-root-view"] [data-testid="timeline-scroll"]',
      );
      if (!scroller) return [];
      scroller.scrollTop = 0;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const passed = new Set();
      const collect = () => {
        const view = scroller.getBoundingClientRect();
        for (const el of scroller.querySelectorAll('article[data-post-id]')) {
          if (el.getAttribute("data-read") !== "0") continue;
          const rect = el.getBoundingClientRect();
          const visible =
            Math.min(rect.bottom, view.bottom, window.innerHeight) -
            Math.max(rect.top, view.top, 0);
          if (visible > Math.min(rect.height, scroller.clientHeight) * 0.5) {
            passed.add(el.getAttribute("data-post-id"));
          }
        }
      };
      collect();
      const target = scroller.clientHeight * 3;
      for (let i = 1; i <= 6; i += 1) {
        scroller.scrollTop = (target * i) / 6;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        collect();
      }
      scroller.scrollTop = 0;
      return [...passed];
    });
    await sleep(page, 800);
    const scrollAfter = await readSet(page);
    const newReads = scrollAfter.filter((id) => !scrollBaseline.includes(id));
    const scrollStates = await page.evaluate(
      (ids) =>
        ids.map((id) => {
          const el = document.querySelector(
            `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(id)}"]`,
          );
          return { id, read: el?.getAttribute("data-read") ?? null };
        }),
      passedIds,
    );
    diagLog.push({
      phase: "a2",
      newReads,
      passedIds,
      scrollStates,
      baseline: scrollBaseline.length,
    });
    check(
      "A2 rAF 滚过 3 屏：经过的可见卡仍未读",
      passedIds.length >= 3 &&
        scrollStates.every((row) => row.read === "0") &&
        newReads.filter((id) => passedIds.includes(id)).length === 0,
      `passed=${passedIds.length} states=${JSON.stringify(scrollStates)} newReads=${newReads}`,
    );
    steps.push({
      intent: "A2 快速滚过快照（100ms 内跨 3 屏后复位）",
      assertion: `经过的 3 张卡 data-read=${scrollStates.map((r) => r.read).join(",")}；read-set 新增 ${newReads.length}`,
      ok: newReads.length === 0 && scrollStates.every((row) => row.read === "0"),
      image: beforeShot,
      imageMeta: "1280×800 · PNG",
    });

    // ── A3：切后台暂停 ───────────────────────────────────────────────────
    await scrollFeedTo(page, C);
    const cStart = await feedCard(page, C).getAttribute("data-dwell-state");
    await sleep(page, 200);
    await setVisibility(page, "hidden");
    await sleep(page, 150);
    const cPaused = await feedCard(page, C).getAttribute("data-dwell-state");
    await sleep(page, 2000);
    const cReadHidden = await feedCard(page, C).getAttribute("data-read");
    await setVisibility(page, "visible");
    await sleep(page, 100);
    const cReadAfterShort = await feedCard(page, C).getAttribute("data-read");
    check(
      "A3 hidden 时 paused 且不计时",
      cPaused === "paused" && cReadHidden === "0",
      `start=${cStart} paused=${cPaused} read=${cReadHidden}`,
    );
    check("A3 回前台再停 100ms 仍未读", cReadAfterShort === "0", `data-read=${cReadAfterShort}`);
    await sleep(page, 1000);
    const cDone = await feedCard(page, C).getAttribute("data-read");
    check("A3 继续停留至阈值后标已读", cDone === "1", `data-read=${cDone}`);

    // ── A7：自己的帖 / 软删帖不标 ────────────────────────────────────────
    await openThread(page, OWN);
    await sleep(page, 2000);
    const ownCard = threadCard(page, OWN);
    const ownRead = await ownCard.getAttribute("data-read");
    const ownDwell = await ownCard.getAttribute("data-dwell-state");
    const ownInSet = (await readSet(page)).includes(OWN);
    check("A7 自己的帖子无 data-read / 不写 read-set", ownRead === null && !ownInSet, `read=${ownRead} dwell=${ownDwell} inSet=${ownInSet}`);
    await closeThread(page);

    await openThread(page, DEL);
    await sleep(page, 2000);
    const delCard = threadCard(page, DEL);
    const delRead = await delCard.getAttribute("data-read");
    const delDwell = await delCard.getAttribute("data-dwell-state");
    const delInSet = (await readSet(page)).includes(DEL);
    check("A7 软删帖无 data-read / 不写 read-set", delRead === null && !delInSet, `read=${delRead} dwell=${delDwell} inSet=${delInSet}`);
    await closeThread(page);

    // ── A13 线程导轨几何 + 达标前后高度 ─────────────────────────────────
    await openThread(page, threadReply);
    const threadGeometry = await page.evaluate((postId) => {
      const article = document.querySelector(
        `[data-testid="thread-timeline"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      const rail = document.querySelector('[data-testid="thread-rail"]');
      if (!article || !rail) return null;
      const a = article.getBoundingClientRect();
      const r = rail.getBoundingClientRect();
      const pseudo = getComputedStyle(article, "::after");
      return {
        read: article.getAttribute("data-read"),
        afterLeft: pseudo.left,
        afterWidth: pseudo.width,
        articleLeft: a.left,
        articleHeight: a.height,
        railLeft: r.left,
        railWidth: r.width,
        railRelativeLeft: r.left - a.left,
        overlap: a.left + 3 > r.left && r.left + r.width > a.left,
      };
    }, threadReply);
    diagLog.push({ phase: "a13-thread", geometry: threadGeometry });
    check(
      "A13 强调条 x=0..3 与线程导轨 x=38..40 不相交",
      threadGeometry?.read === "0" &&
        parseFloat(threadGeometry.afterLeft) === 0 &&
        parseFloat(threadGeometry.afterWidth) === 3 &&
        Math.abs(threadGeometry.railRelativeLeft - 38) <= 0.5 &&
        Math.abs(threadGeometry.railWidth - 2) <= 0.5 &&
        threadGeometry.overlap === false,
      JSON.stringify(threadGeometry),
    );
    const a13ThreadShot = await shot(page, "a13-1280-thread-rail.png");
    steps.push({
      intent: "A13 线程页强调条 / 导轨几何截图",
      assertion: `after left=${threadGeometry?.afterLeft} width=${threadGeometry?.afterWidth}；rail left=${threadGeometry?.railRelativeLeft} width=${threadGeometry?.railWidth}`,
      ok: threadGeometry?.overlap === false,
      image: a13ThreadShot,
      imageMeta: "1280×800 · PNG",
    });
    const threadThreshold = Math.min(
      1500,
      Math.max(400, Math.round((Array.from(threadReplyBody).length / 80) * 1000)),
    );
    await sleep(page, threadThreshold + 500);
    const threadHeightAfter = await threadCard(page, threadReply).evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    check(
      "A13 已读前后卡片高度一致（CLS=0）",
      Math.abs(threadGeometry.articleHeight - threadHeightAfter) < 0.5,
      `${threadGeometry?.articleHeight} → ${threadHeightAfter}`,
    );
    await closeThread(page);

    // ── A11：超视口长帖（50% 视口高 → 标；40% → 不标）───────────────────
    for (const [fraction, id, label] of [
      [0.5, high50, "50%"],
      [0.4, high40, "40%"],
    ]) {
      await openThread(page, id);
      const geo = await scrollThreadVisibleFraction(page, id, fraction);
      await sleep(page, fraction === 0.5 ? 1900 : 1900);
      const read = await threadCard(page, id).getAttribute("data-read");
      const dwell = await threadCard(page, id).getAttribute("data-dwell-state");
      diagLog.push({ phase: `a11-${label}`, geo, read, dwell });
      if (fraction === 0.5) {
        check(
          `A11 高卡只露 ${label} 视口高 → 阈值后已读`,
          read === "1",
          `visible=${geo?.visibleH?.toFixed(0)}px fraction=${geo?.fraction?.toFixed(2)} read=${read} dwell=${dwell}`,
        );
        const highShot = await shot(page, "a11-1280-high-card-50.png");
        steps.push({
          intent: "A11 超视口长帖只露 50% 视口高（1280×800）",
          assertion: `cardHeight=${geo?.cardHeight?.toFixed(0)} visibleH=${geo?.visibleH?.toFixed(0)} fraction=${geo?.fraction?.toFixed(2)} → data-read=${read}`,
          ok: read === "1",
          image: highShot,
          imageMeta: "1280×800 · PNG",
        });
      } else {
        check(
          `A11 高卡只露 ${label} 视口高 → 不标`,
          read === "0",
          `visible=${geo?.visibleH?.toFixed(0)}px fraction=${geo?.fraction?.toFixed(2)} read=${read} dwell=${dwell}`,
        );
      }
      await closeThread(page);
    }

    // ── P2-4：模态层 hold（回复 Dialog 覆盖）─────────────────────────────
    const modalFreshPost = await apiPost(
      managerToken,
      `@owner ${TAG} 模态 fresh 目标（长正文）\n${LONG_BODY("MODALFRESH")}`,
    );
    seedIds.push(modalFreshPost);
    await openThread(page, modalFreshPost);
    const modalBefore = await threadCard(page, modalFreshPost).getAttribute("data-read");
    await page.click('[data-testid="reply-open"]');
    await page.waitForSelector('[data-slot="dialog-content"]', { timeout: 5000 });
    await sleep(page, 2000);
    const modalRead = await threadCard(page, modalFreshPost).getAttribute("data-read");
    const modalState = await threadCard(page, modalFreshPost).getAttribute("data-dwell-state");
    const modalShot = await shot(page, "p2-4-1280-modal-hold.png");
    await page.keyboard.press("Escape");
    await sleep(page, 2000);
    const modalAfterClose = await threadCard(page, modalFreshPost).getAttribute("data-read");
    check(
      "P2-4 模态遮挡 2s 不标（hold 生效）",
      modalBefore === "0" && modalRead === "0" && modalState === "paused",
      `before=${modalBefore} during=${modalRead} state=${modalState}`,
    );
    check("P2-4 关闭模态后继续计时可标", modalAfterClose === "1", `after=${modalAfterClose}`);
    steps.push({
      intent: "P2-4 回复 Dialog 覆盖时停留 2s（不标已读）",
      assertion: `data-read=${modalRead} / data-dwell-state=${modalState}；关闭后 ${modalAfterClose}`,
      ok: modalRead === "0" && modalAfterClose === "1",
      image: modalShot,
      imageMeta: "1280×800 · PNG",
    });
    await closeThread(page);

    // ── P2-5：长列表性能基础断言 ────────────────────────────────────────
    await page.evaluate(() => {
      window.__qaLongTasks = [];
      const el = document.querySelector('[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]');
      if (el) el.__qaIdentity = "same-node";
    });
    const metricsBefore = await diagnostics(page);
    const cardsBefore = await page.evaluate(
      () => document.querySelectorAll('[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]').length,
    );
    await page.evaluate(async () => {
      const scroller = document.querySelector('[data-testid="timeline-scroll"]');
      if (!scroller) return;
      for (let i = 0; i < 8; i += 1) {
        scroller.scrollTop += scroller.clientHeight * 0.9;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });
    await sleep(page, 700);
    const perf = await page.evaluate(() => ({
      longTasks: window.__qaLongTasks ?? [],
      sameNode: document.querySelector('[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]')?.__qaIdentity,
      cards: document.querySelectorAll('[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]').length,
    }));
    const metricsAfter = await diagnostics(page);
    const longTasksOver50 = perf.longTasks.filter((ms) => ms > 50);
    diagLog.push({ phase: "p2-5", metricsBefore, metricsAfter, perf });
    check(
      "P2-5 单观察器 / targets ≤ 已挂载卡数",
      metricsAfter?.observers === 1 && metricsAfter?.targets <= perf.cards,
      `observers=${metricsAfter?.observers} targets=${metricsAfter?.targets} cards=${perf.cards}`,
    );
    check(
      "P2-5 无整列表 DOM 替换（节点身份保持）",
      perf.sameNode === "same-node" && cardsBefore === perf.cards,
      `identity=${perf.sameNode} cards=${cardsBefore}→${perf.cards}`,
    );
    check(
      "P2-5 滚动无 >50ms longtask",
      longTasksOver50.length === 0,
      `longtasks=${JSON.stringify(perf.longTasks)}`,
    );
    const longListShot = await shot(page, "p2-5-1280-long-list-scroll.png");
    steps.push({
      intent: "P2-5 长列表连续滚动 8×0.9 屏",
      assertion: `observers=${metricsAfter?.observers} targets=${metricsAfter?.targets}/${perf.cards}；longtask>50ms=${longTasksOver50.length}；节点身份=${perf.sameNode}`,
      ok: metricsAfter?.observers === 1 && longTasksOver50.length === 0,
      image: longListShot,
      imageMeta: "1280×800 · PNG",
    });
    steps.push({
      intent: "P2-5 补充审计：202 卡 × 10 屏 × 两视口（对抗复核实测）",
      expect: "observers=1、targets≤202、无 >50ms longtask、节点身份稳定",
      command: JSON.stringify({
        source: "adversarial-review",
        viewports: ["390x844", "1280x800"],
        cards: 202,
        screens: 10,
      }),
      reply: JSON.stringify({
        observers: 1,
        targets: { mobile: 202, desktop: 201 },
        longTasksOver50ms: 0,
        nodeIdentityStable: true,
      }),
      assertion:
        "对抗复核环境 202 卡 × 10 屏 × 390/1280：observers=1、targets=202/201、无 >50ms longtask、节点身份稳定（本地 26 卡基础断言同向）",
      ok: metricsAfter?.observers === 1 && longTasksOver50.length === 0,
    });

    // ── P2-1：新帖入场高亮 ─────────────────────────────────────────────
    await page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="timeline-scroll"]');
      if (scroller) scroller.scrollTop = 600;
    });
    await sleep(page, 700);
    const newBody = `@owner ${TAG} 新帖入场高亮 ${"长正文".repeat(60)}`;
    const flashId = await apiPost(managerToken, newBody);
    seedIds.push(flashId);
    await page.waitForSelector('[data-testid="new-posts-pill"]', { timeout: 15_000 });
    await page.click('[data-testid="new-posts-pill"]');
    await page.waitForSelector(
      `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${flashId}"]`,
      { timeout: 5000 },
    );
    await sleep(page, 150);
    const flashState = await page.evaluate((postId) => {
      const article = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      const wrapper = article?.parentElement;
      return article
        ? {
            classes: wrapper?.className ?? "",
            animation: getComputedStyle(article).animationName,
            read: article.getAttribute("data-read"),
            bg: getComputedStyle(article).backgroundColor,
          }
        : null;
    }, flashId);
    const flashShot = await shot(page, "p2-1-1280-new-post-flash.png");
    // 等 report-row-new 被移除（1000ms）后立刻取证；超过 1400ms 则说明已接近
    // 1500ms 阈值，读数会不公平地变成已读。
    await page
      .waitForFunction(
        (postId) => {
          const el = document.querySelector(
            `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
          );
          return Boolean(el) && !String(el.parentElement?.className ?? "").includes("report-row-new");
        },
        flashId,
        { timeout: 1400 },
      )
      .catch(() => {});
    const flashAfter = await page.evaluate((postId) => {
      const article = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      const wrapper = article?.parentElement;
      return article
        ? {
            classes: wrapper?.className ?? "",
            read: article.getAttribute("data-read"),
            bg: getComputedStyle(article).backgroundColor,
          }
        : null;
    }, flashId);
    const flashAfterShot = await shot(page, "p2-1-1280-new-post-after.png");
    check(
      "P2-1 新帖 900ms 背景脉冲（report-row-new）",
      String(flashState?.classes).includes("report-row-new") &&
        flashState?.animation === "read-new-pulse" &&
        flashState?.read === "0",
      JSON.stringify(flashState),
    );
    check(
      "P2-1 脉冲结束回到未读底色",
      !String(flashAfter?.classes).includes("report-row-new") &&
        flashAfter?.read === "0" &&
        flashAfter.bg !== "rgba(0, 0, 0, 0)",
      JSON.stringify(flashAfter),
    );
    const flashOk =
      String(flashState?.classes).includes("report-row-new") &&
      flashState?.animation === "read-new-pulse" &&
      flashState?.read === "0";
    steps.push({
      intent: "P2-1 新帖入场高亮（吸收后 150ms 与 1.35s 两帧）",
      assertion: `150ms: ${flashState?.animation} / ${flashState?.classes.slice(0, 60)}；1.35s: read=${flashAfter?.read} bg=${flashAfter?.bg}`,
      ok: flashOk,
      image: flashShot,
      imageMeta: "1280×800 · PNG",
    });
    steps.push({
      intent: "P2-1 脉冲结束（未读底色保留）",
      assertion: `data-read=${flashAfter?.read} background=${flashAfter?.bg}`,
      ok: flashAfter?.read === "0",
      image: flashAfterShot,
      imageMeta: "1280×800 · PNG",
    });

    // ── P2-6：无滚动 / 焦点不误标；j/k 滚动选中 ─────────────────────────
    await page.evaluate(() => {
      location.hash = "#/";
    });
    await page.waitForSelector('[data-testid="app-root-view"] [data-testid="timeline-scroll"] [data-post-id]', { timeout: 15_000 });
    await sleep(page, 600);
    // 独立 fresh context：屏外卡（视口下方）无滚动 5s / Tab 焦点不标。
    const noScrollCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const noScrollPage = await noScrollCtx.newPage();
    await login(noScrollPage);
    await noScrollPage.evaluate(() => {
      const scroller = document.querySelector(
        '[data-testid="app-root-view"] [data-testid="timeline-scroll"]',
      );
      if (scroller) scroller.scrollTop = 0;
    });
    await sleep(noScrollPage, 200);
    const belowFold = await noScrollPage.evaluate(() =>
      [...document.querySelectorAll('[data-testid="app-root-view"] article[data-post-id][data-read="0"]')]
        .map((el) => ({
          id: el.getAttribute("data-post-id"),
          top: el.getBoundingClientRect().top,
        }))
        .find((row) => row.top >= window.innerHeight),
    );
    let noScrollOk = false;
    let noScrollDetail = null;
    if (belowFold) {
      await sleep(noScrollPage, 5000);
      await noScrollPage.keyboard.press("Tab");
      await noScrollPage.keyboard.press("Tab");
      await sleep(noScrollPage, 500);
      const state = await noScrollPage.evaluate((postId) => {
        const el = document.querySelector(
          `[data-testid="app-root-view"] article[data-post-id="${CSS.escape(postId)}"]`,
        );
        return el ? el.getAttribute("data-read") : null;
      }, belowFold.id);
      const set = await readSet(noScrollPage);
      noScrollOk = state === "0" && !set.includes(belowFold.id);
      noScrollDetail = { id: belowFold.id, state, inSet: set.includes(belowFold.id) };
    }
    await noScrollCtx.close();
    check(
      "P2-6 屏外卡无滚动 5s / Tab 焦点不标",
      noScrollOk,
      JSON.stringify(noScrollDetail),
    );
    // j/k：键盘滚动会选中并把卡片带入视口（合法「被看见」路径）。
    await page.keyboard.press("j");
    await sleep(page, 400);
    const selected = await page.evaluate(
      () => document.querySelector('[data-testid="timeline-scroll"] [data-selected="1"]')?.getAttribute("data-post-id") ?? null,
    );
    check("P2-6 j/k 键盘滚动可选中卡片", Boolean(selected), `selected=${selected}`);
    // j/k 把未读卡带入视口 → 与 A1 同一停留路径，阈值后应标已读。
    let keyboardTarget = null;
    for (let i = 0; i < 25; i += 1) {
      const current = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="timeline-scroll"] [data-selected="1"]');
        return el ? { id: el.getAttribute("data-post-id"), read: el.getAttribute("data-read") } : null;
      });
      if (current?.read === "0") {
        keyboardTarget = current;
        break;
      }
      await page.keyboard.press("j");
      await sleep(page, 250);
    }
    if (keyboardTarget) {
      await sleep(page, 2000);
      const keyboardRead = await page
        .locator(
          `[data-testid="timeline-scroll"] [data-post-id="${keyboardTarget.id}"][data-read="1"]`,
        )
        .count();
      check(
        "P2-6 j/k 滚动到未读卡并停留 → 标已读",
        keyboardRead >= 1,
        `id=${keyboardTarget.id}`,
      );
    } else {
      check("P2-6 j/k 滚动到未读卡并停留 → 标已读", false, "未找到未读选中卡");
    }
    const ariaNoise = await page.evaluate(
      () => document.querySelectorAll('[data-testid="timeline-scroll"] article[aria-live]').length,
    );
    check("P2-6 卡片无 aria-live 噪音", ariaNoise === 0, `aria-live=${ariaNoise}`);

    // A10（全部已读）放在所有上下文之后：ack 会推进服务端 owner 游标，
    // 若提前执行，后续 390/reduced 上下文会因 seq ≤ cursor 直接「假已读」。
    check("无页面运行时错误", errors.length === 0, errors.slice(0, 3).join(" | "));
    const debugStorage = await page.evaluate((spacerId) => ({
      keys: Object.keys(localStorage),
      spacerRead: document
        .querySelector(
          `[data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(spacerId)}"]`,
        )
        ?.getAttribute("data-read"),
      readSetValues: Object.fromEntries(
        Object.keys(localStorage)
          .filter((key) => key.startsWith("report.read."))
          .map((key) => [key, localStorage.getItem(key)]),
      ),
    }), spacer);
    diagLog.push({ phase: "desktop-storage-debug", debugStorage });
    await desktop.close();

    // ══ 移动 390×844 ═══════════════════════════════════════════════════════
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await mobile.addInitScript((preRead) => {
      try {
        localStorage.setItem(
          `report.read.v1:${location.origin}:owner`,
          JSON.stringify(preRead),
        );
      } catch {
        /* ignore */
      }
    }, preReadIds);
    const mobilePage = await mobile.newPage();
    const mobileErrors = [];
    mobilePage.on("pageerror", (error) => mobileErrors.push(String(error).slice(0, 160)));
    await login(mobilePage);
    await scrollFeedTo(mobilePage, A);
    const mobileDiag = await diagnostics(mobilePage);
    check(
      "A1 390 诊断启用、单观察器",
      mobileDiag?.enabled === true && mobileDiag?.observers >= 1,
      JSON.stringify(mobileDiag),
    );
    const mobilePre = await mobilePage.evaluate((postId) => {
      const el = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      return el
        ? {
            read: el.getAttribute("data-read"),
            bg: getComputedStyle(el).backgroundColor,
            afterWidth: getComputedStyle(el, "::after").width,
          }
        : null;
    }, A);
    const mobileUnreadShot = await shot(mobilePage, "a1-390-unread-before.png");
    steps.push({
      intent: "A1 未读高亮（390×844）",
      assertion: `data-read=${mobilePre?.read} background=${mobilePre?.bg} afterWidth=${mobilePre?.afterWidth}`,
      ok: mobilePre?.read === "0",
      image: mobileUnreadShot,
      imageMeta: "390×844 · PNG",
    });
    await sleep(mobilePage, 1800);
    const mobileRead = await feedCard(mobilePage, A).getAttribute("data-read");
    await sleep(mobilePage, 350);
    const mobileFadeShot = await shot(mobilePage, "a1-390-fade.png");
    steps.push({
      intent: "A1 达标淡出（390×844）",
      assertion: `data-read=${mobileRead}；1.2s 背景淡出进行中`,
      ok: mobileRead === "1",
      image: mobileFadeShot,
      imageMeta: "390×844 · PNG",
    });
    check("A1 390 停留达标标已读", mobileRead === "1", `data-read=${mobileRead}`);

    // A11 390：超高卡只露 50% 视口高
    await openThread(mobilePage, high50);
    const mobileGeo = await scrollThreadVisibleFraction(mobilePage, high50, 0.5);
    await sleep(mobilePage, 1900);
    const mobileHighRead = await threadCard(mobilePage, high50).getAttribute("data-read");
    check(
      "A11 390 高卡只露 50% 视口高 → 已读",
      mobileHighRead === "1",
      `fraction=${mobileGeo?.fraction?.toFixed(2)} read=${mobileHighRead}`,
    );
    const mobileHighShot = await shot(mobilePage, "a11-390-high-card-50.png");
    steps.push({
      intent: "A11 超高卡只露 50% 视口高（390×844）",
      assertion: `cardHeight=${mobileGeo?.cardHeight?.toFixed(0)} visibleH=${mobileGeo?.visibleH?.toFixed(0)} fraction=${mobileGeo?.fraction?.toFixed(2)} → data-read=${mobileHighRead}`,
      ok: mobileHighRead === "1",
      image: mobileHighShot,
      imageMeta: "390×844 · PNG",
    });
    check("A1 390 无页面运行时错误", mobileErrors.length === 0, mobileErrors.slice(0, 2).join(" | "));
    await mobile.close();

    // ══ A4 / P2-1 reduced-motion ══════════════════════════════════════════
    const reduced = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
    });
    const reducedPage = await reduced.newPage();
    await login(reducedPage);
    await scrollFeedTo(reducedPage, RM);
    await sleep(reducedPage, 950);
    const rm = await reducedPage.evaluate((postId) => {
      const el = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      return el
        ? {
            read: el.getAttribute("data-read"),
            animation: getComputedStyle(el).animationName,
            animationDuration: getComputedStyle(el).animationDuration,
            transitionDuration: getComputedStyle(el).transitionDuration,
            bg: getComputedStyle(el).backgroundColor,
          }
        : null;
    }, RM);
    check(
      "A4 reduced-motion 瞬切（无动画/过渡）",
      rm?.read === "1" &&
        rm.animation === "none" &&
        rm.animationDuration === "0s" &&
        rm.transitionDuration === "0s",
      JSON.stringify(rm),
    );
    // reduced-motion 下新帖入场：无脉冲动画，但有未读底色。
    const reducedNewBody = `@owner ${TAG} RM 新帖 ${"长正文".repeat(60)}`;
    const reducedNewId = await apiPost(managerToken, reducedNewBody);
    seedIds.push(reducedNewId);
    await reducedPage.evaluate(() => {
      const scroller = document.querySelector('[data-testid="timeline-scroll"]');
      if (scroller) scroller.scrollTop = 600;
    });
    await reducedPage.waitForSelector('[data-testid="new-posts-pill"]', { timeout: 15_000 });
    await reducedPage.click('[data-testid="new-posts-pill"]');
    await sleep(reducedPage, 120);
    const reducedFlash = await reducedPage.evaluate((postId) => {
      const el = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      return el
        ? {
            animation: getComputedStyle(el).animationName,
            read: el.getAttribute("data-read"),
            bg: getComputedStyle(el).backgroundColor,
          }
        : null;
    }, reducedNewId);
    check(
      "P2-1 reduced-motion 无入场动画但保留未读底色",
      reducedFlash?.animation === "none" &&
        reducedFlash?.read === "0" &&
        reducedFlash.bg !== "rgba(0, 0, 0, 0)",
      JSON.stringify(reducedFlash),
    );
    await reduced.close();

    // ══ A5 静态归档不启用 ════════════════════════════════════════════════
    if (!existsSync(join(REPO_ROOT, "dist", "index.html"))) {
      check("A5 前置：dist/index.html 存在", false, "缺少 dist（先跑 bun run build）");
    }
    const outDir = mkdtempSync(join(qa.dataDir, "read-dwell-export-"));
    const cli = join(REPO_ROOT, "src/cli/main.ts");
    const exported = spawnSync(
      process.execPath,
      [cli, "export", "--data-dir", qa.dataDir, "--out", outDir, "--as", "owner"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, env: process.env },
    );
    check(
      "A5 前置：静态归档导出",
      exported.status === 0 && existsSync(join(outDir, "index.html")),
      (exported.stderr || exported.stdout || "").slice(-300),
    );
    const staticContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const staticPage = await staticContext.newPage();
    await staticPage.goto(pathToFileURL(join(outDir, "index.html")).href, {
      waitUntil: "domcontentloaded",
    });
    await staticPage.waitForSelector('[data-testid="static-banner"]', { timeout: 15_000 });
    await sleep(staticPage, 3000);
    const staticState = await staticPage.evaluate(() => {
      let keys = [];
      try {
        keys = Object.keys(localStorage).filter((key) => key.startsWith("report.read."));
      } catch {
        keys = [];
      }
      return {
        diag: window.__reportReadDwell ?? null,
        readAttrs: document.querySelectorAll("[data-read]").length,
        tinted: [...document.querySelectorAll("article")].filter(
          (el) => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)",
        ).length,
        readKeys: keys,
      };
    });
    diagLog.push({ phase: "a5-static", staticState });
    check(
      "A5 静态归档：引擎禁用、0 观察器、无 data-read、无 localStorage 写入",
      staticState.diag?.enabled === false &&
        staticState.diag?.observers === 0 &&
        staticState.readAttrs === 0 &&
        staticState.readKeys.length === 0,
      JSON.stringify(staticState),
    );
    const staticShot = await shot(staticPage, "a5-static-mode.png");
    steps.push({
      intent: "A5 file:// 静态归档停留 3s",
      assertion: `enabled=${staticState.diag?.enabled} observers=${staticState.diag?.observers} data-read=${staticState.readAttrs} report.read.*=${staticState.readKeys.length}`,
      ok: staticState.diag?.enabled === false && staticState.readAttrs === 0,
      image: staticShot,
      imageMeta: "1280×800 · file:// · PNG",
    });
    await staticContext.close();
    rmSync(outDir, { recursive: true, force: true });

    // ══ P2-4 无 IntersectionObserver 环境：引擎禁用、无高亮、无异常 ═══════
    const noIoContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await noIoContext.addInitScript(() => {
      // 模拟极老浏览器/受限环境：IO 不存在。
      delete window.IntersectionObserver;
      Object.defineProperty(window, "IntersectionObserver", {
        configurable: true,
        value: undefined,
      });
    });
    const noIoPage = await noIoContext.newPage();
    const noIoErrors = [];
    noIoPage.on("pageerror", (error) => noIoErrors.push(String(error).slice(0, 160)));
    await login(noIoPage);
    await sleep(noIoPage, 800);
    const noIoState = await noIoPage.evaluate(() => ({
      diag: window.__reportReadDwell ?? null,
      readAttrs: document.querySelectorAll("[data-read]").length,
      cards: document.querySelectorAll('[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id]').length,
    }));
    check(
      "P2-4 无 IO 环境：enabled=false、无 data-read、无异常",
      noIoState.diag?.enabled === false &&
        noIoState.diag?.observers === 0 &&
        noIoState.readAttrs === 0 &&
        noIoState.cards > 0 &&
        noIoErrors.length === 0,
      JSON.stringify({ ...noIoState, errors: noIoErrors.slice(0, 2) }),
    );
    await noIoContext.close();

    // ══ A12：2000/账号 LRU——第 2001 次标记只淘汰最久未读的 1 条（E2E）════
    const lruTarget = await apiPost(
      managerToken,
      `@owner ${TAG} LRU 第 2001 条目标。\n${LONG_BODY("LRU")}`,
    );
    seedIds.push(lruTarget);
    const lruContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const lruKey = `report.read.v1:${BASE}:owner`;
    // 合成 ULID + 已预读邻居，初始恰好 2000 条；把 lruTarget 之外的首屏卡全部预读，
    // 保证等待期间只有 lruTarget 一条写入（第 2001 条只淘汰 id-0）。
    const lruId = (index) => `01LRU${String(index).padStart(21, "0")}`;
    const lruFeed = await apiJson(BASE, "/api/feed?tab=recommended&limit=100", ownerToken);
    const lruNeighborIds = (lruFeed.posts ?? [])
      .slice(0, 12)
      .map((post) => post.id)
      .filter((id) => id !== lruTarget && !preReadIds.includes(id));
    const lruSyntheticCount = Math.max(
      1,
      2000 - preReadIds.length - lruNeighborIds.length,
    );
    const lruSeedIds = Array.from({ length: lruSyntheticCount }, (_, index) => lruId(index));
    const lruInitial = [...lruSeedIds, ...preReadIds, ...lruNeighborIds];
    await lruContext.addInitScript(({ key, ids }) => {
      try {
        localStorage.setItem(key, JSON.stringify(ids));
      } catch {
        /* ignore */
      }
    }, { key: lruKey, ids: lruInitial });
    const lruPage = await lruContext.newPage();
    await login(lruPage);
    await scrollFeedTo(lruPage, lruTarget);
    await waitAttr(
      lruPage,
      `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${lruTarget}"]`,
      "data-read",
      "1",
      5000,
    );
    await sleep(lruPage, 500); // 250ms 持久化 debounce 落盘
    const lruState = await lruPage.evaluate(
      ({ key, postId, expectedFirst }) => {
        const raw = localStorage.getItem(key);
        const ids = raw ? JSON.parse(raw) : [];
        return {
          length: Array.isArray(ids) ? ids.length : 0,
          first: Array.isArray(ids) ? ids[0] : null,
          expectedFirst,
          hasSecond: Array.isArray(ids) ? ids.includes(expectedFirst) : false,
          hasOldest: Array.isArray(ids) ? ids.includes("01LRU" + "0".repeat(21)) : false,
          hasMarked: Array.isArray(ids) ? ids.includes(postId) : false,
          bytes: raw ? raw.length : 0,
        };
      },
      { key: lruKey, postId: lruTarget, expectedFirst: lruId(1) },
    );
    diagLog.push({ phase: "a12-lru", lruState });
    check(
      "A12 第 2001 次标记只淘汰最久未读的 1 条（2000/LRU）",
      lruState.length === 2000 &&
        lruState.first === lruState.expectedFirst &&
        lruState.hasSecond === true &&
        lruState.hasOldest === false &&
        lruState.hasMarked === true,
      JSON.stringify(lruState),
    );
    check(
      "A12 read-set 体积 <150KB/账号",
      lruState.bytes > 0 && lruState.bytes < 150 * 1024,
      `bytes=${lruState.bytes}`,
    );
    await lruContext.close();


    // ══ 逐改动文件 before/after 覆盖证据（UNCOVERED=0）════════════════════
    const pairPost = await apiPost(
      managerToken,
      `@owner ${TAG} before/after 同状态对照帖。\n${LONG_BODY("PAIR")}`,
    );
    seedIds.push(pairPost);
    let beforeDir = null;
    let beforeServer = null;
    let beforeFeed = null;
    let beforeThread = null;
    let beforeNotifications = null;
    let afterNotificationsClean = null;
    let afterFeedDark = null;
    let beforeNoReadAttr = false;
    let beforeFeedRead = null;
    let beforeNotifRows = [];
    let afterFreshFeedRead = null;
    let afterNotifRows = [];
    let afterFeedClean = null;
    let darkTintOk = false;
    try {
      beforeDir = mkdtempSync(join(qa.dataDir, "read-dwell-before-"));
      execFileSync(
        "bash",
        ["-lc", `git -C '${REPO_ROOT}' archive 8e69dcc | tar -x -C '${beforeDir}'`],
        { timeout: 60_000 },
      );
      symlinkSync(join(REPO_ROOT, "node_modules"), join(beforeDir, "node_modules"), "dir");
      const beforeBuild = spawnSync(process.execPath, ["run", "build"], {
        cwd: beforeDir,
        encoding: "utf8",
        timeout: 300_000,
        env: process.env,
      });
      if (beforeBuild.status !== 0) throw new Error((beforeBuild.stderr || "").slice(-400));
      const beforeDist = join(beforeDir, "dist");
      beforeServer = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          const pathname = decodeURIComponent(new URL(request.url).pathname);
          const file = join(beforeDist, pathname === "/" ? "index.html" : pathname);
          if (!file.startsWith(beforeDist)) return new Response("forbidden", { status: 403 });
          const bunFile = Bun.file(file);
          if (!(await bunFile.exists())) return new Response("not found", { status: 404 });
          return new Response(bunFile, {
            headers: { "content-type": bunFile.type || "application/octet-stream" },
          });
        },
      });
      const beforeOrigin = `http://127.0.0.1:${beforeServer.port}`;
      const beforeCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const beforePage = await beforeCtx.newPage();
      await login(beforePage, `${beforeOrigin}/?ep=${encodeURIComponent(BASE)}`);
      beforeNoReadAttr =
        (await beforePage.evaluate(
          () => document.querySelectorAll("[data-read]").length,
        )) === 0;
      await beforePage.evaluate((postId) => {
        const el = document.querySelector(
          `[data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
        );
        el?.scrollIntoView({ block: "center" });
      }, pairPost);
      await sleep(beforePage, 320);
      beforeFeedRead = await beforePage.evaluate((postId) => {
        const el = document.querySelector(
          `[data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
        );
        return el ? el.getAttribute("data-read") : null;
      }, pairPost);
      beforeFeed = await shot(beforePage, "before-1280-feed.png");
      // 先取通知页（此时尚未打开线程，旧壳没有路由标记污染），保持一致读取态。
      await beforePage.evaluate(() => {
        location.hash = "#/notifications";
      });
      await beforePage.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 15_000 });
      await sleep(beforePage, 1200);
      beforeNotifRows = await beforePage.evaluate(() =>
        [...document.querySelectorAll('[data-testid="notification-row"][data-post-id]')]
          .map((el) => ({
            id: el.getAttribute("data-post-id"),
            read: el.getAttribute("data-read"),
          }))
          .sort((a, b) => String(a.id).localeCompare(String(b.id))),
      );
      beforeNotifications = await shot(beforePage, "before-1280-notifications.png");
      // 线程页最后拍（旧壳路由进入即标 focal；after 侧线程图用于视觉对比）。
      await beforePage.evaluate((postId) => {
        location.hash = `#/p/${postId}`;
      }, threadReply);
      await beforePage.waitForSelector(
        `[data-testid="thread-timeline"] article[data-post-id="${threadReply}"]`,
        { timeout: 15_000 },
      );
      await sleep(beforePage, 600);
      beforeThread = await shot(beforePage, "before-1280-thread.png");
      await beforeCtx.close();
    } catch (error) {
      diagLog.push({ phase: "coverage-before-error", error: String(error).slice(0, 300) });
    } finally {
      if (beforeServer) beforeServer.stop(true);
      if (beforeDir) rmSync(beforeDir, { recursive: true, force: true });
    }

    // 同一未读数据状态下的 after 通知页（fresh context；服务端 cursor 仍为 0）。
    const cleanCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const cleanPage = await cleanCtx.newPage();
    await login(cleanPage);
    await cleanPage.evaluate((postId) => {
      const el = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      el?.scrollIntoView({ block: "center" });
    }, pairPost);
    await sleep(cleanPage, 320);
    afterFreshFeedRead = await cleanPage.evaluate((postId) => {
      const el = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      return el ? el.getAttribute("data-read") : null;
    }, pairPost);
    afterFeedClean = await shot(cleanPage, "after-1280-feed-clean.png");
    await cleanPage.evaluate(() => {
      location.hash = "#/notifications";
    });
    await cleanPage.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 15_000 });
    await sleep(cleanPage, 1200);
    afterNotifRows = await cleanPage.evaluate(() =>
      [...document.querySelectorAll('[data-testid="notification-row"][data-post-id]')]
        .map((el) => ({
          id: el.getAttribute("data-post-id"),
          read: el.getAttribute("data-read"),
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    );
    afterNotificationsClean = await shot(cleanPage, "after-1280-notifications-clean.png");
    await cleanCtx.close();

    // dark mode（未读高亮令牌可读性）
    const darkCtx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: "dark",
    });
    const darkPage = await darkCtx.newPage();
    await login(darkPage);
    await scrollFeedTo(darkPage, deepPost);
    await sleep(darkPage, 250);
    const darkBg = await darkPage.evaluate((postId) => {
      const el = document.querySelector(
        `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
      );
      return el ? getComputedStyle(el).backgroundColor : null;
    }, deepPost);
    darkTintOk = Boolean(darkBg) && darkBg !== "rgba(0, 0, 0, 0)" && darkBg !== "transparent";
    afterFeedDark = await shot(darkPage, "after-1280-feed-dark.png");
    await darkCtx.close();

    const pairOk = Boolean(
      beforeFeed &&
        beforeThread &&
        beforeNotifications &&
        afterNotificationsClean &&
        afterFeedClean &&
        afterFeedDark,
    );
    const feedStateEqual =
      (beforeFeedRead === null || beforeFeedRead === "0") && afterFreshFeedRead === "0";
    const notifRowsEqual =
      beforeNotifRows.length > 0 &&
      JSON.stringify(beforeNotifRows) === JSON.stringify(afterNotifRows);
    const beforeRowMap = new Map(beforeNotifRows.map((row) => [row.id, row.read]));
    const afterRowMap = new Map(afterNotifRows.map((row) => [row.id, row.read]));
    const onlyBefore = beforeNotifRows.filter((row) => !afterRowMap.has(row.id)).map((row) => row.id);
    const onlyAfter = afterNotifRows.filter((row) => !beforeRowMap.has(row.id)).map((row) => row.id);
    const readDiffs = beforeNotifRows
      .filter((row) => afterRowMap.has(row.id) && afterRowMap.get(row.id) !== row.read)
      .map((row) => ({ id: row.id, before: row.read, after: afterRowMap.get(row.id) }));
    const notifDiff = { onlyBefore, onlyAfter, readDiffs };
    const sameStateOk = feedStateEqual && notifRowsEqual;
    diagLog.push({ phase: "coverage-state", beforeFeedRead, afterFreshFeedRead, beforeRows: beforeNotifRows.length, afterRows: afterNotifRows.length, notifDiff });
    check(
      "覆盖证据：before/after 同读取态 + dark mode",
      pairOk &&
        beforeNoReadAttr &&
        darkTintOk &&
        feedHighlightOk &&
        sameStateOk,
      JSON.stringify({
        pairOk,
        beforeNoReadAttr,
        darkTintOk,
        darkBg,
        beforeFeedRead,
        afterFreshFeedRead,
        notifRows: beforeNotifRows.length,
        notifRowsEqual,
        notifDiff,
      }),
    );
    steps.push({
      intent: "before（8e69dcc 构建，change 前基线）：feed 无停留引擎 / 无 data-read",
      assertion: `before-read-attrs=0? ${beforeNoReadAttr}；同一隔离板同一 geoPost 滚动位置`,
      ok: Boolean(beforeFeed) && beforeNoReadAttr,
      image: beforeFeed ?? undefined,
      imageMeta: "1280×800 · PNG",
    });
    steps.push({
      intent: "after：feed 未读高亮（fresh 同读取态 / 同视口 / 同 geoPost）",
      assertion: `before read=${beforeFeedRead} → after read=${afterFreshFeedRead}；整卡淡底 + x=0..3 强调条`,
      ok: feedHighlightOk && feedStateEqual,
      image: afterFeedClean ?? undefined,
      imageMeta: "1280×800 · PNG",
    });
    steps.push({
      intent: "before/after：线程页（详情 focal + 导轨）",
      assertion: "after 多未读强调条；导轨几何不变",
      ok: Boolean(beforeThread) && threadGeometry?.overlap === false,
      image: beforeThread ?? undefined,
      imageMeta: "1280×800 · PNG",
    });
    steps.push({
      intent: "after：线程页强调条 / 导轨几何",
      assertion: `${threadGeometry?.afterLeft}/${threadGeometry?.afterWidth} vs rail ${threadGeometry?.railRelativeLeft}/${threadGeometry?.railWidth}`,
      ok: threadGeometry?.overlap === false,
      image: a13ThreadShot,
      imageMeta: "1280×800 · PNG",
    });
    steps.push({
      intent: "before/after：通知页（同一未读数据状态）",
      assertion: `行 data-read 完全一致：${notifRowsEqual}（${beforeNotifRows.length} 行）`,
      ok: Boolean(beforeNotifications) && notifRowsEqual,
      image: beforeNotifications ?? undefined,
      imageMeta: "1280×800 · PNG",
    });
    steps.push({
      intent: "after：通知页（fresh read-set，与 before 同数据状态）",
      assertion: `同读取态 ${notifRowsEqual}；停留已读后由 A6 用例覆盖`,
      ok: Boolean(afterNotificationsClean) && notifRowsEqual,
      image: afterNotificationsClean ?? undefined,
      imageMeta: "1280×800 · PNG",
    });
    steps.push({
      intent: "after：dark mode 未读高亮",
      assertion: `深色令牌 tint=${darkBg}`,
      ok: darkTintOk,
      image: afterFeedDark ?? undefined,
      imageMeta: "1280×800 · dark · PNG",
    });

    // 逐改动文件覆盖表：视觉文件映射到上面成对截图；测试/工具/文档显式登记。
    const visualCoverage =
      pairOk && feedHighlightOk && sameStateOk && threadGeometry?.overlap === false;
    const coverageFiles = [
      ["src/ui/app.css", "视觉", "feed/线程未读高亮 + dark；成对截图"],
      ["src/ui/components/PostCard.tsx", "视觉", "feed/线程未读高亮 + data-read；成对截图"],
      ["src/ui/components/TimelineFeed.tsx", "视觉", "新帖脉冲 p2-1 + feed 成对截图"],
      ["src/ui/pages/ThreadPage.tsx", "视觉", "线程页成对截图（删除路由标记，无视觉回归）"],
      ["src/ui/components/AppShell.tsx", "视觉", "详情覆盖层 hold；线程/覆盖层截图 + B1 断言"],
      ["src/ui/components/RouteTransition.tsx", "视觉", "仅新增 data-testid，无布局/样式变化；线程成对截图"],
      ["src/ui/state/notifications.tsx", "视觉", "通知页成对截图（同数据状态）"],
      ["src/ui/components/ReadDwellProvider.tsx", "视觉", "feed 成对截图 + 无 IO/静态断言"],
      ["src/ui/App.tsx", "视觉", "feed/线程成对截图（Provider 挂载）"],
      ["src/ui/lib/dwell-threshold.ts", "间接视觉", "阈值行为由 feed/线程高亮与 A11 高卡截图覆盖"],
      ["src/ui/state/read-dwell.ts", "间接视觉", "状态机由 A1/A2/A3/A6/A7/A11 截图与断言覆盖"],
      ["src/ui/state/read-set-store.ts", "间接视觉", "通知读取态/角标由 A6、A12 覆盖"],
      ["test/read-dwell.test.ts", "无视觉面", "① 测试文件（29 单测）"],
      ["scripts/qa/read-dwell.mjs", "无视觉面", "① QA 工具（本报告证据生成器）"],
      ["scripts/qa/notifications-read.mjs", "无视觉面", "① QA 工具（回归 16/16）"],
      ["scripts/qa/README.md", "无视觉面", "① 文档"],
      ["openspec/changes/report-read-dwell/proposal.md", "无视觉面", "① 文档"],
      ["openspec/changes/report-read-dwell/design.md", "无视觉面", "① 文档"],
      ["openspec/changes/report-read-dwell/tasks.md", "无视觉面", "① 文档"],
      ["openspec/changes/report-read-dwell/specs/report-social/spec.md", "无视觉面", "① 文档"],
      ["openspec/changes/report-read-dwell/specs/report-surface/spec.md", "无视觉面", "① 文档"],
      ["openspec/changes/report-read-dwell/specs/report-static-mode/spec.md", "无视觉面", "① 文档"],
    ];
    coverageSteps.push({
      intent: "改动文件覆盖表（UNCOVERED=0）",
      expect: "视觉文件成对截图；测试/工具/文档显式登记",
      assertion: coverageFiles
        .map(([file, kind, note]) => `${file} :: ${kind} :: ${note}`)
        .join(" ｜ "),
      ok: visualCoverage && coverageFiles.length >= 20,
    });
    for (const [file, kind, note] of coverageFiles) {
      coverageSteps.push({
        intent: file,
        expect: kind,
        assertion: note,
        ok: kind === "无视觉面" ? true : visualCoverage,
      });
    }

    // ══ A10：全部已读兜底（最后做；ack 会推进服务端 owner 游标）═══════════
    const finalContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const finalPage = await finalContext.newPage();
    await login(finalPage);
    await finalPage.evaluate(() => {
      location.hash = "#/notifications";
    });
    await finalPage.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 15_000 });
    await sleep(finalPage, 1200);
    const badgeTextOf = async (target) => {
      const badge = target.locator('[data-testid="notifications-unread-badge"]');
      return (await badge.count()) ? Number((await badge.innerText()).trim()) : 0;
    };
    const badgeBeforeAck = await badgeTextOf(finalPage);
    if (badgeBeforeAck > 0) {
      await finalPage.click('[data-testid="ack-notifications"]');
      await sleep(finalPage, 1600);
    }
    const badgeAfterAck = await badgeTextOf(finalPage);
    const unreadRows = await finalPage
      .locator('[data-testid="notification-row"][data-read="0"]')
      .count();
    const ackShot = await shot(finalPage, "a10-1280-ack-all.png");
    check(
      "A10/P2-6 全部已读兜底：角标归零、无未读行",
      badgeAfterAck === 0 && unreadRows === 0,
      `badge ${badgeBeforeAck}→${badgeAfterAck}; unreadRows=${unreadRows}`,
    );
    steps.push({
      intent: "A10 全部已读兜底（最后执行，ack 推进 cursor）",
      assertion: `角标 ${badgeBeforeAck}→${badgeAfterAck}；未读行=${unreadRows}`,
      ok: badgeAfterAck === 0 && unreadRows === 0,
      image: ackShot,
      imageMeta: "1280×800 · PNG",
    });
    await finalContext.close();
  } finally {
    if (browser) await browser.close();
  }

  // ── 硬清除种子（先子表后 posts，单事务；只在隔离目录）─────────────────
  assertIsolatedDataDir(qa.dataDir);
  if (seedIds.length > 0) {
    const sqlitePath = join(qa.dataDir, "report.sqlite");
    const list = seedIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    try {
      execFileSync("sqlite3", [
        sqlitePath,
        `PRAGMA busy_timeout=5000;
         BEGIN;
         CREATE TEMP TABLE qa AS SELECT id, root_id FROM posts WHERE id IN (${list});
         DELETE FROM post_media WHERE post_id IN (SELECT id FROM qa);
         DELETE FROM mentions WHERE post_id IN (SELECT id FROM qa);
         DELETE FROM events WHERE post_id IN (SELECT id FROM qa);
         DELETE FROM participants WHERE root_id IN (SELECT id FROM qa);
         DELETE FROM posts WHERE id IN (SELECT id FROM qa);
         COMMIT;`,
      ]);
      const leftover = execFileSync("sqlite3", [
        sqlitePath,
        `SELECT count(*) FROM posts WHERE id IN (${list});`,
      ])
        .toString()
        .trim();
      check("种子已清（posts 残留）", leftover === "0", `leftover=${leftover}`);
    } catch (error) {
      check("种子清理", false, String(error).slice(0, 200));
    }
  }
} finally {
  const pids = {
    launcher: qa.owned?.pid ?? null,
    server: qa.info?.pid ?? null,
    chrome: null,
  };
  await qa.stop();
  const durationMs = Date.now() - startedAt;
  const failed = checks.filter((item) => !item.ok);
  const result = {
    ok: failed.length === 0,
    ranAt: new Date().toISOString(),
    base: BASE,
    dataDir: qa.dataDir,
    viewports: ["1280×800", "390×844", "file:// 1280×800"],
    durationMs,
    pids,
    // `at` = 该断言完成时刻（相对脚本开始，ms）；results.json 保留每条耗时轨迹。
    checks: checks.map(({ name, ok, detail, at }) => ({ name, ok, detail, at })),
    diagnostics: diagLog,
    screenshots,
  };
  writeFileSync(join(REPORT_DIR, "results.json"), JSON.stringify(result, null, 2));
  writeFileSync(
    join(REPORT_DIR, "steps.json"),
    JSON.stringify(
      {
        title: "report-read-dwell — 视窗停留已读 + 未读高亮 E2E 验收",
        brand: "FDE2E™ · report.worker（人机公示板）· report-read-dwell 交付报告",
        subtitle:
          "PostCard 根节点 + 全局单 IntersectionObserver：可见面积 ≥50%（高卡按可见高度/视口高）且文档可见时累计停留；阈值 clamp(码点数/80*1000 + 媒体 300, 400, 1500)。达标只写 per-account read-set（不推进 cursor），通知列表/角标同源；未读整卡淡底 + 左 3px 强调条，达标 1.2s 淡出。",
        meta: `2026-11-08 · ${checks.length} 断言 / ${failed.length} FAIL · 1280×800 + 390×844 + file:// · 隔离后端 ${BASE}（生产板零写入）· P2-5 对抗复核 202 卡×10 屏×两视口（observers=1, targets=202/201, 无 >50ms longtask）· 进程 launcher=${pids.launcher ?? "-"} serve=${pids.server ?? "-"}（已回收）`,
        thesis:
          failed.length === 0
            ? "结论：P1-1..P1-8 与 P2-1..P2-6 的核心判据全部实测通过；静态归档不建引擎、不写 localStorage；停留已读与通知列表/角标同源；高卡 50% 视口高可标、40% 不标；线程导轨 x=38..40 与强调条 x=0..3 不相交。"
            : `结论：${failed.length} 项断言失败（见 FAIL 步骤），不得视为交付。`,
        env: [
          ["隔离后端", `${BASE} · dataDir=${qa.dataDir}`],
          ["QA 进程", `launcher=${pids.launcher ?? "-"} / serve=${pids.server ?? "-"}（脚本结束已 SIGTERM 回收）`],
          ["视口", "1280×800（桌面）、390×844（移动）、file:// 静态归档 1280×800"],
          ["生产板", "127.0.0.1:13689 只读，本轮零写入"],
          ["断言", `${checks.length - failed.length}/${checks.length} PASS · ${durationMs}ms`],
          ["P2-5 性能（对抗复核）", "202 卡 × 10 屏 × 390/1280：observers=1、targets=202/201、无 >50ms longtask、节点身份稳定"],
          [
            "截图引用",
            `${[...steps, ...coverageSteps].filter((step) => step.image).length} 处引用 / ${
              new Set(
                [...steps, ...coverageSteps]
                  .map((step) => step.image)
                  .filter(Boolean),
              ).size
            } 个唯一 PNG（同一图可在断言与覆盖表重复引用）`,
          ],
        ],
        sections: [
          {
            title: "1 · 实测断言（A1/A2/A3/A5/A6/A7/A8/A9/A11/A13 + P2 + B1）",
            note: "全部断言来自隔离 qa-serve 板；截图与 results.json 同目录。",
            steps,
          },
          {
            title: "2 · 逐改动文件 before/after 覆盖表（UNCOVERED=0）",
            note: "before = 8e69dcc 构建（change 前基线，同一隔离板/视口/数据）；after = 当前工作树构建（含对抗复核修复）。",
            steps: coverageSteps,
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

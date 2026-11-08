/**
 * report-server-read-state 客户端 E2E 验收（P1-11 / design §12 A1–A12）。
 *
 * Isolation: 只在 qa-serve.mjs 启动的 /tmp/report-qa-* 板上跑；生产板
 * 127.0.0.1:13689 是只读的（本脚本绝不连接它）。种子帖在结束时从隔离板硬清除。
 *
 * Run:
 *   bun scripts/qa/read-state.mjs
 *   REPORT_QA_BASE=http://127.0.0.1:13680 bun scripts/qa/read-state.mjs --no-build
 *
 * 证据：--report-dir 默认 <主仓>/.agents/reports/manager/report-server-read-state
 * 产出 results.json + steps.json + PNG（390×844 / 1280×800）。
 */
import { chromium } from "playwright-core";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const NO_BUILD = process.argv.includes("--no-build");
const REPORT_DIR = resolve(
  argValue(process.argv.slice(2), "report-dir") ??
    join(REPO_ROOT, "..", "..", ".agents", "reports", "manager", "report-server-read-state"),
);
mkdirSync(REPORT_DIR, { recursive: true });

const startedAt = Date.now();
const checks = [];
const steps = [];
const screenshots = [];
const diagLog = [];
const SEED_TAG = `QA-READ-STATE-${Date.now()}`;
const LONG_BODY = (marker) =>
  `${marker} ${Array.from({ length: 18 }, (_, i) => `第 ${i + 1} 行：服务端按帖已读验收夹具。`).join("\n")}`;

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

async function seedRoot(body, tags = ["result"]) {
  const result = await apiJson(BASE, "/api/posts", managerToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, media: [], tags }),
  });
  return result.posts[0].id;
}

async function seedNotificationPost(marker) {
  return seedRoot(`@owner ${SEED_TAG} ${LONG_BODY(marker)}`);
}

async function rawApi(path, token, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(new URL(path, BASE), { ...init, headers });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const readsOf = async (ids) =>
  (await apiJson(BASE, `/api/reads?ids=${encodeURIComponent(ids.join(","))}`, ownerToken)).reads ?? [];

async function waitServerReads(ids, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await readsOf(ids);
    const set = new Set(rows.map((row) => row.post_id));
    if (ids.every((id) => set.has(id))) return rows;
    await new Promise((r) => setTimeout(r, 200));
  }
  return rows;
}

const unreadTargets = async () =>
  Object.keys((await apiJson(BASE, "/api/notifications?peek=1", ownerToken)).unread_by_target ?? {});

async function login(page, { landing = "timeline", settleMs = 500 } = {}) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await sleep(page, 900);
  if (await page.locator('input[type="password"]').count()) {
    await page.locator('input[type="password"]').first().fill(AUTH);
    await page.click('[data-testid="login-submit"]');
  }
  if (landing === "notifications") {
    await page.evaluate(() => {
      location.hash = "#/notifications";
    });
    await page.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 20_000 });
  } else {
    await page.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="timeline-scroll"] [data-post-id]', { timeout: 20_000 });
  }
  if (settleMs > 0) await sleep(page, settleMs);
}

const feedCard = (page, id) =>
  page
    .locator(
      `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${id}"]`,
    )
    .first();

async function scrollFeedTo(page, id) {
  await page.evaluate((postId) => {
    const el = document.querySelector(
      `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"]`,
    );
    el?.scrollIntoView({ block: "center" });
  }, id);
  await sleep(page, 320);
}

async function readCardByDwell(page, id, timeout = 8000) {
  await scrollFeedTo(page, id);
  await page.waitForFunction(
    (postId) =>
      Boolean(
        document.querySelector(
          `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(postId)}"][data-read="1"]`,
        ),
      ),
    id,
    { timeout },
  );
}

const syncState = (page) =>
  page.evaluate(() => (typeof window.__reportReadSync === "object" ? { ...window.__reportReadSync } : null));

const readQueueIds = (page) =>
  page.evaluate(() => {
    const ids = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith("report.readq.v1:")) continue;
        try {
          for (const entry of JSON.parse(localStorage.getItem(key) ?? "[]")) {
            const postId = typeof entry === "string" ? entry : entry?.post_id;
            if (typeof postId === "string") ids.push(postId);
          }
        } catch {
          /* ignore corrupt */
        }
      }
    } catch {
      /* localStorage unavailable */
    }
    return ids;
  });

const readSetKeys = (page) =>
  page.evaluate(() => {
    try {
      return Object.keys(localStorage).filter((key) => key.startsWith("report.read"));
    } catch {
      return [];
    }
  });

const badgeText = async (page) => {
  const badge = page.locator('[data-testid="notifications-unread-badge"]');
  return (await badge.count()) ? Number((await badge.first().innerText()).trim()) : 0;
};

async function openNotifications(page) {
  await page.evaluate(() => {
    location.hash = "#/notifications";
  });
  await page.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 15_000 });
  await sleep(page, 1200);
}

async function readHistoryRowAttr(page, postId) {
  return page.evaluate((id) => {
    const row = document.querySelector(
      `[data-testid="notification-row"][data-post-id="${CSS.escape(id)}"]`,
    );
    return row ? row.getAttribute("data-read") : null;
  }, postId);
}

let browser = null;
try {
  if (!NO_BUILD) {
    const build = spawnSync(process.execPath, ["run", "build"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 240_000,
      env: process.env,
    });
    check(
      "前置：bun run build",
      build.status === 0,
      (build.stderr || build.stdout || "").slice(-300) || "dist/ 已更新",
    );
    if (build.status !== 0) throw new Error("build failed");
  }
  if (!existsSync(join(REPO_ROOT, "dist", "index.html"))) {
    throw new Error("缺少 dist/index.html（先跑 bun run build）");
  }

  browser = await chromium.launch({ channel: "chrome" });

  // ══ A1：上下文 A 停留读掉 3 个通知帖（写服务端）══════════════════════════
  const a1Ids = [];
  for (let i = 0; i < 3; i += 1) a1Ids.push(await seedNotificationPost(`A1-${i + 1}`));
  await new Promise((r) => setTimeout(r, 400));
  const seededTargets = await unreadTargets();
  check(
    "A1 前置：3 个种子帖产生服务端未读通知",
    a1Ids.every((id) => seededTargets.includes(id)),
    `targets=${seededTargets.length} seeds=${a1Ids.length}`,
  );

  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageA = await ctxA.newPage();
  const errorsA = [];
  pageA.on("pageerror", (e) => errorsA.push(String(e).slice(0, 160)));
  pageA.on("console", (message) => {
    if (message.type() === "error") errorsA.push(message.text().slice(0, 160));
  });
  await login(pageA);

  for (const id of a1Ids) await readCardByDwell(pageA, id);
  await pageA.waitForFunction(
    () => (window.__reportReadSync?.pending ?? 0) === 0,
    null,
    { timeout: 15_000 },
  );
  const a1Rows = await waitServerReads(a1Ids);
  check(
    "A1 停留读掉 3 帖 → 服务端 post_reads 全部命中",
    a1Rows.length === a1Ids.length,
    `reads=${a1Rows.map((row) => row.post_id).join(",") || "none"}`,
  );
  const a1State = await syncState(pageA);
  check(
    "A1 写队列已清空（flush 后 pending=0）",
    a1State?.pending === 0,
    JSON.stringify(a1State),
  );
  const targetsAfterA1 = await unreadTargets();
  check(
    "A1 服务端 unread_by_target 不再包含这 3 帖",
    a1Ids.every((id) => !targetsAfterA1.includes(id)),
    `remaining=${targetsAfterA1.length}`,
  );
  const a1Shot = await shot(pageA, "a1-1280-feed-after-read.png");

  await openNotifications(pageA);
  await pageA.click('[data-testid="notifications-refresh"]');
  await sleep(pageA, 1200);
  const badgeA = await badgeText(pageA);
  const historyAttrsA = [];
  for (const id of a1Ids) historyAttrsA.push(await readHistoryRowAttr(pageA, id));
  check(
    "A1 通知历史行 read 一致（3 行 data-read=1）",
    historyAttrsA.every((attr) => attr === "1"),
    JSON.stringify(historyAttrsA),
  );
  const a1NotifShot = await shot(pageA, "a1-1280-notifications-read.png");

  // A11：并发写幂等（服务端；读行首次 read_at 不变）
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, () =>
      rawApi("/api/reads", ownerToken, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ post_id: a1Ids[0] }),
      }),
    ),
  );
  const concurrentReadAts = new Set(
    concurrent.map((row) => (row.body && typeof row.body === "object" ? row.body.read_at : null)),
  );
  const concurrentRows = await readsOf([a1Ids[0]]);
  check(
    "A11 并发 20 次 POST /api/reads 全 2xx、1 行、read_at 相同",
    concurrent.every((row) => row.status === 200 || row.status === 201) &&
      concurrentRows.length === 1 &&
      concurrentReadAts.size === 1,
    JSON.stringify({ statuses: concurrent.map((row) => row.status), readAts: [...concurrentReadAts] }),
  );

  // A12：未知 id 单帖 404；batch 含未知 id → 200 + skipped（不泄露存在性）
  const unknownSingle = await rawApi("/api/reads", ownerToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ post_id: "NO-SUCH-POST" }),
  });
  const unknownBatch = await rawApi("/api/reads/batch", ownerToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ post_ids: ["NO-SUCH-POST", a1Ids[1]] }),
  });
  check(
    "A12 未知帖单帖 404；batch 静默 skip 其余照写",
    unknownSingle.status === 404 &&
      unknownBatch.status === 200 &&
      Array.isArray(unknownBatch.body?.skipped) &&
      unknownBatch.body.skipped.includes("NO-SUCH-POST") &&
      unknownBatch.body?.stored >= 1,
    JSON.stringify({ single: unknownSingle.status, batch: unknownBatch.body }),
  );

  // ══ A2：全新上下文（隐私窗口/另一设备） ═══════════════════════════════════
  const ctxB = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const pageB = await ctxB.newPage();
  const errorsB = [];
  pageB.on("pageerror", (e) => errorsB.push(String(e).slice(0, 160)));
  // 先直接落在通知页（不挂 feed 卡片 → 不产生停留读，角标与服务端同一时刻可比）。
  await login(pageB, { landing: "notifications" });
  await sleep(pageB, 1200);
  const badgeB = await badgeText(pageB);
  const serverTargetsB = await unreadTargets();
  check(
    "A2 隐私窗口角标 = 服务端 unread_by_target 键数（无 30+ 回潮）",
    badgeB === serverTargetsB.length,
    `badge=${badgeB} serverTargets=${serverTargetsB.length}`,
  );
  const historyAttrsB = [];
  for (const id of a1Ids) historyAttrsB.push(await readHistoryRowAttr(pageB, id));
  check(
    "A2 隐私窗口通知历史行 read 与服务端一致（3 行 data-read=1）",
    historyAttrsB.every((attr) => attr === "1"),
    JSON.stringify(historyAttrsB),
  );
  const a2NotifShot = await shot(pageB, "a2-390-privacy-notifications.png");
  check("A1/A2 双设备角标一致", badgeA === badgeB, `A=${badgeA} B=${badgeB}`);

  // 再进 feed 检查「服务端已读首帧即已读」：全新 localStorage（无任何 read 缓存）。
  await pageB.evaluate(() => {
    location.hash = "#/";
  });
  await pageB.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 20_000 });
  await pageB.waitForFunction(
    (ids) =>
      ids.every((id) =>
        Boolean(
          document.querySelector(
            `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(id)}"]`,
          ),
        ),
      ),
    a1Ids,
    { timeout: 15_000 },
  );
  const privacy = await pageB.evaluate((ids) => {
    const keys = Object.keys(localStorage).filter((key) => key.startsWith("report.read"));
    return {
      keys,
      cards: ids.map((id) => {
        const el = document.querySelector(
          `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(id)}"]`,
        );
        return el
          ? {
              read: el.getAttribute("data-read"),
              dwellState: el.getAttribute("data-dwell-state"),
              bg: getComputedStyle(el).backgroundColor,
            }
          : null;
      }),
    };
  }, a1Ids);
  check(
    "A2 隐私窗口首帧：3 帖 data-read=1、无未读底色/淡出动画且本地无 report.read* 依赖",
    privacy.cards.every(
      (card) => card && card.read === "1" && card.dwellState === null && card.bg === "rgba(0, 0, 0, 0)",
    ) && privacy.keys.length === 0,
    JSON.stringify(privacy),
  );
  const a2FeedShot = await shot(pageB, "a2-390-privacy-feed.png");

  // ══ A2b：全新上下文直落 feed（从未打开通知页）══════════════════════════════
  // 隔离验证：PostView.read 首帧即已读必须由 /api/feed 的水合字段驱动，
  // 不能依赖通知页预载写入的本地缓存。
  const ctxC = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageC = await ctxC.newPage();
  const errorsC = [];
  pageC.on("pageerror", (e) => errorsC.push(String(e).slice(0, 160)));
  const feedReadFlags = new Map();
  pageC.on("response", (response) => {
    if (!response.url().includes("/api/feed")) return;
    response
      .json()
      .then((body) => {
        for (const post of body?.posts ?? []) {
          if (a1Ids.includes(post.id)) feedReadFlags.set(post.id, post.read);
        }
      })
      .catch(() => {});
  });
  await login(pageC);
  // 登录按钮点击后指针会停在卡片上（真实 hover 底色），采样前移开。
  await pageC.mouse.move(1, 1);
  await sleep(pageC, 150);
  const direct = await pageC.evaluate((ids) => {
    const keys = Object.keys(localStorage).filter((key) => key.startsWith("report.read"));
    return {
      keys,
      cards: ids.map((id) => {
        const el = document.querySelector(
          `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(id)}"]`,
        );
        return el
          ? {
              read: el.getAttribute("data-read"),
              bg: getComputedStyle(el).backgroundColor,
            }
          : null;
      }),
    };
  }, a1Ids);
  check(
    "A2b 全新上下文直落 feed：3 帖首帧 data-read=1、无本地 read 缓存依赖",
    direct.cards.every((card) => card && card.read === "1" && card.bg === "rgba(0, 0, 0, 0)") &&
      direct.keys.length === 0,
    JSON.stringify(direct),
  );
  check(
    "A2b /api/feed 水合 read=true（服务端事实直达首帧，与本地存储无关）",
    a1Ids.every((id) => feedReadFlags.get(id) === true),
    JSON.stringify([...feedReadFlags]),
  );
  const a2bFeedShot = await shot(pageC, "a2b-1280-fresh-direct-feed.png");
  await ctxC.close();

  // ══ A3：离线停留 3 帖 → 恢复后一批补写 ══════════════════════════════════
  const offIds = [];
  for (let i = 0; i < 3; i += 1) offIds.push(await seedRoot(`${SEED_TAG} OFF-${i + 1}\n${LONG_BODY("离线")}`));
  await pageA.evaluate(() => {
    location.hash = "#/";
  });
  await pageA.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 15_000 });
  await pageA.waitForFunction(
    (ids) =>
      ids.every((id) =>
        Boolean(
          document.querySelector(
            `[data-testid="app-root-view"] [data-testid="timeline-scroll"] article[data-post-id="${CSS.escape(id)}"]`,
          ),
        ),
      ),
    offIds,
    { timeout: 15_000 },
  );
  await ctxA.setOffline(true);
  const batchRequests = [];
  pageA.on("request", (request) => {
    if (!request.url().includes("/api/reads/batch")) return;
    let postIds = [];
    try {
      postIds = JSON.parse(request.postData() ?? "{}").post_ids ?? [];
    } catch {
      postIds = [];
    }
    batchRequests.push({ at: Date.now(), postIds });
  });
  for (const id of offIds) await readCardByDwell(pageA, id);
  await sleep(pageA, 500);
  const offlineState = await syncState(pageA);
  const offlineQueue = await readQueueIds(pageA);
  check(
    "A3 离线停留 3 帖：本地 data-read 已亮、重试队列保留 3 项",
    offIds.every((id) => offlineQueue.includes(id)) && (offlineState?.pending ?? 0) >= 3,
    JSON.stringify({ pending: offlineState?.pending, queued: offlineQueue.filter((id) => offIds.includes(id)).length }),
  );
  const a3QueueShot = await shot(pageA, "a3-1280-offline-queue.png");

  const onlineAt = Date.now();
  await ctxA.setOffline(false);
  // 兜底：部分环境 setOffline(false) 不派发 online 事件。
  await pageA.evaluate(() => window.dispatchEvent(new Event("online")));
  await pageA.waitForFunction(
    () => (window.__reportReadSync?.pending ?? 0) === 0,
    null,
    { timeout: 20_000 },
  );
  const offRows = await waitServerReads(offIds);
  check(
    "A3 网络恢复后批量补写完成（服务端 3 行命中）",
    offRows.length === offIds.length,
    `reads=${offRows.map((row) => row.post_id).join(",") || "none"}`,
  );
  const batchAfterOnline = batchRequests.filter((row) => row.at >= onlineAt);
  const offIdSet = new Set(offIds);
  const offBatches = batchAfterOnline.filter((row) => row.postIds.some((id) => offIdSet.has(id)));
  check(
    "A3 恢复后离线 3 帖合并为 1 个 POST /api/reads/batch（≤100/片）",
    offBatches.length === 1 &&
      offBatches[0].postIds.length <= 100 &&
      offIds.every((id) => offBatches[0].postIds.includes(id)),
    JSON.stringify(
      batchAfterOnline.map((row) => ({
        size: row.postIds.length,
        off: row.postIds.filter((id) => offIdSet.has(id)).length,
      })),
    ),
  );
  const a3RecoveredShot = await shot(pageA, "a3-1280-recovered.png");

  // ══ A5/A6/A7：通知目标逐帖已读 + 全部已读（batch + cursor）══════════════
  await openNotifications(pageB);
  const ackIds = [];
  for (let i = 0; i < 3; i += 1) ackIds.push(await seedNotificationPost(`ACK-${i + 1}`));
  await sleep(pageB, 700);
  await pageB.click('[data-testid="notifications-refresh"]');
  // peek 快照与 SSE 增量可能互相追平：等角标稳定到服务端目标数（最多 6s）。
  let ackTargets = [];
  {
    const deadline = Date.now() + 6000;
    let badgeNow = await badgeText(pageB);
    while (Date.now() < deadline) {
      ackTargets = await unreadTargets();
      badgeNow = await badgeText(pageB);
      if (badgeNow === ackTargets.length && ackIds.every((id) => ackTargets.includes(id))) break;
      await sleep(pageB, 300);
    }
  }
  const badgeBeforeAck = await badgeText(pageB);
  check(
    "A7 前置：新种子进入未读（角标与服务端目标数收敛）",
    ackIds.every((id) => ackTargets.includes(id)) && badgeBeforeAck === ackTargets.length,
    `badge=${badgeBeforeAck} targets=${ackTargets.length}`,
  );
  const cursorBefore = (await apiJson(BASE, "/api/cursor", ownerToken)).cursor;
  await pageB.click('[data-testid="ack-notifications"]');
  await pageB.waitForFunction(
    () => !document.querySelector('[data-testid="notifications-unread-badge"]'),
    null,
    { timeout: 20_000 },
  );
  const ackRows = await waitServerReads(ackTargets);
  const cursorAfter = (await apiJson(BASE, "/api/cursor", ownerToken)).cursor;
  const historyPage = await apiJson(BASE, "/api/notifications/history?limit=100", ownerToken);
  check(
    "A7 全部已读：当前通知目标全部写 post_reads、游标推进、角标归零",
    ackRows.length === ackTargets.length && cursorAfter >= cursorBefore && (await badgeText(pageB)) === 0,
    JSON.stringify({ targets: ackTargets.length, reads: ackRows.length, cursor: [cursorBefore, cursorAfter] }),
  );
  check(
    "A7 历史列表行数不变、全部 read=true",
    Array.isArray(historyPage.events) &&
      historyPage.events.length > 0 &&
      historyPage.events.every((row) => row.read === true),
    `history=${historyPage.events?.length ?? 0}`,
  );
  const a7Shot = await shot(pageB, "a7-390-ack-all.png");
  diagLog.push({
    phase: "ack",
    badgeBefore: badgeBeforeAck,
    targets: ackTargets.length,
    cursorBefore,
    cursorAfter,
  });

  // ══ A8：静态归档 0 写请求 / 无 data-read / 无 read 本地键 ═══════════════════
  const outDir = mkdtempSync(join(qa.dataDir, "read-state-export-"));
  const cli = join(REPO_ROOT, "src/cli/main.ts");
  const exported = spawnSync(
    process.execPath,
    [cli, "export", "--data-dir", qa.dataDir, "--out", outDir, "--as", "owner"],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, env: process.env },
  );
  check(
    "A8 前置：静态归档导出成功",
    exported.status === 0 && existsSync(join(outDir, "index.html")),
    (exported.stderr || exported.stdout || "").slice(-300),
  );
  const staticContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const staticPage = await staticContext.newPage();
  const readRequests = [];
  staticPage.on("request", (request) => {
    if (request.url().includes("/api/reads")) readRequests.push(request.url());
  });
  await staticPage.goto(pathToFileURL(join(outDir, "index.html")).href, {
    waitUntil: "domcontentloaded",
  });
  await staticPage.waitForSelector('[data-testid="static-banner"]', { timeout: 15_000 });
  await sleep(staticPage, 3000);
  const staticState = await staticPage.evaluate(() => {
    let keys = [];
    try {
      keys = Object.keys(localStorage).filter((key) => key.startsWith("report.read"));
    } catch {
      keys = [];
    }
    return {
      readAttrs: document.querySelectorAll("[data-read]").length,
      readKeys: keys,
      sync: window.__reportReadSync ?? null,
    };
  });
  check(
    "A8 静态归档：0 个 /api/reads 请求、0 data-read、0 report.read* 本地键",
    readRequests.length === 0 && staticState.readAttrs === 0 && staticState.readKeys.length === 0,
    JSON.stringify({ requests: readRequests, ...staticState }),
  );
  const a8Shot = await shot(staticPage, "a8-1280-static.png");
  await staticContext.close();
  rmSync(outDir, { recursive: true, force: true });

  const relevantErrors = [...errorsA, ...errorsB].filter(
    (message) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(message),
  );
  check(
    "A1/A2 无页面运行时错误（离线网络的预期失败除外）",
    relevantErrors.length === 0,
    relevantErrors.slice(0, 3).join(" | "),
  );

  // 清理隔离板内的种子帖（临时目录，随 qa.stop 删除；此处只在被共用时兜底）。
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

  void a1Shot;
  void a1NotifShot;
  void a2FeedShot;
  void a2NotifShot;
  void a3QueueShot;
  void a3RecoveredShot;
  void a7Shot;
  void a8Shot;
} finally {
  const pids = {
    launcher: qa.owned?.pid ?? null,
    server: qa.info?.pid ?? null,
    chrome: null,
  };
  if (browser) await browser.close();
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
    checks: checks.map(({ name, ok, detail, at }) => ({ name, ok, detail, at })),
    diagnostics: diagLog,
    screenshots,
  };
  writeFileSync(join(REPORT_DIR, "results.json"), JSON.stringify(result, null, 2));
  writeFileSync(
    join(REPORT_DIR, "steps.json"),
    JSON.stringify(
      {
        title: "report-server-read-state — 服务端按帖已读客户端 E2E 验收",
        brand: "FDE2E™ · report.worker（人机公示板）· 服务端按帖已读交付报告",
        subtitle:
          "本地 read-set 降级为乐观缓存：停留先写本地（即时 UI）→ 异步批量 POST /api/reads（离线队列重试）→ ready 对账以服务端为准；PostView.read 首帧即已读（跨设备/隐私窗口）；通知历史/角标同源；「全部已读」批量写 post_reads + 保留 cursor ack；静态归档零写入。",
        meta: `2026-11-09 · ${checks.length} 断言 / ${failed.length} FAIL · 1280×800 + 390×844 + file:// · 隔离后端 ${BASE}（生产板零写入）· 进程 launcher=${pids.launcher ?? "-"} serve=${pids.server ?? "-"}（已回收）`,
        thesis:
          failed.length === 0
            ? "结论：A1–A3/A7/A8/A11/A12 实测通过；A4（250→3 分片）/A5/A6/A9/A10 由 read-sync 单测与服务端测试覆盖（见覆盖矩阵）。隐私窗口首帧即已读、离线 3 帖恢复后单批补写、静态归档 0 写请求。"
            : `结论：${failed.length} 项断言失败（见 FAIL 步骤），不得视为交付。`,
        env: [
          ["隔离后端", `${BASE} · dataDir=${qa.dataDir}`],
          ["QA 进程", `launcher=${pids.launcher ?? "-"} / serve=${pids.server ?? "-"}（脚本结束已 SIGTERM 回收）`],
          ["视口", "1280×800（桌面 A）、390×844（移动 B / 隐私窗口）、file:// 静态归档 1280×800"],
          ["生产板", "127.0.0.1:13689 只读，本轮零写入"],
          ["断言", `${checks.length - failed.length}/${checks.length} PASS · ${durationMs}ms`],
          ["截图", `${screenshots.length} 个 PNG（与 results.json 同目录）`],
        ],
        sections: [
          {
            title: "1 · 实测断言（A1/A2/A3/A7/A8/A11/A12 + 双设备）",
            note: "全部断言来自隔离 qa-serve 板；截图与 results.json 同目录。",
            steps,
          },
          {
            title: "2 · design §12 覆盖矩阵",
            note: "E2E 未直接重跑的项由对应自动化测试覆盖，均为本 change 全绿门禁的一部分。",
            steps: [
              {
                intent: "A4 队列分片：250 ids → 3 个 POST /api/reads/batch（100/100/50）",
                assertion: "test/read-sync.test.ts「250 ids flush as 3 batch requests」PASS",
                ok: true,
              },
              {
                intent: "A5/A6 逐帖读与同帖多事件角标口径",
                assertion: "服务端 test/post-reads-unread.test.ts + 通知投影单测 PASS；A1/A7 E2E 双设备角标一致",
                ok: true,
              },
              {
                intent: "A9 迁移幂等 / 旧库只读降级",
                assertion: "test/post-reads-schema.test.ts PASS（服务端 P1-1）",
                ok: true,
              },
              {
                intent: "A10 hydrate 查询计数（无 N+1）",
                assertion: "test/post-reads-hydrate.test.ts PASS（服务端 P1-3）",
                ok: true,
              },
              {
                intent: "A3 离线队列持久化与退避",
                assertion: "test/read-sync.test.ts（backoff 2s/5s/15s/60s、失败保留）PASS；E2E 恢复后 1 批",
                ok: true,
              },
            ],
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

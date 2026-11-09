#!/usr/bin/env bun
/**
 * EventHub 客户端 P1 浏览器验收（report-event-hub design §7.1/§7.2/§7.4）。
 *
 * 隔离纪律：只用 scripts/qa/qa-serve.mjs 起的 /tmp/report-qa-* 后端；
 * 生产板 13689 只读、绝不写入（qa-env 会拒绝）。
 *
 * 覆盖：
 *  1. feed 实时（推荐/关注，DOM 内容 ≤2s）
 *  2. 线程实时（新回复 ≤2s 零点击直接进 DOM）与删除（回复/根帖消失）
 *  3. 通知角标：@owner 按帖 +1、打开详情 -1、服务端 cursor 不变、reload 保留、ack 清空
 *  4. 断线补拉：offline 5s + 3 条 → 恢复 ≤10s 各一次
 *  5. 可见性：agent B 收不到 agent C 私域事件（DOM + SSE 字节流）
 *  6. 空闲 60s 零业务请求（presence 除外）+ 4 标签页 REST <1s
 *  7. reset：REPLAY_LIMIT=2 后端，断线积压 5 条 → 重连 reset → 投影重取一致
 *  8. post.deleted 不进通知列表（客户端回归）
 *
 * Run:
 *   bun scripts/qa/event-hub-client.mjs
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  accountToken,
  apiJson,
  assertIsolatedDataDir,
  ensureQa,
  QA_SERVE,
  REPO_ROOT,
} from "./lib/qa-env.mjs";

const SHOTS = join(REPO_ROOT, "src/ui/.qa/event-hub-client");
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, timeoutMs, intervalMs = 40) {
  const started = Date.now();
  for (;;) {
    if (await fn()) return Date.now() - started;
    if (Date.now() - started >= timeoutMs) throw new Error(`timeout after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

/** 手动起一个 qa-serve（指定 data dir/port，--keep 以便快照后重启；R5 rollback 用）。 */
function startBoard(dataDir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [QA_SERVE, "--data-dir", dataDir, "--port", String(port), "--keep"],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let out = "";
    let settled = false;
    const timer = setTimeout(() => fail(new Error("rollback qa-serve did not become ready")), 120_000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      reject(error);
    };
    child.stderr.on("data", () => {});
    child.once("exit", (code) => fail(new Error(`rollback qa-serve exited early (${code})`)));
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      out += chunk.toString();
      const index = out.indexOf("\n");
      if (index < 0) return;
      const line = out.slice(0, index).trim();
      try {
        const info = JSON.parse(line);
        settled = true;
        clearTimeout(timer);
        resolve({ child, url: info.url, port: info.port, dataDir: info.dataDir });
      } catch (error) {
        fail(error);
      }
    });
  });
}

async function stopBoard(board) {
  if (!board || board.child.exitCode !== null) return;
  const exited = new Promise((resolve) => board.child.once("exit", resolve));
  board.child.kill("SIGTERM");
  await Promise.race([exited, sleep(10_000)]);
  if (board.child.exitCode === null) {
    try {
      board.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function openAs(browser, base, token, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(
    ({ origin, accessToken }) => {
      try {
        localStorage.setItem("report.ep", origin);
        localStorage.setItem(`report.token.${origin}`, accessToken);
      } catch {
        // ignore
      }
      // 记录 hub 状态/原因迁移（reset 的 degraded 窗口很短，轮询会漏）。
      window.__hubStates = [];
      window.__hubReasons = [];
      const record = () => {
        const el = document.querySelector('[data-testid="hub-live-state"]');
        if (!el) return;
        const state = el.getAttribute("data-state");
        const reason = el.getAttribute("data-reason") ?? "";
        if (state && window.__hubStates[window.__hubStates.length - 1] !== state) {
          window.__hubStates.push(state);
        }
        const key = `${state ?? ""}:${reason}`;
        if (window.__hubReasons[window.__hubReasons.length - 1] !== key) {
          window.__hubReasons.push(key);
        }
      };
      const install = () => {
        record();
        try {
          new MutationObserver(record).observe(document.documentElement, {
            subtree: true,
            attributes: true,
            attributeFilter: ["data-state"],
            childList: true,
          });
        } catch {
          // documentElement 尚未就绪时退化到下面的轮询
        }
        setInterval(record, 100);
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", install, { once: true });
      } else {
        install();
      }
    },
    { origin: base, accessToken: token },
  );
  const page = await context.newPage();
  const errors = [];
  const streams = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/stream") streams.push(url.search);
  });
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text().slice(0, 200);
    // 断网实验期间浏览器必然记录网络失败，不是页面运行时错误。
    if (/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(text)) return;
    errors.push(text);
  });
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="timeline-scroll"]', {
    timeout: 15_000,
  });
  await page.waitForTimeout(900);
  return { context, page, errors, streams };
}

const marker = (tag) => `[E2E-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}]`;

async function ownerBadge(page) {
  // 用 DOM 读取（not locator）：角标在归零瞬间会卸载，locator.innerText 会等 30s。
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="notifications-unread-badge"]');
    if (!el) return 0;
    const value = Number((el.textContent ?? "").trim());
    return Number.isFinite(value) ? value : 0;
  });
}

async function postRoot(base, token, body, tags = []) {
  const result = await apiJson(base, "/api/posts", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, quote: null, media: [], tags }),
  });
  return result.posts[0];
}

async function replyTo(base, token, parentId, body) {
  const result = await apiJson(base, `/api/posts/${parentId}/replies`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, media: [], tags: [] }),
  });
  return result.posts[0];
}

async function deletePost(base, token, postId) {
  await apiJson(base, `/api/posts/${postId}`, token, { method: "DELETE" });
}

async function cursorOf(base, token) {
  const result = await apiJson(base, "/api/cursor", token);
  return result.cursor;
}

async function hubStateNow(page) {
  return page.evaluate(
    () =>
      document.querySelector('[data-testid="hub-live-state"]')?.getAttribute("data-state") ?? null,
  );
}

/** 伪造标签页可见性（Chromium headless 下 document.visibilityState 是只读 getter）。 */
async function setPageVisibility(page, value) {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => next,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
}


const qa = await ensureQa(process.argv.slice(2));
const BASE = qa.base;
assertIsolatedDataDir(qa.dataDir);
const ownerToken = accountToken(qa.dataDir, "owner");
const managerToken = accountToken(qa.dataDir, "manager");
const backendToken = accountToken(qa.dataDir, "sub-backend");
const frontendToken = accountToken(qa.dataDir, "sub-frontend");

let browser = null;
let qaReset = null;
/** 手动拉起的板子（rollback / switch）在异常时也必须回收。 */
let rbBoard = null;
let rbDir = null;
let rbSnap = null;
let switchBoard = null;
try {
  browser = await chromium.launch({ channel: "chrome" });

  // ── 1) feed 实时 ────────────────────────────────────────────────────────────
  const owner = await openAs(browser, BASE, ownerToken);
  const ownerPage = owner.page;
  await ownerPage.waitForSelector('[data-testid="post-card"]', { timeout: 15_000 });

  const feedMarker = marker("FEED");
  const feedStarted = Date.now();
  await postRoot(BASE, managerToken, `${feedMarker} 成果：EventHub 推荐流实时验收`, ["result"]);
  const feedDelay = await waitUntil(
    () => ownerPage.evaluate((text) => document.body.innerText.includes(text), feedMarker),
    5_000,
  );
  check("推荐流：新 result 帖无刷新进入 DOM ≤2s", feedDelay <= 2_000, `${feedDelay}ms`);
  await ownerPage.screenshot({ path: join(SHOTS, "01-feed-live-desktop.png") });

  await ownerPage.click('[data-testid="home-tab-following"]');
  await ownerPage.waitForTimeout(600);
  const followingMarker = marker("FOLLOW");
  await postRoot(BASE, managerToken, `${followingMarker} 备注：关注流实时验收`, ["note"]);
  const followingDelay = await waitUntil(
    () => ownerPage.evaluate((text) => document.body.innerText.includes(text), followingMarker),
    5_000,
  );
  check("关注流：所关注成员新帖无刷新进入 DOM ≤2s", followingDelay <= 2_000, `${followingDelay}ms`);
  await ownerPage.click('[data-testid="home-tab-recommended"]');
  await ownerPage.waitForTimeout(400);
  console.log(`feed timings: recommended=${Date.now() - feedStarted}ms`);

  // 成员页：共享单流（不新开 author 第二条流）
  const streamsBeforeMember = owner.streams.length;
  await ownerPage.evaluate(() => {
    location.hash = "#/u/manager";
  });
  await ownerPage.waitForSelector('[data-testid="profile-card"]', { timeout: 10_000 });
  await ownerPage.waitForTimeout(2_500);
  check(
    "成员页：只有 1 条共享 /api/stream（无 author 第二条流）",
    owner.streams.length === streamsBeforeMember &&
      streamsBeforeMember === 1 &&
      !owner.streams.some((query) => query.includes("author=")),
    `streams=${owner.streams.length} ${owner.streams.join(" | ")}`,
  );
  await ownerPage.evaluate(() => {
    location.hash = "#/";
  });
  await ownerPage.waitForTimeout(800);

  // ── 2) 线程实时 + 删除 ──────────────────────────────────────────────────────
  const managerRead = await apiJson(BASE, "/api/read?author=manager&limit=50", managerToken);
  const threadRoot = (managerRead.posts ?? []).find((post) => post.parent_id === null && !post.deleted_at);
  if (!threadRoot) throw new Error("no manager root to open");
  await ownerPage.evaluate((id) => {
    location.hash = `#/p/${id}`;
  }, threadRoot.id);
  await ownerPage.waitForSelector('[data-testid="thread-timeline"]', { timeout: 10_000 });
  await ownerPage.waitForTimeout(500);

  const replyMarker = marker("REPLY");
  const reply = await replyTo(BASE, managerToken, threadRoot.id, `${replyMarker} 线程实时回复`);
  // report-thread-live-append：新回复零点击直接追进 DOM（不再需要点胶囊合并）。
  const appendDelay = await waitUntil(
    () => ownerPage.evaluate((text) => document.body.innerText.includes(text), replyMarker),
    5_000,
  );
  check("线程：他人回复 ≤2s 零点击直接进 DOM", appendDelay <= 2_000, `${appendDelay}ms`);
  await ownerPage.screenshot({ path: join(SHOTS, "02-thread-live-append-desktop.png") });
  await ownerPage.waitForTimeout(400);
  const replyVisible = await ownerPage.evaluate(
    (text) => document.body.innerText.includes(text),
    replyMarker,
  );
  check("线程：回复内容可见（无需点击任何提示）", replyVisible);

  await deletePost(BASE, managerToken, reply.id);
  const replyGoneDelay = await waitUntil(
    async () =>
      !(await ownerPage.evaluate((text) => document.body.innerText.includes(text), replyMarker)),
    5_000,
  );
  check("线程：post.deleted 后回复 ≤2s 消失", replyGoneDelay <= 2_000, `${replyGoneDelay}ms`);

  // 根帖删除 → 主页列表移除
  await ownerPage.evaluate(() => {
    location.hash = "#/";
  });
  await ownerPage.waitForTimeout(800);
  await deletePost(BASE, managerToken, threadRoot.id);
  const rootGoneDelay = await waitUntil(
    async () =>
      !(await ownerPage.evaluate((text) => document.body.innerText.includes(text), threadRoot.body_md.slice(0, 24))),
    5_000,
  );
  check("主页：被删根帖 ≤2s 从列表移除", rootGoneDelay <= 2_000, `${rootGoneDelay}ms`);

  // ── 3) 通知角标 + read-set + ack ───────────────────────────────────────────
  await ownerPage.evaluate(() => {
    location.hash = "#/notifications";
  });
  await ownerPage.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 10_000 });
  await ownerPage.waitForTimeout(1_200);
  const badgeBefore = await ownerBadge(ownerPage);
  const cursorBefore = await cursorOf(BASE, ownerToken);

  const notifMarker = marker("NOTIF");
  const notifPost = await postRoot(BASE, managerToken, `@owner ${notifMarker} 角标验收`, ["note"]);
  const badgeDelay = await waitUntil(async () => (await ownerBadge(ownerPage)) === badgeBefore + 1, 5_000);
  check("角标：@owner 帖按帖 +1（≤2s）", badgeDelay <= 2_000, `${badgeBefore} → ${badgeBefore + 1}（${badgeDelay}ms）`);
  const rowSelector = `[data-testid="notification-row"][data-post-id="${notifPost.id}"]`;
  const rowDelay = await waitUntil(
    () => ownerPage.locator(rowSelector).count().then((n) => n > 0),
    5_000,
  );
  check("通知页停留：新提醒无刷新进入列表", rowDelay <= 2_000, `${rowDelay}ms`);
  await ownerPage.screenshot({ path: join(SHOTS, "03-notifications-badge-desktop.png") });

  await ownerPage.click(rowSelector);
  await ownerPage.waitForTimeout(1_200);
  const inDetail = (await ownerPage.evaluate(() => location.hash)).includes(notifPost.id);
  await ownerPage.evaluate(() => {
    location.hash = "#/notifications";
  });
  await ownerPage.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 10_000 });
  await ownerPage.waitForTimeout(1_000);
  const badgeAfterRead = await ownerBadge(ownerPage);
  const cursorAfterRead = await cursorOf(BASE, ownerToken);
  check("打开详情：read-set 生效、角标 -1", badgeAfterRead === badgeBefore, `${badgeBefore + 1} → ${badgeAfterRead}`);
  check("单帖已读不推进服务端游标", cursorAfterRead === cursorBefore, `cursor ${cursorBefore} → ${cursorAfterRead}`);
  check("通知行已标记已读", inDetail && (await ownerPage.getAttribute(rowSelector, "data-read")) === "1");

  // 重载后 hash 仍是 #/notifications：直接等通知页重新挂载。
  await ownerPage.reload({ waitUntil: "domcontentloaded" });
  await ownerPage.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 15_000 });
  await ownerPage.waitForTimeout(1_200);
  const badgeAfterReload = await ownerBadge(ownerPage);
  const readAfterReload = await ownerPage.getAttribute(rowSelector, "data-read");
  check("reload 后 read-set 仍生效（历史仍在且该行已读）", badgeAfterReload === badgeBefore && readAfterReload === "1", `badge=${badgeAfterReload}`);

  await ownerPage.click('[data-testid="ack-notifications"]');
  const ackDelay = await waitUntil(async () => (await ownerBadge(ownerPage)) === 0, 5_000);
  const cursorAfterAck = await cursorOf(BASE, ownerToken);
  check("全部已读：角标归零", ackDelay <= 2_000, `${ackDelay}ms`);
  check("全部已读：服务端游标推进", cursorAfterAck > cursorBefore, `cursor ${cursorBefore} → ${cursorAfterAck}`);

  // ── 4) 断线补拉 ────────────────────────────────────────────────────────────
  await ownerPage.evaluate(() => {
    location.hash = "#/";
  });
  await ownerPage.waitForTimeout(1_000);
  await owner.context.setOffline(true);
  await ownerPage.waitForTimeout(600);
  const offlineMarkers = [marker("OFF1"), marker("OFF2"), marker("OFF3")];
  for (const text of offlineMarkers) {
    await postRoot(BASE, managerToken, `${text} 断线补拉验收`, ["result"]);
  }
  await ownerPage.waitForTimeout(5_000);
  const offlineVisible = await Promise.all(
    offlineMarkers.map((text) => ownerPage.evaluate((t) => document.body.innerText.includes(t), text)),
  );
  check("离线期间不出现新帖（前提）", offlineVisible.every((value) => !value));
  await owner.context.setOffline(false);
  const recoverStarted = Date.now();
  const recoverDelay = await waitUntil(async () => {
    const counts = await Promise.all(
      offlineMarkers.map((text) =>
        ownerPage.evaluate(
          (value) => document.body.innerText.split(value).length - 1,
          text,
        ),
      ),
    );
    return counts.every((count) => count === 1);
  }, 15_000);
  check("恢复在线：3 条各恰好一次（≤10s）", recoverDelay <= 10_000, `${recoverDelay}ms（总 ${Date.now() - recoverStarted}ms）`);
  await ownerPage.screenshot({ path: join(SHOTS, "04-reconnect-restored-desktop.png") });

  // ── 5) 可见性隔离（agent B 不收到 agent C 私域事件）────────────────────────
  const agentB = await openAs(browser, BASE, backendToken);
  const agentC = await openAs(browser, BASE, frontendToken);
  const privateMarker = marker("PRIVATE");

  const streamTicket = await apiJson(BASE, "/api/stream/ticket", backendToken, { method: "POST" });
  const streamAbort = new AbortController();
  const bStream = await fetch(
    `${BASE}/api/stream?hub=2&ticket=${encodeURIComponent(streamTicket.ticket)}&since=0`,
    { signal: streamAbort.signal },
  );
  const reader = bStream.body.getReader();
  const decoder = new TextDecoder();
  let bBytes = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bBytes += decoder.decode(value, { stream: true });
      }
    } catch {
      // aborted
    }
  })();

  const privatePost = await postRoot(BASE, frontendToken, `${privateMarker} 私域事件隔离验收`, ["note"]);
  await sleep(2_500);
  streamAbort.abort();
  await pump;
  const leaked = bBytes.includes(privatePost.id);
  const domLeak = await agentB.page.evaluate((text) => document.body.innerText.includes(text), privateMarker);
  check("可见性：agent B 的 SSE 字节流不含 C 私域帖", !leaked, `frames=${(bBytes.match(/^data: /gm) ?? []).length}`);
  check("可见性：agent B 的 DOM 不含 C 私域帖", !domLeak);

  const cTicket = await apiJson(BASE, "/api/stream/ticket", frontendToken, { method: "POST" });
  const cAbort = new AbortController();
  const cStream = await fetch(
    `${BASE}/api/stream?hub=2&ticket=${encodeURIComponent(cTicket.ticket)}&since=0`,
    { signal: cAbort.signal },
  );
  const cReader = cStream.body.getReader();
  let cBytes = "";
  try {
    for (let i = 0; i < 6; i += 1) {
      const { value } = await cReader.read();
      if (value) cBytes += new TextDecoder().decode(value, { stream: true });
      if (cBytes.includes(privatePost.id)) break;
    }
  } finally {
    cAbort.abort();
  }
  check("可见性对照组：C 自己的流含该事件（证明事件存在）", cBytes.includes(privatePost.id));
  await agentB.context.close();
  await agentC.context.close();

  // ── 6) 空闲 60s 零业务请求 + 4 标签页 REST ────────────────────────────────
  const extraPages = [];
  for (let i = 0; i < 3; i += 1) {
    const extra = await openAs(browser, BASE, ownerToken, { width: 1024, height: 800 });
    extraPages.push(extra);
  }
  const tracked = [owner, ...extraPages];
  const requests = [];
  for (const entry of tracked) {
    entry.page.on("request", (request) => {
      const url = new URL(request.url());
      requests.push({ page: tracked.indexOf(entry), path: url.pathname, at: Date.now() });
    });
  }
  await sleep(1_500);
  requests.length = 0;
  const idleStarted = Date.now();
  await sleep(60_000);
  const idleElapsed = Date.now() - idleStarted;
  const business = requests.filter(
    (row) => !["/api/who", "/api/accounts", "/api/stream", "/healthz"].includes(row.path),
  );
  check(
    "空闲 60s：除 presence（who/accounts）外零业务请求",
    business.length === 0,
    `window=${idleElapsed}ms requests=${requests.length} business=${business.length}` +
      (business.length
        ? ` (${business.map((row) => `p${row.page}:${row.path}`).join(",")})`
        : ""),
  );
  const restMs = await ownerPage.evaluate(async (token) => {
    const started = performance.now();
    const res = await fetch("/api/feed?tab=recommended&limit=5", {
      headers: { authorization: `Bearer ${token}` },
    });
    await res.json();
    return performance.now() - started;
  }, ownerToken);
  check("4 标签页（4 条 SSE）下 REST 仍 <1s", restMs < 1_000, `${restMs.toFixed(0)}ms`);
  for (const extra of extraPages) await extra.context.close();

  // ── 7) reset（REPLAY_LIMIT=2）──────────────────────────────────────────────
  process.env.STOA_HUB_REPLAY_LIMIT = "2";
  qaReset = await ensureQa([]);
  delete process.env.STOA_HUB_REPLAY_LIMIT;
  const resetToken = accountToken(qaReset.dataDir, "owner");
  const resetManager = accountToken(qaReset.dataDir, "manager");
  const resetClient = await openAs(browser, qaReset.base, resetToken);
  await resetClient.page.waitForSelector('[data-testid="post-card"]', { timeout: 15_000 });

  await resetClient.context.setOffline(true);
  await sleep(600);
  const resetMarkers = [1, 2, 3, 4, 5].map((index) => marker(`RST${index}`));
  for (const text of resetMarkers) {
    await postRoot(qaReset.base, resetManager, `${text} reset 验收`, ["result"]);
  }
  await sleep(1_200);
  await resetClient.context.setOffline(false);
  const resetVisible = await waitUntil(async () => {
    const counts = await Promise.all(
      resetMarkers.map((text) =>
        resetClient.page.evaluate(
          (value) => document.body.innerText.split(value).length - 1,
          text,
        ),
      ),
    );
    return counts.every((count) => count === 1);
  }, 20_000);
  // REST 重取要等视图 reload 完成才回 live；先等落定再读状态迁移史。
  await waitUntil(async () => (await hubStateNow(resetClient.page)) === "live", 5_000).catch(
    () => {},
  );
  const hubStates = await resetClient.page.evaluate(() => window.__hubStates ?? []);
  check("reset：重连后 REST 重取补齐 5 条且各一次", resetVisible <= 15_000, `${resetVisible}ms`);
  check(
    "reset：客户端进入 degraded（轮询兜底）再回 live",
    hubStates.includes("degraded") && hubStates[hubStates.length - 1] === "live",
    hubStates.join(" → "),
  );
  await resetClient.page.screenshot({ path: join(SHOTS, "06-reset-restored-desktop.png") });

  // ── 8) post.deleted 不进通知列表（客户端回归）──────────────────────────────
  await resetClient.page.evaluate(() => {
    location.hash = "#/notifications";
  });
  await resetClient.page.waitForSelector('[data-testid="notifications-scroll"]', { timeout: 10_000 });
  await resetClient.page.waitForTimeout(1_000);
  const badgeBeforeDelete = await ownerBadge(resetClient.page);
  const deletedTarget = await postRoot(qaReset.base, resetManager, `@owner ${marker("DELNOTIF")} 删除事件回归`, ["note"]);
  await resetClient.page.waitForTimeout(1_800);
  const rowBeforeDelete = await resetClient.page.locator(
    `[data-testid="notification-row"][data-post-id="${deletedTarget.id}"]`,
  ).count();
  const badgeAfterCreate = await ownerBadge(resetClient.page);
  await deletePost(qaReset.base, resetManager, deletedTarget.id);
  await resetClient.page.waitForTimeout(1_800);
  const deletedRow = await resetClient.page.locator(
    `[data-testid="notification-deleted-row"][data-post-id="${deletedTarget.id}"]`,
  ).count();
  const stillCredited = await resetClient.page.locator(
    `[data-testid="notification-row"][data-post-id="${deletedTarget.id}"]`,
  ).count();
  const badgeAfterDelete = await ownerBadge(resetClient.page);
  check(
    "删除事件：提醒行转「已删除」而非新增提醒",
    rowBeforeDelete >= 1 && deletedRow >= 1 && stillCredited === 0,
    `rowBefore=${rowBeforeDelete} deletedRow=${deletedRow} stillCredited=${stillCredited}`,
  );
  check(
    "删除事件：不计未读（角标回到创建前）",
    badgeAfterCreate === badgeBeforeDelete + 1 && badgeAfterDelete === badgeBeforeDelete,
    `${badgeBeforeDelete} → ${badgeAfterCreate} → ${badgeAfterDelete}`,
  );

  // ── 截图：degraded 指示（移动 + 桌面，真实连续失败路径）────────────────────
  const mobile = await openAs(browser, qaReset.base, resetToken, {
    width: 390,
    height: 844,
  });
  await mobile.page.waitForTimeout(800);
  await mobile.context.setOffline(true);
  await resetClient.context.setOffline(true);
  const isDegradedNow = async (page) => (await hubStateNow(page)) === "degraded";
  let mobileDegraded = false;
  try {
    await waitUntil(() => isDegradedNow(mobile.page), 45_000, 500);
    mobileDegraded = true;
  } catch {
    mobileDegraded = false;
  }
  let desktopDegraded = false;
  try {
    await waitUntil(() => isDegradedNow(resetClient.page), 45_000, 500);
    desktopDegraded = true;
  } catch {
    desktopDegraded = false;
  }
  check("降级可观测：移动端连续失败后进入 degraded（轮询兜底）", mobileDegraded);
  check("降级可观测：桌面端连续失败后进入 degraded（轮询兜底）", desktopDegraded);
  await resetClient.page.screenshot({ path: join(SHOTS, "05-degraded-desktop.png") });
  await mobile.page.click('[data-testid="home-info-button"]');
  await mobile.page.waitForTimeout(600);
  await mobile.page.screenshot({ path: join(SHOTS, "05-degraded-mobile-390.png") });

  // degraded 兜底轮询（review B4）：60s 内至少一次业务请求；恢复 live 后停止。
  const businessPath = (raw) => {
    const path = new URL(raw).pathname;
    return !["/api/who", "/api/accounts", "/healthz", "/api/stream"].includes(path);
  };
  const pollLog = new Map([
    [mobile.page, []],
    [resetClient.page, []],
  ]);
  for (const [page, log] of pollLog) {
    page.on("request", (request) => {
      if (businessPath(request.url())) log.push(new URL(request.url()).pathname);
    });
  }
  await sleep(62_000);
  const mobileBiz = [...new Set(pollLog.get(mobile.page))];
  const desktopBiz = [...new Set(pollLog.get(resetClient.page))];
  check(
    "degraded 兜底轮询：home 活跃视图 60s 内触发 feed 补拉",
    mobileBiz.includes("/api/feed"),
    mobileBiz.join(",") || "(none)",
  );
  check(
    "degraded 兜底轮询：通知投影 60s 内对账",
    desktopBiz.includes("/api/notifications"),
    desktopBiz.join(",") || "(none)",
  );
  // visible 门（design §4.2）：hidden 65s 不发轮询（重连 ticket 不算轮询），
  // 恢复 visible 后立即补一次（hub 活跃视图 + 通知对账）。
  const pollOnly = (log) =>
    log.filter((path) => path === "/api/feed" || path === "/api/notifications").length;
  await setPageVisibility(mobile.page, "hidden");
  await setPageVisibility(resetClient.page, "hidden");
  const hiddenBaseMobile = pollOnly(pollLog.get(mobile.page));
  const hiddenBaseDesktop = pollOnly(pollLog.get(resetClient.page));
  await sleep(65_000);
  const hiddenAfterMobile = pollOnly(pollLog.get(mobile.page));
  const hiddenAfterDesktop = pollOnly(pollLog.get(resetClient.page));
  check(
    "degraded 兜底轮询：hidden 65s 无轮询请求（ticket 重连除外）",
    hiddenAfterMobile === hiddenBaseMobile && hiddenAfterDesktop === hiddenBaseDesktop,
    `mobile ${hiddenBaseMobile}→${hiddenAfterMobile}, desktop ${hiddenBaseDesktop}→${hiddenAfterDesktop}`,
  );
  await setPageVisibility(mobile.page, "visible");
  await setPageVisibility(resetClient.page, "visible");
  await sleep(3_500);
  const visibleAfterMobile = pollOnly(pollLog.get(mobile.page));
  const visibleAfterDesktop = pollOnly(pollLog.get(resetClient.page));
  check(
    "degraded 兜底轮询：visible 恢复后立即补一次",
    visibleAfterMobile > hiddenAfterMobile && visibleAfterDesktop > hiddenAfterDesktop,
    `mobile ${hiddenAfterMobile}→${visibleAfterMobile}, desktop ${hiddenAfterDesktop}→${visibleAfterDesktop}`,
  );

  await mobile.context.setOffline(false);
  await resetClient.context.setOffline(false);
  await waitUntil(async () => (await hubStateNow(mobile.page)) === "live", 30_000, 250).catch(() => {});
  await waitUntil(async () => (await hubStateNow(resetClient.page)) === "live", 30_000, 250).catch(() => {});
  await sleep(4_000); // 让 reconnect 的 catch-up 落地
  const mobileCount = pollLog.get(mobile.page).length;
  const desktopCount = pollLog.get(resetClient.page).length;
  await sleep(65_000);
  check(
    "恢复 live 后兜底轮询停止（65s 内无新增业务请求）",
    pollLog.get(mobile.page).length === mobileCount &&
      pollLog.get(resetClient.page).length === desktopCount,
    `mobile ${mobileCount}→${pollLog.get(mobile.page).length}, desktop ${desktopCount}→${pollLog.get(resetClient.page).length}`,
  );
  await mobile.context.close();

  // ── 8b) R5 rollback：恢复低水位库后新帖仍实时可见（review B1/B2）─────────
  rbDir = `/tmp/report-qa-rollback-${process.pid}`;
  rbSnap = `${rbDir}-snap`;
  rmSync(rbDir, { recursive: true, force: true });
  rmSync(rbSnap, { recursive: true, force: true });
  rbBoard = null;
  for (const port of [13688, 13685, 13684, 13683]) {
    // qa-serve 先 init 再校验显式端口：端口被占时会把数据目录留成「已 init 未 seed」，
    // 下一次换端口会 created=false 跳过 seed。每次尝试前清目录，保证候选端口失败不污染。
    rmSync(rbDir, { recursive: true, force: true });
    try {
      rbBoard = await startBoard(rbDir, port);
      break;
    } catch {
      rbBoard = null;
    }
  }
  if (!rbBoard) throw new Error("could not start rollback board");
  const rbPort = rbBoard.port;
  const rbOwner = accountToken(rbDir, "owner");
  const rbManager = accountToken(rbDir, "manager");
  await stopBoard(rbBoard);
  cpSync(rbDir, rbSnap, { recursive: true });
  rbBoard = await startBoard(rbDir, rbPort);
  const rbClient = await openAs(browser, rbBoard.url, rbOwner);
  await rbClient.page.waitForSelector('[data-testid="post-card"]', { timeout: 15_000 });
  for (let index = 0; index < 8; index += 1) {
    await postRoot(rbBoard.url, rbManager, `${marker("RBPRE")} 提升水位 ${index}`, ["result"]);
  }
  await rbClient.page.waitForTimeout(2_000);
  // 回滚前水位用**服务端** as_of：DOM 的 data-last-seq 是状态迁移快照（数据帧不触发
  // status 重发），不能当作实时流位置。
  const beforeFeed = await apiJson(rbBoard.url, "/api/feed?tab=recommended&limit=1", rbOwner);
  const rbBeforeSeq = Number(beforeFeed.as_of_seq ?? 0);
  await stopBoard(rbBoard);
  rmSync(rbDir, { recursive: true, force: true });
  cpSync(rbSnap, rbDir, { recursive: true });
  rbBoard = await startBoard(rbDir, rbPort);
  await waitUntil(async () => (await hubStateNow(rbClient.page)) !== "live", 15_000, 100).catch(() => {});
  const rbLive = await waitUntil(
    async () => (await hubStateNow(rbClient.page)) === "live",
    25_000,
    250,
  ).catch(() => -1);
  const rbReasons = await rbClient.page.evaluate(() => window.__hubReasons ?? []);
  check("R5 rollback：状态历史含 degraded:catching_up", rbReasons.includes("degraded:catching_up"), rbReasons.join(" → "));
  const rbSeq = await rbClient.page.evaluate(() => {
    const el = document.querySelector('[data-testid="hub-live-state"]');
    return {
      state: el?.getAttribute("data-state"),
      last: el?.getAttribute("data-last-seq"),
      resume: el?.getAttribute("data-resume-seq"),
    };
  });
  const restoredFeed = await apiJson(rbBoard.url, "/api/feed?tab=recommended&limit=1", rbOwner);
  const restoredAsOf = Number(restoredFeed.as_of_seq ?? 0);
  check(
    "R5 rollback：lastSeq/resumeSeq 同步到恢复库 as_of 且低于回滚前水位",
    Number(rbSeq.last) === restoredAsOf &&
      rbSeq.last === rbSeq.resume &&
      Number(rbSeq.last) < rbBeforeSeq,
    `before(server)=${rbBeforeSeq} after=${rbSeq.last}/${rbSeq.resume} restoredAsOf=${restoredAsOf}`,
  );
  const postRollbackMarker = marker("RBAFTER");
  await postRoot(rbBoard.url, rbManager, `${postRollbackMarker} 恢复后新帖`, ["result"]);
  const postRollbackDelay = await waitUntil(
    () => rbClient.page.evaluate((text) => document.body.innerText.includes(text), postRollbackMarker),
    5_000,
  );
  check("R5 rollback：恢复低水位库后新帖 ≤2s 可见", postRollbackDelay <= 2_000, `${postRollbackDelay}ms（live ${rbLive}ms）`);
  await rbClient.page.screenshot({ path: join(SHOTS, "07-rollback-restored-desktop.png") });
  await rbClient.context.close();
  await stopBoard(rbBoard);
  rmSync(rbDir, { recursive: true, force: true });
  rmSync(rbSnap, { recursive: true, force: true });

  // ── 9) 切换实例：实体缓存不跨实例（review 安全项）────────────────────────
  switchBoard = await ensureQa([]);
  const switchOwner = accountToken(switchBoard.dataDir, "owner");
  const switchShell = await openAs(browser, BASE, ownerToken);
  await switchShell.page.waitForSelector('[data-testid="post-card"]', { timeout: 15_000 });
  const cacheMarker = marker("CACHE");
  await postRoot(BASE, managerToken, `${cacheMarker} 切换实例缓存验收`, ["result"]);
  await waitUntil(
    () => switchShell.page.evaluate((text) => document.body.innerText.includes(text), cacheMarker),
    5_000,
  );
  await switchShell.page.evaluate(
    ({ url, token }) => localStorage.setItem(`report.token.${url}`, token),
    { url: switchBoard.base, token: switchOwner },
  );
  await switchShell.page.click('[data-testid="switch-backend"]');
  await switchShell.page.waitForSelector('[data-testid="ep-input"]', { timeout: 10_000 });
  await switchShell.page.fill('[data-testid="ep-input"]', switchBoard.base);
  await switchShell.page.click('[data-testid="ep-connect"]');
  await switchShell.page.waitForSelector('[data-testid="ep-input"]', { state: "detached", timeout: 20_000 });
  await switchShell.page.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 20_000 });
  let cacheLeak = false;
  const leakStart = Date.now();
  while (Date.now() - leakStart < 2_000) {
    if (await switchShell.page.evaluate((text) => document.body.innerText.includes(text), cacheMarker)) {
      cacheLeak = true;
      break;
    }
    await sleep(20);
  }
  check("切换实例：feed 首帧/加载中不含旧实例帖子", !cacheLeak);
  await switchShell.page.waitForSelector('[data-testid="post-card"]', { timeout: 15_000 });
  check(
    "切换实例后新 feed 正常渲染",
    (await switchShell.page.locator('[data-testid="post-card"]').count()) > 0,
  );
  await switchShell.context.close();
  await switchBoard.stop();

  check("无页面运行时错误（owner）", owner.errors.length === 0, owner.errors.slice(0, 2).join(" | "));
  check("无页面运行时错误（reset 板）", resetClient.errors.length === 0, resetClient.errors.slice(0, 2).join(" | "));

  await owner.context.close();
  await resetClient.context.close();
} finally {
  if (browser) await browser.close();
  await qa.stop();
  if (qaReset) await qaReset.stop();
  await stopBoard(rbBoard);
  if (switchBoard) await switchBoard.stop();
  if (rbDir) rmSync(rbDir, { recursive: true, force: true });
  if (rbSnap) rmSync(rbSnap, { recursive: true, force: true });
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots: ${SHOTS}`);
process.exitCode = failed.length ? 1 : 0;

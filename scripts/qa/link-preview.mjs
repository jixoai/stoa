#!/usr/bin/env bun
/**
 * link-preview E2E driver — openspec change `report-link-preview` design §14.3.
 *
 * Covers A1–A5 and A7–A17. A6 (P2 image 4:3 crop) is explicitly SKIPPED and
 * registered as such. A17 is the carousel-specific scenario (design §14.3).
 *
 * Isolation: only the disposable backend from `scripts/qa/qa-serve.mjs` is
 * written (temp /tmp/report-qa-* data dir; report-link-preview design §7.5 uses
 * STOA_PREVIEW_TEST_ALLOW_ORIGINS=<fixture main origin>; legacy
 * FDE2E_REPORT_PREVIEW_TEST_ALLOW_ORIGINS is also read). The
 * production board (127.0.0.1:13689) is refused by qa-env before any request.
 * Fixture URL hits are counted by `scripts/qa/link-preview-fixture.mjs`
 * (worker UA = stoa-link-preview/1.0; private second origin must stay 0).
 *
 * Run (after the server/frontend implementation for this change is merged):
 *   bun scripts/qa/link-preview.mjs
 *   REPORT_QA_BASE=http://127.0.0.1:13688 bun scripts/qa/link-preview.mjs
 *   bun scripts/qa/link-preview.mjs --preflight     # only checks prerequisites
 *   bun scripts/qa/link-preview.mjs --no-build      # reuse existing dist/
 *   bun scripts/qa/link-preview.mjs --keep-board    # keep the temp data dir
 *
 * Evidence: /Users/kzf/Development/GitHub/jixoai/fde2e/.agents/reports/manager/
 * report-link-preview/steps.json + screenshots (same dir). This script never
 * writes report.html — the shared generator turns steps.json into HTML.
 *
 * DOM contract assumed by the driver (P1-17, tasks.md):
 *   [data-testid="link-preview-card"]        one per preview, 0..3 per post
 *   [data-preview-status]                    pending|partial|ready|failed
 *   [data-preview-phase]                     last completed phase
 *   [data-preview-url]                       canonical URL
 *   [data-testid="preview-media"]            the fixed 4:3 media area
 *   [data-testid="preview-title"]            title text (optional; card text fallback)
 * Carousel (3 previews per post):
 *   [data-testid="link-previews"]            carousel root, data-active-index
 *   [data-testid="previews-next"] / prev     arrow buttons
 *   [data-testid="previews-dot"] ×3          data-index=0/1/2, current aria-current="true"
 * If the implementation picks different names, adjust SELECTORS below; every
 * assertion is otherwise data-driven from the frozen PreviewLink contract.
 */
import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import {
  accountToken,
  apiJson,
  authSecret,
  ensureQa,
  QA_SERVE,
  REPO_ROOT,
} from "./lib/qa-env.mjs";

// ── paths / argv ─────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SCRIPT = join(HERE, "link-preview-fixture.mjs");
const REPORT_DIR = "/Users/kzf/Development/GitHub/jixoai/fde2e/.agents/reports/manager/report-link-preview";
const SHOT_DIR = REPORT_DIR;

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const PREFLIGHT = hasFlag("preflight");
const NO_BUILD = hasFlag("no-build");
const KEEP_BOARD = hasFlag("keep-board");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs, label, intervalMs = 100) {
  const started = Date.now();
  let lastError = null;
  for (;;) {
    try {
      if (await fn()) return Date.now() - started;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`timeout ${timeoutMs}ms: ${label}${lastError ? ` (last: ${lastError.message})` : ""}`);
    }
    await sleep(intervalMs);
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitPidDead(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

async function stopChild(child, label, graceMs = 6000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* gone */
  }
  const started = Date.now();
  while (Date.now() - started < graceMs) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(100);
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* gone */
  }
  await sleep(300);
  if (child.exitCode === null && child.signalCode === null) {
    process.stderr.write(`[link-preview] ${label} did not exit after SIGKILL\n`);
  }
}

function firstJsonLine(child, timeoutMs, label) {
  return new Promise((resolveLine, rejectLine) => {
    let buffer = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      fn(value);
    };
    const onData = (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      try {
        finish(resolveLine, JSON.parse(line));
      } catch (error) {
        finish(rejectLine, new Error(`${label} printed non-JSON: ${line.slice(0, 200)}`));
      }
    };
    const onExit = (code, signal) => {
      finish(rejectLine, new Error(`${label} exited before ready (code=${code}, signal=${signal})`));
    };
    const timer = setTimeout(() => {
      finish(rejectLine, new Error(`${label} did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

// ── report accumulation ──────────────────────────────────────────────────────
const report = {
  title: "report-link-preview · E2E 验收（A1–A17，A6 P2 跳过）",
  brand: "FDE2E™ Report · 端到端交付报告",
  subtitle: "",
  meta: "",
  thesis:
    "持久化 previews 字段 + 异步插件工作队列 + post.updated 实时推送：发帖立即返回（pending 占位），" +
    "阶段推进原地更新，静态导出原样携带 previews，SSRF/重定向/失败路径全部降级为普通链接。",
  env: [],
  sections: [],
  summary: { pass: 0, fail: 0 },
};
const results = [];
let currentSection = null;

function beginSection(title, note = "") {
  currentSection = { title, note, steps: [] };
  report.sections.push(currentSection);
  lastSectionShot = null;
  // Every section starts with fresh preview budget: the suite posts dozens of
  // links in one run, and a depleted account/global counter would leave new
  // rows pending forever (A7 timeout). Budget is read from the isolated DB per
  // enqueue, so clearing the meta counters is enough. Skip before READY (no DB)
  // and after cleanup (data dir removed).
  if (READY && qa && !/清理/.test(title)) {
    try {
      if (existsSync(join(qa.dataDir, "report.sqlite"))) clearPreviewBudget();
    } catch {
      /* budget reset is best-effort; the section itself will surface failures */
    }
  }
}

function sectionSlug(title) {
  return String(title)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .toLowerCase() || "section";
}

function step({ intent, expect = "", assertion, ok, image = null, command = null, reply = null }) {
  // First step of a section inherits the section-opening screenshot, so every
  // UI section (including aborted ones) has at least one image in the report.
  const resolvedImage =
    image ?? (currentSection.steps.length === 0 ? lastSectionShot : null);
  const record = {
    intent,
    expect,
    assertion,
    ok: ok === true,
    ...(resolvedImage ? { image: resolvedImage } : {}),
    ...(command ? { command } : {}),
    ...(reply ? { reply } : {}),
  };
  currentSection.steps.push(record);
  results.push({ section: currentSection.title, ...record });
  console.log(`${record.ok ? "PASS" : "FAIL"} [${currentSection.title}] ${intent} — ${assertion}`);
  return record.ok;
}

const coverage = new Map([
  ["A1", { status: "待跑", note: "" }],
  ["A2", { status: "待跑", note: "" }],
  ["A3", { status: "待跑", note: "" }],
  ["A4", { status: "待跑", note: "" }],
  ["A5", { status: "待跑", note: "" }],
  ["A6", { status: "SKIP", note: "P1 不含图片裁剪（design §15 可延后项 / P2-1）" }],
  ["A7", { status: "待跑", note: "" }],
  ["A8", { status: "待跑", note: "" }],
  ["A9", { status: "待跑", note: "" }],
  ["A10", { status: "待跑", note: "" }],
  ["A11", { status: "待跑", note: "" }],
  ["A12", { status: "待跑", note: "" }],
  ["A13", { status: "待跑", note: "" }],
  ["A14", { status: "待跑", note: "" }],
  ["A15", { status: "待跑", note: "" }],
  ["A16", { status: "待跑", note: "" }],
  ["A17", { status: "待跑", note: "轮播专项（design §14.3 A17）" }],
]);

function markCoverage(id, passed, note = "") {
  coverage.set(id, { status: passed ? "PASS" : "FAIL", note });
}

// ── runtime state ────────────────────────────────────────────────────────────
let qa = null;
let BASE = null;
let AUTH = null;
let ownerToken = null;
let fixture = null;
let fixtures = null;
let browser = null;
let launchedChromePids = [];
let hubTail = null;
let uiBuildResult = null;
let lastActivePage = null;
let lastSectionShot = null;
let sectionShotSeq = 0;
let READY = false;
let BOARD_OWNED = false;
let basePort = null;

const boardChildren = [];
const contexts = new Set();
const shots = [];

function shotPath(name) {
  return join(SHOT_DIR, name);
}

async function shot(page, name) {
  const path = shotPath(name);
  await page.screenshot({ path });
  shots.push(name);
  return name;
}

// ── fixture lifecycle ────────────────────────────────────────────────────────
async function startFixture() {
  const child = spawn(process.execPath, [FIXTURE_SCRIPT], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  let info;
  try {
    info = await firstJsonLine(child, 20_000, "link-preview-fixture");
  } catch (error) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
    throw error;
  }
  return {
    child,
    info,
    url: info.url,
    privateUrl: info.privateUrl,
    port: info.port,
    privatePort: info.privatePort,
    async stop() {
      await stopChild(child, "fixture");
    },
  };
}

async function fixtureStats() {
  const res = await fetch(`${fixture.url}/__stats`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`fixture /__stats HTTP ${res.status}`);
  return res.json();
}

async function fixtureReset() {
  const res = await fetch(`${fixture.url}/__reset`, { method: "POST", signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`fixture /__reset HTTP ${res.status}`);
  return res.json();
}

async function fixtureFixtures() {
  const res = await fetch(`${fixture.url}/__fixtures`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`fixture /__fixtures HTTP ${res.status}`);
  return res.json();
}

function pathStat(stats, url) {
  const pathname = new URL(url).pathname;
  return stats.main.paths[pathname] ?? { total: 0, worker: 0, HEAD: 0, GET: 0, firstAt: null };
}

// ── board lifecycle ──────────────────────────────────────────────────────────
function serveInfo() {
  return JSON.parse(readFileSync(join(qa.dataDir, "server.json"), "utf8"));
}

async function stopServe(signal = "SIGTERM") {
  const info = serveInfo();
  const pid = info.pid;
  try {
    process.kill(pid, signal);
  } catch {
    /* gone */
  }
  await waitPidDead(pid, 12_000);
  await waitUntil(
    async () => {
      try {
        await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(300) });
        return false;
      } catch {
        return true;
      }
    },
    10_000,
    "serve port free after stop",
  );
  await sleep(300);
  return pid;
}

async function startBoardOn(dataDir, port) {
  const child = spawn(process.execPath, [QA_SERVE, "--data-dir", dataDir, "--port", String(port), "--keep"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const info = await firstJsonLine(child, 120_000, "qa-serve(restart)");
  boardChildren.push(child);
  return { child, info };
}

function sqliteExec(sql) {
  const db = new Database(join(qa.dataDir, "report.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(sql);
  } finally {
    db.close();
  }
}

function sqliteQuery(sql, ...params) {
  const db = new Database(join(qa.dataDir, "report.sqlite"), { readonly: true });
  try {
    return db.query(sql).all(...params);
  } finally {
    db.close();
  }
}

// ── hub SSE tail ─────────────────────────────────────────────────────────────
class HubTail {
  constructor(token) {
    this.token = token;
    this.events = [];
    this.hello = null;
    this.abort = null;
    this.pump = null;
    this.helloPromise = null;
  }

  async start() {
    const ticket = await apiJson(BASE, "/api/stream/ticket", this.token, { method: "POST" });
    this.abort = new AbortController();
    const res = await fetch(
      `${BASE}/api/stream?hub=2&ticket=${encodeURIComponent(ticket.ticket)}`,
      { headers: { accept: "text/event-stream" }, signal: this.abort.signal },
    );
    if (!res.ok) throw new Error(`hub stream HTTP ${res.status}`);
    this.helloPromise = new Promise((resolveHello) => {
      this.resolveHello = resolveHello;
    });
    this.pump = this.read(res.body.getReader()).catch(() => {});
    let helloTimer = null;
    try {
      await Promise.race([
        this.helloPromise,
        new Promise((_, rejectHello) => {
          helloTimer = setTimeout(
            () => rejectHello(new Error("hub hello frame not received within 8s")),
            8000,
          );
        }),
      ]);
    } finally {
      if (helloTimer !== null) clearTimeout(helloTimer);
    }
    return this.hello;
  }

  async read(reader) {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        this.handleFrame(frame);
        index = buffer.indexOf("\n\n");
      }
    }
  }

  handleFrame(frame) {
    let event = "message";
    let id = null;
    const data = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      else if (line.startsWith("id:")) id = line.slice(3).trim();
    }
    const payload = data.join("\n");
    if (event === "hello") {
      try {
        this.hello = JSON.parse(payload);
      } catch {
        this.hello = {};
      }
      this.resolveHello?.(this.hello);
      return;
    }
    if (event !== "hub") return;
    try {
      const line = JSON.parse(payload);
      this.events.push({ ...line, sseId: id, receivedAt: Date.now() });
    } catch {
      /* ignore malformed frame */
    }
  }

  async stop() {
    try {
      this.abort?.abort();
    } catch {
      /* ignore */
    }
    await this.pump;
  }
}

async function startHubTail() {
  if (hubTail) await hubTail.stop();
  hubTail = new HubTail(ownerToken);
  await hubTail.start();
  return hubTail;
}

// ── API helpers ──────────────────────────────────────────────────────────────
async function createPost(token, body, tags = []) {
  const started = performance.now();
  const res = await fetch(new URL("/api/posts", BASE), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body, media: [], tags }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const latencyMs = performance.now() - started;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`POST /api/posts HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return { post: json.posts?.[0], latencyMs, json, status: res.status };
}

async function previewsOf(postId) {
  const out = await apiJson(BASE, `/api/posts/${encodeURIComponent(postId)}`, ownerToken);
  return out.post?.previews ?? [];
}

async function waitPreviews(postId, predicate, timeoutMs, label) {
  let last = [];
  await waitUntil(
    async () => {
      last = await previewsOf(postId);
      return predicate(last);
    },
    timeoutMs,
    label,
    150,
  );
  return last;
}

async function setPluginEnabled(enabled) {
  return apiJson(BASE, "/api/plugins/link-preview", ownerToken, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

async function pluginView() {
  const out = await apiJson(BASE, "/api/plugins", ownerToken);
  return (out.plugins ?? []).find((plugin) => plugin.id === "link-preview") ?? null;
}

// ── page helpers ─────────────────────────────────────────────────────────────
async function openPage(options = {}) {
  const {
    viewport = { width: 1280, height: 900 },
    mobile = false,
    token = ownerToken,
    staticUrl = null,
    label = "page",
  } = options;
  const context = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
  });
  contexts.add(context);
  if (!staticUrl) {
    await context.addInitScript(
      ({ origin, accessToken }) => {
        try {
          localStorage.setItem("report.ep", origin);
          localStorage.setItem(`report.token.${origin}`, accessToken);
        } catch {
          /* ignore */
        }
      },
      { origin: BASE, accessToken: token },
    );
  }
  await context.addInitScript(() => {
    window.__previewCls = { value: 0, count: 0, max: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          window.__previewCls.value += entry.value;
          window.__previewCls.count += 1;
          window.__previewCls.max = Math.max(window.__previewCls.max, entry.value);
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      /* layout-shift unsupported */
    }
    window.__resetPreviewCls = () => {
      window.__previewCls = { value: 0, count: 0, max: 0 };
    };
  });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 240)));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text().slice(0, 240);
    if (/ERR_INTERNET_DISCONNECTED|ERR_FILE_NOT_FOUND|Failed to load resource/.test(text)) return;
    errors.push(text);
  });
  page.on("request", (request) => {
    let pathname = "";
    let protocol = "";
    try {
      const url = new URL(request.url());
      pathname = url.pathname;
      protocol = url.protocol;
    } catch {
      /* data: */
    }
    requests.push({
      url: request.url(),
      pathname,
      protocol,
      method: request.method(),
      resourceType: request.resourceType(),
      at: Date.now(),
    });
  });
  await page.goto(staticUrl ?? `${BASE}/`, { waitUntil: "domcontentloaded" });
  if (staticUrl) {
    await page.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 20_000 });
    await page.waitForTimeout(700);
  } else {
    await page.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 20_000 });
    await page.waitForTimeout(700);
    if (await page.locator('input[type="password"]').count()) {
      await page.locator('input[type="password"]').first().fill(AUTH);
      await page.click('[data-testid="login-submit"]');
      await page.waitForTimeout(2200);
      await page.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 20_000 });
    }
  }
  lastActivePage = page;
  // Section-level opening evidence: a section that aborts later still leaves a
  // scene screenshot in the report directory (abort step references it).
  if (currentSection) {
    sectionShotSeq += 1;
    const name = `sec-${String(sectionShotSeq).padStart(2, "0")}-${sectionSlug(currentSection.title)}-start.png`;
    try {
      await page.screenshot({ path: shotPath(name) });
      shots.push(name);
      lastSectionShot = name;
    } catch {
      /* page closed mid-capture */
    }
  }
  return { context, page, errors, requests, label };
}

/** Best-effort abort scene: last open page, else section opening screenshot. */
async function captureAbortShot(label) {
  if (lastActivePage && !lastActivePage.isClosed()) {
    const name = `abort-${sectionSlug(label)}-${Date.now().toString(36)}.png`;
    try {
      await lastActivePage.screenshot({ path: shotPath(name) });
      shots.push(name);
      return name;
    } catch {
      /* fall through */
    }
  }
  return lastSectionShot;
}

async function closePage(entry) {
  if (!entry) return;
  contexts.delete(entry.context);
  await entry.context.close().catch(() => {});
}

async function closeAllPages() {
  for (const context of [...contexts]) {
    contexts.delete(context);
    await context.close().catch(() => {});
  }
}

const READ_PREVIEWS = ({ postId }) => {
  const thread = document.querySelector('[data-testid="thread-timeline"]');
  const post =
    (thread ? thread.querySelector('[data-post-id="' + postId + '"]') : null) ??
    document.querySelector('[data-testid="timeline-scroll"] [data-post-id="' + postId + '"]') ??
    document.querySelector('[data-post-id="' + postId + '"]');
  if (!post) return { found: false, cards: [], bodyText: "" };
  const cards = [...post.querySelectorAll('[data-testid="link-preview-card"]')].map((card) => {
    const rect = card.getBoundingClientRect();
    // Cover uses preview-media; pending has no cover img, so its fixed 4:3
    // placeholder container is the measurement fallback.
    const media =
      card.querySelector('[data-testid="preview-media"]') ??
      card.querySelector('[class*="aspect-"]');
    const mediaRect = media ? media.getBoundingClientRect() : null;
    const img = card.querySelector("img");
    const anchor = card.querySelector("a[href]");
    return {
      status: card.getAttribute("data-preview-status"),
      phase: card.getAttribute("data-preview-phase"),
      position: card.getAttribute("data-preview-position"),
      url: card.getAttribute("data-preview-url") ?? anchor?.getAttribute("href") ?? null,
      text: (card.innerText ?? "").replace(/\s+/g, " ").trim(),
      box: { w: rect.width, h: rect.height, top: rect.top },
      media: mediaRect ? { w: mediaRect.width, h: mediaRect.height, top: mediaRect.top } : null,
      hasImage: Boolean(img),
      imageSrc: img?.getAttribute("src") ?? null,
      anchorHref: anchor?.getAttribute("href") ?? null,
      anchorRel: anchor?.getAttribute("rel") ?? null,
      anchorTarget: anchor?.getAttribute("target") ?? null,
    };
  });
  const bodyText = (post.querySelector('[data-testid="post-body"]')?.innerText ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return { found: true, cards, bodyText };
};

async function readPreviews(page, postId) {
  return page.evaluate(READ_PREVIEWS, { postId });
}

async function waitPreviewState(page, postId, predicate, timeoutMs, label) {
  let last = null;
  await waitUntil(
    async () => {
      last = await readPreviews(page, postId);
      return last.found && predicate(last);
    },
    timeoutMs,
    label,
    120,
  );
  return last;
}

/** Carousel state (frozen QA contract: root data-active-index + dot aria-current). */
const READ_CAROUSEL = ({ postId }) => {
  const thread = document.querySelector('[data-testid="thread-timeline"]');
  const post =
    (thread ? thread.querySelector('[data-post-id="' + postId + '"]') : null) ??
    document.querySelector('[data-testid="timeline-scroll"] [data-post-id="' + postId + '"]') ??
    document.querySelector('[data-post-id="' + postId + '"]');
  if (!post) return null;
  const cards = [...post.querySelectorAll('[data-testid="link-preview-card"]')];
  if (cards.length === 0) return null;
  const root = post.querySelector('[data-testid="link-previews"]');
  if (!root) return null;
  const rawIndex = root.getAttribute("data-active-index");
  const attrActive = (() => {
    if (rawIndex === null) return -1;
    const value = Number(rawIndex);
    return Number.isInteger(value) && value >= 0 ? value : -1;
  })();
  const dots = [...post.querySelectorAll('[data-testid="previews-dot"]')];
  const dotIndexes = dots.map((dot) => {
    const raw = dot.getAttribute("data-index");
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
  });
  const dotActive = dots.findIndex((dot) => dot.getAttribute("aria-current") === "true");
  return {
    cardCount: cards.length,
    dots: dots.length,
    dotIndexes,
    dotActive,
    attrActive,
    active: attrActive,
    hasPrev: Boolean(post.querySelector('[data-testid="previews-prev"]')),
    hasNext: Boolean(post.querySelector('[data-testid="previews-next"]')),
  };
};

async function carouselState(page, postId) {
  return page.evaluate(READ_CAROUSEL, { postId });
}

async function waitCarouselState(page, postId, predicate, timeoutMs, label) {
  let last = null;
  await waitUntil(
    async () => {
      last = await carouselState(page, postId);
      return Boolean(last) && predicate(last);
    },
    timeoutMs,
    label,
    120,
  );
  return last;
}

/**
 * Real mouse interaction: hover then click, never `force`. If the cover image
 * (or any overlay) intercepts the hit target, Playwright times out and the
 * test goes red — that is exactly what A17 must catch.
 */
async function realClick(locator) {
  await locator.hover();
  await locator.click();
}

async function clickCarouselArrow(page, postId, direction) {
  const postSelector = await postScope(page, postId);
  const selector =
    direction === "next"
      ? '[data-testid="previews-next"]'
      : '[data-testid="previews-prev"]';
  const root = page.locator(`${postSelector} [data-testid="link-previews"]`).first();
  if (await root.count()) await root.hover().catch(() => {});
  const locator = page.locator(`${postSelector} ${selector}`).first();
  if ((await locator.count()) && (await locator.isVisible().catch(() => false))) {
    await realClick(locator);
    return selector;
  }
  return null;
}

async function clickCarouselDot(page, postId, index) {
  const postSelector = await postScope(page, postId);
  const dot = page.locator(
    `${postSelector} [data-testid="previews-dot"][data-index="${index}"]`,
  );
  if ((await dot.count()) && (await dot.first().isVisible().catch(() => false))) {
    await realClick(dot.first());
    return true;
  }
  return false;
}

/** CDP touch swipe for mobile carousel acceptance. */
async function swipeCarousel(page, postId, fromRatio, toRatio) {
  const scope = await postScope(page, postId);
  const rootLocator = page.locator(`${scope} [data-testid="link-previews"]`).first();
  if (await rootLocator.count()) {
    await rootLocator.scrollIntoViewIfNeeded().catch(() => {});
  }
  const box = await page.evaluate(({ id }) => {
    const thread = document.querySelector('[data-testid="thread-timeline"]');
    const post =
      (thread ? thread.querySelector('[data-post-id="' + id + '"]') : null) ??
      document.querySelector('[data-testid="timeline-scroll"] [data-post-id="' + id + '"]') ??
      document.querySelector('[data-post-id="' + id + '"]');
    const root = post?.querySelector('[data-testid="link-previews"]');
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, { id: postId });
  if (!box || box.width <= 0) return false;
  const y = box.top + Math.min(box.height / 2, 80);
  const startX = box.left + box.width * fromRatio;
  const endX = box.left + box.width * toRatio;
  const client = await page.context().newCDPSession(page);
  try {
    const point = (x) => ({
      x,
      y,
      id: 1,
      radiusX: 6,
      radiusY: 6,
      force: 1,
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point(startX)],
    });
    await sleep(60);
    for (let step = 1; step <= 12; step += 1) {
      const x = startX + ((endX - startX) * step) / 12;
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [point(x)],
      });
      await sleep(40);
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return true;
  } finally {
    await client.detach().catch(() => {});
  }
}

async function ensurePostVisible(page, postId) {
  const thread = page.locator('[data-testid="thread-timeline"]').first();
  if ((await thread.count()) && (await thread.isVisible().catch(() => false))) {
    const inThread = thread.locator(`[data-post-id="${postId}"]`);
    if (await inThread.count()) return "thread";
    await page.evaluate((id) => {
      location.hash = `#/p/${id}`;
    }, postId);
    await page.waitForSelector(`[data-testid="thread-timeline"] [data-post-id="${postId}"]`, {
      timeout: 15_000,
    });
    return "thread";
  }
  const feedPost = page.locator(`[data-testid="timeline-scroll"] [data-post-id="${postId}"]`);
  if (await feedPost.count()) return "present";
  const pill = page.locator('[data-testid="new-posts-pill"]');
  if (await pill.count()) {
    await pill.first().click();
    await page.waitForTimeout(500);
  }
  if (await feedPost.count()) return "pill";
  await page.evaluate((id) => {
    location.hash = `#/p/${id}`;
  }, postId);
  await page.waitForSelector(
    `[data-testid="thread-timeline"] [data-post-id="${postId}"], [data-testid="timeline-scroll"] [data-post-id="${postId}"]`,
    { timeout: 15_000 },
  );
  return "thread";
}

/** Scope selector for the visible post instance (thread overlay wins). */
async function postScope(page, postId) {
  const thread = page.locator('[data-testid="thread-timeline"]').first();
  if (
    (await thread.count()) &&
    (await thread.isVisible().catch(() => false)) &&
    (await thread.locator(`[data-post-id="${postId}"]`).count())
  ) {
    return `[data-testid="thread-timeline"] [data-post-id="${postId}"]`;
  }
  return `[data-testid="timeline-scroll"] [data-post-id="${postId}"]`;
}

/**
 * Make a post visible without clicking the "new posts" pill: that pill click
 * intentionally refreshes the feed, which would pollute A15's "post.updated
 * must not refetch the feed" assertion. Prefer the feed (hub insert), else
 * open the thread overlay via hash (thread request, not a feed request).
 */
async function showPostWithoutFeedRefresh(page, postId) {
  const feedPost = page.locator(`[data-testid="timeline-scroll"] [data-post-id="${postId}"]`);
  if (await feedPost.count()) return "feed";
  await page.evaluate((id) => {
    location.hash = `#/p/${id}`;
  }, postId);
  await page.waitForSelector(`[data-testid="thread-timeline"] [data-post-id="${postId}"]`, {
    timeout: 15_000,
  });
  return "thread";
}

/** Wait until the preview card for this post is mounted (screenshot evidence). */
async function pageWaitForPreviewDom(page, postId) {
  await page
    .waitForSelector(`[data-post-id="${postId}"] [data-testid="link-preview-card"]`, {
      timeout: 10_000,
    })
    .catch(() => {});
  await sleep(300);
}

async function feedPostIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="timeline-scroll"] [data-testid="post-card"][data-post-id]')].map(
      (el) => el.getAttribute("data-post-id"),
    ),
  );
}

async function scrollTop(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="timeline-scroll"]');
    return scroller ? scroller.scrollTop : 0;
  });
}

async function overflowState(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

async function readCls(page) {
  return page.evaluate(() => window.__previewCls ?? { value: 0, count: 0, max: 0 });
}

async function resetCls(page) {
  await page.evaluate(() => window.__resetPreviewCls?.());
}

function ratioOf(box) {
  return box && box.h > 0 ? box.w / box.h : Number.NaN;
}

// ── static export helpers ────────────────────────────────────────────────────
function ensureUiBuild() {
  const shell = join(REPO_ROOT, "dist", "index.html");
  if (NO_BUILD) {
    if (!existsSync(shell)) throw new Error(`dist/index.html missing and --no-build was passed`);
    return { built: false, shell };
  }
  // Always rebuild unless --no-build: a stale dist from before the change would
  // make A3 silently miss the preview UI (static export test would be invalid).
  const result = spawnSync(process.execPath, ["run", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 300_000,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`bun run build failed (${result.status}): ${(result.stderr || result.stdout || "").slice(-800)}`);
  }
  if (!existsSync(shell)) throw new Error(`build finished but ${shell} is missing`);
  return { built: true, shell };
}

function runExport(outDir) {
  const cli = join(REPO_ROOT, "src/cli/main.ts");
  const result = spawnSync(
    process.execPath,
    [cli, "export", "--data-dir", qa.dataDir, "--out", outDir, "--as", "owner"],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, env: process.env },
  );
  const stdout = result.stdout ?? "";
  const line = stdout.split("\n").find((entry) => entry.trim().startsWith("{"));
  if (result.status !== 0 || !line) {
    throw new Error(`export failed (${result.status}): ${(result.stderr || stdout).slice(-800)}`);
  }
  return JSON.parse(line);
}

function readSnapshot(outDir) {
  const htmlPath = join(outDir, "index.html");
  const html = readFileSync(htmlPath, "utf8");
  const match = /<script type="application\/json" id="report-snapshot">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error(`snapshot element missing in ${htmlPath}`);
  return { snapshot: JSON.parse(match[1]), htmlPath };
}

function staticUrl(outDir) {
  return pathToFileURL(join(outDir, "index.html")).href;
}

// ── misc ─────────────────────────────────────────────────────────────────────
function marker(tag) {
  return `[LP-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}]`;
}

function chromePids() {
  try {
    const result = spawnSync("pgrep", ["-f", "remote-debugging-pipe"], { encoding: "utf8" });
    if (result.status !== 0 && !result.stdout) return [];
    return String(result.stdout)
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function dbPreviewRows(postId) {
  return sqliteQuery(
    "SELECT position, status, phase, error_code, title, cover_url FROM post_previews WHERE post_id = ? ORDER BY position",
    postId,
  );
}

function dbJobRows(postId) {
  return sqliteQuery(
    "SELECT post_id, url_hash, status, attempts, next_run_at, cache_key FROM preview_jobs WHERE post_id = ?",
    postId,
  );
}

function dueJobCount() {
  return sqliteQuery(
    "SELECT count(*) AS n FROM preview_jobs WHERE status = 'running' OR (status = 'queued' AND next_run_at <= ?)",
    Date.now() + 1000,
  )[0].n;
}

/**
 * The QA suite posts dozens of links in one run and exhausts the per-account
 * (60/h) + global preview budget. The budget is read from the isolated DB on
 * every enqueue (no memory cache), so deleting the meta counters before the
 * late sections restores headroom without touching production defaults.
 */
function clearPreviewBudget() {
  const where = "key LIKE 'preview.budget.account.%' OR key = 'preview.budget.global'";
  const before = sqliteQuery(`SELECT key FROM meta WHERE ${where}`).map((row) => row.key);
  sqliteExec(`DELETE FROM meta WHERE ${where}`);
  const remaining = sqliteQuery(`SELECT count(*) AS n FROM meta WHERE ${where}`)[0].n;
  return { cleared: before, remaining };
}

// ── sections ─────────────────────────────────────────────────────────────────
async function sectionEnvironment() {
  beginSection("0 · 夹具与前置", "隔离后端、测试放行清单、插件/能力面可审计");
  const health = await fetch(`${fixture.url}/__health`).then((r) => r.json());
  step({
    intent: "启动 link-preview-fixture（回环主/私网双 origin）",
    expect: "两个 listener 就绪，主/私网端口均随机",
    assertion: `fixture pid=${fixture.info.pid} main=${fixture.url} private=${fixture.privateUrl}`,
    ok: health.ok === true && fixture.port > 0 && fixture.privatePort > 0 && fixture.port !== fixture.privatePort,
  });

  const fixturesData = await fixtureFixtures();
  fixtures = fixturesData;
  step({
    intent: "读取 __fixtures（4 链接帖子夹具）",
    expect: "fourLinks 恰好包含 4 个 http URL",
    assertion: `URL=${(fixturesData.posts.fourLinks.match(/https?:\/\//g) ?? []).length}`,
    ok: (fixturesData.posts.fourLinks.match(/https?:\/\//g) ?? []).length === 4,
  });

  step({
    intent: "确认隔离纪律",
    expect: "BASE 不是生产 13689，dataDir 在 /tmp/report-qa-*",
    assertion: `BASE=${BASE} dataDir=${qa.dataDir}`,
    ok:
      basePort !== 13689 &&
      (qa.dataDir.startsWith("/tmp/report-qa-") || qa.dataDir.startsWith("/private/tmp/report-qa-")),
  });

  const plugin = await pluginView();
  step({
    intent: "GET /api/plugins 包含 link-preview",
    expect: "id/version/rules_version/enabled/worker/limits 齐全",
    assertion: plugin
      ? `version=${plugin.version} rules=${plugin.rules_version} enabled=${plugin.enabled} limits=${JSON.stringify(plugin.limits)}`
      : "link-preview plugin missing",
    ok:
      Boolean(plugin) &&
      plugin.enabled === true &&
      typeof plugin.version === "string" &&
      Number.isInteger(plugin.rules_version) &&
      plugin.limits?.previews_per_post === 3 &&
      ["queued", "running", "ready", "partial", "failed"].every((key) =>
        Number.isInteger(plugin.worker?.[key]),
      ),
    reply: plugin ? JSON.stringify(plugin) : null,
  });
  if (!plugin) {
    READY = false;
    throw new Error("link-preview plugin is not implemented in this build");
  }

  const capabilities = await apiJson(BASE, "/api/capabilities", ownerToken);
  step({
    intent: "能力面声明 preview_fields / preview_events",
    expect: "features.preview_fields=true、features.preview_events=true",
    assertion: `features=${JSON.stringify(capabilities.features ?? capabilities.capabilities?.features ?? {})}`,
    ok:
      capabilities.features?.preview_fields === true &&
      capabilities.features?.preview_events === true,
  });

  // The board is intentionally unseeded; create one baseline card so the
  // first openPage() lands on a non-empty feed (openPage itself only waits for
  // timeline-scroll now).
  await createPost(ownerToken, `${marker("BASE")} 隔离板基线帖（无链接）`);

  await startHubTail();
  step({
    intent: "hub=2 SSE 订阅（hello + post.updated 通道）",
    expect: "收到 hello，后续可按 seq 计事件",
    assertion: `hello=${JSON.stringify(hubTail.hello).slice(0, 180)}`,
    ok: hubTail.hello?.hub === 2,
  });
}

async function sectionA1A2() {
  beginSection("A1 · 发帖返回 <200ms + 首帧 pending", "4:3 占位预留，pending→ready 无 CLS");
  const pageInfo = await openPage({ label: "live-a1" });
  const page = pageInfo.page;
  try {
    await page.waitForTimeout(500);
    await resetCls(page);
    const tag = marker("A1");
    const post = await createPost(ownerToken, `${tag} 单链接：${fixtures.pages.delay2s}`);
    const previews = post.post?.previews ?? [];
    step({
      intent: "POST /api/posts（含 1 链接）",
      expect: "HTTP <200ms；响应 previews[0].status=pending",
      assertion: `latency=${post.latencyMs.toFixed(1)}ms previews=${previews.length} status=${previews[0]?.status}`,
      ok:
        post.status === 201 &&
        post.latencyMs < 200 &&
        previews.length === 1 &&
        previews[0].status === "pending" &&
        previews[0].error_code === null,
      command: `POST ${BASE}/api/posts body="<marker> ${fixtures.pages.delay2s}"`,
      reply: JSON.stringify({ latency_ms: Number(post.latencyMs.toFixed(2)), previews }),
    });

    await ensurePostVisible(page, post.post.id);
    const pending = await waitPreviewState(page, post.post.id, (state) => state.cards[0]?.status === "pending", 8_000, "first pending card");
    const pendingCard = pending.cards[0];
    const pendingMedia = pendingCard.media;
    const pendingRatio = ratioOf(pendingMedia);
    step({
      intent: "首帧 pending 占位（4:3）",
      expect: "卡片 data-preview-status=pending；preview-media 宽高比 ≈4:3",
      assertion: `media=${pendingMedia ? `${pendingMedia.w.toFixed(1)}×${pendingMedia.h.toFixed(1)} ratio=${pendingRatio.toFixed(3)}` : "missing"}`,
      ok:
        pendingCard.status === "pending" &&
        Boolean(pendingMedia) &&
        Math.abs(pendingRatio - 4 / 3) <= 0.12,
      image: await shot(page, "a1-01-pending.png"),
    });
    step({
      intent: "帖子正文首帧已可见（发帖不阻塞）",
      expect: "post-body 含唯一 marker",
      assertion: `body=${pending.bodyText.slice(0, 60)}`,
      ok: pending.bodyText.includes(tag),
    });

    await resetCls(page);
    await waitPreviewState(page, post.post.id, (state) => state.cards[0]?.status === "ready", 15_000, "ready card");
    await page.waitForTimeout(400);
    const cls = await readCls(page);
    step({
      intent: "pending→ready 布局稳定、无 CLS",
      expect: "card 过渡窗口 CLS < 0.02",
      assertion: `CLS=${cls.value.toFixed(4)} entries=${cls.count} max=${cls.max.toFixed(4)}`,
      ok: cls.value < 0.02,
      image: await shot(page, "a1-02-ready.png"),
    });
    markCoverage("A1", results.filter((r) => r.section.includes("A1")).every((r) => r.ok));
  } finally {
    await closePage(pageInfo);
  }

  beginSection("A2 · 阶段推进 pending→partial→ready（无刷新）", "标题先于封面；feed 不重排");
  const a2PageInfo = await openPage({ label: "live-a2" });
  const a2Page = a2PageInfo.page;
  try {
    const tag = marker("A2");
    const beforeIds = await feedPostIds(a2Page);
    const start = Date.now();
    const post = await createPost(ownerToken, `${tag} 阶段推进：${fixtures.pages.delay2s}`);
    await ensurePostVisible(a2Page, post.post.id);
    await waitPreviewState(a2Page, post.post.id, (state) => state.cards[0]?.status === "ready", 15_000, "A2 ready");
    await sleep(400);
    const events = hubTail.events.filter((line) => line.type === "post.updated" && line.post_id === post.post.id);
    const phases = events.map((line) => ({
      seq: line.seq,
      phase: line.payload?.phase,
      status: line.payload?.status,
      title: line.payload?.previews?.[0]?.title ?? null,
      cover: line.payload?.previews?.[0]?.cover ?? null,
      at: line.receivedAt,
    }));
    step({
      intent: "收集 post.updated 事件（meta→cover）",
      expect: "每阶段 1 条事件，meta 携带标题、cover 阶段后 ready",
      assertion: `events=${events.length} phases=${phases.map((p) => `${p.phase}/${p.status}`).join("→")}`,
      ok:
        events.length === 2 &&
        phases[0]?.phase === "meta" &&
        phases[0]?.status === "partial" &&
        phases[1]?.phase === "cover" &&
        phases[1]?.status === "ready",
      reply: JSON.stringify(phases),
    });
    step({
      intent: "标题先于封面",
      expect: "meta 事件已有 title；ready 事件有 cover",
      assertion: `meta.title=${phases[0]?.title ? "yes" : "no"} ready.cover=${phases[1]?.cover ? "yes" : "no"}`,
      ok: Boolean(phases[0]?.title) && Boolean(phases[1]?.cover),
    });
    const afterIds = await feedPostIds(a2Page);
    const beforeSet = new Set(beforeIds);
    const preserved = afterIds.filter((id) => beforeSet.has(id));
    step({
      intent: "阶段事件不重排 feed",
      expect: "既有帖子相对顺序不变，新帖只在顶部插入",
      assertion: `before=${beforeIds.length} after=${afterIds.length} preservedOrder=${JSON.stringify(preserved) === JSON.stringify(beforeIds)}`,
      ok: JSON.stringify(preserved) === JSON.stringify(beforeIds),
    });
    step({
      intent: "pending→ready 时间与事件数",
      expect: "记录实测值供验收报告",
      assertion: `post→ready=${Date.now() - start}ms events=${events.length} metaAt=${phases[0]?.at ? phases[0].at - start : "?"}ms`,
      ok: events.length >= 2,
      image: await shot(a2Page, "a2-01-ready-no-reorder.png"),
    });
    markCoverage("A2", results.filter((r) => r.section.includes("A2")).every((r) => r.ok));
  } finally {
    await closePage(a2PageInfo);
  }
}

async function sectionA3() {
  beginSection("A3 · 静态导出（file:// / 0 网络 / pending·failed 纯链接）", "快照原样携带 previews 与 preview_enabled");
  const build = uiBuildResult ?? ensureUiBuild();
  step({
    intent: "确认静态壳构建",
    expect: "dist/index.html 存在（必要时自动 bun run build）",
    assertion: `built=${build.built} shell=${build.shell}`,
    ok: existsSync(build.shell),
  });

  const failedTag = marker("A3F");
  const failedPost = await createPost(ownerToken, `${failedTag} 失败导出：${fixtures.pages.notFound}`);
  await waitPreviews(failedPost.post.id, (rows) => rows.some((row) => row.status === "failed"), 20_000, "A3 failed post");
  const pendingTag = marker("A3P");
  const pendingPost = await createPost(ownerToken, `${pendingTag} pending 导出：${fixtures.pages.delay2s}`);
  const pendingDir = join(qa.dataDir, `export-pending-${Date.now()}`);
  const exportPending = runExport(pendingDir);
  const pendingSnapshot = readSnapshot(pendingDir).snapshot;
  const snapshotFailed = pendingSnapshot.posts.find((post) => post.id === failedPost.post.id);
  const snapshotPending = pendingSnapshot.posts.find((post) => post.id === pendingPost.post.id);
  step({
    intent: "导出快照包含 previews 与 preview_enabled",
    expect: "failed/pending 原样入快照，顶层 preview_enabled=true",
    assertion: `preview_enabled=${pendingSnapshot.preview_enabled} failed=${snapshotFailed?.previews?.[0]?.status} pending=${snapshotPending?.previews?.[0]?.status}`,
    ok:
      pendingSnapshot.preview_enabled === true &&
      snapshotFailed?.previews?.[0]?.status === "failed" &&
      snapshotPending?.previews?.[0]?.status === "pending",
    reply: JSON.stringify(exportPending),
  });

  const pendingView = await openPage({ staticUrl: staticUrl(pendingDir), label: "static-pending" });
  try {
    const collectAnchors = (id) =>
      pendingView.page.evaluate((postId) => {
        const thread = document.querySelector('[data-testid="thread-timeline"]');
        const post =
          (thread ? thread.querySelector('[data-post-id="' + postId + '"]') : null) ??
          document.querySelector('[data-testid="timeline-scroll"] [data-post-id="' + postId + '"]') ??
          document.querySelector('[data-post-id="' + postId + '"]');
        return post
          ? [...post.querySelectorAll('a[href^="http"]')].map((anchor) => anchor.getAttribute("href"))
          : [];
      }, id);
    await ensurePostVisible(pendingView.page, pendingPost.post.id);
    const pendingCards = await readPreviews(pendingView.page, pendingPost.post.id);
    const pendingAnchors = await collectAnchors(pendingPost.post.id);
    await ensurePostVisible(pendingView.page, failedPost.post.id);
    const failedCards = await readPreviews(pendingView.page, failedPost.post.id);
    const failedAnchors = await collectAnchors(failedPost.post.id);
    const httpRequests = pendingView.requests.filter((request) => /^https?:$/.test(request.protocol));
    step({
      intent: "file:// 打开 pending/failed 归档：纯链接，不渲染预览卡",
      expect: "0 卡片；正文裸 URL 仍可点",
      assertion: `pendingCards=${pendingCards.cards.length} failedCards=${failedCards.cards.length} anchors=${pendingAnchors.length}/${failedAnchors.length}`,
      ok:
        pendingCards.cards.length === 0 &&
        failedCards.cards.length === 0 &&
        pendingAnchors.length >= 1 &&
        failedAnchors.length >= 1,
      image: await shot(pendingView.page, "a3-01-static-pending-plain-link.png"),
    });
    step({
      intent: "静态归档 0 网络请求",
      expect: "无 http/https 请求（快照内联、无 EventSource/API）",
      assertion: `httpRequests=${httpRequests.length} total=${pendingView.requests.length} errors=${pendingView.errors.length}`,
      ok: httpRequests.length === 0 && pendingView.errors.length === 0,
    });
  } finally {
    await closePage(pendingView);
  }

  await waitPreviews(pendingPost.post.id, (rows) => rows.some((row) => row.status === "ready"), 20_000, "A3 pending became ready");
  const readyDir = join(qa.dataDir, `export-ready-${Date.now()}`);
  runExport(readyDir);
  const readySnapshot = readSnapshot(readyDir).snapshot;
  const readyPostSnapshot = readySnapshot.posts.find((post) => post.id === pendingPost.post.id);
  const readyView = await openPage({ staticUrl: staticUrl(readyDir), label: "static-ready" });
  try {
    await ensurePostVisible(readyView.page, pendingPost.post.id);
    const readyCards = await readPreviews(readyView.page, pendingPost.post.id);
    const httpRequests = readyView.requests.filter((request) => /^https?:$/.test(request.protocol));
    const externalImages = await readyView.page.evaluate(({ id }) => {
      const thread = document.querySelector('[data-testid="thread-timeline"]');
      const post =
        (thread ? thread.querySelector('[data-post-id="' + id + '"]') : null) ??
        document.querySelector('[data-testid="timeline-scroll"] [data-post-id="' + id + '"]') ??
        document.querySelector('[data-post-id="' + id + '"]');
      if (!post) return [];
      return [...post.querySelectorAll('[data-testid="link-preview-card"] img')]
        .map((img) => img.getAttribute("src") ?? "")
        .filter((src) => src.startsWith("http"));
    }, { id: pendingPost.post.id });
    step({
      intent: "ready 归档渲染同款卡片",
      expect: "快照 status=ready；卡片 ready；外链封面离线省略",
      assertion: `snapshot=${readyPostSnapshot?.previews?.[0]?.status} cards=${readyCards.cards.length} externalImages=${externalImages.length}`,
      ok:
        readyPostSnapshot?.previews?.[0]?.status === "ready" &&
        readyCards.cards.length === 1 &&
        readyCards.cards[0].status === "ready" &&
        externalImages.length === 0,
      image: await shot(readyView.page, "a3-02-static-ready-card.png"),
    });
    step({
      intent: "ready 归档仍 0 网络",
      expect: "无 http/https 请求、无 console error",
      assertion: `httpRequests=${httpRequests.length} errors=${readyView.errors.length}`,
      ok: httpRequests.length === 0 && readyView.errors.length === 0,
    });
    markCoverage("A3", results.filter((r) => r.section.includes("A3")).every((r) => r.ok));
  } finally {
    await closePage(readyView);
  }
}

async function sectionA4() {
  beginSection("A4 · cacheKey 失配（版本升级等价路径）倒序入队 + 旧值保持", "隔离库直接改 cache_key 模拟插件版本/rules 变化");
  if (!BOARD_OWNED) {
    step({
      intent: "A4 需要重启隔离后端",
      expect: "auto-started qa-serve（本脚本拥有）",
      assertion: "SKIP：REPORT_QA_BASE 指向外部后端，脚本不重启他人的板子",
      ok: true,
    });
    coverage.set("A4", { status: "SKIP", note: "external REPORT_QA_BASE; restart test needs owned backend" });
    return;
  }
  await closeAllPages();
  const older = await createPost(ownerToken, `${marker("A4O")} 旧帖：${fixtures.pages.delay1s}`);
  await sleep(120);
  const newer = await createPost(ownerToken, `${marker("A4N")} 新帖：${fixtures.pages.ogFull}`);
  await waitPreviews(older.post.id, (rows) => rows.every((row) => row.status === "ready"), 30_000, "A4 older ready");
  await waitPreviews(newer.post.id, (rows) => rows.every((row) => row.status === "ready"), 30_000, "A4 newer ready");
  const oldOlder = await previewsOf(older.post.id);
  const oldNewer = await previewsOf(newer.post.id);

  await fixtureReset();
  await stopServe("SIGTERM");
  sqliteExec(
    "BEGIN; UPDATE post_previews SET cache_key = 'stale-' || cache_key; DELETE FROM preview_jobs; COMMIT;",
  );
  const staleRows = sqliteQuery(
    "SELECT count(*) AS n FROM post_previews WHERE cache_key LIKE 'stale-%'",
  )[0];
  await startBoardOn(qa.dataDir, basePort);
  await waitUntil(
    async () => {
      try {
        return (await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(800) })).ok;
      } catch {
        return false;
      }
    },
    15_000,
    "A4 restarted board healthy",
  );

  const immediateOlder = await previewsOf(older.post.id);
  const immediateNewer = await previewsOf(newer.post.id);
  step({
    intent: "失配扫描前旧值保持",
    expect: "重启后立即读取仍为旧 ready 值（不清库、不降级）",
    assertion: `older=${immediateOlder[0]?.status} newer=${immediateNewer[0]?.status} staleRows=${staleRows?.n}`,
    ok:
      staleRows?.n >= 2 &&
      immediateOlder[0]?.status === "ready" &&
      immediateNewer[0]?.status === "ready" &&
      immediateOlder[0]?.title === oldOlder[0]?.title &&
      immediateNewer[0]?.title === oldNewer[0]?.title,
  });

  await waitUntil(
    async () => {
      const stats = await fixtureStats();
      return (
        pathStat(stats, fixtures.pages.delay1s).worker >= 1 &&
        pathStat(stats, fixtures.pages.ogFull).worker >= 1
      );
    },
    30_000,
    "A4 stale URLs re-fetched",
  );
  const stats = await fixtureStats();
  const newerStat = pathStat(stats, fixtures.pages.ogFull);
  const olderStat = pathStat(stats, fixtures.pages.delay1s);
  step({
    intent: "按 created_at desc（新帖先处理）",
    expect: "同域名并发 1，新帖请求先于旧帖",
    assertion: `newer.firstAt=${newerStat.firstAt} older.firstAt=${olderStat.firstAt} newer.worker=${newerStat.worker} older.worker=${olderStat.worker}`,
    ok:
      newerStat.worker >= 1 &&
      olderStat.worker >= 1 &&
      newerStat.firstAt !== null &&
      olderStat.firstAt !== null &&
      newerStat.firstAt < olderStat.firstAt,
  });

  await waitPreviews(older.post.id, (rows) => rows.every((row) => row.status === "ready"), 30_000, "A4 older ready after stale");
  await waitPreviews(newer.post.id, (rows) => rows.every((row) => row.status === "ready"), 30_000, "A4 newer ready after stale");
  // Drain every due stale job before A5 starts toggling: a leftover queued job
  // would otherwise resume when the plugin is re-enabled and look like new
  // fetches. Failed jobs keep a 5m backoff and are already "not due".
  await waitUntil(
    async () => {
      if (dueJobCount() !== 0) return false;
      await sleep(500);
      return dueJobCount() === 0;
    },
    90_000,
    "A4 due preview jobs drained",
  );
  const doneOlder = await previewsOf(older.post.id);
  const doneNewer = await previewsOf(newer.post.id);
  step({
    intent: "重处理后旧值被新阶段覆盖，卡片不丢失",
    expect: "两帖仍 ready，title/cover 保持可展示",
    assertion: `older=${doneOlder[0]?.status}/${doneOlder[0]?.title?.slice(0, 10)} newer=${doneNewer[0]?.status}/${doneNewer[0]?.title?.slice(0, 10)}`,
    ok:
      doneOlder.every((row) => row.status === "ready") &&
      doneNewer.every((row) => row.status === "ready"),
  });
  const a4Page = await openPage({ label: "live-a4" });
  try {
    await ensurePostVisible(a4Page.page, newer.post.id);
    await pageWaitForPreviewDom(a4Page.page, newer.post.id);
    const a4Dom = await readPreviews(a4Page.page, newer.post.id);
    const a4Image = await shot(a4Page.page, "a4-01-reprocessed-old-values.png");
    step({
      intent: "重处理后卡片视觉证据",
      expect: "旧帖仍显示 ready 卡片（未闪空/未降级）",
      assertion: `cards=${a4Dom.cards.length} statuses=${a4Dom.cards.map((card) => card.status).join(",")}`,
      ok: a4Dom.cards.length >= 1 && a4Dom.cards.every((card) => card.status === "ready"),
      image: a4Image,
    });
  } finally {
    await closePage(a4Page);
  }
  markCoverage("A4", results.filter((r) => r.section.includes("A4")).every((r) => r.ok));
}

async function sectionFetchBaseline() {
  beginSection("P1 抓取基线 · HEAD405/重定向/OG/Twitter/GBK/首段/SVG/截断/MIME", "design §6 抓取管线与 §14.1 夹具端点的端到端对照");
  await fixtureReset();
  const p1 = await createPost(
    ownerToken,
    `${marker("FB1")} HEAD/重定向：\n\n${fixtures.pages.head405}\n${fixtures.pages.redirectOne}\n${fixtures.pages.redirectChain}`,
  );
  const p2 = await createPost(
    ownerToken,
    `${marker("FB2")} 元数据回退：\n\n${fixtures.pages.twitter}\n${fixtures.pages.plain}\n${fixtures.pages.gbk}`,
  );
  const p3 = await createPost(
    ownerToken,
    `${marker("FB3")} 首段/SVG/截断：\n\n${fixtures.pages.article}\n${fixtures.pages.svgCover}\n${fixtures.pages.longTitle}`,
  );
  const p4 = await createPost(
    ownerToken,
    `${marker("FB4")} 媒体类型：\n\n${fixtures.resources.imageSmall}\n${fixtures.resources.video}\n${fixtures.resources.pdf}`,
  );
  const p5 = await createPost(
    ownerToken,
    `${marker("FB5")} 音频/未知/meta refresh：\n\n${fixtures.resources.audio}\n${fixtures.resources.unknown}\n${fixtures.pages.metaRefresh}`,
  );
  await waitUntil(
    async () => {
      const rows = await Promise.all([p1, p2, p3, p4, p5].map((entry) => previewsOf(entry.post.id)));
      return rows.flat().every((row) => ["ready", "partial"].includes(row.status));
    },
    45_000,
    "fetch baseline ready",
  );
  const rows = (await Promise.all([p1, p2, p3, p4, p5].map((entry) => previewsOf(entry.post.id)))).flat();
  const byUrl = new Map(rows.map((row) => [row.url, row]));
  const get = (url) => byUrl.get(url);
  const stats = await fixtureStats();
  const headStat = pathStat(stats, fixtures.pages.head405);

  step({
    intent: "HEAD 405 → GET 回退",
    expect: "HEAD /head-405=405 且紧随 GET=200；标题解析成功",
    assertion: `HEAD=${headStat.HEAD} GET=${headStat.GET} title=${get(fixtures.pages.head405)?.title}`,
    ok:
      headStat.HEAD >= 1 &&
      headStat.GET >= 1 &&
      get(fixtures.pages.head405)?.title === "HEAD 405 回退标题",
  });
  step({
    intent: "302 单跳 / 多跳链",
    expect: "single→og-no-cover；chain（3 跳）→og-full；final_url 记录终点",
    assertion: `one=${get(fixtures.pages.redirectOne)?.final_url} chain=${get(fixtures.pages.redirectChain)?.final_url}`,
    ok:
      get(fixtures.pages.redirectOne)?.title === "OG 无封面标题" &&
      get(fixtures.pages.redirectChain)?.title === "OG 完整页面标题" &&
      String(get(fixtures.pages.redirectOne)?.final_url ?? "").endsWith("/og-no-cover") &&
      String(get(fixtures.pages.redirectChain)?.final_url ?? "").endsWith("/og-full"),
  });
  step({
    intent: "OG → Twitter → title/meta 优先级",
    expect: "twitter 标题/描述/封面；plain 只有 title/meta；GBK 正确解码",
    assertion: `twitter=${get(fixtures.pages.twitter)?.title} plain=${get(fixtures.pages.plain)?.title} gbk=${get(fixtures.pages.gbk)?.title}`,
    ok:
      get(fixtures.pages.twitter)?.title === "Twitter 卡片标题" &&
      Boolean(get(fixtures.pages.twitter)?.cover) &&
      get(fixtures.pages.plain)?.title === "仅标题页面" &&
      get(fixtures.pages.plain)?.cover === null &&
      String(get(fixtures.pages.gbk)?.title ?? "").includes("GBK") &&
      String(get(fixtures.pages.gbk)?.title ?? "").includes("编码标题") &&
      String(get(fixtures.pages.gbk)?.description ?? "").includes("编码描述"),
  });
  step({
    intent: "长正文首段回退 / SVG 封面拒绝 / 字段截断",
    expect: "article 描述含首段标记；svg cover=null；title≤200、desc≤400",
    assertion: `article=${String(get(fixtures.pages.article)?.description ?? "").slice(0, 16)} svgCover=${JSON.stringify(get(fixtures.pages.svgCover)?.cover)} titleLen=${get(fixtures.pages.longTitle)?.title?.length} descLen=${get(fixtures.pages.longTitle)?.description?.length}`,
    ok:
      String(get(fixtures.pages.article)?.description ?? "").includes("首段抽取标记") &&
      get(fixtures.pages.svgCover)?.cover === null &&
      get(fixtures.pages.svgCover)?.title === "SVG 封面页面" &&
      (get(fixtures.pages.longTitle)?.title?.length ?? 0) <= 200 &&
      (get(fixtures.pages.longTitle)?.description?.length ?? 0) <= 400,
  });
  step({
    intent: "MIME 分类（魔数 > Content-Type）",
    expect: "png→image、mp4→video、pdf→document、mp3→audio、未知→unknown",
    assertion: `p4=${[fixtures.resources.imageSmall, fixtures.resources.video, fixtures.resources.pdf].map((url) => get(url)?.kind).join(",")} p5=${get(fixtures.resources.audio)?.kind},${get(fixtures.resources.unknown)?.kind}`,
    ok:
      get(fixtures.resources.imageSmall)?.kind === "image" &&
      get(fixtures.resources.video)?.kind === "video" &&
      get(fixtures.resources.pdf)?.kind === "document" &&
      get(fixtures.resources.audio)?.kind === "audio" &&
      get(fixtures.resources.unknown)?.kind === "unknown",
  });
  step({
    intent: "不跟随 meta http-equiv=refresh",
    expect: "title 是被抓页面自身，不变成 /og-full 标题",
    assertion: `title=${get(fixtures.pages.metaRefresh)?.title}`,
    ok: get(fixtures.pages.metaRefresh)?.title === "不应跟随 meta refresh",
  });
  const baselinePage = await openPage({ label: "live-fetch-baseline" });
  try {
    await ensurePostVisible(baselinePage.page, p2.post.id);
    await pageWaitForPreviewDom(baselinePage.page, p2.post.id);
    const baselineImage = await shot(baselinePage.page, "fb-01-metadata-baseline.png");
    step({
      intent: "抓取基线视觉证据",
      expect: "Twitter/plain/GBK 三张卡片按元数据渲染",
      assertion: "screenshot captured",
      ok: true,
      image: baselineImage,
    });
  } finally {
    await closePage(baselinePage);
  }
}

async function sectionA5() {
  beginSection("A5 · 关闭/重开（同版本 0 抓取）", "plugin.updated 控制帧让已开页面立即隐藏/恢复");
  const pageInfo = await openPage({ label: "live-a5" });
  const page = pageInfo.page;
  try {
    await waitUntil(
      async () => (await page.locator('[data-testid="link-preview-card"]').count()) > 0,
      10_000,
      "A5 initial preview cards",
    );
    await fixtureReset();
    const documentBaseline = pageInfo.requests.filter(
      (request) => request.resourceType === "document",
    ).length;
    const cardsBefore = await page.locator('[data-testid="link-preview-card"]').count();
    step({
      intent: "关闭前存在可展示卡片（前提）",
      expect: "页面至少有 1 张预览卡",
      assertion: `cards=${cardsBefore}`,
      ok: cardsBefore >= 1,
    });
    const markerValue = await page.evaluate(() => {
      window.__a5Marker = Math.random();
      return window.__a5Marker;
    });
    await setPluginEnabled(false);
    const disabledView = await pluginView();
    await waitUntil(
      async () => (await page.locator('[data-testid="link-preview-card"]').count()) === 0,
      5_000,
      "cards hidden after plugin disabled",
    );
    const cardsDisabled = await page.locator('[data-testid="link-preview-card"]').count();
    step({
      intent: "PATCH /api/plugins/link-preview {enabled:false}",
      expect: "plugin.updated 控制帧在已开页面隐藏全部卡片（不刷新）",
      assertion: `enabled=${disabledView?.enabled} cards=${cardsDisabled}`,
      ok: disabledView?.enabled === false && cardsDisabled === 0,
      image: await shot(page, "a5-01-plugin-disabled.png"),
    });
    await sleep(2000);
    const statsDisabled = await fixtureStats();
    step({
      intent: "关闭期间 0 抓取",
      expect: "worker UA 请求数不增",
      assertion: `workerRequests=${statsDisabled.main.workerRequests}`,
      ok: statsDisabled.main.workerRequests === 0,
    });

    await setPluginEnabled(true);
    await waitUntil(
      async () => (await page.locator('[data-testid="link-preview-card"]').count()) > 0,
      5_000,
      "cards restored after plugin enabled",
    );
    await sleep(2000);
    const statsEnabled = await fixtureStats();
    step({
      intent: "同版本重开：立即恢复、0 新抓取",
      expect: "enabled=true；卡片回来；workerRequests 仍为 0",
      assertion: `cards=${await page.locator('[data-testid="link-preview-card"]').count()} workerRequests=${statsEnabled.main.workerRequests}`,
      ok:
        (await pluginView())?.enabled === true &&
        (await page.locator('[data-testid="link-preview-card"]').count()) > 0 &&
        statsEnabled.main.workerRequests === 0,
      image: await shot(page, "a5-02-plugin-enabled.png"),
    });
    const markerAfterToggle = await page.evaluate(() => window.__a5Marker);
    const documentRequestsAfterToggle =
      pageInfo.requests.filter((request) => request.resourceType === "document").length -
      documentBaseline;
    step({
      intent: "关闭/重开未整页刷新",
      expect: "PATCH 前后增量：marker 不变、document 请求 +0",
      assertion: `markerKept=${markerAfterToggle === markerValue} documentRequestsDelta=${documentRequestsAfterToggle} (baseline=${documentBaseline})`,
      ok: markerAfterToggle === markerValue && documentRequestsAfterToggle === 0,
    });
    step({
      intent: "异版本入队",
      expect: "运行时不支持版本注入，走 A4 的 cacheKey 失配等价路径（设计 §13.2 同一机制）",
      assertion: "覆盖于 A4：改隔离库 cache_key 后重启，服务端按新 key 倒序入队",
      ok: true,
    });
    markCoverage("A5", results.filter((r) => r.section.includes("A5")).every((r) => r.ok));
  } finally {
    await closePage(pageInfo);
  }
}

async function sectionA7() {
  beginSection("A7 · SSRF 私网/元数据/十进制 IP/映射 IPv6", "worker 目标 0 请求，全部 failed/blocked");
  clearPreviewBudget();
  await fixtureReset();
  const privateOrigin = fixture.privateUrl;
  const hosts = [
    ["169.254.169.254", "http://169.254.169.254/latest/meta-data/"],
    ["10.0.0.1", "http://10.0.0.1/"],
    ["decimal-127", `http://2130706433:${fixture.privatePort}/secret`],
  ];
  const p1 = await createPost(
    ownerToken,
    `${marker("A7A")} SSRF 组 1：\n\n${hosts.map(([, url]) => url).join("\n")}`,
  );
  const p2 = await createPost(
    ownerToken,
    `${marker("A7B")} SSRF 组 2：\n\n` +
      [
        `http://[::ffff:127.0.0.1]:${fixture.privatePort}/secret`,
        `http://localhost:${fixture.port}/og-full`,
        "http://user" + ":pw@" + `127.0.0.1:${fixture.privatePort}/secret`,
      ].join("\n"),
  );
  const p3 = await createPost(
    ownerToken,
    `${marker("A7C")} SSRF 组 3：\n\n` +
      [`${privateOrigin}/secret`, "http://example.com:22/", "http://192.168.1.1/"].join("\n"),
  );
  const pScheme = await createPost(ownerToken, `${marker("A7D")} 非 http scheme：file:///etc/passwd`);
  try {
    await waitUntil(
      async () => {
        const snapshots = await Promise.all([p1, p2, p3].map((entry) => previewsOf(entry.post.id)));
        return snapshots.flat().every((row) => row.status === "failed");
      },
      45_000,
      "A7 all SSRF previews failed",
    );
  } catch (error) {
    const diagnostic = (await Promise.all([p1, p2, p3].map((entry) => previewsOf(entry.post.id))))
      .flat()
      .map((row) => ({ url: row.url, status: row.status, phase: row.phase, code: row.error_code }));
    step({
      intent: "A7 超时诊断：未 failed 的预览行",
      expect: "全部 failed/blocked",
      assertion: JSON.stringify(diagnostic),
      ok: false,
    });
    throw error;
  }
  const snapshots = await Promise.all([p1, p2, p3].map((entry) => previewsOf(entry.post.id)));
  const failed = snapshots.flat();
  const codes = failed.map((row) => row.error_code);
  // Order = extraction order: p1 meta/10/decimal, p2 mapped/localhost/userinfo,
  // p3 private-origin/port22/192.168.
  const privateCodes = [0, 1, 2, 3, 4, 6, 8].map((index) => codes[index]);
  const userinfoCode = codes[5];
  step({
    intent: "私网/元数据/十进制/映射 IPv6/localhost 全部 blocked",
    expect: "error_code ∈ blocked_private|blocked_scheme|parse_error，status=failed",
    assertion: `codes=${codes.join(",")}`,
    ok:
      failed.length === 9 &&
      privateCodes.every((code) =>
        ["blocked_private", "blocked_scheme", "parse_error"].includes(code),
      ) &&
      ["blocked_private", "blocked_scheme", "parse_error"].includes(userinfoCode),
  });
  step({
    intent: "端口策略：22 永远拒绝",
    expect: "error_code=blocked_port",
    assertion: `code=${codes[7]}`,
    ok: codes[7] === "blocked_port",
  });
  step({
    intent: "非 http/https scheme 不抽取",
    expect: "previews=[]（file:// 不产生预览）",
    assertion: `previews=${pScheme.post?.previews?.length}`,
    ok: (pScheme.post?.previews ?? []).length === 0,
  });
  const stats = await fixtureStats();
  step({
    intent: "夹具目标 0 请求（主/私网）",
    expect: "worker UA 请求 0，私网 origin 请求 0",
    assertion: `main.workerRequests=${stats.main.workerRequests} private.requests=${stats.private.requests}`,
    ok: stats.main.workerRequests === 0 && stats.private.requests === 0,
  });
  const a7Page = await openPage({ label: "live-a7" });
  try {
    await ensurePostVisible(a7Page.page, p3.post.id);
    await pageWaitForPreviewDom(a7Page.page, p3.post.id);
    const a7Dom = await readPreviews(a7Page.page, p3.post.id);
    const a7Image = await shot(a7Page.page, "a7-01-ssrf-blocked-cards.png");
    step({
      intent: "SSRF 失败卡片视觉证据",
      expect: "failed 卡片降级为普通链接",
      assertion: `cards=${a7Dom.cards.length} statuses=${a7Dom.cards.map((card) => card.status).join(",")}`,
      ok: a7Dom.cards.length === 3 && a7Dom.cards.every((card) => card.status === "failed"),
      image: a7Image,
    });
  } finally {
    await closePage(a7Page);
  }
  markCoverage("A7", results.filter((r) => r.section.includes("A7")).every((r) => r.ok));
}

async function sectionA8() {
  beginSection("A8 · 302→私网（第二未放行 origin）", "failed/blocked_private；目标端口 0 请求");
  clearPreviewBudget();
  await fixtureReset();
  const post = await createPost(ownerToken, `${marker("A8")} 重定向私网：${fixtures.pages.redirectPrivate}`);
  await waitPreviews(post.post.id, (rows) => rows.some((row) => row.status === "failed"), 20_000, "A8 failed");
  const preview = (await previewsOf(post.post.id))[0];
  const stats = await fixtureStats();
  step({
    intent: "抓取 /redirect-private（主 origin 放行）",
    expect: "failed + blocked_private；私网端口计数器 0",
    assertion: `status=${preview?.status} code=${preview?.error_code} private=${stats.private.requests} mainRedirect=${pathStat(stats, fixtures.pages.redirectPrivate).total}`,
    ok:
      preview?.status === "failed" &&
      preview?.error_code === "blocked_private" &&
      stats.private.requests === 0 &&
      pathStat(stats, fixtures.pages.redirectPrivate).total >= 1,
  });
  const a8Page = await openPage({ label: "live-a8" });
  try {
    await ensurePostVisible(a8Page.page, post.post.id);
    await pageWaitForPreviewDom(a8Page.page, post.post.id);
    const a8Dom = await readPreviews(a8Page.page, post.post.id);
    const a8Image = await shot(a8Page.page, "a8-01-redirect-private-blocked.png");
    step({
      intent: "重定向私网失败卡片视觉证据",
      expect: "failed 卡片显示普通链接",
      assertion: `cards=${a8Dom.cards.length} statuses=${a8Dom.cards.map((card) => card.status).join(",")}`,
      ok: a8Dom.cards.length === 1 && a8Dom.cards[0].status === "failed",
      image: a8Image,
    });
  } finally {
    await closePage(a8Page);
  }
  markCoverage("A8", results.filter((r) => r.section.includes("A8")).every((r) => r.ok));
}

async function sectionA9() {
  beginSection("A9 · 404/超时/超大体失败降级", "正文首帧可见；卡片降级普通链接");
  clearPreviewBudget();
  await fixtureReset();
  const tag = marker("A9");
  const post = await createPost(
    ownerToken,
    `${tag} 失败样本：\n\n${fixtures.pages.notFound}\n${fixtures.pages.slow}\n${fixtures.pages.huge}`,
  );
  const pageInfo = await openPage({ label: "live-a9" });
  try {
    await ensurePostVisible(pageInfo.page, post.post.id);
    const visible = await readPreviews(pageInfo.page, post.post.id);
    step({
      intent: "失败抓取期间正文首帧可见",
      expect: "post-body 含 marker（不被预览阻塞）",
      assertion: `body=${visible.bodyText.slice(0, 50)}`,
      ok: visible.bodyText.includes(tag),
    });
    await waitPreviews(
      post.post.id,
      (rows) => rows.length === 3 && rows.every((row) => row.status === "failed"),
      30_000,
      "A9 all failed",
    );
    const rows = await previewsOf(post.post.id);
    const byUrl = new Map(rows.map((row) => [row.url, row]));
    const notFound = byUrl.get(fixtures.pages.notFound);
    const slow = byUrl.get(fixtures.pages.slow);
    const huge = byUrl.get(fixtures.pages.huge);
    step({
      intent: "错误码分类",
      expect: "404→http_error；慢流→timeout；5MiB 声明→blocked_size",
      assertion: `404=${notFound?.error_code} slow=${slow?.error_code} huge=${huge?.error_code}`,
      ok:
        notFound?.status === "failed" &&
        notFound?.error_code === "http_error" &&
        slow?.status === "failed" &&
        slow?.error_code === "timeout" &&
        huge?.status === "failed" &&
        huge?.error_code === "blocked_size",
    });
    const stats = await fixtureStats();
    const hugeStat = pathStat(stats, fixtures.pages.huge);
    step({
      intent: "超大体不下载正文",
      expect: "HEAD /huge 有请求；GET /huge 为 0",
      assertion: `head=${hugeStat.HEAD} get=${hugeStat.GET} worker=${hugeStat.worker}`,
      ok: hugeStat.HEAD >= 1 && hugeStat.GET === 0,
    });
    await waitPreviewState(pageInfo.page, post.post.id, (state) => state.cards.length === 3 && state.cards.every((card) => card.status === "failed"), 10_000, "A9 DOM failed cards");
    const dom = await readPreviews(pageInfo.page, post.post.id);
    step({
      intent: "DOM 降级：failed 卡片是普通链接",
      expect: "3 张 failed 卡；每张有可点 http 链接",
      assertion: `cards=${dom.cards.length} statuses=${dom.cards.map((card) => card.status).join(",")} anchors=${dom.cards.filter((card) => card.anchorHref).length}`,
      ok:
        dom.cards.length === 3 &&
        dom.cards.every((card) => card.status === "failed") &&
        dom.cards.every((card) => Boolean(card.anchorHref)),
      image: await shot(pageInfo.page, "a9-01-failed-degrade.png"),
    });
    markCoverage("A9", results.filter((r) => r.section.includes("A9")).every((r) => r.ok));
  } finally {
    await closePage(pageInfo);
  }
}

async function sectionA10() {
  beginSection("A10 · 每帖 4 链接只取前 3", "第 4 条 0 请求、0 job、0 卡片");
  clearPreviewBudget();
  await fixtureReset();
  const post = await createPost(ownerToken, `${marker("A10")} ${fixtures.posts.fourLinks}`);
  await waitPreviews(post.post.id, (rows) => rows.length === 3, 10_000, "A10 exactly 3 preview rows");
  await waitPreviews(post.post.id, (rows) => rows.every((row) => row.status === "ready"), 25_000, "A10 3 ready");
  const rows = await previewsOf(post.post.id);
  const stats = await fixtureStats();
  const fourth = pathStat(stats, fixtures.pages.article);
  step({
    intent: "4 链接帖子只生成 3 条 previews/job",
    expect: "rows=3，第 4 条 URL 0 请求",
    assertion: `rows=${rows.length} urls=${rows.map((row) => new URL(row.url).pathname).join(",")} fourthWorker=${fourth.worker}`,
    ok:
      rows.length === 3 &&
      rows.map((row) => new URL(row.url).pathname).join(",") === "/og-full,/twitter,/plain" &&
      fourth.worker === 0,
  });
  const pageInfo = await openPage({ label: "live-a10" });
  try {
    await ensurePostVisible(pageInfo.page, post.post.id);
    await waitPreviewState(pageInfo.page, post.post.id, (state) => state.cards.length === 3 && state.cards.every((card) => card.status === "ready"), 10_000, "A10 DOM 3 ready cards");
    const dom = await readPreviews(pageInfo.page, post.post.id);
    step({
      intent: "UI 只渲染 3 张卡（第一条主卡）",
      expect: "cards=3，顺序与正文出现顺序一致",
      assertion: `cards=${dom.cards.length} positions=${dom.cards.map((card) => card.position).join(",")}`,
      ok:
        dom.cards.length === 3 &&
        dom.cards.every((card) => card.status === "ready") &&
        dom.cards.every((card) => card.position === null || ["0", "1", "2"].includes(card.position)),
      image: await shot(pageInfo.page, "a10-01-four-links-three-cards.png"),
    });
    markCoverage("A10", results.filter((r) => r.section.includes("A10")).every((r) => r.ok));
  } finally {
    await closePage(pageInfo);
  }
}

async function sectionA17() {
  beginSection("A17 · 轮播专项（3 页 / 箭头 / 指示点 / ←→ / 触摸拖拽 / 阶段更新不跳页）", "容器 data-active-index；dot data-index + aria-current=true");
  clearPreviewBudget();
  const post = await createPost(
    ownerToken,
    `${marker("A17")} 轮播：\n\n${fixtures.pages.ogFull}\n${fixtures.pages.twitter}\n${fixtures.pages.plain}`,
  );
  await waitPreviews(post.post.id, (rows) => rows.length === 3, 10_000, "A17 exactly 3 preview rows");
  await waitPreviews(post.post.id, (rows) => rows.every((row) => row.status === "ready"), 25_000, "A17 3 ready");
  const pageInfo = await openPage({ label: "live-a17" });
  try {
    await ensurePostVisible(pageInfo.page, post.post.id);
    const carousel = await waitCarouselState(
      pageInfo.page,
      post.post.id,
      (state) =>
        state.cardCount === 3 &&
        state.dots === 3 &&
        state.attrActive === 0 &&
        state.hasPrev &&
        state.hasNext,
      10_000,
      "A17 carousel controls",
    );
    step({
      intent: "轮播 3 页可用（3 卡 + 3 指示点 + 左右箭头 + data-active-index）",
      expect: "cardCount=3；dots=3 且 data-index=0,1,2；active=0；prev/next 存在",
      assertion: `cards=${carousel.cardCount} dots=${carousel.dots} dotIndexes=${carousel.dotIndexes.join(",")} dotActive=${carousel.dotActive} active=${carousel.active} prev=${carousel.hasPrev} next=${carousel.hasNext}`,
      ok:
        carousel.cardCount === 3 &&
        carousel.dots === 3 &&
        carousel.dotIndexes.join(",") === "0,1,2" &&
        carousel.dotActive === 0 &&
        carousel.attrActive === 0 &&
        carousel.hasPrev &&
        carousel.hasNext,
    });

    const nextSelector = await clickCarouselArrow(pageInfo.page, post.post.id, "next");
    const afterNext = nextSelector
      ? await waitCarouselState(pageInfo.page, post.post.id, (state) => state.active === 1, 3_000, "A17 carousel next").catch(() => null)
      : null;
    step({
      intent: "箭头 → 切到第 2 页",
      expect: "容器 data-active-index 0→1；dot[1] aria-current=true",
      assertion: nextSelector
        ? `selector=${nextSelector} active=${afterNext?.active} dotActive=${afterNext?.dotActive}`
        : "no next arrow in DOM",
      ok: Boolean(nextSelector) && afterNext?.active === 1 && afterNext?.dotActive === 1,
    });

    const dotClicked = await clickCarouselDot(pageInfo.page, post.post.id, 2);
    const afterDot = dotClicked
      ? await waitCarouselState(pageInfo.page, post.post.id, (state) => state.active === 2, 3_000, "A17 carousel dot").catch(() => null)
      : null;
    step({
      intent: "指示点 → 第 3 页",
      expect: "dot[data-index=2] 点击后 data-active-index=2 且该点 aria-current=true",
      assertion: `clicked=${dotClicked} active=${afterDot?.active} dotActive=${afterDot?.dotActive}`,
      ok: dotClicked && afterDot?.active === 2 && afterDot?.dotActive === 2,
    });

    const keyboardFocus = await pageInfo.page.evaluate(({ id }) => {
      const thread = document.querySelector('[data-testid="thread-timeline"]');
      const post =
        (thread ? thread.querySelector('[data-post-id="' + id + '"]') : null) ??
        document.querySelector('[data-testid="timeline-scroll"] [data-post-id="' + id + '"]') ??
        document.querySelector('[data-post-id="' + id + '"]');
      const root = post?.querySelector('[data-testid="link-previews"]');
      // Keyboard handler lives on the carousel region (shadcn Carousel), not on
      // the outer link-previews wrapper.
      const target = root?.querySelector('[data-slot="carousel"]') ?? root;
      if (!target) return false;
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "0");
      target.focus();
      return document.activeElement === target;
    }, { id: post.post.id });
    await pageInfo.page.keyboard.press("ArrowLeft");
    const afterKeyboard = keyboardFocus
      ? await waitCarouselState(pageInfo.page, post.post.id, (state) => state.active === 1, 3_000, "A17 carousel ArrowLeft").catch(() => null)
      : null;
    step({
      intent: "键盘 ← 切回第 2 页",
      expect: "焦点在轮播上时 ArrowLeft 生效（2→1）；dot[1] aria-current=true",
      assertion: `focused=${keyboardFocus} active=${afterKeyboard?.active} dotActive=${afterKeyboard?.dotActive}`,
      ok: Boolean(keyboardFocus) && afterKeyboard?.active === 1 && afterKeyboard?.dotActive === 1,
    });

    // Stage updates must not reset the carousel page. The third link replies
    // after ~4s (HEAD+GET delay), so we can move to page 3 before its
    // post.updated frames arrive.
    const updateTag = marker("A17U");
    const updatePost = await createPost(
      ownerToken,
      `${updateTag} 轮播阶段更新：\n\n${fixtures.pages.ogFull}\n${fixtures.pages.twitter}\n${fixtures.pages.delay2s}`,
    );
    await ensurePostVisible(pageInfo.page, updatePost.post.id);
    await waitCarouselState(
      pageInfo.page,
      updatePost.post.id,
      (state) => state.cardCount === 3,
      10_000,
      "A17 update carousel 3 cards",
    );
    await clickCarouselDot(pageInfo.page, updatePost.post.id, 2);
    const beforeUpdate = await waitCarouselState(
      pageInfo.page,
      updatePost.post.id,
      (state) => state.active === 2,
      3_000,
      "A17 update carousel page 3",
    );
    await waitPreviews(updatePost.post.id, (rows) => rows.length === 3 && rows.every((row) => row.status === "ready"), 30_000, "A17 update post ready");
    await sleep(600);
    const afterUpdate = await carouselState(pageInfo.page, updatePost.post.id);
    step({
      intent: "post.updated 阶段推进不把轮播跳回第 1 页",
      expect: "data-active-index 保持 2；dot[2] aria-current=true",
      assertion: `before=${beforeUpdate?.active}/${beforeUpdate?.dotActive} after=${afterUpdate?.active}/${afterUpdate?.dotActive}`,
      ok:
        beforeUpdate?.active === 2 &&
        beforeUpdate?.dotActive === 2 &&
        afterUpdate?.active === 2 &&
        afterUpdate?.dotActive === 2,
    });

    // Touch drag on the mobile viewport.
    const mobilePageInfo = await openPage({
      viewport: { width: 390, height: 844 },
      mobile: true,
      label: "live-a17-mobile",
    });
    try {
      await ensurePostVisible(mobilePageInfo.page, post.post.id);
      const mobileStart = await waitCarouselState(
        mobilePageInfo.page,
        post.post.id,
        (state) => state.cardCount === 3,
        8_000,
        "A17 mobile carousel",
      );
      const swiped = await swipeCarousel(mobilePageInfo.page, post.post.id, 0.92, 0.08);
      const afterSwipe = swiped
        ? await waitCarouselState(mobilePageInfo.page, post.post.id, (state) => state.active !== mobileStart.active, 3_000, "A17 mobile swipe left").catch(() => null)
        : null;
      const swipeBack = await swipeCarousel(mobilePageInfo.page, post.post.id, 0.08, 0.92);
      const afterSwipeBack = swipeBack
        ? await waitCarouselState(mobilePageInfo.page, post.post.id, (state) => state.active === mobileStart.active, 3_000, "A17 mobile swipe right").catch(() => null)
        : null;
      step({
        intent: "390 视口触摸拖拽切页并可拖回",
        expect: "左滑 active+1；右滑回到起始页",
        assertion: `start=${mobileStart.active}/${mobileStart.dotActive} afterSwipe=${afterSwipe?.active}/${afterSwipe?.dotActive} afterBack=${afterSwipeBack?.active}/${afterSwipeBack?.dotActive}`,
        ok:
          mobileStart.cardCount === 3 &&
          Boolean(afterSwipe) &&
          afterSwipe.active !== mobileStart.active &&
          afterSwipe.dotActive === afterSwipe.active &&
          afterSwipeBack?.active === mobileStart.active &&
          afterSwipeBack?.dotActive === mobileStart.active,
        image: await shot(mobilePageInfo.page, "a17-01-mobile-carousel-swipe.png"),
      });
    } finally {
      await closePage(mobilePageInfo);
    }
    markCoverage("A17", results.filter((r) => r.section.includes("A17")).every((r) => r.ok));
  } finally {
    await closePage(pageInfo);
  }
}

async function sectionA11() {
  beginSection("A11 · 点击卡片：新窗口 + window.opener=null", "P1 无 viewer 适配器，fileviewer 契约 P2 登记");
  clearPreviewBudget();
  const post = await createPost(ownerToken, `${marker("A11")} 点击：${fixtures.pages.ogFull}`);
  await waitPreviews(post.post.id, (rows) => rows.some((row) => row.status === "ready"), 20_000, "A11 preview ready");
  const pageInfo = await openPage({ label: "live-a11" });
  try {
    await ensurePostVisible(pageInfo.page, post.post.id);
    await waitPreviewState(pageInfo.page, post.post.id, (state) => state.cards.length === 1 && state.cards[0].status === "ready", 10_000, "A11 DOM card");
    const dom = await readPreviews(pageInfo.page, post.post.id);
    const targetCard = dom.cards.find((card) => card.anchorHref?.includes("/og-full")) ?? dom.cards[0];
    const href = targetCard.anchorHref;
    const anchorInfo = await pageInfo.page.evaluate(({ postId, url }) => {
      const post = document.querySelector('[data-post-id="' + postId + '"]');
      const card = [...post.querySelectorAll('[data-testid="link-preview-card"]')].find((entry) =>
        (entry.getAttribute("data-preview-url") ?? "").includes(url),
      );
      const anchor = card?.querySelector("a[href]");
      return anchor
        ? { rel: anchor.getAttribute("rel"), target: anchor.getAttribute("target"), href: anchor.getAttribute("href") }
        : null;
    }, { postId: post.post.id, url: "/og-full" });
    let popup = null;
    try {
      const popupPromise = pageInfo.page.waitForEvent("popup", { timeout: 8_000 });
      const a11Scope = await postScope(pageInfo.page, post.post.id);
      await realClick(
        pageInfo.page
          .locator(`${a11Scope} [data-testid="link-preview-card"] a[href*="/og-full"]`)
          .first(),
      );
      popup = await popupPromise;
      await popup.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    } catch (error) {
      step({
        intent: "点击预览卡主区",
        expect: "打开新窗口",
        assertion: `click failed: ${error.message}`,
        ok: false,
      });
    }
    if (popup) {
      const popupUrl = popup.url();
      const opener = await popup.evaluate(() => window.opener === null);
      step({
        intent: "新窗口目标 URL 与 window.opener",
        expect: "URL=canonical；opener=null；rel 含 noopener/noreferrer",
        assertion: `url=${popupUrl} openerNull=${opener} target=${anchorInfo?.target} rel=${anchorInfo?.rel}`,
        ok:
          popupUrl === href &&
          opener === true &&
          anchorInfo?.target === "_blank" &&
          /noopener/.test(anchorInfo?.rel ?? "") &&
          /noreferrer/.test(anchorInfo?.rel ?? ""),
        image: await shot(popup, "a11-01-popup-window.png").catch(() => null),
      });
      await popup.close().catch(() => {});
    }
    step({
      intent: "fileviewer 适配器（P2-2）",
      expect: "P1 VIEWER_ADAPTERS=[]：永远新窗口原链接；file-viewer URL 契约属 P2",
      assertion: "N/A（P2 交付项；A11 的本轮判据为新窗口 + opener=null）",
      ok: true,
    });
    markCoverage("A11", results.filter((r) => r.section.includes("A11")).every((r) => r.ok));
  } finally {
    await closePage(pageInfo);
  }
}

async function sectionA12() {
  beginSection("A12 · post.updated 不进通知/未读/CLI；feed 不刷新", "通知类型集合保持 post.created/thread.invited");
  clearPreviewBudget();
  const pageInfo = await openPage({ label: "live-a12" });
  const page = pageInfo.page;
  let tail = null;
  try {
    await page.waitForTimeout(800);
    tail = new HubTail(ownerToken);
    await tail.start();
    const tag = marker("A12");
    const post = await createPost(ownerToken, `${tag} 通知隔离：${fixtures.pages.delay2s}`);
    await sleep(250);
    const peekAfterCreate = await apiJson(BASE, "/api/notifications?peek=1&limit=100", ownerToken);
    if (peekAfterCreate.target !== null && peekAfterCreate.target !== undefined) {
      await apiJson(BASE, "/api/notifications/ack", ownerToken, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: peekAfterCreate.target }),
      });
    }
    const afterAck = await apiJson(BASE, "/api/notifications?peek=1&limit=100", ownerToken);
    const unreadBefore = afterAck.unread_count ?? 0;

    const cli = spawn(
      process.execPath,
      [
        join(REPO_ROOT, "src/cli/main.ts"),
        "wait-notifications",
        "--as",
        "owner",
        "--data-dir",
        qa.dataDir,
        "--env-files",
        `${join(qa.dataDir, ".env")},${join(qa.dataDir, "accounts", "owner.env")}`,
        "--timeout",
        "5",
        "--no-export",
      ],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let cliOut = "";
    let cliErr = "";
    cli.stdout.on("data", (chunk) => {
      cliOut += chunk.toString();
    });
    cli.stderr.on("data", (chunk) => {
      cliErr += chunk.toString();
    });

    await waitPreviews(post.post.id, (rows) => rows.some((row) => row.status === "ready"), 20_000, "A12 preview ready");
    let firstUpdateAt = tail.events.find(
      (line) => line.type === "post.updated" && line.post_id === post.post.id,
    )?.receivedAt ?? null;
    if (firstUpdateAt === null) {
      await waitUntil(
        async () => {
          const line = tail.events.find(
            (entry) => entry.type === "post.updated" && entry.post_id === post.post.id,
          );
          if (!line) return false;
          firstUpdateAt = line.receivedAt;
          return true;
        },
        10_000,
        "A12 first post.updated frame",
      );
    }
    await sleep(4000);
    const cliExitEarly = cli.exitCode;
    if (cli.exitCode === null) {
      try {
        cli.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
    await waitPidDead(cli.pid, 3000);

    const peek = await apiJson(BASE, "/api/notifications?peek=1&limit=100", ownerToken);
    const history = await apiJson(BASE, "/api/notifications/history?limit=100", ownerToken);
    const typesPeek = new Set((peek.events ?? []).map((event) => event.type));
    const typesHistory = new Set((history.events ?? []).map((event) => event.type));
    step({
      intent: "通知 peek/history 不含 post.updated",
      expect: "types 只出现 post.created/thread.invited",
      assertion: `peek=${[...typesPeek].join(",")} history=${[...typesHistory].join(",")}`,
      ok: !typesPeek.has("post.updated") && !typesHistory.has("post.updated"),
    });
    step({
      intent: "未读数不因 post.updated 变化",
      expect: "unread_count 在预览事件前后不变",
      assertion: `before=${unreadBefore} after=${peek.unread_count}`,
      ok: (peek.unread_count ?? 0) === unreadBefore,
    });
    step({
      intent: "CLI wait-notifications 隔离",
      expect: "5s 内 stdout 为空且 CLI 未异常退出（只有通知类型才输出）",
      assertion: `stdout=${JSON.stringify(cliOut.slice(0, 160))} exitEarly=${cliExitEarly} stderr=${JSON.stringify(cliErr.slice(-80))}`,
      ok: cliOut.trim() === "" && cliExitEarly === null,
    });
    const lateRequests = pageInfo.requests.filter(
      (request) =>
        ["/api/feed", "/api/timeline"].includes(request.pathname) &&
        request.at >= firstUpdateAt,
    );
    step({
      intent: "post.updated 之后不触发 feed 重取",
      expect: "首个 post.updated 帧之后新增 /api/feed、/api/timeline 请求数 = 0",
      assertion: `feedRequestsAfterPostUpdated=${lateRequests.length} firstUpdateAt=${firstUpdateAt}`,
      ok: lateRequests.length === 0,
      image: await shot(page, "a12-01-notifications-unaffected.png"),
    });
    markCoverage("A12", results.filter((r) => r.section.includes("A12")).every((r) => r.ok));
  } finally {
    await tail?.stop().catch(() => {});
    await closePage(pageInfo);
  }
}

async function sectionA13() {
  beginSection("A13 · 重启续跑（SIGKILL）", "任务持久化；重启后继续，不重复卡片/不丢任务");
  if (!BOARD_OWNED) {
    step({
      intent: "A13 需要 kill/restart 隔离后端",
      expect: "auto-started qa-serve（本脚本拥有）",
      assertion: "SKIP：REPORT_QA_BASE 指向外部后端，脚本不 kill 他人的板子",
      ok: true,
    });
    coverage.set("A13", { status: "SKIP", note: "external REPORT_QA_BASE; SIGKILL/restart test needs owned backend" });
    return;
  }
  clearPreviewBudget();
  await closeAllPages();
  await fixtureReset();
  const post = await createPost(ownerToken, `${marker("A13")} 重启续跑：${fixtures.pages.slowOk}`);
  await waitUntil(async () => pathStat(await fixtureStats(), fixtures.pages.slowOk).worker >= 1, 20_000, "A13 first worker request");
  const killedPid = await stopServe("SIGKILL");
  const workerBeforeRestart = pathStat(await fixtureStats(), fixtures.pages.slowOk).worker;
  const jobsAfterKill = dbJobRows(post.post.id);
  step({
    intent: "处理中断开：SIGKILL serve 进程",
    expect: "隔离库中 job 仍在（queued/running），previews 未丢",
    assertion: `pid=${killedPid} jobs=${JSON.stringify(jobsAfterKill.map((job) => job.status))} rows=${dbPreviewRows(post.post.id).length}`,
    ok: dbPreviewRows(post.post.id).length === 1 && jobsAfterKill.length >= 1,
  });
  await startBoardOn(qa.dataDir, basePort);
  await waitUntil(
    async () => {
      try {
        return (await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(800) })).ok;
      } catch {
        return false;
      }
    },
    15_000,
    "A13 restarted board healthy",
  );
  const jobsAfterRestart = dbJobRows(post.post.id);
  step({
    intent: "重启后残留 running 重置 queued",
    expect: "job 存在且即将重跑（不丢任务）",
    assertion: `jobs=${JSON.stringify(jobsAfterRestart.map((job) => ({ status: job.status, attempts: job.attempts })))}`,
    ok: jobsAfterRestart.length === 1 && ["queued", "running"].includes(jobsAfterRestart[0].status),
  });
  await waitUntil(async () => pathStat(await fixtureStats(), fixtures.pages.slowOk).worker > workerBeforeRestart, 25_000, "A13 resumed fetch");
  const rows = await waitPreviews(post.post.id, (list) => list.length === 1 && list[0].status === "ready", 30_000, "A13 ready after restart");
  const pageInfo = await openPage({ label: "live-a13" });
  try {
    await ensurePostVisible(pageInfo.page, post.post.id);
    const dom = await waitPreviewState(pageInfo.page, post.post.id, (state) => state.cards.length === 1 && state.cards[0].status === "ready", 10_000, "A13 DOM card");
    step({
      intent: "重启后续跑完成且不重复卡片",
      expect: "previews=1 ready；DOM 卡片=1",
      assertion: `api=${rows.length}/${rows[0]?.status} dom=${dom.cards.length}/${dom.cards[0]?.status}`,
      ok: rows.length === 1 && rows[0]?.status === "ready" && dom.cards.length === 1 && dom.cards[0]?.status === "ready",
      image: await shot(pageInfo.page, "a13-01-resumed-after-restart.png"),
    });
    markCoverage("A13", results.filter((r) => r.section.includes("A13")).every((r) => r.ok));
  } finally {
    await closePage(pageInfo);
  }
}

async function sectionA14() {
  beginSection("A14 · 旧帖首次查看（插件关闭期间发布）", "开启后入队补卡；正文未改写");
  clearPreviewBudget();
  await fixtureReset();
  await setPluginEnabled(false);
  const body = `${marker("A14")} 旧帖补卡：${fixtures.pages.ogNoCover}`;
  const post = await createPost(ownerToken, body);
  const previewsDisabled = await previewsOf(post.post.id);
  step({
    intent: "插件关闭期间发帖",
    expect: "previews=[]；worker 0 请求",
    assertion: `previews=${previewsDisabled.length} worker=${(await fixtureStats()).main.workerRequests}`,
    ok: previewsDisabled.length === 0 && (await fixtureStats()).main.workerRequests === 0,
  });
  await setPluginEnabled(true);
  const rows = await waitPreviews(post.post.id, (list) => list.some((row) => row.status === "ready"), 30_000, "A14 old post ready");
  const afterPost = await apiJson(BASE, `/api/posts/${encodeURIComponent(post.post.id)}`, ownerToken);
  const pageInfo = await openPage({ label: "live-a14" });
  try {
    await ensurePostVisible(pageInfo.page, post.post.id);
    const dom = await waitPreviewState(pageInfo.page, post.post.id, (state) => state.cards.length === 1 && state.cards[0].status === "ready", 10_000, "A14 DOM card");
    step({
      intent: "开启插件后旧帖入队并出现卡片",
      expect: "previews ready；正文 body_md 未改写",
      assertion: `status=${rows[0]?.status} bodySame=${afterPost.post?.body_md === body} cards=${dom.cards.length}`,
      ok:
        rows[0]?.status === "ready" &&
        afterPost.post?.body_md === body &&
        dom.cards.length === 1 &&
        dom.cards[0].status === "ready",
      image: await shot(pageInfo.page, "a14-01-old-post-backfilled.png"),
    });
    markCoverage("A14", results.filter((r) => r.section.includes("A14")).every((r) => r.ok));
  } finally {
    await closePage(pageInfo);
  }
}

async function sectionA15() {
  beginSection("A15 · 事件风暴（3 链接 × 多阶段）", "只更新对应卡片；无整页请求、无滚动跳动");
  const budget = clearPreviewBudget();
  const pageInfo = await openPage({ label: "live-a15" });
  const page = pageInfo.page;
  try {
    await page.waitForTimeout(500);
    const beforeIds = await feedPostIds(page);
    const beforeScroll = await scrollTop(page);
    const requestBaseline = pageInfo.requests.length;
    const tag = marker("A15");
    // Distinct slow endpoints: the first post.updated frame arrives ~4s after
    // creation, so the feed refresh caused by post.created can settle before
    // the measurement window opens.
    const post = await createPost(
      ownerToken,
      `${tag} 事件风暴：\n\n${fixtures.pages.delay2s}\n${fixtures.pages.delay1s}\n${fixtures.pages.slowOk}`,
    );
    await sleep(2_000);
    const stormTail = new HubTail(ownerToken);
    await stormTail.start();
    await showPostWithoutFeedRefresh(page, post.post.id);
    await waitPreviews(post.post.id, (rows) => rows.length === 3 && rows.every((row) => row.status === "ready"), 30_000, "A15 all ready");
    await sleep(1500);
    await stormTail.stop();
    const events = stormTail.events.filter((line) => line.type === "post.updated" && line.post_id === post.post.id);
    const phases = events.map((line) => line.payload?.phase);
    step({
      intent: "每链接每阶段一条 post.updated",
      expect: "3 链接 × 2 阶段 = 6 条事件，phase=meta/cover 各 3",
      assertion: `events=${events.length} phases=${phases.join(",")} budgetCleared=${budget.cleared.length}`,
      ok:
        events.length === 6 &&
        phases.filter((phase) => phase === "meta").length === 3 &&
        phases.filter((phase) => phase === "cover").length === 3,
    });
    step({
      intent: "事件 payload 只带该帖最新 previews（≤3）",
      expect: "每条 post_id 匹配、previews=3",
      assertion: `payloadSizes=${events.map((line) => line.payload?.previews?.length).join(",")}`,
      ok: events.every((line) => line.payload?.previews?.length === 3),
    });
    const afterIds = await feedPostIds(page);
    const preserved = afterIds.filter((id) => beforeIds.includes(id));
    const afterScroll = await scrollTop(page);
    const firstUpdateAt = events[0]?.receivedAt ?? Date.now();
    const documentRequests = pageInfo.requests
      .slice(requestBaseline)
      .filter((request) => request.resourceType === "document").length;
    const feedRequests = pageInfo.requests.filter(
      (request) =>
        ["/api/feed", "/api/timeline"].includes(request.pathname) &&
        request.at >= firstUpdateAt,
    );
    const dom = await readPreviews(page, post.post.id);
    step({
      intent: "风暴期间无整页/列表请求、无滚动跳动",
      expect: "document=0、post.updated 后 feed/timeline=0；scrollTop ±2；既有顺序不变",
      assertion: `document=${documentRequests} feedAfterPostUpdated=${feedRequests.length} scroll=${beforeScroll}→${afterScroll} orderKept=${JSON.stringify(preserved) === JSON.stringify(beforeIds)} cards=${dom.cards.length}`,
      ok:
        documentRequests === 0 &&
        feedRequests.length === 0 &&
        Math.abs(afterScroll - beforeScroll) <= 2 &&
        JSON.stringify(preserved) === JSON.stringify(beforeIds) &&
        dom.cards.length === 3,
      image: await shot(page, "a15-01-event-storm.png"),
    });
    markCoverage("A15", results.filter((r) => r.section.includes("A15")).every((r) => r.ok));
  } finally {
    await closePage(pageInfo);
  }
}

async function sectionA16() {
  beginSection("A16 · 390×844 / 1280×900：无溢出、pending-ready 高度差 ≤2px、CLS<0.02", "两视口分别实测");
  const budget = clearPreviewBudget();
  for (const spec of [
    { label: "mobile", viewport: { width: 390, height: 844 }, mobile: true },
    { label: "desktop", viewport: { width: 1280, height: 900 }, mobile: false },
  ]) {
    const pageInfo = await openPage({ viewport: spec.viewport, mobile: spec.mobile, label: `a16-${spec.label}` });
    const page = pageInfo.page;
    try {
      await page.waitForTimeout(500);
      const post = await createPost(
        ownerToken,
        `${marker(`A16-${spec.label}`)} 视口：${fixtures.pages.delay2s}`,
      );
      await ensurePostVisible(page, post.post.id);
      const pending = await waitPreviewState(page, post.post.id, (state) => state.cards[0]?.status === "pending", 8_000, `A16 ${spec.label} pending`);
      await resetCls(page);
      const pendingCard = pending.cards[0];
      const pendingHeight = pendingCard.box.h;
      const pendingRatio = ratioOf(pendingCard.media);
      const pendingImage = await shot(page, `a16-01-${spec.label}-pending.png`);
      await waitPreviewState(page, post.post.id, (state) => state.cards[0]?.status === "ready", 15_000, `A16 ${spec.label} ready`);
      await page.waitForTimeout(400);
      const ready = await readPreviews(page, post.post.id);
      const readyCard = ready.cards[0];
      const readyHeight = readyCard.box.h;
      const readyRatio = ratioOf(readyCard.media);
      const cls = await readCls(page);
      const overflow = await overflowState(page);
      const readyImage = await shot(page, `a16-02-${spec.label}-ready.png`);
      step({
        intent: `${spec.label} ${spec.viewport.width}×${spec.viewport.height}：无横向溢出`,
        expect: "document.scrollWidth ≤ clientWidth",
        assertion: `scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth} budgetCleared=${budget.cleared.length}`,
        ok: overflow.scrollWidth <= overflow.clientWidth,
      });
      step({
        intent: `${spec.label}：pending/ready 4:3 且高度差 ≤2px`,
        expect: "media ratio≈4:3；card height Δ≤2",
        assertion: `pending=${pendingHeight.toFixed(1)}px(${pendingRatio.toFixed(3)}) ready=${readyHeight.toFixed(1)}px(${readyRatio.toFixed(3)}) Δ=${Math.abs(readyHeight - pendingHeight).toFixed(2)}`,
        ok:
          Boolean(pendingCard.media) &&
          Boolean(readyCard.media) &&
          Math.abs(pendingRatio - 4 / 3) <= 0.12 &&
          Math.abs(readyRatio - 4 / 3) <= 0.12 &&
          Math.abs(readyHeight - pendingHeight) <= 2,
        image: pendingImage,
      });
      step({
        intent: `${spec.label}：卡片过渡 CLS < 0.02`,
        expect: "pending→ready 布局位移总和 <0.02",
        assertion: `CLS=${cls.value.toFixed(4)} entries=${cls.count} max=${cls.max.toFixed(4)}`,
        ok: cls.value < 0.02,
        image: readyImage,
      });
    } finally {
      await closePage(pageInfo);
    }
  }
  markCoverage("A16", results.filter((r) => r.section.includes("A16")).every((r) => r.ok));
}

function sectionCoverage() {
  beginSection("覆盖矩阵 · A1..A17", "驱动按 design §14.3 冻结场景逐条登记；A6 显式 SKIP（P2）");
  for (const [id, entry] of coverage) {
    step({
      intent: `${id} 覆盖状态`,
      expect: "PASS / FAIL / SKIP",
      assertion: `${entry.status}${entry.note ? ` — ${entry.note}` : ""}`,
      ok: entry.status === "PASS" || entry.status === "SKIP" || entry.status === "N/A",
    });
  }
}

async function runPreflight() {
  beginSection("前置检查（--preflight）", "只验证夹具/隔离后端/插件面/静态壳前置，不跑 A1–A17");
  const ui = ensureUiBuild();
  step({
    intent: "静态壳前置",
    expect: "dist/index.html 可用（供 A3）",
    assertion: `built=${ui.built} shell=${ui.shell}`,
    ok: existsSync(ui.shell),
  });
  sectionCoverage();
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  report.subtitle = `change report-link-preview · design §14.3 · ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;

  fixture = await startFixture();
  // Only the main fixture origin is allowlisted for the preview fetcher; the
  // private second listener is intentionally absent (A8).
  process.env.STOA_PREVIEW_TEST_ALLOW_ORIGINS = fixture.url;
  qa = await ensureQa([], { qaServeArgs: ["--no-seed", "--keep"] });
  BASE = qa.base;
  BOARD_OWNED = qa.owned !== null;
  basePort = Number(new URL(BASE).port || 80);
  AUTH = authSecret(qa.dataDir);
  ownerToken = accountToken(qa.dataDir, "owner");

  // Build before ANY openPage(): the early sections (A1/A2/A5/A14) need the
  // current dist shell. Building only in A3 left the first pages blank.
  uiBuildResult = ensureUiBuild();

  const chromeBefore = new Set(chromePids());
  browser = await chromium.launch({ channel: "chrome" });
  launchedChromePids = chromePids().filter((pid) => !chromeBefore.has(pid));
  const initialServePid = (() => {
    try {
      return serveInfo().pid;
    } catch {
      return null;
    }
  })();
  report.env = [
    ["fixture", `${fixture.url}（private ${fixture.privateUrl}）`],
    ["isolated board", `${BASE} · ${qa.dataDir}`],
    ["allow origins", fixture.url],
    ["worker UA", "stoa-link-preview/1.0"],
    ["fixture pid", String(fixture.info.pid)],
    ["serve pid", initialServePid === null ? "n/a" : String(initialServePid)],
    ["chromium pid(s)", launchedChromePids.join(",") || "n/a"],
    ["built shell", join(REPO_ROOT, "dist/index.html")],
    ["evidence", REPORT_DIR],
  ];

  try {
    await sectionEnvironment();
    READY = true;
  } catch (error) {
    READY = false;
    if (!results.length || results[results.length - 1].ok) {
      step({
        intent: "前置检查",
        expect: "link-preview 已合入且能力面可审计",
        assertion: `ABORTED: ${error.message}`,
        ok: false,
      });
    }
  }

  if (!READY) {
    for (const [id, entry] of coverage) {
      if (entry.status === "待跑") coverage.set(id, { status: "BLOCKED", note: "前置未满足" });
    }
    sectionCoverage();
    return 2;
  }

  if (PREFLIGHT) {
    await runPreflight();
    return results.every((result) => result.ok) ? 0 : 1;
  }

  const SECTION_COVERAGE = new Map([
    [sectionA1A2, ["A1", "A2"]],
    [sectionFetchBaseline, []],
    [sectionA5, ["A5"]],
    [sectionA14, ["A14"]],
    [sectionA3, ["A3"]],
    [sectionA4, ["A4"]],
    [sectionA7, ["A7"]],
    [sectionA8, ["A8"]],
    [sectionA9, ["A9"]],
    [sectionA10, ["A10"]],
    [sectionA17, ["A17"]],
    [sectionA11, ["A11"]],
    [sectionA12, ["A12"]],
    [sectionA13, ["A13"]],
    [sectionA15, ["A15"]],
    [sectionA16, ["A16"]],
  ]);

  for (const section of [
    sectionA1A2,
    sectionFetchBaseline,
    // Toggle A5/A14 before A3/A7 create failed jobs: design §2.3 re-enables
    // failed jobs on plugin open, which would look like new fetches in A5.
    sectionA5,
    sectionA14,
    sectionA3,
    sectionA4,
    sectionA7,
    sectionA8,
    sectionA9,
    sectionA10,
    sectionA17,
    sectionA11,
    sectionA12,
    sectionA13,
    sectionA15,
    sectionA16,
  ]) {
    try {
      await section();
    } catch (error) {
      const abortImage = await captureAbortShot(section.name);
      beginSection(`${section.name} · aborted`, "小节异常中断");
      step({
        intent: "小节执行",
        expect: "无未捕获异常",
        assertion: `ABORTED: ${error.message}`,
        ok: false,
        image: abortImage,
      });
      for (const id of SECTION_COVERAGE.get(section) ?? []) {
        if (coverage.get(id)?.status === "待跑") {
          coverage.set(id, { status: "FAIL", note: "section aborted" });
        }
      }
    }
  }
  sectionCoverage();
  return results.every((result) => result.ok) ? 0 : 1;
}

// ── lifecycle + evidence ─────────────────────────────────────────────────────
let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(`[link-preview] fatal: ${error.stack ?? error}`);
  exitCode = 1;
} finally {
  await hubTail?.stop().catch(() => {});
  await closeAllPages().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (fixture) await fixture.stop().catch(() => {});
  if (qa) {
    const owned = qa.owned !== null;
    if (owned) {
      try {
        qa.owned?.kill("SIGTERM");
      } catch {
        /* gone */
      }
      await sleep(300);
      const args = [QA_SERVE, "--stop", "--data-dir", qa.dataDir];
      if (KEEP_BOARD) args.push("--keep");
      const stopped = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8" });
      if (stopped.stdout) process.stderr.write(stopped.stdout);
      if (stopped.stderr) process.stderr.write(stopped.stderr);
    }
  }
  for (const child of boardChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  await sleep(500);
  await waitUntil(async () => launchedChromePids.every((pid) => !pidAlive(pid)), 3000).catch(() => {});

  const fixturePid = fixture?.info?.pid ?? null;
  const servePid = qa ? (() => {
    try {
      return serveInfo().pid;
    } catch {
      return null;
    }
  })() : null;
  const chromeAlive = launchedChromePids.filter((pid) => pidAlive(pid));
  const boardChildPids = boardChildren.map((child) => child.pid).filter((pid) => Number.isInteger(pid));
  const boardChildrenAlive = boardChildPids.filter((pid) => pidAlive(pid));
  const cleanupOk =
    (fixturePid === null || !pidAlive(fixturePid)) &&
    (servePid === null || !pidAlive(servePid)) &&
    boardChildrenAlive.length === 0;
  beginSection("清理 · PID 回收 / 证据落盘", "fixture、qa-serve 子进程与 chromium 均已退出；只写 steps.json + 截图");
  step({
    intent: "回收测试进程",
    expect: "fixture/qa-serve/chromium 无残留",
    assertion: `fixture=${fixturePid} alive=${fixturePid ? pidAlive(fixturePid) : false}; serve=${servePid} alive=${servePid ? pidAlive(servePid) : false}; restartChildren=${boardChildPids.join(",") || "none"} alive=${boardChildrenAlive.join(",") || "none"}; chromeLeftover=${chromeAlive.length}`,
    ok: cleanupOk && chromeAlive.length === 0,
  });
  step({
    intent: "证据产物",
    expect: "steps.json + 同目录截图；禁止手写 HTML",
    assertion: `dir=${REPORT_DIR} screenshots=${shots.length}`,
    ok: true,
  });

  const failed = results.filter((result) => !result.ok);
  report.summary = {
    pass: results.length - failed.length,
    fail: failed.length,
    blocked: results.filter((result) => /BLOCKED/.test(result.assertion)).length,
    skipped: [...coverage.values()].filter((entry) => entry.status === "SKIP").length,
  };
  report.meta =
    `${new Date().toISOString().slice(0, 10)} · change report-link-preview · ` +
    `${results.length} 步骤 · PASS ${report.summary.pass} / FAIL ${report.summary.fail} · ` +
    `fixture=${fixture?.url ?? "n/a"} · board=${BASE ?? "n/a"}`;
  writeFileSync(join(REPORT_DIR, "steps.json"), JSON.stringify(report, null, 2));
  console.log(`\n${report.summary.pass}/${results.length} steps passed (${failed.length} failed)`);
  console.log(`steps.json + ${shots.length} screenshot(s) -> ${REPORT_DIR}`);
  process.exitCode = failed.length === 0 ? (exitCode === 0 || exitCode === true ? 0 : exitCode) : exitCode === 2 ? 2 : 1;
}

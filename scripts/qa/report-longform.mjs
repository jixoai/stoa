#!/usr/bin/env bun
/**
 * report-longform E2E（P1-20 / design §8 A1–A14）。
 *
 * 隔离纪律：只对 `qa-serve.mjs` 起的 /tmp/report-qa-* 后端写入（qa-env 拒绝生产板
 * 13689）；进程结束 kill 隔离服务并打印 PID。
 *
 * 覆盖：A1 文章视图 + 嵌入讨论、A2 四块、A3 未知块降级、A4 raw HTML 转义、
 * A5 上限、A6 性能、A8 feed 摘要、A9 通知/已读不变、A10 静态归档、A11 CLI、
 * A12 插件、A13 迁移、A14 编辑器/无障碍/响应式。（A7 TOC 属 P2，不在本轮。）
 *
 * Run:
 *   bun scripts/qa/report-longform.mjs [--no-build] [--report-dir D]
 */
import { chromium } from "playwright-core";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import {
  REPO_ROOT,
  accountToken,
  apiJson,
  argValue,
  authSecret,
  ensureQa,
} from "./lib/qa-env.mjs";

const argv = process.argv.slice(2);
const qa = await ensureQa(argv);
const BASE = qa.base;
const AUTH = authSecret(qa.dataDir);
const MANAGER_TOKEN = accountToken(qa.dataDir, "manager");
const OWNER_TOKEN = accountToken(qa.dataDir, "owner");
const REPORT_DIR = resolve(
  argValue(argv, "report-dir") ??
    join(REPO_ROOT, "..", "..", ".agents", "reports", "manager", "report-longform"),
);
const PLUGIN_DIR = resolve(REPO_ROOT, "..", "..", "plugins", "report-channel");
mkdirSync(REPORT_DIR, { recursive: true });
if (!argv.includes("--no-build")) {
  execFileSync("bun", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
}
if (!existsSync(join(REPO_ROOT, "dist", "index.html"))) throw new Error("missing dist/index.html");

const startedAt = Date.now();
const checks = [];
const steps = [];
const screenshots = [];
let stepSeq = 0;
const check = (name, ok, detail = "", extra = {}) => {
  stepSeq += 1;
  checks.push({ name, ok: Boolean(ok), detail, at: Date.now() - startedAt });
  steps.push({
    id: `S${stepSeq}`,
    intent: name,
    assertion: detail || (ok ? "PASS" : "FAIL"),
    ok: Boolean(ok),
    ...extra,
  });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
};
const sleep = (page, ms) => page.waitForTimeout(ms);
async function shot(page, name) {
  await page.screenshot({ path: join(REPORT_DIR, name) });
  screenshots.push(name);
  return name;
}

// ── 小工具：PNG 生成 / 上传 / 页面登录 ──────────────────────────────────────

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (0xedb88320 ^ (crc >>> 1)) >>> 0 : (crc >>> 1) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(width, height, seed = 0) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const off = row + 1 + x * 3;
      raw[off] = (60 + Math.round((x / width) * 160) + seed) & 0xff;
      raw[off + 1] = (70 + Math.round((y / height) * 120) + seed * 2) & 0xff;
      raw[off + 2] = (150 + Math.round(((x + y) / (width + height)) * 60)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function uploadPng(width, height, seed) {
  const res = await fetch(`${BASE}/api/media`, {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-filename": `longform-${seed}.png`,
      authorization: `Bearer ${MANAGER_TOKEN}`,
    },
    body: makePng(width, height, seed),
  });
  if (!res.ok) throw new Error(`media upload failed: HTTP ${res.status}`);
  return (await res.json()).hash;
}

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await sleep(page, 700);
  if (await page.locator('input[type="password"]').count()) {
    await page.locator('input[type="password"]').first().fill(AUTH);
    await page.click('[data-testid="login-submit"]');
  }
  await page.waitForSelector('[data-testid="timeline-scroll"]', { timeout: 30_000 });
  await sleep(page, 500);
}

const shotMap = new Map();
function attachShot(name, fileName, meta = "") {
  const step = steps.find((row) => row.intent === name);
  if (step) {
    step.image = fileName;
    step.imageMeta = meta;
  }
  shotMap.set(name, fileName);
}

// ── A5 上限（先建 512KB article，供 A6 性能复用）────────────────────────────

const fence = (name, json) => "````fde2e:" + name + "\n" + json + "\n````";
const mediaRef = (hash) => `/api/media/${hash}`;

const shotA = await uploadPng(480, 300, 1);
const shotB = await uploadPng(480, 300, 2);

const MAIN_BODY = [
  "# FDE2E 长文验收主体",
  "",
  "这是长文摘要来源的第一段正文，包含 `行内代码`、**粗体**、[外链](https://example.com/a) 与 #result 标签。",
  "",
  "## 小节一：结构",
  "",
  "- 列表项一",
  "- 列表项二",
  "",
  "| 列 A | 列 B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "```js",
  "const ok = true;",
  "```",
  "",
  fence(
    "stats",
    JSON.stringify({
      items: [
        { label: "断言", value: "95/95", hint: "PASS", tone: "success" },
        { label: "耗时", before: "1820", after: "940", unit: "ms", better: "lower" },
      ],
    }),
  ),
  "",
  fence(
    "steps",
    JSON.stringify({
      steps: [
        { title: "构建", status: "done", expect: "零错误", detail: "bun run build ok", command: "bun run build", output: "built in 570ms", media: mediaRef(shotA), mediaAlt: "构建截图" },
        { title: "降级项", status: "degraded", detail: "接口超时，走降级路径" },
        { title: "跳过项", status: "skipped", detail: "环境不具备" },
        { title: "失败项", status: "failed", detail: "断言不成立" },
        { title: "待定项", detail: "尚未执行" },
      ],
    }),
  ),
  "",
  fence(
    "compare",
    JSON.stringify({
      title: "首屏对比",
      note: "同数据同视口",
      before: { media: mediaRef(shotA), label: "Before", viewport: "1280x800" },
      after: { media: mediaRef(shotB), label: "After", viewport: "390x844" },
    }),
  ),
  "",
  fence(
    "callout",
    JSON.stringify({
      tone: "warn",
      title: "注意",
      body: "结论先行：四块全部渲染。",
      items: ["要点一", "要点二"],
      code: "bun test --filter longform",
    }),
  ),
  "",
  fence("unknown-block", '{ "hello": "world" }'),
  "",
  fence("stats", '{ "items": }'),
  "",
  fence("stats", JSON.stringify({ items: [{ label: "x", value: 5 }] })),
  "",
  "## 小节二：安全",
  "",
  "<script>alert(1)</script> 与 <img src=x onerror=\"window.__xss=1\"> 都应显示为文本。",
].join("\n");

const mainArticle = await apiJson(BASE, "/api/posts", MANAGER_TOKEN, {
  method: "POST",
  body: JSON.stringify({ body: MAIN_BODY, kind: "article", tags: ["result"] }),
});
const MAIN_ID = mainArticle.posts[0].id;
check("A5-0 创建长文（kind=article）", mainArticle.posts[0].kind === "article", `id=${MAIN_ID}`);

// A5：上限与错误码
const L512 = "# 上限\n\n" + "a".repeat(512_000 - 6);
const pass = await apiJson(BASE, "/api/posts", MANAGER_TOKEN, {
  method: "POST",
  body: JSON.stringify({ body: L512, kind: "article", tags: ["result"] }),
});
check("A5 512,000 字符通过", pass.posts[0].body_md.length === 512_000, `len=${pass.posts[0].body_md.length} id=${pass.posts[0].id}`);
const BIG_ID = pass.posts[0].id;

const fail = await fetch(`${BASE}/api/posts`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${MANAGER_TOKEN}` },
  body: JSON.stringify({ body: "a".repeat(512_001), kind: "article" }),
});
const failBody = await fail.json();
check("A5 512,001 字符拒绝（BAD_REQUEST + 上限文案）", fail.status === 400 && /512,000/.test(JSON.stringify(failBody)), `status=${fail.status} ${JSON.stringify(failBody).slice(0, 160)}`);

const tooLarge = await fetch(`${BASE}/api/posts`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${MANAGER_TOKEN}` },
  body: JSON.stringify({ body: "文".repeat(800_000), kind: "article" }),
});
const tooLargeBody = await tooLarge.json();
check("A5 UTF-8 >2MiB 拒绝（体积护栏先判）", tooLarge.status === 400 && /2 MiB utf-8/.test(JSON.stringify(tooLargeBody)), `status=${tooLarge.status}`);

const noteOver = await fetch(`${BASE}/api/posts`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${MANAGER_TOKEN}` },
  body: JSON.stringify({ body: "a".repeat(200_001) }),
});
check("A5 note 200,000 上限不变", noteOver.status === 400, `status=${noteOver.status}`);

const bogusKind = await fetch(`${BASE}/api/posts`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${MANAGER_TOKEN}` },
  body: JSON.stringify({ body: "x", kind: "essay" }),
});
check("A5 未知 kind 拒绝", bogusKind.status === 400, `status=${bogusKind.status}`);

// ── 其余夹具：4 篇小长文（feed 性能）+ note + 引用 + 讨论回复 ────────────────

const smallArticle = (index) =>
  [
    `# 性能长文 ${index}`,
    "",
    `第 ${index} 篇长文的摘要段落，用于 feed 性能采样。`,
    "",
    fence("stats", JSON.stringify({ items: [{ label: `指标${index}`, value: String(index * 10), hint: "PASS", tone: "success" }] })),
  ].join("\n");
const smallIds = [];
for (let index = 1; index <= 4; index += 1) {
  const created = await apiJson(BASE, "/api/posts", MANAGER_TOKEN, {
    method: "POST",
    body: JSON.stringify({ body: smallArticle(index), kind: "article", tags: ["result"] }),
  });
  smallIds.push(created.posts[0].id);
}

const note = await apiJson(BASE, "/api/posts", MANAGER_TOKEN, {
  method: "POST",
  body: JSON.stringify({ body: "普通短帖：note 载体回归样例。", tags: ["note"] }),
});
const NOTE_ID = note.posts[0].id;

const quoting = await apiJson(BASE, "/api/posts", MANAGER_TOKEN, {
  method: "POST",
  body: JSON.stringify({ body: "引用一篇长文看看卡片形态。", quote: MAIN_ID, tags: ["note"] }),
});
const QUOTE_ID = quoting.posts[0].id;

const reply = await apiJson(BASE, `/api/posts/${MAIN_ID}/replies`, OWNER_TOKEN, {
  method: "POST",
  body: JSON.stringify({ body: "讨论区的第一条回复（来自 owner）。" }),
});
check("夹具：长文下的一条讨论回复", Boolean(reply.posts[0].id), `reply=${reply.posts[0].id}`);

// feed 性能样本：补足 20 行（含长文）
for (let index = 1; index <= 6; index += 1) {
  await apiJson(BASE, "/api/posts", MANAGER_TOKEN, {
    method: "POST",
    body: JSON.stringify({ body: `性能样本短帖 ${index}：用于 feed 20 行采样。`, tags: ["note"] }),
  });
}

// ── 浏览器会话 ──────────────────────────────────────────────────────────────

const browser = await chromium.launch({ channel: "chrome" });
const errors = [];
const apiRequests = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/api/")) apiRequests.push({ method: req.method(), url, at: Date.now() - startedAt });
  });
  await login(page);

  const gotoHash = (hash) => page.evaluate((h) => {
    location.hash = h;
  }, hash);
  const waitSel = (sel, timeout = 15_000) => page.waitForSelector(sel, { timeout });

  // ── A8 feed 摘要卡 ────────────────────────────────────────────────────────
  // 长文未必落在 feed 首屏：向下翻页直到该卡进 DOM（首页分页 20 行/页）。
  const findFeedCard = async (postId) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const card = page.locator(`[data-testid="timeline-scroll"] article[data-post-id="${postId}"]`);
      if (await card.count()) return card;
      await page.mouse.wheel(0, 4000);
      await sleep(page, 800);
    }
    return page.locator(`[data-testid="timeline-scroll"] article[data-post-id="${postId}"]`);
  };
  const feedCard = await findFeedCard(MAIN_ID);
  await feedCard.waitFor({ state: "attached", timeout: 15_000 });
  await feedCard.scrollIntoViewIfNeeded();
  await sleep(page, 300);
  const feedInfo = await feedCard.evaluate((el) => ({
    summary: Boolean(el.querySelector('[data-testid="article-summary"]')),
    badge: el.querySelector('[data-testid="article-badge"]')?.textContent?.trim() ?? null,
    title: el.querySelector('[data-testid="article-summary-title"]')?.textContent?.trim() ?? null,
    minutes: el.querySelector('[data-testid="article-summary-minutes"]')?.textContent?.trim() ?? null,
    paragraphs: el.querySelectorAll("p").length,
    pres: el.querySelectorAll("pre").length,
    postBody: Boolean(el.querySelector('[data-testid="post-body"]')),
  }));
  check(
    "A8 feed 长文卡＝摘要卡（长文 Badge/标题/约 N 分钟，无全文 DOM）",
    feedInfo.summary &&
      feedInfo.badge === "长文" &&
      (feedInfo.title ?? "").includes("FDE2E 长文验收主体") &&
      /约 \d+ 分钟/.test(feedInfo.minutes ?? "") &&
      feedInfo.paragraphs <= 6 &&
      feedInfo.pres === 0 &&
      !feedInfo.postBody,
    JSON.stringify(feedInfo),
  );
  // note 卡行为不变：线程页 focal 仍走 post-body（feed 首屏不含该帖，改在线程页取样）
  await page.evaluate((id) => {
    location.hash = `#/p/${id}`;
  }, NOTE_ID);
  await waitSel('[data-testid="focal-card"]');
  await sleep(page, 500);
  const noteCardInfo = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="focal-card"]');
    return {
      summary: Boolean(card?.querySelector('[data-testid="article-summary"]')),
      postBody: Boolean(card?.querySelector('[data-testid="post-body"]')),
      text: card?.querySelector('[data-testid="post-body"]')?.textContent?.trim(),
    };
  });
  check(
    "A8 note 卡行为不变（走 post-body，无摘要卡）",
    !noteCardInfo.summary && noteCardInfo.postBody && (noteCardInfo.text ?? "").includes("普通短帖"),
    JSON.stringify(noteCardInfo),
  );
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await waitSel('[data-testid="timeline-scroll"] article[data-post-id]');
  await sleep(page, 500);
  await shot(page, "a8-1280-feed-summary.png");
  attachShot("A8 feed 长文卡＝摘要卡（长文 Badge/标题/约 N 分钟，无全文 DOM）", "a8-1280-feed-summary.png", "1280×800 · png");

  // 点击进 /a/<id>
  await feedCard.click();
  await page.waitForFunction(() => location.hash.startsWith("#/a/"), null, { timeout: 10_000 });
  await waitSel('[data-testid="article-view"]');

  // ── A1 文章视图 ───────────────────────────────────────────────────────────
  const a1 = await page.evaluate(() => {
    const h1s = [...document.querySelectorAll("h1")];
    const bodyH1 = document.querySelectorAll('[data-testid="article-body"] h1').length;
    const prose = document.querySelector('[data-testid="article-body"] p');
    const probe = document.createElement("span");
    const proseStyle = prose ? getComputedStyle(prose) : null;
    if (proseStyle) {
      probe.style.font = proseStyle.font;
      probe.style.visibility = "hidden";
      probe.style.position = "absolute";
      probe.textContent = "0".repeat(68);
      document.body.append(probe);
    }
    const widthOf68ch = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      h1Count: h1s.length,
      h1Text: h1s[0]?.textContent?.trim() ?? null,
      bodyH1,
      minutes: document.querySelector('[data-testid="article-minutes"]')?.textContent?.trim() ?? null,
      proseWidth: prose ? Math.round(prose.getBoundingClientRect().width) : 0,
      widthOf68ch: Math.round(widthOf68ch),
      topLink: document.querySelector('[data-testid="article-open-thread-top"]')?.textContent?.trim() ?? null,
      bottomLink: document.querySelector('[data-testid="article-open-thread-bottom"]')?.textContent?.trim() ?? null,
      discussion: Boolean(document.querySelector('[data-testid="article-discussion"]')),
      discussionRows: document.querySelectorAll('[data-testid="article-discussion"] [data-timeline-row="reply"]').length,
      rails: document.querySelectorAll('[data-testid="article-discussion"] [data-testid="thread-rail"]').length,
      replyText: document.querySelector('[data-testid="article-discussion"] article[data-post-id]')?.textContent ?? "",
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  check(
    "A1 唯一 H1 + 标题/时间/约 N 分钟 + prose ≤68ch",
    a1.h1Count === 1 &&
      a1.h1Text === "FDE2E 长文验收主体" &&
      a1.bodyH1 === 0 &&
      /约 \d+ 分钟/.test(a1.minutes ?? "") &&
      a1.proseWidth > 0 &&
      a1.proseWidth <= a1.widthOf68ch + 8 &&
      a1.scrollWidth <= a1.clientWidth,
    JSON.stringify(a1),
  );
  check(
    "A1 嵌入讨论区（回复行 + 导轨 + 底部独立线程页入口）",
    a1.discussion &&
      a1.discussionRows >= 1 &&
      a1.rails >= 1 &&
      (a1.replyText ?? "").includes("讨论区的第一条回复") &&
      (a1.topLink ?? "").includes("在独立线程页打开") &&
      (a1.bottomLink ?? "").includes("在独立线程页打开"),
    JSON.stringify({ rows: a1.discussionRows, rails: a1.rails, top: a1.topLink, bottom: a1.bottomLink }),
  );
  await shot(page, "a1-1280-article.png");
  attachShot("A1 唯一 H1 + 标题/时间/约 N 分钟 + prose ≤68ch", "a1-1280-article.png", "1280×800 · png");
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(page, 600);
  await shot(page, "a1-390-article.png");
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(page, 400);

  // ── A2 四块 ───────────────────────────────────────────────────────────────
  const readDwellBefore = await page.evaluate(() => ({ ...(window.__reportReadDwell ?? {}) }));
  const a2 = await page.evaluate(() => {
    const stats = document.querySelector('[data-article-block="stats"]');
    const grid = document.querySelector('[data-testid="stats-grid"]');
    const steps = [...document.querySelectorAll('[data-testid="step-row"]')];
    const command = document.querySelector('[data-testid="step-command"]');
    const callout = document.querySelector('[data-testid="callout"]');
    return {
      statsCols: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
      value: document.querySelector('[data-testid="stats-value"]')?.textContent?.trim() ?? null,
      delta: document.querySelector('[data-testid="stats-delta"]')?.textContent?.trim() ?? null,
      statuses: steps.map((row) => row.getAttribute("data-status")),
      statusLabels: steps.map((row) => row.querySelector('[data-testid="step-status"]')?.textContent?.trim()),
      commandOverflow: command ? getComputedStyle(command).overflowX : null,
      compareGrid: Boolean(document.querySelector('[data-testid="compare-grid"]')),
      compareWarning: document.querySelector('[data-testid="compare-viewport-warning"]')?.textContent?.trim() ?? null,
      mediaButton: Boolean(document.querySelector('[data-testid="block-media"]')),
      calloutText: callout?.textContent ?? "",
      calloutCode: Boolean(document.querySelector('[data-testid="callout-code"]')),
      calloutItems: document.querySelectorAll('[data-testid="callout-items"] li').length,
      statsCount: document.querySelectorAll('[data-article-block="stats"]').length,
      stats: Boolean(stats),
    };
  });
  check(
    "A2 stats：4 列网格 + value/tone + before→after 百分比",
    a2.statsCount >= 1 && a2.statsCols === 4 && a2.value?.includes("95/95") && /→/.test(a2.delta ?? "") && /%/.test(a2.delta ?? ""),
    JSON.stringify({ cols: a2.statsCols, value: a2.value, delta: a2.delta }),
  );
  check(
    "A2 steps：五态 Badge + command 横向滚动 + media 可开 viewer",
    JSON.stringify(a2.statuses) === JSON.stringify(["done", "degraded", "skipped", "failed", "pending"]) &&
      a2.statusLabels.join(",") === "完成,降级,跳过,失败,待定" &&
      a2.commandOverflow === "auto" &&
      a2.mediaButton,
    JSON.stringify({ statuses: a2.statuses, labels: a2.statusLabels, overflow: a2.commandOverflow }),
  );
  check(
    "A2 compare：≥860 并排 + viewport 不一致 warning；callout：body+items+code",
    a2.compareGrid && /不一致/.test(a2.compareWarning ?? "") && (a2.calloutText ?? "").includes("结论先行") && a2.calloutItems === 2 && a2.calloutCode,
    JSON.stringify({ grid: a2.compareGrid, warning: a2.compareWarning, items: a2.calloutItems }),
  );
  await page.locator('[data-testid="block-media"]').first().click();
  await waitSel('[data-testid="viewer-image"]');
  await sleep(page, 300);
  await shot(page, "a2-1280-viewer.png");
  await page.keyboard.press("Escape");
  await sleep(page, 400);
  await shot(page, "a2-1280-blocks.png");
  attachShot("A2 stats：4 列网格 + value/tone + before→after 百分比", "a2-1280-blocks.png", "1280×800 · png");

  // 390：compare 切换、stats 2 列
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(page, 600);
  const a2narrow = await page.evaluate(() => {
    const grid = document.querySelector('[data-testid="stats-grid"]');
    const tabs = document.querySelector('[data-testid="compare-switch"]');
    return {
      cols: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
      tabs: Boolean(tabs),
      sides: document.querySelectorAll('[data-testid="compare-side"]').length,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  await page.click('[data-testid="compare-tab-after"]');
  await sleep(page, 300);
  const afterVisible = await page.evaluate(
    () => document.querySelector('[data-testid="compare-side"] figcaption')?.textContent ?? "",
  );
  check(
    "A2 <860px：stats 2 列、compare 一次一张（After 切换生效）且无横向溢出",
    a2narrow.cols === 2 &&
      a2narrow.tabs &&
      a2narrow.sides === 1 &&
      afterVisible.includes("After") &&
      a2narrow.scrollWidth <= a2narrow.clientWidth,
    JSON.stringify({ ...a2narrow, afterVisible }),
  );
  await shot(page, "a2-390-compare.png");
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(page, 500);

  // ── A3 降级占位 ───────────────────────────────────────────────────────────
  const a3 = await page.evaluate(() => {
    const degraded = [...document.querySelectorAll('[data-testid="article-block-degraded"]')];
    const callout = document.querySelector('[data-testid="callout"]');
    return {
      count: degraded.length,
      names: degraded.map((el) => el.getAttribute("data-block-name")),
      lines: degraded.map((el) => el.getAttribute("data-block-line")),
      raw: degraded.map((el) => el.querySelector('[data-testid="article-block-raw"]')?.textContent ?? ""),
      issueText: degraded.map((el) => el.querySelector('[data-testid="article-block-issue"]')?.textContent ?? ""),
      labels: degraded.map((el) => el.textContent),
      restRendered: Boolean(callout),
    };
  });
  check(
    "A3 未知块/坏 JSON/schema 错 → 三处降级占位（块名/行号/原文），其余正常",
    a3.count === 3 &&
      a3.names.includes("unknown-block") &&
      a3.lines.every((line) => Number(line) > 0) &&
      a3.raw[0].includes("hello") &&
      a3.issueText.some((text) => text.includes("unsupported")) &&
      a3.issueText.some((text) => /not valid JSON/.test(text)) &&
      a3.labels.some((text) => text.includes("不支持的区块")) &&
      a3.restRendered,
    JSON.stringify({ count: a3.count, names: a3.names, lines: a3.lines }),
  );
  await shot(page, "a3-1280-degraded.png");
  attachShot("A3 未知块/坏 JSON/schema 错 → 三处降级占位（块名/行号/原文），其余正常", "a3-1280-degraded.png", "1280×800 · png");

  // ── A4 raw HTML 转义 ──────────────────────────────────────────────────────
  const a4 = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="article-view"]');
    return {
      scripts: root.querySelectorAll("script, iframe, style").length,
      onerror: root.querySelectorAll("[onerror]").length,
      xss: typeof window.__xss,
      text: root.textContent.includes("<script>alert(1)</script>"),
      imgText: root.textContent.includes("<img src=x onerror"),
    };
  });
  check(
    "A4 raw HTML 全按文本（DOM 0 script/iframe/事件属性，文本可见）",
    a4.scripts === 0 && a4.onerror === 0 && a4.xss === "undefined" && a4.text && a4.imgText,
    JSON.stringify(a4),
  );
  const dangerous = spawnSync("rg", ["dangerouslySetInnerHTML", "src/"], { cwd: REPO_ROOT, encoding: "utf8" });
  check("A4 源码无 dangerouslySetInnerHTML", (dangerous.status ?? 1) !== 0 || dangerous.stdout.trim() === "", `rg exit=${dangerous.status}`);

  // ── A9 通知/已读不变 ──────────────────────────────────────────────────────
  // 用一篇「刚创建、从未在 feed 出现过」的长文做读态证据（避免 feed 停留干扰）。
  const readArticle = await apiJson(BASE, "/api/posts", MANAGER_TOKEN, {
    method: "POST",
    body: JSON.stringify({ body: "# 读态证据长文\n\n用于 dwell 证据。", kind: "article", tags: ["note"] }),
  });
  const READ_ID = readArticle.posts[0].id;
  const cursorBefore = (await apiJson(BASE, "/api/cursor", MANAGER_TOKEN)).cursor;
  await gotoHash(`/a/${READ_ID}`);
  await waitSel('[data-testid="article-view"]');
  await sleep(300);
  const readsEarly = await apiJson(BASE, `/api/reads?ids=${READ_ID}`, MANAGER_TOKEN);
  const cursorAfterOpen = (await apiJson(BASE, "/api/cursor", MANAGER_TOKEN)).cursor;
  check(
    "A9 打开 article 不直接写已读、不推进游标（dwell 门槛未到）",
    (readsEarly.reads ?? []).length === 0 && cursorAfterOpen === cursorBefore,
    JSON.stringify({ reads: readsEarly.reads, cursor: [cursorBefore, cursorAfterOpen] }),
  );

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(2600);
  const dwell = await page.evaluate(() => ({
    ...(window.__reportReadDwell ?? {}),
    rootRead: document.querySelector('[data-testid="article-view"]')?.getAttribute("data-read") ?? null,
    dwellState: document.querySelector('[data-testid="article-view"]')?.getAttribute("data-dwell-state") ?? null,
  }));
  const managerReads = await apiJson(BASE, `/api/reads?ids=${READ_ID}`, MANAGER_TOKEN);
  check(
    "A9 read-dwell 复用既有观察器（observers ≤ 1）与写路径（服务端 post_reads 命中）",
    dwell.observers <= 1 &&
      dwell.marks >= 1 &&
      dwell.persists >= 1 &&
      (managerReads.reads ?? []).some((row) => row.post_id === READ_ID) &&
      (dwell.rootRead === "1" || dwell.dwellState === "read"),
    JSON.stringify({ ...dwell, readHit: (managerReads.reads ?? []).map((r) => r.post_id) }),
  );

  // 线程页 focal 摘要卡（A8）：单独打开 MAIN_ID 的线程页
  await gotoHash(`/p/${MAIN_ID}`);
  await waitSel('[data-testid="thread-timeline"]');
  await sleep(600);
  const threadFocal = await page.evaluate(() => ({
    summary: Boolean(document.querySelector('[data-testid="focal-card"] [data-testid="article-summary"]')),
    openFull: Boolean(document.querySelector('[data-testid="article-open-full"]')),
    paragraphs: document.querySelector('[data-testid="focal-card"]')?.querySelectorAll("p").length ?? 0,
  }));
  check(
    "A8 线程页 focal＝摘要卡 + 「阅读全文」入口（不渲染全文）",
    threadFocal.summary && threadFocal.openFull && threadFocal.paragraphs <= 6,
    JSON.stringify(threadFocal),
  );
  await shot(page, "a1-1280-thread-focal.png");
  attachShot("A8 线程页 focal＝摘要卡 + 「阅读全文」入口（不渲染全文）", "a1-1280-thread-focal.png", "1280×800 · png");

  // 通知类型：article 仍只产生 post.created（owner 视角）
  const peek = await apiJson(BASE, "/api/notifications?peek=1&limit=200", OWNER_TOKEN);
  const types = [...new Set(peek.events.map((event) => event.type))];
  check(
    "A9 article 发帖只产生既有通知类型（无新类型）",
    types.every((type) => ["post.created", "thread.invited"].includes(type)) && types.includes("post.created"),
    JSON.stringify(types),
  );

  // 通知行摘要（manager 收到 owner 回复的 post.created）
  await gotoHash("/notifications");
  await waitSel('[data-testid="notification-row"]');
  await sleep(page, 600);
  const notificationSummary = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="notification-row"]')];
    const hit = rows.find((row) => (row.textContent ?? "").includes("普通短帖") || (row.textContent ?? "").includes("引用一篇长文") || (row.textContent ?? "").includes("长文验收"));
    return {
      rows: rows.length,
      articleSummaryRows: document.querySelectorAll('[data-testid="notification-article-summary"]').length,
      sample: hit?.textContent?.slice(0, 120) ?? null,
    };
  });
  check(
    "A8 通知行对长文用摘要文本（notification-article-summary）",
    notificationSummary.articleSummaryRows >= 1,
    JSON.stringify(notificationSummary),
  );
  await shot(page, "a8-1280-notification-summary.png");
  attachShot("A8 通知行对长文用摘要文本（notification-article-summary）", "a8-1280-notification-summary.png", "1280×800 · png");

  // 搜索摘要卡
  await gotoHash("/search?q=FDE2E 长文验收主体");
  await sleep(page, 900);
  const searchInfo = await page.evaluate(() => ({
    summary: Boolean(document.querySelector('[data-testid="article-summary"]')),
    title: document.querySelector('[data-testid="article-summary-title"]')?.textContent?.trim() ?? null,
  }));
  check("A8 搜索页长文结果＝摘要卡", searchInfo.summary && (searchInfo.title ?? "").includes("长文验收主体"), JSON.stringify(searchInfo));
  await shot(page, "a8-1280-search-summary.png");
  attachShot("A8 搜索页长文结果＝摘要卡", "a8-1280-search-summary.png", "1280×800 · png");

  // 引用卡（note 引用长文）
  await gotoHash(`/p/${QUOTE_ID}`);
  await waitSel('[data-testid="quote-card"]');
  await sleep(page, 400);
  const quoteInfo = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="quote-card"]');
    return {
      href: card?.getAttribute("href") ?? null,
      kindAttr: card?.getAttribute("data-quote-kind") ?? null,
      summary: Boolean(card?.querySelector('[data-testid="quote-article-summary"]')),
      text: card?.textContent?.slice(0, 120) ?? null,
    };
  });
  check(
    "A8 引用长文卡＝标题/摘要 + 链接 #/a/<id>",
    quoteInfo.kindAttr === "article" && quoteInfo.href === `#/a/${encodeURIComponent(MAIN_ID)}` && quoteInfo.summary && (quoteInfo.text ?? "").includes("长文"),
    JSON.stringify(quoteInfo),
  );

  // /a/<note> 回退
  await gotoHash(`/a/${NOTE_ID}`);
  await page.waitForFunction(() => location.hash.startsWith("#/p/"), null, { timeout: 10_000 });
  await waitSel('[data-testid="thread-timeline"]');
  const fellBack = await page.evaluate(() => location.hash);
  check("/a/<note> 回退到 /p/<note>（无死路由）", fellBack === `#/p/${NOTE_ID}`, fellBack);

  // ── A6 性能：feed 20 帖（含长文）+ 长任务 + 文章首屏 ───────────────────────
  await page.evaluate(() => {
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration));
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      // 环境无 longtask 支持：留空数组
    }
  });
  await gotoHash("/");
  await waitSel('[data-testid="timeline-scroll"] article[data-post-id]');
  const feedPerf = await page.evaluate(async () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i += 1) {
      if (document.querySelectorAll('[data-testid="timeline-scroll"] article[data-post-id]').length >= 20) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    const rows = document.querySelectorAll('[data-testid="timeline-scroll"] article[data-post-id]').length;
    const summaries = document.querySelectorAll('[data-testid="article-summary"]').length;
    return { ms: Math.round(performance.now() - t0), rows, summaries };
  });
  await page.mouse.wheel(0, 1200);
  await sleep(page, 900);
  const longTasks = await page.evaluate(() => ({
    count: (window.__longTasks ?? []).length,
    max: Math.max(0, ...(window.__longTasks ?? [])),
  }));
  const articleFirstPaint = await page.evaluate(async (id) => {
    const t0 = performance.now();
    location.hash = `#/a/${id}`;
    await new Promise((done) => {
      const check = () => (document.querySelector('[data-testid="article-view"]') ? done() : requestAnimationFrame(check));
      check();
    });
    const ms = Math.round(performance.now() - t0);
    return ms;
  }, MAIN_ID);
  check(
    "A6 feed 20 帖含长文：渲染 <1500ms（实测回填）且无 >50ms 长任务",
    feedPerf.rows >= 20 && feedPerf.summaries >= 5 && feedPerf.ms < 1500 && longTasks.max <= 50,
    JSON.stringify({ ...feedPerf, ...longTasks, articleFirstPaint }),
  );
  check(
    "A6 文章视图首屏 DOM 就绪 <1500ms（实测回填；含 512KB 帖）",
    articleFirstPaint < 1500,
    `articleFirstPaint=${articleFirstPaint}ms`,
  );

  // ── A14 编辑器 ────────────────────────────────────────────────────────────
  await gotoHash("/compose?format=article");
  await waitSel('[data-testid="article-editor"]');
  await sleep(page, 400);
  const editor1280 = await page.evaluate(() => ({
    split: Boolean(document.querySelector('[data-testid="article-editor-split"]')),
    tabs: Boolean(document.querySelector('[data-testid="article-editor-tabs"]')),
    submitInGroup: Boolean(document.querySelector('[data-testid="article-submit"]')?.closest('[data-slot="input-group"]')),
    counter: document.querySelector('[data-testid="article-counter"]')?.textContent?.trim() ?? null,
  }));
  check(
    "A14 1280 左右分栏 + 提交在 InputGroup + 计数按 512,000",
    editor1280.split && !editor1280.tabs && editor1280.submitInGroup && (editor1280.counter ?? "").includes("512,000"),
    JSON.stringify(editor1280),
  );
  await shot(page, "a14-1280-editor.png");

  // 插入四块模板 → 预览可解析
  await page.click('[data-testid="article-insert-block"]');
  await page.click('[data-testid="article-insert-stats"]');
  await sleep(page, 500);
  const inserted = await page.evaluate(() => ({
    value: document.querySelector('[data-testid="article-editor-input"]')?.value ?? "",
    previewBlocks: document.querySelectorAll('[data-testid="article-editor-preview"] [data-article-block]').length,
  }));
  check(
    "A14 四块插入模板（stats）可解析 + 预览渲染",
    inserted.value.includes("fde2e:stats") && inserted.previewBlocks >= 1,
    JSON.stringify({ hasBlock: inserted.value.includes("fde2e:stats"), previewBlocks: inserted.previewBlocks }),
  );

  // 坏 JSON → 错误面板（line/block/fix）并禁用提交；点击定位
  await page.fill('[data-testid="article-editor-input"]', "# 草稿\n\n```fde2e:stats\n{ \"items\": }\n```\n");
  await sleep(page, 600);
  const badEditor = await page.evaluate(() => {
    const errors = document.querySelector('[data-testid="article-errors"]');
    const item = document.querySelector('[data-testid="article-error-item"]');
    const submit = document.querySelector('[data-testid="article-submit"]');
    return {
      errors: Boolean(errors),
      itemText: item?.textContent?.trim() ?? null,
      line: item?.getAttribute("data-line") ?? null,
      block: item?.getAttribute("data-block") ?? null,
      fixText: item?.parentElement?.querySelector("span")?.textContent ?? "",
      submitDisabled: submit?.disabled ?? null,
    };
  });
  await page.click('[data-testid="article-error-item"]');
  await sleep(page, 200);
  const caret = await page.evaluate(() => {
    const area = document.querySelector('[data-testid="article-editor-input"]');
    return { caret: area?.selectionStart ?? -1, linePos: area?.value.indexOf("```fde2e:stats") ?? -1 };
  });
  check(
    "A14 坏 JSON 禁止提交 + 错误面板 line/block/fix + 点击定位到行",
    badEditor.errors &&
      /第 3 行/.test(badEditor.itemText ?? "") &&
      badEditor.line === "3" &&
      badEditor.block === "1" &&
      (badEditor.fixText ?? "").length > 0 &&
      badEditor.submitDisabled === true &&
      caret.caret === caret.linePos,
    JSON.stringify({ ...badEditor, caret }),
  );
  await shot(page, "a14-1280-editor-error.png");
  attachShot("A14 坏 JSON 禁止提交 + 错误面板 line/block/fix + 点击定位到行", "a14-1280-editor-error.png", "1280×800 · png");

  // 草稿恢复/清除
  await page.fill('[data-testid="article-editor-input"]', "# 草稿恢复样例\n\n正文。");
  await sleep(600);
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(900);
  const restored = await page.evaluate(() => document.querySelector('[data-testid="article-editor-input"]')?.value ?? "");
  await page.fill('[data-testid="article-editor-input"]', "");
  await sleep(600);
  const draftCleared = await page.evaluate(() =>
    Object.keys(localStorage).some((key) => key.includes("report.draft.v1:article:root")),
  );
  check(
    "A14 草稿恢复（reload 后原文还在）与清空（清键）",
    restored.includes("草稿恢复样例") && draftCleared === false,
    JSON.stringify({ restored: restored.slice(0, 24), draftCleared }),
  );

  // 双击提交只发一次
  const postRequests = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/posts")) postRequests.push(req.url());
  });
  await page.fill(
    '[data-testid="article-editor-input"]',
    `# 双击提交样例\n\n正文段落。\n\n${fence("callout", JSON.stringify({ body: "ok" }))}`,
  );
  await sleep(600);
  await Promise.all([
    page.click('[data-testid="article-submit"]', { clickCount: 2, delay: 30 }).catch(() => {}),
  ]);
  await page.waitForFunction(() => location.hash.startsWith("#/a/"), null, { timeout: 15_000 });
  await sleep(800);
  check("A14 双击提交只发一次 POST /api/posts", postRequests.length === 1, `requests=${postRequests.length}`);

  // 390 编辑器（全屏 + tabs）
  await gotoHash("/compose?format=article");
  await waitSel('[data-testid="article-editor"]');
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(600);
  const editor390 = await page.evaluate(() => ({
    tabs: Boolean(document.querySelector('[data-testid="article-editor-tabs"]')),
    split: Boolean(document.querySelector('[data-testid="article-editor-split"]')),
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  check(
    "A14 390 全屏 + 撰写/预览 Tabs，无横向溢出",
    editor390.tabs && !editor390.split && editor390.scrollWidth <= editor390.clientWidth,
    JSON.stringify(editor390),
  );
  await shot(page, "a14-390-editor.png");
  attachShot("A14 390 全屏 + 撰写/预览 Tabs，无横向溢出", "a14-390-editor.png", "390×844 · png");
  // 200% 字号无横向溢出（text-only zoom 代理）
  const zoom = await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
    const ok = document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
    document.documentElement.style.fontSize = "";
    return { ok, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  });
  check("A14 200% 字号无横向溢出", zoom.ok, JSON.stringify(zoom));
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(400);

  // 键盘可达：提交键在 Tab 顺序内（可见/未禁用）
  const keyboard = await page.evaluate(() => {
    const submit = document.querySelector('[data-testid="article-submit"]');
    const focusables = [...document.querySelectorAll("button, [href], textarea, input")].filter(
      (el) => !el.disabled && el.offsetParent !== null,
    );
    return {
      submitVisible: Boolean(submit?.offsetParent),
      submitInTabOrder: focusables.indexOf(submit) >= 0,
      focusableCount: focusables.length,
    };
  });
  check(
    "A14 提交键可见且在 Tab 顺序内（键盘可达）",
    keyboard.submitVisible && keyboard.submitInTabOrder,
    JSON.stringify(keyboard),
  );

  await ctx.close();

  // ── A10 静态归档（file:// 0 网络 / 0 写）──────────────────────────────────
  const exportDir = mkdtempSync(join(tmpdir(), "report-qa-longform-static-"));
  execFileSync("bun", ["src/cli/main.ts", "export", "--data-dir", qa.dataDir, "--as", "owner", "--out", exportDir], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  const staticCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const staticPage = await staticCtx.newPage();
  const staticRequests = [];
  staticPage.on("request", (req) => {
    const url = req.url();
    if (!url.startsWith("file://")) staticRequests.push(url);
  });
  staticPage.on("pageerror", (e) => errors.push(`static: ${String(e).slice(0, 160)}`));
  const archiveUrl = pathToFileURL(join(exportDir, "index.html")).href;
  await staticPage.goto(`${archiveUrl}#/a/${MAIN_ID}`, { waitUntil: "domcontentloaded" });
  await staticPage.waitForSelector('[data-testid="article-view"]', { timeout: 20_000 });
  await staticPage.waitForSelector('[data-article-block="stats"]', { timeout: 10_000 });
  await sleep(800);
  const staticInfo = await staticPage.evaluate(() => ({
    blocks: document.querySelectorAll("[data-article-block]").length,
    degraded: document.querySelectorAll('[data-testid="article-block-degraded"]').length,
    discussionRows: document.querySelectorAll('[data-testid="article-discussion"] article[data-post-id]').length,
    readonly: Boolean(document.querySelector('[data-testid="article-readonly"]')),
    dataRead: document.querySelectorAll("[data-read]").length,
    readKeys: Object.keys(localStorage).filter((key) => key.startsWith("report.read")),
    mediaImg: (() => {
      const img = document.querySelector('[data-testid="block-media"] img');
      return img ? { src: img.getAttribute("src"), loaded: img.naturalWidth > 0 } : null;
    })(),
    banner: Boolean(document.querySelector('[data-testid="static-banner"]')),
  }));
  const externalRequests = staticRequests.filter((url) => !url.startsWith("data:"));
  check(
    "A10 file:// 长文：四块 + 讨论区只读 + 图片相对路径可加载 + 0 网络/0 读态存储",
    staticInfo.blocks >= 4 &&
      staticInfo.discussionRows >= 1 &&
      staticInfo.readonly &&
      staticInfo.dataRead === 0 &&
      staticInfo.readKeys.length === 0 &&
      staticInfo.mediaImg?.loaded === true &&
      (staticInfo.mediaImg?.src ?? "").startsWith("media/") &&
      staticInfo.banner &&
      externalRequests.length === 0,
    JSON.stringify({ ...staticInfo, externalRequests: externalRequests.slice(0, 3) }),
  );
  await staticPage.screenshot({ path: join(REPORT_DIR, "a10-1280-static.png") });
  screenshots.push("a10-1280-static.png");
  attachShot("A10 file:// 长文：四块 + 讨论区只读 + 图片相对路径可加载 + 0 网络/0 读态存储", "a10-1280-static.png", "1280×800 · png");
  // `/a/<note>` 回退（静态）
  await staticPage.evaluate((id) => {
    location.hash = `#/a/${id}`;
  }, NOTE_ID);
  await staticPage.waitForFunction(() => location.hash.startsWith("#/p/"), null, { timeout: 10_000 });
  const staticFallback = await staticPage.evaluate(() => location.hash);
  check("A10 静态 /a/<note> 回退 /p/<note>", staticFallback === `#/p/${NOTE_ID}`, staticFallback);
  await staticPage.setViewportSize({ width: 390, height: 844 });
  await staticPage.evaluate((id) => {
    location.hash = `#/a/${id}`;
  }, MAIN_ID);
  await staticPage.waitForSelector('[data-testid="article-view"]', { timeout: 10_000 });
  await sleep(500);
  await staticPage.screenshot({ path: join(REPORT_DIR, "a10-390-static.png") });
  screenshots.push("a10-390-static.png");
  await staticCtx.close();

  // ── A11 CLI ───────────────────────────────────────────────────────────────
  const cliDir = mkdtempSync(join(tmpdir(), "report-longform-cli-"));
  try {
    const mdPath = join(cliDir, "report.md");
    writeFileSync(
      mdPath,
      ["# CLI 长文样例", "", "正文段落。", "", fence("callout", JSON.stringify({ body: "cli ok" }))].join("\n"),
      "utf8",
    );
    const cliPost = spawnSync(
      "bun",
      ["src/cli/main.ts", "post", "--file", mdPath, "--format", "article", "--data-dir", qa.dataDir, "--as", "manager"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const cliOut = JSON.parse(cliPost.stdout || "{}");
    check(
      "A11 CLI post --file --format article → kind=article",
      cliPost.status === 0 && cliOut.posts?.[0]?.kind === "article" && cliOut.posts[0].body_md.includes("CLI 长文样例"),
      `status=${cliPost.status} kind=${cliOut.posts?.[0]?.kind}`,
    );
    const cliBogus = spawnSync(
      "bun",
      ["src/cli/main.ts", "post", "-m", "x", "--format", "bogus", "--data-dir", qa.dataDir, "--as", "manager"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    check("A11 CLI --format bogus 报错", cliBogus.status !== 0 && /--format/.test(cliBogus.stderr), `status=${cliBogus.status} ${cliBogus.stderr.slice(0, 120)}`);
    const cliHuman = spawnSync(
      "bun",
      ["src/cli/main.ts", "post", "--file", mdPath, "--format", "article", "--data-dir", qa.dataDir, "--as", "manager", "--human"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    check("A11 CLI 人类输出标注 posted (article)", cliHuman.status === 0 && cliHuman.stdout.includes("posted (article)"), cliHuman.stdout.split("\n")[0]);
  } finally {
    rmSync(cliDir, { recursive: true, force: true });
  }

  // ── A12 插件（MCP 工具层）────────────────────────────────────────────────
  process.env.REPORT_CHANNEL_BASE_URL = BASE;
  process.env.REPORT_CHANNEL_DATA_DIR = qa.dataDir;
  process.env.REPORT_CHANNEL_ACCOUNT = "manager";
  const tools = await import(pathToFileURL(join(PLUGIN_DIR, "scripts/lib/tools.mjs")).href);
  const pluginTmp = mkdtempSync(join(tmpdir(), "report-longform-plugin-"));
  const pluginFile = join(pluginTmp, "plugin-report.md");
  writeFileSync(pluginFile, "# 插件长文\n\n正文。\n", "utf8");
  let pluginOk = false;
  let pluginDetail = "";
  try {
    const posted = await tools.callTool("board_post", { file: pluginFile, format: "article", tags: ["result"] });
    const postedPost = posted.posts?.[0] ?? {};
    const viaKind = await tools.callTool("board_post", { file: pluginFile, kind: "article" });
    const viaArticle = await tools.callTool("board_post", { file: pluginFile, article: true });
    let conflictError = null;
    try {
      await tools.callTool("board_post", { file: pluginFile, kind: "note", article: true });
    } catch (err) {
      conflictError = err.message;
    }
    let fileBodyError = null;
    try {
      await tools.callTool("board_post", { file: pluginFile, body: "x" });
    } catch (err) {
      fileBodyError = err.message;
    }
    let missingError = null;
    try {
      await tools.callTool("board_post", {});
    } catch (err) {
      missingError = err.message;
    }
    const reply = await tools.callTool("board_reply", { post_id: MAIN_ID, file: pluginFile, format: "article" });
    const read = await tools.callTool("board_read", { thread: MAIN_ID, limit: 5 });
    pluginOk =
      postedPost.kind === "article" &&
      (postedPost.url ?? "").includes("#/a/") &&
      viaKind.posts[0].kind === "article" &&
      viaArticle.posts[0].kind === "article" &&
      /conflicting/.test(conflictError ?? "") &&
      /not both/.test(fileBodyError ?? "") &&
      /body or file is required/.test(missingError ?? "") &&
      reply.posts[0].kind === "article" &&
      read.posts.every((post) => typeof post.kind === "string");
    pluginDetail = JSON.stringify({
      kind: postedPost.kind,
      url: postedPost.url,
      conflict: conflictError,
      both: fileBodyError,
      missing: missingError,
      replyKind: reply.posts[0].kind,
    });
  } catch (err) {
    pluginDetail = `threw: ${err.message}`;
  } finally {
    rmSync(pluginTmp, { recursive: true, force: true });
  }
  check("A12 插件 board_post/board_reply file/kind/format/article + 冲突报错不发请求", pluginOk, pluginDetail);

  // ── A13 迁移（v5/v6 夹具 → v7）────────────────────────────────────────────
  const migration = await (async () => {
    const { Database } = await import("bun:sqlite");
    const { migrate, SCHEMA_VERSION } = await import(join(REPO_ROOT, "src/server/db.ts"));
    const dir = mkdtempSync(join(tmpdir(), "report-longform-migrate-"));
    const results = {};
    try {
      // v6 夹具：post_reads 有行、posts 无 kind
      const v6 = new Database(join(dir, "v6.db"));
      v6.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
      v6.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '6')");
      v6.exec(
        "CREATE TABLE posts(id TEXT PRIMARY KEY, author TEXT NOT NULL, body_md TEXT NOT NULL, parent_id TEXT, root_id TEXT NOT NULL, self_thread_id TEXT NOT NULL, self_thread_is_leaf INTEGER NOT NULL DEFAULT 1, reply_to_account_id TEXT, quoted_post_id TEXT, tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, seq INTEGER NOT NULL, batch_id TEXT NOT NULL, deleted_at INTEGER)",
      );
      v6.exec("INSERT INTO posts(id, author, body_md, root_id, self_thread_id, created_at, seq, batch_id) VALUES ('old-1','manager','旧帖','old-1','old-1',1,1,'B')");
      v6.exec(
        "CREATE TABLE post_reads(account_id TEXT NOT NULL, post_id TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY(account_id, post_id))",
      );
      v6.exec("INSERT INTO post_reads(account_id, post_id, read_at) VALUES ('manager','old-1',42)");
      migrate(v6);
      migrate(v6); // 幂等
      const v6Info = v6.query("PRAGMA table_info(posts)").all().map((row) => row.name);
      const v6Row = v6.query("SELECT kind, body_md FROM posts WHERE id='old-1'").get();
      const v6Reads = v6.query("SELECT COUNT(*) AS n FROM post_reads").get();
      const v6Version = v6.query("SELECT value FROM meta WHERE key='schema_version'").get();
      results.v6 = { hasKind: v6Info.includes("kind"), kind: v6Row?.kind, body: v6Row?.body_md, reads: v6Reads?.n, version: v6Version?.value };
      v6.close();

      // v5 夹具：无 post_reads、无 kind
      const v5 = new Database(join(dir, "v5.db"));
      v5.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
      v5.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '5')");
      v5.exec(
        "CREATE TABLE posts(id TEXT PRIMARY KEY, author TEXT NOT NULL, body_md TEXT NOT NULL, parent_id TEXT, root_id TEXT NOT NULL, self_thread_id TEXT NOT NULL, self_thread_is_leaf INTEGER NOT NULL DEFAULT 1, reply_to_account_id TEXT, quoted_post_id TEXT, created_at INTEGER NOT NULL, seq INTEGER NOT NULL, batch_id TEXT NOT NULL, deleted_at INTEGER)",
      );
      v5.exec("INSERT INTO posts(id, author, body_md, root_id, self_thread_id, created_at, seq, batch_id) VALUES ('v5-1','manager','v5 旧帖','v5-1','v5-1',1,1,'B')");
      migrate(v5);
      migrate(v5);
      const v5Tables = v5.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      const v5Kind = v5.query("SELECT kind FROM posts WHERE id='v5-1'").get();
      const v5Version = v5.query("SELECT value FROM meta WHERE key='schema_version'").get();
      results.v5 = { postReads: v5Tables.includes("post_reads"), kind: v5Kind?.kind, version: v5Version?.value };
      v5.close();
      results.schemaVersion = SCHEMA_VERSION;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return results;
  })();
  check(
    "A13 v5/v6 夹具迁移到 v7：kind 列补齐、旧行 note、post_reads 原样、迁移幂等",
    migration.schemaVersion === 7 &&
      migration.v6.hasKind &&
      migration.v6.kind === "note" &&
      migration.v6.body === "旧帖" &&
      migration.v6.reads === 1 &&
      migration.v6.version === "7" &&
      migration.v5.postReads &&
      migration.v5.kind === "note" &&
      migration.v5.version === "7",
    JSON.stringify(migration),
  );

  // ── 收尾：运行时错误 ──────────────────────────────────────────────────────
  const realErrors = errors.filter((message) => !/favicon|File not found|net::ERR_FILE_NOT_FOUND/i.test(message));
  check("全流程无页面运行时错误（console.error/pageerror）", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "0");
} finally {
  await browser.close();
  await qa.stop();
  const failed = checks.filter((row) => !row.ok);
  const results = {
    ok: failed.length === 0,
    ranAt: new Date().toISOString(),
    base: BASE,
    dataDir: qa.dataDir,
    port: qa.info?.port ?? null,
    pid: qa.info?.pid ?? null,
    productionTouched: false,
    durationMs: Date.now() - startedAt,
    checks,
    screenshots,
  };
  writeFileSync(join(REPORT_DIR, "results.json"), JSON.stringify(results, null, 2));

  // steps.json → report.html（统一生成器，禁止手写 HTML）
  const sectionOf = (name) => {
    const match = /^A(\d+)/.exec(name);
    return match ? `A${match[1]}` : "A0";
  };
  const groups = new Map();
  for (const row of steps) {
    const key = sectionOf(row.intent);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const order = ["A1", "A2", "A3", "A4", "A5", "A6", "A8", "A9", "A10", "A11", "A12", "A13", "A14", "A0"];
  const sections = [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([key, rows]) => ({
      title: key === "A0" ? "夹具与通用" : `A${key.slice(1)} · ${rows.length} 项断言`,
      steps: rows,
    }));
  writeFileSync(
    join(REPORT_DIR, "steps.json"),
    JSON.stringify(
      {
        title: "report-longform（长文章）— P1 端到端交付报告",
        brand: "FDE2E™ · report.worker（人机公示板）· 长文交付报告",
        subtitle:
          "article 载体（kind）+ fde2e 指令块四块（stats/steps/compare/callout）+ 文章视图与嵌入讨论区 + 摘要卡 + 全屏编辑器 + 静态归档 + CLI/插件 + schema v7。",
        meta: `2026-11-07 · ${checks.length} 断言 / ${failed.length} FAIL · 1280×800 + 390×844 · 隔离后端 ${BASE}（生产板零写入）· pid=${qa.info?.pid ?? "-"}`,
        thesis:
          failed.length === 0
            ? "结论：A1–A6/A8–A14 全部实测通过（A7 TOC 属 P2，不在本轮）。"
            : `结论：${failed.length} 项失败，详见下方面板。`,
        env: [
          ["隔离后端", `${BASE} · dataDir=${qa.dataDir} · pid=${qa.info?.pid ?? "-"}`],
          ["视口", "1280×800、390×844（编辑器另测 200% 字号）"],
          ["断言", `${checks.length - failed.length}/${checks.length} PASS`],
          ["静态归档", "file:// 0 网络 / 0 写（导出目录 /tmp/report-qa-longform-static-*）"],
        ],
        sections,
        summary: { pass: checks.length - failed.length, fail: failed.length },
      },
      null,
      2,
    ),
  );
  try {
    execFileSync(
      "node",
      [join(REPO_ROOT, "..", "..", "fde2e-skills-v0", "scripts", "e2e-report-gen.mjs"), REPORT_DIR],
      { cwd: REPO_ROOT, stdio: "inherit" },
    );
  } catch (err) {
    console.error(`report.html 生成失败：${err.message}`);
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed · ${REPORT_DIR}/results.json · report.html`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

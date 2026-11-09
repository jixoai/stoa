#!/usr/bin/env bun
/**
 * report-share-actions E2E：操作条纯图标 + 分享面板。
 *
 * A1 四键纯图标（可见文本为空、aria-label 正确）
 * A2 分享面板项目齐全（复制/系统/微信/微博/QQ/X/Telegram/邮件）
 * A3 系统分享调用 navigator.share（canonical URL）
 * A4 复制链接写入剪贴板（canonical URL）
 * A5 社交直达 window.open URL 含 canonical URL（微博/X/Telegram）
 * A6 390 面板不溢出、操作键 ≥44px
 * A7 无 console/pageerror
 *
 * Run:
 *   bun scripts/qa/share-actions.mjs
 *   bun scripts/qa/share-actions.mjs --no-build
 */
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, argValue, authSecret, ensureQa } from "./lib/qa-env.mjs";

const argv = process.argv.slice(2);
const qa = await ensureQa(argv);
const BASE = qa.base;
const AUTH = authSecret(qa.dataDir);
const REPORT_DIR = resolve(
  argValue(argv, "report-dir") ??
    join(REPO_ROOT, "..", "..", ".agents", "reports", "manager", "report-share-actions"),
);
mkdirSync(REPORT_DIR, { recursive: true });
if (!argv.includes("--no-build")) {
  execFileSync("bun", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
}
if (!existsSync(join(REPO_ROOT, "dist", "index.html"))) throw new Error("missing dist/index.html");

const startedAt = Date.now();
const checks = [];
const steps = [];
const screenshots = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok), detail, at: Date.now() - startedAt });
  steps.push({ intent: name, assertion: detail || (ok ? "PASS" : "FAIL"), ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (page, ms) => page.waitForTimeout(ms);
async function shot(page, name) {
  await page.screenshot({ path: join(REPORT_DIR, name) });
  screenshots.push(name);
}

const browser = await chromium.launch({ channel: "chrome" });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await ctx.addInitScript(() => {
    window.__shared = null;
    window.__opened = [];
    navigator.share = async (data) => {
      window.__shared = data;
    };
    navigator.canShare = () => true;
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await sleep(page, 700);
  if (await page.locator('input[type="password"]').count()) {
    await page.locator('input[type="password"]').first().fill(AUTH);
    await page.click('[data-testid="login-submit"]');
  }
  await page.waitForSelector('[data-testid="timeline-scroll"] article[data-post-id]', { timeout: 25_000 });
  await sleep(page, 800);

  const card = page.locator('[data-testid="timeline-scroll"] article[data-post-id]').first();
  const postId = await card.getAttribute("data-post-id");
  if (!postId) throw new Error("no post id");
  const actions = await card.evaluate((el) => {
    const ids = ["action-reply", "action-quote", "action-bookmark", "action-share"];
    return ids.map((id) => {
      const node = el.querySelector(`[data-testid="${id}"]`);
      return node
        ? {
            id,
            text: (node.textContent ?? "").trim(),
            label: node.getAttribute("aria-label"),
            box: { w: node.getBoundingClientRect().width, h: node.getBoundingClientRect().height },
          }
        : { id, missing: true };
    });
  });
  check(
    "A1 四键纯图标（可见文本为空、aria-label 完整、≥44px）",
    actions.every(
      (a) =>
        !a.missing &&
        a.text === "" &&
        a.label &&
        a.box &&
        a.box.w >= 44 &&
        a.box.h >= 44,
    ),
    JSON.stringify(actions),
  );

  await card.locator('[data-testid="action-share"]').click();
  await page.waitForSelector('[data-testid="share-panel"]', { timeout: 8000 });
  await sleep(page, 400);
  const items = await page.evaluate(() =>
    [
      "share-copy",
      "share-native",
      "share-wechat",
      "share-weibo",
      "share-qq",
      "share-x",
      "share-telegram",
      "share-mail",
    ].filter((id) => Boolean(document.querySelector(`[data-testid="${id}"]`))),
  );
  check(
    "A2 分享面板含复制/系统/微信/微博/QQ/X/Telegram/邮件",
    items.length === 8,
    JSON.stringify(items),
  );
  await shot(page, "a1-1280-share-panel.png");

  await page.click('[data-testid="share-native"]');
  await sleep(page, 300);
  const shared = await page.evaluate(() => window.__shared);
  check(
    "A3 系统分享调用 navigator.share 且 URL 为 canonical",
    Boolean(shared?.url?.includes(postId)),
    JSON.stringify(shared),
  );

  await card.locator('[data-testid="action-share"]').click();
  await page.waitForSelector('[data-testid="share-panel"]', { timeout: 8000 });
  await page.click('[data-testid="share-copy"]');
  await sleep(page, 300);
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  const toastText = await page.evaluate(
    () => document.querySelector('[data-slot="toast-title"]')?.textContent?.trim() ?? null,
  );
  check(
    "A4 复制链接写入剪贴板（canonical URL）＋可见「链接已复制」提示",
    clipboard.includes(postId) && clipboard.includes("#/p/") && toastText === "链接已复制",
    JSON.stringify({ clipboard, toastText }),
  );

  const social = [
    ["share-weibo", "https://service.weibo.com/share/share.php?url="],
    ["share-x", "https://twitter.com/intent/tweet?url="],
    ["share-telegram", "https://t.me/share/url?url="],
  ];
  let socialOk = true;
  const socialDetails = [];
  for (const [id, prefix] of social) {
    await card.locator('[data-testid="action-share"]').click();
    await page.waitForSelector('[data-testid="share-panel"]', { timeout: 8000 });
    await page.click(`[data-testid="${id}"]`);
    await sleep(page, 200);
    const opened = await page.evaluate(() => window.__opened.at(-1) ?? null);
    const ok = Boolean(opened?.startsWith(prefix) && opened.includes(encodeURIComponent(postId).slice(0, 12)));
    socialOk = socialOk && ok;
    socialDetails.push({ id, opened: opened?.slice(0, 100) });
  }
  check("A5 社交直达 window.open 均带 canonical URL", socialOk, JSON.stringify(socialDetails));

  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(page, 500);
  const mobileCard = page.locator('[data-testid="timeline-scroll"] article[data-post-id]').first();
  await mobileCard.locator('[data-testid="action-share"]').click();
  await page.waitForSelector('[data-testid="share-panel"]', { timeout: 8000 });
  await sleep(page, 400);
  const mobile = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="share-panel"]');
    const rect = panel?.getBoundingClientRect();
    const doc = document.documentElement;
    const buttons = [...document.querySelectorAll('[data-testid="timeline-scroll"] article[data-post-id] [data-testid^="action-"]')];
    return {
      panel: rect ? { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) } : null,
      hscroll: doc.scrollWidth <= doc.clientWidth,
      minTarget: Math.min(...buttons.map((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))),
    };
  });
  check(
    "A6 390 分享面板不溢出、操作键 ≥44px",
    Boolean(mobile.panel) &&
      mobile.panel.left >= 0 &&
      mobile.panel.right <= 390 &&
      mobile.hscroll &&
      mobile.minTarget >= 44,
    JSON.stringify(mobile),
  );
  await shot(page, "a6-390-share-panel.png");
  await ctx.close();

  const realErrors = errors.filter((m) => !/favicon|File not found/i.test(m));
  check("A7 无页面运行时错误", realErrors.length === 0, realErrors.slice(0, 3).join(" | ") || "0");

  // A8 无 navigator.share 环境：系统分享/微信隐藏，复制与社交直达仍可用
  const plain = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await plain.addInitScript(() => {
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
  });
  const p2 = await plain.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await p2.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await sleep(p2, 700);
  if (await p2.locator('input[type="password"]').count()) {
    await p2.locator('input[type="password"]').first().fill(AUTH);
    await p2.click('[data-testid="login-submit"]');
  }
  await p2.waitForSelector('[data-testid="timeline-scroll"] article[data-post-id]', { timeout: 25_000 });
  await sleep(p2, 600);
  await p2
    .locator('[data-testid="timeline-scroll"] article[data-post-id] [data-testid="action-share"]')
    .first()
    .click();
  await p2.waitForSelector('[data-testid="share-panel"]', { timeout: 8000 });
  const plainItems = await p2.evaluate(() =>
    [
      "share-copy",
      "share-native",
      "share-wechat",
      "share-weibo",
      "share-qq",
      "share-x",
      "share-telegram",
      "share-mail",
    ].filter((id) => Boolean(document.querySelector(`[data-testid="${id}"]`))),
  );
  check(
    "A8 无 navigator.share：系统分享/微信隐藏，复制+5 社交仍可用",
    plainItems.length === 6 &&
      plainItems.includes("share-copy") &&
      !plainItems.includes("share-native") &&
      !plainItems.includes("share-wechat"),
    JSON.stringify(plainItems),
  );
  await plain.close();
} finally {
  await browser.close();
  await qa.stop();
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    join(REPORT_DIR, "results.json"),
    JSON.stringify(
      {
        ok: failed.length === 0,
        ranAt: new Date().toISOString(),
        base: BASE,
        dataDir: qa.dataDir,
        durationMs: Date.now() - startedAt,
        checks,
        screenshots,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(REPORT_DIR, "steps.json"),
    JSON.stringify(
      {
        title: "report-share-actions — 操作条纯图标 + 分享面板 E2E",
        brand: "FDE2E™ · report.worker（人机公示板）· 分享交付报告",
        subtitle:
          "列表操作条四键纯图标（回复/引用/收藏/分享）；分享面板提供复制链接、系统原生分享（含微信）、微博/QQ/X/Telegram/邮件直达；URL 一律 canonical。",
        meta: `2026-11-09 · ${checks.length} 断言 / ${failed.length} FAIL · 1280×800 + 390×844 · 隔离后端 ${BASE}（生产板零写入）`,
        thesis: failed.length === 0 ? "结论：纯图标操作条与分享面板全部实测通过。" : `结论：${failed.length} 项失败。`,
        env: [
          ["隔离后端", `${BASE} · dataDir=${qa.dataDir}`],
          ["视口", "1280×800、390×844"],
          ["断言", `${checks.length - failed.length}/${checks.length} PASS`],
        ],
        sections: [{ title: "1 · 分享断言", steps }],
        summary: { pass: checks.length - failed.length, fail: failed.length },
      },
      null,
      2,
    ),
  );
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed · ${REPORT_DIR}/results.json`);
  process.exitCode = failed.length ? 1 : 0;
}

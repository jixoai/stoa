#!/usr/bin/env bun
/**
 * link-preview UI 截图/断言（临时 QA 脚本，不入库）。
 *
 * 前置：mock API（scripts/qa/ui-mock-api.mjs，13612）与 `bun run dev:ui`（5273）已启动。
 * 产出：390/1280 两档的 pending/partial/ready/failed 单卡、三页轮播、
 * post.updated 前后轮播页保持、设置页，以及 assertions.json。
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MOCK = process.env.MOCK_ORIGIN ?? "http://127.0.0.1:13612";
const APP = process.env.APP_ORIGIN ?? "http://127.0.0.1:5273";
const OUT = process.env.SHOT_DIR ?? "/tmp/link-preview-ui-shots";
mkdirSync(OUT, { recursive: true });

const STATES = [
  ["pending", "p-pending"],
  ["partial", "p-partial"],
  ["ready", "p-ready"],
  ["failed", "p-failed"],
  ["partial-fail", "p-partial-fail"],
  ["carousel", "p-carousel"],
];

const results = {
  app: APP,
  mock: MOCK,
  viewports: {},
  requests: {},
  overflow: {},
  heights: {},
  carousel: {},
  failedHybrid: {},
  settings: {},
  errors: [],
};

const feed = await (await fetch(`${MOCK}/api/feed?tab=recommended`)).json();
const accountsResult = await (await fetch(`${MOCK}/api/accounts`)).json();
const carouselPost = feed.posts.find((post) => post.id === "p-carousel");
const partialFailPost = feed.posts.find((post) => post.id === "p-partial-fail");
if (!carouselPost) throw new Error("mock feed missing p-carousel");
if (!partialFailPost) throw new Error("mock feed missing p-partial-fail");

function snapshotDocument(enabled) {
  const snapshot = {
    version: 1,
    as_of_seq: 10_000,
    viewer: "owner",
    bookmarks: [],
    accounts: accountsResult.accounts.map(({ created_at: _created, ...account }) => account),
    follows: [],
    posts: feed.posts,
    participants: {},
    media: [],
    preview_enabled: enabled,
  };
  return snapshot;
}

function updatedPreviews() {
  const stamp = Date.now();
  return carouselPost.previews.map((preview, index) => ({
    ...preview,
    title: `${preview.title} · 事件后更新`,
    updated_at: stamp + index,
  }));
}

let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });

  for (const [label, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    await fetch(`${MOCK}/__reset`, { method: "POST" });
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    page.on("pageerror", (error) => results.errors.push(`${label}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") results.errors.push(`${label}: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        results.errors.push(`${label}: HTTP ${response.status()} ${response.url()}`);
      }
    });

    await page.goto(`${APP}/?ep=${encodeURIComponent(MOCK)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="post-card"]', { timeout: 30_000 });
    await page.waitForSelector('article[data-post-id="p-ready"] [data-testid="link-preview-card"]', {
      timeout: 30_000,
    });

    // 单卡状态截图 + 高度测量
    const heights = {};
    for (const [state, postId] of STATES) {
      const scope = page.locator(`article[data-post-id="${postId}"]`);
      const previews = scope.locator('[data-testid="link-previews"]');
      await previews.waitFor({ timeout: 15_000 });
      const cards = previews.locator('[data-testid="link-preview-card"]');
      const count = await cards.count();
      const measured = [];
      for (let index = 0; index < count; index += 1) {
        measured.push(await cards.nth(index).boundingBox());
      }
      heights[state] = measured.map((box) => (box ? Math.round(box.height * 10) / 10 : null));
      await previews.screenshot({ path: join(OUT, `${label}-${state}.png`) });
    }
    results.heights[label] = heights;

    const pendingHeight = heights.pending?.[0];
    const partialHeight = heights.partial?.[0];
    const readyHeight = heights.ready?.[0];
    results.heights[label].deltaPartialReady = Math.abs((partialHeight ?? 0) - (readyHeight ?? 0));
    results.heights[label].deltaPendingReady = Math.abs((pendingHeight ?? 0) - (readyHeight ?? 0));

    // failed 混合策略：同一实例 partial → failed 必须保持槽位高度；冷启动 failed 保持 40px。
    const clickAndCheckOpener = async (locator) => {
      const [popup] = await Promise.all([
        context.waitForEvent("page", { timeout: 10_000 }),
        locator.click(),
      ]);
      const openerIsNull = await popup.evaluate(() => window.opener === null);
      const href = await locator.getAttribute("href");
      const rel = await locator.getAttribute("rel");
      const target = await locator.getAttribute("target");
      await popup.close();
      return { openerIsNull, href, rel, target };
    };
    const pfScope = page.locator('article[data-post-id="p-partial-fail"]');
    const pfPreviews = pfScope.locator('[data-testid="link-previews"]');
    const pfCard = pfPreviews.locator('[data-testid="link-preview-card"]');
    const beforeBox = await pfCard.boundingBox();
    await pfPreviews.screenshot({ path: join(OUT, `${label}-partial-before-fail.png`) });
    const failedPreview = {
      ...partialFailPost.previews[0],
      status: "failed",
      phase: "probe",
      error_code: "timeout",
      title: null,
      description: null,
      cover: null,
      fields_ready: [],
      updated_at: Date.now(),
    };
    const emitFail = await fetch(`${MOCK}/__emit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ post_id: "p-partial-fail", previews: [failedPreview] }),
    });
    if (!emitFail.ok) throw new Error(`partial→failed emit failed: ${emitFail.status}`);
    await pfScope
      .locator('[data-preview-reserved="true"]')
      .waitFor({ timeout: 15_000 });
    await page.waitForTimeout(300);
    const afterBox = await pfCard.boundingBox();
    await pfPreviews.screenshot({ path: join(OUT, `${label}-partial-after-fail.png`) });
    const reservedHeight = Math.round((afterBox?.height ?? 0) * 10) / 10;
    const beforeHeight = Math.round((beforeBox?.height ?? 0) * 10) / 10;
    results.failedHybrid[label] = {
      beforeHeight,
      afterHeight: reservedHeight,
      delta: Math.round(Math.abs(reservedHeight - beforeHeight) * 10) / 10,
      reservedSlot: true,
      coldFailedHeight: heights.failed?.[0],
      clickReserved: await clickAndCheckOpener(
        pfScope.locator('[data-testid="link-preview-failed-reserved"]'),
      ),
      clickCold: await clickAndCheckOpener(
        page.locator('article[data-post-id="p-failed"] [data-testid="link-preview-failed"]'),
      ),
    };
    await fetch(`${MOCK}/__reset`, { method: "POST" });

    // 三条轮播：翻到第 2 页 → 注入 post.updated → 页码保持
    const carousel = page.locator('article[data-post-id="p-carousel"] [data-testid="link-previews"]');
    const dots = carousel.locator('[data-testid="previews-dot"]');
    const dotCount = await dots.count();
    const feedRequestsBefore = requests.filter((url) => url.includes("/api/feed")).length;
    await dots.nth(1).click();
    await page.waitForTimeout(350);
    const activeIndexBefore = await carousel.getAttribute("data-active-index");
    const activeBefore = await carousel
      .locator('[data-testid="previews-dot"][aria-current="true"]')
      .getAttribute("aria-label");
    await carousel.screenshot({ path: join(OUT, `${label}-carousel-page2.png`) });
    // N7：只统计本次事件后的渲染次数（DEV 探针）。
    await page.evaluate(() => {
      window.__linkPreviewRenderCounts = {};
    });

    const emit = await fetch(`${MOCK}/__emit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ post_id: "p-carousel", previews: updatedPreviews() }),
    });
    if (!emit.ok) throw new Error(`emit failed: ${emit.status}`);
    await page.waitForFunction(
      () =>
        document
          .querySelector('article[data-post-id="p-carousel"] [data-testid="link-preview-card"]')
          ?.textContent?.includes("事件后更新") === true,
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(250);
    const activeIndexAfter = await carousel.getAttribute("data-active-index");
    const activeAfter = await carousel
      .locator('[data-testid="previews-dot"][aria-current="true"]')
      .getAttribute("aria-label");
    const feedRequestsAfter = requests.filter((url) => url.includes("/api/feed")).length;
    await carousel.screenshot({ path: join(OUT, `${label}-carousel-page2-after-event.png`) });
    const renderCounts = await page.evaluate(() => window.__linkPreviewRenderCounts ?? {});
    const carouselUrls = [
      "https://alpha.example/a",
      "https://beta.example/b",
      "https://gamma.example/c",
    ];
    const renderedUrls = Object.keys(renderCounts).filter((url) => renderCounts[url] > 0);
    const otherRendered = renderedUrls.filter((url) => !carouselUrls.includes(url));
    results.carousel[label] = {
      dotCount,
      activeIndexBefore,
      activeIndexAfter,
      activeBefore,
      activeAfter,
      preserved: activeBefore === activeAfter && activeIndexBefore === activeIndexAfter,
      feedRequestsBefore,
      feedRequestsAfter,
      feedRefetched: feedRequestsAfter !== feedRequestsBefore,
      renderSpy: {
        counts: renderCounts,
        renderedUrls,
        otherRendered,
        onlyAffectedPost: otherRendered.length === 0,
      },
    };

    const dotBox = await dots.first().boundingBox();
    results.a11y = results.a11y ?? {};
    results.a11y[label] = {
      dotWidth: dotBox ? Math.round(dotBox.width) : null,
      dotHeight: dotBox ? Math.round(dotBox.height) : null,
      prevLabel: await carousel.locator('[data-testid="previews-prev"]').getAttribute("aria-label"),
      nextLabel: await carousel.locator('[data-testid="previews-next"]').getAttribute("aria-label"),
    };

    const overflow = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    results.overflow[label] = overflow;
    await page.screenshot({ path: join(OUT, `${label}-feed.png`), fullPage: true });

    // 设置页：桌面从账号下拉，移动从账号抽屉
    if (label === "desktop") {
      await page.locator("aside").getByText("@owner").first().click();
      await page.locator('[data-testid="nav-settings"]').click();
    } else {
      await page.locator('[data-testid="home-account-button"]').click();
      await page.locator('[data-testid="account-menu-settings"]').click();
    }
    await page.waitForSelector('[data-testid="settings-sheet"]');
    await page.waitForTimeout(400);
    const toggle = page.locator('[data-testid="plugin-toggle"]');
    const workerError = (await page.locator('[data-testid="plugin-worker-error"]').count()) > 0
      ? await page.locator('[data-testid="plugin-worker-error"]').innerText()
      : null;
    results.settings[label] = {
      toggleVisible: await toggle.isVisible(),
      toggleDisabled: await toggle.isDisabled(),
      meta: await page.locator('[data-testid="plugin-meta"]').innerText(),
      worker: await page.locator('[data-testid="plugin-worker-status"]').innerText(),
      workerError,
      dependency: await page.locator('[data-testid="plugin-dependencies"]').innerText(),
      privacyVisible: await page.locator('[data-testid="plugin-privacy"]').isVisible(),
      readonlyVisible: (await page.locator('[data-testid="plugin-readonly"]').count()) > 0,
      pluginsRequests: requests.filter((url) => url.includes("/api/plugins")).length,
    };
    await page.screenshot({ path: join(OUT, `${label}-settings.png`) });

    if (label === "desktop") {
      // 关闭插件：整块预览消失（正文裸 URL 仍可点）；再打开恢复。
      const cardCountBefore = await page.locator('[data-testid="link-previews"]').count();
      await toggle.click();
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="link-previews"]').length === 0,
        undefined,
        { timeout: 15_000 },
      );
      const hidden = (await page.locator('[data-testid="link-previews"]').count()) === 0;
      await page.screenshot({ path: join(OUT, `${label}-plugin-off.png`) });
      await toggle.click();
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="link-previews"]').length > 0,
        undefined,
        { timeout: 15_000 },
      );
      const restored = (await page.locator('[data-testid="link-previews"]').count()) > 0;
      results.settings.desktop.pluginToggle = { cardCountBefore, hidden, restored };
    }
    await page.locator('[data-testid="settings-sheet"] [data-slot="sheet-close"]').click();
    await page.waitForSelector('[data-testid="settings-sheet"]', { state: "detached" });

    // N1：focus 主链接后注入 status=partial，activeElement 必须仍是同一主链接。
    const pendingPost = feed.posts.find((post) => post.id === "p-pending");
    const pendingLink = page.locator(
      'article[data-post-id="p-pending"] [data-testid="link-preview-open"]',
    );
    await pendingLink.focus();
    const focusBefore = await page.evaluate(() => ({
      testid: document.activeElement?.getAttribute("data-testid") ?? null,
      post: document.activeElement?.closest("article")?.getAttribute("data-post-id") ?? null,
    }));
    const focusPreview = {
      ...pendingPost.previews[0],
      status: "partial",
      phase: "meta",
      title: "焦点探针",
      description: "状态更新后焦点仍在主链接。",
      updated_at: Date.now(),
    };
    const focusEmit = await fetch(`${MOCK}/__emit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ post_id: "p-pending", previews: [focusPreview] }),
    });
    if (!focusEmit.ok) throw new Error(`focus emit failed: ${focusEmit.status}`);
    await page.waitForFunction(
      () =>
        document
          .querySelector('article[data-post-id="p-pending"] [data-testid="link-preview-card"]')
          ?.getAttribute("data-preview-status") === "partial",
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(250);
    const focusAfter = await page.evaluate(() => ({
      testid: document.activeElement?.getAttribute("data-testid") ?? null,
      post: document.activeElement?.closest("article")?.getAttribute("data-post-id") ?? null,
    }));
    results.focusProbe = results.focusProbe ?? {};
    results.focusProbe[label] = {
      before: focusBefore,
      after: focusAfter,
      retained:
        focusBefore.testid === "link-preview-open" &&
        focusAfter.testid === "link-preview-open" &&
        focusBefore.post === "p-pending" &&
        focusAfter.post === "p-pending",
    };
    await fetch(`${MOCK}/__reset`, { method: "POST" });

    results.requests[label] = {
      feed: requests.filter((url) => url.includes("/api/feed")).length,
      plugins: requests.filter((url) => url.includes("/api/plugins")).length,
      total: requests.length,
    };
    await context.close();
  }

  // ── agent 只读（P1-19）──────────────────────────────────────────────────────
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.route(`${MOCK}/api/status`, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.account = { id: "agent", role: "agent" };
      await route.fulfill({ response, json });
    });
    await page.goto(`${APP}/?ep=${encodeURIComponent(MOCK)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="post-card"]', { timeout: 30_000 });
    await page.waitForSelector('article[data-post-id="p-ready"] [data-testid="link-previews"]', {
      timeout: 30_000,
    });
    await page.locator("aside button").filter({ hasText: "@" }).first().click();
    await page.locator('[data-testid="nav-settings"]').click();
    await page.waitForSelector('[data-testid="settings-sheet"]');
    await page.waitForTimeout(300);
    const toggle = page.locator('[data-testid="plugin-toggle"]');
    results.settings.agent = {
      toggleVisible: await toggle.isVisible(),
      toggleDisabled: await toggle.isDisabled(),
      readonly: await page.locator('[data-testid="plugin-readonly"]').innerText(),
    };
    await page.screenshot({ path: join(OUT, "desktop-settings-agent.png") });
    await context.close();
  }

  // ── N2 首帧门：延迟 /api/plugins + 关闭态、能力矩阵 feature=false ────────────
  async function runN2Gate(label, config) {
    await fetch(`${MOCK}/__config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(`${APP}/?ep=${encodeURIComponent(MOCK)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="post-card"]', { timeout: 30_000 });
    const samples = [];
    for (let index = 0; index < 20; index += 1) {
      samples.push(await page.locator('[data-testid="link-previews"]').count());
      await page.waitForTimeout(100);
    }
    results.n2Gate = results.n2Gate ?? {};
    results.n2Gate[label] = {
      samples,
      maxBlocks: Math.max(...samples),
      stableBlocks: samples[samples.length - 1],
      noFlash: samples.every((count) => count === 0),
    };
    await context.close();
    await fetch(`${MOCK}/__reset`, { method: "POST" });
  }

  await runN2Gate("plugin-off-delayed", {
    pluginDelayMs: 1200,
    pluginEnabled: false,
    previewFields: true,
  });
  await runN2Gate("feature-false", {
    pluginDelayMs: 0,
    pluginEnabled: true,
    previewFields: false,
  });

  // ── 静态归档（P1-14/P1-17/P1-19）：零 /api/plugins ──────────────────────────
  async function runStatic(viewport, label, enabled) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    page.on("pageerror", (error) => results.errors.push(`${label}: ${error.message}`));
    const html = await (await fetch(`${APP}/`)).text();
    const injected = html.replace(
      '<div id="root"></div>',
      `<div id="root"></div><script type="application/json" id="report-snapshot">${JSON.stringify(
        snapshotDocument(enabled),
      )}</script>`,
    );
    await page.route(`${APP}/`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: injected }),
    );
    await page.goto(`${APP}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="post-card"]', { timeout: 30_000 });
    await page.waitForTimeout(500);
    const cards = await page.locator('[data-testid="link-preview-card"]').count();
    const plain = await page.locator('[data-testid="link-preview-plain-link"]').count();
    const roots = await page.locator('[data-testid="link-previews"]').count();
    const carousels = await page
      .locator('[data-testid="link-previews"]:has([data-testid="previews-dot"])')
      .count();
    const apiRequests = requests.filter((url) => url.startsWith(MOCK));
    results.settings[label] = {
      previewEnabled: enabled,
      cards,
      plain,
      roots,
      carousels,
      apiRequests: apiRequests.length,
      pluginRequests: requests.filter((url) => url.includes("/api/plugins")).length,
    };
    await page.screenshot({ path: join(OUT, `${label}-feed.png`), fullPage: true });
    if (enabled) {
      if (viewport.width < 1024) {
        await page.locator('[data-testid="home-account-button"]').click();
        await page.locator('[data-testid="account-menu-settings"]').click();
      } else {
        await page.locator("aside").getByText("@owner").first().click();
        await page.locator('[data-testid="nav-settings"]').click();
      }
      await page.waitForSelector('[data-testid="settings-sheet"]');
      await page.waitForTimeout(300);
      results.settings[label].settings = {
        toggleDisabled: await page.locator('[data-testid="plugin-toggle"]').isDisabled(),
        readonly: await page.locator('[data-testid="plugin-readonly"]').innerText(),
        meta: await page.locator('[data-testid="plugin-meta"]').innerText(),
      };
      await page.screenshot({ path: join(OUT, `${label}-settings.png`) });
    }
    await context.close();
  }

  await runStatic({ width: 1280, height: 900 }, "static-desktop", true);
  await runStatic({ width: 390, height: 844 }, "static-mobile", true);
  await runStatic({ width: 1280, height: 900 }, "static-disabled", false);
} finally {
  if (browser) await browser.close();
}

writeFileSync(join(OUT, "assertions.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log(`screenshots → ${OUT}`);

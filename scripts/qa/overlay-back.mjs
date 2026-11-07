/**
 * 浮层返回关闭 + 共享元素通用化验收（可复现版）。
 *
 * Isolation: reads/writes ONLY the disposable backend from REPORT_QA_BASE, or
 * auto-starts scripts/qa/qa-serve.mjs (fresh /tmp/report-qa-* board). It never
 * talks to the production board; bookmark toggles stay inside the temp SQLite.
 *
 * Run:
 *   bun scripts/qa/overlay-back.mjs
 *   REPORT_QA_BASE=http://127.0.0.1:13688 bun scripts/qa/overlay-back.mjs
 *
 * The backend URL is also usable by any other shell as
 * `?ep=http://127.0.0.1:<port>` — that is the before/after two-shell setup.
 */
import { chromium } from "playwright-core";
import { accountToken, apiJson, authSecret, ensureQa } from "./lib/qa-env.mjs";

const qa = await ensureQa(process.argv.slice(2));
const BASE = qa.base;
const EP = qa.base;
const AUTH = authSecret(qa.dataDir);
const ownerToken = accountToken(qa.dataDir, "owner");

const feed = await apiJson(BASE, "/api/read?limit=100", ownerToken);
const posts = (feed.posts ?? []).filter((post) => !post.deleted_at);
const mediaPost = posts.find((post) => (post.media ?? []).length > 0);
const threadPost =
  posts.find((post) => post.parent_id === null && (post.reply_count ?? 0) > 0) ??
  mediaPost ??
  posts[0];
if (!mediaPost || !threadPost) throw new Error("isolated fixtures are missing posts/media");
const MEDIA_POST = mediaPost.id;
const THREAD_POST = threadPost.id;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

let browser = null;
try {
  browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 160));
  });
  await page.goto(`${BASE}/?ep=${encodeURIComponent(EP)}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  if (await page.locator('input[type="password"]').count()) {
    await page.locator('input[type="password"]').first().fill(AUTH);
    await page.click('[data-testid="login-submit"]');
    await page.waitForTimeout(2500);
  }

  const goto = async (hash) => {
    await page.evaluate((h) => {
      location.hash = h;
    }, hash);
    await page.waitForTimeout(1300);
  };
  const mediaOpenButton = () =>
    page
      .locator(
        '[data-variant="focal"] [aria-label="查看视频"], [data-variant="focal"] [aria-label="查看图片"]',
      )
      .first();
  const morphProps = () =>
    page.evaluate(() => {
      const groups = document
        .getAnimations()
        .map((a) => ({
          pseudo:
            a.effect && "pseudoElement" in a.effect ? String(a.effect.pseudoElement) : "",
          frames: a.effect?.getKeyframes?.() ?? [],
        }))
        .filter((row) => /group\(vt-(avatar|author)-/.test(row.pseudo));
      return groups.map((row) => ({
        pseudo: row.pseudo,
        props: [
          ...new Set(
            row.frames
              .flatMap((f) => Object.keys(f))
              .filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)),
          ),
        ],
      }));
    });
  // View-transition animations can start a few frames after the click; poll
  // instead of sampling once (a single 120ms sample is flaky under load).
  const waitForMorph = async (timeout = 900) => {
    const deadline = Date.now() + timeout;
    let last = [];
    while (Date.now() < deadline) {
      last = await morphProps();
      if (
        last.some((m) => ["width", "height", "transform"].some((p) => m.props.includes(p)))
      ) {
        return last;
      }
      await page.waitForTimeout(40);
    }
    return last;
  };

  // ── 查看器：返回关闭 ───────────────────────────────────────────────────────
  await goto(`#/p/${MEDIA_POST}`);
  const hashBefore = await page.evaluate(() => location.hash);
  await mediaOpenButton().click();
  await page.waitForTimeout(700);
  check("点击媒体打开查看器", await page.locator('[data-testid="image-viewer"]').isVisible());
  await page.evaluate(() => history.back());
  await page.waitForTimeout(800);
  check("返回键/手势关闭查看器", (await page.locator('[data-testid="image-viewer"]').count()) === 0);
  check("关闭查看器不改变路由", (await page.evaluate(() => location.hash)) === hashBefore);

  await mediaOpenButton().click();
  await page.waitForTimeout(600);
  const stateWithViewer = await page.evaluate(() => JSON.stringify(history.state));
  await page.click('[data-testid="viewer-close"]');
  await page.waitForTimeout(800);
  const stateAfterClose = await page.evaluate(() => JSON.stringify(history.state));
  check("X 关闭查看器", (await page.locator('[data-testid="image-viewer"]').count()) === 0);
  check(
    "X 关闭后合成条目被弹回（当前条目不再是浮层）",
    stateWithViewer.includes("__overlay") && !stateAfterClose.includes("__overlay"),
    `${stateWithViewer} → ${stateAfterClose}`,
  );

  // ── 回归：点通知列表“第二项”必须由该项自己的主体做共享动画 ─────────────────
  await goto("#/notifications");
  {
    const rows = page.locator('[data-testid="notification-row"][data-post-id]');
    const count = await rows.count();
    check("通知列表至少两行（回归前提）", count >= 2, `rows=${count}`);
    if (count >= 2) {
      const firstId = await rows.nth(0).getAttribute("data-post-id");
      const secondId = await rows.nth(1).getAttribute("data-post-id");
      const idleNames = await page.evaluate(() =>
        [...document.querySelectorAll("[data-vt-intent]")].map((el) =>
          el.getAttribute("data-vt-intent"),
        ),
      );
      check("列表静止时没有预置共享意图", idleNames.length === 0, JSON.stringify(idleNames));
      const row1Y = await rows.nth(0).locator("[data-shared-avatar]").boundingBox();
      const row2Y = await rows.nth(1).locator("[data-shared-avatar]").boundingBox();
      await page.evaluate(() => {
        const original = document.startViewTransition.bind(document);
        globalThis.__vtIntentProbe = null;
        document.startViewTransition = (callback) => {
          globalThis.__vtIntentProbe = [...document.querySelectorAll("[data-vt-intent]")].map(
            (el) => ({
              intent: el.getAttribute("data-vt-intent"),
              y: Math.round(el.getBoundingClientRect().y),
              target: el.closest("[data-post-id]")?.getAttribute("data-post-id") ?? null,
            }),
          );
          return original(callback);
        };
      });
      await rows.nth(1).click();
      await page.waitForTimeout(140);
      const intentProbe = await page.evaluate(() => globalThis.__vtIntentProbe);
      const avatarIntent = (intentProbe ?? []).filter((el) => el.intent === "avatar");
      check(
        "意图名打在第二条（按屏幕位置区分，而非帖 id）",
        avatarIntent.length === 1 &&
          Math.abs(avatarIntent[0].y - row2Y.y) <= 2 &&
          Math.abs(avatarIntent[0].y - row1Y.y) > 2,
        JSON.stringify({ probe: avatarIntent, row1Y: row1Y.y, row2Y: row2Y.y }),
      );
      const groups = await page.evaluate(() =>
        document
          .getAnimations()
          .map((a) => (a.effect && "pseudoElement" in a.effect ? String(a.effect.pseudoElement) : ""))
          .filter((p) => p.includes("::view-transition-group(vt-")),
      );
      check(
        "共享组名指向被点行目标",
        groups.some((g) => g.includes(secondId)),
        `${secondId} → ${groups.join(", ")}`,
      );
      check(
        "第一行目标不参与本次动画",
        firstId === secondId || !groups.some((g) => g.includes(firstId)),
        `${firstId} → ${groups.join(", ")}`,
      );
      await page.waitForTimeout(1100);
      const intentLeft = await page.evaluate(
        () => document.querySelectorAll("[data-vt-intent]").length,
      );
      check("落定后意图标记已清理", intentLeft === 0, `left=${intentLeft}`);
    }
  }

  // ── 抽屉 / sheet：返回关闭 ────────────────────────────────────────────────
  await goto("#/");
  await page.click('[data-testid="home-account-button"]');
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  check("Esc 关闭账号抽屉", (await page.locator('[data-testid="account-sheet"]').count()) === 0);
  check("关闭抽屉不改变路由", (await page.evaluate(() => location.hash)) === "#/");
  await page.click('[data-testid="home-info-button"]');
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  check("Esc 关闭信息 sheet", (await page.locator('[data-testid="info-sheet"]').count()) === 0);

  // ── 共享元素：非首页入口要“形变”而不是淡入 ────────────────────────────────
  async function morphCheck(label, prepare, clickSelector, clickPosition = null) {
    await prepare();
    const target = page.locator(clickSelector).last();
    if (!(await target.count())) {
      check(`${label}：存在可点目标`, false);
      return;
    }
    await target.click(clickPosition ? { position: clickPosition } : {});
    const morph = await waitForMorph();
    const has = morph.some((m) =>
      ["width", "height", "transform"].some((p) => m.props.includes(p)),
    );
    check(
      `${label}：共享元素形变（非淡入）`,
      morph.length > 0 && has,
      JSON.stringify(morph).slice(0, 200),
    );
    await page.waitForTimeout(800);
    await goto("#/");
  }

  await morphCheck(
    "通知 → 帖子",
    async () => {
      await goto("#/notifications");
    },
    // Only rows with a concrete target post can open a thread.
    '[data-testid="notification-row"][data-post-id]',
  );
  await morphCheck(
    "标签页 → 帖子",
    async () => {
      await goto("#/tag/result");
    },
    '[data-testid="feed-swap"] [data-post-id]',
  );
  await morphCheck(
    "成员页 → 帖子",
    async () => {
      await goto("#/u/manager");
    },
    '[data-testid="feed-swap"] [data-post-id]',
  );
  await morphCheck(
    "收藏页 → 帖子",
    async () => {
      await goto(`#/p/${MEDIA_POST}`);
      const btn = page.locator('[data-variant="focal"] [data-testid="action-bookmark"]');
      if ((await btn.getAttribute("aria-pressed")) !== "true") {
        await btn.click();
        await page.waitForTimeout(700);
      }
      await goto("#/bookmarks");
    },
    '[data-testid="feed-swap"] [data-post-id]',
    // The media card's center is the image (opens the viewer); click the
    // article's top-left padding so the card itself handles the open.
    { x: 8, y: 8 },
  );

  // 回复 → 帖子（详情内点回复卡）
  await goto(`#/p/${THREAD_POST}`);
  const replyCards = page.locator('[data-variant="reply"][data-post-id]');
  let reply = null;
  for (let i = (await replyCards.count()) - 1; i >= 0; i -= 1) {
    const text = await replyCards.nth(i).innerText();
    if (!text.includes("此帖已删除")) {
      reply = replyCards.nth(i);
      break;
    }
  }
  if (reply) {
    await reply.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await page.waitForTimeout(200);
    await reply.click({ position: { x: 220, y: 34 } });
    const morph = await waitForMorph();
    check(
      "回复 → 帖子：共享元素形变（非淡入）",
      morph.some((m) => ["width", "height", "transform"].some((p) => m.props.includes(p))),
      JSON.stringify(morph).slice(0, 200),
    );
  } else {
    check("回复 → 帖子：存在回复卡（可测）", false, "无回复卡");
  }

  check("无页面运行时错误", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  if (browser) await browser.close();
  await qa.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;

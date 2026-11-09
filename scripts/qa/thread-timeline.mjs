#!/usr/bin/env bun
/**
 * 线程 timeline（全平铺、无缩进）验收 — openspec change report-thread-timeline §6.2
 *
 * Isolation: reads/writes ONLY the disposable backend from REPORT_QA_BASE, or
 * auto-starts scripts/qa/qa-serve.mjs with --no-seed (fresh /tmp/report-qa-*
 * board). The production board (13689) is never contacted. Every fixture below
 * is created through the authenticated HTTP API on that temp board.
 *
 * Run:
 *   bun scripts/qa/thread-timeline.mjs
 *   REPORT_QA_BASE=http://127.0.0.1:13688 bun scripts/qa/thread-timeline.mjs
 *
 * Assertions (both 390×844 and 1280×900):
 *   1  无祖先展开入口（ancestors-toggle=0 / 无「条上文」）
 *   2  进入即 focal 贴顶 + scrollTop>0（有祖先）
 *   3  向上滚动读到根帖，全程无点击/展开
 *   4  focal 不被上文挤出视口（可见高度 ≥ 60%）
 *   5  延迟 /api/thread 400ms：rAF 60 帧 focal 顶边极差 ≤2px
 *   6  无缩进：reply 行 marginLeft=0、所有 post 行 padding-left=16px
 *   7  头像列：普通行 46px、中心 x=39±1（正文列恒 68）
 *   8  无层级控件（collapse-depth / expand-branch / 继续 N 层回复）
 *   9  子线程入口存在且可导航
 *  10  平铺先序 = 父子相邻（同级按 (created_at, seq, id) 升序；report-thread-nesting）
 *  11  「回复给 @x」只在父帖非上一行时出现
 *  12  紧凑行：24px 头像与普通行同轴（中心 39±1，gutter 17）+ 同一 trunk
 *  13  相邻行导轨 1px 内相接（left=38 / width=2）
 *  14  focal 贴顶 stub 高度 === focalAvatarTop-containerTop（22，精确相等）
 *  15  删除占位行不断轨
 *  16  返回恢复首可见行 + 偏移 ±2px
 *  17  9 层深链 focal 不丢 + context-gap 可导航
 *  18  共享元素仍形变（vt-avatar / vt-author）
 *  19  reduced-motion 首帧到位
 *  20  0 console error / 390 宽无横向溢出
 *
 * Screenshots: src/ui/.qa/thread-timeline/<mobile|desktop>-<nn>-<name>.png
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountToken, apiJson, argValue, authSecret, ensureQa } from "./lib/qa-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(HERE, "../../src/ui/.qa/thread-timeline");

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
// F1：4 条祖先（含长正文 + 一条删除）→ focal（depth 5）→ 3 条回复（depth 6，仍在 maxDepth 内）
F.chainRoot = await createPost(ownerToken, "TL1 根帖：深链上下文验收基线。\n\n向上滚动应能读到这一段。");
F.a1 = await createReply(ownerToken, F.chainRoot, "TL1-A1 第一层祖先。");
F.a2 = await createReply(managerToken, F.a1, "TL1-A2 第二层祖先（随后删除，验证断轨占位）。");
F.a3 = await createReply(ownerToken, F.a2, "TL1-A3 第三层祖先。");
F.a4 = await createReply(
  ownerToken,
  F.a3,
  "TL1-A4 长正文祖先。\n\n" +
    Array.from({ length: 42 }, (_, index) => `- 长正文第 ${index + 1} 行：祖先正文不截断。`).join("\n"),
);
F.focal = await createReply(
  ownerToken,
  F.a4,
  "TL1-FOCAL 焦点帖：进入后应贴住吸顶栏下沿。\n\n向上滚动可读到根帖。",
);
F.r1 = await createReply(managerToken, F.focal, "TL1-R1 焦点帖回复一。");
F.r2 = await createReply(ownerToken, F.focal, "TL1-R2 焦点帖回复二。");
F.r3 = await createReply(managerToken, F.focal, "TL1-R3 焦点帖回复三。");

// F2：交错分支 A→B(t1)、A→C(t2)、B→D(t3)、C→E(t4)
F.branchRoot = await createPost(ownerToken, "TL2 根帖：交错分支时间序验收。");
F.B = await createReply(managerToken, F.branchRoot, "TL2-B t1");
F.C = await createReply(managerToken, F.branchRoot, "TL2-C t2");
F.D = await createReply(managerToken, F.B, "TL2-D t3 紧邻父帖 B（父帖就是上一行）");
F.E = await createReply(managerToken, F.C, "TL2-E t4");

// F3：深层多人对话（>3 层，验证无 3 级封顶）
F.deepRoot = await createPost(ownerToken, "TL3 根帖：深层多人对话。");
F.d1 = await createReply(managerToken, F.deepRoot, "TL3-D1 第 1 层");
F.d2 = await createReply(ownerToken, F.d1, "TL3-D2 第 2 层");
F.d3 = await createReply(managerToken, F.d2, "TL3-D3 第 3 层");
F.d4 = await createReply(ownerToken, F.d3, "TL3-D4 第 4 层");

// F4：连续自接链（同作者父子相邻 → 紧凑行 + 连续 trunk）
F.selfRoot = await createPost(ownerToken, "TL4 根帖：自接链。");
F.s1 = await createReply(ownerToken, F.selfRoot, "TL4-S1 连续自接一。");
F.s2 = await createReply(ownerToken, F.s1, "TL4-S2 连续自接二。");
// 紧凑链之后再插一条他人回复：截图要拍到「紧凑行 → 46px 普通回复」的过渡
F.s3 = await createReply(managerToken, F.s2, "TL4-S3 紧凑链之后的普通回复（46px 头像 + 操作行）。");

// F5：9 层链（root + n1..n8）；n3 用于子线程入口，n8 用于 focal 缺失回退
F.nineRoot = await createPost(ownerToken, "TL5 根帖：9 层深链。");
F.nine = [];
for (let index = 1; index <= 8; index += 1) {
  const parent = index === 1 ? F.nineRoot : F.nine[index - 2];
  F.nine.push(await createReply(ownerToken, parent, `TL5-N${index} 第 ${index} 层`));
}
F.nineC3 = F.nine[2];
F.nineC8 = F.nine[7];

// F6：混合作者 9 层链（B1 深链拓扑）：focal 缺失时不得把不可解析祖先平铺成回复
F.mixRoot = await createPost(ownerToken, "TL6 根帖：混合作者深链。");
F.mix = [];
for (let index = 1; index <= 8; index += 1) {
  const parent = index === 1 ? F.mixRoot : F.mix[index - 2];
  const token = index % 2 === 1 ? managerToken : ownerToken;
  F.mix.push(
    await createReply(token, parent, `TL6-M${index} 第 ${index} 层（${index % 2 === 1 ? "manager" : "owner"}）`),
  );
}
F.mixFocal = F.mix[7];

// F7：种子阶段幻影入口（B2）：root 有 15 条回复（seed.child_count = reply_count）
F.seedRoot = await createPost(ownerToken, "TL7 根帖：种子阶段入口验收（15 条回复）。");
for (let index = 1; index <= 15; index += 1) {
  await createReply(index % 2 ? managerToken : ownerToken, F.seedRoot, `TL7-R${index} 回复`);
}

// F8：j/k 长列表（12 条回复，保证 10 次 j 后必须滚动）
F.kbRoot = await createPost(ownerToken, "TL8 根帖：j/k 锚定锁验收。");
for (let index = 1; index <= 12; index += 1) {
  await createReply(index % 2 ? managerToken : ownerToken, F.kbRoot, `TL8-R${index} 回复`);
}

// 删除 A2（软删 → 祖先链中的占位行）
await apiJson(BASE, `/api/posts/${encodeURIComponent(F.a2)}`, ownerToken, { method: "DELETE" });

const threadOf = async (postId) =>
  (await apiJson(BASE, `/api/thread/${encodeURIComponent(postId)}?focal=${encodeURIComponent(postId)}`, ownerToken))
    .thread;

// ── 浏览器辅助 ────────────────────────────────────────────────────────────────
const wait = (page, ms) => page.waitForTimeout(ms);

async function gotoHash(page, hash, ms = 1500) {
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

/** 每行几何 + 导轨段（自由函数，页面内执行）。 */
const READ_GEOMETRY = () => {
  const container = document.querySelector('[data-testid="thread-scroll"]');
  if (!container) return null;
  const box = (el) => {
    const rect = el.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  };
  const rows = [...document.querySelectorAll("[data-timeline-row]")].map((row) => {
    const rowBox = box(row);
    const avatar = row.querySelector("[data-shared-avatar]");
    const article = row.querySelector("article[data-post-id]");
    const author = row.querySelector("[data-shared-author]");
    const compactCard = row.querySelector('[data-testid="post-self-continuation"]');
    const articleClasses = article?.className ?? "";
    const rails = [
      ...row.querySelectorAll('[data-testid="thread-rail"], [data-testid="thread-rail-stub"]'),
    ].map((rail) => {
      const railBox = box(rail);
      return {
        ...railBox,
        leftRel: railBox.left - rowBox.left,
        kind: rail.getAttribute("data-thread-rail"),
        stub: rail.getAttribute("data-testid") === "thread-rail-stub",
      };
    });
    const avatarBox = avatar ? box(avatar) : null;
    return {
      kind: row.getAttribute("data-timeline-row"),
      postId: row.getAttribute("data-post-id"),
      railPosition: row.getAttribute("data-rail-position"),
      ...rowBox,
      marginLeft: getComputedStyle(row).marginLeft,
      paddingLeft: article ? getComputedStyle(article).paddingLeft : null,
      authorText: author ? author.innerText.replace(/\s+/g, " ").trim() : null,
      compact: Boolean(compactCard),
      selected: /ring-2|bg-accent\/50/.test(articleClasses),
      avatar: avatarBox
        ? { ...avatarBox, center: avatarBox.left + avatarBox.width / 2, centerRel: avatarBox.left + avatarBox.width / 2 - rowBox.left }
        : null,
      rails,
      text: row.innerText.replace(/\s+/g, " ").slice(0, 160),
    };
  });
  const focalRow = document.querySelector('[data-timeline-row="focal"]');
  const focalArticle = focalRow?.querySelector("article[data-post-id]");
  const px = (el, prop) => (el ? parseFloat(getComputedStyle(el)[prop]) || 0 : 0);
  const focalMetrics = focalArticle
    ? {
        bodyFont: px(focalArticle.querySelector('[data-testid="post-body"]'), "fontSize"),
        bodyLine: px(focalArticle.querySelector('[data-testid="post-body"]'), "lineHeight"),
        nameFont: px(focalArticle.querySelector("[data-shared-author] span"), "fontSize"),
        timeFont: px(
          (() => {
            const spans = focalArticle.querySelectorAll("[data-shared-author] span");
            return spans.length ? spans[spans.length - 1] : null;
          })(),
          "fontSize",
        ),
        avatar: focalRow?.querySelector("[data-shared-avatar]")
          ? box(focalRow.querySelector("[data-shared-avatar]")).width
          : 0,
        icon: px(focalArticle.querySelector('[data-testid="post-actions"] svg'), "width"),
        firstIconLeftRel: (() => {
          const icon = focalArticle.querySelector('[data-testid="post-actions"] svg');
          return icon ? box(icon).left - box(focalArticle).left : null;
        })(),
        inkGap: (() => {
          const actions = focalArticle.querySelector('[data-testid="post-actions"]');
          const body = focalArticle.querySelector('[data-testid="post-body"]');
          const button = actions?.querySelector("button");
          const icon = actions?.querySelector("svg");
          if (!actions || !body || !button || !icon) return null;
          const bodyStyle = getComputedStyle(body);
          const leading =
            (parseFloat(bodyStyle.lineHeight) - parseFloat(bodyStyle.fontSize)) / 2;
          return (
            box(actions).top +
            (box(button).height - parseFloat(getComputedStyle(icon).width)) / 2 -
            (box(body).bottom - leading)
          );
        })(),
        actionsLeft: (() => {
          const actions = focalArticle.querySelector('[data-testid="post-actions"]');
          const body = focalArticle.querySelector('[data-testid="post-body"]');
          if (!actions || !body || !focalArticle) return null;
          return {
            bodyBottom: box(body).bottom,
            actionsTop: box(actions).top,
            actionsRight: box(actions).right,
            actionsWidth: box(actions).width,
            bodyWidth: box(body).width,
            textRight: box(focalArticle).right - 16,
          };
        })(),
      }
    : null;
  const footer = focalRow?.querySelector("[data-testid=\"reply-count\"]")?.parentElement ?? null;
  const footerBox = footer ? box(footer) : null;
  const footerFirst = footer?.firstElementChild ?? null;
  const footerFirstBox = footerFirst ? box(footerFirst) : null;
  return {
    anchor: container.getAttribute("data-anchor"),
    container: { ...box(container), scrollTop: container.scrollTop, scrollHeight: container.scrollHeight, clientHeight: container.clientHeight },
    rows,
    bodyOverflow: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    },
    focalMetrics,
    railColor: (() => {
      const rail = document.querySelector('[data-testid="thread-rail"]');
      return rail ? getComputedStyle(rail).backgroundColor : null;
    })(),
    header: (() => {
      // 详情覆盖层下根页仍挂载（两个 header）：只取线程页自己那条。
      const header = document.querySelector('[data-testid="thread-back"]')?.closest("header") ?? null;
      if (!header) return null;
      const style = getComputedStyle(header);
      return {
        background: style.backgroundColor,
        backdrop: style.backdropFilter || style.webkitBackdropFilter,
        borderBottom: style.borderBottomColor,
      };
    })(),
    focalInkTop: focalArticle
      ? (() => {
          const body = focalArticle.querySelector("[data-shared-author]");
          return body ? box(body).top - box(container).top : null;
        })()
      : null,
    footer: footerFirstBox
      ? {
          leftRel: footerFirstBox.left - (focalRow ? box(focalRow).left : 0),
          text: footer?.innerText.replace(/\s+/g, " ").trim() ?? "",
          railRightRel:
            [...(focalRow?.querySelectorAll('[data-testid="thread-rail"]') ?? [])]
              .map((rail) => box(rail).right - (focalRow ? box(focalRow).left : 0))
              .sort((a, b) => b - a)[0] ?? 0,
        }
      : null,
    ancestorsToggle: document.querySelectorAll('[data-testid="ancestors-toggle"]').length,
    collapseDepth: document.querySelectorAll('[data-testid="collapse-depth"]').length,
    expandBranch: document.querySelectorAll('[data-testid="expand-branch"]').length,
    bodyText: document.body.innerText,
  };
};

const firstVisible = (geometry) => {
  const top = geometry.container.top;
  for (const row of geometry.rows) {
    if (!row.postId) continue;
    if (row.bottom > top + 1) return { anchorId: row.postId, offsetPx: row.top - top };
  }
  return { anchorId: null, offsetPx: 0 };
};

const morphProps = () => {
  const groups = document
    .getAnimations()
    .map((animation) => ({
      pseudo:
        animation.effect && "pseudoElement" in animation.effect
          ? String(animation.effect.pseudoElement)
          : "",
      frames: animation.effect?.getKeyframes?.() ?? [],
    }))
    .filter((row) => /group\(vt-(avatar|author)-/.test(row.pseudo));
  return groups.map((row) => ({
    pseudo: row.pseudo,
    props: [
      ...new Set(
        row.frames
          .flatMap((frame) => Object.keys(frame))
          .filter((key) => !["offset", "easing", "composite", "computedOffset"].includes(key)),
      ),
    ],
  }));
};

async function waitForMorph(page, timeout = 1000) {
  const deadline = Date.now() + timeout;
  let last = [];
  while (Date.now() < deadline) {
    last = await page.evaluate(morphProps);
    if (last.some((entry) => ["width", "height", "transform"].some((prop) => entry.props.includes(prop)))) {
      return last;
    }
    await wait(page, 40);
  }
  return last;
}

async function openPage(browser, viewport, mobile, reducedMotion = "no-preference") {
  const context = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile, reducedMotion });
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
  const shot = async (page, index, name) => {
    const path = `${SHOT_DIR}/${label}-${String(index).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path });
    return path;
  };
  const shots = {};

  const { context, page, errors } = await openPage(browser, viewport, mobile);

  // ── ① F1：进入即贴顶 / 祖先在上 / 无展开入口 / stub / 头像同列 / 导轨 ─────────
  await gotoHash(page, `#/p/${F.focal}`, 1800);
  await waitForThread(page, { ancestors: 5, replies: 3 });
  await wait(page, 400);
  let geometry = await page.evaluate(READ_GEOMETRY);

  check(label, "1 无 ancestors-toggle 入口", geometry.ancestorsToggle === 0, `count=${geometry.ancestorsToggle}`);
  check(label, "1 页面无「条上文」文案", !/条上文/.test(geometry.bodyText));
  check(label, "8 无 collapse-depth / expand-branch", geometry.collapseDepth === 0 && geometry.expandBranch === 0);
  check(label, "8 无「继续 N 层回复」", !/继续 \d+ 层回复/.test(geometry.bodyText));

  const focalRow = geometry.rows.find((row) => row.kind === "focal");
  const anchorDelta = focalRow ? focalRow.top - geometry.container.top : Number.NaN;
  const focalOffset = focalRow ? geometry.container.scrollTop + (focalRow.top - geometry.container.top) : Number.NaN;
  check(
    label,
    "2 进入即 focal 贴顶（top−container.top ∈ [-2,2]）",
    Math.abs(anchorDelta) <= 2,
    `delta=${anchorDelta.toFixed(2)} scrollTop=${geometry.container.scrollTop.toFixed(1)}`,
  );
  check(
    label,
    "2 有祖先时 scrollTop>0 且 tail spacer 保证 focal 可达",
    geometry.container.scrollTop > 0 &&
      geometry.container.scrollHeight - geometry.container.clientHeight >= geometry.container.scrollTop - 1,
    `scrollTop=${geometry.container.scrollTop.toFixed(1)} F=${focalOffset.toFixed(1)} scrollHeight=${geometry.container.scrollHeight} clientHeight=${geometry.container.clientHeight} anchor=${geometry.anchor}`,
  );
  const focalVisible = focalRow
    ? Math.min(focalRow.bottom, geometry.container.bottom) - Math.max(focalRow.top, geometry.container.top)
    : 0;
  check(
    label,
    "4 focal 可见高度 ≥ 行高 60%",
    focalRow ? focalVisible >= focalRow.height * 0.6 : false,
    `visible=${focalVisible.toFixed(1)} row=${focalRow?.height.toFixed(1)}`,
  );
  const ancestorRows = geometry.rows.filter((row) => row.kind === "ancestor");
  check(
    label,
    "3 祖先行全部渲染在 DOM（5 条）",
    ancestorRows.length === 5,
    `count=${ancestorRows.length}`,
  );
  check(
    label,
    "3 首屏祖先都在 focal 上方",
    ancestorRows.every((row) => row.bottom <= focalRow.top + 1),
  );
  const stub = focalRow?.rails.find((rail) => rail.stub);
  const stubVisible = stub
    ? Math.min(stub.bottom, geometry.container.bottom) - Math.max(stub.top, geometry.container.top)
    : 0;
  const stubToAvatar = stub && focalRow?.avatar ? focalRow.avatar.top - geometry.container.top : Number.NaN;
  check(
    label,
    "14 stub 高度精确等于 focalAvatarTop−containerTop（≤0.5px），且贴顶时可见=全高",
    Boolean(stub) &&
      Math.abs(stub.height - stubToAvatar) <= 0.5 &&
      Math.abs(stubVisible - stub.height) <= 0.5,
    stub
      ? `height=${stub.height.toFixed(1)} avatarΔ=${stubToAvatar.toFixed(1)} visible=${stubVisible.toFixed(1)}`
      : "missing",
  );
  // 视觉 1：分隔行文字对齐正文列，且不压导轨
  check(
    label,
    "V1 分隔行文字对齐正文列（68±1）且距导轨 ≥6px",
    Boolean(geometry.footer) &&
      Math.abs(geometry.footer.leftRel - 68) <= 1 &&
      geometry.footer.leftRel - geometry.footer.railRightRel >= 6,
    geometry.footer
      ? `textLeft=${geometry.footer.leftRel.toFixed(1)} railRight=${geometry.footer.railRightRel.toFixed(1)} text=${geometry.footer.text}`
      : "missing footer",
  );
  // 视觉 2：作者行只出现一次用户名、角色胶囊是真角色、时间 13px 同行
  const focalAuthor = focalRow?.authorText ?? "";
  const usernameHits = (focalAuthor.match(/owner/g) ?? []).length;
  check(
    label,
    "V2 作者行用户名只出现一次 + 真角色胶囊 + 时间同行",
    usernameHits === 1 &&
      !/@owner/.test(focalAuthor) &&
      /人类|总调度/.test(focalAuthor) &&
      Boolean(geometry.focalMetrics) &&
      Math.abs(geometry.focalMetrics.timeFont - 13) <= 0.6,
    `author="${focalAuthor}" time=${geometry.focalMetrics?.timeFont}`,
  );
  // 视觉 4：字号 / 头像 / 操作图标
  const fm = geometry.focalMetrics;
  check(
    label,
    "V4 正文 17px/25、name 16px、时间 13px、头像 46、操作图标 16px",
    Boolean(fm) &&
      Math.abs(fm.bodyFont - 17) <= 0.6 &&
      Math.abs(fm.bodyLine - 25) <= 0.8 &&
      Math.abs(fm.nameFont - 16) <= 0.6 &&
      Math.abs(fm.timeFont - 13) <= 0.6 &&
      Math.abs(fm.avatar - 46) <= 1 &&
      Math.abs(fm.icon - 16) <= 1,
    fm
      ? `body=${fm.bodyFont}/${fm.bodyLine} name=${fm.nameFont} time=${fm.timeFont} avatar=${fm.avatar} icon=${fm.icon}`
      : "missing",
  );
  // 视觉 5：名→正文 6–8；正文→操作行 16–18（元素间距口径）
  check(
    label,
    "V5 正文→操作行墨迹间距 16–18px（贴正文，不再是页脚）",
    typeof fm?.inkGap === "number" && fm.inkGap >= 16 && fm.inkGap <= 18,
    typeof fm?.inkGap === "number" ? `inkGap=${fm.inkGap.toFixed(1)}` : "missing",
  );
  // 视觉 7：操作行铺满文字列但桌面限宽（440–480），不拉到过散
  check(
    label,
    "V7 操作行宽度 = min(文字列, 464)（桌面限宽 440–480）",
    Boolean(fm?.actionsLeft) &&
      Math.abs(fm.actionsLeft.actionsWidth - Math.min(fm.actionsLeft.bodyWidth, 464)) <= 2 &&
      (fm.actionsLeft.bodyWidth <= 464 || (fm.actionsLeft.actionsWidth >= 440 && fm.actionsLeft.actionsWidth <= 480)),
    fm?.actionsLeft
      ? `actionsWidth=${fm.actionsLeft.actionsWidth.toFixed(1)} bodyWidth=${fm.actionsLeft.bodyWidth.toFixed(1)}`
      : "missing",
  );

  // 视觉 8：导轨色 / 视觉 9：吸顶栏玻璃
  check(
    label,
    "V8 导轨色 #C3C9D2（divider 不动）",
    geometry.railColor === "rgb(195, 201, 210)",
    `rail=${geometry.railColor}`,
  );
  check(
    label,
    "V9 吸顶栏半透明 + backdrop-blur + 下边线 #D7DBE0",
    Boolean(geometry.header) &&
      /\/\s*0?\.\d+\)$/.test(geometry.header.background) &&
      /blur\(\d+px\)/.test(geometry.header.backdrop ?? "") &&
      geometry.header.borderBottom === "rgb(215, 219, 224)",
    geometry.header
      ? `bg=${geometry.header.background} backdrop=${geometry.header.backdrop} border=${geometry.header.borderBottom}`
      : "missing header",
  );
  // 视觉 10：focal 行内上内边距（首字到吸顶栏 28–30）
  check(
    label,
    "V10（视觉代理，非墨迹精确值）focal 首字≈吸顶栏 28–31px、stub 22",
    typeof geometry.focalInkTop === "number" &&
      geometry.focalInkTop + 7 >= 28 &&
      geometry.focalInkTop + 7 <= 31,
    `authorTop=${typeof geometry.focalInkTop === "number" ? geometry.focalInkTop.toFixed(1) : "?"} ink≈${typeof geometry.focalInkTop === "number" ? (geometry.focalInkTop + 7).toFixed(1) : "?"} stub=${stubVisible.toFixed(1)}`,
  );

  check(
    label,
    "V7b 首个操作图标墨迹对齐正文列（68±1）",
    typeof fm?.firstIconLeftRel === "number" && Math.abs(fm.firstIconLeftRel - 68) <= 1,
    typeof fm?.firstIconLeftRel === "number" ? `iconLeft=${fm.firstIconLeftRel.toFixed(1)}` : "missing",
  );
  shots.entry = await shot(page, 1, "entry-focal-stub");

  // 无缩进 / 头像同列
  const posts = geometry.rows.filter((row) => ["ancestor", "focal", "reply"].includes(row.kind));
  const replyRows = geometry.rows.filter((row) => row.kind === "reply");
  check(
    label,
    "6 reply 行 marginLeft 全为 0px",
    replyRows.length > 0 && replyRows.every((row) => row.marginLeft === "0px"),
    `rows=${replyRows.length} values=${[...new Set(replyRows.map((row) => row.marginLeft))].join(",")}`,
  );
  check(
    label,
    "6 所有 post 行 padding-left=16px",
    posts.every((row) => row.paddingLeft === "16px"),
    `values=${[...new Set(posts.map((row) => row.paddingLeft))].join(",")}`,
  );
  const centers = posts.map((row) => row.avatar?.centerRel).filter((value) => typeof value === "number");
  const maxCenterDelta = centers.length
    ? Math.max(...centers.map((center) => Math.abs(center - 39)))
    : Number.NaN;
  const centerSpread = centers.length ? Math.max(...centers) - Math.min(...centers) : Number.NaN;
  check(
    label,
    "7 头像中心（行内）x=39±1 且两两差 ≤1",
    centers.length === posts.length && maxCenterDelta <= 1 && centerSpread <= 1,
    `n=${centers.length} maxΔ=${maxCenterDelta.toFixed(2)} spread=${centerSpread.toFixed(2)}`,
  );

  // 导轨连续性（相邻行）
  const railGaps = [];
  const railLefts = [];
  const railWidths = [];
  for (let index = 0; index < posts.length - 1; index += 1) {
    const current = posts[index];
    const next = posts[index + 1];
    const bottom = [...current.rails].reverse().find((rail) => rail.kind === "bottom" || rail.kind === "full");
    const top = next.rails.find((rail) => rail.kind === "top" || rail.kind === "full");
    if (!bottom || !top) continue;
    railGaps.push(Math.abs(bottom.bottom - top.top));
    railLefts.push(Math.abs(bottom.left - top.left), Math.abs(next.rails[0].left - current.rails[0].left));
    railWidths.push(Math.abs(bottom.width - top.width));
  }
  check(
    label,
    "13 相邻行导轨段 1px 内相接（垂直/水平/宽度）",
    railGaps.length > 0 &&
      railGaps.every((gap) => gap <= 1) &&
      railLefts.every((gap) => gap <= 1) &&
      railWidths.every((gap) => gap <= 1),
    `maxV=${Math.max(...railGaps).toFixed(2)} maxL=${Math.max(...railLefts).toFixed(2)} maxW=${Math.max(...railWidths).toFixed(2)} pairs=${railGaps.length}`,
  );
  check(
    label,
    "12 trunk 只在一根线上（所有导轨 left=38±1）",
    posts
      .flatMap((row) => row.rails)
      .every((rail) => Math.abs(rail.leftRel - 38) <= 1 && Math.abs(rail.width - 2) <= 1),
    `leftRel=${[...new Set(posts.flatMap((row) => row.rails).map((rail) => rail.leftRel.toFixed(1)))].join(",")}`,
  );

  // 删除占位 + 断轨
  const deletedRow = geometry.rows.find((row) => /此帖已删除/.test(row.text));
  check(label, "15 删除祖先保留占位行", Boolean(deletedRow) && deletedRow.height > 0, deletedRow ? `h=${deletedRow.height.toFixed(1)}` : "missing");
  check(
    label,
    "15 删除行 trunck 不断（rail 段齐全）",
    Boolean(deletedRow) && deletedRow.rails.length >= 1,
    deletedRow ? `rails=${deletedRow.rails.length}` : "missing",
  );

  // ── B3a 锚定锁定态按 j：不得把 scrollTop 拉回（F1 有祖先，scrollTop>0 有意义）────
  const lockedBefore = await page.evaluate(READ_GEOMETRY);
  await page.keyboard.press("j");
  await wait(page, 220);
  const lockedAfter = await page.evaluate(READ_GEOMETRY);
  const lockedFocal = lockedAfter.rows.find((row) => row.kind === "focal");
  check(
    label,
    "B3a 锁定态按 j：scrollTop 不跳变、focal 仍在吸顶栏下沿",
    Math.abs(lockedAfter.container.scrollTop - lockedBefore.container.scrollTop) <= 2 &&
      Boolean(lockedFocal) &&
      Math.abs(lockedFocal.top - lockedAfter.container.top) <= 2,
    `${lockedBefore.container.scrollTop.toFixed(0)}→${lockedAfter.container.scrollTop.toFixed(0)} focalΔ=${(lockedFocal ? lockedFocal.top - lockedAfter.container.top : NaN).toFixed(1)}`,
  );

  // ── ③ 向上滚动读到根帖（无点击/展开）─────────────────────────────────────────
  await page.evaluate(() => {
    const container = document.querySelector('[data-testid="thread-scroll"]');
    container.scrollTop = 0;
  });
  await wait(page, 400);
  const scrolledGeometry = await page.evaluate(READ_GEOMETRY);
  const rootRow = scrolledGeometry.rows.find((row) => /TL1 根帖/.test(row.text));
  const rootVisible =
    rootRow &&
    rootRow.bottom > scrolledGeometry.container.top + 1 &&
    rootRow.top < scrolledGeometry.container.bottom;
  check(
    label,
    "3 向上滚动到顶可读到根帖（无点击/展开）",
    Boolean(rootVisible),
    rootRow ? `rootTop=${(rootRow.top - scrolledGeometry.container.top).toFixed(1)}` : "missing",
  );
  check(label, "3 滚动后仍无 ancestors-toggle", scrolledGeometry.ancestorsToggle === 0);
  shots.ancestors = await shot(page, 2, "scrolled-up-ancestors");

  // ── ⑯ 返回恢复 ────────────────────────────────────────────────────────────────
  await gotoHash(page, `#/p/${F.focal}`, 1600);
  await waitForThread(page, { ancestors: 5, replies: 3 });
  await page.evaluate(() => {
    const container = document.querySelector('[data-testid="thread-scroll"]');
    const rows = [...container.querySelectorAll('[data-timeline-row][data-post-id]')];
    const target = rows[1];
    container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top - 40;
  });
  await wait(page, 250);
  const before = firstVisible(await page.evaluate(READ_GEOMETRY));
  // 用「点击卡片」进入另一帖（走 navigate() → pushState 带 idx；裸改 hash 会得到
  // state=null 的条目，popstate 方向退化为 fade，测不到返回恢复）。
  await page
    .locator(`[data-timeline-row="ancestor"][data-post-id="${F.a1}"] article`)
    .first()
    .click({ position: { x: 200, y: 28 } });
  await wait(page, 1700);
  check(
    label,
    "16 前置：点击祖先卡片进入另一帖",
    (await page.evaluate(() => location.hash)) === `#/p/${F.a1}`,
    `hash=${await page.evaluate(() => location.hash)}`,
  );
  await waitForThread(page);
  await page.evaluate(() => history.back());
  await wait(page, 1800);
  await waitForThread(page, { ancestors: 5, replies: 3 });
  const afterGeometry = await page.evaluate(READ_GEOMETRY);
  const after = firstVisible(afterGeometry);
  check(
    label,
    "16 返回恢复首可见行 + 偏移 ±2px",
    before.anchorId !== null &&
      after.anchorId === before.anchorId &&
      Math.abs(after.offsetPx - before.offsetPx) <= 2,
    `${before.anchorId}@${before.offsetPx.toFixed(1)} → ${after.anchorId}@${after.offsetPx.toFixed(1)} anchorMode=${afterGeometry.anchor}`,
  );

  // ── 解锁后的数据更新（report-thread-live-append 新语义）：零点击自动追进 DOM，
  //    离底时视口不动 + 出「新回复」提示；点击提示＝跳转（旧「点击才合并」已废除）──
  const mergeTag = `TL1-MERGE-${label}-${Date.now()}`;
  await createReply(managerToken, F.focal, `${mergeTag} 合并窗口新回复。`);
  await page.waitForFunction(
    (tag) => document.querySelector('[data-testid="thread-scroll"]')?.innerText.includes(tag),
    mergeTag,
    { timeout: 12_000 },
  );
  const appendedGeometry = await page.evaluate(READ_GEOMETRY);
  const appended = firstVisible(appendedGeometry);
  const appendedFocal = appendedGeometry.rows.find((row) => row.kind === "focal");
  check(
    label,
    "C1 解锁后新回复：零点击自动追加、视口不打扰（首可见行/偏移 ±2、未被拉回 focal）",
    after.anchorId !== null &&
      appended.anchorId === after.anchorId &&
      Math.abs(appended.offsetPx - after.offsetPx) <= 2 &&
      appendedGeometry.bodyText.includes(mergeTag) &&
      Boolean(appendedFocal) &&
      appendedFocal.top > appendedGeometry.container.top + 10,
    `${after.anchorId}@${after.offsetPx.toFixed(1)} → ${appended.anchorId}@${appended.offsetPx.toFixed(1)} focalTop=${appendedFocal ? (appendedFocal.top - appendedGeometry.container.top).toFixed(1) : "?"}`,
  );
  const mergePillText = await page
    .locator('[data-testid="new-replies-pill"]')
    .innerText()
    .then((text) => text.replace(/\s+/g, " ").trim())
    .catch(() => "");
  check(
    label,
    "C1 离底新回复：出现「1 条新回复」提示",
    mergePillText.includes("1 条新回复"),
    `pill="${mergePillText}"`,
  );
  const jumpTarget = await page.evaluate((tag) => {
    const container = document.querySelector('[data-testid="thread-scroll"]');
    const row = [...container.querySelectorAll("[data-timeline-row][data-post-id]")].find((item) =>
      item.innerText.includes(tag),
    );
    if (!row) return null;
    const rowRect = row.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      target: rowRect.top - containerRect.top + container.scrollTop,
      max: container.scrollHeight - container.clientHeight,
    };
  }, mergeTag);
  await page.click('[data-testid="new-replies-pill"]');
  await wait(page, 700);
  const afterMergeGeometry = await page.evaluate(READ_GEOMETRY);
  const mergedRow = afterMergeGeometry.rows.find((row) => row.text.includes(mergeTag));
  const expectedJump = jumpTarget ? Math.min(jumpTarget.target, jumpTarget.max) : Number.NaN;
  check(
    label,
    "C2 点击提示：滚动到第一条新回复（不足一屏 clamp 到底）、提示清除",
    jumpTarget !== null &&
      Math.abs(afterMergeGeometry.container.scrollTop - expectedJump) <= 2 &&
      Boolean(mergedRow) &&
      mergedRow.top >= afterMergeGeometry.container.top - 2 &&
      mergedRow.bottom <= afterMergeGeometry.container.top + afterMergeGeometry.container.clientHeight + 2 &&
      (await page.locator('[data-testid="new-replies-pill"]').count()) === 0,
    `scrollTop=${afterMergeGeometry.container.scrollTop.toFixed(1)} expected=${expectedJump.toFixed(1)} row=${mergedRow ? `${mergedRow.top.toFixed(0)}..${mergedRow.bottom.toFixed(0)}` : "missing"}`,
  );

  // ── B2 种子阶段幻影子线程入口：延迟线程接口，确保真的落在 seed 窗口 ──────────
  await page.route("**/api/thread/**", async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 900));
    await route.continue();
  });
  await page.evaluate((hash) => {
    location.hash = hash;
  }, `#/p/${F.seedRoot}`);
  await wait(page, 300);
  const seedWindow = await page.evaluate(() => {
    const phase = document
      .querySelector('[data-testid="thread-swap"]')
      ?.getAttribute("data-phase");
    return {
      phase,
      focal: document.querySelectorAll('[data-timeline-row="focal"]').length,
      replySkeleton: document.querySelectorAll('[data-testid="post-skeleton"]').length,
      subthread: document.querySelectorAll('[data-testid="subthread-entry"]').length,
      replies: document.querySelectorAll('[data-timeline-row="reply"]').length,
    };
  });
  check(
    label,
    "B2 种子窗口前提成立（focal 已出现、phase=content、回复骨架在）",
    seedWindow.focal === 1 &&
      seedWindow.phase === "content" &&
      seedWindow.replySkeleton >= 2 &&
      seedWindow.replies === 0,
    JSON.stringify(seedWindow),
  );
  check(
    label,
    "B2 种子阶段不出现幻影「查看该子线程」入口",
    seedWindow.subthread === 0,
    `subthread=${seedWindow.subthread}`,
  );
  const skeletonGeometry = await page.evaluate(() => {
    const slot = document.querySelector('[data-timeline-row="reply-skeleton"] [data-testid="skeleton-avatar-slot"]');
    const avatar = document.querySelector('[data-timeline-row="reply-skeleton"] [data-testid="skeleton-avatar"]');
    const row = slot?.closest('[data-timeline-row="reply-skeleton"]');
    if (!slot || !avatar || !row) return null;
    const slotBox = slot.getBoundingClientRect();
    const avatarBox = avatar.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    return {
      slotWidth: slotBox.width,
      centerRel: avatarBox.left + avatarBox.width / 2 - rowBox.left,
      avatarWidth: avatarBox.width,
    };
  });
  check(
    label,
    "A1 骨架 compact 槽 46px / 24px 头像中心 39（与内容同度量）",
    Boolean(skeletonGeometry) &&
      Math.abs(skeletonGeometry.slotWidth - 46) <= 1 &&
      Math.abs(skeletonGeometry.avatarWidth - 24) <= 1 &&
      Math.abs(skeletonGeometry.centerRel - 39) <= 1,
    JSON.stringify(skeletonGeometry),
  );
  await wait(page, 2400);
  const seedLate = await page.evaluate(() => ({
    subthread: document.querySelectorAll('[data-testid="subthread-entry"]').length,
    replies: document.querySelectorAll('[data-timeline-row="reply"]').length,
  }));
  await page.unroute("**/api/thread/**");
  check(
    label,
    "B2 线程到位后（15 条回复）也无入口",
    seedLate.subthread === 0 && seedLate.replies === 15,
    JSON.stringify(seedLate),
  );

  // ── B3 j/k 与锚定锁：进入即连按 j（不预先滚动，避免提前解锁）─────────────────
  await gotoHash(page, `#/p/${F.kbRoot}`, 2000);
  await waitForThread(page, { replies: 12 });
  const lockedGeometry = await page.evaluate(READ_GEOMETRY);
  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.press("j");
    await wait(page, 120);
  }
  const keysGeometry = await page.evaluate(READ_GEOMETRY);
  const keysSelected = keysGeometry.rows.find((row) => row.selected);
  const keysVisible =
    keysSelected &&
    keysSelected.bottom > keysGeometry.container.top + 1 &&
    keysSelected.top < keysGeometry.container.bottom - 1;
  check(
    label,
    "B3 连按 10 次 j：scrollTop 增加且选中行滚进视口",
    Boolean(keysSelected) &&
      Boolean(keysVisible) &&
      keysGeometry.container.scrollTop > lockedGeometry.container.scrollTop + 50,
    `scrollTop ${lockedGeometry.container.scrollTop.toFixed(0)}→${keysGeometry.container.scrollTop.toFixed(0)} selected=${keysSelected?.postId ?? "none"} visible=${Boolean(keysVisible)}`,
  );

  // ── ⑩⑪ F2：平铺先序 + 回复给 @x ──────────────────────────────────────────────
  // report-thread-nesting 起，渲染序是父子相邻的先序（pre-order DFS）：同级按
  // (created_at, seq, id) 升序，但子节点紧跟父节点、子树结束后才继续同级。
  await gotoHash(page, `#/p/${F.branchRoot}`, 1600);
  await waitForThread(page, { replies: 4 });
  const branchGeometry = await page.evaluate(READ_GEOMETRY);
  const branchThread = await threadOf(F.branchRoot);
  const comparePosts = (a, b) =>
    a.created_at - b.created_at || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const childrenOf = new Map();
  for (const post of branchThread.posts) {
    if (!post.parent_id) continue;
    const list = childrenOf.get(post.parent_id) ?? [];
    list.push(post);
    childrenOf.set(post.parent_id, list);
  }
  for (const list of childrenOf.values()) list.sort(comparePosts);
  const expectedOrder = [];
  {
    const seen = new Set([branchThread.focal_id]);
    const stack = [];
    const pushChildren = (parentId) => {
      const kids = childrenOf.get(parentId) ?? [];
      for (let index = kids.length - 1; index >= 0; index -= 1) stack.push(kids[index]);
    };
    pushChildren(branchThread.focal_id);
    while (stack.length > 0) {
      const post = stack.pop();
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      expectedOrder.push(post.id);
      pushChildren(post.id);
    }
  }
  const domOrder = branchGeometry.rows.filter((row) => row.kind === "reply").map((row) => row.postId);
  check(
    label,
    "10 平铺回复 DOM 顺序 = 先序（同级 created_at → seq → id 升序）",
    JSON.stringify(domOrder) === JSON.stringify(expectedOrder),
    `dom=${domOrder.join(",")} expected=${expectedOrder.join(",")}`,
  );
  const rowOf = (postId) => branchGeometry.rows.find((row) => row.postId === postId);
  const bRow = rowOf(F.B);
  const cRow = rowOf(F.C);
  const dRow = rowOf(F.D);
  check(
    label,
    "11 首条回复与紧邻父帖的回复不显示「回复给」",
    Boolean(bRow) && !/回复给/.test(bRow.text) && Boolean(dRow) && !/回复给/.test(dRow.text),
    `b=${bRow?.text.slice(0, 40)} d=${dRow?.text.slice(0, 40)}`,
  );
  check(
    label,
    "11 父帖不是上一行的回复显示「回复给 @x」",
    Boolean(cRow) && /回复给\s*@\w+/.test(cRow.text),
    cRow?.text.slice(0, 80),
  );
  shots.flat = await shot(page, 3, "flat-replies-same-column");

  // ── F3：深层多人对话（4 层，无 3 级封顶/无层级控件）──────────────────────────
  await gotoHash(page, `#/p/${F.deepRoot}`, 1600);
  await waitForThread(page, { replies: 4 });
  const deepMixed = await page.evaluate(READ_GEOMETRY);
  const deepReplyRows = deepMixed.rows.filter((row) => row.kind === "reply");
  const deepIds = [F.d1, F.d2, F.d3, F.d4];
  check(
    label,
    "F3 4 层多人对话全部平铺（4 条回复同列、无封顶）",
    deepReplyRows.length === 4 &&
      deepIds.every((id) => deepReplyRows.some((row) => row.postId === id)) &&
      deepReplyRows.every((row) => Math.abs((row.avatar?.centerRel ?? 0) - 39) <= 1),
    `rows=${deepReplyRows.length} order=${deepReplyRows.map((row) => row.postId?.slice(-4)).join(",")}`,
  );
  check(
    label,
    "F3 无「继续 N 层回复」/无 collapse-depth / expand-branch",
    !/继续 \d+ 层回复/.test(deepMixed.bodyText) &&
      deepMixed.collapseDepth === 0 &&
      deepMixed.expandBranch === 0,
  );

  // ── ⑫ F4：自接链紧凑行 + 连续导轨 ───────────────────────────────────────────
  await gotoHash(page, `#/p/${F.selfRoot}`, 1600);
  await waitForThread(page, { replies: 3 });
  const selfGeometry = await page.evaluate(READ_GEOMETRY);
  const selfPosts = selfGeometry.rows.filter((row) => ["focal", "reply"].includes(row.kind));
  const selfCenters = selfPosts.map((row) => row.avatar?.centerRel).filter((value) => typeof value === "number");
  const compactRows = selfGeometry.rows.filter((row) => row.compact);
  const selfGaps = [];
  for (let index = 0; index < selfPosts.length - 1; index += 1) {
    const bottom = [...selfPosts[index].rails].reverse().find((rail) => rail.kind === "bottom" || rail.kind === "full");
    const top = selfPosts[index + 1].rails.find((rail) => rail.kind === "top" || rail.kind === "full");
    if (bottom && top) selfGaps.push(Math.abs(bottom.bottom - top.top));
  }
  const compactWidths = selfGeometry.rows
    .filter((row) => row.compact)
    .map((row) => row.avatar?.width ?? 0);
  check(
    label,
    "12 紧凑行头像 24px、与普通行同轴（中心 39±1，gutter 17）",
    compactRows.length === 2 &&
      compactWidths.length === 2 &&
      compactWidths.every((width) => Math.abs(width - 24) <= 1) &&
      selfGeometry.rows
        .filter((row) => row.compact)
        .every(
          (row) =>
            Math.abs((row.avatar?.centerRel ?? 0) - 39) <= 1 &&
            Math.abs(68 - ((row.avatar?.right ?? 0) - row.left)) >= 16 &&
            Math.abs(68 - ((row.avatar?.right ?? 0) - row.left)) <= 18,
        ),
    `rows=${compactRows.length} widths=${compactWidths.join(",")} heights=${compactRows.map((row) => row.height.toFixed(0)).join(",")} centers=${selfCenters.map((center) => center.toFixed(1)).join(",")}`,
  );
  check(
    label,
    "12 普通行头像中心 39±1（同一条 46px 头像列）",
    selfPosts.filter((row) => !row.compact).every((row) => Math.abs((row.avatar?.centerRel ?? 0) - 39) <= 1),
    `centers=${selfPosts.filter((row) => !row.compact).map((row) => (row.avatar?.centerRel ?? 0).toFixed(1)).join(",")}`,
  );
  check(
    label,
    "12 自接链导轨相邻段 ≤1px 相接",
    selfGaps.length > 0 && selfGaps.every((gap) => gap <= 1),
    `gaps=${selfGaps.map((gap) => gap.toFixed(2)).join(",")}`,
  );
  check(
    label,
    "12 自接链紧凑行：无独立 chip 行、编号改正文行内后缀",
    compactRows.length === 2 &&
      selfPosts.every((row) => row.paddingLeft === "16px") &&
      selfGeometry.rows
        .filter((row) => row.compact)
        .every((row) => /·\s*\d+\/\d+/.test(row.text)),
    `rows=${compactRows.length} text=${selfGeometry.rows.filter((row) => row.compact).map((row) => row.text.slice(-14)).join(" | ")}`,
  );

  // 06 取证图必须同时含「紧凑行」与「46px 普通回复」：滚到紧凑链起点再拍。
  const transitionRows = selfGeometry.rows.filter((row) => row.kind === "reply");
  check(
    label,
    "V6 紧凑→普通过渡样本同时含紧凑行与普通回复",
    transitionRows.some((row) => row.compact) && transitionRows.some((row) => !row.compact),
    `replies=${transitionRows.map((row) => (row.compact ? "compact" : "normal")).join(",")}`,
  );
  await page.evaluate(() => {
    const container = document.querySelector('[data-testid="thread-scroll"]');
    const focal = document.querySelector('[data-timeline-row="focal"]');
    container.scrollTop += focal.getBoundingClientRect().bottom - container.getBoundingClientRect().top;
  });
  await wait(page, 350);
  shots.compact = await shot(page, 6, "compact-to-normal");

  // ── ⑨ F5 c3：子线程入口 + 无内联展开 ────────────────────────────────────────
  await gotoHash(page, `#/p/${F.nineC3}`, 1600);
  await waitForThread(page, { ancestors: 3, replies: 3 });
  const nineThread = await threadOf(F.nineC3);
  const nineExpectedReplies = nineThread.posts.filter(
    (post) =>
      post.id !== nineThread.focal_id &&
      !(post.id === F.nineRoot || post.id === F.nine[0] || post.id === F.nine[1]),
  ).length;
  const entries = page.locator('[data-testid="subthread-entry"]');
  const entryCount = await entries.count();
  const entryText = entryCount ? await entries.first().innerText() : "";
  const nineReplyCount = await page.locator('[data-timeline-row="reply"]').count();
  check(
    label,
    "9 折叠子树渲染为「查看该子线程 · N 条回复」",
    entryCount >= 1 && /查看该子线程\s*·\s*\d+\s*条回复/.test(entryText.replace(/\s+/g, " ")),
    `count=${entryCount} text=${entryText.replace(/\s+/g, " ")}`,
  );
  check(
    label,
    "9 当前页不内联展开隐藏行（reply 行数 = 接口返回数）",
    nineReplyCount === nineExpectedReplies,
    `dom=${nineReplyCount} expected=${nineExpectedReplies}`,
  );
  // 视觉 3：入口行末端不得留悬空导轨（列扫描 x=rowLeft+39 命中 0）
  // 末行控制行不得再画导轨（DOM 计数；elementFromPoint 会跳过 pointer-events:none 的导轨）
  const danglingRails = await page.evaluate(() => {
    const row = document.querySelector('[data-timeline-row="subthread"]');
    if (!row) return -1;
    return row.querySelectorAll('[data-testid="thread-rail"], [data-testid="thread-rail-stub"]').length;
  });
  check(
    label,
    "V3 子线程入口行无悬空导轨（末行控制行 DOM 导轨数 0）",
    danglingRails === 0,
    `rails=${danglingRails}`,
  );

  shots.subthread = await shot(page, 4, "subthread-entry");
  const entryNodeId = await entries.first().getAttribute("data-node-id");
  await entries.first().click();
  await wait(page, 1500);
  check(
    label,
    "9 子线程入口导航到 /p/<nodeId>",
    (await page.evaluate(() => location.hash)) === `#/p/${entryNodeId}`,
    `hash=${await page.evaluate(() => location.hash)} expected=#/p/${entryNodeId}`,
  );

  // ── B1 深链拓扑（review 2026-11-08）：focal 缺失 + 混合作者 → 不得把祖先当回复 ──
  await gotoHash(page, `#/p/${F.mixFocal}`, 2200);
  await page.waitForFunction(
    () => {
      const focal = document.querySelector('[data-timeline-row="focal"]');
      const phase = document.querySelector('[data-testid="thread-swap"]')?.getAttribute("data-phase");
      return Boolean(focal) && phase === "content";
    },
    null,
    { timeout: 8000 },
  );
  await wait(page, 300);
  const mixThread = await threadOf(F.mixFocal);
  const mixGeometry = await page.evaluate(READ_GEOMETRY);
  const mixRows = mixGeometry.rows.filter((row) => ["context-gap", "focal", "reply"].includes(row.kind));
  const mixReplies = mixGeometry.rows.filter((row) => row.kind === "reply");
  const mixFocal = mixGeometry.rows.find((row) => row.kind === "focal");
  check(
    label,
    "B1 深链 focal 缺失：不可解析祖先不平铺成回复",
    mixReplies.length === 0 && Boolean(mixFocal),
    `replies=${mixReplies.length} rows=${mixRows.map((row) => row.kind).join("→")}`,
  );
  check(
    label,
    "B1 缺口行在 focal 上方、focal 之后无伪造回复",
    mixRows.length >= 2 &&
      mixRows[0].kind === "context-gap" &&
      mixRows[1].kind === "focal" &&
      mixRows.length === 2,
    `rows=${mixRows.map((row) => row.kind).join("→")}`,
  );
  const gapTarget = await page
    .locator('[data-testid="context-gap-open"]')
    .first()
    .getAttribute("data-node-id");
  check(
    label,
    "B1 前提成立（接口确实返回了不可定位节点）+ 缺口指向 depth7 父帖",
    mixThread.posts.length > 0 && gapTarget === F.mix[6],
    `posts=${mixThread.posts.length} gapTarget=${gapTarget} expected=${F.mix[6]}`,
  );

  // ── ⑰ F5 c8：深链 focal 缺失回退 ───────────────────────────────────────────
  await gotoHash(page, `#/p/${F.nineC8}`, 2000);
  await page.waitForFunction(
    () => {
      const focal = document.querySelector('[data-timeline-row="focal"]');
      const phase = document.querySelector('[data-testid="thread-swap"]')?.getAttribute("data-phase");
      return Boolean(focal) && phase === "content";
    },
    null,
    { timeout: 8000 },
  );
  await wait(page, 300);
  const deepGeometry = await page.evaluate(READ_GEOMETRY);
  const deepFocal = deepGeometry.rows.find((row) => row.kind === "focal");
  check(
    label,
    "17 9 层深链 focal 仍渲染（不永久骨架）",
    Boolean(deepFocal) && /TL5-N8/.test(deepFocal.text),
    deepFocal ? deepFocal.text.slice(0, 60) : "missing",
  );
  check(
    label,
    "17 深链不把 root..depth6 伪装成相邻祖先",
    deepGeometry.rows.filter((row) => row.kind === "ancestor").length === 0,
    `ancestors=${deepGeometry.rows.filter((row) => row.kind === "ancestor").length}`,
  );
  const deepDelta = deepFocal ? deepFocal.top - deepGeometry.container.top : Number.NaN;
  check(
    label,
    "17 深链同样 focal 贴顶（缺口行在上方）",
    Boolean(deepFocal) && Math.abs(deepDelta) <= 2,
    `delta=${deepDelta.toFixed(2)} scrollTop=${deepGeometry.container.scrollTop.toFixed(1)} anchor=${deepGeometry.anchor}`,
  );
  const gapBelowTop = await page.evaluate(() => {
    const gap = document.querySelector('[data-timeline-row="context-gap"]');
    const container = document.querySelector('[data-testid="thread-scroll"]');
    if (!gap || !container) return null;
    return gap.getBoundingClientRect().bottom - container.getBoundingClientRect().top;
  });
  check(
    label,
    "17 深链进入态：缺口行在视口外（focal 贴顶）",
    typeof gapBelowTop === "number" && gapBelowTop <= 1,
    `gapBottomΔ=${typeof gapBelowTop === "number" ? gapBelowTop.toFixed(1) : "?"}`,
  );
  shots.deep = await shot(page, 5, "deep-link-entry-focal-pinned");
  await page.evaluate(() => {
    const container = document.querySelector('[data-testid="thread-scroll"]');
    container.scrollTop = 0;
  });
  await wait(page, 350);
  shots.gap = await shot(page, 7, "context-gap-in-viewport");
  const gapTextLeft = await page.evaluate(() => {
    const row = document.querySelector('[data-timeline-row="context-gap"]');
    const text = row?.querySelector("p");
    if (!row || !text) return null;
    return text.getBoundingClientRect().left - row.getBoundingClientRect().left;
  });
  check(
    label,
    "A2 缺口行文案左缘 = 正文列 68（与 subthread/footer 统一）",
    typeof gapTextLeft === "number" && Math.abs(gapTextLeft - 68) <= 1,
    `textLeft=${typeof gapTextLeft === "number" ? gapTextLeft.toFixed(1) : "?"}`,
  );
  const gapVisible = (await page.locator('[data-testid="context-gap"]').count()) >= 1;
  const gapText = gapVisible
    ? (await page.locator('[data-testid="context-gap"]').first().innerText()).replace(/\s+/g, " ")
    : "";
  check(
    label,
    "17 context-gap 行存在且文案为「更早的回复未加载」",
    gapVisible && /更早的回复未加载/.test(gapText),
    gapText,
  );
  if (gapVisible) {
    await page.click('[data-testid="context-gap-open"]');
    await wait(page, 1500);
    check(
      label,
      "17 context-gap 导航到父帖详情",
      (await page.evaluate(() => location.hash)) === `#/p/${F.nine[6]}`,
      `hash=${await page.evaluate(() => location.hash)}`,
    );
  } else {
    check(label, "17 context-gap 导航到父帖详情", false, "no gap row");
  }

  // ── B1b depth7（focal 缺失但父在 posts）：不得出现假「更早的回复未加载」──────────
  await gotoHash(page, `#/p/${F.nine[6]}`, 2200);
  await page.waitForFunction(
    () => document.querySelector('[data-timeline-row="focal"]') !== null,
    null,
    { timeout: 8000 },
  );
  await wait(page, 300);
  const depth7 = await page.evaluate(READ_GEOMETRY);
  check(
    label,
    "B1b depth7 深链：父帖可解析 → 走正常祖先链、无假缺口文案",
    depth7.rows.filter((row) => row.kind === "ancestor").length === 7 &&
      depth7.rows.filter((row) => row.kind === "context-gap").length === 0 &&
      !/更早的回复/.test(depth7.bodyText),
    `ancestors=${depth7.rows.filter((row) => row.kind === "ancestor").length} gap=${depth7.rows.filter((row) => row.kind === "context-gap").length}`,
  );

  // ── ⑱ 共享元素仍形变（从时间线点进帖子）────────────────────────────────────
  await gotoHash(page, "#/", 1200);
  const feedCard = page.locator('[data-testid="feed-swap"] [data-post-id]').first();
  if (await feedCard.count()) {
    await feedCard.click();
    const morph = await waitForMorph(page);
    check(
      label,
      "18 共享元素形变（vt-avatar/vt-author 含 width/height/transform）",
      morph.length > 0 &&
        morph.some((entry) => ["width", "height", "transform"].some((prop) => entry.props.includes(prop))),
      JSON.stringify(morph).slice(0, 200),
    );
  } else {
    check(label, "18 共享元素形变", false, "no feed card");
  }

  // ── ⑳ console error / 横向溢出 ─────────────────────────────────────────────
  const finalGeometry = await page.evaluate(READ_GEOMETRY);
  check(label, "20 390/桌面无横向溢出", finalGeometry.bodyOverflow.scrollWidth <= finalGeometry.bodyOverflow.clientWidth,
    `scrollWidth=${finalGeometry.bodyOverflow.scrollWidth} clientWidth=${finalGeometry.bodyOverflow.clientWidth}`);
  check(label, "20 主上下文无 console error / pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));

  // ── 视觉证据：祖先紧贴 focal 的接缝（视口内可见）────────────────────────────
  await gotoHash(page, `#/p/${F.focal}`, 1600);
  await waitForThread(page, { ancestors: 5, replies: 3 });
  await page.evaluate(() => {
    const container = document.querySelector('[data-testid="thread-scroll"]');
    const row = document.querySelector('[data-timeline-row="focal"]');
    container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - 220;
  });
  await wait(page, 400);
  shots.seam = await shot(page, 8, "seam-ancestor-focal");

  // ── ⑤ 数据晚到不抖（独立 context：无实体缓存，延迟线程接口 400ms）───────────
  await context.close();
  const delayed = await openPage(browser, viewport, mobile);
  await delayed.page.route("**/api/thread/**", async (route) => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    await route.continue();
  });
  const samples = await delayed.page.evaluate(async (hash) => {
    const out = [];
    let frames = 0;
    await new Promise((resolveSample) => {
      const tick = () => {
        const container = document.querySelector('[data-testid="thread-scroll"]');
        const row = document.querySelector('[data-timeline-row="focal"]');
        if (container && row) {
          out.push(row.getBoundingClientRect().top - container.getBoundingClientRect().top);
        }
        frames += 1;
        if (out.length >= 60) return resolveSample();
        if (frames > 900) return resolveSample();
        requestAnimationFrame(tick);
      };
      location.hash = hash;
      requestAnimationFrame(tick);
    });
    return out;
  }, `#/p/${F.focal}`);
  const range = samples.length ? Math.max(...samples) - Math.min(...samples) : Number.NaN;
  const jump = samples.length > 1
    ? Math.max(...samples.slice(1).map((value, index) => Math.abs(value - samples[index])))
    : 0;
  check(
    label,
    "5 延迟线程 400ms：focal 顶边 rAF 60 帧极差 ≤2px、无 >4px 跳变",
    samples.length >= 60 && range <= 2 && jump <= 4,
    `frames=${samples.length} min=${Math.min(...samples).toFixed(2)} max=${Math.max(...samples).toFixed(2)} range=${range.toFixed(2)} maxJump=${jump.toFixed(2)} samples=${JSON.stringify(samples.slice(0, 8).map((value) => Number(value.toFixed(2))))}`,
  );
  check(
    label,
    "5 延迟线程最终仍贴顶",
    samples.length > 0 && Math.abs(samples[samples.length - 1]) <= 2,
    `last=${samples.at(-1)?.toFixed(2)}`,
  );
  errors.push(...delayed.errors.map((message) => `delayed:${message}`));
  await delayed.context.close();

  // ── ⑲ reduced-motion：首帧到位 ─────────────────────────────────────────────
  const reduced = await openPage(browser, viewport, mobile, "reduce");
  errors.push(...reduced.errors.map((message) => `reduced:${message}`));
  const reducedSamples = await reduced.page.evaluate(async (hash) => {
    const out = [];
    let frames = 0;
    await new Promise((resolveSample) => {
      const tick = () => {
        const container = document.querySelector('[data-testid="thread-scroll"]');
        const row = document.querySelector('[data-timeline-row="focal"]');
        if (container && row) {
          out.push(row.getBoundingClientRect().top - container.getBoundingClientRect().top);
        }
        frames += 1;
        if (out.length >= 30) return resolveSample();
        if (frames > 600) return resolveSample();
        requestAnimationFrame(tick);
      };
      location.hash = hash;
      requestAnimationFrame(tick);
    });
    return out;
  }, `#/p/${F.focal}`);
  const reducedMax = reducedSamples.length
    ? Math.max(...reducedSamples.map((value) => Math.abs(value)))
    : Number.NaN;
  check(
    label,
    "19 reduced-motion：focal 首帧即到位（|Δ| ≤2px，无平滑中间帧）",
    reducedSamples.length > 0 && reducedMax <= 2,
    `frames=${reducedSamples.length} max|Δ|=${reducedMax.toFixed(2)} samples=${JSON.stringify(reducedSamples.slice(0, 6).map((value) => Number(value.toFixed(2))))}`,
  );
  const reducedErrors = [...reduced.errors];
  await reduced.context.close();
  check(
    label,
    "19 reduced-motion 上下文无 console error / pageerror",
    reducedErrors.length === 0,
    reducedErrors.slice(0, 3).join(" | "),
  );
  check(
    label,
    "20 全上下文（主 + delayed + reduced）console error = 0",
    errors.length === 0,
    errors.slice(0, 4).join(" | "),
  );

  return { shots, samples, reducedSamples };
}

// ── main ─────────────────────────────────────────────────────────────────────
let browser = null;
const onlyViewport = argValue(process.argv.slice(2), "viewport", null);
const evidence = { base: BASE, dataDir: qa.dataDir, servePid: qa.info?.pid ?? null, fixtures: F, viewports: {}, onlyViewport };
try {
  mkdirSync(SHOT_DIR, { recursive: true });
  browser = await chromium.launch({ channel: "chrome" });
  for (const spec of [
    { label: "mobile", viewport: { width: 390, height: 844 }, mobile: true },
    { label: "desktop", viewport: { width: 1280, height: 900 }, mobile: false },
  ].filter((spec) => !onlyViewport || spec.label === onlyViewport)) {
    const out = await runViewport(browser, spec);
    evidence.viewports[spec.label] = out;
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
process.exitCode = failed.length ? 1 : 0;

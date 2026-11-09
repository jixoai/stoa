#!/usr/bin/env node
/**
 * report-to-article —— steps.json → 长文 Markdown（report-longform D14/§6.3 的落地件）。
 *
 * 用法（确定性的纯转换；同一输入必得同一输出）：
 *   node scripts/report-to-article.mjs <evidence-dir> [--out report.md] [--upload] [--media-map media.json]
 *
 * 输入 `<evidence-dir>/steps.json` 沿用 e2e-report-gen 契约：
 *   { title, brand?, subtitle?, meta?, thesis?, env?, summary?, coverage?, logs?,
 *     sections: [{ title, note?, compares?, steps: [{ id?, intent, expect?, command?,
 *       reply?, assertion, ok, image?, imageMeta?, imageBefore?, status? }] }] }
 *
 * P1 映射（直接产出四块，不手写 HTML）：
 *   title → `# <title>`；meta → 引用；thesis → fde2e:callout；
 *   summary/coverage → fde2e:stats；env → Markdown 表格；
 *   每节 fde2e:steps（expect/detail/command/output/media）；imageBefore+image 与
 *   sections[].compares[] → fde2e:compare；logs → Markdown 代码块（P2 升级 log 块）；
 *   结尾再一个 fde2e:stats 汇总。
 *
 * 媒体：`--upload` 走插件同一份 config.mjs（baseUrl/token）逐张 POST /api/media；
 * `--media-map` 用离线映射 `{ "img/s1.webp": "<hash 或 /api/media/...>" }`；
 * 两者都未给时警告并输出普通链接（article 不渲染相对图片，避免静态归档死链）。
 *
 * 退出码：0 成功；1 读取/解析/自检失败；2 用法错误。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { loadConfig, loadToken } from "./lib/config.mjs";

const MAX_ARTICLE_CHARS = 512_000;
const MAX_ARTICLE_BYTES = 2 * 1024 * 1024;
const MAX_STEPS = 20;
const MAX_TITLE = 120;
const MAX_EXPECT = 1000;
const MAX_DETAIL = 2000;
const MAX_COMMAND = 4 * 1024;
const MAX_OUTPUT = 8 * 1024;

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const hasFlag = (name) => argv.includes(`--${name}`);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    "usage: node scripts/report-to-article.mjs <evidence-dir> [--out report.md] [--upload] [--media-map media.json]",
  );
  process.exit(0);
}
const dir = argv.find((arg) => !arg.startsWith("--"));
if (!dir) {
  console.error("usage: node scripts/report-to-article.mjs <evidence-dir> [--out report.md] [--upload] [--media-map media.json]");
  process.exit(2);
}

function truncate(text, max) {
  const value = String(text ?? "");
  return value.length > max ? value.slice(0, max) : value;
}

/** 动态 fence 长度：内容中最长反引号 run + 1（至少 4），防注入破块。 */
function fenceFor(text) {
  const runs = String(text).match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  return "`".repeat(Math.max(4, longest + 1));
}

/** 指令块（JSON 由 JSON.stringify 生成 → 结构合法；字段按 schema 上限截断）。 */
function block(name, data) {
  const json = JSON.stringify(data, null, 2);
  const ticks = fenceFor(json);
  return `${ticks}fde2e:${name}\n${json}\n${ticks}`;
}

function mdTable(rows, header) {
  const escape = (cell) => String(cell ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");
  const lines = [`| ${header.map(escape).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.map(escape).join(" | ")} |`);
  return lines.join("\n");
}

function codeBlock(text, lang = "text") {
  const ticks = fenceFor(text);
  return `${ticks}${lang}\n${String(text).replace(/\s+$/, "")}\n${ticks}`;
}

// ── 媒体解析 ────────────────────────────────────────────────────────────────

const mediaMap = (() => {
  const path = flagValue("media-map");
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (err) {
    console.error(`读取 media-map 失败：${err.message}`);
    process.exit(1);
  }
})();

const cfg = loadConfig();
let uploadWarningShown = false;
const mediaCache = new Map();

async function resolveMedia(rawPath) {
  if (rawPath.startsWith("/api/media/")) return rawPath;
  if (mediaCache.has(rawPath)) return mediaCache.get(rawPath);
  let url = null;
  const mapped = mediaMap[rawPath];
  if (mapped) {
    url = mapped.startsWith("/api/media/") ? mapped : `/api/media/${mapped}`;
  } else if (hasFlag("upload")) {
    const full = resolve(dir, rawPath);
    if (!existsSync(full)) {
      console.error(`警告：图片不存在 ${rawPath}，输出普通链接`);
    } else {
      const token = loadToken(cfg);
      const ext = extname(full).slice(1).toLowerCase();
      const contentType =
        { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" }[
          ext
        ] ?? "application/octet-stream";
      const res = await fetch(`${cfg.baseUrl}/api/media`, {
        method: "POST",
        headers: {
          "content-type": contentType,
          "x-filename": rawPath.split("/").pop() ?? "image",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: readFileSync(full),
      });
      if (!res.ok) {
        console.error(`警告：上传 ${rawPath} 失败（HTTP ${res.status}），输出普通链接`);
      } else {
        const payload = await res.json();
        url = `/api/media/${payload.hash}`;
      }
    }
  }
  if (!url) {
    if (!uploadWarningShown) {
      uploadWarningShown = true;
      console.error(
        "警告：未提供 --upload/--media-map，相对图片改写为普通链接（article 不渲染相对图片）",
      );
    }
    url = null;
  }
  mediaCache.set(rawPath, url);
  return url;
}

// ── steps.json → article markdown ───────────────────────────────────────────

const stepsPath = join(resolve(dir), "steps.json");
if (!existsSync(stepsPath)) {
  console.error(`缺少 ${stepsPath}`);
  process.exit(1);
}
let input;
try {
  input = JSON.parse(readFileSync(stepsPath, "utf8"));
} catch (err) {
  console.error(`解析 steps.json 失败：${err.message}`);
  process.exit(1);
}

const sections = Array.isArray(input.sections) ? input.sections : [];
const allSteps = sections.flatMap((section) => section.steps ?? []);
const passCount = input.summary?.pass ?? allSteps.filter((step) => step.ok === true).length;
const failCount = input.summary?.fail ?? allSteps.filter((step) => step.ok !== true).length;
const title = String(input.title ?? "交付报告");

function stepStatus(step) {
  const known = new Set(["done", "failed", "degraded", "skipped", "pending"]);
  if (typeof step.status === "string" && known.has(step.status)) return step.status;
  if (step.ok === true) return "done";
  if (step.ok === false) return "failed";
  return "pending";
}

function stepExpect(step) {
  const parts = [];
  if (step.expect) parts.push(step.expect);
  return parts.join("；");
}

function stepDetail(step) {
  return [step.assertion, step.imageMeta ? `（截图 ${step.imageMeta}）` : ""].filter(Boolean).join(" ");
}

const lines = [];
lines.push(`# ${title}`);
if (input.meta) lines.push(`> ${input.meta}`);
if (input.brand || input.subtitle) {
  lines.push(`> ${[input.brand, input.subtitle].filter(Boolean).join(" · ")}`);
}

const thesisOk = failCount === 0;
lines.push("");
lines.push(
  block("callout", {
    tone: thesisOk ? "success" : "warn",
    title: thesisOk ? "结论：全部断言通过" : `结论：${failCount} 项失败`,
    body: String(input.thesis ?? `${title} — 断言通过 ${passCount}/${passCount + failCount}`),
  }),
);

// 概览 stats（summary + coverage 汇总）
const overviewItems = [
  { label: "断言通过", value: `${passCount}`, hint: "PASS", tone: "success" },
  { label: "断言失败", value: `${failCount}`, hint: failCount === 0 ? "无失败" : "需修复", tone: failCount === 0 ? "neutral" : "danger" },
  { label: "步骤总数", value: `${allSteps.length}` },
];
if (Array.isArray(input.coverage) && input.coverage.length > 0) {
  const covered = input.coverage.filter((row) => row.covered !== false && row.ok !== false).length;
  overviewItems.push({ label: "覆盖率", value: `${covered}/${input.coverage.length}`, hint: "覆盖表", tone: covered === input.coverage.length ? "success" : "warn" });
}
if (input.env?.length) overviewItems.push({ label: "环境项", value: `${input.env.length}` });
lines.push("");
lines.push(block("stats", { items: overviewItems }));

if (Array.isArray(input.env) && input.env.length > 0) {
  lines.push("");
  lines.push(mdTable(input.env, ["项", "值"]));
}

for (const section of sections) {
  lines.push("");
  lines.push(`## ${section.title ?? "小节"}`);
  if (section.note) lines.push("", String(section.note));

  // 节内步骤（>20 截断由 schema 处理；此处先按 20 切给 worker 端 0 error 的输出）
  const sectionSteps = (section.steps ?? []).slice(0, MAX_STEPS);
  if (sectionSteps.length > 0) {
    const stepsData = [];
    for (const step of sectionSteps) {
      const entry = {
        title: truncate([step.id, step.intent].filter(Boolean).join(" · "), MAX_TITLE),
        status: stepStatus(step),
      };
      const expect = truncate(stepExpect(step), MAX_EXPECT);
      if (expect) entry.expect = expect;
      const detail = truncate(stepDetail(step), MAX_DETAIL);
      if (detail) entry.detail = detail;
      if (step.command) entry.command = truncate(typeof step.command === "string" ? step.command : JSON.stringify(step.command), MAX_COMMAND);
      if (step.reply) entry.output = truncate(typeof step.reply === "string" ? step.reply : JSON.stringify(step.reply), MAX_OUTPUT);
      // 成对前后图 → compare（不放进 steps.media）；单图 → steps[].media
      const pair = step.imageBefore && step.image;
      if (!pair && step.image) {
        const media = await resolveMedia(step.image);
        if (media) {
          entry.media = media;
          entry.mediaAlt = truncate(step.imageMeta ?? step.intent ?? "", 200) || undefined;
          if (!entry.mediaAlt) delete entry.mediaAlt;
        } else {
          entry.expect = truncate(`${entry.expect ?? ""}\n[截图 ${step.image}]`.trim(), MAX_EXPECT);
        }
      }
      stepsData.push(entry);
    }
    lines.push("");
    lines.push(block("steps", { steps: stepsData }));

    // 单步成对图 → compare（确定性顺序：按步骤顺序）
    for (const step of sectionSteps) {
      if (!(step.imageBefore && step.image)) continue;
      const before = await resolveMedia(step.imageBefore);
      const after = await resolveMedia(step.image);
      if (!before || !after) {
        lines.push("", `（前后对比图缺失媒体引用：${step.imageBefore} / ${step.image}）`);
        continue;
      }
      lines.push(
        "",
        block("compare", {
          title: truncate([step.id, step.intent].filter(Boolean).join(" · "), 120),
          before: { media: before, label: "Before" },
          after: { media: after, label: "After" },
        }),
      );
    }
  }

  // 节级 compares
  for (const compare of section.compares ?? []) {
    const beforeSrc = typeof compare.before === "string" ? compare.before : compare.before?.media ?? compare.before?.path;
    const afterSrc = typeof compare.after === "string" ? compare.after : compare.after?.media ?? compare.after?.path;
    const before = beforeSrc ? await resolveMedia(beforeSrc) : null;
    const after = afterSrc ? await resolveMedia(afterSrc) : null;
    if (!before || !after) {
      console.error(`警告：compares 缺少可用媒体（${beforeSrc} / ${afterSrc}），跳过该块`);
      continue;
    }
    const side = (raw, media, fallback) => {
      const obj = typeof raw === "string" ? {} : raw ?? {};
      const out = { media, label: truncate(obj.label ?? fallback, 60) };
      if (obj.caption) out.caption = truncate(obj.caption, 200);
      if (obj.viewport) out.viewport = truncate(obj.viewport, 40);
      return out;
    };
    const payload = {
      before: side(compare.before, before, "Before"),
      after: side(compare.after, after, "After"),
    };
    if (compare.title) payload.title = truncate(compare.title, 120);
    if (compare.note) payload.note = truncate(compare.note, 300);
    lines.push("", block("compare", payload));
  }
}

// 覆盖表（Markdown 表格 + stats 汇总）
if (Array.isArray(input.coverage) && input.coverage.length > 0) {
  lines.push("");
  lines.push("## 覆盖表");
  lines.push(
    "",
    mdTable(
      input.coverage.map((row) => [
        row.item ?? row.name ?? row.id ?? "",
        row.covered === false || row.ok === false ? "未覆盖" : "已覆盖",
        row.note ?? row.evidence ?? "",
      ]),
      ["项", "状态", "证据"],
    ),
  );
}

// 日志（P1 回退 Markdown 代码块；P2 升级 fde2e:log）
if (typeof input.logs === "string" && input.logs.trim()) {
  lines.push("", "## 日志", "", codeBlock(input.logs));
} else if (Array.isArray(input.logs)) {
  for (const log of input.logs) {
    const text = typeof log === "string" ? log : log?.text ?? "";
    if (!text.trim()) continue;
    const label = typeof log === "object" && log?.title ? `### ${log.title}\n\n` : "";
    lines.push("", label + codeBlock(text));
  }
}

// 结尾汇总 stats（pass/fail/总步骤）
lines.push("");
lines.push(
  block("stats", {
    items: [
      { label: "通过", value: `${passCount}`, hint: "PASS", tone: "success" },
      { label: "失败", value: `${failCount}`, tone: failCount === 0 ? "neutral" : "danger" },
      { label: "总步骤", value: `${allSteps.length}` },
    ],
  }),
);

const output = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;

// 自检：字符/字节上限（与 worker 端 assertBody(article) 同口径）
if (output.length > MAX_ARTICLE_CHARS) {
  console.error(`输出超过 article 字符上限（${output.length} > ${MAX_ARTICLE_CHARS}）`);
  process.exit(1);
}
if (Buffer.byteLength(output, "utf8") > MAX_ARTICLE_BYTES) {
  console.error(`输出超过 article 字节上限（${Buffer.byteLength(output, "utf8")} > ${MAX_ARTICLE_BYTES}）`);
  process.exit(1);
}

const outPath = flagValue("out");
if (outPath) {
  writeFileSync(resolve(outPath), output, "utf8");
  console.log(`wrote ${resolve(outPath)} (${output.length} chars)`);
} else {
  process.stdout.write(output);
}

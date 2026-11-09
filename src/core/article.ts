/**
 * 长文解析（report-longform D7/§3）：服务端（长度校验）/客户端/静态归档共用的纯函数。
 *
 * - 唯一的结构化扩展点＝fenced 指令块（` ```fde2e:<name> ` + 单个 JSON 对象）；
 * - 白名单硬封顶：P1 `stats`/`steps`/`compare`/`callout`（P2 追加 gallery/log）；
 * - 未知块/坏 JSON/schema 不匹配一律安全降级（可见占位 + 原文），**永不抛异常**；
 * - 解析不执行内容：`JSON.parse` only，不 eval、不 new Function、不碰 DOM。
 *
 * 本文件不 import 任何运行时/浏览器 API（`TextEncoder` 是跨端标准），因此服务端、
 * 浏览器与静态归档可以共用同一份实现（design §3.3/§2.5）。
 */
import { parseMarkdown, type Block, type InlineToken } from "./markdown.ts";

// ── 常量与类型契约（design §3.1/§3.2）────────────────────────────────────────

/** P1 块名白名单（硬封顶 6 块；P2 追加 `gallery`/`log`）。 */
export const ARTICLE_BLOCK_NAMES = ["stats", "steps", "compare", "callout"] as const;
export type ArticleBlockName = (typeof ARTICLE_BLOCK_NAMES)[number];

/** 指令块总量/单块体积上限（design §3.1）。 */
export const MAX_DIRECTIVE_BLOCKS = 200;
export const MAX_DIRECTIVE_BYTES = 16 * 1024;

/** info string 命名空间：精确匹配才是指令块。 */
export const DIRECTIVE_LANG_RE = /^fde2e:([a-z][a-z0-9-]{0,31})$/;
/** 指令块媒体白名单：只接受本板内容寻址的媒体引用。 */
export const ARTICLE_MEDIA_RE = /^\/api\/media\/[a-f0-9]{64}$/;

export const STATS_MAX_ITEMS = 8;
export const STATS_LABEL_MAX = 40;
export const STATS_VALUE_MAX = 32;
export const STATS_UNIT_MAX = 12;
export const STATS_HINT_MAX = 80;
export const STEPS_MAX_ITEMS = 20;
export const STEP_TITLE_MAX = 120;
export const STEP_EXPECT_MAX = 1000;
export const STEP_DETAIL_MAX = 2000;
export const STEP_COMMAND_MAX = 4 * 1024;
export const STEP_OUTPUT_MAX = 8 * 1024;
export const STEP_MEDIA_ALT_MAX = 200;
export const COMPARE_LABEL_MAX = 60;
export const COMPARE_CAPTION_MAX = 200;
export const COMPARE_TITLE_MAX = 120;
export const COMPARE_NOTE_MAX = 300;
export const COMPARE_VIEWPORT_MAX = 40;
export const CALLOUT_TITLE_MAX = 80;
export const CALLOUT_BODY_MAX = 2000;
export const CALLOUT_ITEMS_MAX = 8;
export const CALLOUT_ITEM_MAX = 300;
export const CALLOUT_CODE_MAX = 4 * 1024;

export type BlockIssueSeverity = "error" | "warning";

export interface BlockIssue {
  severity: BlockIssueSeverity;
  /** 块在文档中的序号（1-based，用于编辑器定位）。 */
  block: number;
  /** 块起始行（1-based）。 */
  line: number;
  message: string;
}

export type StatsTone = "neutral" | "success" | "warn" | "danger";

export interface StatsItem {
  label: string;
  value?: string;
  before?: string;
  after?: string;
  unit?: string;
  hint?: string;
  tone: StatsTone;
  /** `higher`/`lower`；缺省 null（不做方向判断，仍显示变前后文字）。 */
  better: "higher" | "lower" | null;
}

export interface StatsData {
  name: "stats";
  items: StatsItem[];
}

export type StepStatus = "done" | "failed" | "degraded" | "skipped" | "pending";

export interface StepItem {
  title: string;
  status: StepStatus;
  expect?: string;
  detail?: string;
  /** 纯文本（pre 渲染，不解析 MD）。 */
  command?: string;
  /** 纯文本（pre 渲染，不解析 MD）。 */
  output?: string;
  /** 本地媒体引用 `/api/media/<64hex>`。 */
  media?: string;
  mediaAlt?: string;
}

export interface StepsData {
  name: "steps";
  steps: StepItem[];
}

export interface MediaSide {
  /** 有效值为 `/api/media/<64hex>`；无效时为空串（渲染占位 + error）。 */
  media: string;
  label?: string;
  caption?: string;
  viewport?: string;
}

export interface CompareData {
  name: "compare";
  title?: string;
  note?: string;
  viewport?: string;
  before: MediaSide;
  after: MediaSide;
}

export type CalloutTone = "info" | "warn" | "success" | "danger";

export interface CalloutData {
  name: "callout";
  tone: CalloutTone;
  title?: string;
  body?: string;
  items: string[];
  /** 纯文本（pre 渲染，不解析 MD）。 */
  code?: string;
}

export type ArticleBlockData = StatsData | StepsData | CompareData | CalloutData;

export type ArticleNode =
  | { kind: "markdown"; block: Block }
  | {
      kind: "directive";
      name: string;
      /** 块体原文（展示前转义；不作为代码执行）。 */
      raw: string;
      /** 校验通过后的结构化值；未知块/坏 JSON/schema 错为 null。 */
      data: ArticleBlockData | null;
      issues: BlockIssue[];
      line: number;
    };

export interface ArticleHeading {
  level: 2 | 3;
  /** 纯文本（无 Markdown 标记）。 */
  text: string;
  /** slug，已按文档顺序去重。 */
  id: string;
  /** 在**全部** heading block（H1–H6）中的 0-based 序号。 */
  index: number;
}

export interface ArticleStats {
  title: string;
  excerpt: string;
  minutes: number;
  chars: number;
  headings: number;
  directives: number;
}

export interface ArticleDoc {
  nodes: ArticleNode[];
  /** 只收 H2/H3。 */
  headings: ArticleHeading[];
  stats: ArticleStats;
  issues: BlockIssue[];
}

// ── 纯文本 / slug ────────────────────────────────────────────────────────────

/** InlineToken → 纯文本（递归；link 取 children，image 取 alt）。 */
export function inlinePlainText(tokens: readonly InlineToken[]): string {
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "code":
        out += token.text;
        break;
      case "strong":
      case "em":
      case "link":
        out += inlinePlainText(token.children);
        break;
      case "image":
        out += token.alt;
        break;
    }
  }
  return out;
}

/** Block → 纯文本（不解析 Markdown 正则剥标记，避免误伤 CJK/标点）。 */
export function blockPlainText(block: Block): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "quote":
      return inlinePlainText(block.children);
    case "list":
      return block.items.map((item) => inlinePlainText(item)).join("\n");
    case "code":
      return block.text;
    case "table":
      return [...block.header, ...block.rows.flat()]
        .map((cell) => inlinePlainText(cell))
        .join(" ");
    case "hr":
      return "";
  }
}

/**
 * 标题锚点 slug（design §3.5）：NFKC → 小写 → 非 `[a-z0-9\u4e00-\u9fff-]` 替换 `-`
 * → 合并/去首尾 → 截断 64 码点 → 空串 `section`。
 */
export function slugifyHeading(text: string): string {
  const normalized = text.normalize("NFKC").toLowerCase();
  const dashed = normalized
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const truncated = Array.from(dashed).slice(0, 64).join("");
  return truncated || "section";
}

/** 按文档顺序去重：`x`、`x-2`、`x-3`… */
function dedupeSlug(slug: string, used: Map<string, number>): string {
  const count = used.get(slug) ?? 0;
  used.set(slug, count + 1);
  return count === 0 ? slug : `${slug}-${count + 1}`;
}

// ── article 行内安全过滤（design §3.4）──────────────────────────────────────

/** 行内链接（article）：只允许 `https?:` 或 `#` 页内锚点。 */
export function isArticleLinkHref(href: string): boolean {
  return /^https?:/i.test(href) || href.startsWith("#");
}

/** 行内图片（article）：只允许 `https?:` 或本地 `/api/media/<64hex>`。 */
export function isArticleImageSrc(src: string): boolean {
  return /^https?:/i.test(src) || ARTICLE_MEDIA_RE.test(src);
}

/** 指令块媒体引用：只允许本地 `/api/media/<64hex>`。 */
export function isArticleMediaUrl(url: string): boolean {
  return ARTICLE_MEDIA_RE.test(url);
}

/**
 * article 渲染前的行内过滤：不合格的 link/image 还原为纯文本
 * （`[text](href)` / `![alt](src)` 原样可见），不留可点击链接/图片。
 * note 路径不调用本函数（既有行为逐字不变）。
 */
export function filterArticleInline(tokens: readonly InlineToken[]): InlineToken[] {
  return tokens.map((token) => {
    switch (token.type) {
      case "link":
        if (isArticleLinkHref(token.href)) {
          return { type: "link", href: token.href, children: filterArticleInline(token.children) };
        }
        return { type: "text", text: `[${inlinePlainText(token.children)}](${token.href})` };
      case "image":
        if (isArticleImageSrc(token.src)) return token;
        return { type: "text", text: `![${token.alt}](${token.src})` };
      case "strong":
        return { type: "strong", children: filterArticleInline(token.children) };
      case "em":
        return { type: "em", children: filterArticleInline(token.children) };
      default:
        return token;
    }
  });
}

// ── schema 校验（design §3.2）───────────────────────────────────────────────

interface IssueSink {
  error(message: string): void;
  warn(message: string): void;
  readonly failed: boolean;
}

function makeSink(block: number, line: number, issues: BlockIssue[]): IssueSink {
  let failed = false;
  return {
    error(message) {
      failed = true;
      issues.push({ severity: "error", block, line, message });
    },
    warn(message) {
      issues.push({ severity: "warning", block, line, message });
    },
    get failed() {
      return failed;
    },
  };
}

/** 可选字符串字段：类型不符 → error；超长 → 截断 + warning。 */
function readString(
  sink: IssueSink,
  obj: Record<string, unknown>,
  key: string,
  max: number,
  opts: { required?: boolean } = {},
): string | undefined {
  const raw = obj[key];
  if (raw === undefined || raw === null) {
    if (opts.required) sink.error(`field "${key}" is required`);
    return undefined;
  }
  if (typeof raw !== "string") {
    sink.error(`field "${key}" must be a string`);
    return undefined;
  }
  if (raw.length > max) {
    sink.warn(`field "${key}" truncated to ${max} chars`);
    return raw.slice(0, max);
  }
  return raw;
}

/** 枚举字段：未知值 → fallback + warning；类型不符 → error。 */
function readEnum<T extends string>(
  sink: IssueSink,
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = obj[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string") {
    sink.error(`field "${key}" must be a string`);
    return fallback;
  }
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  sink.warn(`unknown ${key} "${raw}"; falling back to "${fallback}"`);
  return fallback;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** `better`：`higher`/`lower`；缺省 null（不判方向，仍显示前后文字）。 */
function readBetter(sink: IssueSink, obj: Record<string, unknown>): "higher" | "lower" | null {
  const raw = obj.better;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    sink.error('field "better" must be a string');
    return null;
  }
  if (raw === "higher" || raw === "lower") return raw;
  sink.warn(`unknown better "${raw}"; ignoring`);
  return null;
}

function validateStats(sink: IssueSink, root: Record<string, unknown>): StatsData | null {
  const rawItems = root.items;
  if (!Array.isArray(rawItems)) {
    sink.error('field "items" must be an array');
    return null;
  }
  if (rawItems.length === 0) {
    sink.error('field "items" must not be empty');
    return null;
  }
  if (rawItems.length > STATS_MAX_ITEMS) {
    sink.warn(`stats items truncated to ${STATS_MAX_ITEMS} (had ${rawItems.length})`);
  }
  const items: StatsItem[] = [];
  for (const entry of rawItems.slice(0, STATS_MAX_ITEMS)) {
    const obj = asObject(entry);
    if (!obj) {
      sink.error("stats items entries must be objects");
      continue;
    }
    const label = readString(sink, obj, "label", STATS_LABEL_MAX, { required: true });
    if (label === undefined) continue;
    const value = readString(sink, obj, "value", STATS_VALUE_MAX);
    const before = readString(sink, obj, "before", STATS_VALUE_MAX);
    const after = readString(sink, obj, "after", STATS_VALUE_MAX);
    if (value === undefined && (before === undefined || after === undefined)) {
      sink.error(`stats item "${label}" needs "value" or both "before" and "after"`);
      continue;
    }
    const item: StatsItem = {
      label,
      tone: readEnum(sink, obj, "tone", ["neutral", "success", "warn", "danger"] as const, "neutral"),
      better: readBetter(sink, obj),
    };
    if (value !== undefined) item.value = value;
    if (before !== undefined) item.before = before;
    if (after !== undefined) item.after = after;
    const unit = readString(sink, obj, "unit", STATS_UNIT_MAX);
    if (unit !== undefined) item.unit = unit;
    const hint = readString(sink, obj, "hint", STATS_HINT_MAX);
    if (hint !== undefined) item.hint = hint;
    items.push(item);
  }
  if (items.length === 0) return null;
  return { name: "stats", items };
}

function readMediaSide(issue: IssueSink, value: unknown, key: string): MediaSide | null {
  const obj = asObject(value);
  if (!obj) {
    issue.error(`field "${key}" must be an object`);
    return null;
  }
  const media = readString(issue, obj, "media", 2000, { required: true });
  if (media === undefined) return null;
  const side: MediaSide = { media: isArticleMediaUrl(media) ? media : "" };
  if (media !== side.media) {
    issue.error(`field "${key}.media" must be a local /api/media/<hash> reference`);
  }
  const label = readString(issue, obj, "label", COMPARE_LABEL_MAX);
  if (label !== undefined) side.label = label;
  const caption = readString(issue, obj, "caption", COMPARE_CAPTION_MAX);
  if (caption !== undefined) side.caption = caption;
  const viewport = readString(issue, obj, "viewport", COMPARE_VIEWPORT_MAX);
  if (viewport !== undefined) side.viewport = viewport;
  return side;
}

function validateSteps(sink: IssueSink, root: Record<string, unknown>): StepsData | null {
  const rawSteps = root.steps;
  if (!Array.isArray(rawSteps)) {
    sink.error('field "steps" must be an array');
    return null;
  }
  if (rawSteps.length === 0) {
    sink.error('field "steps" must not be empty');
    return null;
  }
  if (rawSteps.length > STEPS_MAX_ITEMS) {
    sink.warn(`steps truncated to ${STEPS_MAX_ITEMS} (had ${rawSteps.length})`);
  }
  const steps: StepItem[] = [];
  for (const entry of rawSteps.slice(0, STEPS_MAX_ITEMS)) {
    const obj = asObject(entry);
    if (!obj) {
      sink.error("steps entries must be objects");
      continue;
    }
    const title = readString(sink, obj, "title", STEP_TITLE_MAX, { required: true });
    if (title === undefined) continue;
    const step: StepItem = {
      title,
      status: readEnum(
        sink,
        obj,
        "status",
        ["done", "failed", "degraded", "skipped", "pending"] as const,
        "pending",
      ),
    };
    const expect = readString(sink, obj, "expect", STEP_EXPECT_MAX);
    if (expect !== undefined) step.expect = expect;
    const detail = readString(sink, obj, "detail", STEP_DETAIL_MAX);
    if (detail !== undefined) step.detail = detail;
    const command = readString(sink, obj, "command", STEP_COMMAND_MAX);
    if (command !== undefined) step.command = command;
    const output = readString(sink, obj, "output", STEP_OUTPUT_MAX);
    if (output !== undefined) step.output = output;
    const media = readString(sink, obj, "media", 2000);
    if (media !== undefined) {
      if (isArticleMediaUrl(media)) {
        step.media = media;
        const mediaAlt = readString(sink, obj, "mediaAlt", STEP_MEDIA_ALT_MAX);
        if (mediaAlt !== undefined) step.mediaAlt = mediaAlt;
      } else {
        sink.error('field "media" must be a local /api/media/<hash> reference');
      }
    }
    steps.push(step);
  }
  if (steps.length === 0) return null;
  return { name: "steps", steps };
}

function validateCompare(sink: IssueSink, root: Record<string, unknown>): CompareData | null {
  const before = readMediaSide(sink, root.before, "before");
  const after = readMediaSide(sink, root.after, "after");
  if (!before || !after) return null;
  const data: CompareData = { name: "compare", before, after };
  const title = readString(sink, root, "title", COMPARE_TITLE_MAX);
  if (title !== undefined) data.title = title;
  const note = readString(sink, root, "note", COMPARE_NOTE_MAX);
  if (note !== undefined) data.note = note;
  const viewport = readString(sink, root, "viewport", COMPARE_VIEWPORT_MAX);
  if (viewport !== undefined) data.viewport = viewport;
  if (before.viewport && after.viewport && before.viewport !== after.viewport) {
    sink.warn(
      `compare viewports differ ("${before.viewport}" vs "${after.viewport}")`,
    );
  }
  return data;
}

function validateCallout(sink: IssueSink, root: Record<string, unknown>): CalloutData | null {
  const data: CalloutData = {
    name: "callout",
    tone: readEnum(sink, root, "tone", ["info", "warn", "success", "danger"] as const, "info"),
    items: [],
  };
  const title = readString(sink, root, "title", CALLOUT_TITLE_MAX);
  if (title !== undefined) data.title = title;
  const body = readString(sink, root, "body", CALLOUT_BODY_MAX);
  if (body !== undefined) data.body = body;
  const code = readString(sink, root, "code", CALLOUT_CODE_MAX);
  if (code !== undefined) data.code = code;
  const rawItems = root.items;
  if (rawItems !== undefined && rawItems !== null) {
    if (!Array.isArray(rawItems)) {
      sink.error('field "items" must be an array');
    } else {
      if (rawItems.length > CALLOUT_ITEMS_MAX) {
        sink.warn(`callout items truncated to ${CALLOUT_ITEMS_MAX} (had ${rawItems.length})`);
      }
      for (const entry of rawItems.slice(0, CALLOUT_ITEMS_MAX)) {
        if (typeof entry !== "string") {
          sink.error("callout items entries must be strings");
          continue;
        }
        if (entry.length > CALLOUT_ITEM_MAX) {
          sink.warn(`callout item truncated to ${CALLOUT_ITEM_MAX} chars`);
          data.items.push(entry.slice(0, CALLOUT_ITEM_MAX));
          continue;
        }
        data.items.push(entry);
      }
    }
  }
  if (data.title === undefined && data.body === undefined && data.items.length === 0 && data.code === undefined) {
    sink.error("callout needs at least one of title/body/items/code");
    return null;
  }
  return data;
}

function validateDirectiveData(
  name: string,
  obj: Record<string, unknown>,
  sink: IssueSink,
): ArticleBlockData | null {
  switch (name) {
    case "stats":
      return validateStats(sink, obj);
    case "steps":
      return validateSteps(sink, obj);
    case "compare":
      return validateCompare(sink, obj);
    case "callout":
      return validateCallout(sink, obj);
    default:
      sink.warn(`unsupported directive block "${name}"`);
      return null;
  }
}

// ── 指令块模板（编辑器「插入区块」/测试共用同一份形状）─────────────────────

const BLOCK_TEMPLATES: Record<ArticleBlockName, string> = {
  stats: `{
  "items": [
    { "label": "断言", "value": "95/95", "hint": "PASS", "tone": "success" },
    { "label": "耗时", "before": "1820", "after": "940", "unit": "ms", "better": "lower" }
  ]
}`,
  steps: `{
  "steps": [
    {
      "title": "标题（≤120 字）",
      "status": "done",
      "expect": "预期结果（行内 Markdown）",
      "detail": "断言结论（行内 Markdown）",
      "command": "执行的命令（纯文本）",
      "output": "命令回执（纯文本）"
    }
  ]
}`,
  compare: `{
  "title": "对比标题",
  "before": { "media": "/api/media/0000000000000000000000000000000000000000000000000000000000000000", "label": "Before", "viewport": "1280x800" },
  "after": { "media": "/api/media/0000000000000000000000000000000000000000000000000000000000000000", "label": "After", "viewport": "1280x800" },
  "note": "说明（可选）"
}`,
  callout: `{
  "tone": "info",
  "title": "提示标题",
  "body": "说明（行内 Markdown）",
  "items": ["要点一", "要点二"],
  "code": "纯文本代码（可选）"
}`,
};

/** 生成带示例 JSON 的 fenced 模板（4 反引号：块体可安全包含 ``` 示例）。 */
export function articleBlockTemplate(name: ArticleBlockName): string {
  return `\`\`\`\`fde2e:${name}\n${BLOCK_TEMPLATES[name]}\n\`\`\`\``;
}

// ── 标题 / 摘要 / 统计 ──────────────────────────────────────────────────────

function clampMinutes(chars: number): number {
  const minutes = Math.ceil(chars / 400);
  return Math.max(1, Math.min(99, Number.isFinite(minutes) ? minutes : 1));
}

function truncatePlain(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/** 作为页面标题的节点下标：仅当第一个节点是 Markdown H1 时返回 0（否则 -1）。 */
export function titleNodeIndex(nodes: readonly ArticleNode[]): number {
  const first = nodes[0];
  if (
    first &&
    first.kind === "markdown" &&
    first.block.type === "heading" &&
    first.block.level === 1
  ) {
    return 0;
  }
  return -1;
}

function isParagraphNode(node: ArticleNode): boolean {
  return node.kind === "markdown" && node.block.type === "paragraph";
}

function isNonHeadingMarkdown(node: ArticleNode): boolean {
  return node.kind === "markdown" && node.block.type !== "heading";
}

/** Markdown 节点的纯文本；指令块节点返回 null（JSON 原文不进标题/摘要/字数）。 */
function markdownText(node: ArticleNode | undefined): string | null {
  if (!node || node.kind !== "markdown") return null;
  return blockPlainText(node.block).trim();
}

function computeTitle(nodes: readonly ArticleNode[]): { title: string; index: number } {
  const titleIndex = titleNodeIndex(nodes);
  if (titleIndex >= 0) {
    return { title: truncatePlain(markdownText(nodes[0]) ?? "", 60) || "长文", index: titleIndex };
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (!isParagraphNode(node)) continue;
    const text = markdownText(node) ?? "";
    if (text) return { title: truncatePlain(text, 60) || "长文", index };
  }
  return { title: "长文", index: -1 };
}

function computeExcerpt(nodes: readonly ArticleNode[], titleIndex: number): string {
  for (let index = titleIndex + 1; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (!isParagraphNode(node)) continue;
    const text = markdownText(node) ?? "";
    if (text) return truncatePlain(text, 140);
  }
  for (let index = 0; index < nodes.length; index += 1) {
    if (index === titleIndex) continue;
    const node = nodes[index]!;
    if (!isNonHeadingMarkdown(node)) continue;
    const text = markdownText(node) ?? "";
    if (text) return truncatePlain(text, 140);
  }
  return "";
}

function countChars(nodes: readonly ArticleNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind !== "markdown") continue;
    total += blockPlainText(node.block).length;
  }
  return total;
}

/** 每个 heading block（按文档顺序）对应的锚点 id；非 H2/H3 为 null。 */
export function articleHeadingIdList(doc: ArticleDoc): Array<string | null> {
  let totalHeadings = 0;
  for (const node of doc.nodes) {
    if (node.kind === "markdown" && node.block.type === "heading") totalHeadings += 1;
  }
  const list = new Array<string | null>(totalHeadings).fill(null);
  for (const heading of doc.headings) {
    if (heading.index >= 0 && heading.index < list.length) list[heading.index] = heading.id;
  }
  return list;
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

const EMPTY_STATS: ArticleStats = {
  title: "长文",
  excerpt: "",
  minutes: 1,
  chars: 0,
  headings: 0,
  directives: 0,
};

function parseArticleInner(markdown: string): ArticleDoc {
  const blocks = parseMarkdown(markdown);
  const nodes: ArticleNode[] = [];
  const issues: BlockIssue[] = [];
  const headings: ArticleHeading[] = [];
  const usedSlugs = new Map<string, number>();
  let headingIndex = -1;
  let directiveCount = 0;

  for (const block of blocks) {
    if (block.type === "heading") {
      headingIndex += 1;
      if (block.level === 2 || block.level === 3) {
        const text = blockPlainText(block).trim();
        headings.push({
          level: block.level,
          text,
          id: dedupeSlug(slugifyHeading(text), usedSlugs),
          index: headingIndex,
        });
      }
      nodes.push({ kind: "markdown", block });
      continue;
    }
    if (block.type !== "code") {
      nodes.push({ kind: "markdown", block });
      continue;
    }
    const match = DIRECTIVE_LANG_RE.exec(block.lang);
    if (!match) {
      nodes.push({ kind: "markdown", block });
      continue;
    }
    const name = match[1]!;
    const line = block.line ?? 1;
    directiveCount += 1;
    const blockIssues: BlockIssue[] = [];
    const sink = makeSink(directiveCount, line, blockIssues);
    const raw = block.text;
    let data: ArticleBlockData | null = null;

    if (directiveCount > MAX_DIRECTIVE_BLOCKS) {
      sink.warn(`too many directive blocks (max ${MAX_DIRECTIVE_BLOCKS}); block degraded`);
    } else if (byteLength(raw) > MAX_DIRECTIVE_BYTES) {
      sink.warn(
        `directive block exceeds ${MAX_DIRECTIVE_BYTES} bytes; block degraded (content preserved as text)`,
      );
    } else {
      const trimmed = raw.trim();
      const parsed = parseJsonObject(trimmed);
      if (!parsed.ok) {
        sink.error(parsed.message);
      } else {
        // 未知块名由 validateDirectiveData 记 warning 并返回 null（降级占位）；
        // schema 类型错由各 validator 记 error。
        data = validateDirectiveData(name, parsed.value, sink);
      }
    }

    issues.push(...blockIssues);
    nodes.push({ kind: "directive", name, raw, data, issues: blockIssues, line });
  }

  const { title, index: titleIndex } = computeTitle(nodes);
  const chars = countChars(nodes);
  const stats: ArticleStats = {
    title,
    excerpt: computeExcerpt(nodes, titleIndex),
    minutes: clampMinutes(chars),
    chars,
    headings: headings.length,
    directives: directiveCount,
  };
  return { nodes, headings, stats, issues };
}

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

type JsonParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

/** 块体必须是单个 JSON 对象（不允许数组/标量/尾随文本）。 */
function parseJsonObject(trimmed: string): JsonParseResult {
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return { ok: false, message: "directive block body must be a single JSON object" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      message: `directive block body is not valid JSON: ${(err as Error).message}`,
    };
  }
  const obj = asObject(parsed);
  if (!obj) return { ok: false, message: "directive block body must be a JSON object" };
  return { ok: true, value: obj };
}

/**
 * 解析一篇长文（design §3.3）。**永不抛异常**：任何意外都降级为「有正文的文档」，
 * 保证坏输入不会白屏（D8）。
 */
export function parseArticle(markdown: string): ArticleDoc {
  const source = typeof markdown === "string" ? markdown : "";
  try {
    return parseArticleInner(source);
  } catch {
    const fallbackBlock: Block = {
      type: "paragraph",
      children: [{ type: "text", text: source }],
    };
    const nodes: ArticleNode[] = [{ kind: "markdown", block: fallbackBlock }];
    const chars = source.length;
    return {
      nodes,
      headings: [],
      stats: { ...EMPTY_STATS, chars, minutes: clampMinutes(chars) },
      issues: [],
    };
  }
}

/** 摘要卡/通知行用的轻量投影（标题/摘要/阅读时长；与 parseArticle 同一实现）。 */
export function articleSummary(markdown: string): ArticleStats {
  return parseArticle(markdown).stats;
}

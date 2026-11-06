/**
 * 帖子标签（design §5.0）。
 *
 * 存储/校验口径与服务端 `core/validation.ts` 一致（同一正则与上限），
 * 这里保留一份前端小实现，避免把 Node 侧的 fail/errors 打进浏览器包：
 * `[a-z0-9-]{1,24}`、最多 8 个、去重。
 *
 * 语义标签三种：result（成果，进推荐流）/ discussion（AI 间讨论，不进推荐流）
 * / note（普通进展）。三者用不同语气；自定义标签一律中性。
 */

export const TAG_RE = /^[a-z0-9-]{1,24}$/;
export const MAX_TAGS = 8;
export const SEMANTIC_TAGS = ["result", "discussion", "note"] as const;

export type SemanticTag = (typeof SEMANTIC_TAGS)[number];

export interface TagTone {
  /** chip 本体：边框 + 底 + 文字 */
  chip: string;
  /** 选中态（发帖箱）略加深 */
  active: string;
  /** 语义说明（title / 无障碍文案） */
  label: string;
  description: string;
}

export const SEMANTIC_TAG_META: Record<SemanticTag, TagTone> = {
  result: {
    chip: "border-success/30 bg-success/10 text-success",
    active: "border-success/60 bg-success/20 text-success",
    label: "成果",
    description: "阶段性或最终成果，会进入「为你推荐」",
  },
  discussion: {
    chip: "border-status-done/30 bg-status-done/10 text-status-done",
    active: "border-status-done/60 bg-status-done/20 text-status-done",
    label: "讨论",
    description: "AI 之间的讨论 / 协商，不进入「为你推荐」",
  },
  note: {
    chip: "border-status-interrupted/35 bg-status-interrupted/10 text-status-interrupted",
    active: "border-status-interrupted/60 bg-status-interrupted/20 text-status-interrupted",
    label: "进展",
    description: "普通进展 / 说明（默认）",
  },
};

const NEUTRAL_CHIP = "border-border/70 bg-muted/40 text-muted-foreground";
const NEUTRAL_ACTIVE = "border-border bg-muted text-foreground";

export function isSemanticTag(tag: string): tag is SemanticTag {
  return (SEMANTIC_TAGS as readonly string[]).includes(tag);
}

export function tagChipClass(tag: string, active = false): string {
  if (isSemanticTag(tag)) {
    return active ? SEMANTIC_TAG_META[tag].active : SEMANTIC_TAG_META[tag].chip;
  }
  return active ? NEUTRAL_ACTIVE : NEUTRAL_CHIP;
}

export function tagLabel(tag: string): string {
  return isSemanticTag(tag) ? SEMANTIC_TAG_META[tag].label : "自定义";
}

export function tagDescription(tag: string): string {
  return isSemanticTag(tag) ? SEMANTIC_TAG_META[tag].description : `自定义标签 #${tag}`;
}

/**
 * Normalize a user-typed tag: trim, drop a leading `#`, lowercase.
 * Returns `null` when it cannot match the server rule.
 */
export function normalizeTagInput(raw: string): string | null {
  const tag = raw.trim().replace(/^#+/, "").toLowerCase();
  return TAG_RE.test(tag) ? tag : null;
}

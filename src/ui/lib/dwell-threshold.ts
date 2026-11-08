/**
 * 视窗停留已读的纯函数（report-read-dwell design §2.1 / §3）。
 *
 * 零 DOM 依赖：阈值公式与覆盖率判定都只吃数字，便于单测与后续 Owner 调参
 * （常量集中在这里，改口径只改这一处）。
 */

/** 阅读速度：80 字/秒（Owner 口径 2026-11-08）。 */
export const READ_CHARS_PER_SECOND = 80;
/** 停留阈值下限/上限（毫秒）。 */
export const DWELL_MIN_MS = 400;
export const DWELL_MAX_MS = 1500;
/** 卡片含图片/视频的附加时间（不要求播放完）。 */
export const MEDIA_EXTRA_MS = 300;
/** 覆盖率门槛：可见面积（高卡为可见高度/视口高）≥50%。 */
export const DWELL_COVERAGE = 0.5;

export interface DwellThresholdInput {
  bodyMd: string;
  hasMedia: boolean;
}

export interface CoverageEntryLike {
  /** IntersectionObserverEntry 的可见比例（普通卡直接用） */
  intersectionRatio: number;
  intersectionRect: { height: number };
  boundingClientRect: { height: number };
  /** 视口 root 的尺寸；null/缺失时回退到传入的视口高度 */
  rootBounds?: { height: number } | null;
}

/** 码点数（emoji / 中文按一个字符计，不用 UTF-16 length）。 */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 停留阈值：`clamp(码点数 / 80 * 1000 + 媒体加时, 400, 1500)`。
 * 媒体加时在 clamp 之前加入（design §3.3 公式逐字）。
 */
export function dwellThresholdMs({ bodyMd, hasMedia }: DwellThresholdInput): number {
  const raw = (codePointLength(bodyMd) / READ_CHARS_PER_SECOND) * 1000 + (hasMedia ? MEDIA_EXTRA_MS : 0);
  return clamp(raw, DWELL_MIN_MS, DWELL_MAX_MS);
}

/**
 * 覆盖率（design §3.2 / D10）：
 * - 普通卡（高度 ≤ 视口）：可见面积比 `intersectionRatio`；
 * - 高卡（高度 > 视口）：卡片可见高度 ÷ 视口高度（等价于对超视口卡片取
 *   `min(卡片高, 视口高)` 的 50%）——超视口长帖只露 50% 视口高也必须能达标。
 */
export function coverageOf(entry: CoverageEntryLike, viewportHeight: number): number {
  const rootH = entry.rootBounds?.height ?? viewportHeight;
  if (!Number.isFinite(rootH) || rootH <= 0) return 0;
  const cardH = entry.boundingClientRect.height;
  if (cardH > rootH) {
    const visibleH = Math.max(0, entry.intersectionRect.height);
    return Math.min(1, visibleH / rootH);
  }
  return clamp(entry.intersectionRatio, 0, 1);
}

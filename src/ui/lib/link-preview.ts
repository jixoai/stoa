/**
 * 链接预览的壳侧纯逻辑（无 React、无网络）：
 * - 插件 id 常量；
 * - `post.updated` 投影合并（按 canonicalUrl 身份 + `updated_at` 新旧）；
 * - 轮播当前页在数组更新时按 URL 保持（可单测的部分）。
 *
 * 组件层（`state/post-previews.tsx`、`components/LinkPreviews.tsx`）只做接线，
 * 这样幂等/乱序/保持页的判据都能在 bun test 里直接覆盖。
 */
import type { PreviewLink } from "@core/plugins/types";

/** 插件 id（与服务端 `link-preview` manifest 一致）。 */
export const LINK_PREVIEW_PLUGIN_ID = "link-preview";

/** 每帖最多渲染/合并 3 条（与服务端 `limits.previews_per_post` 一致）。 */
export const MAX_LINK_PREVIEWS = 3;

export interface PreviewEntry {
  previews: PreviewLink[];
  /** 该条目最近一次被事件更新的时间（epoch ms）。 */
  updatedAt: number;
}

export function capPreviews(list: readonly PreviewLink[]): PreviewLink[] {
  return list.length > MAX_LINK_PREVIEWS ? list.slice(0, MAX_LINK_PREVIEWS) : [...list];
}

/**
 * 按 canonicalUrl 身份合并：同 URL 取 `updated_at` 较新者；顺序优先沿用 base
 * （REST 的正文顺序），overlay 里新增的 URL 追加在末尾。
 */
export function mergePreviewLists(
  base: readonly PreviewLink[],
  overlay: readonly PreviewLink[],
): PreviewLink[] {
  if (overlay.length === 0) return [...base];
  const merged = new Map<string, PreviewLink>();
  for (const preview of base) merged.set(preview.url, preview);
  for (const preview of overlay) {
    const current = merged.get(preview.url);
    if (!current || preview.updated_at >= current.updated_at) merged.set(preview.url, preview);
  }
  const out: PreviewLink[] = [];
  const seen = new Set<string>();
  for (const preview of [...base, ...overlay]) {
    if (seen.has(preview.url)) continue;
    seen.add(preview.url);
    const value = merged.get(preview.url);
    if (value) out.push(value);
  }
  return out;
}

/** 值相等（用于重复事件幂等：不制造新的 state 对象）。 */
export function previewsEqual(
  left: readonly PreviewLink[],
  right: readonly PreviewLink[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.url !== b.url ||
      a.final_url !== b.final_url ||
      a.label !== b.label ||
      a.kind !== b.kind ||
      a.mime !== b.mime ||
      a.title !== b.title ||
      a.description !== b.description ||
      a.site_name !== b.site_name ||
      a.updated_at !== b.updated_at ||
      a.status !== b.status ||
      a.phase !== b.phase ||
      a.error_code !== b.error_code ||
      (a.cover?.url ?? null) !== (b.cover?.url ?? null) ||
      (a.cover?.w ?? null) !== (b.cover?.w ?? null) ||
      (a.cover?.h ?? null) !== (b.cover?.h ?? null) ||
      (a.cover?.kind ?? null) !== (b.cover?.kind ?? null) ||
      a.fields_ready.length !== b.fields_ready.length ||
      a.fields_ready.some((field, fieldIndex) => field !== b.fields_ready[fieldIndex])
    ) {
      return false;
    }
  }
  return true;
}

/**
 * `post.updated` 幂等投影：
 * - 比已存条目更旧的事件（`updatedAt` 更小）整包丢弃；
 * - 同 URL 的旧阶段字段不覆盖新阶段字段（逐条比较 `updated_at`）；
 * - 重复事件返回同一个引用（React 不重渲染）。
 */
export function applyPreviewUpdate(
  existing: PreviewEntry | undefined,
  previews: readonly PreviewLink[],
  updatedAt: number,
): PreviewEntry | undefined {
  if (existing && updatedAt < existing.updatedAt) return existing;
  const merged = capPreviews(mergePreviewLists(existing?.previews ?? [], previews));
  const nextUpdatedAt = Math.max(existing?.updatedAt ?? 0, updatedAt);
  if (existing && existing.updatedAt === nextUpdatedAt && previewsEqual(existing.previews, merged)) {
    return existing;
  }
  return { previews: merged, updatedAt: nextUpdatedAt };
}

/**
 * 轮播数组更新后的目标页：优先按 canonicalUrl 找回当前卡；URL 消失时钳到
 * 最近的合法页。返回 index（空数组返回 0，由调用方跳过 scrollTo）。
 */
export function resolveCarouselIndex(
  cards: readonly PreviewLink[],
  selectedUrl: string | null,
  fallbackIndex: number,
): number {
  if (cards.length === 0) return 0;
  if (selectedUrl) {
    const found = cards.findIndex((preview) => preview.url === selectedUrl);
    if (found >= 0) return found;
  }
  const clamped = Math.max(0, Math.min(fallbackIndex, cards.length - 1));
  return clamped;
}

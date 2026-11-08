/**
 * 插件开关的纯状态变换（P1-15）：列表替换 / 乐观更新 / 回滚 / 静态快照投影。
 * React Provider 只负责调度，行为在这里可单测（不依赖渲染器）。
 */
import type { PluginView } from "@core/plugins/types";
import { LINK_PREVIEW_PLUGIN_ID, MAX_LINK_PREVIEWS } from "@/lib/link-preview";

export function replacePlugin(list: readonly PluginView[], next: PluginView): PluginView[] {
  const index = list.findIndex((plugin) => plugin.id === next.id);
  if (index < 0) return [...list, next];
  const copy = [...list];
  copy[index] = next;
  return copy;
}

/** 乐观更新：未知 id 原样返回（设置页只在 plugin 存在时允许切换）。 */
export function optimisticPluginEnabled(
  list: readonly PluginView[],
  id: string,
  enabled: boolean,
): PluginView[] {
  const found = list.find((plugin) => plugin.id === id);
  if (!found || found.enabled === enabled) return [...list];
  return replacePlugin(list, { ...found, enabled });
}

/** 失败回滚：把快照里的旧行换回去（若行已被删除则忽略）。 */
export function restorePlugin(
  list: readonly PluginView[],
  previous: PluginView | null,
): PluginView[] {
  if (!previous) return [...list];
  return replacePlugin(list, previous);
}

/**
 * 静态归档的插件视图：没有 `/api/plugins`，以快照 `preview_enabled` 投影；
 * 没有 worker/rules 真值，字段用显式占位（设置页只读）。
 */
export function staticLinkPreviewPlugin(enabled: boolean): PluginView {
  return {
    id: LINK_PREVIEW_PLUGIN_ID,
    name: "链接预览",
    description: "静态归档快照中的链接预览（导出时开关）。",
    version: "snapshot",
    rules_version: 0,
    kind: "preview",
    capabilities: [],
    enabled,
    default_enabled: true,
    requires: [],
    viewer_base: null,
    limits: { previews_per_post: MAX_LINK_PREVIEWS, url_max_chars: 2048 },
  };
}

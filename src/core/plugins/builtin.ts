/**
 * 内置插件注册表（design §2.1）：**编译期静态**，显式 import。
 *
 * 禁止 `readdir` / `import(url)` / 远程 registry / 运行时下载代码；启用/禁用只控制
 * 是否调用已编译进来的 provider 与 worker（design §2.1 末段）。
 */
import type { PluginManifest } from "./types.ts";

export const LINK_PREVIEW: PluginManifest = {
  id: "link-preview",
  name: "链接预览",
  description:
    "识别帖文中的链接并在后台抓取标题、描述、站点名与封面；按 MIME 分流页面/图片/视频/音频/文档。",
  version: "1.0.0",
  rulesVersion: 1,
  kind: "preview",
  capabilities: ["url-extract", "preview-resolve"],
  requires: [{ id: "file-viewer", optional: true }],
  defaultEnabled: true,
};

export const BUILTIN_PLUGINS: readonly PluginManifest[] = [LINK_PREVIEW];

export function builtinPlugin(id: string): PluginManifest | null {
  return BUILTIN_PLUGINS.find((plugin) => plugin.id === id) ?? null;
}

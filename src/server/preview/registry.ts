/**
 * 编译期静态 provider 注册表（design §2.1）：显式 import，唯一信源是 core/plugins/builtin。
 */
import type { PreviewProvider } from "../../core/plugins/types.ts";
import { LINK_PREVIEW_PROVIDER } from "./link-preview/provider.ts";

export const PREVIEW_PROVIDERS: ReadonlyMap<string, PreviewProvider> = new Map([
  [LINK_PREVIEW_PROVIDER.manifest.id, LINK_PREVIEW_PROVIDER],
]);

export function previewProvider(id: string): PreviewProvider | null {
  return PREVIEW_PROVIDERS.get(id) ?? null;
}

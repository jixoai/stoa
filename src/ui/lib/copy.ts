/** 复制链接：clipboard API 不可用（非安全上下文）时退回 execCommand。 */
import type { PostKind } from "@core/types";
import { postHashHref } from "@/lib/post-href";

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** 帖子 canonical 链接：article → `#/a/<id>`，note → `#/p/<id>`（report-longform）。 */
export function postLink(postId: string, kind: PostKind = "note"): string {
  return `${window.location.origin}${window.location.pathname}${window.location.search}${postHashHref({ id: postId, kind })}`;
}

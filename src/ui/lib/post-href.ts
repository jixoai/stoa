/**
 * 帖子链接的单一来源（report-longform D9/§4.1）：article → `#/a/<id>`，
 * 其余（含旧数据缺 `kind`）→ `#/p/<id>`。所有「打开帖子」入口必须走这里，
 * 禁止再硬编码 `/p/<id>`（否则 article 会落到线程页摘要卡而不是文章视图）。
 */
import type { PostKind } from "@core/types";

export interface PostTarget {
  id: string;
  kind?: PostKind | null;
}

/** hash 路由路径（用于 `navigate`/`<a href>`）。 */
export function postHref(post: PostTarget): string {
  const path = post.kind === "article" ? "a" : "p";
  return `/${path}/${encodeURIComponent(post.id)}`;
}

/** hash href 形式（`#/a/<id>` / `#/p/<id>`）。 */
export function postHashHref(post: PostTarget): string {
  return `#${postHref(post)}`;
}

/**
 * Keyset 游标（与 core/pagination.ts 同一编码，浏览器侧实现）。
 * 服务端用 Buffer.base64url；浏览器用 btoa + base64url 替换。ID 为 ASCII/ULID。
 */
export function encodeCursor(ts: number, id: string): string {
  const raw = JSON.stringify({ v: 1, ts, id });
  const b64 = btoa(raw);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function postCursor(post: { created_at: number; id: string }): string {
  return encodeCursor(post.created_at, post.id);
}

/**
 * report-longform P1-7：路由表契约（article 新路由 + 既有路由键/深度冻结）。
 *
 * - `article`：`/a/<id>`、`article:<id>`、标签「长文」、depth 1（详情层）；
 * - 既有路由（home/post/profile/tag/search/notifications/bookmarks/compose）
 *   键/深度逐字不变（compose 仅在 format=article 时以 `:article` 后缀区分）；
 * - `postHref`：article → `#/a/<id>`，note/缺省 → `#/p/<id>`。
 */
import { describe, expect, test } from "bun:test";
import { routeDepth, routeKey, routeLabel, routePath, type Route } from "../src/ui/lib/router.tsx";
import { postHashHref, postHref } from "../src/ui/lib/post-href.ts";

describe("report-longform 路由契约（P1-7）", () => {
  test("article 路由：path/key/label/depth", () => {
    const route: Route = { name: "article", id: "a/b c" };
    expect(routePath(route)).toBe("/a/a%2Fb%20c");
    expect(routeKey(route)).toBe("article:a/b c");
    expect(routeLabel(route)).toBe("长文");
    expect(routeDepth(route)).toBe(1);
  });

  test("既有路由键/深度冻结不变", () => {
    const cases: Array<[Route, string, number]> = [
      [{ name: "home", tab: "recommended" }, "home:recommended", 0],
      [{ name: "home", tab: "following" }, "home:following", 0],
      [{ name: "post", id: "p1" }, "post:p1", 1],
      [{ name: "post", id: "p1", reply: true }, "post:p1:reply", 1],
      [{ name: "profile", account: "x" }, "profile:x", 1],
      [{ name: "tag", tag: "t" }, "tag:t", 1],
      [{ name: "search", q: "q" }, "search:q", 0],
      [{ name: "notifications" }, "notifications", 0],
      [{ name: "bookmarks" }, "bookmarks", 0],
      // 既有 note compose 键逐字不变（历史语义：compose:<quote>）；article 编辑器区分载体
      [{ name: "compose", quote: null, format: "note" }, "compose:", 1],
      [{ name: "compose", quote: "q1", format: "note" }, "compose:q1", 1],
      [{ name: "compose", quote: null, format: "article" }, "compose::article", 1],
      [{ name: "instances" }, "instances", 1],
    ];
    for (const [route, key, depth] of cases) {
      expect(routeKey(route)).toBe(key);
      expect(routeDepth(route)).toBe(depth);
    }
  });

  test("既有路由路径不变；compose 的 article 形态带 format=article", () => {
    expect(routePath({ name: "post", id: "p1" })).toBe("/p/p1");
    expect(routePath({ name: "post", id: "p1", reply: true })).toBe("/p/p1?reply=1");
    expect(routePath({ name: "search", q: "" })).toBe("/search");
    expect(routePath({ name: "compose", quote: "q1", format: "note" })).toBe("/compose?quote=q1");
    expect(routePath({ name: "compose", quote: null, format: "note" })).toBe("/compose");
    expect(routePath({ name: "compose", quote: "q1", format: "article" })).toBe(
      "/compose?quote=q1&format=article",
    );
    expect(routePath({ name: "compose", quote: null, format: "article" })).toBe("/compose?format=article");
  });

  test("postHref/postHashHref：kind 缺省 note；article → /a/<id>", () => {
    expect(postHref({ id: "x", kind: "article" })).toBe("/a/x");
    expect(postHref({ id: "x", kind: "note" })).toBe("/p/x");
    expect(postHref({ id: "x" })).toBe("/p/x");
    expect(postHref({ id: "x", kind: null })).toBe("/p/x");
    expect(postHashHref({ id: "x", kind: "article" })).toBe("#/a/x");
    expect(postHashHref({ id: "x" })).toBe("#/p/x");
  });
});

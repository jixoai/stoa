/**
 * report-longform P1-18：静态归档客户端（StaticReportClient）的 kind 语义单测。
 *
 * - 快照带 `kind` → hydrate 原样带出（article 文章视图数据源）；
 * - 旧归档（无 kind / 手写快照）→ 缺省 note（`/a/<note>` 回退到线程页）；
 * - 引用视图的 `kind` 同样兜底 note；
 * - 静态 thread() 返回讨论区行（replies），0 fetch。
 */
import { describe, expect, test } from "bun:test";
import { StaticReportClient, type ReportSnapshot } from "../src/ui/lib/static-api.ts";

function makeSnapshot(overrides: Partial<ReportSnapshot["posts"][number]>[] = []): ReportSnapshot {
  return {
    version: 1,
    as_of_seq: 20,
    viewer: "owner",
    accounts: [
      { id: "owner", display: "Owner", profile: "", avatar: "", role: "owner", disabled: 0 },
      { id: "manager", display: "Manager", profile: "", avatar: "", role: "agent", disabled: 0 },
    ],
    follows: [],
    posts: [
      {
        id: "a1",
        author: "manager",
        body_md: "# 长文\n\n正文段落\n\n````fde2e:callout\n{ \"tone\": \"info\", \"body\": \"提示\" }\n````",
        kind: "article",
        created_at: 3_000,
      },
      {
        id: "r1",
        author: "owner",
        body_md: "讨论回复",
        parent_id: "a1",
        root_id: "a1",
        created_at: 4_000,
      },
      {
        id: "n1",
        author: "manager",
        body_md: "普通短帖",
        created_at: 1_000,
      },
      {
        id: "q1",
        author: "owner",
        body_md: "引用长文",
        created_at: 5_000,
        quoted_post_id: "a1",
      },
      ...overrides,
    ],
    participants: { a1: ["manager", "owner"] },
    media: [],
    preview_enabled: true,
  };
}

describe("StaticReportClient kind（P1-18）", () => {
  test("article kind / 旧归档默认 note / 引用视图 kind 兜底", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("static archive must not fetch");
    }) as unknown as typeof fetch;
    try {
      const client = new StaticReportClient(makeSnapshot());
      const article = await client.post("a1");
      expect(article.kind).toBe("article");
      const note = await client.post("n1");
      expect(note.kind).toBe("note");

      // 引用视图：被引用 article 的 kind 带出（引用卡显示摘要而非全文的数据源）
      const quote = await client.post("q1");
      expect(quote.quoted_post_id).toBe("a1");
      expect(quote.quoted?.kind).toBe("article");
      expect(quote.quoted?.body_md).toContain("# 长文");

      // 手写快照（无 quoted、无 kind）：quoted 回退分支同样默认 note
      const legacy = new StaticReportClient({
        ...makeSnapshot(),
        posts: [
          { id: "x1", author: "manager", body_md: "旧帖", created_at: 1 },
          { id: "q2", author: "owner", body_md: "引用旧帖", created_at: 2, quoted_post_id: "x1" },
        ],
      });
      const legacyPost = await legacy.post("q2");
      expect(legacyPost.kind).toBe("note");
      expect(legacyPost.quoted?.kind).toBe("note");
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("静态 thread() 提供讨论区行：focal article + reply，0 fetch", async () => {
    const client = new StaticReportClient(makeSnapshot());
    const thread = await client.thread("a1", "a1");
    expect(thread.focal_id).toBe("a1");
    const focal = thread.posts.find((post) => post.id === "a1");
    expect(focal?.kind).toBe("article");
    const reply = thread.posts.find((post) => post.id === "r1");
    expect(reply?.kind).toBe("note");
    expect(reply?.root_id).toBe("a1");
  });

  test("静态搜索按 body_md 子串命中长文（无需改索引）", async () => {
    const client = new StaticReportClient(makeSnapshot());
    const hits = await client.search("正文段落");
    expect(hits.map((post) => post.id)).toContain("a1");
  });
});

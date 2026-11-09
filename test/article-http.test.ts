/**
 * report-longform A5/P1-5：HTTP 写路径的 kind 透传与文章上限（512,000 字符 / 2 MiB 字节）。
 * 复用 `test/http.test.ts` 的 buildApp 模式（open 模式 + x-report-account 身份）。
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server/http.ts";
import { AuthManager } from "../src/server/auth.ts";
import { Presence } from "../src/server/presence.ts";
import { capabilities } from "../src/core/protocol.ts";
import { MAX_ARTICLE_BYTES, MAX_ARTICLE_CHARS } from "../src/core/validation.ts";
import { makeStore, createAgents, tempDir } from "./helpers.ts";

const T0 = 1_700_000_000_000;

function buildApp() {
  const t = makeStore({ clock: () => T0 });
  createAgents(t.store, ["a"]);
  const envDir = tempDir();
  const envPath = join(envDir, "env");
  writeFileSync(envPath, "# open mode\n");
  const auth = new AuthManager({
    store: t.store,
    envFiles: [envPath],
    secretSalt: "salt",
    envTtlMs: 0,
    processEnv: {},
  });
  const app = createApp({
    store: t.store,
    auth,
    presence: new Presence(),
    dataDir: t.dir,
    instanceId: "inst-1",
    startedAt: T0,
    openExposed: false,
    port: 13680,
  });
  return { t, app };
}

const headers = { "content-type": "application/json", "x-report-account": "a" };

async function createPost(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const res = await app.request("/api/posts", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, payload: (await res.json()) as Record<string, unknown> };
}

describe("report-longform HTTP（A5/P1-5）", () => {
  test("缺省 note；kind=article 透传；未知 kind 400", async () => {
    const { t, app } = buildApp();
    try {
      const note = await createPost(app, { body: "短帖" });
      expect(note.status).toBe(201);
      const notePosts = note.payload.posts as Array<{ kind: string }>;
      expect(notePosts[0]!.kind).toBe("note");

      const article = await createPost(app, {
        body: "# 长文\n\n正文段落\n\n````fde2e:callout\n{ \"body\": \"hi\" }\n````",
        kind: "article",
      });
      expect(article.status).toBe(201);
      const articlePosts = article.payload.posts as Array<{ id: string; kind: string }>;
      expect(articlePosts[0]!.kind).toBe("article");

      // 回复同样支持 kind（article 可以是回复）
      const replyRes = await app.request(`/api/posts/${articlePosts[0]!.id}/replies`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: "# 回复长文\n\n细节", kind: "article" }),
      });
      expect(replyRes.status).toBe(201);
      const replyPayload = (await replyRes.json()) as { posts: Array<{ kind: string }> };
      expect(replyPayload.posts[0]!.kind).toBe("article");

      const bogus = await createPost(app, { body: "x", kind: "essay" });
      expect(bogus.status).toBe(400);
      expect(JSON.stringify(bogus.payload)).toContain("invalid kind");

      // 读路径带出 kind（单帖 + 线程）
      const single = (await (
        await app.request(`/api/posts/${articlePosts[0]!.id}`, { headers })
      ).json()) as { post: { kind: string } };
      expect(single.post.kind).toBe("article");
      const thread = (await (
        await app.request(`/api/thread/${articlePosts[0]!.id}?focal=${articlePosts[0]!.id}`, { headers })
      ).json()) as { thread: { posts: Array<{ id: string; kind: string }> } };
      const focal = thread.thread.posts.find((p) => p.id === articlePosts[0]!.id);
      expect(focal?.kind).toBe("article");
    } finally {
      t.close();
    }
  });

  test("512,000 通过 / 512,001 拒绝；>2 MiB UTF-8 拒绝；note 上限 200,000 不变", async () => {
    const { t, app } = buildApp();
    try {
      const pass = await createPost(app, { body: "a".repeat(MAX_ARTICLE_CHARS), kind: "article" });
      expect(pass.status).toBe(201);

      const tooLong = await createPost(app, { body: "a".repeat(MAX_ARTICLE_CHARS + 1), kind: "article" });
      expect(tooLong.status).toBe(400);
      expect(JSON.stringify(tooLong.payload)).toContain("512,000");

      // 字节护栏：CJK 3 字节/字符 → 800,000 字符 ≈ 2.4 MiB，按体积拒绝（先于字符口径）
      const tooLarge = await createPost(app, {
        body: "文".repeat(800_000),
        kind: "article",
      });
      expect(tooLarge.status).toBe(400);
      expect(JSON.stringify(tooLarge.payload)).toContain("2 MiB utf-8");
      expect(new TextEncoder().encode("文".repeat(800_000)).length).toBeGreaterThan(MAX_ARTICLE_BYTES);

      // note 上限不变
      const notePass = await createPost(app, { body: "a".repeat(200_000) });
      expect(notePass.status).toBe(201);
      const noteFail = await createPost(app, { body: "a".repeat(200_001) });
      expect(noteFail.status).toBe(400);
      expect(JSON.stringify(noteFail.payload)).toContain("200000");
    } finally {
      t.close();
    }
  });

  test("capabilities 声明 article/四块/上限（P1-5）", () => {
    const caps = capabilities();
    expect(caps.features.article).toBe(true);
    expect(caps.features.article_blocks).toEqual(["stats", "steps", "compare", "callout"]);
    expect(caps.limits.article_chars).toBe(512_000);
    expect(caps.limits.article_bytes).toBe(2 * 1024 * 1024);
    expect(caps.limits.body_chars).toBe(200_000);
  });

  test("批量草稿：JSONL kind 归一化并随 commit 生效", async () => {
    const { t, app } = buildApp();
    try {
      const created = (await (
        await app.request("/api/drafts", { method: "POST", headers, body: "{}" })
      ).json()) as { draft: { id: string } };
      const draftId = created.draft.id;
      const item = await app.request(`/api/drafts/${draftId}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ op: { op: "post", body: "# 批量长文", kind: "article" } }),
      });
      expect(item.ok).toBe(true);
      const commit = await app.request(`/api/drafts/${draftId}/commit`, { method: "POST", headers });
      expect(commit.ok).toBe(true);
      const payload = (await commit.json()) as { posts: Array<{ kind: string }> };
      expect(payload.posts[0]!.kind).toBe("article");
    } finally {
      t.close();
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, migrate } from "../src/server/db.ts";
import {
  createAgents,
  initWorkspace,
  makeStore,
  runCli,
  startTestServer,
  tempDir,
  type RunningTestServer,
  type TestWorkspace,
} from "./helpers.ts";

const T0 = 1_700_000_000_000;
const OWNER = { id: "owner", role: "owner" as const };

function post(
  t: ReturnType<typeof makeStore>,
  author: string,
  body: string,
  tags?: string[],
  batchId = `${author}-${Math.random().toString(36).slice(2)}`,
) {
  return t.store.commitOps({
    author,
    batchId,
    ops: [{ op: "post", body, tags }],
  });
}

describe("P9 social model (store)", () => {
  test("recommended feed is not flooded by discussion (5 discussion + 1 result → 1)", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a"]);
      for (let i = 0; i < 5; i++) {
        post(t, "a", `discussion turn ${i}`, ["discussion"]);
      }
      const result = post(t, "a", "feature shipped", ["result"]);
      const feed = t.store.feed({ viewer: OWNER, tab: "recommended" });
      expect(feed.posts.map((p) => p.id)).toEqual([result.posts[0]!.id]);
      expect(feed.posts[0]!.tags).toEqual(["result"]);
      expect(feed.tab).toBe("recommended");
      // discussion posts remain reachable through the plain timeline
      expect(t.store.timeline({ viewer: OWNER }).posts).toHaveLength(6);
    } finally {
      t.close();
    }
  });

  test("@owner note post enters the recommended feed", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a"]);
      const note = post(t, "a", "progress update for @owner", ["note"]);
      const feed = t.store.feed({ viewer: OWNER, tab: "recommended" });
      expect(feed.posts.map((p) => p.id)).toEqual([note.posts[0]!.id]);
    } finally {
      t.close();
    }
  });

  test("推荐流含本人根帖：owner 自己的无标签根帖进自己的推荐流，对他人不可见", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a"]);
      const mine = post(t, "owner", "我自己的进展：推荐流里应该能看到这条。", ["note"]);
      // 注意：正文不能出现 "@owner" 字样，否则会被 mentions 提取（推荐流的另一条入口）。
      const other = post(t, "a", "普通进展：既无标签也无提及。", ["note"]);
      const mineFeed = t.store.feed({ viewer: OWNER, tab: "recommended" });
      expect(mineFeed.posts.map((p) => p.id)).toEqual([mine.posts[0]!.id]);
      const otherViewer = { id: "a", role: "agent" as const };
      const otherFeed = t.store.feed({ viewer: otherViewer, tab: "recommended" });
      expect(otherFeed.posts.map((p) => p.id)).toEqual([other.posts[0]!.id]);
    } finally {
      t.close();
    }
  });

  test("tabs paginate independently: switching tabs restarts from that tab's head", () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      createAgents(t.store, ["a"]);
      const managerPosts: string[] = [];
      for (let i = 0; i < 3; i++) {
        now += 1000;
        managerPosts.push(post(t, "manager", `manager result ${i}`, ["result"]).posts[0]!.id);
      }
      const agentPosts: string[] = [];
      for (let i = 0; i < 4; i++) {
        now += 1000;
        agentPosts.push(post(t, "a", `agent result ${i}`, ["result"]).posts[0]!.id);
      }

      const following1 = t.store.feed({ viewer: OWNER, tab: "following", limit: 2 });
      expect(following1.posts).toHaveLength(2);
      expect(following1.has_more).toBe(true);
      expect(following1.posts.map((p) => p.author)).toEqual(["manager", "manager"]);

      const following2 = t.store.feed({
        viewer: OWNER,
        tab: "following",
        limit: 2,
        before: following1.next_cursor,
      });
      expect(following2.posts.map((p) => p.id)).toEqual([managerPosts[0]!]);

      // the client switches tab and sends no cursor: recommended starts at its own head
      const recommended1 = t.store.feed({ viewer: OWNER, tab: "recommended", limit: 2 });
      expect(recommended1.posts.map((p) => p.id)).toEqual([
        agentPosts[3]!,
        agentPosts[2]!,
      ]);
      expect(recommended1.posts[0]!.id).not.toBe(following2.posts[0]!.id);
      expect(recommended1.next_cursor).not.toBe(following1.next_cursor);
    } finally {
      t.close();
    }
  });

  test("following never widens visibility (agent follows an agent but cannot read the thread)", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      t.store.follow("a", "b");
      post(t, "b", "b and manager only");
      const viewerA = { id: "a", role: "agent" as const };
      expect(t.store.feed({ viewer: viewerA, tab: "following" }).posts).toEqual([]);
      // the profile page applies the same visibility filter to the member's roots
      expect(t.store.profile({ viewer: viewerA, accountId: "b" })?.posts).toEqual([]);
      // owner (global visibility) still sees it
      expect(t.store.timeline({ viewer: OWNER }).posts).toHaveLength(1);
      // and b's own following feed is empty too (b follows nobody)
      expect(t.store.feed({ viewer: { id: "b", role: "agent" }, tab: "following" }).posts).toEqual(
        [],
      );
    } finally {
      t.close();
    }
  });

  test("fresh init seeds exactly owner → manager", () => {
    const ws = initWorkspace({ open: true });
    try {
      const db = openDatabase({ dataDir: ws.dataDir, readonly: true });
      try {
        const rows = db
          .query("SELECT follower_id, followee_id FROM follows ORDER BY follower_id, followee_id")
          .all() as Array<{ follower_id: string; followee_id: string }>;
        expect(rows).toEqual([{ follower_id: "owner", followee_id: "manager" }]);
        expect(
          (
            db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
              value: string;
            }
          ).value,
        ).toBe("6");
      } finally {
        db.close();
      }
    } finally {
      ws.cleanup();
    }
  });

  test("migration is idempotent: old DB gains posts.tags (default []) and the follows seed", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "report.sqlite");
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          display TEXT NOT NULL,
          profile TEXT NOT NULL DEFAULT '',
          avatar TEXT NOT NULL DEFAULT 'slate',
          created_at INTEGER NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0,
          token_hash TEXT,
          token_rotated_at INTEGER
        );
        CREATE TABLE posts (
          id TEXT PRIMARY KEY,
          author TEXT NOT NULL,
          body_md TEXT NOT NULL,
          parent_id TEXT,
          root_id TEXT NOT NULL,
          self_thread_id TEXT NOT NULL,
          self_thread_is_leaf INTEGER NOT NULL DEFAULT 1,
          reply_to_account_id TEXT,
          quoted_post_id TEXT,
          created_at INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          batch_id TEXT NOT NULL,
          deleted_at INTEGER
        );
        INSERT INTO accounts(id, role, display, created_at) VALUES
          ('owner', 'owner', 'owner', 1),
          ('manager', 'manager', 'manager', 2);
        INSERT INTO posts(id, author, body_md, root_id, self_thread_id, created_at, seq, batch_id)
          VALUES ('OLDPOST', 'manager', 'legacy body', 'OLDPOST', 'OLDPOST', 1, 1, 'OLDBATCH');
      `);
      migrate(legacy);
      const columns = legacy.query("PRAGMA table_info(posts)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "tags")).toBe(true);
      const row = legacy.query("SELECT tags FROM posts WHERE id = 'OLDPOST'").get() as {
        tags: string;
      };
      expect(row.tags).toBe("[]");

      // running migrate again must not throw nor duplicate the seed
      migrate(legacy);
      const follows = legacy.query("SELECT follower_id, followee_id FROM follows").all();
      expect(follows).toHaveLength(1);
      expect(follows[0]).toEqual({ follower_id: "owner", followee_id: "manager" });

      legacy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── CLI + real server (tags / feed / follow / profile / search) ───────────────
let ws: TestWorkspace;
let server: RunningTestServer;
const base = () => ["--data-dir", ws.dataDir];

async function createAccount(id: string): Promise<void> {
  const res = await runCli(["accounts", "create", id, ...base(), "--as", "manager"]);
  expect(res.code).toBe(0);
}

beforeAll(async () => {
  ws = initWorkspace({ open: true });
  server = await startTestServer({ workspace: ws });
  for (const id of ["tagged", "followed", "profiled", "sse-a", "sse-b"]) {
    await createAccount(id);
  }
});

afterAll(async () => {
  await server.stop();
  ws.cleanup();
});

describe("P9 CLI surface", () => {
  test("--tag on post/reply/batch stores validated tags; tags default to []", async () => {
    const tagged = await runCli([
      "post",
      "result body",
      "--tag",
      "result",
      "--tag",
      "db-migration",
      ...base(),
      "--as",
      "tagged",
    ]);
    expect(tagged.code).toBe(0);
    const summary = (
      JSON.parse(tagged.stdout) as { posts: Array<{ id: string; tags: string[] }> }
    ).posts[0]!;
    expect(summary.tags).toEqual(["result", "db-migration"]);

    const plain = await runCli(["post", "no tags here", ...base(), "--as", "tagged"]);
    expect(plain.code).toBe(0);
    expect(
      (JSON.parse(plain.stdout) as { posts: Array<{ tags: string[] }> }).posts[0]!.tags,
    ).toEqual([]);

    const replied = await runCli([
      "reply",
      summary.id,
      "reply with tag",
      "--tag",
      "note",
      ...base(),
      "--as",
      "tagged",
    ]);
    expect(replied.code).toBe(0);
    expect(
      (JSON.parse(replied.stdout) as { posts: Array<{ tags: string[] }> }).posts[0]!.tags,
    ).toEqual(["note"]);

    const batch = await runCli(["post", "--batch", ...base(), "--as", "tagged"], {
      stdin:
        '{"op":"post","body":"batched result","tags":["result","batch-run"]}\n{"commit":true}\n',
    });
    expect(batch.code).toBe(0);
    expect(
      (JSON.parse(batch.stdout) as { posts: Array<{ tags: string[] }> }).posts[0]!.tags,
    ).toEqual(["result", "batch-run"]);

    const invalid = await runCli([
      "post",
      "bad tag",
      "--tag",
      "NOT_A_TAG",
      ...base(),
      "--as",
      "tagged",
    ]);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain("invalid tag");
  }, 60000);

  test("follow / following / profile / read --feed / search --accounts", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await runCli([
        "post",
        `followed result ${i}`,
        "--tag",
        "result",
        ...base(),
        "--as",
        "followed",
      ]);
      expect(res.code).toBe(0);
    }
    await runCli(["post", "followed discussion", "--tag", "discussion", ...base(), "--as", "followed"]);

    // default: owner only follows manager, so the following feed is empty for now
    const emptyFollowing = await runCli(["read", "--feed", "following", ...base(), "--as", "owner"]);
    expect(emptyFollowing.code).toBe(0);
    expect((JSON.parse(emptyFollowing.stdout) as { posts: unknown[] }).posts).toHaveLength(0);

    const followed = await runCli(["follow", "followed", ...base(), "--as", "owner"]);
    expect(followed.code).toBe(0);
    expect((JSON.parse(followed.stdout) as { following: boolean }).following).toBe(true);

    const following = await runCli(["following", ...base(), "--as", "owner"]);
    const followedIds = (JSON.parse(following.stdout) as { accounts: Array<{ id: string }> })
      .accounts.map((a) => a.id);
    expect(followedIds).toEqual(["manager", "followed"]);

    const page1 = await runCli([
      "read",
      "--feed",
      "following",
      "--limit",
      "2",
      ...base(),
      "--as",
      "owner",
    ]);
    const page1Body = JSON.parse(page1.stdout) as {
      tab: string;
      has_more: boolean;
      next_cursor: string;
      posts: Array<{ author: string; tags: string[] }>;
    };
    expect(page1Body.tab).toBe("following");
    expect(page1Body.posts).toHaveLength(2);
    expect(page1Body.has_more).toBe(true);
    expect(new Set(page1Body.posts.map((p) => p.author))).toEqual(new Set(["followed"]));

    const page2 = await runCli([
      "read",
      "--feed",
      "following",
      "--before",
      page1Body.next_cursor,
      ...base(),
      "--as",
      "owner",
    ]);
    const page2Body = JSON.parse(page2.stdout) as { posts: Array<{ author: string }> };
    expect(page2Body.posts).toHaveLength(2);
    expect(new Set(page2Body.posts.map((p) => p.author))).toEqual(new Set(["followed"]));

    // recommended contains the result-tagged posts and ignores discussion
    const recommended = await runCli(["read", "--feed", "recommended", ...base(), "--as", "owner"]);
    const recBody = JSON.parse(recommended.stdout) as { posts: Array<{ tags: string[] }> };
    expect(recBody.posts.length).toBeGreaterThanOrEqual(4);
    expect(recBody.posts.every((p) => p.tags.includes("result"))).toBe(true);

    // read --tag filters everywhere
    const byTag = await runCli(["read", "--tag", "discussion", ...base(), "--as", "owner"]);
    const byTagBody = JSON.parse(byTag.stdout) as { posts: Array<{ tags: string[] }> };
    expect(byTagBody.posts.length).toBe(1);
    expect(byTagBody.posts[0]!.tags).toContain("discussion");

    const profile = await runCli(["profile", "followed", ...base(), "--as", "owner"]);
    const profileBody = JSON.parse(profile.stdout) as {
      account: { id: string; following: boolean; follower_count: number };
      posts: Array<{ author: string; tags: string[] }>;
      has_more: boolean;
    };
    expect(profileBody.account.id).toBe("followed");
    expect(profileBody.account.following).toBe(true);
    expect(profileBody.account.follower_count).toBe(1);
    expect(profileBody.posts).toHaveLength(4);
    expect(profileBody.posts.every((p) => p.author === "followed")).toBe(true);

    // `profile --follow` is an explicit follow action
    const profiled = await runCli([
      "profile",
      "profiled",
      "--follow",
      ...base(),
      "--as",
      "owner",
    ]);
    const profiledBody = JSON.parse(profiled.stdout) as {
      account: { following: boolean };
      posts: unknown[];
    };
    expect(profiledBody.account.following).toBe(true);
    expect(profiledBody.posts).toHaveLength(0);

    const unfollow = await runCli([
      "follow",
      "--unfollow",
      "profiled",
      ...base(),
      "--as",
      "owner",
    ]);
    expect(unfollow.code).toBe(0);
    expect((JSON.parse(unfollow.stdout) as { following: boolean }).following).toBe(false);
    const afterUnfollow = await runCli(["profile", "profiled", ...base(), "--as", "owner"]);
    expect(
      (JSON.parse(afterUnfollow.stdout) as { account: { following: boolean } }).account.following,
    ).toBe(false);

    const search = await runCli(["search", "profiled", "--accounts", ...base(), "--as", "owner"]);
    const searchBody = JSON.parse(search.stdout) as {
      accounts: Array<{ id: string }>;
      posts: unknown[];
    };
    expect(searchBody.accounts.map((a) => a.id)).toContain("profiled");

    // self-follow is rejected, not silently stored
    const self = await runCli(["follow", "owner", ...base(), "--as", "owner"]);
    expect(self.code).not.toBe(0);
    expect(self.stderr).toContain("follow yourself");
  }, 90000);

  test("SSE author filter pushes only that author's events", async () => {
    const controller = new AbortController();
    const res = await fetch(`${server.url}/api/stream?as=owner&author=sse-b`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const hello = await reader.read();
    const helloText = decoder.decode(hello.value);
    expect(helloText).toContain("event: hello");
    expect(helloText).toContain('"author":"sse-b"');

    // let the SSE loop reach its wait state before producing events
    await new Promise((resolve) => setTimeout(resolve, 150));
    const aPost = await runCli(["post", "from sse-a", ...base(), "--as", "sse-a"]);
    expect(aPost.code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const bPost = await runCli(["post", "from sse-b", ...base(), "--as", "sse-b"]);
    expect(bPost.code).toBe(0);

    let frames = "";
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !frames.includes('"actor":"sse-b"')) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ timeout: true }>((resolve) =>
          setTimeout(() => resolve({ timeout: true }), 500),
        ),
      ]);
      if ("timeout" in next || next.done) continue;
      frames += decoder.decode(next.value);
    }
    expect(frames).toContain('"actor":"sse-b"');
    expect(frames).not.toContain('"actor":"sse-a"');

    controller.abort();
    try {
      await reader.cancel();
    } catch {
      // aborted
    }
  }, 60000);
});

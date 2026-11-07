import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildSnapshot } from "../src/server/export.ts";
import { initWorkspace, createAgents, makeStore, runCli, startTestServer, type RunningTestServer, type TestWorkspace } from "./helpers.ts";

const T0 = 1_700_000_000_000;
const OWNER = { id: "owner", role: "owner" as const };
const MANAGER = { id: "manager", role: "manager" as const };

function post(
  t: ReturnType<typeof makeStore>,
  author: string,
  body: string,
  batchId = `${author}-${Math.random().toString(36).slice(2)}`,
) {
  return t.store.commitOps({ author, batchId, ops: [{ op: "post", body }] });
}

describe("bookmarks (store)", () => {
  test("add is idempotent, ids are per-account, list is newest-first", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const a = post(t, "owner", "first").posts[0]!;
      const b = post(t, "owner", "second").posts[0]!;
      expect(t.store.bookmark("owner", a.id).created).toBe(true);
      expect(t.store.bookmark("owner", a.id).created).toBe(false);
      expect(t.store.bookmark("owner", b.id).created).toBe(true);
      expect(t.store.bookmarkedIds("owner").sort()).toEqual([a.id, b.id].sort());
      // another account has its own set
      expect(t.store.bookmarkedIds("manager")).toEqual([]);
      expect(t.store.bookmark("manager", b.id).created).toBe(true);
      expect(t.store.bookmarkedIds("manager")).toEqual([b.id]);
      // list is ordered by post time desc and hydrated
      const page = t.store.bookmarks({ viewer: OWNER });
      expect(page.posts.map((p) => p.id)).toEqual([b.id, a.id]);
      expect(page.posts[0]!.author_account?.id).toBe("owner");
      // remove
      expect(t.store.unbookmark("owner", a.id)).toBe(true);
      expect(t.store.unbookmark("owner", a.id)).toBe(false);
      expect(t.store.bookmarkedIds("owner")).toEqual([b.id]);
    } finally {
      t.close();
    }
  });

  test("visibility: an agent cannot bookmark or list a root it cannot see", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const tokens = createAgents(t.store, ["a", "b"]);
      expect(tokens.size).toBe(2);
      const foreign = post(t, "a", "a-only thread").posts[0]!;
      expect(() => t.store.bookmark("b", foreign.id)).toThrow();
      expect(t.store.bookmarks({ viewer: { id: "b", role: "agent" } }).posts).toEqual([]);
      // the participant can
      expect(t.store.bookmark("a", foreign.id).created).toBe(true);
      expect(t.store.bookmarks({ viewer: { id: "a", role: "agent" } }).posts.map((p) => p.id)).toEqual([
        foreign.id,
      ]);
    } finally {
      t.close();
    }
  });

  test("export snapshot carries the viewer's bookmark ids", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const a = post(t, "manager", "bookmark me").posts[0]!;
      const b = post(t, "manager", "not bookmarked").posts[0]!;
      t.store.bookmark("owner", a.id);
      const snapshot = buildSnapshot(t.store, "owner");
      expect(snapshot.bookmarks).toEqual([a.id]);
      expect(snapshot.posts.map((row) => row.id)).toContain(b.id);
    } finally {
      t.close();
    }
  });

  test("replies can be bookmarked and show up in the list", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const root = post(t, "owner", "root").posts[0]!;
      const reply = t.store.commitOps({
        author: "manager",
        batchId: "reply-1",
        ops: [{ op: "reply", parent: root.id, body: "reply body" }],
      }).posts[0]!;
      expect(t.store.bookmark("owner", reply.id).created).toBe(true);
      const page = t.store.bookmarks({ viewer: OWNER });
      expect(page.posts.map((p) => p.id)).toEqual([reply.id]);
    } finally {
      t.close();
    }
  });
});

describe("bookmarks (HTTP + CLI)", () => {
  let ws: TestWorkspace;
  let server: RunningTestServer;

  beforeAll(async () => {
    ws = initWorkspace({ open: true });
    server = await startTestServer({ workspace: ws });
  });

  afterAll(async () => {
    await server.stop();
    ws.cleanup();
  });

  const call = (path: string, init: RequestInit = {}, as = "owner") =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "x-report-account": as, ...(init.headers ?? {}) },
    });

  test("PUT /api/bookmarks/:id → ids → list → DELETE", async () => {
    const created = await call("/api/posts", {
      method: "POST",
      body: JSON.stringify({ body: "http bookmark" }),
    });
    expect(created.status).toBe(201);
    const postId = ((await created.json()) as { posts: Array<{ id: string }> }).posts[0]!.id;

    const put = await call(`/api/bookmarks/${postId}`, { method: "PUT" });
    expect(put.status).toBe(201);
    expect(((await put.json()) as { bookmarked: boolean }).bookmarked).toBe(true);

    const ids = (await (await call("/api/bookmarks/ids")).json()) as { ids: string[] };
    expect(ids.ids).toContain(postId);

    const list = (await (await call("/api/bookmarks?limit=10")).json()) as {
      posts: Array<{ id: string }>;
    };
    expect(list.posts.map((p) => p.id)).toContain(postId);

    const del = await call(`/api/bookmarks/${postId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = (await (await call("/api/bookmarks/ids")).json()) as { ids: string[] };
    expect(after.ids).not.toContain(postId);
  });

  test("bookmarking an unknown post is a 404", async () => {
    const res = await call("/api/bookmarks/01ZZZZZZZZZZZZZZZZZZZZZZZZ", { method: "PUT" });
    expect(res.status).toBe(404);
  });

  test("CLI bookmark / bookmarks / --remove", async () => {
    const base = ["--data-dir", ws.dataDir, "--env-files", ws.envFiles.join(",")];
    const made = await runCli(["post", "cli bookmark target", ...base, "--as", "manager"]);
    expect(made.code).toBe(0);
    const postId = (JSON.parse(made.stdout.trim()) as { posts: Array<{ id: string }> }).posts[0]!.id;

    const add = await runCli(["bookmark", postId, ...base, "--as", "manager"]);
    expect(add.code).toBe(0);
    expect((JSON.parse(add.stdout.trim()) as { bookmarked: boolean }).bookmarked).toBe(true);

    const list = await runCli(["bookmarks", ...base, "--as", "manager"]);
    expect(list.code).toBe(0);
    const parsed = JSON.parse(list.stdout.trim()) as { posts: Array<{ id: string }> };
    expect(parsed.posts.map((p) => p.id)).toContain(postId);

    const remove = await runCli(["bookmark", postId, "--remove", ...base, "--as", "manager"]);
    expect(remove.code).toBe(0);
    expect((JSON.parse(remove.stdout.trim()) as { bookmarked: boolean }).bookmarked).toBe(false);
    const empty = await runCli(["bookmarks", ...base, "--as", "manager"]);
    expect((JSON.parse(empty.stdout.trim()) as { posts: unknown[] }).posts).toHaveLength(0);
  });
});

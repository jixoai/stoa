import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { migrate, openDatabase } from "../src/server/db.ts";
import { buildSnapshot } from "../src/server/export.ts";
import { Store } from "../src/server/store.ts";
import { makeStore, tempDir } from "./helpers.ts";

const T0 = 1_700_000_000_000;
const OWNER = { id: "owner", role: "owner" as const };

function post(
  t: ReturnType<typeof makeStore>,
  author: string,
  body: string,
  batchId: string,
) {
  return t.store.commitOps({ author, batchId, ops: [{ op: "post", body }] }).posts[0]!;
}

function countQueries<T>(db: Database, needle: string, fn: () => T): { value: T; count: number } {
  let count = 0;
  const original = db.query.bind(db);
  (db as unknown as { query: typeof db.query }).query = ((sql: string) => {
    if (sql.includes(needle)) count += 1;
    return original(sql);
  }) as typeof db.query;
  try {
    return { value: fn(), count };
  } finally {
    delete (db as unknown as { query?: typeof db.query }).query;
  }
}

function bulkPosts(t: ReturnType<typeof makeStore>, count: number, batchId: string) {
  const created = [];
  for (let start = 0; start < count; start += 500) {
    const ops = Array.from({ length: Math.min(500, count - start) }, (_, offset) => ({
      op: "post" as const,
      body: `bulk ${start + offset}`,
    }));
    created.push(
      ...t.store.commitOps({ author: "owner", batchId: `${batchId}-${start}`, ops }).posts,
    );
  }
  return created;
}

describe("PostView.read hydration", () => {
  test("a 20-post timeline page adds exactly one post_reads query", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const created = bulkPosts(t, 25, "H20");
      // newest 20 make the page (created_at DESC, id DESC); mark the two newest.
      t.store.markPostRead("owner", created[24]!.id);
      t.store.markPostRead("owner", created[23]!.id);
      // warm the sqlite_master probe before counting.
      expect(t.store.readTablesAvailable()).toBe(true);

      const measured = countQueries(t.db, "post_reads", () =>
        t.store.timeline({ viewer: OWNER, limit: 20 }),
      );
      const page = measured.value;
      expect(measured.count).toBe(1);
      expect(page.posts).toHaveLength(20);
      for (const row of page.posts) {
        expect(typeof row.read).toBe("boolean");
        expect(row.read_at === null || typeof row.read_at === "number").toBe(true);
      }
      const byId = new Map(page.posts.map((row) => [row.id, row]));
      expect(byId.get(created[24]!.id)!.read).toBe(true);
      expect(byId.get(created[24]!.id)!.read_at).toBe(T0);
      expect(byId.get(created[23]!.id)!.read).toBe(true);
      expect(byId.get(created[22]!.id)!.read).toBe(false);
      expect(byId.get(created[22]!.id)!.read_at).toBeNull();
    } finally {
      t.close();
    }
  });

  test("a 1000-post export scan adds at most three post_reads queries", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const created = bulkPosts(t, 1000, "H1000");
      expect(created).toHaveLength(1000);
      t.store.markPostRead("owner", created[500]!.id);
      expect(t.store.readTablesAvailable()).toBe(true);

      const measured = countQueries(t.db, "post_reads", () =>
        t.store.visiblePostsForExport(OWNER),
      );
      expect(measured.count).toBeLessThanOrEqual(3); // ceil(1000 / 400)
      expect(measured.value).toHaveLength(1000);
      const target = measured.value.find((row) => row.id === created[500]!.id)!;
      expect(target.read).toBe(true);
      expect(target.read_at).toBe(T0);
      expect(
        measured.value.filter((row) => row.read === true),
      ).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  test("cursor-covered posts are read with read_at=null; per-post rows carry read_at", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const first = post(t, "owner", "older", "C1");
      const second = post(t, "owner", "newer", "C2");
      t.store.advanceCursor("owner", first.seq);

      const covered = t.store.getPostView(first.id, OWNER)!;
      expect(covered.read).toBe(true);
      expect(covered.read_at).toBeNull();
      const uncovered = t.store.getPostView(second.id, OWNER)!;
      expect(uncovered.read).toBe(false);
      expect(uncovered.read_at).toBeNull();

      const written = t.store.markPostRead("owner", second.id);
      const explicit = t.store.getPostView(second.id, OWNER)!;
      expect(explicit.read).toBe(true);
      expect(explicit.read_at).toBe(written.read_at);
      // cursor is untouched by per-post reads
      expect(t.store.getCursor("owner")).toBe(first.seq);
    } finally {
      t.close();
    }
  });

  test("soft-deleted posts keep read fields without disturbing other projections", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const root = post(t, "owner", "will be deleted", "SD");
      t.store.markPostRead("owner", root.id);
      t.store.softDelete(root.id, OWNER);
      const view = t.store.getPostView(root.id, OWNER)!;
      expect(view.deleted_at).not.toBeNull();
      expect(view.body_md).toBe("");
      expect(view.media).toEqual([]);
      expect(view.previews).toEqual([]);
      expect(view.quoted).toBeNull();
      expect(view.read).toBe(true);
      expect(view.read_at).toBe(T0);
    } finally {
      t.close();
    }
  });

  test("ThreadNode inherits read/read_at consistently with getPostView", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const root = post(t, "owner", "root", "TH1");
      const reply = t.store.commitOps({
        author: "manager",
        batchId: "TH2",
        ops: [{ op: "reply", parent: root.id, body: "reply" }],
      }).posts[0]!;
      t.store.markPostRead("owner", root.id);

      const thread = t.store.thread({ viewer: OWNER, postId: root.id })!;
      expect(thread.posts.length).toBeGreaterThanOrEqual(2);
      for (const node of thread.posts) {
        const single = t.store.getPostView(node.id, OWNER)!;
        expect(node.read).toBe(single.read);
        expect(node.read_at).toBe(single.read_at);
      }
      const rootNode = thread.posts.find((node) => node.id === root.id)!;
      const replyNode = thread.posts.find((node) => node.id === reply.id)!;
      expect(rootNode.read).toBe(true);
      expect(rootNode.read_at).toBe(T0);
      // the reply is newer than the cursor and has no read row yet.
      expect(replyNode.read).toBe(false);
      expect(replyNode.read_at).toBeNull();
    } finally {
      t.close();
    }
  });

  test("read-only v5 database: every PostView is read=false without throwing", () => {
    const dir = tempDir();
    try {
      const db = openDatabase({ dataDir: dir });
      migrate(db);
      const store = new Store({ dataDir: dir, db, clock: () => T0 });
      store.ensureInitAccount({ id: "owner", role: "owner", display: "owner" });
      store.ensureInitAccount({ id: "manager", role: "manager", display: "manager" });
      const root = store.commitOps({
        author: "owner",
        batchId: "RO2",
        ops: [{ op: "post", body: "legacy" }],
      }).posts[0]!;
      db.exec("DROP TABLE post_reads");
      db.close();

      const ro = openDatabase({ dataDir: dir, readonly: true });
      try {
        const roStore = new Store({ dataDir: dir, db: ro, clock: () => T0 });
        expect(roStore.readTablesAvailable()).toBe(false);
        expect(roStore.getPostView(root.id, OWNER)!.read).toBe(false);
        const timeline = roStore.timeline({ viewer: OWNER, limit: 10 });
        expect(timeline.posts.length).toBeGreaterThan(0);
        expect(timeline.posts.every((row) => row.read === false && row.read_at === null)).toBe(
          true,
        );
        expect(roStore.thread({ viewer: OWNER, postId: root.id })!.posts[0]!.read).toBe(false);
      } finally {
        ro.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("export snapshot carries read/read_at through SnapshotPost", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const root = post(t, "owner", "snapshot", "EX1");
      t.store.markPostRead("owner", root.id);
      const snapshot = buildSnapshot(t.store, "owner");
      const row = snapshot.posts.find((entry) => entry.id === root.id)!;
      expect(row.read).toBe(true);
      expect(row.read_at).toBe(T0);
      expect(snapshot.version).toBe(1);
    } finally {
      t.close();
    }
  });

  test("EXPLAIN QUERY PLAN: post_reads lookup uses the (account_id, post_id) primary-key index", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const plan = t.db
        .query(
          "EXPLAIN QUERY PLAN SELECT read_at FROM post_reads WHERE account_id = ? AND post_id IN (?, ?)",
        )
        .all("owner", "a", "b") as Array<{ detail: string }>;
      const text = plan.map((row) => row.detail).join("\n");
      expect(text).toContain("post_reads");
      // SQLite names the composite primary key's index `sqlite_autoindex_post_reads_1`
      // for rowid tables; the columns prove the PK index is used.
      expect(text).toContain("account_id=? AND post_id=?");
    } finally {
      t.close();
    }
  });
});

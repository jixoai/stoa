import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { migrate, openDatabase, SCHEMA_VERSION } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { createAgents, makeStore, tempDir } from "./helpers.ts";

const T0 = 1_700_000_000_000;

function tableExists(db: ReturnType<typeof openDatabase>, name: string): boolean {
  return (
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== null
  );
}

function indexExists(db: ReturnType<typeof openDatabase>, name: string): boolean {
  return (
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name) !== null
  );
}

function metaVersion(db: ReturnType<typeof openDatabase>): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string;
  } | null;
  return row?.value ?? null;
}

function post(
  t: ReturnType<typeof makeStore>,
  author: string,
  body: string,
  batchId: string,
) {
  return t.store.commitOps({ author, batchId, ops: [{ op: "post", body }] }).posts[0]!;
}

describe("post_reads schema v6", () => {
  test("fresh migrate creates post_reads + idx_post_reads_post and meta schema_version 6", () => {
    const dir = tempDir();
    try {
      const db = openDatabase({ dataDir: dir });
      try {
        migrate(db);
        expect(SCHEMA_VERSION).toBe(6);
        expect(tableExists(db, "post_reads")).toBe(true);
        expect(indexExists(db, "idx_post_reads_post")).toBe(true);
        expect(metaVersion(db)).toBe("6");
        const columns = db.query("PRAGMA table_info(post_reads)").all() as Array<{
          name: string;
          notnull: number;
          pk: number;
        }>;
        expect(columns.map((column) => column.name)).toEqual(["account_id", "post_id", "read_at"]);
        expect(columns.find((column) => column.name === "account_id")!.pk).toBe(1);
        expect(columns.find((column) => column.name === "post_id")!.pk).toBe(2);
        expect(columns.find((column) => column.name === "read_at")!.notnull).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-running migrate is idempotent and keeps existing posts/read rows", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a"]);
      const root = post(t, "a", "kept", "M1");
      const read = t.store.markPostRead("a", root.id);
      const postCount = (t.db.query("SELECT COUNT(*) AS c FROM posts").get() as { c: number }).c;
      const readCount = (
        t.db.query("SELECT COUNT(*) AS c FROM post_reads").get() as { c: number }
      ).c;

      expect(() => migrate(t.db)).not.toThrow();
      expect(() => migrate(t.db)).not.toThrow();

      expect(metaVersion(t.db)).toBe("6");
      expect((t.db.query("SELECT COUNT(*) AS c FROM posts").get() as { c: number }).c).toBe(
        postCount,
      );
      expect((t.db.query("SELECT COUNT(*) AS c FROM post_reads").get() as { c: number }).c).toBe(
        readCount,
      );
      const row = t.db
        .query("SELECT read_at FROM post_reads WHERE account_id = 'a' AND post_id = ?")
        .get(root.id) as { read_at: number };
      expect(row.read_at).toBe(read.read_at);
    } finally {
      t.close();
    }
  });

  test("a v5 database gains post_reads on migrate; existing rows are untouched", () => {
    const dir = tempDir();
    try {
      const db = openDatabase({ dataDir: dir });
      migrate(db);
      const store = new Store({ dataDir: dir, db, clock: () => T0 });
      store.ensureInitAccount({ id: "owner", role: "owner", display: "owner" });
      store.ensureInitAccount({ id: "manager", role: "manager", display: "manager" });
      const created = store.commitOps({
        author: "owner",
        batchId: "V5",
        ops: [{ op: "post", body: "legacy row" }],
      }).posts[0]!;
      // 模拟 v5 库：没有 post_reads 表，meta 停在 5。
      db.exec("DROP TABLE post_reads");
      db.query("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
      expect(tableExists(db, "post_reads")).toBe(false);

      migrate(db);

      expect(tableExists(db, "post_reads")).toBe(true);
      expect(indexExists(db, "idx_post_reads_post")).toBe(true);
      expect(metaVersion(db)).toBe("6");
      const posts = db.query("SELECT id, body_md, seq FROM posts").all() as Array<{
        id: string;
        body_md: string;
        seq: number;
      }>;
      expect(posts).toEqual([{ id: created.id, body_md: "legacy row", seq: created.seq }]);
      expect(
        (db.query("SELECT COUNT(*) AS c FROM post_reads").get() as { c: number }).c,
      ).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read-only v5 database degrades to read=false and cursor-only unread", () => {
    const dir = tempDir();
    try {
      const db = openDatabase({ dataDir: dir });
      migrate(db);
      const store = new Store({ dataDir: dir, db, clock: () => T0 });
      store.ensureInitAccount({ id: "owner", role: "owner", display: "owner" });
      store.ensureInitAccount({ id: "manager", role: "manager", display: "manager" });
      createAgents(store, ["a", "b"]);
      const root = store.commitOps({
        author: "a",
        batchId: "RO1",
        ops: [{ op: "post", body: "for b @b" }],
      }).posts[0]!;
      const unreadBefore = store.unreadCount("b");
      expect(unreadBefore).toBe(2);
      // 旧库没有 post_reads（export 不跑 migrate）。
      db.exec("DROP TABLE post_reads");
      db.query("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
      db.close();

      const ro = openDatabase({ dataDir: dir, readonly: true });
      try {
        const roStore = new Store({ dataDir: dir, db: ro, clock: () => T0 });
        expect(roStore.readTablesAvailable()).toBe(false);
        const view = roStore.getPostView(root.id, { id: "b", role: "agent" });
        expect(view).not.toBeNull();
        expect(view!.read).toBe(false);
        expect(view!.read_at).toBeNull();
        expect(roStore.unreadCount("b")).toBe(unreadBefore);
        const timeline = roStore.timeline({ viewer: { id: "b", role: "agent" }, limit: 10 });
        expect(timeline.posts.every((row) => row.read === false && row.read_at === null)).toBe(
          true,
        );
      } finally {
        ro.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removeAccount clears only that account's post_reads rows", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      // a and b are both participants of the same private thread.
      const one = post(t, "a", "one @b", "D1");
      const two = post(t, "a", "two @b", "D2");
      t.store.markPostRead("a", one.id);
      t.store.markPostRead("b", one.id);
      t.store.markPostRead("b", two.id);

      t.store.removeAccount("a");

      const aRows = t.db
        .query("SELECT COUNT(*) AS c FROM post_reads WHERE account_id = 'a'")
        .get() as { c: number };
      const bRows = t.db
        .query("SELECT COUNT(*) AS c FROM post_reads WHERE account_id = 'b'")
        .get() as { c: number };
      expect(aRows.c).toBe(0);
      expect(bRows.c).toBe(2);
      // tombstone keeps no cursor either (same transaction path, regression).
      expect(t.store.getCursor("a")).toBe(0);
    } finally {
      t.close();
    }
  });
});

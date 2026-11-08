import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ReportError } from "../src/core/errors.ts";
import { createAgents, makeStore } from "./helpers.ts";

const T0 = 1_700_000_000_000;

function post(
  t: ReturnType<typeof makeStore>,
  author: string,
  body: string,
  batchId: string,
) {
  return t.store.commitOps({ author, batchId, ops: [{ op: "post", body }] }).posts[0]!;
}

function errorCode(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    return (err as ReportError).code ?? null;
  }
  return null;
}

/** Count executed SQL statements containing `needle` while `fn` runs. */
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

function readRowCount(t: ReturnType<typeof makeStore>, accountId: string, postId?: string): number {
  const row = postId
    ? (t.db
        .query("SELECT COUNT(*) AS c FROM post_reads WHERE account_id = ? AND post_id = ?")
        .get(accountId, postId) as { c: number })
    : (t.db
        .query("SELECT COUNT(*) AS c FROM post_reads WHERE account_id = ?")
        .get(accountId) as { c: number });
  return row.c;
}

describe("post_reads store", () => {
  test("single write is idempotent and keeps the first read_at", () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      const root = post(t, "owner", "read me", "S1");
      const first = t.store.markPostRead("owner", root.id);
      expect(first.created).toBe(true);
      expect(first.read_at).toBe(T0);
      now += 5_000;
      const second = t.store.markPostRead("owner", root.id);
      expect(second.created).toBe(false);
      expect(second.read_at).toBe(first.read_at);
      expect(readRowCount(t, "owner", root.id)).toBe(1);
    } finally {
      t.close();
    }
  });

  test("unknown posts and invisible roots both fail with NOT_FOUND", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const root = post(t, "a", "a-only", "V1");
      expect(errorCode(() => t.store.markPostRead("owner", "does-not-exist"))).toBe("NOT_FOUND");
      expect(errorCode(() => t.store.markPostRead("b", root.id))).toBe("NOT_FOUND");
      expect(errorCode(() => t.store.markPostRead("b", "does-not-exist"))).toBe("NOT_FOUND");
      // the participant and global roles can write.
      expect(t.store.markPostRead("a", root.id).created).toBe(true);
      expect(t.store.markPostRead("owner", root.id).created).toBe(true);
      expect(readRowCount(t, "b")).toBe(0);
    } finally {
      t.close();
    }
  });

  test("soft-deleted posts accept read writes (no unread/highlight effect)", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const root = post(t, "a", "for b @b", "SD1");
      expect(t.store.unreadCount("b")).toBe(2);
      t.store.softDelete(root.id, { id: "a", role: "agent" });
      expect(t.store.unreadCount("b")).toBe(0);
      const written = t.store.markPostRead("b", root.id);
      expect(written.created).toBe(true);
      expect(readRowCount(t, "b", root.id)).toBe(1);
      const view = t.store.getPostView(root.id, { id: "b", role: "agent" });
      expect(view).not.toBeNull();
      expect(view!.deleted_at).not.toBeNull();
      expect(view!.read).toBe(true);
      // unread stays zero; the read row never revives a deleted target.
      expect(t.store.unreadCount("b")).toBe(0);
      expect(t.store.unreadByTarget("b")).toEqual({});
    } finally {
      t.close();
    }
  });

  test("batch reports stored/skipped, dedupes and is idempotent", () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      createAgents(t.store, ["a", "b"]);
      const visible = [
        post(t, "a", "v1", "B1"),
        post(t, "a", "v2", "B2"),
        post(t, "a", "v3 @b", "B3"),
      ];
      const invisible = post(t, "b", "b-only", "B4");
      const ids = [
        ...visible.map((row) => row.id),
        invisible.id, // b posts it, a cannot see it
        "missing-1",
        "missing-2",
      ];
      const first = t.store.markPostReads("a", [...ids, visible[0]!.id]);
      expect(first.stored).toBe(3);
      expect(first.skipped.sort()).toEqual([invisible.id, "missing-1", "missing-2"].sort());
      // stored + skipped === unique input count
      expect(first.stored + first.skipped.length).toBe(new Set(ids).size);
      expect(readRowCount(t, "a")).toBe(3);

      now += 10_000;
      const second = t.store.markPostReads("a", ids);
      expect(second.stored).toBe(3);
      expect(second.read_at).toBe(first.read_at + 10_000);
      expect(readRowCount(t, "a")).toBe(3);
      const stored = t.store.readStatesFor("a", visible.map((row) => row.id));
      expect([...stored.values()]).toEqual([first.read_at, first.read_at, first.read_at]);
      expect([...stored.keys()].sort()).toEqual(visible.map((row) => row.id).sort());
    } finally {
      t.close();
    }
  });

  test("readStatesFor groups ids by 400 and never leaks other accounts' rows", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const ops = Array.from({ length: 401 }, (_, index) => ({
        op: "post" as const,
        body: `bulk ${index}`,
      }));
      const created = t.store.commitOps({ author: "owner", batchId: "BULK", ops }).posts;
      expect(created).toHaveLength(401);
      t.store.markPostReads("owner", created.map((row) => row.id));

      // warm the table probe so the count only sees read-row queries.
      expect(t.store.readTablesAvailable()).toBe(true);
      const ids = created.map((row) => row.id);
      const measured = countQueries(t.db, "post_reads", () => t.store.readStatesFor("owner", ids));
      expect(measured.count).toBe(2); // 400 + 1
      expect(measured.value.size).toBe(401);

      const managerRows = t.store.readStatesFor("manager", ids);
      expect(managerRows.size).toBe(0);
      expect(readRowCount(t, "manager")).toBe(0);
    } finally {
      t.close();
    }
  });

  test("concurrent same-post writes converge to one row with one read_at", async () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const root = post(t, "owner", "race", "A11");
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          Promise.resolve().then(() => t.store.markPostRead("owner", root.id)),
        ),
      );
      expect(results).toHaveLength(20);
      expect(results.filter((row) => row.created)).toHaveLength(1);
      expect(new Set(results.map((row) => row.read_at)).size).toBe(1);
      expect(readRowCount(t, "owner", root.id)).toBe(1);
      expect(readRowCount(t, "owner")).toBe(1);
    } finally {
      t.close();
    }
  });
});

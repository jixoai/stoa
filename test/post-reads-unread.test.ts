import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createAgents, makeStore } from "./helpers.ts";

const T0 = 1_700_000_000_000;

/** a posts a root that mentions b: exactly 2 notification events for b. */
function notifyB(t: ReturnType<typeof makeStore>, batchId: string, body = "hello @b") {
  return t.store.commitOps({
    author: "a",
    batchId,
    ops: [{ op: "post", body }],
  }).posts[0]!;
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

describe("unread computed from post_reads", () => {
  test("without read rows the legacy cursor values are unchanged", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const one = notifyB(t, "U1");
      const two = notifyB(t, "U2");
      expect(t.store.unreadCount("b")).toBe(4);
      expect(t.store.unreadByTarget("b")).toEqual({ [one.id]: 2, [two.id]: 2 });
      const history = t.store.notificationHistory("b", { limit: 100 });
      expect(history.cursor).toBe(0);
      expect(history.events).toHaveLength(4);
      expect(history.events.every((event) => event.read === false)).toBe(true);
    } finally {
      t.close();
    }
  });

  test("reading one target removes it and subtracts its event count", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const one = notifyB(t, "R1");
      const two = notifyB(t, "R2");
      expect(t.store.unreadCount("b")).toBe(4);
      expect(Object.keys(t.store.unreadByTarget("b"))).toHaveLength(2);

      t.store.markPostRead("b", one.id);

      expect(t.store.unreadCount("b")).toBe(2);
      expect(t.store.unreadByTarget("b")).toEqual({ [two.id]: 2 });
      expect(Object.keys(t.store.unreadByTarget("b"))).toHaveLength(1);
      // per-post reads never advance the account cursor.
      expect(t.store.getCursor("b")).toBe(0);
    } finally {
      t.close();
    }
  });

  test("same post with two events: events -2 but target -1", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const root = notifyB(t, "M1");
      expect(t.store.unreadCount("b")).toBe(2);
      expect(t.store.unreadByTarget("b")).toEqual({ [root.id]: 2 });

      t.store.markPostRead("b", root.id);

      expect(t.store.unreadCount("b")).toBe(0);
      expect(t.store.unreadByTarget("b")).toEqual({});
    } finally {
      t.close();
    }
  });

  test("history rows turn read without a cursor advance; cursor coverage still works", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const one = notifyB(t, "H1");
      const two = notifyB(t, "H2");
      t.store.markPostRead("b", one.id);

      const history = t.store.notificationHistory("b", { limit: 100 });
      expect(history.cursor).toBe(0);
      const own = history.events.filter((event) => event.post_id === one.id);
      const other = history.events.filter((event) => event.post_id === two.id);
      expect(own).toHaveLength(2);
      expect(own.every((event) => event.read === true)).toBe(true);
      expect(other.every((event) => event.read === false)).toBe(true);

      // legacy cursor coverage still marks older events read.
      const oldest = history.events[history.events.length - 1]!;
      t.store.advanceCursor("b", oldest.seq);
      const after = t.store.notificationHistory("b", { limit: 100 });
      for (const event of after.events) {
        expect(event.read).toBe(event.seq <= oldest.seq || event.post_id === one.id);
      }
    } finally {
      t.close();
    }
  });

  test("a history page adds exactly one post_reads query", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const ops = Array.from({ length: 120 }, (_, index) => ({
        op: "post" as const,
        body: `bulk ${index} @b`,
      }));
      t.store.commitOps({ author: "a", batchId: "HIST", ops });
      expect(t.store.readTablesAvailable()).toBe(true);
      // warm the probe + first read path.
      t.store.notificationHistory("b", { limit: 5 });

      const measured = countQueries(t.db, "post_reads", () =>
        t.store.notificationHistory("b", { limit: 100 }),
      );
      expect(measured.value.events).toHaveLength(100);
      expect(measured.count).toBe(1); // one page-wide batch, never per row
    } finally {
      t.close();
    }
  });

  test("soft-deleted targets never count unread, even with a read row", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const root = notifyB(t, "SD1");
      t.store.markPostRead("b", root.id);
      t.store.softDelete(root.id, { id: "a", role: "agent" });
      expect(t.store.unreadCount("b")).toBe(0);
      expect(t.store.unreadByTarget("b")).toEqual({});
      const history = t.store.notificationHistory("b", { limit: 100 });
      // history rows are kept and stay read (soft delete never revives them).
      expect(history.events.length).toBeGreaterThan(0);
      expect(history.events.every((event) => event.read === true)).toBe(true);
    } finally {
      t.close();
    }
  });

  test("events without post_id degrade to cursor-only (no root_id deduction)", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const root = notifyB(t, "N1");
      t.db
        .query(
          `INSERT INTO events(type, actor, post_id, root_id, batch_id, created_at, payload_json)
           VALUES ('post.created', 'a', NULL, ?, 'N2', ?, '{}')`,
        )
        .run(root.id, T0);
      expect(t.store.unreadByTarget("b")).toEqual({ [root.id]: 3 });

      t.store.markPostRead("b", root.id);
      // only the two post-bound events were deducted; the null-post_id event stays.
      expect(t.store.unreadCount("b")).toBe(1);
      expect(t.store.unreadByTarget("b")).toEqual({ [root.id]: 1 });
      const history = t.store.notificationHistory("b", { limit: 100 });
      const nullRow = history.events.find((event) => event.post_id === null)!;
      expect(nullRow.read).toBe(false);
    } finally {
      t.close();
    }
  });

  test("read state is account-private: A reading never changes B", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const root = notifyB(t, "P1");
      expect(t.store.unreadCount("b")).toBe(2);
      // a is a participant (author) and may read its own post.
      t.store.markPostRead("a", root.id);
      expect(t.store.unreadCount("b")).toBe(2);
      expect(t.store.getPostView(root.id, { id: "b", role: "agent" })!.read).toBe(false);
      expect(t.store.getPostView(root.id, { id: "a", role: "agent" })!.read).toBe(true);
      expect(t.store.readStatesFor("b", [root.id]).size).toBe(0);
    } finally {
      t.close();
    }
  });
});

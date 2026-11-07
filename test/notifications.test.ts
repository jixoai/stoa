import { describe, expect, test } from "bun:test";
import { makeStore, createAgents } from "./helpers.ts";
import { NOTIFICATION_TYPES } from "../src/core/types.ts";
import type { NotificationEventLine, ThreadSnapshotLine } from "../src/core/types.ts";

const T0 = 1_700_000_000_000;

function eventLines(lines: Array<NotificationEventLine | ThreadSnapshotLine>): NotificationEventLine[] {
  return lines.filter((line): line is NotificationEventLine => !("type" in line && line.type === "thread.snapshot"));
}

describe("wait-notifications delivery (design §7, P1.6)", () => {
  test("invited account gets the event plus an inline thread snapshot", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const root = t.store.commitOps({
        author: "a",
        batchId: "N1",
        ops: [{ op: "post", body: "county report @b" }],
      }).posts[0]!;
      const first = t.store.notificationLines("b");
      const events = eventLines(first.lines);
      expect(events.map((e) => e.type)).toEqual(["post.created", "thread.invited"]);
      const snapshot = first.lines.find(
        (line): line is ThreadSnapshotLine => "type" in line && line.type === "thread.snapshot",
      )!;
      expect(snapshot).toBeDefined();
      expect(snapshot.root_id).toBe(root.id);
      expect(snapshot.thread.posts.map((p) => p.id)).toEqual([root.id]);
      expect(first.target).toBe(events[1]!.seq);
      expect(first.cursor).toBe(0);

      t.store.advanceCursor("b", first.target!);
      expect(t.store.notificationLines("b").lines).toHaveLength(0);
      expect(t.store.getCursor("b")).toBe(first.target!);
    } finally {
      t.close();
    }
  });

  test("without ack the same events are redelivered (repeatable, never lost)", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      t.store.commitOps({ author: "a", batchId: "N2", ops: [{ op: "post", body: "hi @b" }] });
      const one = t.store.notificationLines("b");
      const two = t.store.notificationLines("b");
      expect(eventLines(two.lines).map((e) => e.seq)).toEqual(eventLines(one.lines).map((e) => e.seq));
      expect(t.store.getCursor("b")).toBe(0);
    } finally {
      t.close();
    }
  });

  test("cursor advance is monotonic even for concurrent/stale acks", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a"]);
      expect(t.store.advanceCursor("a", 10)).toBe(10);
      expect(t.store.advanceCursor("a", 3)).toBe(10);
      expect(t.store.getCursor("a")).toBe(10);
    } finally {
      t.close();
    }
  });

  test("authors do not receive their own events", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a"]);
      t.store.commitOps({ author: "a", batchId: "N3", ops: [{ op: "post", body: "self" }] });
      expect(t.store.notificationLines("a").lines).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  test("unrelated accounts receive nothing", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b", "c"]);
      t.store.commitOps({ author: "a", batchId: "N4", ops: [{ op: "post", body: "private" }] });
      expect(t.store.notificationLines("b").lines).toHaveLength(0);
      expect(t.store.notificationLines("c").lines).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  test("a batch is delivered whole, in seq order, up to one target", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const root = t.store.commitOps({
        author: "a",
        batchId: "N5",
        ops: [{ op: "post", body: "root" }],
      }).posts[0]!;
      t.store.advanceCursor("b", t.store.maxEventSeq());
      const committed = t.store.commitOps({
        author: "a",
        batchId: "N6",
        ops: [
          { op: "reply", parent: root.id, body: "r1 @b" },
          { op: "reply", parent: root.id, body: "r2" },
          { op: "reply", parent: root.id, body: "r3" },
        ],
      });
      expect(committed.posts).toHaveLength(3);
      const delivered = t.store.notificationLines("b");
      const events = eventLines(delivered.lines);
      expect(events).toHaveLength(4); // 3 post.created + 1 thread.invited
      expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((x, y) => x - y));
      expect(delivered.target).toBe(t.store.maxEventSeq());
      t.store.advanceCursor("b", delivered.target!);
      expect(t.store.notificationLines("b").lines).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  test("manager sees owner's un-@'d reply in an offline thread", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a"]);
      const root = t.store.commitOps({
        author: "a",
        batchId: "N7",
        ops: [{ op: "post", body: "agent thread" }],
      }).posts[0]!;
      t.store.commitOps({
        author: "owner",
        batchId: "N8",
        ops: [{ op: "reply", parent: root.id, body: "owner comments" }],
      });
      const managerLines = t.store.notificationLines("manager");
      expect(eventLines(managerLines.lines).some((e) => e.actor === "owner")).toBe(true);
      // a (offline agent) also sees the owner reply because it participates in the thread
      const aLines = t.store.notificationLines("a");
      expect(eventLines(aLines.lines).some((e) => e.actor === "owner")).toBe(true);
    } finally {
      t.close();
    }
  });

  test("cursor override replays history without changing the stored cursor", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      t.store.commitOps({ author: "a", batchId: "N9", ops: [{ op: "post", body: "hi @b" }] });
      const delivered = t.store.notificationLines("b");
      t.store.advanceCursor("b", delivered.target!);
      expect(t.store.notificationLines("b").lines).toHaveLength(0);
      const replay = t.store.notificationLines("b", 0);
      expect(eventLines(replay.lines).length).toBeGreaterThan(0);
      expect(t.store.getCursor("b")).toBe(delivered.target!);
    } finally {
      t.close();
    }
  });
});

describe("notification history (always-visible list)", () => {
  test("read flag follows the account cursor and never mutates it", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      t.store.commitOps({ author: "a", batchId: "H1", ops: [{ op: "post", body: "one @b" }] });
      t.store.commitOps({ author: "a", batchId: "H2", ops: [{ op: "post", body: "two @b" }] });
      const all = t.store.notificationHistory("b", { limit: 100 });
      expect(all.events.length).toBe(4);
      expect(all.cursor).toBe(0);
      expect(all.events.every((event) => event.read === false)).toBe(true);
      // 推进到中间水位：≤ 水位已读、> 水位未读
      const cursor = all.events[1]!.seq;
      t.store.advanceCursor("b", cursor);
      const after = t.store.notificationHistory("b", { limit: 100 });
      expect(after.cursor).toBe(cursor);
      for (const event of after.events) {
        expect(event.read).toBe(event.seq <= cursor);
      }
      expect(t.store.getCursor("b")).toBe(cursor);
    } finally {
      t.close();
    }
  });

  test("before pagination never repeats or skips events", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      for (let index = 0; index < 5; index += 1) {
        t.store.commitOps({
          author: "a",
          batchId: `HP${index}`,
          ops: [{ op: "post", body: `page ${index} @b` }],
        });
      }
      const all = t.store.notificationHistory("b", { limit: 100 });
      expect(all.events.length).toBe(10);
      const seen: number[] = [];
      let before: number | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = t.store.notificationHistory("b", { limit: 3, before });
        seen.push(...page.events.map((event) => event.seq));
        if (!page.has_more) {
          expect(page.next_before).toBeNull();
          break;
        }
        expect(page.next_before).toBe(page.events[page.events.length - 1]!.seq);
        before = page.next_before;
      }
      expect(seen).toHaveLength(all.events.length);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual([...seen].sort((x, y) => y - x));
      expect(seen).toEqual(all.events.map((event) => event.seq));
    } finally {
      t.close();
    }
  });

  test("visibility: non-participants never see private-thread events", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b", "c"]);
      const onlyB = t.store.commitOps({
        author: "a",
        batchId: "V1",
        ops: [{ op: "post", body: "for b only @b" }],
      }).posts[0]!;
      const forC = t.store.commitOps({
        author: "a",
        batchId: "V2",
        ops: [{ op: "post", body: "for c @c" }],
      }).posts[0]!;
      const bHistory = t.store.notificationHistory("b", { limit: 100 });
      expect(bHistory.events.length).toBeGreaterThan(0);
      expect(bHistory.events.every((event) => event.root_id === onlyB.id)).toBe(true);
      const cHistory = t.store.notificationHistory("c", { limit: 100 });
      expect(cHistory.events.every((event) => event.root_id === forC.id)).toBe(true);
      expect(cHistory.events.some((event) => event.root_id === onlyB.id)).toBe(false);
      const ownerRoots = new Set(
        t.store.notificationHistory("owner", { limit: 100 }).events.map((event) => event.root_id),
      );
      expect(ownerRoots.has(onlyB.id)).toBe(true);
      expect(ownerRoots.has(forC.id)).toBe(true);
    } finally {
      t.close();
    }
  });

  test("REST parity: own events are excluded from history", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const root = t.store.commitOps({
        author: "a",
        batchId: "S1",
        ops: [{ op: "post", body: "root @b" }],
      }).posts[0]!;
      t.store.commitOps({
        author: "b",
        batchId: "S2",
        ops: [{ op: "reply", parent: root.id, body: "b replies" }],
      });
      const bHistory = t.store.notificationHistory("b", { limit: 100 });
      expect(bHistory.events.some((event) => event.actor === "b")).toBe(false);
      const ownerHistory = t.store.notificationHistory("owner", { limit: 100 });
      expect(ownerHistory.events.some((event) => event.actor === "b")).toBe(true);
    } finally {
      t.close();
    }
  });

  test("history only returns notification event types", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const root = t.store.commitOps({
        author: "a",
        batchId: "T1",
        ops: [{ op: "post", body: "typed @b" }],
      }).posts[0]!;
      // 模拟 event-hub 铺路时可能出现的非通知事件
      t.db
        .query(
          `INSERT INTO events(type, actor, post_id, root_id, batch_id, created_at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("post.deleted", "a", root.id, root.id, "X1", T0, "{}");
      const history = t.store.notificationHistory("b", { limit: 100 });
      expect(history.events.length).toBeGreaterThan(0);
      expect(history.events.every((event) => NOTIFICATION_TYPES.includes(event.type))).toBe(true);
      expect(history.events.some((event) => (event.type as string) === "post.deleted")).toBe(false);
    } finally {
      t.close();
    }
  });

  test("invalid before is rejected; limit clamps into 1..100", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      t.store.commitOps({ author: "a", batchId: "L1", ops: [{ op: "post", body: "one @b" }] });
      expect(() => t.store.notificationHistory("b", { before: -1 })).toThrow();
      expect(t.store.notificationHistory("b", { limit: 0 }).events).toHaveLength(1);
      expect(t.store.notificationHistory("b", { limit: 1000 }).events.length).toBeLessThanOrEqual(100);
    } finally {
      t.close();
    }
  });
});

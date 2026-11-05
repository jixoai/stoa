import { describe, expect, test } from "bun:test";
import { makeStore, createAgents } from "./helpers.ts";
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

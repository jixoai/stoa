import { describe, expect, test } from "bun:test";
import { encodeCursor } from "../src/core/pagination.ts";
import { ReportError } from "../src/core/errors.ts";
import { makeStore, createAgents } from "./helpers.ts";

const T0 = 1_700_000_000_000;
const VIEWER = { id: "a", role: "agent" as const };

describe("keyset pagination (design §5.2, P1.5)", () => {
  test("head insertion does not duplicate or skip page 2 rows", () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      createAgents(t.store, ["a"]);
      for (let i = 0; i < 5; i++) {
        now += 1000;
        t.store.commitOps({
          author: "a",
          batchId: `P-${i}`,
          ops: [{ op: "post", body: `post ${i}` }],
        });
      }
      const page1 = t.store.timeline({ viewer: VIEWER, limit: 2 });
      expect(page1.posts.map((p) => p.body_md)).toEqual(["post 4", "post 3"]);
      expect(page1.has_more).toBe(true);
      expect(page1.next_cursor).not.toBeNull();

      now += 1000;
      t.store.commitOps({ author: "a", batchId: "P-NEW", ops: [{ op: "post", body: "head insert" }] });

      const page2 = t.store.timeline({
        viewer: VIEWER,
        limit: 2,
        before: page1.next_cursor,
      });
      expect(page2.posts.map((p) => p.body_md)).toEqual(["post 2", "post 1"]);
      const allIds = [...page1.posts, ...page2.posts].map((p) => p.id);
      expect(new Set(allIds).size).toBe(allIds.length);

      const head = t.store.timeline({ viewer: VIEWER, limit: 3 });
      expect(head.posts.map((p) => p.body_md)).toEqual(["head insert", "post 4", "post 3"]);
    } finally {
      t.close();
    }
  });

  test("a same-created_at batch is not split across pages by accident", () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      createAgents(t.store, ["a"]);
      const committed = t.store.commitOps({
        author: "a",
        batchId: "SAME-MS",
        ops: [
          { op: "post", body: "one" },
          { op: "post", body: "two" },
          { op: "post", body: "three" },
        ],
      });
      expect(new Set(committed.posts.map((p) => p.created_at)).size).toBe(1);
      const page1 = t.store.timeline({ viewer: VIEWER, limit: 2 });
      expect(page1.posts).toHaveLength(2);
      expect(page1.has_more).toBe(true);
      const page2 = t.store.timeline({ viewer: VIEWER, limit: 2, before: page1.next_cursor });
      expect(page2.posts).toHaveLength(1);
      expect(page2.has_more).toBe(false);
      const ids = [...page1.posts, ...page2.posts].map((p) => p.id);
      expect(new Set(ids).size).toBe(3);
      expect(ids).toEqual(committed.posts.map((p) => p.id).reverse());
    } finally {
      t.close();
    }
  });

  test("after walks toward newer rows in ascending order", () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      createAgents(t.store, ["a"]);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        now += 1000;
        const res = t.store.commitOps({
          author: "a",
          batchId: `A-${i}`,
          ops: [{ op: "post", body: `p${i}` }],
        });
        ids.push(res.posts[0]!.id);
      }
      const first = t.store.getPostView(ids[0]!, VIEWER)!;
      const after = t.store.timeline({
        viewer: VIEWER,
        limit: 10,
        after: encodeCursor(first.created_at, first.id),
      });
      expect(after.order).toBe("asc");
      expect(after.posts.map((p) => p.id)).toEqual(ids.slice(1));
    } finally {
      t.close();
    }
  });

  test("cursor is opaque, versioned and validated", () => {
    const cursor = encodeCursor(123, "abc");
    expect(cursor).not.toContain("123");
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a"]);
      expect(() => t.store.timeline({ viewer: VIEWER, before: "not-a-cursor" })).toThrow(ReportError);
      const badVersion = Buffer.from(JSON.stringify({ v: 2, ts: 1, id: "x" })).toString("base64url");
      expect(() => t.store.timeline({ viewer: VIEWER, before: badVersion })).toThrow(ReportError);
      expect(() => t.store.timeline({ viewer: VIEWER, before: encodeCursor(1, "a"), after: encodeCursor(2, "b") })).toThrow(
        ReportError,
      );
    } finally {
      t.close();
    }
  });
});

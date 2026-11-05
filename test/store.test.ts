import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { ReportError } from "../src/core/errors.ts";
import { sha256Hex } from "../src/core/auth.ts";
import { makeStore, createAgents } from "./helpers.ts";

const T0 = 1_700_000_000_000;

function count(t: ReturnType<typeof makeStore>, sql: string): number {
  return (t.db.query(sql).get() as { c: number }).c;
}

describe("batch transactions (design §6, P1.6)", () => {
  test("commit is atomic, shares created_at and is idempotent by batch_id", () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      createAgents(t.store, ["a"]);
      const viewer = { id: "a", role: "agent" as const };
      expect(t.store.timeline({ viewer }).posts).toHaveLength(0);

      const result = t.store.commitOps({
        author: "a",
        batchId: "BATCH-1",
        ops: [
          { op: "post", body: "part one" },
          { op: "post", body: "part two" },
        ],
      });
      expect(result.idempotent).toBe(false);
      expect(result.batch_id).toBe("BATCH-1");
      expect(result.posts).toHaveLength(2);
      expect(result.posts[0]!.created_at).toBe(result.posts[1]!.created_at);
      expect(result.posts[0]!.seq).toBeLessThan(result.posts[1]!.seq);
      expect(t.store.timeline({ viewer }).posts).toHaveLength(2);
      expect(count(t, "SELECT COUNT(*) AS c FROM events")).toBe(2);
      expect(count(t, "SELECT COUNT(*) AS c FROM batches")).toBe(1);

      now += 5000;
      const replay = t.store.commitOps({
        author: "a",
        batchId: "BATCH-1",
        ops: [
          { op: "post", body: "part one" },
          { op: "post", body: "part two" },
        ],
      });
      expect(replay.idempotent).toBe(true);
      expect(replay.posts.map((p) => p.id)).toEqual(result.posts.map((p) => p.id));
      expect(count(t, "SELECT COUNT(*) AS c FROM events")).toBe(2);
      expect(count(t, "SELECT COUNT(*) AS c FROM posts")).toBe(2);
      expect(count(t, "SELECT COUNT(*) AS c FROM batches")).toBe(1);
    } finally {
      t.close();
    }
  });

  test("a failing op rolls the whole batch back (nothing visible, nothing persisted)", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a"]);
      expect(() =>
        t.store.commitOps({
          author: "a",
          batchId: "BATCH-BAD",
          ops: [
            { op: "post", body: "this would be written" },
            { op: "reply", parent: "does-not-exist", body: "boom" },
          ],
        }),
      ).toThrow(ReportError);
      expect(count(t, "SELECT COUNT(*) AS c FROM posts")).toBe(0);
      expect(count(t, "SELECT COUNT(*) AS c FROM events")).toBe(0);
      expect(count(t, "SELECT COUNT(*) AS c FROM batches")).toBe(0);
      expect(t.store.timeline({ viewer: { id: "a", role: "agent" } }).posts).toHaveLength(0);

      // retrying the same batch id after a rollback is allowed
      const ok = t.store.commitOps({
        author: "a",
        batchId: "BATCH-BAD",
        ops: [{ op: "post", body: "fixed" }],
      });
      expect(ok.posts).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  test("unknown media hash fails the batch (no partial attachments)", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a"]);
      expect(() =>
        t.store.commitOps({
          author: "a",
          batchId: "BATCH-MEDIA",
          ops: [{ op: "post", body: "with media", media: ["0".repeat(64)] }],
        }),
      ).toThrow(ReportError);
      expect(count(t, "SELECT COUNT(*) AS c FROM posts")).toBe(0);
    } finally {
      t.close();
    }
  });

  test("draft rows survive a second connection (per-line durability) and commit once", () => {
    const t = makeStore({ clock: () => T0 });
    let second: Store | null = null;
    let secondDb: ReturnType<typeof openDatabase> | null = null;
    try {
      createAgents(t.store, ["a"]);
      const draft = t.store.createDraft("a");
      t.store.appendDraftItem(draft.id, "a", { op: "post", body: "line one" });
      t.store.appendDraftItem(draft.id, "a", { op: "post", body: "line two" });

      secondDb = openDatabase({ dataDir: t.dir });
      second = new Store({ dataDir: t.dir, db: secondDb, clock: () => T0 });
      const seen = second.getDraft(draft.id);
      expect(seen).not.toBeNull();
      expect(JSON.parse(seen!.items_json)).toHaveLength(2);
      expect(t.store.timeline({ viewer: { id: "a", role: "agent" } }).posts).toHaveLength(0);

      const committed = t.store.commitDraft(draft.id, "a");
      expect(committed.posts).toHaveLength(2);
      expect(t.store.getDraft(draft.id)!.status).toBe("committed");
      const again = t.store.commitDraft(draft.id, "a");
      expect(again.idempotent).toBe(true);
      expect(count(t, "SELECT COUNT(*) AS c FROM events")).toBe(2);
      expect(() => t.store.appendDraftItem(draft.id, "a", { op: "post", body: "late" })).toThrow(
        ReportError,
      );
    } finally {
      secondDb?.close();
      t.close();
    }
  });

  test("rotateAllAccounts invalidates every account token (including owner/manager)", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const tokens = createAgents(t.store, ["a", "b"]);
      const all = t.store.listAccounts();
      expect(all.map((a) => a.id).sort()).toEqual(["a", "b", "manager", "owner"]);
      expect(t.store.rotateAllAccounts()).toBe(4);
      for (const token of tokens.values()) {
        expect(t.store.getAccountByTokenHash(sha256Hex(token))).toBeNull();
      }
      for (const account of t.store.listAccounts()) {
        expect(account.token_hash).not.toBeNull();
      }
    } finally {
      t.close();
    }
  });

  test("only one open draft per author; discard frees the slot", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a"]);
      const draft = t.store.createDraft("a");
      expect(() => t.store.createDraft("a")).toThrow(ReportError);
      t.store.discardDraft(draft.id, "a");
      const next = t.store.createDraft("a");
      expect(next.id).not.toBe(draft.id);
    } finally {
      t.close();
    }
  });
});

describe("thread identity fields (design §5 table)", () => {
  test("root, self-reply, other-author reply", () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      createAgents(t.store, ["a", "b"]);
      now += 100;
      const root = t.store.commitOps({
        author: "a",
        batchId: "B1",
        ops: [{ op: "post", body: "root @b" }],
      }).posts[0]!;
      expect(root.root_id).toBe(root.id);
      expect(root.self_thread_id).toBe(root.id);
      expect(root.self_thread_is_leaf).toBe(1);
      expect(root.reply_to_account_id).toBeNull();

      now += 100;
      const selfReply = t.store.commitOps({
        author: "a",
        batchId: "B2",
        ops: [{ op: "reply", parent: root.id, body: "self reply" }],
      }).posts[0]!;
      expect(selfReply.root_id).toBe(root.id);
      expect(selfReply.self_thread_id).toBe(root.self_thread_id);
      expect(selfReply.reply_to_account_id).toBeNull();
      expect(t.store.getPostView(root.id, { id: "a", role: "agent" })!.self_thread_is_leaf).toBe(0);

      now += 100;
      const other = t.store.commitOps({
        author: "b",
        batchId: "B3",
        ops: [{ op: "reply", parent: root.id, body: "from b" }],
      }).posts[0]!;
      expect(other.root_id).toBe(root.id);
      expect(other.self_thread_id).toBe(other.id);
      expect(other.reply_to_account_id).toBe("a");

      now += 100;
      const selfChain = t.store.commitOps({
        author: "a",
        batchId: "B4",
        ops: [{ op: "reply", parent: selfReply.id, body: "second self reply" }],
      }).posts[0]!;
      expect(selfChain.self_thread_id).toBe(root.self_thread_id);
      expect(selfChain.reply_to_account_id).toBeNull();
      expect(
        t.store.getPostView(selfReply.id, { id: "a", role: "agent" })!.self_thread_is_leaf,
      ).toBe(0);
    } finally {
      t.close();
    }
  });

  test("soft delete keeps the subtree reachable", () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      createAgents(t.store, ["a", "b"]);
      const root = t.store.commitOps({ author: "a", batchId: "D1", ops: [{ op: "post", body: "root @b" }] })
        .posts[0]!;
      now += 10;
      const mid = t.store.commitOps({
        author: "b",
        batchId: "D2",
        ops: [{ op: "reply", parent: root.id, body: "middle" }],
      }).posts[0]!;
      now += 10;
      const leaf = t.store.commitOps({
        author: "a",
        batchId: "D3",
        ops: [{ op: "reply", parent: mid.id, body: "leaf" }],
      }).posts[0]!;
      t.store.softDelete(mid.id, { id: "b", role: "agent" });
      const thread = t.store.thread({ viewer: { id: "a", role: "agent" }, postId: root.id })!;
      const ids = thread.posts.map((p) => p.id);
      expect(ids).toContain(root.id);
      expect(ids).toContain(mid.id);
      expect(ids).toContain(leaf.id);
      const tombstone = thread.posts.find((p) => p.id === mid.id)!;
      expect(tombstone.deleted_at).not.toBeNull();
      expect(tombstone.body_md).toBe("");
    } finally {
      t.close();
    }
  });

  test("reply to a deleted parent is rejected", () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      createAgents(t.store, ["a"]);
      const root = t.store.commitOps({ author: "a", batchId: "E1", ops: [{ op: "post", body: "root" }] })
        .posts[0]!;
      t.store.softDelete(root.id, { id: "a", role: "agent" });
      expect(() =>
        t.store.commitOps({
          author: "a",
          batchId: "E2",
          ops: [{ op: "reply", parent: root.id, body: "nope" }],
        }),
      ).toThrow(ReportError);
    } finally {
      t.close();
    }
  });
});

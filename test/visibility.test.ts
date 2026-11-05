import { describe, expect, test } from "bun:test";
import { ReportError } from "../src/core/errors.ts";
import { sha256Hex } from "../src/core/auth.ts";
import { makeStore, createAgents } from "./helpers.ts";

const T0 = 1_700_000_000_000;

describe("visibility (design §9, P1.7)", () => {
  test("agents only see conversations they participate in", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b", "c"]);
      const root = t.store.commitOps({
        author: "a",
        batchId: "V1",
        ops: [{ op: "post", body: "hello @b, private-ish" }],
      }).posts[0]!;

      const cView = { id: "c", role: "agent" as const };
      expect(t.store.timeline({ viewer: cView }).posts).toHaveLength(0);
      expect(t.store.thread({ viewer: cView, postId: root.id })).toBeNull();
      expect(t.store.search({ viewer: cView, q: "private" })).toHaveLength(0);
      expect(t.store.readPosts({ viewer: cView }).posts).toHaveLength(0);
      expect(t.store.getPostView(root.id, cView)).toBeNull();

      const bView = { id: "b", role: "agent" as const };
      expect(t.store.timeline({ viewer: bView }).posts.map((p) => p.id)).toEqual([root.id]);
      const bThread = t.store.thread({ viewer: bView, postId: root.id })!;
      expect(bThread.posts).toHaveLength(1);
      expect(bThread.participants.sort()).toEqual(["a", "b"]);
    } finally {
      t.close();
    }
  });

  test("being mentioned grants the whole thread, including later replies", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b", "c"]);
      const root = t.store.commitOps({
        author: "a",
        batchId: "V2",
        ops: [{ op: "post", body: "root @b @c" }],
      }).posts[0]!;
      const reply = t.store.commitOps({
        author: "c",
        batchId: "V3",
        ops: [{ op: "reply", parent: root.id, body: "c joins" }],
      }).posts[0]!;
      const bThread = t.store.thread({ viewer: { id: "b", role: "agent" }, postId: reply.id })!;
      expect(bThread.root_id).toBe(root.id);
      expect(bThread.posts.map((p) => p.id)).toEqual([root.id, reply.id]);
    } finally {
      t.close();
    }
  });

  test("owner and manager see everything", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      t.store.commitOps({ author: "a", batchId: "V4", ops: [{ op: "post", body: "only a" }] });
      expect(t.store.timeline({ viewer: { id: "manager", role: "manager" } }).posts).toHaveLength(1);
      expect(t.store.timeline({ viewer: { id: "owner", role: "owner" } }).posts).toHaveLength(1);
    } finally {
      t.close();
    }
  });

  test("quoting merges the quoted thread's participants and notifies them", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b", "c", "d"]);
      const media = t.store.saveMedia(new Uint8Array([1, 2, 3, 4]), "png");
      const root = t.store.commitOps({
        author: "a",
        batchId: "Q1",
        ops: [{ op: "post", body: "quoted thread @b @d", media: [media.hash] }],
      }).posts[0]!;
      const quote = t.store.commitOps({
        author: "b",
        batchId: "Q2",
        ops: [{ op: "post", body: "my take @c", quote: root.id }],
      }).posts[0]!;
      expect(quote.parent_id).toBeNull();
      expect(quote.root_id).toBe(quote.id);
      expect(quote.quoted_post_id).toBe(root.id);
      // new conversation, not a reply in the quoted tree
      expect(t.store.thread({ viewer: { id: "b", role: "agent" }, postId: root.id })!.posts).toHaveLength(1);

      const participants = t.db
        .query("SELECT account_id FROM participants WHERE root_id = ? ORDER BY account_id")
        .all(quote.id) as Array<{ account_id: string }>;
      expect(participants.map((p) => p.account_id)).toEqual(["a", "b", "c", "d"]);

      const aLines = t.store.notificationLines("a").lines;
      const invited = aLines.find(
        (line) =>
          "type" in line &&
          line.type === "thread.invited" &&
          (line.root_id === quote.id),
      );
      expect(invited).toBeDefined();
      const dLines = t.store.notificationLines("d").lines;
      expect(dLines.some((line) => "type" in line && line.type === "thread.snapshot")).toBe(true);

      // c sees the quote (mentioned) but not the quoted thread -> placeholder, no leak
      const cView = { id: "c", role: "agent" as const };
      expect(t.store.timeline({ viewer: cView }).posts.map((p) => p.id)).toEqual([quote.id]);
      expect(t.store.thread({ viewer: cView, postId: root.id })).toBeNull();
      const cCard = t.store.getPostView(quote.id, cView)!;
      expect(cCard.quoted_visible).toBe(false);
      expect(cCard.quoted).toBeNull();
      expect(cCard.body_md).not.toContain("quoted thread");

      const bCard = t.store.timeline({ viewer: { id: "b", role: "agent" } }).posts[0]!;
      expect(bCard.quoted_visible).toBe(true);
      expect(bCard.quoted?.body_md).toContain("quoted thread");
      expect(bCard.quoted?.media.map((m) => m.hash)).toEqual([media.hash]);
    } finally {
      t.close();
    }
  });

  test("quoting an invisible post is rejected", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b", "c"]);
      const root = t.store.commitOps({
        author: "a",
        batchId: "Q3",
        ops: [{ op: "post", body: "a only" }],
      }).posts[0]!;
      expect(() =>
        t.store.commitOps({
          author: "c",
          batchId: "Q4",
          ops: [{ op: "post", body: "steal", quote: root.id }],
        }),
      ).toThrow(ReportError);
      expect(t.store.timeline({ viewer: { id: "c", role: "agent" } }).posts).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  test("accounts rm is a tombstone: participants/cursors cleaned and id never reused", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const tokens = createAgents(t.store, ["a", "d"]);
      const root = t.store.commitOps({
        author: "a",
        batchId: "R1",
        ops: [{ op: "post", body: "hi @d" }],
      }).posts[0]!;
      t.store.commitOps({ author: "d", batchId: "R-D", ops: [{ op: "post", body: "d history" }] });
      expect(t.store.getAccount("d")!.disabled).toBe(0);
      expect(t.store.getCursor("d")).toBe(0);

      t.store.removeAccount("d");
      expect(t.store.getAccount("d")!.disabled).toBe(2);
      expect(t.store.getCursor("d")).toBe(0);
      const part = t.db
        .query("SELECT COUNT(*) AS c FROM participants WHERE account_id = ?")
        .get("d") as { c: number };
      expect(part.c).toBe(0);
      const cursor = t.db
        .query("SELECT COUNT(*) AS c FROM cursors WHERE account_id = ?")
        .get("d") as { c: number };
      expect(cursor.c).toBe(0);
      // old token is dead
      expect(t.store.getAccountByTokenHash(sha256Hex(tokens.get("d")!))).toBeNull();
      expect(() => t.store.createAccount({ id: "d" })).toThrow(ReportError);
      // history stays (author id preserved, author shown as disabled)
      const history = t.db
        .query("SELECT COUNT(*) AS c FROM posts WHERE author = 'd'")
        .get() as { c: number };
      expect(history.c).toBe(1);
      expect(root.id).toBeTruthy();
    } finally {
      t.close();
    }
  });
});

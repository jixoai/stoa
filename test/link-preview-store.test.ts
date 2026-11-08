import { describe, expect, test } from "bun:test";
import { makeStore } from "./helpers.ts";
import { previewRowsForPost } from "../src/server/preview/queue.ts";

const T0 = 1_700_000_000_000;

describe("store write path (report-link-preview P1-4)", () => {
  test("no-link post → previews=[]; multi-link post → pending rows in order", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const plain = t.store.commitOps({
        author: "owner",
        batchId: "b-plain",
        ops: [{ op: "post", body: "没有链接" }],
      }).posts[0]!;
      expect(plain.previews).toEqual([]);

      const linked = t.store.commitOps({
        author: "owner",
        batchId: "b-links",
        ops: [
          {
            op: "post",
            body: "A https://example.com/a 和 [B](https://example.com/b) 和 https://example.com/c",
          },
        ],
      }).posts[0]!;
      expect(linked.previews.map((preview) => preview.url)).toEqual([
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
      ]);
      expect(linked.previews.map((preview) => preview.status)).toEqual([
        "pending",
        "pending",
        "pending",
      ]);
      expect(linked.previews[1]!.label).toBe("B");
      expect(previewRowsForPost(t.db, linked.id)).toHaveLength(3);
      expect(
        (
          t.db.query("SELECT COUNT(*) AS c FROM preview_jobs WHERE post_id = ?").get(linked.id) as {
            c: number;
          }
        ).c,
      ).toBe(3);
    } finally {
      t.close();
    }
  });

  test("replies are indexed too; quoted posts only render their own body links", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const root = t.store.commitOps({
        author: "owner",
        batchId: "b-root",
        ops: [{ op: "post", body: "根帖无链接" }],
      }).posts[0]!;
      const reply = t.store.commitOps({
        author: "owner",
        batchId: "b-reply",
        ops: [{ op: "reply", parent: root.id, body: "回复 https://example.com/reply" }],
      }).posts[0]!;
      expect(reply.previews).toHaveLength(1);
      expect(reply.previews[0]!.url).toBe("https://example.com/reply");
      expect(root.previews).toEqual([]);
    } finally {
      t.close();
    }
  });

  test("soft delete removes preview rows and jobs in the same transaction", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const post = t.store.commitOps({
        author: "owner",
        batchId: "b-del",
        ops: [{ op: "post", body: "删除 https://example.com/del" }],
      }).posts[0]!;
      expect(previewRowsForPost(t.db, post.id)).toHaveLength(1);
      t.store.softDelete(post.id, { id: "owner", role: "owner" });
      expect(previewRowsForPost(t.db, post.id)).toHaveLength(0);
      expect(
        (t.db.query("SELECT COUNT(*) AS c FROM preview_jobs WHERE post_id = ?").get(post.id) as {
          c: number;
        }).c,
      ).toBe(0);
      const view = t.store.getPostView(post.id, { id: "owner", role: "owner" })!;
      expect(view.previews).toEqual([]);
    } finally {
      t.close();
    }
  });

  test("plugin off: no extraction, no rows, no jobs", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      t.store.setPluginEnabled("link-preview", false, "owner");
      const post = t.store.commitOps({
        author: "owner",
        batchId: "b-off",
        ops: [{ op: "post", body: "关闭 https://example.com/off" }],
      }).posts[0]!;
      expect(post.previews).toEqual([]);
      expect(previewRowsForPost(t.db, post.id)).toHaveLength(0);
      expect(t.db.query("SELECT * FROM preview_jobs").all()).toHaveLength(0);
    } finally {
      t.close();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { assembleThread, type ThreadPostInput } from "../src/core/thread.ts";

function mk(
  id: string,
  author: string,
  parent: string | null,
  root: string,
  selfThread: string,
  createdAt: number,
  deleted = false,
): ThreadPostInput {
  return {
    id,
    author,
    parent_id: parent,
    root_id: root,
    self_thread_id: selfThread,
    created_at: createdAt,
    deleted,
  };
}

describe("thread assembly (design §5.1, P1.3)", () => {
  test("spine chain is rendered before other authors' branches", () => {
    const posts: ThreadPostInput[] = [
      mk("root", "A", null, "root", "root", 1),
      mk("a1", "A", "root", "root", "root", 2),
      mk("a2", "A", "a1", "root", "root", 3),
      mk("b1", "B", "root", "root", "b1", 4),
    ];
    const assembled = assembleThread(posts);
    expect(assembled.spine_ids).toEqual(["root", "a1", "a2"]);
    expect(assembled.nodes.map((n) => n.id)).toEqual(["root", "a1", "a2", "b1"]);
    expect(assembled.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 1]);
    expect(assembled.nodes.map((n) => n.is_spine)).toEqual([true, true, true, false]);
    expect(assembled.nodes.map((n) => n.is_self_continuation)).toEqual([false, true, true, false]);
    const chain = assembled.nodes.filter((n) => n.i !== undefined);
    expect(chain.map((n) => [n.i, n.n])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(assembled.nodes.find((n) => n.id === "b1")!.i).toBeUndefined();
    expect(assembled.spine_complete).toBe(true);
  });

  test("spine prefers the branch leading to focal", () => {
    const posts: ThreadPostInput[] = [
      mk("root", "A", null, "root", "root", 1),
      mk("early", "A", "root", "root", "root", 2),
      mk("late", "A", "root", "root", "root", 3),
      mk("late-child", "A", "late", "root", "root", 4),
    ];
    const assembled = assembleThread(posts, { focalId: "late-child" });
    expect(assembled.spine_ids).toEqual(["root", "late", "late-child"]);
    expect(assembled.nodes.map((n) => n.id)).toEqual(["root", "late", "late-child", "early"]);
    expect(assembled.nodes.find((n) => n.id === "early")!.depth).toBe(1);
  });

  test("a deleted spine node removes i/n from the whole thread", () => {
    const posts: ThreadPostInput[] = [
      mk("root", "A", null, "root", "root", 1),
      mk("a1", "A", "root", "root", "root", 2, true),
      mk("a2", "A", "a1", "root", "root", 3),
    ];
    const assembled = assembleThread(posts);
    expect(assembled.spine_complete).toBe(false);
    for (const node of assembled.nodes) {
      expect(node.i).toBeUndefined();
      expect(node.n).toBeUndefined();
    }
    // the deleted node still holds the tree together
    expect(assembled.nodes.map((n) => n.id)).toEqual(["root", "a1", "a2"]);
  });

  test("single-post thread has no i/n badge", () => {
    const assembled = assembleThread([mk("root", "A", null, "root", "root", 1)]);
    expect(assembled.nodes).toHaveLength(1);
    expect(assembled.nodes[0]!.i).toBeUndefined();
  });

  test("depth cap folds deeper replies and counts them", () => {
    const posts: ThreadPostInput[] = [mk("root", "A", null, "root", "root", 1)];
    for (let i = 1; i <= 10; i++) {
      posts.push(mk(`n${i}`, "A", i === 1 ? "root" : `n${i - 1}`, "root", "root", i + 1));
    }
    const assembled = assembleThread(posts, { maxDepth: 6 });
    expect(assembled.nodes).toHaveLength(7);
    expect(assembled.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(assembled.collapsed).toHaveLength(1);
    expect(assembled.collapsed[0]!.count).toBeGreaterThanOrEqual(4);
  });

  test("branch subtrees respect the depth cap and are counted", () => {
    const posts: ThreadPostInput[] = [
      mk("root", "A", null, "root", "root", 1),
      mk("b1", "B", "root", "root", "b1", 2),
      mk("b2", "B", "b1", "root", "b1", 3),
      mk("b3", "B", "b2", "root", "b1", 4),
    ];
    const assembled = assembleThread(posts, { maxDepth: 1 });
    expect(assembled.nodes.map((n) => n.id)).toEqual(["root", "b1"]);
    expect(assembled.collapsed.reduce((sum, c) => sum + c.count, 0)).toBeGreaterThanOrEqual(2);
  });
});

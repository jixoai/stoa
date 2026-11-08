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

describe("thread assembly: focal path/subtree are unconditional (report-thread-depth)", () => {
  /** root → alternating-author chain to n19, plus focal's child and grandchild. */
  function deepAlternatingChain(): ThreadPostInput[] {
    const posts: ThreadPostInput[] = [mk("n0", "A", null, "n0", "n0", 0)];
    for (let i = 1; i <= 19; i++) {
      posts.push(
        mk(
          `n${i}`,
          i % 2 === 1 ? "B" : "A",
          `n${i - 1}`,
          "n0",
          i % 2 === 1 ? `n${i}` : "n0",
          i,
        ),
      );
    }
    posts.push(mk("c1", "A", "n19", "n0", "c1", 20));
    posts.push(mk("c2", "B", "c1", "n0", "c2", 21));
    return posts;
  }

  test("20-level focal keeps every ancestor, focal and its subtree past maxDepth", () => {
    const assembled = assembleThread(deepAlternatingChain(), { focalId: "n19", maxDepth: 6 });
    const ids = assembled.nodes.map((node) => node.id);
    expect(ids).toEqual([
      "n0",
      ...Array.from({ length: 19 }, (_, i) => `n${i + 1}`),
      "c1",
      "c2",
    ]);
    expect(assembled.nodes.find((node) => node.id === "n19")!.depth).toBe(19);
    expect(assembled.nodes.find((node) => node.id === "c1")!.depth).toBe(20);
    expect(assembled.collapsed).toEqual([]);
  });

  test("unrelated 30-level branch still folds at maxDepth; focal path/subtree never counted", () => {
    const posts: ThreadPostInput[] = [
      mk("root", "A", null, "root", "root", 0),
      mk("p1", "B", "root", "root", "p1", 1),
      mk("focal", "A", "p1", "root", "focal", 2),
      mk("fc", "B", "focal", "root", "fc", 3),
    ];
    for (let i = 1; i <= 30; i++) {
      posts.push(
        mk(
          `b${i}`,
          i % 2 === 1 ? "B" : "A",
          i === 1 ? "root" : `b${i - 1}`,
          "root",
          i % 2 === 1 ? `b${i}` : "root",
          i + 3,
        ),
      );
    }
    const assembled = assembleThread(posts, { focalId: "focal", maxDepth: 6 });
    const ids = assembled.nodes.map((node) => node.id);
    for (const id of ["root", "p1", "focal", "fc"]) expect(ids).toContain(id);
    expect(ids).toContain("b6");
    expect(ids).not.toContain("b7");
    expect(assembled.collapsed).toEqual([{ parent_id: "b6", depth: 6, count: 24 }]);
    const mustEmitIds = new Set(["root", "p1", "focal", "fc"]);
    for (const group of assembled.collapsed) expect(mustEmitIds.has(group.parent_id)).toBe(false);
  });

  test("default maxDepth 24 caps unrelated branches but not the focal", () => {
    const posts: ThreadPostInput[] = [
      mk("root", "A", null, "root", "root", 0),
      mk("p1", "B", "root", "root", "p1", 1),
      mk("focal", "A", "p1", "root", "focal", 2),
      mk("fc", "B", "focal", "root", "fc", 3),
    ];
    for (let i = 1; i <= 30; i++) {
      posts.push(
        mk(
          `b${i}`,
          i % 2 === 1 ? "B" : "A",
          i === 1 ? "root" : `b${i - 1}`,
          "root",
          i % 2 === 1 ? `b${i}` : "root",
          i + 3,
        ),
      );
    }
    const assembled = assembleThread(posts, { focalId: "focal" });
    const ids = assembled.nodes.map((node) => node.id);
    for (const id of ["root", "p1", "focal", "fc"]) expect(ids).toContain(id);
    expect(ids).toContain("b24");
    expect(ids).not.toContain("b25");
    expect(assembled.collapsed).toEqual([{ parent_id: "b24", depth: 24, count: 6 }]);
  });

  test("a sibling branch of a deep focal is not emitted unconditionally", () => {
    const posts: ThreadPostInput[] = [
      mk("root", "A", null, "root", "root", 0),
      mk("a1", "B", "root", "root", "a1", 1),
      mk("a2", "A", "a1", "root", "a2", 2),
      mk("p", "B", "a2", "root", "p", 3),
      mk("focal", "A", "p", "root", "focal", 4),
      mk("fc", "B", "focal", "root", "fc", 5),
      mk("s", "C", "p", "root", "s", 6),
      mk("s2", "C", "s", "root", "s", 7),
    ];
    const assembled = assembleThread(posts, { focalId: "focal", maxDepth: 3 });
    expect(assembled.nodes.map((node) => node.id)).toEqual([
      "root",
      "a1",
      "a2",
      "p",
      "focal",
      "fc",
    ]);
    expect(assembled.collapsed).toEqual([{ parent_id: "p", depth: 3, count: 2 }]);
  });

  test("deep focal on the spine: whole chain emitted, i/n preserved, deep side branch capped", () => {
    const posts: ThreadPostInput[] = [mk("n0", "A", null, "n0", "n0", 0)];
    for (let i = 1; i <= 19; i++) posts.push(mk(`n${i}`, "A", `n${i - 1}`, "n0", "n0", i));
    posts.push(mk("c1", "A", "n19", "n0", "n0", 20));
    posts.push(mk("side", "B", "n18", "n0", "side", 21));
    const assembled = assembleThread(posts, { focalId: "n19", maxDepth: 6 });
    expect(assembled.spine_ids).toEqual([
      "n0",
      ...Array.from({ length: 19 }, (_, i) => `n${i + 1}`),
      "c1",
    ]);
    expect(assembled.nodes).toHaveLength(21);
    expect(assembled.nodes.map((node) => node.id)).not.toContain("side");
    expect(assembled.nodes.every((node) => node.i !== undefined && node.n !== undefined)).toBe(true);
    expect(assembled.nodes[assembled.nodes.length - 1]!.i).toBe(21);
    expect(assembled.nodes[assembled.nodes.length - 1]!.n).toBe(21);
    // The deep spine anchor still gets its unrelated branch folded (emittedSpine
    // must cover nodes past maxDepth, not `spine.slice(0, maxDepth+1)`).
    expect(assembled.collapsed).toEqual([{ parent_id: "n18", depth: 18, count: 1 }]);
  });

  test("orphan (missing parent) semantics unchanged; a focal below the gap is complete", () => {
    const posts: ThreadPostInput[] = [
      mk("root", "A", null, "root", "root", 1),
      mk("o1", "B", "ghost", "root", "o1", 2),
      mk("o2", "B", "o1", "root", "o1", 3),
    ];
    const plain = assembleThread(posts, { maxDepth: 6 });
    expect(plain.nodes.map((node) => [node.id, node.depth])).toEqual([
      ["root", 0],
      ["o1", 1],
      ["o2", 2],
    ]);
    const withFocal = assembleThread(posts, { focalId: "o2", maxDepth: 1 });
    expect(withFocal.nodes.map((node) => [node.id, node.depth])).toEqual([
      ["root", 0],
      ["o1", 1],
      ["o2", 2],
    ]);
    expect(withFocal.collapsed).toEqual([]);
  });
});

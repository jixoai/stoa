/**
 * 线程 planner 单测（openspec change report-thread-scope / report-thread-timeline /
 * report-thread-nesting）。
 *
 * 重点：作用域＝祖先链 + focal + focal 的后代（按父子相邻的先序展开，report-thread-nesting）；
 * focal 是 root 时等于整棵会话；同根兄弟分支不得进入 `replyNodes`。同时锁住既有语义：
 * unresolvedGap、祖先 >20 裁剪、子线程入口、compact / replyingTo。
 */
import { describe, expect, test } from "bun:test";
import type { CollapsedGroup, ThreadNode, ThreadView } from "../src/core/types.ts";
import {
  buildTimelinePlan,
  countAddedInScope,
  firstAddedInScope,
  planForThreadView,
  type TimelinePlan,
} from "../src/ui/lib/thread-plan.ts";

let seqCounter = 0;

function node(
  id: string,
  parentId: string | null,
  opts: {
    author?: string;
    createdAt?: number;
    selfContinuation?: boolean;
    replyTo?: string | null;
    childCount?: number;
  } = {},
): ThreadNode {
  seqCounter += 1;
  return {
    id,
    author: opts.author ?? "owner",
    body_md: id,
    kind: "note",
    parent_id: parentId,
    root_id: "root",
    self_thread_id: id,
    self_thread_is_leaf: 1,
    reply_to_account_id: opts.replyTo ?? null,
    quoted_post_id: null,
    tags: [],
    created_at: opts.createdAt ?? 100 + seqCounter,
    seq: seqCounter,
    batch_id: "b",
    deleted_at: null,
    author_account: null,
    media: [],
    previews: [],
    reply_count: 0,
    quoted: null,
    quoted_visible: false,
    depth: 0,
    is_spine: false,
    is_self_continuation: opts.selfContinuation ?? false,
    child_count: opts.childCount ?? 0,
  };
}

/** 按 nodes 的 parent_id 回填 child_count（除非显式给了 childCount）。 */
function withChildCounts(nodes: ThreadNode[]): ThreadNode[] {
  const counts = new Map<string, number>();
  for (const item of nodes) {
    if (!item.parent_id) continue;
    counts.set(item.parent_id, (counts.get(item.parent_id) ?? 0) + 1);
  }
  return nodes.map((item) => ({
    ...item,
    child_count: item.child_count > 0 ? item.child_count : (counts.get(item.id) ?? 0),
  }));
}

/** 始终按 nodes 重新计算 child_count（追加节点后使用）。 */
function recount(nodes: ThreadNode[]): ThreadNode[] {
  const counts = new Map<string, number>();
  for (const item of nodes) {
    if (!item.parent_id) continue;
    counts.set(item.parent_id, (counts.get(item.parent_id) ?? 0) + 1);
  }
  return nodes.map((item) => ({ ...item, child_count: counts.get(item.id) ?? 0 }));
}

function threadView(
  posts: ThreadNode[],
  focalId: string,
  collapsed: CollapsedGroup[] = [],
): ThreadView {
  return {
    root_id: "root",
    focal_id: focalId,
    spine_complete: true,
    posts,
    collapsed,
    participants: [],
    as_of_seq: 100,
  };
}

/** 复刻 ThreadPage 的祖先链计算（parent → … → root）后调用 planner。 */
function planFor(
  focal: ThreadNode,
  nodes: ThreadNode[],
  opts: {
    collapsed?: Map<string, number>;
    deepGap?: boolean;
    unresolvedGap?: boolean;
    loaded?: boolean;
  } = {},
): TimelinePlan {
  const nodeMap = new Map(nodes.map((item) => [item.id, item]));
  const ancestors: ThreadNode[] = [];
  let cursor = focal.parent_id ? nodeMap.get(focal.parent_id) : undefined;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    ancestors.push(cursor);
    seen.add(cursor.id);
    cursor = cursor.parent_id ? nodeMap.get(cursor.parent_id) : undefined;
  }
  return buildTimelinePlan({
    focal,
    ancestors,
    nodes,
    nodeMap,
    collapsedCounts: opts.collapsed ?? new Map(),
    deepGap: opts.deepGap ?? false,
    unresolvedGap: opts.unresolvedGap ?? false,
    loaded: opts.loaded ?? true,
  });
}

const postIds = (plan: TimelinePlan): string[] =>
  plan.rows
    .filter((row) => row.kind === "post")
    .map((row) => (row.kind === "post" ? row.node.id : ""));

/**
 * 夹具：
 *   root ├── A1
 *        ├── C1
 *        └── B1 └── FOCAL ├── R1 └── R3
 *                        └── R2
 */
function branchFixture() {
  return withChildCounts([
    node("root", null, { createdAt: 100, childCount: 3 }),
    node("a1", "root", { author: "manager", createdAt: 110 }),
    node("c1", "root", { author: "manager", createdAt: 120 }),
    node("b1", "root", { createdAt: 130 }),
    node("focal", "b1", { author: "manager", createdAt: 140 }),
    node("r1", "focal", { createdAt: 150 }),
    node("r2", "focal", { author: "manager", createdAt: 160 }),
    node("r3", "r1", { createdAt: 170 }),
  ]);
}

describe("buildTimelinePlan 作用域（focal 子树）", () => {
  test("深链到分支 B：只渲染祖先链 + focal + focal 子树（先序），兄弟分支 A/C 排除", () => {
    const nodes = branchFixture();
    const focal = nodes.find((item) => item.id === "focal")!;
    const plan = planFor(focal, nodes);

    // 先序：r1 → r3（r1 的子节点）→ r2（r1 子树结束后继续同级）。
    expect(plan.replyNodes.map((item) => item.id)).toEqual(["r1", "r3", "r2"]);
    expect(postIds(plan)).toEqual(["root", "b1", "focal", "r1", "r3", "r2"]);
    expect(plan.replyNodes.map((item) => item.id)).not.toContain("a1");
    expect(plan.replyNodes.map((item) => item.id)).not.toContain("c1");
    expect(plan.gapVisible).toBe(false);
  });

  test("focal 是 root：后代集等于其余全部节点（整棵会话，先序）", () => {
    const nodes = branchFixture();
    const focal = nodes.find((item) => item.id === "root")!;
    const plan = planFor(focal, nodes);

    expect(plan.replyNodes.map((item) => item.id)).toEqual([
      "a1",
      "c1",
      "b1",
      "focal",
      "r1",
      "r3",
      "r2",
    ]);
    expect(postIds(plan)).toHaveLength(nodes.length);
  });

  test("focal 是 root：assembleThread 的 orphan 占位（父帖缺失）仍渲染；深链页不串入", () => {
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("a1", "root", { createdAt: 110 }),
      node("focal", "a1", { createdAt: 120 }),
      // orphan：parent_id 不在 posts 里（visibility root-scoped 的占位分支）
      node("orphan", "missing-parent", { author: "manager", createdAt: 130 }),
    ]);
    const root = nodes.find((item) => item.id === "root")!;
    const rootPlan = planFor(root, nodes);
    expect(rootPlan.replyNodes.map((item) => item.id)).toEqual(["a1", "focal", "orphan"]);

    const deepFocal = nodes.find((item) => item.id === "focal")!;
    const deepPlan = planFor(deepFocal, nodes);
    expect(deepPlan.replyNodes.map((item) => item.id)).toEqual([]);
    expect(postIds(deepPlan)).toEqual(["root", "a1", "focal"]);
  });

  test("focal 子树多分支：直接回复后紧跟它自己的子树（先序）", () => {
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("focal", "root", { createdAt: 110 }),
      node("r1", "focal", { createdAt: 120 }),
      node("r2", "focal", { author: "manager", createdAt: 130 }),
      node("r1a", "r1", { createdAt: 140 }),
      node("r1b", "r1", { author: "manager", createdAt: 150 }),
    ]);
    const focal = nodes.find((item) => item.id === "focal")!;
    const plan = planFor(focal, nodes);

    expect(plan.replyNodes.map((item) => item.id)).toEqual(["r1", "r1a", "r1b", "r2"]);
    expect(postIds(plan)).toEqual(["root", "focal", "r1", "r1a", "r1b", "r2"]);
  });

  test("脏数据成环：seen 防重复，不重复成行、不死循环", () => {
    const base = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("focal", "root", { createdAt: 110 }),
      node("child", "focal", { createdAt: 120 }),
      node("grandchild", "child", { createdAt: 130 }),
    ]);
    // 脏数据：同一 id 以另一个 parent_id 再出现一次，令 child→grandchild→child 成环。
    const cyclic = [...base, { ...base[2]!, parent_id: "grandchild" }];
    const focal = cyclic.find((item) => item.id === "focal")!;
    const plan = planFor(focal, cyclic);

    expect(plan.replyNodes.map((item) => item.id)).toEqual(["child", "grandchild"]);
    expect(postIds(plan).filter((id) => id === "child")).toHaveLength(1);
    // 环不会让 BFS 死循环：调用本身能返回即证明有界。
    expect(plan).toBeTruthy();
  });
});

describe("buildTimelinePlan 先序展开（report-thread-nesting A1–A9）", () => {
  /** A1/A2：直接子节点紧邻 focal，孙节点紧跟其父。 */
  test("A1/A2 子节点紧邻父、孙节点紧跟子（A→B→C）", () => {
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("focal", "root", { createdAt: 110 }),
      node("r2", "focal", { createdAt: 120 }),
      node("r3", "r2", { createdAt: 130 }),
    ]);
    const focal = nodes.find((item) => item.id === "focal")!;
    const plan = planFor(focal, nodes);

    expect(postIds(plan)).toEqual(["root", "focal", "r2", "r3"]);
    const r3Row = plan.rows.find((row) => row.kind === "post" && row.node.id === "r3");
    expect(r3Row?.kind === "post" ? r3Row.compact : null).toBe(false);
    expect(r3Row?.kind === "post" ? r3Row.replyingTo : null).toBeNull();
  });

  /** A3：兄弟回复在各自子树结束后按时间继续。 */
  test("A3 兄弟在子树后：A→B、A→C、B→D ⇒ B,D,C", () => {
    const nodes = withChildCounts([
      node("focal", null, { createdAt: 100 }),
      node("b", "focal", { createdAt: 110 }),
      node("c", "focal", { createdAt: 120 }),
      node("d", "b", { createdAt: 130 }),
    ]);
    const focal = nodes.find((item) => item.id === "focal")!;
    const plan = planFor(focal, nodes);
    expect(plan.replyNodes.map((item) => item.id)).toEqual(["b", "d", "c"]);
  });

  /** A4：多分支混合先序（含 E2E 同构夹具：R2→R3 与 R2 之后的 M1）。 */
  test("A4 多分支混合先序：R1→R2→R3、R1→M1（M1 时间早于 R3）⇒ R2,R3,M1", () => {
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("r1", "root", { createdAt: 110 }),
      node("r2", "r1", { createdAt: 120 }),
      node("m1", "r1", { createdAt: 130 }),
      node("r3", "r2", { createdAt: 140 }),
    ]);
    const focal = nodes.find((item) => item.id === "r1")!;
    const plan = planFor(focal, nodes);
    expect(plan.replyNodes.map((item) => item.id)).toEqual(["r2", "r3", "m1"]);

    // 同级 M1 的父帖是 r1、上一 post 行是 r3 ⇒ 显示「回复给」。
    const m1Row = plan.rows.find((row) => row.kind === "post" && row.node.id === "m1");
    expect(m1Row?.kind === "post" ? m1Row.replyingTo : null).toBe("owner");
  });

  /** A5：无子节点只输出自身。 */
  test("A5 无子节点回复只输出自身", () => {
    const nodes = withChildCounts([
      node("focal", null, { createdAt: 100 }),
      node("leaf1", "focal", { createdAt: 110 }),
      node("leaf2", "focal", { author: "manager", createdAt: 120 }),
    ]);
    const focal = nodes.find((item) => item.id === "focal")!;
    const plan = planFor(focal, nodes);
    expect(plan.replyNodes.map((item) => item.id)).toEqual(["leaf1", "leaf2"]);
    expect(plan.rows.filter((row) => row.kind === "post" && row.role === "reply")).toHaveLength(2);
  });

  /** A6：自接链在 DFS 下自然相邻，compact/compactHeader 保持（即使有更早的兄弟回复）。 */
  test("A6 自接 compact 保持：兄弟回复不再打断同作者续接链", () => {
    const nodes = withChildCounts([
      node("focal", null, { author: "owner", createdAt: 100 }),
      node("s1", "focal", { author: "owner", selfContinuation: true, createdAt: 110 }),
      node("x", "focal", { author: "manager", createdAt: 115 }),
      node("s2", "s1", { author: "owner", selfContinuation: true, createdAt: 120 }),
    ]);
    const focal = nodes.find((item) => item.id === "focal")!;
    const plan = planFor(focal, nodes);

    expect(plan.replyNodes.map((item) => item.id)).toEqual(["s1", "s2", "x"]);
    const posts = plan.rows.filter((row) => row.kind === "post" && row.role === "reply");
    const [s1, s2, x] = posts;
    expect(s1?.kind === "post" ? [s1.compact, s1.compactHeader] : null).toEqual([true, true]);
    expect(s2?.kind === "post" ? [s2.compact, s2.compactHeader] : null).toEqual([true, false]);
    expect(x?.kind === "post" ? [x.compact, x.replyingTo] : null).toEqual([false, "owner"]);
  });

  /** A7：同级排序稳定（created_at → seq → id），重复构建/输入顺序无关。 */
  test("A7 排序稳定：同级 created_at→seq→id，重复构建结果一致", () => {
    const base = withChildCounts([
      node("focal", null, { createdAt: 100 }),
      node("p", "focal", { createdAt: 200 }),
      node("q", "focal", { createdAt: 200 }),
      node("early-seq", "focal", { createdAt: 200 }),
    ]);
    // 同 created_at：q 的 seq 比 p 小；early-seq 的 seq 最大。
    const patched = base.map((item) => {
      if (item.id === "p") return { ...item, seq: 20 };
      if (item.id === "q") return { ...item, seq: 10 };
      if (item.id === "early-seq") return { ...item, seq: 30 };
      return item;
    });
    const focal = patched.find((item) => item.id === "focal")!;
    const plan = planFor(focal, patched);
    expect(plan.replyNodes.map((item) => item.id)).toEqual(["q", "p", "early-seq"]);

    // 输入数组顺序不影响输出（先序由 (created_at, seq, id) 决定）。
    const reversed = planFor(focal, patched.slice().reverse());
    expect(reversed.replyNodes.map((item) => item.id)).toEqual(["q", "p", "early-seq"]);

    // 完全同 created_at/seq 时按 id 升序：id 小的先输出。
    const tie = withChildCounts([
      node("focal", null, { createdAt: 100 }),
      node("b", "focal", { createdAt: 200 }),
      node("a", "focal", { createdAt: 200 }),
    ]).map((item) =>
      item.id === "a" || item.id === "b" ? { ...item, seq: 7 } : item,
    );
    const tieFocal = tie.find((item) => item.id === "focal")!;
    expect(planFor(tieFocal, tie).replyNodes.map((item) => item.id)).toEqual(["a", "b"]);
  });

  /** A8：深链 focal 页只含其子树（兄弟分支 0 命中），子树内部仍是先序。 */
  test("A8 深链 focal 只含其子树且子树先序", () => {
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("sibling", "root", { createdAt: 110 }),
      node("focal", "root", { createdAt: 120 }),
      node("r1", "focal", { createdAt: 130 }),
      node("r2", "focal", { createdAt: 140 }),
      node("r1a", "r1", { createdAt: 150 }),
    ]);
    const focal = nodes.find((item) => item.id === "focal")!;
    const plan = planFor(focal, nodes);

    expect(plan.replyNodes.map((item) => item.id)).toEqual(["r1", "r1a", "r2"]);
    expect(postIds(plan)).toEqual(["root", "focal", "r1", "r1a", "r2"]);
    expect(postIds(plan)).not.toContain("sibling");
  });

  /** A9：root 页全量先序（orphan 占位追加在可达先序之后）。 */
  test("A9 root 全量先序：分支子树连续，orphan 追加在末尾", () => {
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("a", "root", { createdAt: 110 }),
      node("b", "root", { createdAt: 120 }),
      node("a1", "a", { createdAt: 130 }),
      node("b1", "b", { createdAt: 140 }),
      node("orphan", "missing-parent", { createdAt: 125 }),
    ]);
    const root = nodes.find((item) => item.id === "root")!;
    const plan = planFor(root, nodes);
    expect(plan.replyNodes.map((item) => item.id)).toEqual([
      "a",
      "a1",
      "b",
      "b1",
      "orphan",
    ]);
    expect(postIds(plan)).toHaveLength(nodes.length);
  });

  /** A9b：orphan 占位带后代 / 多个 orphan 根 → 各自作为独立子树先序追加。 */
  test("A9b orphan 带后代与多个 orphan 根：独立子树先序追加", () => {
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("a", "root", { createdAt: 110 }),
      node("orphan-1", "missing-1", { createdAt: 120 }),
      node("orphan-1-child", "orphan-1", { createdAt: 130 }),
      node("orphan-1-grandchild", "orphan-1-child", { createdAt: 140 }),
      node("orphan-2", "missing-2", { createdAt: 125 }),
      node("orphan-2-child", "orphan-2", { createdAt: 150 }),
    ]);
    const root = nodes.find((item) => item.id === "root")!;
    const plan = planFor(root, nodes);

    expect(plan.replyNodes.map((item) => item.id)).toEqual([
      "a",
      "orphan-1",
      "orphan-1-child",
      "orphan-1-grandchild",
      "orphan-2",
      "orphan-2-child",
    ]);
    expect(postIds(plan)).toHaveLength(nodes.length);
  });
});

describe("buildTimelinePlan 缺口与既有语义", () => {
  test("unresolvedGap：父帖不可解析时 rest=[]，只留缺口行 + focal", () => {
    const focal = node("focal", "missing-parent", { createdAt: 200 });
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("unrelated", "root", { createdAt: 110 }),
    ]);
    const plan = planFor(focal, nodes, { deepGap: true, unresolvedGap: true });

    expect(plan.replyNodes).toEqual([]);
    expect(postIds(plan)).toEqual(["focal"]);
    expect(plan.gapVisible).toBe(true);
    expect(plan.gapParentId).toBe("missing-parent");
  });

  test("deepGap：focal 不在 posts 但父帖可解析 → 正常祖先链，focal 入口不自指", () => {
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("parent", "root", { createdAt: 110 }),
    ]);
    const focal = node("focal", "parent", { createdAt: 120, childCount: 3 });
    const plan = planFor(focal, nodes, { deepGap: true });

    expect(postIds(plan)).toEqual(["root", "parent", "focal"]);
    expect(plan.replyNodes).toEqual([]);
    expect(plan.rows.some((row) => row.kind === "subthread" && row.nodeId === "focal")).toBe(false);
    expect(plan.gapVisible).toBe(false);
  });

  test("祖先 >20：只渲染最近 20 条，缺口行跳被丢弃的最后一条祖先", () => {
    const chain: ThreadNode[] = [node("n0", null, { createdAt: 0 })];
    for (let index = 1; index <= 25; index += 1) {
      chain.push(node(`n${index}`, `n${index - 1}`, { author: "owner", createdAt: index }));
    }
    const nodes = withChildCounts(chain);
    const focal = nodes.find((item) => item.id === "n25")!;
    const plan = planFor(focal, nodes);

    const ancestorIds = plan.rows.flatMap((row) =>
      row.kind === "post" && row.role === "ancestor" ? [row.node.id] : [],
    );
    expect(ancestorIds).toHaveLength(20);
    expect(ancestorIds[0]).toBe("n5");
    expect(ancestorIds.at(-1)).toBe("n24");
    expect(plan.gapVisible).toBe(true);
    expect(plan.gapParentId).toBe("n4");
  });

  test("同级排序：created_at → seq → id，兄弟分支不干扰 focal 子树", () => {
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("sibling", "root", { createdAt: 105 }),
      node("focal", "root", { createdAt: 110 }),
      node("late", "focal", { author: "manager", createdAt: 130 }),
      node("early", "focal", { createdAt: 130 }),
    ]);
    // 同 created_at 时按 seq 升序：手动把 early 的 seq 改大，它应排在 late 之后。
    const patched = nodes.map((item) =>
      item.id === "early" ? { ...item, seq: 999 } : item,
    );
    const focal = patched.find((item) => item.id === "focal")!;
    const plan = planFor(focal, patched);

    expect(plan.replyNodes.map((item) => item.id)).toEqual(["late", "early"]);
    expect(plan.replyNodes.map((item) => item.id)).not.toContain("sibling");
  });

  test("关系语义：相邻自接链 compact / 非相邻父帖 replyingTo", () => {
    const nodes = withChildCounts([
      node("focal", null, { author: "owner", createdAt: 100 }),
      node("s1", "focal", { author: "owner", selfContinuation: true, createdAt: 110 }),
      node("s2", "s1", { author: "owner", selfContinuation: true, createdAt: 120 }),
      node("other", "focal", { author: "manager", replyTo: "owner", createdAt: 130 }),
    ]);
    const focal = nodes.find((item) => item.id === "focal")!;
    const plan = planFor(focal, nodes);
    const posts = plan.rows.filter((row) => row.kind === "post" && row.role === "reply");

    const [s1, s2, other] = posts;
    expect(s1?.kind === "post" ? [s1.compact, s1.compactHeader, s1.replyingTo] : null).toEqual([
      true,
      true,
      null,
    ]);
    expect(s2?.kind === "post" ? [s2.compact, s2.compactHeader, s2.replyingTo] : null).toEqual([
      true,
      false,
      null,
    ]);
    expect(other?.kind === "post" ? [other.compact, other.replyingTo] : null).toEqual([
      false,
      "owner",
    ]);
  });

  test("子线程入口：child_count 大于已加载子节点时生成入口行，折叠计数优先", () => {
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("focal", "root", { createdAt: 110 }),
      node("r1", "focal", { createdAt: 120 }),
    ]);
    const patched = nodes.map((item) =>
      item.id === "focal" ? { ...item, child_count: 3 } : item,
    );
    const focal = patched.find((item) => item.id === "focal")!;
    const plan = planFor(focal, patched);
    const entry = plan.rows.find((row) => row.kind === "subthread");
    expect(entry?.kind === "subthread" ? entry.nodeId : null).toBe("focal");
    expect(entry?.kind === "subthread" ? entry.count : null).toBe(2);

    const collapsed = new Map([["focal", 5]]);
    const collapsedPlan = planFor(focal, patched, { collapsed });
    const collapsedEntry = collapsedPlan.rows.find((row) => row.kind === "subthread");
    expect(collapsedEntry?.kind === "subthread" ? collapsedEntry.count : null).toBe(5);
  });

  test("未加载（loaded=false）：不生成任何子线程入口", () => {
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("focal", "root", { createdAt: 110, childCount: 4 }),
    ]);
    const focal = nodes.find((item) => item.id === "focal")!;
    const plan = planFor(focal, nodes, { loaded: false });
    expect(plan.rows.some((row) => row.kind === "subthread")).toBe(false);
  });
});

describe("planForThreadView / countAddedInScope / firstAddedInScope（新回复追加与提示口径）", () => {
  test("兄弟分支新增回复：差集计数 0（深链页不出胶囊）", () => {
    const base = branchFixture();
    const prev = planForThreadView(threadView(base, "focal"), "focal");
    const withSibling = recount([
      ...base,
      node("a1x", "a1", { author: "manager", createdAt: 180 }),
    ]);
    const next = planForThreadView(threadView(withSibling, "focal"), "focal");

    expect(countAddedInScope(prev, next)).toBe(0);
  });

  test("focal 子树新增回复：差集计数 1（直接回复与更深回复同口径）", () => {
    const base = branchFixture();
    const prev = planForThreadView(threadView(base, "focal"), "focal");
    const direct = recount([
      ...base,
      node("r4", "focal", { author: "manager", createdAt: 180 }),
    ]);
    const nested = recount([
      ...base,
      node("r1x", "r1", { author: "manager", createdAt: 181 }),
    ]);

    expect(
      countAddedInScope(prev, planForThreadView(threadView(direct, "focal"), "focal")),
    ).toBe(1);
    expect(
      countAddedInScope(prev, planForThreadView(threadView(nested, "focal"), "focal")),
    ).toBe(1);
  });

  test("折叠/超 maxDepth 的新回复：focal 子树内计数，祖先链增长不计数", () => {
    const fixture = (rootCount: number, focalCount: number) =>
      withChildCounts([
        node("root", null, { createdAt: 100, childCount: rootCount }),
        node("focal", "root", { createdAt: 110, childCount: focalCount }),
        node("r1", "focal", { createdAt: 120 }),
      ]);
    const prev = planForThreadView(threadView(fixture(3, 3), "focal"), "focal");
    const focalHiddenGrew = planForThreadView(threadView(fixture(3, 4), "focal"), "focal");
    const ancestorHiddenGrew = planForThreadView(threadView(fixture(4, 3), "focal"), "focal");

    expect(countAddedInScope(prev, focalHiddenGrew)).toBe(1);
    expect(countAddedInScope(prev, ancestorHiddenGrew)).toBe(0);
  });

  test("root 页（focal=root）：兄弟分支新增照常计数", () => {
    const base = branchFixture();
    const prev = planForThreadView(threadView(base, "root"), "root");
    const withSibling = recount([
      ...base,
      node("a1x", "a1", { author: "manager", createdAt: 180 }),
    ]);
    const next = planForThreadView(threadView(withSibling, "root"), "root");

    expect(countAddedInScope(prev, next)).toBe(1);
  });

  test("深链超 maxDepth：无帖子焦点用合成 focal 回退，后代差集仍可算", () => {
    const nodes = withChildCounts([
      node("root", null, { createdAt: 100 }),
      node("parent", "root", { createdAt: 110 }),
    ]);
    const synthetic = node("focal", "parent", { createdAt: 120 });
    const prevView = threadView(nodes, "focal");
    const prev = planForThreadView(prevView, "focal", synthetic);
    expect(prev?.rows.some((row) => row.kind === "post" && row.role === "focal")).toBe(true);

    const nextNodes = withChildCounts([
      ...nodes,
      node("focal", "parent", { createdAt: 120 }),
      node("focal-child", "focal", { createdAt: 130 }),
    ]);
    const next = planForThreadView(threadView(nextNodes, "focal"), "focal", synthetic);
    expect(countAddedInScope(prev, next)).toBe(1);
  });

  test("firstAddedInScope：先序序第一条新增行；兄弟/无行差集为 null", () => {
    const base = branchFixture();
    const prev = planForThreadView(threadView(base, "focal"), "focal");

    // r1 子树内与 focal 深处各来一条：先序里 r1x（r1 子树内）先于 r4（focal 的末子）。
    const nested = recount([
      ...base,
      node("r1x", "r1", { author: "manager", createdAt: 180 }),
    ]);
    const direct = recount([
      ...base,
      node("r4", "focal", { author: "manager", createdAt: 190 }),
    ]);
    const both = recount([
      ...base,
      node("r1x", "r1", { author: "manager", createdAt: 180 }),
      node("r4", "focal", { author: "manager", createdAt: 190 }),
    ]);

    expect(
      firstAddedInScope(prev, planForThreadView(threadView(nested, "focal"), "focal")),
    ).toBe("r1x");
    expect(
      firstAddedInScope(prev, planForThreadView(threadView(direct, "focal"), "focal")),
    ).toBe("r4");
    expect(
      firstAddedInScope(prev, planForThreadView(threadView(both, "focal"), "focal")),
    ).toBe("r1x");

    // 兄弟分支新增：本页无新增行 → null（提示回退滚到底）。
    const sibling = recount([
      ...base,
      node("a1x", "a1", { author: "manager", createdAt: 200 }),
    ]);
    expect(
      firstAddedInScope(prev, planForThreadView(threadView(sibling, "focal"), "focal")),
    ).toBe(null);

    // 只有折叠子树计数增长（无新行）→ null，与 countAddedInScope=1 并存。
    const fixture = (focalCount: number) =>
      withChildCounts([
        node("root", null, { createdAt: 100, childCount: 3 }),
        node("focal", "root", { createdAt: 110, childCount: focalCount }),
        node("r1", "focal", { createdAt: 120 }),
      ]);
    const prevHidden = planForThreadView(threadView(fixture(3), "focal"), "focal");
    const nextHidden = planForThreadView(threadView(fixture(4), "focal"), "focal");
    expect(countAddedInScope(prevHidden, nextHidden)).toBe(1);
    expect(firstAddedInScope(prevHidden, nextHidden)).toBe(null);
  });
});

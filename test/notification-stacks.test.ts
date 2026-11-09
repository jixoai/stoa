/**
 * 通知叠放纯函数单测（report-notification-stacks P1-1 / P1-3 / P1-4）。
 *
 * 覆盖：
 * - 锚点 DP `U(p) ?? N(p) ?? p`（最靠根未读；软删穿链不当锚；缺失拓扑退化自身；100 节点线性）；
 * - 成员构建（同帖多事件去重、软删剔除、无 target 独立行）与分组（排序/摘要/未读计数）；
 * - 一致性契约（design §11.3 契约 1–6）：同叠 ⇔ 从最早未读打开的 timeline 包含叠内
 *   全部未读成员；兄弟双向口径（共同未读祖先可同叠 ⇔ 无未读共同锚点必须分叠）；
 *   全已读叠 `N` 锚点覆盖全部分支；planner 交叉验证。
 */
import { describe, expect, test } from "bun:test";
import type { NotificationEventLine, PostView, ThreadNode, ThreadView } from "../src/core/types.ts";
import {
  buildThreadTopology,
  highestUnreadAncestor,
  resolveStackAnchors,
  type NotificationRelevance,
  type ThreadTopology,
  type ThreadTopologyNode,
} from "../src/ui/lib/thread-plan.ts";
import { planForThreadView } from "../src/ui/lib/thread-plan.ts";
import {
  buildNotificationMembers,
  buildNotificationStacks,
  diffNotificationStacks,
  memberRowId,
  type NotificationMember,
  type NotificationStack,
} from "../src/ui/lib/notification-stacks.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

/** id 的字典序即时间序（单字母 fixture 足够）。 */
function pnode(
  id: string,
  parent: string | null,
  opts: { deleted?: boolean; root?: string } = {},
): ThreadTopologyNode {
  const created = id.charCodeAt(0);
  return {
    id,
    parent_id: parent,
    root_id: opts.root ?? "A",
    deleted_at: opts.deleted ? 1 : null,
    created_at: created,
    seq: created,
  };
}

function member(
  id: string | null,
  seq: number,
  opts: { read?: boolean; deleted?: boolean; type?: NotificationEventLine["type"] } = {},
): NotificationMember {
  const event: NotificationEventLine = {
    seq,
    type: opts.type ?? "post.created",
    actor: "manager",
    post_id: id,
    root_id: id ? "A" : null,
    batch_id: "b",
    created_at: seq,
    payload: {},
  };
  return {
    targetId: id,
    post: id
      ? ({
          id,
          root_id: "A",
          parent_id: null,
          deleted_at: opts.deleted ? 1 : null,
          body_md: `${id} 正文`,
        } as unknown as PostView)
      : null,
    deleted: opts.deleted === true,
    events: [event],
    read: opts.read === true,
    sortSeq: seq,
    event,
  };
}

function relevanceOf(unread: readonly string[], notified: readonly string[]): NotificationRelevance {
  const u = new Set(unread);
  const n = new Set(notified);
  return { isUnread: (id) => u.has(id), isNotified: (id) => n.has(id) };
}

const NO_DELETED = () => false;

/** 合成：A → B → C（链）；A → D、A → E（兄弟）；E → F → G → H（8 层深链的尾部）。 */
function chainTopology(extra: ThreadTopologyNode[] = []): ThreadTopology {
  return buildThreadTopology([
    pnode("A", null),
    pnode("B", "A"),
    pnode("C", "B"),
    pnode("D", "A"),
    pnode("E", "A"),
    pnode("F", "E"),
    pnode("G", "F"),
    pnode("H", "G"),
    ...extra,
  ]);
}

function stackOf(result: { stacks: NotificationStack[] }, anchorId: string): NotificationStack {
  const stack = result.stacks.find((row) => row.anchorId === anchorId);
  if (!stack) throw new Error(`no stack anchored at ${anchorId}`);
  return stack;
}

function contractCheck(
  topology: ThreadTopology,
  result: { stacks: NotificationStack[]; standalone: NotificationMember[] },
  unread: ReadonlySet<string>,
  notified: ReadonlySet<string>,
): void {
  const relevance = { isUnread: (id: string) => unread.has(id), isNotified: (id: string) => notified.has(id) };
  const anchors = resolveStackAnchors(topology, relevance);
  // 契约 1：同叠 ⇒ timeline 包含（每个未读成员都在 scopeOf(anchor) 内）。
  for (const stack of result.stacks) {
    const scope = topology.scopeOf(stack.anchorId);
    expect(scope).not.toBeNull();
    for (const m of stack.unreadMembers) {
      expect(scope!.has(m.targetId!)).toBe(true);
    }
  }
  // 契约 2：timeline 内未读 ⇒ 同叠（scope 内每个未读帖的 anchor 都是 a）。
  for (const stack of result.stacks) {
    const scope = topology.scopeOf(stack.anchorId)!;
    const candidates = new Set<string>([stack.anchorId, ...scope.descendantIds, ...scope.ancestorIds]);
    for (const id of candidates) {
      if (!unread.has(id)) continue;
      expect(anchors.get(id)).toBe(stack.anchorId);
    }
  }
  void relevance;
}

// ── P1-1 锚点 DP ────────────────────────────────────────────────────────────

describe("resolveStackAnchors（P1-1）", () => {
  test("① 单链未读三帖 → 全部 anchor=根（最靠根未读）", () => {
    const topology = chainTopology();
    const anchors = resolveStackAnchors(topology, relevanceOf(["A", "B", "C"], ["A", "B", "C"]));
    expect(anchors.get("A")).toBe("A");
    expect(anchors.get("B")).toBe("A");
    expect(anchors.get("C")).toBe("A");
  });

  test("② 兄弟未读（共同祖先已读）→ 各自 anchor=self", () => {
    const topology = chainTopology();
    const anchors = resolveStackAnchors(
      topology,
      relevanceOf(["B", "D", "H"], ["A", "B", "D", "E", "H"]),
    );
    expect(anchors.get("B")).toBe("B");
    expect(anchors.get("D")).toBe("D");
    expect(anchors.get("H")).toBe("H");
    // 共同祖先已读：不是未读锚点也不当候选（N 只对全已读链生效）。
    expect(anchors.get("A")).toBe("A");
  });

  test("③ A 未读 / B 已读 / C 未读 → 三者 anchor=A", () => {
    const topology = chainTopology();
    const anchors = resolveStackAnchors(
      topology,
      relevanceOf(["A", "C"], ["A", "B", "C"]),
    );
    expect(anchors.get("B")).toBe("A");
    expect(anchors.get("C")).toBe("A");
  });

  test("④ 中间软删：链路不断、删除节点不当锚", () => {
    const topology = buildThreadTopology([
      pnode("A", null),
      pnode("B", "A", { deleted: true }),
      pnode("C", "B"),
    ]);
    // B 未读也不当锚（软删）；C 的链穿过 B 找到 A。
    const anchors = resolveStackAnchors(topology, relevanceOf(["A", "B", "C"], []));
    expect(anchors.get("C")).toBe("A");
    // 只有 B 未读（A 已读）：B 不作候选 → 各自自身。
    const deletedOnly = resolveStackAnchors(topology, relevanceOf(["B"], []));
    expect(deletedOnly.get("C")).toBe("C");
    expect(deletedOnly.get("B")).toBe("B");
  });

  test("④b 软删兜底判定经 relevance.isDeleted（拓扑缺 deleted_at）", () => {
    const topology = buildThreadTopology([pnode("A", null), pnode("B", "A"), pnode("C", "B")]);
    const relevance: NotificationRelevance = {
      isUnread: () => true,
      isNotified: () => true,
      isDeleted: (id) => id === "A",
    };
    const anchors = resolveStackAnchors(topology, relevance);
    expect(anchors.get("B")).toBe("B");
    expect(anchors.get("C")).toBe("B");
  });

  test("⑤ 拓扑缺失 → anchor=self 且不抛异常；highestUnreadAncestor 返回 null", () => {
    const topology = chainTopology();
    const relevance = relevanceOf(["A", "B"], ["A", "B"]);
    const anchors = resolveStackAnchors(topology, relevance);
    expect(anchors.has("Z")).toBe(false);
    expect(highestUnreadAncestor(topology, "Z", relevance)).toBeNull();
    expect(highestUnreadAncestor(topology, "B", relevance)).toBe("A");
  });

  test("⑥ 100 节点链一次线性 DP：relevance 调用 ≤ 2×V", () => {
    const nodes: ThreadTopologyNode[] = [];
    let parent: string | null = null;
    for (let index = 0; index < 100; index += 1) {
      const id = `n${String(index).padStart(3, "0")}`;
      nodes.push({ id, parent_id: parent, root_id: "n000", deleted_at: null, created_at: index, seq: index });
      parent = id;
    }
    const topology = buildThreadTopology(nodes);
    let unreadCalls = 0;
    let notifiedCalls = 0;
    const unread = new Set([nodes[10]!.id, nodes[99]!.id]);
    const anchors = resolveStackAnchors(topology, {
      isUnread: (id) => {
        unreadCalls += 1;
        return unread.has(id);
      },
      isNotified: (id) => {
        notifiedCalls += 1;
        return true;
      },
    });
    expect(anchors.get("n099")).toBe("n010");
    expect(unreadCalls).toBeLessThanOrEqual(100);
    expect(notifiedCalls).toBeLessThanOrEqual(100);
  });

  test("⑦ N(p) 回退：全已读链 → 最靠根已通知帖", () => {
    const topology = chainTopology();
    const anchors = resolveStackAnchors(topology, relevanceOf([], ["A", "B", "C"]));
    expect(anchors.get("C")).toBe("A");
    // 未通知的中间节点不参与 N：B 未在通知集合 → C 的 N 仍是 A。
    const partial = resolveStackAnchors(topology, relevanceOf([], ["A", "C"]));
    expect(partial.get("C")).toBe("A");
    // C 自身已通知且祖先未通知 → N=C。
    const selfOnly = resolveStackAnchors(topology, relevanceOf([], ["C"]));
    expect(selfOnly.get("C")).toBe("C");
  });
});

// ── P1-3 分组 ───────────────────────────────────────────────────────────────

describe("buildNotificationStacks（P1-3）", () => {
  test("① 同链 3 成员 → 1 叠：size 3 / unread 3 / 摘要=最新未读", () => {
    const topology = chainTopology();
    const result = buildNotificationStacks({
      members: [member("A", 1), member("B", 2), member("C", 3)],
      topology,
      relevance: relevanceOf(["A", "B", "C"], ["A", "B", "C"]),
      isDeleted: NO_DELETED,
    });
    expect(result.stacks.length).toBe(1);
    const stack = stackOf(result, "A");
    expect(stack.key).toBe("stack:A");
    expect(stack.size).toBe(3);
    expect(stack.unreadCount).toBe(3);
    expect(stack.newestUnread?.targetId).toBe("C");
    expect(stack.representative.targetId).toBe("C");
    expect(stack.anchorLoaded).toBe(true);
    expect(stack.members.map((m) => m.targetId)).toEqual(["C", "B", "A"]);
    // 单成员行/多成员行判定依据。
    expect(stack.size >= 2).toBe(true);
  });

  test("② 同帖 post.created + thread.invited → 1 成员 / unread 1（成员构建）", () => {
    const events: NotificationEventLine[] = [
      {
        seq: 2, type: "thread.invited", actor: "manager", post_id: "B", root_id: "A",
        batch_id: "b", created_at: 2, payload: {},
      },
      {
        seq: 1, type: "post.created", actor: "manager", post_id: "B", root_id: "A",
        batch_id: "b", created_at: 1, payload: {},
      },
    ];
    const members = buildNotificationMembers({
      events,
      postOf: () => ({ deleted_at: null, body_md: "B" } as unknown as PostView),
      isRead: () => false,
    });
    expect(members.length).toBe(1);
    expect(members[0]!.events.length).toBe(2);
    expect(members[0]!.sortSeq).toBe(2);
    expect(members[0]!.event.type).toBe("post.created");
    expect(members[0]!.read).toBe(false);
  });

  test("③ 软删最新未读 → 成员剔除、摘要回退次新、unread−1、standalone 保留", () => {
    const topology = chainTopology();
    const result = buildNotificationStacks({
      members: [member("A", 1), member("B", 2), member("C", 3, { deleted: true })],
      topology,
      relevance: relevanceOf(["A", "B", "C"], ["A", "B", "C"]),
      isDeleted: (id) => id === "C",
    });
    const stack = stackOf(result, "A");
    expect(stack.size).toBe(2);
    expect(stack.unreadCount).toBe(2);
    expect(stack.newestUnread?.targetId).toBe("B");
    expect(stack.members.map((m) => memberRowId(m))).toEqual(["B", "A"]);
    expect(result.standalone.map((m) => m.targetId)).toEqual(["C"]);
  });

  test("④ 软删帖不进成员/锚点，standalone 保留供独立灰行", () => {
    const topology = chainTopology();
    // A 软删：不作为锚点候选（B/C 不能锚到 A）。
    const result = buildNotificationStacks({
      members: [member("A", 1, { deleted: true }), member("B", 2)],
      topology,
      relevance: relevanceOf([], []),
      isDeleted: (id) => id === "A",
    });
    expect(result.stacks.length).toBe(1);
    expect(stackOf(result, "B").size).toBe(1);
    expect(result.standalone.map((m) => m.targetId)).toEqual(["A"]);
  });

  test("⑤ 无 target 事件 → 独立行（不出现 notification-stack）", () => {
    const topology = chainTopology();
    const result = buildNotificationStacks({
      members: [member("A", 1), member(null, 2)],
      topology,
      relevance: relevanceOf(["A"], ["A"]),
      isDeleted: NO_DELETED,
    });
    expect(result.stacks.length).toBe(1);
    expect(result.standalone.length).toBe(1);
    expect(result.standalone[0]!.targetId).toBeNull();
  });

  test("⑥ 叠按最新 seq 排序；同叠成员 seq 降序", () => {
    const topology = buildThreadTopology([
      pnode("A", null),
      pnode("B", "A"),
      pnode("C", "B"),
      // 第二条链（独立根 P）：用于断言「叠按最新活动倒序」。
      pnode("P", null),
      pnode("Q", "P"),
    ]);
    const result = buildNotificationStacks({
      members: [member("A", 1), member("C", 9), member("B", 5), member("Q", 7)],
      topology,
      relevance: relevanceOf(["A", "B", "C", "P", "Q"], ["A", "B", "C", "P", "Q"]),
      isDeleted: NO_DELETED,
    });
    // A/B/C 同叠（anchor=A，最新 seq 9）；P/Q 同叠（anchor=P，最新 seq 7）。
    expect(result.stacks.map((stack) => stack.anchorId)).toEqual(["A", "P"]);
    expect(stackOf(result, "A").members.map((m) => m.targetId)).toEqual(["C", "B", "A"]);
    expect(stackOf(result, "P").members.map((m) => m.targetId)).toEqual(["Q"]);
  });

  test("⑦ 共同未读祖先的兄弟 → 同叠；共同祖先已读的兄弟 → 两叠（禁止「兄弟永不同叠」）", () => {
    const topology = chainTopology();
    const shared = buildNotificationStacks({
      members: [member("B", 3), member("D", 4)],
      topology,
      relevance: relevanceOf(["A", "B", "D"], ["A", "B", "D"]),
      isDeleted: NO_DELETED,
    });
    expect(shared.stacks.length).toBe(1);
    expect(stackOf(shared, "A").members.map((m) => m.targetId).sort()).toEqual(["B", "D"]);

    const split = buildNotificationStacks({
      members: [member("B", 3), member("D", 4)],
      topology,
      relevance: relevanceOf(["B", "D"], ["A", "B", "D"]),
      isDeleted: NO_DELETED,
    });
    expect(split.stacks.map((stack) => stack.anchorId).sort()).toEqual(["B", "D"]);
  });

  test("⑧ 全已读叠 anchor=N（最靠根已通知帖）且 scope 覆盖全部分支", () => {
    const topology = chainTopology();
    const result = buildNotificationStacks({
      members: [member("B", 3, { read: true }), member("D", 4, { read: true })],
      topology,
      relevance: relevanceOf([], ["A", "B", "D"]),
      isDeleted: NO_DELETED,
    });
    const stack = stackOf(result, "A");
    expect(stack.unreadCount).toBe(0);
    expect(stack.newestUnread).toBeNull();
    expect(stack.representative.targetId).toBe("D");
    const scope = topology.scopeOf(stack.anchorId)!;
    expect(scope.has("B")).toBe(true);
    expect(scope.has("D")).toBe(true);
    // 兄弟分支互不在对方的 scope 内（对比：取最新成员会漏掉兄弟）。
    expect(topology.scopeOf("D")!.has("B")).toBe(false);
  });

  test("锚点未加载：anchorLoaded=false，成员仍成叠（点击仍去锚点）", () => {
    const topology = chainTopology();
    const result = buildNotificationStacks({
      members: [member("B", 3), member("C", 4)],
      topology,
      relevance: relevanceOf(["A", "B", "C"], ["A", "B", "C"]),
      isDeleted: NO_DELETED,
    });
    const stack = stackOf(result, "A");
    expect(stack.anchorLoaded).toBe(false);
    expect(stack.size).toBe(2);
  });

  test("拓扑缺失（lineage 未回）：成员各自 self 锚点，不抛异常", () => {
    const result = buildNotificationStacks({
      members: [member("A", 1), member("B", 2), member("C", 3)],
      topology: null,
      relevance: relevanceOf(["A", "B", "C"], ["A", "B", "C"]),
      isDeleted: NO_DELETED,
    });
    expect(result.stacks.map((stack) => stack.anchorId)).toEqual(["C", "B", "A"]);
  });
});

// ── P1-4 一致性契约（design §11.3）──────────────────────────────────────────

describe("contract（同叠 ⇔ 从最早未读打开的 timeline 包含叠内全部未读成员）", () => {
  function contractFixture(unreadIds: string[], notifiedIds: string[], memberIds: string[]) {
    const topology = chainTopology();
    const unread = new Set(unreadIds);
    const notified = new Set(notifiedIds);
    const result = buildNotificationStacks({
      members: memberIds.map((id, index) => member(id, index + 1, { read: !unread.has(id) })),
      topology,
      relevance: { isUnread: (id) => unread.has(id), isNotified: (id) => notified.has(id) },
      isDeleted: NO_DELETED,
    });
    contractCheck(topology, result, unread, notified);
    return { topology, result };
  }

  test("契约 1+2：同叠 ⇔ timeline 包含（未读集合等价）", () => {
    contractFixture(["A", "B", "C", "D"], ["A", "B", "C", "D", "E"], ["A", "B", "C", "D"]);
    contractFixture(["B", "D", "H"], ["A", "B", "D", "E", "G", "H"], ["B", "D", "H"]);
    contractFixture(["A", "C", "H"], ["A", "C", "G", "H"], ["A", "C", "H"]);
  });

  test("契约 3a：共同祖先 A 未读的兄弟 → 同叠且 scopeOf(A) 含双方", () => {
    const { topology, result } = contractFixture(["A", "B", "D"], ["A", "B", "D"], ["B", "D"]);
    const stack = stackOf(result, "A");
    expect(stack.size).toBe(2);
    const scope = topology.scopeOf("A")!;
    expect(scope.has("B")).toBe(true);
    expect(scope.has("D")).toBe(true);
  });

  test("契约 3b：无共同未读祖先的兄弟 → 分叠且互不在对方 scope", () => {
    const { topology, result } = contractFixture(["B", "D"], ["A", "B", "D"], ["B", "D"]);
    expect(result.stacks.length).toBe(2);
    expect(topology.scopeOf("B")!.has("D")).toBe(false);
    expect(topology.scopeOf("D")!.has("B")).toBe(false);
  });

  test("契约 3c：深链未读（8 层）→ 全部锚到最靠根未读，且 scope 覆盖全链", () => {
    const nodes: ThreadTopologyNode[] = [];
    let parent: string | null = null;
    const ids: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const id = `d${index}`;
      nodes.push({ id, parent_id: parent, root_id: "d0", deleted_at: null, created_at: index, seq: index });
      parent = id;
      ids.push(id);
    }
    const topology = buildThreadTopology(nodes);
    const unread = new Set(ids);
    const result = buildNotificationStacks({
      members: ids.map((id, index) => member(id, index + 1)),
      topology,
      relevance: { isUnread: (id) => unread.has(id), isNotified: () => true },
      isDeleted: NO_DELETED,
    });
    expect(result.stacks.length).toBe(1);
    expect(stackOf(result, "d0").size).toBe(8);
    contractCheck(topology, result, unread, new Set(ids));
  });

  test("契约 3d：中间软删 → 链路不断，锚点穿过删除节点", () => {
    const topology = buildThreadTopology([
      pnode("A", null),
      pnode("B", "A", { deleted: true }),
      pnode("C", "B"),
      pnode("D", "C"),
    ]);
    const unread = new Set(["A", "C", "D"]);
    const result = buildNotificationStacks({
      members: [member("A", 1), member("C", 3), member("D", 4)],
      topology,
      relevance: { isUnread: (id) => unread.has(id), isNotified: () => true },
      isDeleted: (id) => id === "B",
    });
    expect(result.stacks.length).toBe(1);
    expect(stackOf(result, "A").size).toBe(3);
    contractCheck(topology, result, unread, new Set(["A", "C", "D"]));
  });

  test("契约 3e：缺父（拓扑只含自身）→ anchor=self，不抛异常", () => {
    const topology = buildThreadTopology([pnode("X", "missing-parent")]);
    const unread = new Set(["X"]);
    const result = buildNotificationStacks({
      members: [member("X", 1)],
      topology,
      relevance: { isUnread: (id) => unread.has(id), isNotified: () => true },
      isDeleted: NO_DELETED,
    });
    expect(result.stacks.length).toBe(1);
    expect(stackOf(result, "X").anchorId).toBe("X");
  });

  test("契约 4：planner 交叉验证——叠内每个未读成员出现在 plan.rows（兄弟分支不出现）", () => {
    const topology = chainTopology();
    const unread = new Set(["A", "B", "C"]);
    const result = buildNotificationStacks({
      members: [member("A", 1), member("B", 2), member("C", 3)],
      topology,
      relevance: { isUnread: (id) => unread.has(id), isNotified: () => true },
      isDeleted: NO_DELETED,
    });
    const stack = stackOf(result, "A");
    const view = syntheticThreadView(topology);
    const plan = planForThreadView(view, stack.anchorId)!;
    const rowIds = new Set(
      plan.rows.filter((row) => row.kind === "post").map((row) => (row as { node: { id: string } }).node.id),
    );
    for (const m of stack.unreadMembers) {
      expect(rowIds.has(m.targetId!)).toBe(true);
    }
    // 焦点＝最早未读（不是最新成员）。
    const focalRow = plan.rows.find((row) => row.kind === "post" && row.role === "focal");
    expect((focalRow as { node: { id: string } }).node.id).toBe("A");
  });

  test("契约 4b：共同祖先已读的兄弟 → 点 B 的 plan 不含 D", () => {
    const topology = chainTopology();
    const unread = new Set(["B", "D"]);
    const result = buildNotificationStacks({
      members: [member("B", 3), member("D", 4)],
      topology,
      relevance: { isUnread: (id) => unread.has(id), isNotified: () => true },
      isDeleted: NO_DELETED,
    });
    const bStack = stackOf(result, "B");
    const plan = planForThreadView(syntheticThreadView(topology), bStack.anchorId)!;
    const rowIds = new Set(
      plan.rows.filter((row) => row.kind === "post").map((row) => (row as { node: { id: string } }).node.id),
    );
    expect(rowIds.has("B")).toBe(true);
    expect(rowIds.has("D")).toBe(false);
  });

  test("契约 5：全已读叠 N 锚点覆盖全部成员（首屏可达集合；无「跳最新」入口）", () => {
    const topology = chainTopology();
    const notified = new Set(["A", "B", "D", "E", "H"]);
    const result = buildNotificationStacks({
      members: ["B", "D", "H"].map((id, index) => member(id, index + 1, { read: true })),
      topology,
      relevance: { isUnread: () => false, isNotified: (id) => notified.has(id) },
      isDeleted: NO_DELETED,
    });
    const stack = stackOf(result, "A");
    expect(stack.anchorId).toBe("A");
    const scope = topology.scopeOf(stack.anchorId)!;
    for (const m of stack.members) {
      expect(scope.has(m.targetId!)).toBe(true);
      expect(m.read).toBe(true);
    }
    // 「跳最新」变体不存在：叠只暴露 anchorId/representative，无 latestId 之类的入口。
    expect(Object.keys(stack).sort()).toEqual(
      [
        "anchorId", "anchorLoaded", "key", "members", "newestUnread", "representative",
        "rootId", "size", "sortSeq", "unreadCount", "unreadMembers",
      ].sort(),
    );
  });

  test("契约 6：拓扑缺失时 anchor(x)===x 且不抛异常（成员构造也不抛）", () => {
    const unread = new Set(["A", "B"]);
    const result = buildNotificationStacks({
      members: [member("A", 1), member("B", 2)],
      topology: buildThreadTopology([]),
      relevance: { isUnread: (id) => unread.has(id), isNotified: () => true },
      isDeleted: NO_DELETED,
    });
    expect(result.stacks.map((stack) => stack.anchorId).sort()).toEqual(["A", "B"]);
  });
});

// ── P2-1 增量分类 ───────────────────────────────────────────────────────────

describe("diffNotificationStacks", () => {
  test("grow / new / merge / reanchor / splits 分类", () => {
    const a = member("A", 1);
    const b = member("B", 2);
    const d = member("D", 3);
    const stack = (key: string, members: NotificationMember[]): NotificationStack => ({
      key,
      anchorId: key.replace("stack:", ""),
      rootId: "A",
      members,
      unreadMembers: members.filter((m) => !m.read),
      size: members.length,
      unreadCount: members.filter((m) => !m.read).length,
      sortSeq: members[0]!.sortSeq,
      newestUnread: members.find((m) => !m.read) ?? null,
      representative: members[0]!,
      anchorLoaded: true,
    });
    const prev = [stack("stack:B", [b]), stack("stack:D", [d])];
    // grow：B 叠多一个成员。
    const grown = [stack("stack:B", [b, a]), stack("stack:D", [d])];
    const growDiff = diffNotificationStacks(prev, grown);
    expect(growDiff.transitions.get("stack:B")).toBe("grow");
    expect(growDiff.transitions.get("stack:D")).toBe("stable");
    // merge：B、D 两叠合并到 A（新未读祖先）。
    const merged = [stack("stack:A", [d, b])];
    const mergeDiff = diffNotificationStacks(prev, merged);
    expect(mergeDiff.transitions.get("stack:A")).toBe("merge");
    expect(mergeDiff.merges).toBe(1);
    expect(mergeDiff.splits).toBe(0);
    // reanchor：同一叠换锚。
    const reanchored = [stack("stack:A", [b]), stack("stack:D", [d])];
    expect(diffNotificationStacks(prev, reanchored).transitions.get("stack:A")).toBe("reanchor");
    // splits：单叠拆成两叠。
    const split = [stack("stack:B", [b]), stack("stack:D", [d])];
    const splitDiff = diffNotificationStacks([stack("stack:A", [b, d])], split);
    expect(splitDiff.splits).toBe(1);
    // new：首见（prev 为 null 由页面处理；这里给空 prev）。
    expect(diffNotificationStacks([], [stack("stack:E", [member("E", 9)])]).transitions.get("stack:E")).toBe("new");
  });
});

// ── planner fixtures ────────────────────────────────────────────────────────

/** 由拓扑行构造 `ThreadView`（planner 交叉验证用；字段按 ThreadNode 形状齐备）。 */
function syntheticThreadView(topology: ThreadTopology): ThreadView {
  const posts: ThreadNode[] = [];
  for (const node of topology.byId.values()) {
    posts.push({
      id: node.id,
      author: "manager",
      body_md: `${node.id} 正文`,
      parent_id: node.parent_id,
      root_id: node.root_id,
      self_thread_id: node.id,
      self_thread_is_leaf: 0,
      reply_to_account_id: null,
      quoted_post_id: null,
      tags: [],
      created_at: node.created_at ?? 0,
      seq: node.seq ?? 0,
      batch_id: "b",
      deleted_at: node.deleted_at,
      author_account: null,
      media: [],
      reply_count: 0,
      quoted: null,
      quoted_visible: false,
      previews: [],
      read: false,
      read_at: null,
      depth: 0,
      is_spine: false,
      is_self_continuation: false,
      child_count: [...topology.byId.values()].filter((row) => row.parent_id === node.id).length,
    } as ThreadNode);
  }
  return {
    root_id: "A",
    focal_id: null,
    spine_complete: true,
    posts,
    collapsed: [],
    participants: ["manager"],
    as_of_seq: 99,
  };
}

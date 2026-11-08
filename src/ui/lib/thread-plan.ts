/**
 * 平铺 timeline planner（design report-thread-timeline §2 / report-thread-scope §1-§4 /
 * report-thread-nesting §2）。
 *
 * 一个平面、一条 trunk、一个**先序**：可见祖先链（root → parent）→ focal → focal 的后代，
 * 按父子相邻的先序（pre-order DFS）平铺——每个节点的子节点按 `(created_at, seq, id)` 升序，
 * 每条先输出自身、紧接着递归输出它自己的子树，子树结束后再继续同级的下一条。没有任何缩进/
 * 深度上限/层级控件；关系由「紧邻 + 导轨 + 回复给 @x」表达。
 *
 * 作用域（report-thread-scope）：只有 focal 的后代（沿 parent_id 从 focal 可达）才是本页的
 * 「回复」。同根兄弟分支（既不是 focal 的祖先、也不是 focal 的后代）不进入本页；focal 是 root
 * 时后代集自然等于其余全部节点，行为与「整棵会话」一致（父帖缺失的 orphan 占位追加在可达
 * 先序结果之后）。
 */
import type { ThreadNode, ThreadView } from "@core/types";

export type PostRole = "ancestor" | "focal" | "reply";

export interface PostRow {
  kind: "post";
  key: string;
  node: ThreadNode;
  role: PostRole;
  /** 连续同作者父子：24px 头像居中于 42px 列、无重复作者行/操作栏。 */
  compact: boolean;
  /** 连续自接链首条仍显示作者/时间。 */
  compactHeader: boolean;
  /** 父帖不是上一 post 行时的「回复给 @x」（focal 永不为真）。 */
  replyingTo: string | null;
}

export interface SubthreadRow {
  kind: "subthread";
  key: string;
  nodeId: string;
  count: number;
}

export type PlanRow = PostRow | SubthreadRow;

export interface TimelinePlan {
  rows: PlanRow[];
  replyNodes: ThreadNode[];
  /** 顶部缺口行要跳转的（上一批）帖子 id；null = 不渲染缺口行。 */
  gapParentId: string | null;
  /** 是否有缺口行（深链 focal 的父帖不可解析 / 祖先超过 20 条 UI 阈值）。 */
  gapVisible: boolean;
}

function compareNodes(a: ThreadNode, b: ThreadNode): number {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const ANCESTOR_RENDER_LIMIT = 20;

export interface BuildTimelinePlanArgs {
  focal: ThreadNode;
  ancestors: ThreadNode[];
  nodes: ThreadNode[];
  nodeMap: Map<string, ThreadNode>;
  collapsedCounts: Map<string, number>;
  /** thread.posts 不含 focal（深链超 maxDepth）：focal 是单帖合成。 */
  deepGap: boolean;
  /** focal.parent_id 解析不到（posts 里没有）：整页只能显示缺口 + focal。 */
  unresolvedGap: boolean;
  /** 完整线程是否已从网络回来；未回来时不得生成「查看该子线程」入口。 */
  loaded: boolean;
}

/**
 * focal 的后代集（不含 focal，也不含祖先链），按**先序（pre-order DFS）**展开：
 * 从 nodes 建 parent→children（子节点按 `(created_at, seq, id)` 升序），沿 parent_id
 * 从 focal 出发，每个节点先输出自身、再紧接着输出它的子树，子树结束后继续同级。
 *
 * - focal 是 root 时即其余全部节点；父帖缺失的 orphan 占位不在可达树里，作为独立子树按
 *   时间序追加在可达先序结果之后（report-thread-scope：root 页仍渲染其余全部节点）。
 * - `seen` 防脏数据成环；`ancestorSet` 排除保证「祖先/后代」永不重叠（环回到祖先时只跳过
 *   祖先自身，其子节点仍展开）。
 */
function collectFocalDescendants(
  focal: ThreadNode,
  nodes: ThreadNode[],
  ancestorSet: Set<string>,
  includeUnreachable: boolean,
): ThreadNode[] {
  const childrenByParent = new Map<string, ThreadNode[]>();
  for (const node of nodes) {
    if (!node.parent_id) continue;
    const list = childrenByParent.get(node.parent_id);
    if (list) list.push(node);
    else childrenByParent.set(node.parent_id, [node]);
  }
  for (const list of childrenByParent.values()) list.sort(compareNodes);

  const descendants: ThreadNode[] = [];
  const seen = new Set<string>([focal.id]);
  const stack: ThreadNode[] = [];
  // 逆序入栈 ⇒ 弹出的第一个是时间最早的孩子；孩子的子树在栈顶，先于兄弟被处理。
  const pushChildren = (parentId: string) => {
    const kids = childrenByParent.get(parentId);
    if (!kids) return;
    for (let index = kids.length - 1; index >= 0; index -= 1) stack.push(kids[index]!);
  };
  const drain = () => {
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (!ancestorSet.has(node.id)) descendants.push(node);
      pushChildren(node.id);
    }
  };

  pushChildren(focal.id);
  drain();

  if (includeUnreachable) {
    // root 页的 orphan 占位（parent_id 不在 posts 里）不可从 focal 达：作为独立子树追加。
    const leftovers = nodes
      .filter(
        (node) => node.id !== focal.id && !ancestorSet.has(node.id) && !seen.has(node.id),
      )
      .sort(compareNodes);
    for (const node of leftovers) {
      if (seen.has(node.id)) continue;
      stack.push(node);
      drain();
    }
  }
  return descendants;
}

export function buildTimelinePlan(args: BuildTimelinePlanArgs): TimelinePlan {
  const { focal, ancestors, nodes, nodeMap, collapsedCounts, deepGap, unresolvedGap, loaded } = args;
  const ancestorSet = new Set(ancestors.map((node) => node.id));

  // 祖先：root → … → parent；>20 条只渲染最近 20 条，顶部补缺口行（§5.1）。
  // 缺口行跳到「被丢弃的最后一条祖先」（= 最近可见祖先的上一帖），不是它的 parent。
  const ordered = ancestors.slice().reverse();
  let visible = ordered;
  let gapVisible = false;
  let gapParentId: string | null = null;
  if (ordered.length > ANCESTOR_RENDER_LIMIT) {
    const dropped = ordered.slice(0, ordered.length - ANCESTOR_RENDER_LIMIT);
    visible = ordered.slice(-ANCESTOR_RENDER_LIMIT);
    gapVisible = true;
    gapParentId = dropped[dropped.length - 1]?.id ?? null;
  }
  if (unresolvedGap) {
    // focal 的父帖都没随本页返回：让缺口行指向父帖详情（点进去继续上级上下文）。
    gapVisible = true;
    gapParentId = focal.parent_id;
  }

  const loadedDirect = new Map<string, number>();
  for (const node of nodes) {
    if (!node.parent_id) continue;
    loadedDirect.set(node.parent_id, (loadedDirect.get(node.parent_id) ?? 0) + 1);
  }

  // 子线程入口数量：后端折叠优先，否则是「已知子节点里没随本页返回的部分」。
  const unloadedCount = (node: ThreadNode): number => {
    const collapsed = collapsedCounts.get(node.id) ?? 0;
    if (collapsed > 0) return collapsed;
    const loadedChildren = loadedDirect.get(node.id) ?? 0;
    return Math.max(0, node.child_count - loadedChildren);
  };

  const rows: PlanRow[] = [];
  const pushNode = (row: PostRow) => {
    rows.push(row);
    // 种子/骨架阶段 child_count 还不可信（seed 把它当 reply_count），不生成入口。
    if (!loaded) return;
    // 深链缺口模式下 focal 就是当前页，入口会指向自己 → 不渲染。
    if (row.role === "focal" && deepGap) return;
    const count = unloadedCount(row.node);
    if (count > 0) {
      rows.push({ kind: "subthread", key: `sub-${row.node.id}`, nodeId: row.node.id, count });
    }
  };

  for (const ancestor of visible) {
    pushNode({
      kind: "post",
      key: `a-${ancestor.id}`,
      node: ancestor,
      role: "ancestor",
      compact: false,
      compactHeader: false,
      // 祖先链内部父帖就是上一行（首条可能因为裁剪/缺口没有上文，不标）。
      replyingTo: null,
    });
  }

  pushNode({
    kind: "post",
    key: `f-${focal.id}`,
    node: focal,
    role: "focal",
    compact: false,
    compactHeader: false,
    replyingTo: null,
  });

  // 平铺回复＝focal 的后代（report-thread-scope），按父子相邻的先序展开
  // （report-thread-nesting）：子节点升序、先自身再子树、子树结束后继续同级。
  // 同根兄弟分支不是 focal 的后代，不进入本页。
  //
  // focal 是 root（parent_id === null）时取「其余全部节点」：整棵会话仍全部渲染，
  // 并保留 assembleThread 特意补渲染的 orphan 占位（parent_id 不在 posts 里但同属该 root，
  // 它们不可达，追加在可达先序结果之后）。
  //
  // 缺口模式（focal.parent_id 解析不到）下 posts 里全是「不可定位的上文」：
  // 它们既不是 focal 的祖先也不是 focal 的后代，平铺到 focal 下方会把拓扑反过来
  // （祖先显示成回复）。只保留缺口行说明，不再渲染这些行。
  const rest = unresolvedGap
    ? []
    : collectFocalDescendants(focal, nodes, ancestorSet, focal.parent_id === null);

  const replyNodes: ThreadNode[] = [];
  let prevPost: ThreadNode | null = focal;
  for (const node of rest) {
    const parentId = node.parent_id;
    const adjacent = parentId !== null && prevPost?.id === parentId;
    const compact = node.is_self_continuation && adjacent;
    const compactHeader = compact && !prevPost?.is_self_continuation;
    const replyingTo =
      parentId !== null && !adjacent
        ? (node.reply_to_account_id ?? nodeMap.get(parentId)?.author ?? parentId)
        : null;
    pushNode({
      kind: "post",
      key: `p-${node.id}`,
      node,
      role: "reply",
      compact,
      compactHeader,
      replyingTo,
    });
    replyNodes.push(node);
    prevPost = node;
  }

  return { rows, replyNodes, gapParentId, gapVisible };
}

/**
 * 由网络返回的完整 `ThreadView` 构建 planner 输出（静默刷新差集用）。
 *
 * 与渲染路径同规则：焦点优先取 `thread.posts`（`focal_id` → 路由 postId），深链超
 * maxDepth 时回退到调用方的合成焦点帖（`focalFallback`）。`loaded` 恒为 true——
 * 网络视图已经完整，允许生成子线程入口。
 */
export function planForThreadView(
  view: ThreadView,
  postId: string,
  focalFallback: ThreadNode | null = null,
): TimelinePlan | null {
  const nodes = view.posts;
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const focalId = view.focal_id ?? postId;
  const focal = nodeMap.get(focalId) ?? nodeMap.get(postId) ?? focalFallback;
  if (!focal) return null;

  const ancestors: ThreadNode[] = [];
  let cursor = focal.parent_id ? nodeMap.get(focal.parent_id) : undefined;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    ancestors.push(cursor);
    seen.add(cursor.id);
    cursor = cursor.parent_id ? nodeMap.get(cursor.parent_id) : undefined;
  }

  const collapsedCounts = new Map<string, number>();
  for (const group of view.collapsed ?? []) {
    collapsedCounts.set(group.parent_id, (collapsedCounts.get(group.parent_id) ?? 0) + group.count);
  }

  const deepGap = !nodeMap.has(focalId);
  return buildTimelinePlan({
    focal,
    ancestors,
    nodes,
    nodeMap,
    collapsedCounts,
    deepGap,
    unresolvedGap: Boolean(deepGap && focal.parent_id !== null && !nodeMap.has(focal.parent_id)),
    loaded: true,
  });
}

/** 子线程入口的隐藏回复数（按 nodeId；只含真正渲染出入口的行）。 */
function subthreadCounts(plan: TimelinePlan | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!plan) return map;
  for (const row of plan.rows) {
    if (row.kind === "subthread") map.set(row.nodeId, row.count);
  }
  return map;
}

/**
 * 相对上一份 plan，本次线程视图在**本页作用域内**新增的回复数（新回复胶囊口径）。
 *
 * - plan `replyNodes` 差集 = 会被本页渲染的新行；
 * - focal/其后代节点的子线程入口计数净增量 = 折叠/超 maxDepth 的新回复（同口径）；
 * - 同根兄弟分支的新增不计入（scope 收敛后点击胶囊不会「无行可显示」）。
 */
export function countAddedInScope(
  prev: TimelinePlan | null,
  next: TimelinePlan | null,
): number {
  if (!next) return 0;
  const knownReplies = new Set((prev?.replyNodes ?? []).map((node) => node.id));
  const addedReplies = next.replyNodes.filter((node) => !knownReplies.has(node.id)).length;

  // 作用域节点＝focal + 会被本页渲染的回复（不含祖先链：祖先的折叠增长可能来自兄弟分支）。
  const scope = new Set<string>();
  for (const row of next.rows) {
    if (row.kind === "post" && row.role !== "ancestor") scope.add(row.node.id);
  }
  if (scope.size === 0) return addedReplies;

  const prevHidden = subthreadCounts(prev);
  const nextHidden = subthreadCounts(next);
  let addedHidden = 0;
  for (const [nodeId, count] of nextHidden) {
    if (!scope.has(nodeId)) continue;
    addedHidden += Math.max(0, count - (prevHidden.get(nodeId) ?? 0));
  }
  return addedReplies + addedHidden;
}

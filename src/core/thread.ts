/**
 * Thread assembly (design §5.1, spec report-thread-model).
 *
 * Pure function over a *complete* post set for one root_id (the caller must fetch
 * every post of the conversation in one query — no per-level N+1).
 *
 * Output order is the render order expected by the UI:
 *   1. the spine (same-author / same-self-thread chain) from root to leaf,
 *   2. then, for each spine node in order, its branch subtrees (DFS, time order).
 * The spec scenario "自接链置顶" outranks design §5.1 step 4's per-node interleaving;
 * this function deliberately keeps the whole chain before branch content.
 */

export interface ThreadPostInput {
  id: string;
  author: string;
  parent_id: string | null;
  root_id: string;
  self_thread_id: string;
  created_at: number;
  deleted: boolean;
}

export interface ThreadNodeMeta {
  depth: number;
  is_spine: boolean;
  is_self_continuation: boolean;
  child_count: number;
  i?: number;
  n?: number;
}

export interface CollapsedGroup {
  parent_id: string;
  depth: number;
  count: number;
}

export interface AssembleOptions {
  focalId?: string | null;
  maxDepth?: number;
}

export interface AssembledThread<T> {
  nodes: Array<T & ThreadNodeMeta>;
  collapsed: CollapsedGroup[];
  spine_complete: boolean;
  spine_ids: string[];
}

function byTime<T extends ThreadPostInput>(a: T, b: T): number {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function assembleThread<T extends ThreadPostInput>(
  posts: T[],
  opts: AssembleOptions = {},
): AssembledThread<T> {
  const maxDepth = opts.maxDepth ?? 6;
  const focalId = opts.focalId ?? null;
  const byId = new Map<string, T>();
  const children = new Map<string, T[]>();
  for (const post of posts) {
    byId.set(post.id, post);
    if (post.parent_id) {
      const list = children.get(post.parent_id) ?? [];
      list.push(post);
      children.set(post.parent_id, list);
    }
  }
  for (const list of children.values()) list.sort(byTime);

  const root =
    posts.find((p) => p.parent_id === null && p.root_id === p.id) ??
    posts.find((p) => p.id === p.root_id) ??
    null;

  const empty: AssembledThread<T> = {
    nodes: [],
    collapsed: [],
    spine_complete: false,
    spine_ids: [],
  };
  if (!root) return empty;

  const containsCache = new Map<string, boolean>();
  const subtreeContains = (nodeId: string, target: string | null): boolean => {
    if (!target) return false;
    if (nodeId === target) return true;
    const cached = containsCache.get(nodeId);
    if (cached !== undefined) return cached;
    let found = false;
    for (const child of children.get(nodeId) ?? []) {
      if (subtreeContains(child.id, target)) {
        found = true;
        break;
      }
    }
    containsCache.set(nodeId, found);
    return found;
  };

  const spine: T[] = [root];
  const seen = new Set<string>([root.id]);
  let cur = root;
  for (;;) {
    const candidates = (children.get(cur.id) ?? []).filter(
      (k) => k.author === cur.author && k.self_thread_id === cur.self_thread_id && !seen.has(k.id),
    );
    if (candidates.length === 0) break;
    const next = candidates.find((k) => subtreeContains(k.id, focalId)) ?? candidates[0]!;
    spine.push(next);
    seen.add(next.id);
    cur = next;
  }

  const spineComplete = spine.every((p) => !p.deleted);
  const spineIndex = new Map<string, number>();
  spine.forEach((p, idx) => spineIndex.set(p.id, idx));
  const spineIds = spine.map((p) => p.id);

  const nodes: Array<T & ThreadNodeMeta> = [];
  const collapsed: CollapsedGroup[] = [];
  const collapsedIndex = new Map<string, CollapsedGroup>();
  const addCollapsed = (parentId: string, depth: number, count: number) => {
    if (count <= 0) return;
    const key = `${parentId}|${depth}`;
    const existing = collapsedIndex.get(key);
    if (existing) {
      existing.count += count;
      return;
    }
    const group: CollapsedGroup = { parent_id: parentId, depth, count };
    collapsedIndex.set(key, group);
    collapsed.push(group);
  };

  const emitNode = (post: T, depth: number, isSpine: boolean) => {
    const parent = post.parent_id ? byId.get(post.parent_id) : null;
    const meta: ThreadNodeMeta = {
      depth,
      is_spine: isSpine,
      is_self_continuation: Boolean(parent && parent.author === post.author),
      child_count: (children.get(post.id) ?? []).length,
    };
    if (spineComplete && spine.length >= 2) {
      const idx = spineIndex.get(post.id);
      if (idx !== undefined) {
        meta.i = idx + 1;
        meta.n = spine.length;
      }
    }
    nodes.push(Object.assign({}, post, meta) as T & ThreadNodeMeta);
  };

  const countDescendants = (postId: string): number => {
    let total = 0;
    for (const child of children.get(postId) ?? []) {
      total += 1 + countDescendants(child.id);
    }
    return total;
  };

  // 1) spine chain (whole chain before branches: "自接链置顶")
  let spineTruncated = false;
  for (let idx = 0; idx < spine.length; idx++) {
    const post = spine[idx]!;
    if (idx > maxDepth) {
      spineTruncated = true;
      break;
    }
    emitNode(post, idx, true);
  }

  const deepestEmittedSpine = spine[Math.min(spine.length - 1, maxDepth)];
  if (spineTruncated && deepestEmittedSpine) {
    // count the remainder of the chain itself
    const remaining = spine.length - (maxDepth + 1);
    addCollapsed(deepestEmittedSpine.id, maxDepth, remaining);
  }

  const emitBranch = (post: T, depth: number) => {
    if (depth > maxDepth) {
      addCollapsed(post.parent_id ?? root.id, maxDepth, 1 + countDescendants(post.id));
      return;
    }
    emitNode(post, depth, false);
    for (const child of children.get(post.id) ?? []) {
      if (spineIndex.has(child.id)) continue;
      emitBranch(child, depth + 1);
    }
  };

  // 2) branches, grouped after their spine anchor (spine nodes already emitted)
  const emittedSpine = spine.slice(0, Math.min(spine.length, maxDepth + 1));
  for (let idx = 0; idx < emittedSpine.length; idx++) {
    const anchor = emittedSpine[idx]!;
    for (const child of children.get(anchor.id) ?? []) {
      if (spineIndex.has(child.id)) continue;
      emitBranch(child, idx + 1);
    }
  }

  // Any node not reachable from the root (orphaned parent) is still rendered as a
  // top-level placeholder branch: visibility is root-scoped, so a missing ancestor
  // must not make replies disappear.
  const emitted = new Set(nodes.map((n) => n.id));
  for (const post of posts) {
    if (!emitted.has(post.id) && post.id !== root.id) {
      const parentMissing = post.parent_id !== null && !byId.has(post.parent_id);
      if (parentMissing) {
        emitBranch(post, Math.min(maxDepth, 1));
      }
    }
  }

  return { nodes, collapsed, spine_complete: spineComplete, spine_ids: spineIds };
}

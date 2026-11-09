/**
 * 通知叠放纯函数（report-notification-stacks design §3 / §11.2；无 React、无网络）。
 *
 * 一条会话里同一分支的连续回复不在通知页铺成 N 行：**共享同一叠锚点**的成员归为一叠。
 * 锚点＝`U(p) ?? N(p) ?? p`（`U`/`N` 都是「自身与祖先中最靠根的未读/已通知帖」，
 * 定义与 DP 在 `thread-plan.ts`，与线程 planner 同一套「祖先 + focal + 后代」语义）。
 *
 * - 软删帖不作成员/锚点候选，但通知行作为独立「此帖已删除」灰行保留（D9）；
 * - 无 target 的协议事件独立成行（`standalone`）；
 * - 同帖多条通知（`post.created` + `thread.invited`）只算 1 个成员；
 * - 分组在「history ∪ live」合并集合上做，成员可跨历史页（D10）。
 */
import type { NotificationEventLine, PostView } from "@core/types";
import {
  resolveStackAnchors,
  type NotificationRelevance,
  type ThreadTopology,
} from "@/lib/thread-plan";

export interface NotificationMember {
  /** null = 无 target 的协议事件（独立行） */
  targetId: string | null;
  post: PostView | null;
  deleted: boolean;
  /** 同一帖的全部事件，按 seq 降序 */
  events: NotificationEventLine[];
  /** 组内事件全部已读才算该帖已读（按帖粒度展示与计数） */
  read: boolean;
  /** 组内最大 seq（列表排序/角标同源） */
  sortSeq: number;
  /** 代表事件：`post.created` 优先（用于文案/时间） */
  event: NotificationEventLine;
}

export interface NotificationStack {
  /** 固定为 `stack:<anchorId>`（reanchor/split 会换 key → 卸载/挂载） */
  key: string;
  anchorId: string;
  rootId: string | null;
  /** seq 降序；已剔除软删成员 */
  members: NotificationMember[];
  unreadMembers: NotificationMember[];
  size: number;
  unreadCount: number;
  sortSeq: number;
  /** 最新一条未读（摘要来源）；全已读时为 null */
  newestUnread: NotificationMember | null;
  /** 前卡代表成员：未读取 newestUnread，全已读取 members[0] */
  representative: NotificationMember;
  /** 锚点自身是否已在已加载成员里（false 时点击仍去正确锚点，行内容渐进补全） */
  anchorLoaded: boolean;
}

export interface BuildNotificationStacksInput {
  /** history ∪ live，按 targetId 去重后的成员 */
  members: Iterable<NotificationMember>;
  /** 目标 id 并集（含未加载 history 行的未读 target）的祖先拓扑 */
  topology: ThreadTopology | null;
  /** 权威未读/已通知判定（provider 投影 − read-set） */
  relevance: NotificationRelevance;
  /** 软删判定（post 投影或 post.deleted 事件） */
  isDeleted(id: string): boolean;
}

/** 成员的行身份（诊断/展开定位/差分用）：有 target 用 target，无 target 用事件 seq。 */
export function memberRowId(member: NotificationMember): string {
  return member.targetId ?? `event:${member.sortSeq}`;
}

/**
 * 事件 → 成员（保留既有 `groupNotificationEvents` 的语义）：
 * - 同帖事件合并；`post.created` 优先作代表事件；`sortSeq` = 组内最大 seq；
 * - 帖子投影尚未取回（undefined）的组暂不发布（不闪现未分组行），
 *   删除态（null）发布为「已删除」成员（独立灰行）；
 * - 无 target 的事件按事件自身独立成成员。
 */
export function buildNotificationMembers(input: {
  events: Iterable<NotificationEventLine>;
  postOf(postId: string): PostView | null | undefined;
  isRead(targetId: string | null, seq: number): boolean;
}): NotificationMember[] {
  const groups = new Map<string, NotificationEventLine[]>();
  for (const event of input.events) {
    const targetId = event.post_id ?? event.root_id ?? null;
    const key = targetId ?? `event:${event.seq}`;
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }
  const members: NotificationMember[] = [];
  for (const group of groups.values()) {
    const head = group[0]!;
    const targetId = head.post_id ?? head.root_id ?? null;
    const post = targetId ? input.postOf(targetId) : null;
    if (targetId && typeof post === "undefined") continue;
    group.sort((a, b) => b.seq - a.seq);
    const representative = group.find((event) => event.type === "post.created") ?? group[0]!;
    members.push({
      targetId,
      post: post ?? null,
      deleted: post ? post.deleted_at !== null : Boolean(targetId),
      events: group,
      read: group.every((event) => input.isRead(targetId, event.seq)),
      sortSeq: group[0]!.seq,
      event: representative,
    });
  }
  return members.sort((a, b) => b.sortSeq - a.sortSeq);
}

/**
 * 分组（design §3.3）：共享锚点的成员归为一叠。软删/无 target 的成员进 `standalone`
 * （页面渲染为独立灰行/事件行），软删帖不参与叠与锚点候选。
 */
export function buildNotificationStacks(input: BuildNotificationStacksInput): {
  stacks: NotificationStack[];
  standalone: NotificationMember[];
} {
  const topology = input.topology;
  // 软删在 DP 里也必须排除（拓扑缺 deleted_at 时靠 post 投影/删除事件兜底）。
  const relevance: NotificationRelevance = {
    isUnread: (id) => !input.isDeleted(id) && input.relevance.isUnread(id),
    isNotified: (id) => !input.isDeleted(id) && input.relevance.isNotified(id),
    isDeleted: input.isDeleted,
  };
  const anchors = topology ? resolveStackAnchors(topology, relevance) : null;

  const groups = new Map<string, NotificationMember[]>();
  const standalone: NotificationMember[] = [];
  for (const member of input.members) {
    if (!member.targetId) {
      standalone.push(member);
      continue;
    }
    if (member.deleted) {
      standalone.push(member);
      continue;
    }
    const anchorId = anchors?.get(member.targetId) ?? member.targetId;
    const group = groups.get(anchorId);
    if (group) group.push(member);
    else groups.set(anchorId, [member]);
  }

  const stacks: NotificationStack[] = [];
  for (const [anchorId, members] of groups) {
    members.sort((a, b) => b.sortSeq - a.sortSeq);
    const unread = members.filter((member) => !member.read);
    const head = members[0]!;
    stacks.push({
      key: `stack:${anchorId}`,
      anchorId,
      rootId: head.post?.root_id ?? members.find((member) => member.post)?.post?.root_id ?? null,
      members,
      unreadMembers: unread,
      size: members.length,
      unreadCount: unread.length,
      sortSeq: head.sortSeq,
      newestUnread: unread[0] ?? null,
      representative: unread[0] ?? head,
      anchorLoaded: members.some((member) => member.targetId === anchorId),
    });
  }
  stacks.sort((a, b) => b.sortSeq - a.sortSeq);
  standalone.sort((a, b) => b.sortSeq - a.sortSeq);
  return { stacks, standalone };
}

export type StackTransition = "new" | "grow" | "stable" | "reanchor" | "merge";

export interface StackDiff {
  /** next stack key → 相对上一轮的过渡类型（stable 表示无变化） */
  transitions: Map<string, StackTransition>;
  merges: number;
  splits: number;
}

/**
 * 叠的增量分类（design §3.5 状态机；供 `data-stack-transition` 与诊断计数）：
 * - `new`：没有成员来自上一轮的叠；
 * - `grow`：key 不变且成员数增加；
 * - `reanchor`：成员全部来自同一个上一轮叠，但 key 变了；
 * - `merge`：成员来自 ≥2 个上一轮叠（两叠合并为一行）；
 * - `splits`：上一轮某个叠的成员在本轮落到 ≥2 个 key（读上下文与未读后代分开）。
 */
export function diffNotificationStacks(
  prev: readonly NotificationStack[] | null,
  next: readonly NotificationStack[],
): StackDiff {
  const transitions = new Map<string, StackTransition>();
  const prevKeyByMember = new Map<string, string>();
  for (const stack of prev ?? []) {
    for (const member of stack.members) prevKeyByMember.set(memberRowId(member), stack.key);
  }
  let merges = 0;
  const nextKeysByPrevKey = new Map<string, Set<string>>();
  for (const stack of next) {
    const prevKeys = new Set<string>();
    for (const member of stack.members) {
      const prevKey = prevKeyByMember.get(memberRowId(member));
      if (!prevKey) continue;
      prevKeys.add(prevKey);
      const bucket = nextKeysByPrevKey.get(prevKey);
      if (bucket) bucket.add(stack.key);
      else nextKeysByPrevKey.set(prevKey, new Set([stack.key]));
    }
    let transition: StackTransition;
    if (prevKeys.size === 0) transition = "new";
    else if (prevKeys.size > 1) {
      transition = "merge";
      merges += 1;
    } else {
      const only = [...prevKeys][0]!;
      const prevSize = (prev ?? []).find((stack) => stack.key === only)?.size ?? 0;
      transition = only === stack.key ? (stack.size > prevSize ? "grow" : "stable") : "reanchor";
    }
    transitions.set(stack.key, transition);
  }
  let splits = 0;
  for (const keys of nextKeysByPrevKey.values()) {
    if (keys.size > 1) splits += 1;
  }
  return { transitions, merges, splits };
}

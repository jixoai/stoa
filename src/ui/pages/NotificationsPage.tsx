/**
 * 通知页（report-notification-stacks）：**按会话链叠放**的历史列表。
 *
 * 一条会话里同一分支的连续回复不再铺成 N 行：共享同一「叠锚点」的成员渲染为一行
 * （层叠前卡 + 展开成员列表）；单成员行沿用既有 DOM（D8，兼容既有 QA 与视觉基线）。
 * 点击叠行打开**最早一条未读**（focal＝锚点，不是最新成员）；全已读叠打开最靠根的
 * 已通知帖（上下文回看，D12）。点击**不写已读**（D11）——读由 read-dwell 的视窗停留
 * 逐条转已读，叠自然收缩；「全部已读」仍是唯一推进服务端游标的路径。
 *
 * 已读语义（report-server-read-state）：按帖已读（服务端 `post_reads` + 本地乐观
 * read-set + 游标三源合并）。软删帖不作叠成员/锚点：其通知行作为独立「此帖已删除」
 * 灰行保留在历史（D9/Q1：保留、不可点/不可展开）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NotificationEventLine, NotificationHistoryLine, PostView } from "@core/types";
import { BellOffIcon, CheckCheckIcon, ChevronDownIcon, ChevronUpIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { PageHeader } from "@/components/PageHeader";
import { AuthorAvatar, AuthorLine } from "@/components/AuthorAvatar";
import { markSharedSubject } from "@/lib/shared-element";
import { Markdown } from "@/components/Markdown";
import {
  buildNotificationMembers,
  buildNotificationStacks,
  diffNotificationStacks,
  memberRowId,
  type NotificationMember,
  type NotificationStack,
  type StackDiff,
} from "@/lib/notification-stacks";
import { useConnection } from "@/state/connection";
import { useNotifications } from "@/state/notifications";
import { navigate } from "@/lib/router";
import { postHref } from "@/lib/post-href";
import { articleSummary } from "@core/article";
import { toastReadOnly } from "@/lib/readonly";
import { dateTimeShort } from "@/lib/format";
import { cn } from "cn";

const HISTORY_PAGE_SIZE = 50;

/** 诊断快照（P2-3；只读，不参与业务）。 */
export interface NotificationStacksDiagnostics {
  enabled: boolean;
  stacks: number;
  members: number;
  standalone: number;
  unreadTargets: number;
  lineageNodes: number;
  lineageRequests: number;
  lineageFailures: number;
  lastGroupMs: number;
  recomputes: number;
  merges: number;
  splits: number;
}

declare global {
  interface Window {
    __reportNotificationStacks?: NotificationStacksDiagnostics;
  }
}

function eventText(event: NotificationEventLine, post: PostView | null): string {
  if (event.type === "thread.invited") return "邀请你加入了会话";
  const payload = (event.payload ?? {}) as { parent_id?: string | null; quoted_post_id?: string | null };
  if (post?.quoted_post_id || payload.quoted_post_id) return "引用了帖子";
  if (post?.parent_id || payload.parent_id) return "回复了帖子";
  return "发布了新帖";
}

/** 通知行正文片段（report-longform §4.3）：article 用 title/excerpt 纯文本，不渲染全文。 */
function notificationSnippet(post: PostView): string {
  if (post.kind !== "article") return post.body_md;
  const summary = articleSummary(post.body_md);
  return summary.excerpt ? `${summary.title} — ${summary.excerpt}` : summary.title;
}

/** 通知行摘要槽：note 保持既有 Markdown 片段；article 只出标题/摘要纯文本（永不进全文）。 */
function NotificationBody({ post, className }: { post: PostView; className?: string }) {
  if (post.kind === "article") {
    return (
      <div className={className} data-testid="notification-article-summary">
        {notificationSnippet(post)}
      </div>
    );
  }
  return (
    <div className={className}>
      <Markdown source={post.body_md} className="[&_p]:my-0" />
    </div>
  );
}

export function NotificationsPage() {
  const { client, account, accounts, staticMode } = useConnection();
  const notifications = useNotifications();
  const {
    refresh: refreshNotifications,
    ensurePosts,
    postOf,
    isRead,
    adoptServerReads,
    unreadTargets,
    notifiedTargets,
    topology,
    lineageOf,
    ensureLineage,
    lineageStats,
  } = notifications;
  /** 未读 / 全部（默认）：全部 = 历史列表，已读行照常显示。 */
  const [scope, setScope] = useState<"all" | "unread">("all");
  const [history, setHistory] = useState<NotificationHistoryLine[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyMoreError, setHistoryMoreError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  /** 展开状态按叠 key（=锚点）存储；key 变化（reanchor/split）后旧展开态自然丢弃。 */
  const [expandedStacks, setExpandedStacks] = useState<ReadonlySet<string>>(() => new Set());
  const nextBefore = useRef<number | null>(null);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const historyToken = useRef(0);

  // 分组诊断（P2-3）：渲染期只写 ref，不触发额外更新。
  const lastGroupMsRef = useRef(0);
  const recomputesRef = useRef(0);
  const mergeCountRef = useRef(0);
  const splitCountRef = useRef(0);
  const prevStacksRef = useRef<readonly NotificationStack[] | null>(null);
  const accountKey = `${client?.base ?? ""}|${account?.id ?? ""}`;
  const accountKeyRef = useRef(accountKey);

  const loadHistory = useCallback(
    async (reset: boolean) => {
      if (!client) return;
      if (!reset && (!hasMoreRef.current || nextBefore.current === null || loadingMoreRef.current)) {
        return;
      }
      loadingMoreRef.current = true;
      const token = ++historyToken.current;
      if (reset) setHistoryLoading(true);
      else setHistoryLoadingMore(true);
      try {
        const page = await client.notificationHistory({
          limit: HISTORY_PAGE_SIZE,
          before: reset ? null : nextBefore.current,
        });
        if (token !== historyToken.current) return;
        // 服务端历史的 read 先采纳（避免未 hydrate 的首帧误高亮；跨设备一致）。
        const serverReadTargets = page.events
          .filter((row) => row.read)
          .map((row) => row.post_id ?? row.root_id ?? null)
          .filter((id): id is string => typeof id === "string" && id.length > 0);
        if (serverReadTargets.length > 0) adoptServerReads(serverReadTargets);
        setHistory((prev) => {
          if (reset) return page.events;
          const seen = new Set(prev.map((row) => row.seq));
          return [...prev, ...page.events.filter((row) => !seen.has(row.seq))];
        });
        nextBefore.current = page.next_before;
        hasMoreRef.current = page.has_more;
        setHasMore(page.has_more);
        setHistoryMoreError(null);
      } catch (err) {
        if (token === historyToken.current) setHistoryMoreError((err as Error).message);
      } finally {
        if (token === historyToken.current) {
          loadingMoreRef.current = false;
          if (reset) setHistoryLoading(false);
          else setHistoryLoadingMore(false);
        }
      }
    },
    [client, adoptServerReads],
  );

  // 进入通知页只拉历史首页：未读/角标由 EventHub 增量 + provider 的 peek 对账维持，
  // 不再做「进页 re-peek」（report-event-hub P1-11）。
  useEffect(() => {
    if (staticMode) return;
    void loadHistory(true);
  }, [loadHistory, staticMode]);

  // 历史行的帖子投影（正文/删除态）由 provider 统一补拉，列表与详情共用一份缓存。
  useEffect(() => {
    if (history.length === 0) return;
    const ids = [
      ...new Set(
        history
          .map((row) => row.post_id ?? row.root_id ?? null)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    ensurePosts(ids);
  }, [history, ensurePosts]);

  // 停留在通知页时，实时新到达的行按需 hydrate（不在通知页时 0 次帖子正文请求）。
  useEffect(() => {
    if (notifications.liveEvents.length === 0) return;
    const ids = [
      ...new Set(
        notifications.liveEvents
          .map((event) => event.post_id ?? event.root_id ?? null)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    ensurePosts(ids);
  }, [notifications.liveEvents, ensurePosts]);

  /** 历史事件 ∪ provider 实时事件 → 成员（同帖多条提醒合并；角标同源）。 */
  const members = useMemo<NotificationMember[]>(() => {
    const bySeq = new Map<number, NotificationEventLine>();
    const serverRead = new Set<number>();
    for (const row of history) {
      bySeq.set(row.seq, row);
      if (row.read) serverRead.add(row.seq);
    }
    for (const event of notifications.liveEvents) {
      if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
    }
    return buildNotificationMembers({
      events: bySeq.values(),
      postOf,
      isRead: (targetId, seq) => serverRead.has(seq) || isRead(targetId, seq),
    });
  }, [history, notifications.liveEvents, postOf, isRead]);

  // 拓扑补拉：成员 target + 实时事件 target + 全部未读 target（锚点可能尚未加载）
  // 合并进 provider 的 150ms 批次（P1-5/§4.3：100 目标 1 次请求）。
  useEffect(() => {
    if (staticMode) return;
    const ids = new Set<string>();
    for (const member of members) if (member.targetId) ids.add(member.targetId);
    for (const event of notifications.liveEvents) {
      const target = event.post_id ?? event.root_id ?? null;
      if (target) ids.add(target);
    }
    for (const target of unreadTargets) ids.add(target);
    if (ids.size > 0) ensureLineage([...ids]);
  }, [members, notifications.liveEvents, unreadTargets, ensureLineage, staticMode]);

  /** 软删判定：post 投影（null = 已确认删除/不可见）优先，lineage 墓碑兜底。 */
  const isDeletedTarget = useCallback(
    (id: string) => {
      const post = postOf(id);
      if (post === null) return true;
      if (post) return post.deleted_at !== null;
      const node = lineageOf(id);
      return node ? node.deleted_at !== null : false;
    },
    [postOf, lineageOf],
  );

  const grouped = useMemo(() => {
    const started = typeof performance !== "undefined" ? performance.now() : Date.now();
    const result = buildNotificationStacks({
      members,
      topology,
      relevance: {
        isUnread: (id) => unreadTargets.has(id),
        isNotified: (id) => notifiedTargets.has(id),
      },
      isDeleted: isDeletedTarget,
    });
    const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
    lastGroupMsRef.current = Math.round((ended - started) * 100) / 100;
    recomputesRef.current += 1;
    return result;
  }, [members, topology, unreadTargets, notifiedTargets, isDeletedTarget]);
  const { stacks, standalone } = grouped;

  /** 叠的增量分类（P2-1/P2-2）：首帧不产生过渡高亮；滚动/展开不参与。 */
  const diff = useMemo<StackDiff>(() => {
    if (accountKeyRef.current !== accountKey) {
      accountKeyRef.current = accountKey;
      prevStacksRef.current = null;
    }
    if (prevStacksRef.current === null) {
      prevStacksRef.current = stacks;
      return { transitions: new Map(), merges: 0, splits: 0 };
    }
    const result = diffNotificationStacks(prevStacksRef.current, stacks);
    prevStacksRef.current = stacks;
    mergeCountRef.current += result.merges;
    splitCountRef.current += result.splits;
    return result;
  }, [stacks, accountKey]);

  // 账号切换：展开态/差分基线随投影重建（read-set 与 lineage 已由 provider 清空）。
  useEffect(() => {
    if (accountKeyRef.current === accountKey) return;
    accountKeyRef.current = accountKey;
    prevStacksRef.current = null;
    setExpandedStacks(new Set());
  }, [accountKey]);

  // 叠 key 消失（reanchor/split/dissolve）时丢弃其展开态，避免集合无界增长。
  useEffect(() => {
    setExpandedStacks((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(stacks.map((stack) => stack.key));
      let changed = false;
      const next = new Set<string>();
      for (const key of prev) {
        if (alive.has(key)) next.add(key);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [stacks]);

  const visibleEntries = useMemo(() => {
    const entries: Array<
      | { kind: "stack"; sortSeq: number; stack: NotificationStack }
      | { kind: "member"; sortSeq: number; member: NotificationMember }
    > = [];
    for (const stack of stacks) {
      if (scope === "unread" && stack.unreadCount === 0) continue;
      entries.push({ kind: "stack", sortSeq: stack.sortSeq, stack });
    }
    for (const member of standalone) {
      if (scope === "unread" && (member.deleted || member.read)) continue;
      entries.push({ kind: "member", sortSeq: member.sortSeq, member });
    }
    entries.sort((a, b) => b.sortSeq - a.sortSeq);
    return entries;
  }, [stacks, standalone, scope]);

  /** 页脚「还有 N 条未读」＝服务端未读 − 已加载未读 target 数（按 target，不按行）。 */
  const loadedUnreadTargets = useMemo(() => {
    const ids = new Set<string>();
    for (const stack of stacks) {
      for (const member of stack.unreadMembers) {
        if (member.targetId) ids.add(member.targetId);
      }
    }
    for (const member of standalone) {
      if (!member.deleted && !member.read && member.targetId) ids.add(member.targetId);
    }
    return ids.size;
  }, [stacks, standalone]);
  const unreadBeyondLoaded = Math.max(0, notifications.unread - loadedUnreadTargets);

  // 诊断（P2-3）：静态归档 enabled=false；数值与 DOM 计数一致（stacks/members）。
  useEffect(() => {
    window.__reportNotificationStacks = {
      enabled: !staticMode,
      stacks: stacks.length,
      members: stacks.reduce((total, stack) => total + stack.size, 0),
      standalone: standalone.length,
      unreadTargets: unreadTargets.size,
      lineageNodes: lineageStats.nodes,
      lineageRequests: lineageStats.requests,
      lineageFailures: lineageStats.failures,
      lastGroupMs: lastGroupMsRef.current,
      recomputes: recomputesRef.current,
      merges: mergeCountRef.current,
      splits: splitCountRef.current,
    };
  }, [staticMode, stacks, standalone, unreadTargets, lineageStats]);

  const actorOf = (event: NotificationEventLine) => accounts.find((row) => row.id === event.actor) ?? null;

  const refreshAll = () => {
    void refreshNotifications();
    void loadHistory(true);
  };

  const toggleStack = useCallback((key: string) => {
    setExpandedStacks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * 打开某帖：共享元素 + 导航；**不**写已读（D11，读由 read-dwell 的停留触发）。
   * 目标按载体分派（report-longform §4.1）：article → `#/a/<id>`；帖子投影未加载时
   * 缺省 note（`/a/<note>` 有回退，不会死链）。
   */
  const openPost = (host: HTMLElement, postId: string) => {
    markSharedSubject(host, postId);
    navigate(postHref({ id: postId, kind: postOf(postId)?.kind ?? "note" }));
  };

  /** 单成员叠（D8）：沿用既有行 DOM（notification-row + 全部 data-* 契约）。 */
  const renderSingleRow = (stack: NotificationStack) => {
    const member = stack.members[0]!;
    const event = member.event;
    const actor = actorOf(event);
    const mine = account?.id === event.actor;
    const transition = diff.transitions.get(stack.key);
    return (
      <div
        key={stack.key}
        role="button"
        tabIndex={0}
        data-testid={member.deleted ? "notification-deleted-row" : "notification-row"}
        data-shared-host
        data-post-id={member.deleted ? undefined : (member.targetId ?? undefined)}
        data-read={member.read ? "1" : "0"}
        data-seq={member.sortSeq}
        data-event-count={member.events.length}
        data-stack-key={member.deleted ? undefined : stack.key}
        data-stack-anchor={member.deleted ? undefined : stack.anchorId}
        data-stack-size={stack.size}
        data-stack-unread={stack.unreadCount}
        data-anchor-loaded={stack.anchorLoaded ? "1" : "0"}
        data-member-ids={member.targetId ?? undefined}
        data-unread-member-ids={!member.deleted && !member.read && member.targetId ? member.targetId : undefined}
        data-stack-transition={transition && transition !== "stable" ? transition : undefined}
        className={cn(
          "flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none",
          member.deleted && "cursor-default opacity-60 hover:bg-transparent",
          // 未读＝高亮；已读＝正常（不再整体降噪，历史始终可读）。
          !member.deleted && !member.read && "bg-primary/5 hover:bg-primary/10",
          transition && transition !== "stable" && "notification-stack-flash",
        )}
        onClick={(clickEvent) => {
          if (member.deleted || !stack.anchorId) return;
          if ((clickEvent.target as HTMLElement).closest("a,button")) return;
          openPost(clickEvent.currentTarget, stack.anchorId);
        }}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
          if ((keyEvent.target as HTMLElement).closest("a,button")) return;
          keyEvent.preventDefault();
          if (member.deleted || !stack.anchorId) return;
          openPost(keyEvent.currentTarget, stack.anchorId);
        }}
      >
        <div data-shared-avatar>
          <AuthorAvatar account={actor} fallbackId={event.actor} />
        </div>
        <div className="min-w-0 flex-1">
          <div data-shared-author>
            <AuthorLine account={actor} fallbackId={event.actor} />
          </div>
          <div className="mt-0.5 text-sm">
            <span className="font-medium">{eventText(event, member.post)}</span>
            <span className="ml-1 text-xs text-muted-foreground">{dateTimeShort(event.created_at)}</span>
            {mine ? (
              <Badge variant="outline" className="ml-2 align-middle">
                我
              </Badge>
            ) : null}
          </div>
          {member.deleted ? (
            <div className="mt-1 text-xs text-muted-foreground">此帖已删除</div>
          ) : member.post ? (
            <NotificationBody post={member.post} className="mt-1 line-clamp-2 text-sm text-muted-foreground" />
          ) : null}
        </div>
      </div>
    );
  };

  /** 叠的展开成员行（≥2 成员）：正文纯文本截断（不做 Markdown 渲染）。 */
  const renderMemberRow = (stack: NotificationStack, member: NotificationMember) => {
    const event = member.event;
    const actor = actorOf(event);
    const target = member.targetId;
    return (
      <div
        key={memberRowId(member)}
        role="button"
        tabIndex={0}
        data-testid="notification-stack-member"
        data-post-id={target ?? undefined}
        data-read={member.read ? "1" : "0"}
        data-seq={member.sortSeq}
        data-event-count={member.events.length}
        data-member-of={stack.key}
        className={cn(
          "flex w-full cursor-pointer items-start gap-2 px-4 py-2 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none",
          member.read && scope === "all" && "opacity-70",
        )}
        onClick={(clickEvent) => {
          if ((clickEvent.target as HTMLElement).closest("a,button")) return;
          if (!target) return;
          // 成员行在叠容器内：阻止冒泡，否则外层会把导航改回 anchor（成员应打开自己的帖）。
          clickEvent.stopPropagation();
          openPost(clickEvent.currentTarget, target);
        }}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
          if ((keyEvent.target as HTMLElement).closest("a,button")) return;
          keyEvent.preventDefault();
          if (!target) return;
          keyEvent.stopPropagation();
          openPost(keyEvent.currentTarget, target);
        }}
      >
        <div className="pt-0.5">
          <AuthorAvatar account={actor} fallbackId={event.actor} size="tiny" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
            <span className="truncate font-medium">{actor?.display ?? event.actor}</span>
            <span className="shrink-0 text-muted-foreground">{eventText(event, member.post)}</span>
            <span className="shrink-0 text-muted-foreground">{dateTimeShort(event.created_at)}</span>
          </div>
          {member.post ? (
            <div className="truncate text-xs text-muted-foreground">
              {notificationSnippet(member.post)}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  /** 多成员叠行（≥2）：层叠前卡 + 展开区（grid-template-rows 0fr↔1fr 动画）。 */
  const renderStackRow = (stack: NotificationStack) => {
    const member = stack.representative;
    const event = member.event;
    const actor = actorOf(event);
    const mine = account?.id === event.actor;
    const expanded = expandedStacks.has(stack.key);
    const transition = diff.transitions.get(stack.key);
    const memberRows = scope === "unread" ? stack.unreadMembers : stack.members;
    const regionId = `notification-stack-members-${stack.anchorId}`;
    const distinctActors = [...new Set(stack.members.map((row) => row.event.actor))].slice(0, 3);
    const extraActors = new Set(stack.members.map((row) => row.event.actor)).size - distinctActors.length;
    return (
      <div
        key={stack.key}
        role="button"
        tabIndex={0}
        data-testid="notification-stack"
        data-shared-host
        data-stack-key={stack.key}
        data-stack-size={stack.size}
        data-stack-unread={stack.unreadCount}
        data-stack-anchor={stack.anchorId}
        data-anchor-loaded={stack.anchorLoaded ? "1" : "0"}
        data-member-ids={stack.members.map((row) => memberRowId(row)).join(",")}
        data-unread-member-ids={stack.unreadMembers
          .map((row) => row.targetId)
          .filter((id): id is string => typeof id === "string")
          .join(",")}
        data-stack-transition={transition && transition !== "stable" ? transition : undefined}
        className="relative cursor-pointer bg-transparent pt-2 focus-visible:outline-none"
        onClick={(clickEvent) => {
          if ((clickEvent.target as HTMLElement).closest("a,button")) return;
          openPost(clickEvent.currentTarget, stack.anchorId);
        }}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
          if ((keyEvent.target as HTMLElement).closest("a,button")) return;
          keyEvent.preventDefault();
          openPost(keyEvent.currentTarget, stack.anchorId);
        }}
      >
        {/* 层叠装饰（aria-hidden）：主题令牌、无 box-shadow（项目视觉纪律）。 */}
        <span
          aria-hidden="true"
          className="absolute inset-x-6 top-0 h-2 rounded-t-xl border border-b-0 border-border/60 bg-muted/40"
        />
        <span
          aria-hidden="true"
          className="absolute inset-x-3 top-1 h-2 rounded-t-xl border border-b-0 border-border/60 bg-muted/60"
        />
        <div
          data-testid="notification-stack-front"
          className={cn(
            "relative z-10 rounded-xl border border-border/60 bg-card px-4 py-3 transition-colors",
            stack.unreadCount > 0 && "hover:bg-primary/5",
            transition && transition !== "stable" && "notification-stack-flash",
          )}
        >
          <div className="flex w-full items-start gap-3">
            <div data-shared-avatar className="shrink-0">
              {distinctActors.length > 1 ? (
                <AvatarGroup>
                  {distinctActors.map((actorId) => (
                    <AuthorAvatar
                      key={actorId}
                      account={accounts.find((row) => row.id === actorId) ?? null}
                      fallbackId={actorId}
                      size="tiny"
                    />
                  ))}
                  {extraActors > 0 ? <AvatarGroupCount>+{extraActors}</AvatarGroupCount> : null}
                </AvatarGroup>
              ) : (
                <AuthorAvatar account={actor} fallbackId={event.actor} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div data-shared-author className="flex min-w-0 items-start gap-2">
                <div className="min-w-0 flex-1">
                  <AuthorLine account={actor} fallbackId={event.actor} />
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {stack.unreadCount > 0 ? (
                    <Badge
                      variant="secondary"
                      data-testid="notification-stack-unread"
                      aria-label={`${stack.unreadCount} 条未读`}
                      className="tabular-nums"
                    >
                      {stack.unreadCount}
                    </Badge>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-testid="notification-stack-toggle"
                    aria-expanded={expanded}
                    aria-controls={regionId}
                    aria-label={`${expanded ? "收起" : "展开"} ${stack.size} 条会话提醒`}
                    onClick={(clickEvent) => {
                      clickEvent.stopPropagation();
                      toggleStack(stack.key);
                    }}
                  >
                    {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
                  </Button>
                </div>
              </div>
              <div className="mt-0.5 text-sm">
                <span className="font-medium">{eventText(event, member.post)}</span>
                <span className="ml-1 text-xs text-muted-foreground">
                  {dateTimeShort(event.created_at)}
                </span>
                {mine ? (
                  <Badge variant="outline" className="ml-2 align-middle">
                    我
                  </Badge>
                ) : null}
              </div>
              {member.post ? (
                <NotificationBody post={member.post} className="mt-1 line-clamp-2 text-sm text-muted-foreground" />
              ) : null}
              <div className="mt-1 text-xs text-muted-foreground">
                共 {stack.size} 条会话提醒
                {!stack.anchorLoaded ? "（锚点更早的消息未加载）" : ""}
              </div>
            </div>
          </div>
        </div>
        <div
          id={regionId}
          data-testid="notification-stack-members-region"
          data-expanded={expanded ? "1" : "0"}
          className="notification-stack-expand"
        >
          <div className="overflow-hidden">
            <div
              className="divide-y divide-border/60 border-border/60"
              aria-hidden={expanded ? undefined : true}
              // 折叠态对读屏/键盘完全隐藏（grid 0fr 只做视觉裁剪）。
              inert={!expanded}
            >
              {memberRows.map((row) => renderMemberRow(stack, row))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  /** 独立行：软删灰行（D9/Q1）与无 target 的协议事件行。 */
  const renderStandaloneRow = (member: NotificationMember) => {
    const event = member.event;
    const actor = actorOf(event);
    const mine = account?.id === event.actor;
    if (member.deleted) {
      return (
        <div
          key={memberRowId(member)}
          data-testid="notification-deleted-row"
          data-deleted-post-id={member.targetId ?? undefined}
          data-seq={member.sortSeq}
          data-event-count={member.events.length}
          className="flex w-full cursor-default items-start gap-3 px-4 py-3 opacity-60"
        >
          <div>
            <AuthorAvatar account={actor} fallbackId={event.actor} />
          </div>
          <div className="min-w-0 flex-1">
            <AuthorLine account={actor} fallbackId={event.actor} />
            <div className="mt-0.5 text-sm">
              <span className="font-medium">{eventText(event, null)}</span>
              <span className="ml-1 text-xs text-muted-foreground">
                {dateTimeShort(event.created_at)}
              </span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">此帖已删除</div>
          </div>
        </div>
      );
    }
    return (
      <div
        key={memberRowId(member)}
        role="button"
        tabIndex={0}
        data-testid="notification-row"
        data-read={member.read ? "1" : "0"}
        data-seq={member.sortSeq}
        data-event-count={member.events.length}
        data-stack-size={1}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none",
          !member.read && "bg-primary/5 hover:bg-primary/10",
        )}
      >
        <div>
          <AuthorAvatar account={actor} fallbackId={event.actor} />
        </div>
        <div className="min-w-0 flex-1">
          <AuthorLine account={actor} fallbackId={event.actor} />
          <div className="mt-0.5 text-sm">
            <span className="font-medium">{eventText(event, null)}</span>
            <span className="ml-1 text-xs text-muted-foreground">{dateTimeShort(event.created_at)}</span>
            {mine ? (
              <Badge variant="outline" className="ml-2 align-middle">
                我
              </Badge>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const renderEntry = (entry: (typeof visibleEntries)[number]): ReactNode =>
    entry.kind === "stack"
      ? entry.stack.size >= 2
        ? renderStackRow(entry.stack)
        : renderSingleRow(entry.stack)
      : renderStandaloneRow(entry.member);

  const loadingFirstPage =
    visibleEntries.length === 0 &&
    (historyLoading || notifications.hydrating || (notifications.loading && !staticMode));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            通知
            {notifications.unread > 0 ? (
              <Badge variant="secondary" data-testid="notifications-unread-badge">
                {notifications.unread}
              </Badge>
            ) : null}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="icon-sm" aria-label="刷新通知" data-testid="notifications-refresh" onClick={refreshAll}>
              <RefreshCwIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="ack-notifications"
              aria-label="全部已读"
              title="全部已读"
              aria-disabled={staticMode || undefined}
              disabled={notifications.unread === 0}
              className={cn(staticMode && "opacity-60")}
              onClick={() => {
                if (staticMode) {
                  toastReadOnly();
                  return;
                }
                // ack 只清实时层；历史列表重新取一页，把刚到的行（可能还没进 history）
                // 落成已读历史，避免「全部已读」后列表反而变短。
                void notifications.ack().then(() => loadHistory(true));
              }}
            >
              <CheckCheckIcon />
            </Button>
          </>
        }
      >
        <Tabs value={scope} onValueChange={(value) => setScope(value === "unread" ? "unread" : "all")}>
          <TabsList variant="line" aria-label="通知筛选">
            <TabsTrigger value="all" data-testid="notifications-scope-all">
              全部
            </TabsTrigger>
            <TabsTrigger value="unread" data-testid="notifications-scope-unread">
              未读
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

      <div
        className="min-h-0 flex-1 overflow-y-auto p-3"
        data-testid="notifications-scroll"
        onScroll={(event) => {
          const el = event.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) void loadHistory(false);
        }}
      >
        {notifications.error ? (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{notifications.error}</AlertDescription>
          </Alert>
        ) : null}
        {historyMoreError ? (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{historyMoreError}</AlertDescription>
          </Alert>
        ) : null}

        {loadingFirstPage ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : visibleEntries.length === 0 ? (
          <Empty className="py-20" data-testid="notifications-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BellOffIcon />
              </EmptyMedia>
              <EmptyTitle>{scope === "unread" ? "没有未读通知" : "暂无通知"}</EmptyTitle>
              <EmptyDescription>
                {scope === "unread"
                  ? "已读通知都在「全部」里；有人发帖、回复或 @ 你时会产生新的未读提醒。"
                  : "有人发帖、回复或 @ 你时会出现在这里；已读提醒会一直保留。"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <Card className="gap-0 divide-y divide-border/60 p-0" data-testid="notification-list">
              {visibleEntries.map((entry) => renderEntry(entry))}
            </Card>

            <div className="mt-3 flex flex-col items-center gap-1" data-testid="notifications-history-footer">
              {unreadBeyondLoaded > 0 ? (
                <p
                  className="py-1 text-center text-xs text-muted-foreground"
                  data-testid="notifications-more-unread"
                >
                  还有 {unreadBeyondLoaded} 条未读（加载更早）
                </p>
              ) : null}
              {historyLoadingMore ? (
                <div className="flex flex-col gap-2 py-2" aria-label="正在加载更早通知">
                  {Array.from({ length: 2 }).map((_, index) => (
                    <Skeleton key={index} className="h-14 w-full rounded-xl" />
                  ))}
                </div>
              ) : hasMore ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="notifications-load-more"
                  onClick={() => void loadHistory(false)}
                >
                  <ChevronDownIcon data-icon="inline-start" />
                  加载更早
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

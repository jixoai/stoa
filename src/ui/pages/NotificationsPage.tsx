/**
 * 通知页：**历史列表**语义（对齐 X）——默认展示全部通知（已读正常显示、未读高亮），
 * 新事件仍由 provider 的 peek/SSE 增量并入；历史本身由 `GET /api/notifications/history`
 * 分页补齐（跨刷新/重载可见）。筛选「全部 / 未读」只是可选视图，默认不会被已读行藏掉。
 *
 * 已读语义：按帖已读（provider 的本端读集合 ∪ 服务端 ack 水位）；「全部已读」仍推进游标。
 * 静态归档只读：不拉写接口，历史为空时展示只读空态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NotificationEventLine, NotificationHistoryLine } from "@core/types";
import { BellOffIcon, CheckCheckIcon, ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/PageHeader";
import { AuthorAvatar, AuthorLine } from "@/components/AuthorAvatar";
import { markSharedSubject } from "@/lib/shared-element";
import { Markdown } from "@/components/Markdown";
import { useConnection } from "@/state/connection";
import { useNotifications, groupNotificationEvents, type NotificationItem } from "@/state/notifications";
import { navigate } from "@/lib/router";
import { toastReadOnly } from "@/lib/readonly";
import { dateTimeShort } from "@/lib/format";
import { cn } from "cn";

const HISTORY_PAGE_SIZE = 50;

function eventText(event: NotificationEventLine, item: NotificationItem): string {
  if (event.type === "thread.invited") return "邀请你加入了会话";
  const payload = (event.payload ?? {}) as { parent_id?: string | null; quoted_post_id?: string | null };
  if (item.post?.quoted_post_id || payload.quoted_post_id) return "引用了帖子";
  if (item.post?.parent_id || payload.parent_id) return "回复了帖子";
  return "发布了新帖";
}

export function NotificationsPage() {
  const { client, account, accounts, staticMode } = useConnection();
  const notifications = useNotifications();
  const { refresh: refreshNotifications, ensurePosts, postOf, isRead } = notifications;
  /** 未读 / 全部（默认）：全部 = 历史列表，已读行照常显示。 */
  const [scope, setScope] = useState<"all" | "unread">("all");
  const [history, setHistory] = useState<NotificationHistoryLine[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyMoreError, setHistoryMoreError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const nextBefore = useRef<number | null>(null);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const historyToken = useRef(0);

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
    [client],
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

  /** 历史事件 ∪ provider 实时事件，按帖子分组（同帖多条提醒一行；角标同源）。 */
  const rows = useMemo<NotificationItem[]>(() => {
    const bySeq = new Map<number, NotificationEventLine>();
    const serverRead = new Set<number>();
    for (const row of history) {
      bySeq.set(row.seq, row);
      if (row.read) serverRead.add(row.seq);
    }
    for (const event of notifications.liveEvents) {
      if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
    }
    return groupNotificationEvents(
      bySeq.values(),
      postOf,
      (targetId, seq) => serverRead.has(seq) || isRead(targetId, seq),
    );
  }, [history, notifications.liveEvents, postOf, isRead]);

  const visible = useMemo(
    () => (scope === "unread" ? rows.filter((row) => !row.deleted && !row.read) : rows),
    [rows, scope],
  );

  /** 已加载行里的未读数：服务端角标可能更大（分页/未 hydrate），用「还有 N 条」补齐。 */
  const unreadRowCount = useMemo(
    () => rows.filter((row) => !row.deleted && !row.read).length,
    [rows],
  );
  const unreadBeyondLoaded = Math.max(0, notifications.unread - unreadRowCount);

  const actorOf = (event: NotificationEventLine) => accounts.find((row) => row.id === event.actor) ?? null;

  const refreshAll = () => {
    void refreshNotifications();
    void loadHistory(true);
  };

  const renderRow = (item: NotificationItem) => {
    const { event, post, read } = item;
    const actor = actorOf(event);
    const mine = account?.id === event.actor;
    return (
      <div
        key={item.targetId ?? event.seq}
        role="button"
        tabIndex={0}
        data-testid={item.deleted ? "notification-deleted-row" : "notification-row"}
        data-shared-host
        data-post-id={item.targetId ?? undefined}
        data-read={read ? "1" : "0"}
        data-seq={item.sortSeq}
        data-event-count={item.events.length}
        className={cn(
          "flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none",
          item.deleted && "opacity-60",
          // 未读＝高亮；已读＝正常（不再整体降噪，历史始终可读）。
          !item.deleted && !read && "bg-primary/5 hover:bg-primary/10",
        )}
        onClick={(clickEvent) => {
          if ((clickEvent.target as HTMLElement).closest("a,button")) return;
          if (!item.targetId) return;
          // 共享元素主体＝被点的这一行指向的帖子（而不是列表里第一张同帖卡片）。
          markSharedSubject(clickEvent.currentTarget, item.targetId);
          // 按帖已读：只记录该帖（含同帖全部事件），不推进服务端游标。
          notifications.markPostRead(item.targetId);
          navigate(`/p/${encodeURIComponent(item.targetId)}`);
        }}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
          if ((keyEvent.target as HTMLElement).closest("a,button")) return;
          keyEvent.preventDefault();
          if (!item.targetId) return;
          markSharedSubject(keyEvent.currentTarget, item.targetId);
          notifications.markPostRead(item.targetId);
          navigate(`/p/${encodeURIComponent(item.targetId)}`);
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
            <span className="font-medium">{eventText(event, item)}</span>
            <span className="ml-1 text-xs text-muted-foreground">{dateTimeShort(event.created_at)}</span>
            {mine ? (
              <Badge variant="outline" className="ml-2 align-middle">
                我
              </Badge>
            ) : null}
          </div>
          {item.deleted ? (
            <div className="mt-1 text-xs text-muted-foreground">此帖已删除</div>
          ) : post ? (
            <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              <Markdown source={post.body_md} className="[&_p]:my-0" />
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const loadingFirstPage =
    rows.length === 0 &&
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
        ) : visible.length === 0 ? (
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
              {visible.map(renderRow)}
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

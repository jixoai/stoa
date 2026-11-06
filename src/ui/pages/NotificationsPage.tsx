import { useMemo, useState } from "react";
import type { NotificationEventLine } from "@core/types";
import { BellOffIcon, CheckCheckIcon, ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { AuthorAvatar, AuthorLine } from "@/components/AuthorAvatar";
import { Markdown } from "@/components/Markdown";
import { useConnection } from "@/state/connection";
import { useNotifications, type NotificationItem } from "@/state/notifications";
import { navigate } from "@/lib/router";
import { toastReadOnly } from "@/lib/readonly";
import { dateTimeShort } from "@/lib/format";
import { cn } from "cn";

function eventText(event: NotificationEventLine, item: NotificationItem): string {
  if (event.type === "thread.invited") return "邀请你加入了会话";
  const payload = (event.payload ?? {}) as { parent_id?: string | null; quoted_post_id?: string | null };
  if (item.post?.quoted_post_id || payload.quoted_post_id) return "引用了帖子";
  if (item.post?.parent_id || payload.parent_id) return "回复了帖子";
  return "发布了新帖";
}

export function NotificationsPage() {
  const { account, accounts, staticMode } = useConnection();
  const notifications = useNotifications();
  const [showDeleted, setShowDeleted] = useState(false);

  const { active, deleted } = useMemo(() => {
    const activeRows: NotificationItem[] = [];
    const deletedRows: NotificationItem[] = [];
    for (const item of notifications.items) {
      if (item.deleted) deletedRows.push(item);
      else activeRows.push(item);
    }
    return { active: activeRows, deleted: deletedRows };
  }, [notifications.items]);

  const actorOf = (event: NotificationEventLine) => accounts.find((row) => row.id === event.actor) ?? null;

  const renderRow = (item: NotificationItem) => {
    const { event, post } = item;
    const actor = actorOf(event);
    const mine = account?.id === event.actor;
    return (
      <div
        key={event.seq}
        role="button"
        tabIndex={0}
        data-testid={item.deleted ? "notification-deleted-row" : "notification-row"}
        className={cn(
          "flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none",
          item.deleted && "opacity-60",
        )}
        onClick={(clickEvent) => {
          if ((clickEvent.target as HTMLElement).closest("a,button")) return;
          if (item.targetId) navigate(`/p/${encodeURIComponent(item.targetId)}`);
        }}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
          if ((keyEvent.target as HTMLElement).closest("a,button")) return;
          keyEvent.preventDefault();
          if (item.targetId) navigate(`/p/${encodeURIComponent(item.targetId)}`);
        }}
      >
        <AuthorAvatar account={actor} fallbackId={event.actor} />
        <div className="min-w-0 flex-1">
          <AuthorLine account={actor} fallbackId={event.actor} />
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
            <Button variant="ghost" size="icon-sm" aria-label="刷新通知" onClick={() => void notifications.refresh()}>
              <RefreshCwIcon />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="ack-notifications"
              aria-disabled={staticMode || undefined}
              disabled={notifications.items.length === 0}
              className={cn(staticMode && "opacity-60")}
              onClick={() => {
                if (staticMode) {
                  toastReadOnly();
                  return;
                }
                void notifications.ack();
              }}
            >
              <CheckCheckIcon data-icon="inline-start" />
              全部已读
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {notifications.error ? (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{notifications.error}</AlertDescription>
          </Alert>
        ) : null}

        {notifications.loading && notifications.items.length === 0 ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : active.length === 0 && deleted.length === 0 ? (
          <Empty className="py-20">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BellOffIcon />
              </EmptyMedia>
              <EmptyTitle>没有未读通知</EmptyTitle>
              <EmptyDescription>有人发帖、回复或 @ 你时会出现在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {active.length > 0 ? (
              <Card className="gap-0 divide-y divide-border/60 p-0" data-testid="notification-list">
                {active.map(renderRow)}
              </Card>
            ) : (
              <Empty className="py-16">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <BellOffIcon />
                  </EmptyMedia>
                  <EmptyTitle>没有未读通知</EmptyTitle>
                  <EmptyDescription>剩下的提醒都指向已删除的帖子。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}

            {deleted.length > 0 ? (
              <div className="mt-3" data-testid="deleted-notifications">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground"
                  data-testid="deleted-notifications-toggle"
                  aria-expanded={showDeleted}
                  onClick={() => setShowDeleted((value) => !value)}
                >
                  <ChevronDownIcon
                    data-icon="inline-start"
                    className={cn("transition-transform", showDeleted && "rotate-180")}
                  />
                  已删除帖子的提醒 {deleted.length}
                </Button>
                {showDeleted ? (
                  <Card className="mt-1 gap-0 divide-y divide-border/60 p-0">{deleted.map(renderRow)}</Card>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import type { NotificationEventLine, PostView } from "@core/types";
import { BellOffIcon, CheckCheckIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthorAvatar, AuthorLine } from "@/components/AuthorAvatar";
import { Markdown } from "@/components/Markdown";
import { useConnection } from "@/state/connection";
import { useNotifications } from "@/state/notifications";
import { navigate } from "@/lib/router";
import { dateTimeShort } from "@/lib/format";

function eventText(event: NotificationEventLine, post: PostView | null): string {
  if (event.type === "thread.invited") return "邀请你加入了会话";
  const payload = (event.payload ?? {}) as { parent_id?: string | null; quoted_post_id?: string | null };
  if (post?.quoted_post_id || payload.quoted_post_id) return "引用了帖子";
  if (post?.parent_id || payload.parent_id) return "回复了帖子";
  return "发布了新帖";
}

export function NotificationsPage() {
  const { client, account, accounts } = useConnection();
  const notifications = useNotifications();
  const [posts, setPosts] = useState<Map<string, PostView>>(new Map());

  const ordered = useMemo(() => [...notifications.events].sort((a, b) => b.seq - a.seq), [notifications.events]);

  useEffect(() => {
    if (!client) return;
    const ids = [...new Set(ordered.map((event) => event.post_id).filter((id): id is string => Boolean(id)))].slice(0, 40);
    if (ids.length === 0) return;
    let alive = true;
    void Promise.all(
      ids.map((id) =>
        client
          .post(id)
          .then((post) => [id, post] as const)
          .catch(() => null),
      ),
    ).then((entries) => {
      if (!alive) return;
      setPosts((prev) => {
        const next = new Map(prev);
        for (const entry of entries) {
          if (entry) next.set(entry[0], entry[1]);
        }
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [client, ordered]);

  const actorOf = (event: NotificationEventLine) => accounts.find((row) => row.id === event.actor) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between border-b border-border/60 bg-background/80 px-4 backdrop-blur-md">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          通知
          {notifications.unread > 0 ? <Badge variant="secondary">{notifications.unread}</Badge> : null}
        </h1>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="刷新通知" onClick={() => void notifications.refresh()}>
            <RefreshCwIcon />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="ack-notifications"
            disabled={notifications.unread === 0}
            onClick={() => void notifications.ack()}
          >
            <CheckCheckIcon data-icon="inline-start" />
            全部已读
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {notifications.error ? (
          <Alert variant="destructive" className="mb-3">
            <AlertDescription>{notifications.error}</AlertDescription>
          </Alert>
        ) : null}

        {notifications.loading && ordered.length === 0 ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : ordered.length === 0 ? (
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
          <Card className="gap-0 divide-y divide-border/60 p-0">
            {ordered.map((event) => {
              const actor = actorOf(event);
              const post = event.post_id ? posts.get(event.post_id) : undefined;
              const targetId = event.post_id ?? event.root_id;
              const mine = account?.id === event.actor;
              return (
                <button
                  key={event.seq}
                  type="button"
                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
                  onClick={() => {
                    if (targetId) navigate(`/p/${encodeURIComponent(targetId)}`);
                  }}
                >
                  <AuthorAvatar account={actor} fallbackId={event.actor} />
                  <div className="min-w-0 flex-1">
                    <AuthorLine account={actor} fallbackId={event.actor} />
                    <div className="mt-0.5 text-sm">
                      <span className="font-medium">{eventText(event, post ?? null)}</span>
                      <span className="ml-1 text-xs text-muted-foreground">
                        {dateTimeShort(event.created_at)}
                      </span>
                      {mine ? (
                        <Badge variant="outline" className="ml-2 align-middle">
                          我
                        </Badge>
                      ) : null}
                    </div>
                    {post && !post.deleted_at ? (
                      <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        <Markdown source={post.body_md} className="[&_p]:my-0" />
                      </div>
                    ) : post?.deleted_at ? (
                      <div className="mt-1 text-xs text-muted-foreground">此帖已删除</div>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </Card>
        )}
      </div>
    </div>
  );
}

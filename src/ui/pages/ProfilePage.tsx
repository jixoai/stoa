/**
 * 成员页（design §5.0 / §12.1）：`#/u/<account>`
 *
 * - 资料卡：display / @id / profile / 角色 / 在线态 / 粉丝数 / 关注按钮
 * - 该成员的根帖时间线（复用通用 feed 控制器）
 * - 页面打开期间用 SSE `author=<acct>` **技术订阅**该成员事件：新帖即时进入时间线，
 *   断线重连按 after 游标补拉、按 id 去重。浏览不产生 follows 边，关注只有按钮。
 */
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  Loader2Icon,
  RadioIcon,
  UserCheckIcon,
  UserPlusIcon,
} from "lucide-react";
import { cn } from "cn";
import type { ProfileAccountView, SseState } from "@/lib/api";
import type { FeedQuery, FeedPageData } from "@/state/feed";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { TimelineFeed } from "@/components/TimelineFeed";
import { useConnection } from "@/state/connection";
import { useAuthorStream } from "@/state/author-stream";
import { useHomeFeeds, usePostFeed } from "@/state/feed";
import { goBack, useRoute } from "@/lib/router";
import { dateTimeShort, roleLabel, timeShort } from "@/lib/format";

const STREAM_LABEL: Record<SseState, string> = {
  idle: "未连接",
  connecting: "连接中",
  open: "实时",
  reconnecting: "重连中",
  closed: "已断开",
};

export function ProfilePage() {
  const route = useRoute();
  const account = route.name === "profile" ? route.account : "";
  const { client, account: me } = useConnection();
  const { following: followingFeed } = useHomeFeeds();

  const [profile, setProfile] = useState<ProfileAccountView | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);

  const loader = useCallback(
    async (query: FeedQuery): Promise<FeedPageData> => {
      if (!client) throw new Error("未连接后端");
      try {
        const page = await client.profile(account, query);
        setProfile(page.account);
        setProfileError(null);
        return {
          posts: page.posts,
          has_more: page.has_more,
          next_cursor: page.next_cursor,
          as_of_seq: page.as_of_seq,
        };
      } catch (err) {
        setProfileError((err as Error).message);
        throw err;
      }
    },
    [client, account],
  );

  // `account` becomes "" for one render while the route is leaving the member
  // page; a null loader prevents a stray `/api/profile/` request in that tick.
  const feed = usePostFeed(account ? loader : null, { resetKey: account, realtime: false });

  // SSE author filter: technical live subscription for this member page only.
  const streamState = useAuthorStream(account, () => feed.refreshNew());
  const { refreshNew } = feed;
  useEffect(() => {
    if (streamState === "open") refreshNew();
  }, [streamState, refreshNew]);

  useEffect(() => {
    setProfile(null);
    setProfileError(null);
    setActionError(null);
  }, [account]);

  const isSelf = Boolean(me && me.id === account);
  const following = profile?.following ?? false;

  const toggleFollow = async () => {
    if (!client || !profile || followBusy) return;
    setFollowBusy(true);
    setActionError(null);
    try {
      const result = following ? await client.unfollow(account) : await client.follow(account);
      setProfile((prev) =>
        prev
          ? {
              ...prev,
              following: result.following,
              follower_count: Math.max(0, prev.follower_count + (result.following ? 1 : -1)),
            }
          : prev,
      );
      toast.add({
        type: "success",
        title: result.following ? `已关注 @${account}` : `已取消关注 @${account}`,
        description: result.following
          ? "该成员的根帖会出现在主页「正在关注」"
          : "该成员的根帖不再进入「正在关注」",
        timeout: 2800,
      });
      // The follow edge is not an event; refresh the home following feed now so
      // returning to the tab reflects it without a reload.
      void followingFeed.loadInitial();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setFollowBusy(false);
    }
  };

  const leading = (
    <>
      {profileError ? (
        <div className="p-3">
          <Alert variant="destructive">
            <AlertDescription>成员资料加载失败：{profileError}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {profile ? (
        <section
          data-testid="profile-card"
          className="border-b border-border/60 px-4 pb-4 pt-3"
        >
          <div className="flex items-start gap-3">
            <AuthorAvatar account={profile} fallbackId={profile.id} size="large" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold leading-tight">
                    {profile.display}
                  </h2>
                  <p className="truncate text-sm text-muted-foreground">@{profile.id}</p>
                </div>
                {isSelf ? (
                  <Badge variant="secondary" className="shrink-0">
                    这是你
                  </Badge>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant={following ? "outline" : "default"}
                    aria-pressed={following}
                    data-testid="follow-button"
                    data-following={following ? "1" : "0"}
                    title={following ? "点击取消关注" : "关注该成员（进入主页「正在关注」）"}
                    disabled={followBusy}
                    onClick={() => void toggleFollow()}
                  >
                    {followBusy ? (
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : following ? (
                      <UserCheckIcon data-icon="inline-start" />
                    ) : (
                      <UserPlusIcon data-icon="inline-start" />
                    )}
                    {following ? "已关注" : "关注"}
                  </Button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant="secondary" className="h-5 px-1.5">
                  {roleLabel(profile.role)}
                </Badge>
                <span className="inline-flex items-center gap-1">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      profile.online ? "bg-success" : "bg-muted-foreground/40",
                    )}
                  />
                  {profile.online ? "在线" : "离线"}
                </span>
                {!profile.online && profile.last_seen ? (
                  <span title={new Date(profile.last_seen).toLocaleString("zh-CN")}>
                    最近活跃 {timeShort(profile.last_seen)}
                  </span>
                ) : null}
                <span
                  className="inline-flex items-center gap-1"
                  title={`事件流订阅：${STREAM_LABEL[streamState]}`}
                  data-testid="profile-live"
                >
                  <RadioIcon
                    className={cn(
                      "size-3",
                      streamState === "open" ? "text-success" : "text-muted-foreground",
                    )}
                  />
                  {STREAM_LABEL[streamState]}
                </span>
              </div>

              {profile.profile ? (
                <p className="text-sm leading-relaxed">{profile.profile}</p>
              ) : (
                <p className="text-sm text-muted-foreground">（未填写简介）</p>
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span data-testid="follower-count">
                  <strong className="font-semibold text-foreground">{profile.follower_count}</strong>{" "}
                  粉丝
                </span>
                <span>
                  <strong className="font-semibold text-foreground">
                    {profile.following_count}
                  </strong>{" "}
                  关注
                </span>
                <span>加入于 {dateTimeShort(profile.created_at)}</span>
              </div>
            </div>
          </div>

          {actionError ? (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}
        </section>
      ) : !profileError ? (
        <section className="border-b border-border/60 p-4">
          <div className="flex items-start gap-3">
            <Skeleton className="size-16 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-full" />
            </div>
          </div>
        </section>
      ) : null}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border/60 bg-background/80 px-2 backdrop-blur-md">
        <Button variant="ghost" size="icon-sm" onClick={() => goBack("/")} aria-label="返回">
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">@{account}</h1>
        </div>
        <span className="truncate text-[11px] text-muted-foreground">成员页</span>
      </header>

      <TimelineFeed
        key={account}
        feed={feed}
        feedName={`profile:${account}`}
        leading={leading}
        emptyTitle="还没有根帖"
        emptyDescription="该成员发布根帖后，会即时出现在这里。"
      />
    </div>
  );
}

/**
 * 成员页（design §5.0 / §12.1）：`#/u/<account>`
 *
 * - 资料卡：display / @id / profile / 角色 / 在线态 / 粉丝数 / 关注按钮
 * - 该成员的根帖时间线（复用通用 feed 控制器）
 * - 实时：**不再开第二条流**（report-event-hub P1）——共享 EventHub 按 actor 过滤；
 *   删除事件按当前列表 id 命中。浏览不产生 follows 边，关注只有按钮。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2Icon,
  RadioIcon,
  UserCheckIcon,
  UserPlusIcon,
} from "lucide-react";
import { cn } from "cn";
import type { ProfileAccountView } from "@/lib/api";
import type { FeedQuery, FeedPageData } from "@/state/feed";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { ProfileCardSkeleton } from "@/components/Skeletons";
import { toast } from "@/components/ui/toast";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { TimelineFeed } from "@/components/TimelineFeed";
import { useConnection } from "@/state/connection";
import { useHubStatus } from "@/state/hub/provider";
import { isRootCreated, type HubStatus } from "@/state/hub/types";
import { useHomeFeeds, usePostFeed } from "@/state/feed";
import {
  getCachedAuthorRoots,
  getCachedIdentity,
  getCachedProfile,
  rememberProfile,
} from "@/state/cache";
import { goBack, routeSource, usePageRoute } from "@/lib/router";
import { toastReadOnly } from "@/lib/readonly";
import { dateTimeShort, roleLabel, timeShort } from "@/lib/format";

const STREAM_LABEL: Record<HubStatus["state"], string> = {
  off: "未连接",
  connecting: "连接中",
  live: "实时",
  reconnecting: "重连中",
  degraded: "轮询兜底",
};

export function ProfilePage() {
  const route = usePageRoute();
  const account = route.name === "profile" ? route.account : "";
  const source = routeSource(route);
  const { client, account: me, staticMode, who, accounts } = useConnection();
  const { following: followingFeed } = useHomeFeeds();

  const [profile, setProfile] = useState<ProfileAccountView | null>(() =>
    account ? getCachedProfile(account) : null,
  );
  const [profileError, setProfileError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);

  const loader = useCallback(
    async (query: FeedQuery): Promise<FeedPageData> => {
      if (!client) throw new Error("未连接后端");
      try {
        const page = await client.profile(account, query);
        setProfile(page.account);
        rememberProfile(page.account);
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
  // 首帧种子：该成员已见过的根帖（时间线里出现过的），配合 cacheKey 写回快照。
  const seedPosts = useMemo(
    () => (account ? getCachedAuthorRoots(account) : []),
    [account],
  );
  const feed = usePostFeed(account ? loader : null, {
    resetKey: account,
    initialPosts: seedPosts,
    cacheKey: account ? `profile:${account}` : undefined,
    live: {
      // 成员页只显示该成员的根帖：其他成员发帖不触发本页请求（P4 验收）。
      matches: (event) => event.actor === account && isRootCreated(event),
      deleteRootAction: "refresh",
    },
  });

  // 实时状态来自共享 EventHub（每标签页一条流，成员页不再自开第二条）。
  const hubStatus = useHubStatus();
  const streamState = hubStatus.state;
  const streamLabel =
    streamState === "degraded"
      ? hubStatus.reason === "catching_up"
        ? "补齐中"
        : "轮询兜底"
      : STREAM_LABEL[streamState];

  useEffect(() => {
    setProfile(account ? getCachedProfile(account) : null);
    setProfileError(null);
    setActionError(null);
  }, [account]);

  const isSelf = Boolean(me && me.id === account);
  // 首帧身份：完整资料 > 已见身份缓存（帖子作者/推荐成员/上次资料）> presence/账号表。
  // 头像、名字、简介、在线态、粉丝数都能在第一帧给出；未知派生字段才用骨架占位。
  const knownWho = useMemo(() => who.find((row) => row.id === account) ?? null, [who, account]);
  const knownAccount = useMemo(
    () => accounts.find((row) => row.id === account) ?? null,
    [accounts, account],
  );
  const knownIdentity = useMemo(
    () => (account ? getCachedIdentity(account) : null),
    [account],
  );
  const identity = profile ?? knownIdentity ?? knownWho ?? knownAccount;
  const presence =
    profile ??
    (knownIdentity?.online !== undefined
      ? { online: knownIdentity.online, last_seen: knownIdentity.lastSeen ?? null }
      : knownWho);
  const following = profile?.following ?? knownIdentity?.following ?? false;
  const followers = profile?.follower_count ?? knownIdentity?.followers ?? null;
  const joinedAt =
    profile?.created_at ?? knownIdentity?.createdAt ?? knownAccount?.created_at ?? 0;

  const toggleFollow = async () => {
    if (staticMode) {
      toastReadOnly();
      return;
    }
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

      {identity ? (
        <section
          data-testid="profile-card"
          className="border-b border-border/60 px-4 pb-4 pt-3"
        >
          <div className="flex items-start gap-3">
            <AuthorAvatar
              account={identity}
              fallbackId={identity.id}
              size="large"
              sharedId={`account-${identity.id}`}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold leading-tight">
                    {identity.display}
                  </h2>
                  <p className="truncate text-sm text-muted-foreground">@{identity.id}</p>
                </div>
                {isSelf ? (
                  <Badge variant="secondary" className="shrink-0">
                    这是你
                  </Badge>
                ) : profile ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={following ? "outline" : "default"}
                    aria-pressed={following}
                    aria-disabled={staticMode || undefined}
                    data-testid="follow-button"
                    data-following={following ? "1" : "0"}
                    title={
                      staticMode
                        ? "静态归档只读"
                        : following
                          ? "点击取消关注"
                          : "关注该成员（进入主页「正在关注」）"
                    }
                    disabled={followBusy}
                    className={cn(staticMode && "opacity-60")}
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
                ) : (
                  <Skeleton className="h-8 w-[74px] shrink-0 rounded-md" />
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant="secondary" className="h-5 px-1.5">
                  {roleLabel(identity.role)}
                </Badge>
                {presence ? (
                  <>
                    <span className="inline-flex items-center gap-1">
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          presence.online ? "bg-success" : "bg-muted-foreground/40",
                        )}
                      />
                      {presence.online ? "在线" : "离线"}
                    </span>
                    {!presence.online && presence.last_seen ? (
                      <span title={new Date(presence.last_seen).toLocaleString("zh-CN")}>
                        最近活跃 {timeShort(presence.last_seen)}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <Skeleton className="h-3 w-16" />
                )}
                <span
                  className="inline-flex items-center gap-1"
                  title={`事件流订阅：${streamLabel}`}
                  data-testid="profile-live"
                  data-live-state={streamState}
                  data-reason={hubStatus.reason ?? undefined}
                >
                  <RadioIcon
                    className={cn(
                      "size-3",
                      streamState === "live" ? "text-success" : "text-muted-foreground",
                    )}
                  />
                  {streamLabel}
                </span>
              </div>

              {identity.profile ? (
                <p className="text-sm leading-relaxed">{identity.profile}</p>
              ) : (
                <p className="text-sm text-muted-foreground">（未填写简介）</p>
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {followers !== null ? (
                  <span data-testid="follower-count">
                    <strong className="font-semibold text-foreground">{followers}</strong> 粉丝
                  </span>
                ) : (
                  <Skeleton className="h-3 w-14" />
                )}
                {profile ? (
                  <span>
                    <strong className="font-semibold text-foreground">
                      {profile.following_count}
                    </strong>{" "}
                    关注
                  </span>
                ) : (
                  <Skeleton className="h-3 w-14" />
                )}
                {joinedAt > 0 ? <span>加入于 {dateTimeShort(joinedAt)}</span> : null}
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
        <ProfileCardSkeleton />
      ) : null}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={`@${account}`}
        back
        onBack={() => goBack("/")}
        backTestId="profile-back"
        source={`来自${source} · 成员页`}
        sourceTestId="profile-source"
      />

      <TimelineFeed
        key={account}
        feed={feed}
        feedName={`profile:${account}`}
        scrollPath={`/u/${account}`}
        scrollTab="root"
        leading={leading}
        emptyTitle="还没有根帖"
        emptyDescription="该成员发布根帖后，会即时出现在这里。"
      />
    </div>
  );
}

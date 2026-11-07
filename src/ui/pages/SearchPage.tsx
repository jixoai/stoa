import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PostView } from "@core/types";
import { HashIcon, SearchIcon, UserCheckIcon } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { PostCard } from "@/components/PostCard";
import { PostListSkeleton } from "@/components/Skeletons";
import { useConnection } from "@/state/connection";
import { navigate, usePageRoute } from "@/lib/router";
import { roleLabel } from "@/lib/format";
import { prefetchProfile, rememberAuthors, rememberSuggested } from "@/state/cache";
import type { SuggestedAccount, TrendingTag, WhoRow } from "@/lib/api";

export function SearchPage() {
  const route = usePageRoute();
  const routeQuery = route.name === "search" ? route.q : "";
  const { client } = useConnection();
  const [input, setInput] = useState(routeQuery);
  const [results, setResults] = useState<PostView[]>([]);
  const [members, setMembers] = useState<WhoRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState("");
  const [trending, setTrending] = useState<TrendingTag[]>([]);
  const [suggested, setSuggested] = useState<SuggestedAccount[]>([]);
  const [discoverLoading, setDiscoverLoading] = useState(true);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hasQuery = Boolean(routeQuery.trim());

  useEffect(() => {
    setInput(routeQuery);
  }, [routeQuery]);

  useEffect(() => {
    if (!client || !routeQuery.trim()) {
      setResults([]);
      setMembers([]);
      setSearched("");
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    client
      .searchWithAccounts(routeQuery.trim())
      .then(({ posts, accounts }) => {
        if (!alive) return;
        setResults(posts);
        setMembers(accounts ?? []);
        rememberAuthors(accounts ?? []);
        setSearched(routeQuery.trim());
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [client, routeQuery, retryNonce]);

  // 空查询的发现区（report-ux-r2 §6）：热门标签 + 推荐成员，接口空/失败都有空态。
  useEffect(() => {
    if (!client || hasQuery) return;
    let alive = true;
    setDiscoverLoading(true);
    setDiscoverError(null);
    Promise.all([client.trendingTags(12), client.suggestedAccounts(6)])
      .then(([tags, accounts]) => {
        if (!alive) return;
        setTrending(tags);
        setSuggested(accounts);
        // 推荐成员的身份立即进缓存：点进成员页时首帧就有真实头像/名字/粉丝数。
        rememberSuggested(accounts);
      })
      .catch((err: Error) => {
        if (alive) setDiscoverError(err.message);
      })
      .finally(() => {
        if (alive) setDiscoverLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [client, hasQuery, retryNonce]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const q = input.trim();
    if (!q) {
      navigate("/search");
      return;
    }
    navigate(`/search?q=${encodeURIComponent(q)}`);
  };

  const openPost = (post: PostView) => navigate(`/p/${encodeURIComponent(post.id)}`);
  const replyPost = (post: PostView) => navigate(`/p/${encodeURIComponent(post.id)}?reply=1`);
  const quotePost = (post: PostView) => navigate(`/compose?quote=${encodeURIComponent(post.id)}`);

  const nothingFound = !loading && results.length === 0 && members.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="搜索" />
      <div className="border-b border-border/60 p-3">
        <form onSubmit={submit}>
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="搜索正文 / 作者 / 成员…"
              data-testid="search-input"
              autoFocus
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton type="submit" variant="default" size="sm">
                搜索
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="p-3">
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {error}
                <Button size="sm" variant="outline" onClick={() => setRetryNonce((value) => value + 1)}>
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {loading ? (
          <PostListSkeleton count={3} />
        ) : !hasQuery ? (
          discoverLoading ? (
            <div className="flex flex-col gap-2 p-3">
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-40 w-full rounded-xl" />
            </div>
          ) : (
            <div data-testid="search-discover">
              {discoverError ? (
                <div className="p-3">
                  <Alert variant="destructive">
                    <AlertDescription className="flex flex-wrap items-center gap-2">
                      发现内容加载失败：{discoverError}
                      <Button size="sm" variant="outline" onClick={() => setRetryNonce((value) => value + 1)}>
                        重试
                      </Button>
                    </AlertDescription>
                  </Alert>
                </div>
              ) : null}

              <section data-testid="discover-tags" className="border-b border-border/60 px-4 py-3">
                <div className="flex items-center justify-between">
                  <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                    <HashIcon className="size-4 text-muted-foreground" /> 热门标签
                  </h2>
                  <span className="text-[11px] text-muted-foreground">按最近热度</span>
                </div>
                {trending.length === 0 ? (
                  <p data-testid="discover-tags-empty" className="py-4 text-center text-xs text-muted-foreground">
                    还没有热门标签；发帖时在正文里写 #标签 就会出现在这里。
                  </p>
                ) : (
                  <div className="-mx-1 mt-2 flex gap-1.5 overflow-x-auto px-1 pb-1" data-testid="trending-tags">
                    {trending.map((row) => (
                      <Button
                        key={row.tag}
                        type="button"
                        variant="outline"
                        size="xs"
                        data-testid={`trending-tag-${row.tag}`}
                        data-tag={row.tag}
                        className="shrink-0 rounded-full"
                        onClick={() => navigate(`/tag/${encodeURIComponent(row.tag)}`)}
                      >
                        <span aria-hidden className="opacity-60">
                          #
                        </span>
                        {row.tag}
                        <span className="text-[10px] tabular-nums text-muted-foreground">{row.count}</span>
                      </Button>
                    ))}
                  </div>
                )}
              </section>

              <section data-testid="discover-members">
                <div className="flex items-center justify-between px-4 pb-1 pt-3">
                  <h2 className="text-sm font-semibold">推荐成员</h2>
                  <span className="text-[11px] text-muted-foreground">按粉丝数</span>
                </div>
                {suggested.length === 0 ? (
                  <p data-testid="discover-members-empty" className="px-4 py-6 text-center text-xs text-muted-foreground">
                    还没有可推荐的成员。
                  </p>
                ) : (
                  <div className="divide-y divide-border/60">
                    {suggested.map((member) => (
                      <Button
                        key={member.id}
                        variant="ghost"
                        data-testid={`suggested-member-${member.id}`}
                        aria-label={`打开 @${member.id} 的成员页`}
                        className="h-auto w-full justify-start gap-3 rounded-none px-4 py-2.5 text-left font-normal"
                        onPointerEnter={() => prefetchProfile(client, member.id)}
                        onPointerDown={() => prefetchProfile(client, member.id)}
                        onClick={() => navigate(`/u/${encodeURIComponent(member.id)}`)}
                      >
                        <AuthorAvatar
                          account={{
                            id: member.id,
                            display: member.display,
                            profile: member.profile,
                            avatar: member.avatar,
                            role: member.role,
                            disabled: 0,
                          }}
                          fallbackId={member.id}
                          size="normal"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                            <span className="truncate text-sm font-semibold">{member.display}</span>
                            <span className="truncate text-xs text-muted-foreground">@{member.id}</span>
                            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                              {roleLabel(member.role)}
                            </Badge>
                            {member.following ? (
                              <Badge
                                variant="outline"
                                data-testid={`suggested-following-${member.id}`}
                                className="h-4 gap-0.5 border-success/40 bg-success/10 px-1.5 text-[10px] text-success"
                              >
                                <UserCheckIcon className="size-2.5" />
                                已关注
                              </Badge>
                            ) : null}
                            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
                              {member.followers} 粉丝
                            </span>
                          </span>
                          {member.profile ? (
                            <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
                              {member.profile}
                            </span>
                          ) : null}
                        </span>
                      </Button>
                    ))}
                  </div>
                )}
              </section>

              <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
                按正文子串搜索；也会匹配成员 id / display / 简介。输入 @账号 可找到提及该账号的帖子。
              </p>
            </div>
          )
        ) : nothingFound ? (
          <Empty className="py-20">
            <EmptyHeader>
              <EmptyTitle>没有找到「{searched}」</EmptyTitle>
              <EmptyDescription>换个关键词或作者 id 试试。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div>
            <div className="px-4 py-2 text-xs text-muted-foreground">
              {members.length} 位成员 · {results.length} 条帖子
            </div>

            {members.length > 0 ? (
              <section data-testid="search-members" className="border-b border-border/60">
                <div className="px-4 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  成员
                </div>
                <div className="divide-y divide-border/60">
                  {members.map((member) => (
                    <Button
                      key={member.id}
                      variant="ghost"
                      data-testid={`search-member-${member.id}`}
                      aria-label={`打开 @${member.id} 的成员页`}
                      className="h-auto w-full justify-start gap-3 rounded-none px-4 py-2.5 text-left font-normal"
                      onPointerEnter={() => prefetchProfile(client, member.id)}
                      onPointerDown={() => prefetchProfile(client, member.id)}
                      onClick={() => navigate(`/u/${encodeURIComponent(member.id)}`)}
                    >
                      <AuthorAvatar
                        account={member}
                        fallbackId={member.id}
                        size="normal"
                        sharedId={`account-${member.id}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                          <span className="truncate text-sm font-semibold">{member.display}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            @{member.id}
                          </span>
                          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                            {roleLabel(member.role)}
                          </Badge>
                          <span
                            className={cn(
                              "ml-auto size-1.5 shrink-0 rounded-full",
                              member.online ? "bg-success" : "bg-muted-foreground/40",
                            )}
                            title={member.online ? "在线" : "离线"}
                          />
                        </span>
                        {member.profile ? (
                          <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
                            {member.profile}
                          </span>
                        ) : null}
                      </span>
                    </Button>
                  ))}
                </div>
              </section>
            ) : null}

            {results.length > 0 ? (
              <section>
                <div className="px-4 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  帖子
                </div>
                <div className="divide-y divide-border/60">
                  {results.map((post) => (
                    <PostCard
                      key={post.id}
                      post={post}
                      onOpen={openPost}
                      onReply={replyPost}
                      onQuote={quotePost}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

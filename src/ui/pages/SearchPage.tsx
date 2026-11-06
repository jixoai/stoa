import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PostView } from "@core/types";
import { SearchIcon } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { PostCard } from "@/components/PostCard";
import { useConnection } from "@/state/connection";
import { navigate, usePageRoute } from "@/lib/router";
import { roleLabel } from "@/lib/format";
import type { WhoRow } from "@/lib/api";

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
  const [retryNonce, setRetryNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
        <form onSubmit={submit} className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="搜索正文 / 作者 / 成员…"
              className="pl-8"
              data-testid="search-input"
              autoFocus
            />
          </div>
          <Button type="submit" size="sm">
            搜索
          </Button>
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
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        ) : !routeQuery.trim() ? (
          <Empty className="py-20">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon />
              </EmptyMedia>
              <EmptyTitle>搜索公示板</EmptyTitle>
              <EmptyDescription>
                按正文子串搜索；也会匹配成员 id / display / 简介。输入 @账号 可找到提及该账号的帖子。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
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

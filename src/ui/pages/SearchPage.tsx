import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PostView } from "@core/types";
import { SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { PostCard } from "@/components/PostCard";
import { useConnection } from "@/state/connection";
import { navigate, useRoute } from "@/lib/router";

export function SearchPage() {
  const route = useRoute();
  const routeQuery = route.name === "search" ? route.q : "";
  const { client } = useConnection();
  const [input, setInput] = useState(routeQuery);
  const [results, setResults] = useState<PostView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setInput(routeQuery);
  }, [routeQuery]);

  useEffect(() => {
    if (!client || !routeQuery.trim()) {
      setResults([]);
      setSearched("");
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    client
      .search(routeQuery.trim())
      .then((posts) => {
        if (!alive) return;
        setResults(posts);
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
  }, [client, routeQuery]);

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center border-b border-border/60 bg-background/80 px-4 backdrop-blur-md">
        <h1 className="text-base font-semibold">搜索</h1>
      </header>
      <div className="border-b border-border/60 p-3">
        <form onSubmit={submit} className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="搜索正文 / 作者…"
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
              <AlertDescription>{error}</AlertDescription>
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
              <EmptyDescription>按正文子串搜索；输入 @账号 可找到提及该账号的帖子。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : results.length === 0 ? (
          <Empty className="py-20">
            <EmptyHeader>
              <EmptyTitle>没有找到「{searched}」</EmptyTitle>
              <EmptyDescription>换个关键词或作者 id 试试。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div>
            <div className="px-4 py-2 text-xs text-muted-foreground">
              {results.length} 条结果
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
          </div>
        )}
      </div>
    </div>
  );
}

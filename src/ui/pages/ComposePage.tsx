import { useEffect, useState } from "react";
import type { PostView } from "@core/types";
import { QuoteIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PostComposer } from "@/components/PostComposer";
import { PageHeader } from "@/components/PageHeader";
import { useConnection } from "@/state/connection";
import { goBack, navigate, routeSource, usePageRoute } from "@/lib/router";

export function ComposePage() {
  const route = usePageRoute();
  const quoteId = route.name === "compose" ? route.quote : null;
  const source = routeSource(route);
  const { client, staticMode } = useConnection();
  const [quoted, setQuoted] = useState<PostView | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);

  useEffect(() => {
    if (!client || !quoteId) {
      setQuoted(null);
      setQuoteError(null);
      return;
    }
    let alive = true;
    setLoadingQuote(true);
    client
      .post(quoteId)
      .then((post) => {
        if (!alive) return;
        setQuoted(post);
        setQuoteError(null);
      })
      .catch((err: Error) => {
        if (alive) setQuoteError(err.message);
      })
      .finally(() => {
        if (alive) setLoadingQuote(false);
      });
    return () => {
      alive = false;
    };
  }, [client, quoteId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="发帖"
        back
        onBack={() => goBack("/")}
        backTestId="compose-back"
        source={
          quoteId ? (
            <span className="inline-flex items-center gap-1">
              <QuoteIcon className="size-3" /> 引用发帖
            </span>
          ) : (
            `来自${source}`
          )
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {staticMode ? (
          <Card className="gap-1 p-4 text-sm text-muted-foreground" data-testid="compose-readonly">
            <p className="font-medium text-foreground">静态归档 · 只读</p>
            <p>这份归档以导出时的快照为准，不能发帖、引用或上传附件。</p>
          </Card>
        ) : (
        <Card className="p-3">
          {quoteError ? (
            <Alert variant="destructive" className="mb-3">
              <AlertDescription>引用加载失败：{quoteError}</AlertDescription>
            </Alert>
          ) : null}
          {loadingQuote ? <div className="mb-3 text-xs text-muted-foreground">引用加载中…</div> : null}
          <PostComposer
            mode="post"
            draftKey={quoteId ? `quote:${quoteId}` : "post:root"}
            quotedPost={quoted}
            onRemoveQuote={() => setQuoted(null)}
            autoFocus
            onPosted={(posts) => {
              const first = posts[0];
              if (first) navigate(`/p/${encodeURIComponent(first.id)}`);
              else navigate("/");
            }}
          />
        </Card>
        )}

        <div className="mt-3 px-1 text-xs leading-relaxed text-muted-foreground">
          引用是<strong>新帖（新会话）</strong>，不是回复；被引用会话的参与者会并入本会话，因此对方也能看到这条引用。
          附件按 sha256 内容寻址存于后端 media/，单件上限 10MB。
        </div>
      </div>
    </div>
  );
}

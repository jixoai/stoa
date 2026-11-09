/**
 * 长文正文下方的嵌入式讨论区（report-longform §4.2）：
 * - 复用 `planForThreadView`（focal = 本文）与共享 `ThreadTimelineRows`——行度量/导轨/
 *   顺序与独立线程页**完全一致**（同一 planner、同一渲染件，禁止第二套）；
 * - 只渲染 `role === "reply"` 的行与子线程入口（article 本体已在上方正文区渲染，
 *   不重复 focal/ancestor 行）；
 * - read-dwell：回复行是普通 `PostCard`（自动注册到既有全局观察器与写路径），
 *   讨论区自身不建 observer、不写 `report.read*` 之外的任何存储；
 * - 静态归档：只读展示快照内既有回复，0 网络请求（composer 由页面层按 staticMode 收起）。
 */
import { useMemo } from "react";
import type { PostView, ThreadView } from "@core/types";
import { MessageCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThreadTimelineRows } from "@/components/ThreadTimelineRows";
import { planForThreadView } from "@/lib/thread-plan";
import { navigate } from "@/lib/router";
import { postHref } from "@/lib/post-href";

interface ArticleDiscussionProps {
  post: PostView;
  /** 完整线程（`client.thread(post.id, post.id)`）；null = 尚未拿到（只有单帖）。 */
  thread: ThreadView | null;
  loaded: boolean;
  /** 打开回复编辑器（页面层持有 ReplyComposer）。 */
  onOpenReply: () => void;
}

export function ArticleDiscussion({ post, thread, loaded, onOpenReply }: ArticleDiscussionProps) {
  const plan = useMemo(
    () => (thread ? planForThreadView(thread, post.id) : null),
    [thread, post.id],
  );
  const rows = useMemo(
    () =>
      (plan?.rows ?? []).filter(
        (row) => row.kind === "subthread" || (row.kind === "post" && row.role === "reply"),
      ),
    [plan],
  );
  const replyCount = post.reply_count;
  return (
    <section
      aria-label="讨论"
      data-testid="article-discussion"
      className="mx-auto w-full max-w-[68ch] px-4 pt-6 pb-10"
    >
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
        <h2 className="text-base font-semibold" data-testid="discussion-title">
          讨论 · {replyCount > 0 ? `${replyCount} 条回复` : "还没有回复"}
        </h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          data-testid="article-reply-open"
          onClick={onOpenReply}
        >
          <MessageCircleIcon data-icon="inline-start" />
          回复
        </Button>
      </div>

      {post.parent_id !== null ? (
        <div className="mt-2 text-xs text-muted-foreground">
          <a
            href={`#/p/${encodeURIComponent(post.id)}`}
            data-testid="article-view-context"
            className="text-link underline-offset-2 hover:underline"
            onClick={(event) => {
              event.preventDefault();
              navigate(`/p/${encodeURIComponent(post.id)}`);
            }}
          >
            查看上文（这是一条回复）
          </a>
        </div>
      ) : null}

      {rows.length > 0 || !loaded ? (
        <ThreadTimelineRows
          rows={rows}
          loaded={loaded}
          selectedId={null}
          onOpen={(rowPost) => navigate(postHref(rowPost))}
          onReply={(rowPost) => navigate(`/p/${encodeURIComponent(rowPost.id)}?reply=1`)}
          onQuote={(rowPost) => navigate(`/compose?quote=${encodeURIComponent(rowPost.id)}`)}
          onOpenThread={(id) => navigate(`/p/${encodeURIComponent(id)}`)}
        />
      ) : (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="discussion-empty">
          还没有回复。
        </p>
      )}
    </section>
  );
}

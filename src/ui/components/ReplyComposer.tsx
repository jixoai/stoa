/**
 * 沉浸式回复编辑器：回复框默认收起，只有明确意图（点回复入口 / ?reply=1）才展开。
 *
 * 形态对齐 X：移动端全屏（顶部 X 关闭 + 回复提交、原帖上下文、回复给 @x、编辑器与工具条），
 * 桌面端同构 Dialog。组件一律用官方件：Dialog / Button / 复用 PostComposer（InputGroup）。
 * 返回关闭走 `useBackClose` 的合成历史条目（Base UI 的 Dialog 只有 Esc/遮罩）。
 */
import { useCallback, useRef, useState } from "react";
import type { PostView } from "@core/types";
import { Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "@/components/Markdown";
import { AuthorAvatar, AuthorLine } from "@/components/AuthorAvatar";
import { PostComposer } from "@/components/PostComposer";
import { useBackClose } from "@/lib/back-close";
import { fullTime } from "@/lib/format";

interface ReplyComposerProps {
  post: PostView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPosted?: (posts: PostView[]) => void;
}

const EMPTY_STATE = { canSubmit: false, busy: false };

export function ReplyComposer({ post, open, onOpenChange, onPosted }: ReplyComposerProps) {
  const [state, setState] = useState(EMPTY_STATE);
  const submitRef = useRef<(() => void) | null>(null);

  useBackClose(open, () => onOpenChange(false));

  const handleState = useCallback((next: { canSubmit: boolean; busy: boolean }) => {
    setState((prev) =>
      prev.canSubmit === next.canSubmit && prev.busy === next.busy ? prev : next,
    );
  }, []);

  const setOpen = (next: boolean) => {
    if (!next) setState(EMPTY_STATE);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        data-testid="reply-composer"
        showCloseButton={false}
        className="inset-0 top-0 left-0 grid h-dvh w-screen max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none bg-background p-0 ring-0 max-sm:data-open:animate-none max-sm:data-closed:animate-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[85dvh] sm:w-[600px] sm:max-w-[600px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:bg-popover sm:ring-1"
      >
        <DialogTitle className="sr-only">回复 @{post.author}</DialogTitle>
        <header
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 pb-2"
          style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top))" }}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="关闭回复"
            data-testid="reply-close"
            onClick={() => setOpen(false)}
          >
            <XIcon />
          </Button>
          <Button
            type="button"
            size="sm"
            className="rounded-full px-4"
            data-testid="reply-submit"
            disabled={!state.canSubmit}
            onClick={() => submitRef.current?.()}
          >
            {state.busy ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : null}
            回复
          </Button>
        </header>

        <div className="min-h-0 overflow-y-auto" data-testid="reply-composer-scroll">
          <div className="flex gap-3 px-4 pt-3">
            <div className="shrink-0">
              <AuthorAvatar account={post.author_account} fallbackId={post.author} size="small" />
            </div>
            <div className="min-w-0 flex-1">
              <AuthorLine
                account={post.author_account}
                fallbackId={post.author}
                time={fullTime(post.created_at)}
              />
              <div className="mt-1 line-clamp-6 text-sm text-foreground/90 [&_p]:my-1">
                <Markdown source={post.body_md} />
              </div>
            </div>
          </div>

          <div className="px-4 pt-3 text-sm text-muted-foreground" data-testid="reply-to-line">
            回复给 <span className="text-primary">@{post.author}</span>
          </div>

          <div className="px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2">
            <PostComposer
              mode="reply"
              parentId={post.id}
              draftKey={`reply:${post.id}`}
              autoFocus
              showTabs={false}
              tall
              hideSubmit
              submitRef={submitRef}
              onStateChange={handleState}
              placeholder="发布你的回复…"
              onPosted={(posts) => {
                setOpen(false);
                onPosted?.(posts);
              }}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

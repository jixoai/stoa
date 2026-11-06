import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "cn";
import type { PostView, ThreadNode, ThreadView } from "@core/types";
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import { PostCard, type ChainPosition } from "@/components/PostCard";
import { PostComposer } from "@/components/PostComposer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useConnection } from "@/state/connection";
import { goBack, navigate, useRoute } from "@/lib/router";
import { fullTime } from "@/lib/format";

type ReplyItem =
  | {
      kind: "node";
      node: ThreadNode;
      indent: number;
      selfContinuation: boolean;
      selfHeader: boolean;
      chainPosition: ChainPosition;
      depth: number;
    }
  | { kind: "collapse-depth"; key: string; indent: number; count: number }
  | { kind: "expand-branch"; key: string; indent: number; count: number; parentId: string }
  | { kind: "read-more"; key: string; indent: number; count: number; nodeId: string }
  | { kind: "backend-collapse"; key: string; indent: number; count: number; nodeId: string };

interface ReplyPlan {
  items: ReplyItem[];
  replyingTo: Map<string, string>;
}

function buildReplyPlan(
  focal: ThreadNode,
  childrenMap: Map<string, ThreadNode[]>,
  backendCollapsed: Map<string, number>,
  expandedBranches: Set<string>,
  maxDepth: number,
): ReplyPlan {
  const items: ReplyItem[] = [];
  const visited = new Set<string>();
  const replyingTo = new Map<string, string>();
  const byId = new Map<string, ThreadNode>();
  for (const list of childrenMap.values()) for (const node of list) byId.set(node.id, node);

  const subtreeCount = (roots: ThreadNode[]): number => {
    let count = 0;
    const walk = (node: ThreadNode) => {
      count += 1;
      for (const child of childrenMap.get(node.id) ?? []) walk(child);
    };
    for (const root of roots) walk(root);
    return count;
  };

  const buildGroup = (parent: ThreadNode, allKids: ThreadNode[], parentDepth: number, parentIndent: number) => {
    const kids = allKids.filter((kid) => !visited.has(kid.id));
    if (kids.length === 0) {
      emitMissing(parent, parentIndent);
      return;
    }
    const childIndent = Math.min(72, parentIndent + 24);

    // 自接链：沿同作者续接走一条；整链先于他人分支（design §12.4）
    const chain: ThreadNode[] = [];
    let cursor = parent;
    for (;;) {
      const next = (childrenMap.get(cursor.id) ?? []).find(
        (kid) => kid.is_self_continuation && !visited.has(kid.id),
      );
      if (!next) break;
      chain.push(next);
      visited.add(next.id);
      cursor = next;
    }

    chain.forEach((node, index) => {
      items.push({
        kind: "node",
        node,
        indent: childIndent,
        selfContinuation: true,
        selfHeader: index === 0,
        chainPosition:
          chain.length === 1 ? "single" : index === 0 ? "start" : index === chain.length - 1 ? "end" : "middle",
        depth: parentDepth + 1,
      });
    });

    // 链上每个节点的他人分支：链后渲染，缩进跟随所在分支
    for (let index = 0; index < chain.length; index += 1) {
      const chainNode = chain[index]!;
      const nextChainId = chain[index + 1]?.id;
      const subKids = (childrenMap.get(chainNode.id) ?? []).filter((kid) => kid.id !== nextChainId);
      if (subKids.length > 0) buildGroup(chainNode, subKids, parentDepth + 1, childIndent);
    }

    const others = kids.filter((kid) => !chain.some((node) => node.id === kid.id));
    if (others.length > 0) {
      // 子分支 >10 条默认收起（Top-level 回复不受影响）
      if (parentDepth >= 1 && others.length > 10 && !expandedBranches.has(parent.id)) {
        items.push({
          kind: "expand-branch",
          key: `branch-${parent.id}`,
          indent: childIndent,
          count: subtreeCount(others),
          parentId: parent.id,
        });
      } else if (parentDepth + 1 > maxDepth) {
        // 3 级封顶；第 4 级起缩进冻结 +「继续 N 层回复」
        items.push({
          kind: "collapse-depth",
          key: `depth-${parent.id}`,
          indent: childIndent,
          count: subtreeCount(others),
        });
      } else {
        for (const other of others) {
          visited.add(other.id);
          items.push({
            kind: "node",
            node: other,
            indent: childIndent,
            selfContinuation: false,
            selfHeader: false,
            chainPosition: "none",
            depth: parentDepth + 1,
          });
          buildGroup(other, childrenMap.get(other.id) ?? [], parentDepth + 1, childIndent);
        }
      }
    }

    emitMissing(parent, childIndent);
    const backendCount = backendCollapsed.get(parent.id);
    if (backendCount && backendCount > 0) {
      items.push({
        kind: "backend-collapse",
        key: `backend-${parent.id}`,
        indent: childIndent,
        count: backendCount,
        nodeId: parent.id,
      });
    }
  };

  const emitMissing = (parent: ThreadNode, indent: number) => {
    const loaded = (childrenMap.get(parent.id) ?? []).length;
    const missing = parent.child_count - loaded;
    if (missing > 0) {
      items.push({
        kind: "read-more",
        key: `read-${parent.id}`,
        indent,
        count: missing,
        nodeId: parent.id,
      });
    }
  };

  buildGroup(focal, childrenMap.get(focal.id) ?? [], 0, 0);

  // Replying to：仅当父帖不在视觉邻位且父帖不是 focal
  let prev = focal.id;
  for (const item of items) {
    if (item.kind !== "node") continue;
    const parentId = item.node.parent_id;
    if (parentId && parentId !== prev && parentId !== focal.id && !item.selfContinuation) {
      const parentAuthor = byId.get(parentId)?.author;
      const to = item.node.reply_to_account_id ?? parentAuthor ?? parentId;
      replyingTo.set(item.node.id, to);
    }
    prev = item.node.id;
  }

  return { items, replyingTo };
}

export function ThreadPage() {
  const route = useRoute();
  const postId = route.name === "post" ? route.id : "";
  const wantReply = route.name === "post" && route.reply === true;
  const { client, subscribeEvents } = useConnection();
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingThread, setPendingThread] = useState<ThreadView | null>(null);
  const [newReplyCount, setNewReplyCount] = useState(0);
  const [extraDepth, setExtraDepth] = useState(0);
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(new Set());
  const [ancestorsExpanded, setAncestorsExpanded] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focalRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const anchoredFor = useRef<string | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const threadRef = useRef<ThreadView | null>(null);
  threadRef.current = thread;

  const load = useCallback(
    async (silent = false) => {
      if (!client || !postId) return;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const next = await client.thread(postId, postId);
        if (silent) {
          const current = threadRef.current;
          if (current) {
            const known = new Set(current.posts.map((post) => post.id));
            const added = next.posts.filter((post) => !known.has(post.id)).length;
            if (added > 0) {
              setPendingThread(next);
              setNewReplyCount(added);
            }
          } else {
            setThread(next);
          }
        } else {
          setThread(next);
          setPendingThread(null);
          setNewReplyCount(0);
        }
        setError(null);
      } catch (err) {
        if (!silent) setError((err as Error).message);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [client, postId],
  );

  useEffect(() => {
    anchoredFor.current = null;
    setThread(null);
    setPendingThread(null);
    setNewReplyCount(0);
    setExtraDepth(0);
    setExpandedBranches(new Set());
    setAncestorsExpanded(false);
    setSelectedIndex(-1);
    void load(false);
  }, [load]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void load(true);
    }, 350);
  }, [load]);

  // SSE：本会话有新帖 → 静默补拉，进 pending（不直接重排）
  useEffect(() => {
    if (!thread) return;
    const rootId = thread.root_id;
    return subscribeEvents((event) => {
      if (event.root_id === rootId || event.post_id === rootId || event.post_id === postId) {
        scheduleRefresh();
      }
    });
  }, [thread?.root_id, postId, scheduleRefresh, subscribeEvents]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  const nodes = useMemo(() => thread?.posts ?? [], [thread]);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const childrenMap = useMemo(() => {
    const map = new Map<string, ThreadNode[]>();
    for (const node of nodes) {
      if (!node.parent_id) continue;
      const list = map.get(node.parent_id) ?? [];
      list.push(node);
      map.set(node.parent_id, list);
    }
    return map;
  }, [nodes]);

  const focal = useMemo(() => {
    if (!thread) return null;
    return nodeMap.get(thread.focal_id ?? postId) ?? nodeMap.get(postId) ?? null;
  }, [thread, nodeMap, postId]);

  const ancestorChain = useMemo(() => {
    if (!focal) return [];
    const chain: ThreadNode[] = [];
    let cursor = focal.parent_id ? nodeMap.get(focal.parent_id) : undefined;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      chain.push(cursor);
      seen.add(cursor.id);
      cursor = cursor.parent_id ? nodeMap.get(cursor.parent_id) : undefined;
    }
    return chain;
  }, [focal, nodeMap]);

  const backendCollapsed = useMemo(() => {
    const map = new Map<string, number>();
    for (const group of thread?.collapsed ?? []) {
      map.set(group.parent_id, (map.get(group.parent_id) ?? 0) + group.count);
    }
    return map;
  }, [thread?.collapsed]);

  const maxDepth = 3 + extraDepth;
  const plan = useMemo(() => {
    if (!focal) return { items: [], replyingTo: new Map<string, string>() } satisfies ReplyPlan;
    return buildReplyPlan(focal, childrenMap, backendCollapsed, expandedBranches, maxDepth);
  }, [focal, childrenMap, backendCollapsed, expandedBranches, maxDepth]);

  const replyNodes = useMemo(
    () => plan.items.filter((item): item is Extract<ReplyItem, { kind: "node" }> => item.kind === "node"),
    [plan.items],
  );

  const focalReplyingTo = useMemo(() => {
    if (!focal || !focal.parent_id || ancestorsExpanded) return null;
    const parent = nodeMap.get(focal.parent_id);
    return focal.reply_to_account_id ?? parent?.author ?? null;
  }, [focal, ancestorsExpanded, nodeMap]);

  const replyGroupCount = useMemo(() => {
    if (!focal) return 0;
    const direct = childrenMap.get(focal.id) ?? [];
    const selfChain = direct.filter((node) => node.is_self_continuation);
    const others = direct.filter((node) => !node.is_self_continuation);
    return (selfChain.length > 0 ? 1 : 0) + others.length;
  }, [childrenMap, focal]);

  // focal 锚点：数据到位后滚到视口顶（scroll-margin-top 避开吸顶栏）
  useLayoutEffect(() => {
    if (!thread || !focal || loading) return;
    const key = `${thread.root_id}|${thread.focal_id}|${postId}`;
    if (anchoredFor.current === key) return;
    anchoredFor.current = key;
    const el = focalRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior: "auto" });
  }, [thread, focal, loading, postId]);

  useEffect(() => {
    if (!wantReply || !thread) return;
    const timer = window.setTimeout(() => {
      composerRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [wantReply, thread]);

  // 键盘：j/k 移动，Enter 打开该条详情，r 回复
  const kbNodes = useMemo(() => (focal ? [focal, ...replyNodes.map((item) => item.node)] : []), [focal, replyNodes]);
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "j" || event.key === "k") {
        if (kbNodes.length === 0) return;
        event.preventDefault();
        setSelectedIndex((index) => {
          const next =
            event.key === "j"
              ? Math.min(kbNodes.length - 1, index < 0 ? 0 : index + 1)
              : Math.max(0, index < 0 ? 0 : index - 1);
          const node = kbNodes[next];
          if (node) {
            document
              .querySelector<HTMLElement>(`[data-post-id="${CSS.escape(node.id)}"]`)
              ?.scrollIntoView({ block: "nearest" });
          }
          return next;
        });
      } else if ((event.key === "Enter" || event.key === "r") && selectedIndex >= 0) {
        const node = kbNodes[selectedIndex];
        if (!node) return;
        event.preventDefault();
        if (event.key === "r") {
          if (node.deleted_at === null) navigate(`/p/${encodeURIComponent(node.id)}?reply=1`);
        } else if (node.id !== focal?.id) navigate(`/p/${encodeURIComponent(node.id)}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kbNodes, selectedIndex, focal?.id]);

  const openPost = (post: PostView) => navigate(`/p/${encodeURIComponent(post.id)}`);
  const replyPost = (post: PostView) => navigate(`/p/${encodeURIComponent(post.id)}?reply=1`);
  const quotePost = (post: PostView) => navigate(`/compose?quote=${encodeURIComponent(post.id)}`);

  const mergePending = () => {
    if (!pendingThread) return;
    setThread(pendingThread);
    setPendingThread(null);
    setNewReplyCount(0);
  };

  if (loading && !thread) {
    return (
      <div className="flex h-full flex-col">
        <ThreadHeader />
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    );
  }

  if (error || !thread || !focal) {
    return (
      <div className="flex h-full flex-col">
        <ThreadHeader />
        <div className="p-4">
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {error ?? "帖子不存在或不可见"}
              <Button size="sm" variant="outline" onClick={() => void load(false)}>
                重试
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ThreadHeader />
      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="thread-scroll">
        {ancestorChain.length > 0 || newReplyCount > 0 ? (
          <div className="sticky top-0 z-20 flex min-h-8 items-center gap-2 border-b border-border/60 bg-background/80 px-2 py-1 backdrop-blur-md">
            {ancestorChain.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="ancestors-toggle"
                onClick={() => setAncestorsExpanded((value) => !value)}
              >
                <ArrowUpIcon data-icon="inline-start" />
                {ancestorsExpanded ? "收起上文" : `${ancestorChain.length} 条上文`}
                {ancestorsExpanded ? (
                  <ChevronDownIcon data-icon="inline-end" />
                ) : (
                  <ChevronRightIcon data-icon="inline-end" />
                )}
              </Button>
            ) : (
              <span />
            )}
            {newReplyCount > 0 ? (
              <Button
                type="button"
                data-testid="new-replies-pill"
                className="ml-auto h-7 rounded-full px-3"
                onClick={mergePending}
              >
                <ArrowUpIcon data-icon="inline-start" />
                {newReplyCount} 条新回复
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 p-3">
          {ancestorsExpanded && ancestorChain.length > 0 ? (
            <Card className="gap-0 divide-y divide-border/60 p-0">
              {ancestorChain
                .slice(0, 3)
                .reverse()
                .map((ancestor) => (
                  <PostCard
                    key={ancestor.id}
                    post={ancestor}
                    variant="ancestor"
                    onOpen={openPost}
                    onReply={replyPost}
                    onQuote={quotePost}
                  />
                ))}
              {ancestorChain.length > 3 ? (
                <div className="px-4 py-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const oldest = ancestorChain.slice(0, 3).at(-1);
                      if (oldest?.parent_id) navigate(`/p/${encodeURIComponent(oldest.parent_id)}`);
                    }}
                  >
                    <ArrowUpIcon data-icon="inline-start" />
                    继续 {ancestorChain.length - 3} 条上文
                  </Button>
                </div>
              ) : null}
            </Card>
          ) : null}

          <Card
            ref={focalRef}
            data-testid="focal-card"
            className="gap-0 p-0"
            style={{ scrollMarginTop: ancestorChain.length > 0 || newReplyCount > 0 ? 40 : 0 }}
          >
            <PostCard
              post={focal}
              variant="focal"
              replyingTo={focalReplyingTo}
              selected={selectedIndex === 0}
              onReply={replyPost}
              onQuote={quotePost}
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
              <span>{fullTime(focal.created_at)}</span>
            </div>
          </Card>

          {focal.deleted_at === null ? (
            <Card ref={composerRef} className="gap-0 p-3" data-testid="reply-box">
              <PostComposer
                mode="reply"
                parentId={focal.id}
                autoFocus={wantReply}
                compact
                placeholder={`回复 @${focal.author}…`}
                onPosted={() => void load(false)}
              />
            </Card>
          ) : (
            <Card className="gap-0 p-3 text-sm text-muted-foreground" data-testid="reply-unavailable">
              此帖已删除，不能再回复。
            </Card>
          )}

          <div className="flex items-center gap-2 px-1 text-sm font-medium">
            <span data-testid="reply-count">{replyGroupCount} 条回复</span>
            <Separator className="flex-1" />
          </div>

          {plan.items.length === 0 ? null : (
            <Card className="gap-0 divide-y divide-border/60 p-0" data-testid="reply-list">
              {plan.items.map((item) => {
                if (item.kind === "node") {
                  return (
                    <div
                      key={`node-${item.node.id}`}
                      className="relative"
                      style={{ marginLeft: item.indent }}
                    >
                      {item.depth > 3 && !item.selfContinuation ? (
                        <span aria-hidden className="absolute left-0 top-0 bottom-0 w-px bg-border" />
                      ) : null}
                      <PostCard
                        post={item.node}
                        variant="reply"
                        selected={selectedIndex === kbNodes.findIndex((node) => node.id === item.node.id)}
                        selfContinuation={item.selfContinuation}
                        selfHeader={item.selfHeader}
                        chainPosition={item.chainPosition}
                        replyingTo={plan.replyingTo.get(item.node.id) ?? null}
                        onOpen={openPost}
                        onReply={replyPost}
                        onQuote={quotePost}
                      />
                    </div>
                  );
                }
                if (item.kind === "read-more") {
                  return (
                    <div key={`read-${item.nodeId}`} style={{ marginLeft: item.indent }} className="px-4 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid="read-more-replies"
                        onClick={() => navigate(`/p/${encodeURIComponent(item.nodeId)}`)}
                      >
                        <ChevronRightIcon data-icon="inline-start" />
                        Read {item.count} more replies
                      </Button>
                    </div>
                  );
                }
                if (item.kind === "backend-collapse") {
                  return (
                    <div key={`backend-${item.nodeId}`} style={{ marginLeft: item.indent }} className="px-4 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/p/${encodeURIComponent(item.nodeId)}`)}
                      >
                        <ChevronDownIcon data-icon="inline-start" />
                        继续 {item.count} 层回复
                      </Button>
                    </div>
                  );
                }
                if (item.kind === "expand-branch") {
                  return (
                    <div key={item.key} style={{ marginLeft: item.indent }} className="px-4 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid="expand-branch"
                        onClick={() =>
                          setExpandedBranches((prev) => {
                            const next = new Set(prev);
                            next.add(item.parentId);
                            return next;
                          })
                        }
                      >
                        <ChevronDownIcon data-icon="inline-start" />
                        展开 {item.count} 条回复
                      </Button>
                    </div>
                  );
                }
                return (
                  <div key={item.key} style={{ marginLeft: item.indent }} className="px-4 py-2">
                    <Button variant="ghost" size="sm" onClick={() => setExtraDepth((depth) => depth + 3)}>
                      <ChevronDownIcon data-icon="inline-start" />
                      继续 {item.count} 层回复
                    </Button>
                  </div>
                );
              })}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function ThreadHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border/60 bg-background/80 px-2 backdrop-blur-md">
      <Button variant="ghost" size="icon-sm" onClick={() => goBack("/")} aria-label="返回">
        <ArrowLeftIcon />
      </Button>
      <h1 className="text-base font-semibold">帖子</h1>
      <span className="ml-auto pr-2 text-xs text-muted-foreground" />
    </header>
  );
}

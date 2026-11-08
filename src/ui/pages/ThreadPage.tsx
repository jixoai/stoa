import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import type { PostView, ThreadNode, ThreadView } from "@core/types";
import { ArrowUpIcon, ChevronRightIcon } from "lucide-react";
import { PostCard } from "@/components/PostCard";
import { ReplyComposer } from "@/components/ReplyComposer";
import { ContentSwap } from "@/components/ContentSwap";
import { PostSkeleton, ThreadSkeleton } from "@/components/Skeletons";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/PageHeader";
import { useConnection } from "@/state/connection";
import { useEventHub, useEventHubView } from "@/state/hub/provider";
import { useNotifications } from "@/state/notifications";
import { getCachedThread, getThreadSeed, rememberThread } from "@/state/cache";
import {
  goBack,
  isViewTransitionRunning,
  navigate,
  routeSource,
  useRoute,
  useTransitionDirection,
  useTransitionEpoch,
} from "@/lib/router";
import { fullTime } from "@/lib/format";
import { loadThreadScrollMemory, saveThreadScrollMemory } from "@/lib/scroll-memory";

// ── 平铺 timeline planner（design report-thread-timeline §2）────────────────────
//
// 一个平面、一条 trunk、一个时间序：祖先链（root → parent）→ focal → 其余节点按
// `(created_at, seq, id)` 升序平铺。没有任何缩进/深度上限/层级控件；关系由
// 「回复给 @x」+ 导轨 + 时间顺序表达。

type PostRole = "ancestor" | "focal" | "reply";

interface PostRow {
  kind: "post";
  key: string;
  node: ThreadNode;
  role: PostRole;
  /** 连续同作者父子：24px 头像居中于 42px 列、无重复作者行/操作栏。 */
  compact: boolean;
  /** 连续自接链首条仍显示作者/时间。 */
  compactHeader: boolean;
  /** 父帖不是上一 post 行时的「回复给 @x」（focal 永不为真）。 */
  replyingTo: string | null;
}

interface SubthreadRow {
  kind: "subthread";
  key: string;
  nodeId: string;
  count: number;
}

type PlanRow = PostRow | SubthreadRow;

interface TimelinePlan {
  rows: PlanRow[];
  replyNodes: ThreadNode[];
  /** 顶部缺口行要跳转的（上一批）帖子 id；null = 不渲染缺口行。 */
  gapParentId: string | null;
  /** 是否有缺口行（深链 focal 的父帖不可解析 / 祖先超过 20 条 UI 阈值）。 */
  gapVisible: boolean;
}

function compareNodes(a: ThreadNode, b: ThreadNode): number {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const ANCESTOR_RENDER_LIMIT = 20;

// 线程 timeline 行几何（design §3；2026-11-08 视觉复核：头像 46 / 正文列 68 / 导轨 x=38）
const THREAD_AVATAR = 46;
const THREAD_AVATAR_GAP = 6;      // 16 + 46 + 6 = 正文列 x=68
const THREAD_PAD_TOP = 12;        // 普通行 pt-3
const FOCAL_PAD_TOP = 22;         // focal 多 10px：首字到吸顶栏 20→28–30
const COMPACT_PAD_TOP = 6;        // 紧凑行 py-1.5
const COMPACT_AVATAR = 24;

function buildTimelinePlan(args: {
  focal: ThreadNode;
  ancestors: ThreadNode[];
  nodes: ThreadNode[];
  nodeMap: Map<string, ThreadNode>;
  collapsedCounts: Map<string, number>;
  /** thread.posts 不含 focal（深链超 maxDepth）：focal 是单帖合成。 */
  deepGap: boolean;
  /** focal.parent_id 解析不到（posts 里没有）：整页只能显示缺口 + focal。 */
  unresolvedGap: boolean;
  /** 完整线程是否已从网络回来；未回来时不得生成「查看该子线程」入口。 */
  loaded: boolean;
}): TimelinePlan {
  const { focal, ancestors, nodes, nodeMap, collapsedCounts, deepGap, unresolvedGap, loaded } = args;
  const ancestorSet = new Set(ancestors.map((node) => node.id));

  // 祖先：root → … → parent；>20 条只渲染最近 20 条，顶部补缺口行（§5.1）。
  // 缺口行跳到「被丢弃的最后一条祖先」（= 最近可见祖先的上一帖），不是它的 parent。
  const ordered = ancestors.slice().reverse();
  let visible = ordered;
  let gapVisible = false;
  let gapParentId: string | null = null;
  if (ordered.length > ANCESTOR_RENDER_LIMIT) {
    const dropped = ordered.slice(0, ordered.length - ANCESTOR_RENDER_LIMIT);
    visible = ordered.slice(-ANCESTOR_RENDER_LIMIT);
    gapVisible = true;
    gapParentId = dropped[dropped.length - 1]?.id ?? null;
  }
  if (unresolvedGap) {
    // focal 的父帖都没随本页返回：让缺口行指向父帖详情（点进去继续上级上下文）。
    gapVisible = true;
    gapParentId = focal.parent_id;
  }

  const loadedDirect = new Map<string, number>();
  for (const node of nodes) {
    if (!node.parent_id) continue;
    loadedDirect.set(node.parent_id, (loadedDirect.get(node.parent_id) ?? 0) + 1);
  }

  // 子线程入口数量：后端折叠优先，否则是「已知子节点里没随本页返回的部分」。
  const unloadedCount = (node: ThreadNode): number => {
    const collapsed = collapsedCounts.get(node.id) ?? 0;
    if (collapsed > 0) return collapsed;
    const loadedChildren = loadedDirect.get(node.id) ?? 0;
    return Math.max(0, node.child_count - loadedChildren);
  };

  const rows: PlanRow[] = [];
  const pushNode = (row: PostRow) => {
    rows.push(row);
    // 种子/骨架阶段 child_count 还不可信（seed 把它当 reply_count），不生成入口。
    if (!loaded) return;
    // 深链缺口模式下 focal 就是当前页，入口会指向自己 → 不渲染。
    if (row.role === "focal" && deepGap) return;
    const count = unloadedCount(row.node);
    if (count > 0) {
      rows.push({ kind: "subthread", key: `sub-${row.node.id}`, nodeId: row.node.id, count });
    }
  };

  for (const ancestor of visible) {
    pushNode({
      kind: "post",
      key: `a-${ancestor.id}`,
      node: ancestor,
      role: "ancestor",
      compact: false,
      compactHeader: false,
      // 祖先链内部父帖就是上一行（首条可能因为裁剪/缺口没有上文，不标）。
      replyingTo: null,
    });
  }

  pushNode({
    kind: "post",
    key: `f-${focal.id}`,
    node: focal,
    role: "focal",
    compact: false,
    compactHeader: false,
    replyingTo: null,
  });

  // 平铺回复：排除 focal 与整条祖先链，按 (created_at, seq, id) 升序。
  //
  // 缺口模式（focal.parent_id 解析不到）下 posts 里全是「不可定位的上文」：
  // 它们既不是 focal 的祖先也不是 focal 的回复，平铺到 focal 下方会把拓扑反过来
  // （祖先显示成回复）。只保留缺口行说明，不再渲染这些行。
  const rest = unresolvedGap
    ? []
    : nodes.filter((node) => node.id !== focal.id && !ancestorSet.has(node.id));
  rest.sort(compareNodes);

  const replyNodes: ThreadNode[] = [];
  let prevPost: ThreadNode | null = focal;
  for (const node of rest) {
    const parentId = node.parent_id;
    const adjacent = parentId !== null && prevPost?.id === parentId;
    const compact = node.is_self_continuation && adjacent;
    const compactHeader = compact && !prevPost?.is_self_continuation;
    const replyingTo =
      parentId !== null && !adjacent
        ? (node.reply_to_account_id ?? nodeMap.get(parentId)?.author ?? parentId)
        : null;
    pushNode({
      kind: "post",
      key: `p-${node.id}`,
      node,
      role: "reply",
      compact,
      compactHeader,
      replyingTo,
    });
    replyNodes.push(node);
    prevPost = node;
  }

  return { rows, replyNodes, gapParentId, gapVisible };
}

// ── timeline 行 + 主轨（design §3.2）─────────────────────────────────────────
//
// 导轨画在行包裹层（不是 PostCard 内部），因此 focal footer / 子线程入口 / 删除占位
// 都在同一条 trunk 上；头像 `relative z-[1]` 盖住导轨，视觉上是「头像上方一段 +
// 下方一段」。

type RowKind = "ancestor" | "focal" | "reply" | "subthread" | "context-gap" | "reply-skeleton";

interface TimelineRowProps {
  kind: RowKind;
  /** 头像上下缘（CSS px）：普通行 pt-3(12) + 46 头像；focal pt-[22px]；紧凑行 6 + 24。 */
  avatarTop?: number;
  avatarBottom?: number;
  first?: boolean;
  last?: boolean;
  postId?: string;
  testId?: string;
  /** focal 的上段导轨同时是贴顶 stub（data-testid=thread-rail-stub）。 */
  stub?: boolean;
  rowRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

function TimelineRow({
  kind,
  avatarTop = 12,
  avatarBottom = 58,
  first = false,
  last = false,
  postId,
  testId,
  stub = false,
  rowRef,
  children,
}: TimelineRowProps) {
  const control = kind === "subthread" || kind === "context-gap" || kind === "reply-skeleton";
  const single = first && last;
  const railPosition = single ? "single" : first ? "first" : last ? "last" : "middle";
  return (
    <div
      ref={rowRef}
      className="relative"
      data-timeline-row={kind}
      data-post-id={postId}
      data-rail-position={railPosition}
      data-testid={testId}
      style={
        {
          "--rail-avatar-top": `${avatarTop}px`,
          "--rail-avatar-bottom": `${avatarBottom}px`,
        } as CSSProperties
      }
    >
      {control ? (
        // 控制行（缺口/子线程入口）没有头像可截断：中间行贯穿整行；末行不再画下段，
        // 否则会留下一截悬空导轨（review 2026-11-08：入口行 y=467 硬切 47px）。
        single || last ? null : (
          <span
            aria-hidden
            data-testid="thread-rail"
            data-thread-rail="full"
            className="pointer-events-none absolute left-[38px] w-0.5 bg-thread-rail"
            style={{ top: 0, bottom: 0 }}
          />
        )
      ) : (
        <>
          {!first ? (
            <span
              aria-hidden
              data-testid={stub ? "thread-rail-stub" : "thread-rail"}
              data-thread-rail="top"
              className="pointer-events-none absolute left-[38px] w-0.5 bg-thread-rail"
              style={{ top: 0, height: avatarTop }}
            />
          ) : null}
          {!last ? (
            <span
              aria-hidden
              data-testid="thread-rail"
              data-thread-rail="bottom"
              className="pointer-events-none absolute left-[38px] w-0.5 bg-thread-rail"
              style={{ top: avatarBottom, bottom: 0 }}
            />
          ) : null}
        </>
      )}
      {children}
    </div>
  );
}

// ── 锚定 / 恢复（design §4）─────────────────────────────────────────────────

/** 容器顶边下方第一条 post 行 + 行内偏移（滚动记忆与解锁后的位移补偿共用）。 */
function readFirstVisible(container: HTMLElement): { id: string; offsetPx: number } | null {
  const top = container.getBoundingClientRect().top;
  for (const row of container.querySelectorAll<HTMLElement>(
    "[data-timeline-row][data-post-id]",
  )) {
    if (row.getBoundingClientRect().bottom > top + 1) {
      return {
        id: row.getAttribute("data-post-id") ?? "",
        offsetPx: row.getBoundingClientRect().top - top,
      };
    }
  }
  return null;
}

/** focal 行在滚动内容里的 offsetTop。 */
function focalOffset(container: HTMLElement, row: HTMLElement): number {
  return row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
}

/**
 * 把 focal 行贴到滚动容器顶边（= 吸顶栏下沿），并用 tail spacer 保证这个位置可达。
 * 全程同步写 scrollTop（无平滑滚动），可在 layout 阶段一次完成。
 */
function anchorToFocal(
  container: HTMLElement,
  row: HTMLElement,
  spacer: HTMLElement | null,
  programmaticTop: { current: number },
): void {
  if (spacer) spacer.style.height = "0px";
  // `container.scrollHeight` 在内容不足一屏时会被浏览器抬到 clientHeight，
  // 用它算「focal 下方内容」会虚高、导致 spacer 补不够（实测 focal 停在 81px 处）。
  // 真实内容是滚动容器的直接子块（timeline + spacer + 编辑器入口条）。
  const contentBox = spacer?.parentElement ?? container.firstElementChild;
  const contentHeight =
    contentBox instanceof HTMLElement ? contentBox.offsetHeight : container.scrollHeight;
  const target0 = focalOffset(container, row);
  const viewport = container.clientHeight;
  const rowHeight = row.offsetHeight;
  const below = Math.max(0, contentHeight - target0 - rowHeight);
  if (spacer) {
    const needed = Math.ceil(Math.max(0, viewport - rowHeight - below));
    spacer.style.height = `${needed}px`;
  }
  const max = Math.max(0, container.scrollHeight - viewport);
  const target = Math.min(Math.round(target0), max);
  programmaticTop.current = target;
  container.scrollTop = target;
  container.dataset.anchor = target < Math.round(target0) ? "clamped" : "ok";
}

/**
 * 把 scrollTop 写到目标值；内容不足一屏时先补 tail spacer，否则目标位置不可达
 * （浏览器会把 scrollTop clamp 到 0，返回恢复/深链都会落空）。
 */
function scrollToTarget(
  container: HTMLElement,
  spacer: HTMLElement | null,
  target: number,
  programmaticTop: { current: number },
): number {
  if (spacer) spacer.style.height = "0px";
  // 补齐到「目标位置可达」：内容高 H、视口 V，则 spacer = target + V - H。
  const contentBox = spacer?.parentElement ?? container.firstElementChild;
  const contentHeight =
    contentBox instanceof HTMLElement ? contentBox.offsetHeight : container.scrollHeight;
  if (spacer) {
    const needed = Math.ceil(Math.max(0, target + container.clientHeight - contentHeight));
    spacer.style.height = `${needed}px`;
  }
  const max = Math.max(0, container.scrollHeight - container.clientHeight);
  const next = Math.min(Math.max(0, target), max);
  programmaticTop.current = next;
  container.scrollTop = next;
  return next;
}

function restoreThreadScroll(
  container: HTMLElement,
  spacer: HTMLElement | null,
  memory: { anchorId: string | null; offsetPx: number; scrollTop: number },
  programmaticTop: { current: number },
  settled: boolean,
): boolean {
  if (memory.anchorId) {
    const row = container.querySelector<HTMLElement>(
      `[data-timeline-row][data-post-id="${CSS.escape(memory.anchorId)}"]`,
    );
    if (row) {
      const top = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
      scrollToTarget(container, spacer, container.scrollTop + top - memory.offsetPx, programmaticTop);
      container.dataset.anchor = "restored";
      return true;
    }
    // 锚点行还没进 DOM（冷缓存）：等内容落地后再试，避免把位置落在错误的高度上。
    if (!settled) return false;
  }
  scrollToTarget(container, spacer, memory.scrollTop, programmaticTop);
  container.dataset.anchor = "restored";
  return true;
}

// ── 初始锚定 / 数据晚到补偿 / 返回恢复（layout 阶段，无平滑滚动）──────────────
//
// 这个「锚定哨兵」必须**渲染在 timeline 内容里**：冷缓存时 focal 行要等
// ContentSwap 从骨架切到内容才挂载（那是 ContentSwap 自己的 state 提交，父组件
// 不会重渲染），父级 useLayoutEffect 等不到那一帧。挂在内容里则与 focal 同一
// 次 commit 挂载，layout 阶段即可量高度并写 scrollTop——浏览器还没 paint。

interface ThreadAnchoringProps {
  containerRef: RefObject<HTMLDivElement | null>;
  rowRef: RefObject<HTMLDivElement | null>;
  spacerRef: RefObject<HTMLDivElement | null>;
  postId: string;
  /** 只随「布局真的变了」而变；选中态等纯渲染不触发锚定/补偿。 */
  anchorKey: string;
  loaded: boolean;
  lastFirstRef: RefObject<{ id: string; offsetPx: number } | null>;
  directionRef: RefObject<"forward" | "back" | "fade">;
  anchorLocked: RefObject<boolean>;
  anchoredFor: RefObject<string | null>;
  programmaticTop: RefObject<number>;
}

function ThreadAnchoring({
  containerRef,
  rowRef,
  spacerRef,
  postId,
  anchorKey,
  loaded,
  lastFirstRef,
  directionRef,
  anchorLocked,
  anchoredFor,
  programmaticTop,
}: ThreadAnchoringProps) {
  /** 布局仍在收敛（回复行落地/字体/媒体）时的重试次数上限。 */
  const retries = useRef(0);

  useLayoutEffect(() => {
    let cancelled = false;
    let attempts = 0;

    const anchorNow = () => {
      const current = containerRef.current;
      const currentRow = rowRef.current;
      if (!current || !currentRow || !anchorLocked.current) return;
      anchorToFocal(current, currentRow, spacerRef.current, programmaticTop);
      // 内容还在长高时第一遍可能被 clamp：下一帧再量一次（同一帧内布局不会变）。
      if (current.dataset.anchor === "clamped" && retries.current < 3) {
        retries.current += 1;
        requestAnimationFrame(anchorNow);
      }
    };

    const run = () => {
      if (cancelled) return;
      const container = containerRef.current;
      const row = rowRef.current;
      // 首次 commit 里祖先 host 的 ref 可能还没挂（React 先跑子布局效应再挂宿主 ref）：
      // 微任务里重试（仍在 paint 之前），否则这一次锚定会被永久跳过。
      if ((!container || !row) && attempts < 3) {
        attempts += 1;
        queueMicrotask(run);
        return;
      }
      if (!container || !row) return;

      if (anchoredFor.current !== postId) {
        const memory = directionRef.current === "back" ? loadThreadScrollMemory(postId) : null;
        if (memory) {
          if (!restoreThreadScroll(container, spacerRef.current, memory, programmaticTop, loaded)) {
            return; // 等内容就绪再试
          }
          anchoredFor.current = postId;
          anchorLocked.current = false;
          lastFirstRef.current = readFirstVisible(container);
          return;
        }
        if (!anchorLocked.current) {
          anchoredFor.current = postId;
          return;
        }
        anchoredFor.current = postId;
        anchorNow();
        lastFirstRef.current = readFirstVisible(container);
        return;
      }

      if (anchorLocked.current) {
        // 种子/骨架 → 完整线程，或回复合并：用户没滚动过就同一 layout 帧重新贴回 focal。
        anchorNow();
      } else {
        // 已解锁：数据更新只做「保持首可见行」补偿（design §4.2.7），绝不拉回 focal。
        const prev = lastFirstRef.current;
        if (prev?.id) {
          const previousRow = container.querySelector<HTMLElement>(
            `[data-timeline-row][data-post-id="${CSS.escape(prev.id)}"]`,
          );
          if (previousRow) {
            const top =
              previousRow.getBoundingClientRect().top - container.getBoundingClientRect().top;
            const delta = top - prev.offsetPx;
            if (Math.abs(delta) > 2) {
              programmaticTop.current = container.scrollTop + delta;
              container.scrollTop = programmaticTop.current;
            }
          }
        }
      }
      lastFirstRef.current = readFirstVisible(container);
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [anchorKey]);
  return null;
}

export function ThreadPage() {
  const route = useRoute();
  const postId = route.name === "post" ? route.id : "";
  const source = routeSource(route);
  const wantReply = route.name === "post" && route.reply === true;
  const { client, staticMode } = useConnection();
  // 首帧优先用已见线程；只有单帖缓存时也要把焦点帖排出来（合成线程），
  // 回复区在下方用骨架占位——转场快照即最终排版，转场结束后焦点帖不再移动。
  const [thread, setThread] = useState<ThreadView | null>(() =>
    postId ? getThreadSeed(postId) : null,
  );
  /** 完整线程是否已从网络回来（回复骨架 → 真实回复的开关）。 */
  const [loaded, setLoaded] = useState(() => Boolean(postId && getCachedThread(postId)));
  /**
   * 转场进行中到达的网络结果先挂起：转场快照必须与落位后的页面一致，
   * 否则「快照撤掉那一刻」会看到页面跳变（第二次导航抖动的直接原因）。
   */
  const heldThread = useRef<ThreadView | null>(null);
  const heldLoaded = useRef(false);
  const transitionEpoch = useTransitionEpoch();
  const commitThread = useCallback((next: ThreadView, done: boolean) => {
    if (isViewTransitionRunning()) {
      heldThread.current = next;
      heldLoaded.current = done;
      return;
    }
    setThread(next);
    if (done) setLoaded(true);
  }, []);
  useEffect(() => {
    if (isViewTransitionRunning()) return;
    if (!heldThread.current) return;
    const next = heldThread.current;
    const done = heldLoaded.current;
    heldThread.current = null;
    heldLoaded.current = false;
    setThread(next);
    if (done) setLoaded(true);
  }, [transitionEpoch]);
  const [error, setError] = useState<string | null>(null);
  const [pendingThread, setPendingThread] = useState<ThreadView | null>(null);
  const [newReplyCount, setNewReplyCount] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  /** focal 被服务端截断（深链超 maxDepth）时用单帖接口补出来的焦点帖。 */
  const [syntheticFocal, setSyntheticFocal] = useState<PostView | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focalRowRef = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  /** 用户首次 wheel/touch/pointer/key 或「非我们写的」scroll 之后解除锚定。 */
  const anchorLocked = useRef(true);
  const anchoredFor = useRef<string | null>(null);
  const programmaticTop = useRef(-1);
  /** 已解锁时的「首可见行」基线（滚动时与每次 layout 后更新）。 */
  const lastFirstRef = useRef<{ id: string; offsetPx: number } | null>(null);
  const direction = useTransitionDirection();
  const directionRef = useRef(direction);
  directionRef.current = direction;
  // 打开详情即已读（Owner 2026-11-07）：按帖记录到本端读集合，不管从哪条路径进来
  // （时间线/成员页/搜索/通知）都生效；不推进服务端游标，别的旧帖不受影响。
  const notifications = useNotifications();
  const markPostRead = notifications.markPostRead;
  useEffect(() => {
    if (!postId) return;
    markPostRead(postId);
  }, [postId, markPostRead]);

  /** 沉浸式回复编辑器：默认收起，点回复入口 / ?reply=1 才展开。 */
  const [replyOpen, setReplyOpen] = useState(false);
  const autoReplyOpened = useRef(false);
  const refreshTimer = useRef<number | null>(null);
  const threadRef = useRef<ThreadView | null>(null);
  threadRef.current = thread;

  const load = useCallback(
    async (silent = false) => {
      if (!client || !postId) return;
      if (!silent) setError(null);
      try {
        const next = await client.thread(postId, postId);
        rememberThread(postId, next);
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
            commitThread(next, true);
          }
        } else {
          commitThread(next, true);
          setPendingThread(null);
          setNewReplyCount(0);
        }
        setError(null);
      } catch (err) {
        if (!silent) setError((err as Error).message);
      }
    },
    [client, postId],
  );

  useEffect(() => {
    setThread(postId ? getThreadSeed(postId) : null);
    setLoaded(Boolean(postId && getCachedThread(postId)));
    setPendingThread(null);
    setNewReplyCount(0);
    setSelectedIndex(-1);
    setSyntheticFocal(null);
    void load(false);
  }, [load]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void load(true);
    }, 350);
  }, [load]);

  // Hub（共享单流）：本会话有新帖 → 静默补拉，进 pending（不直接重排）；
  // 删除按 root/post id 命中 → 同样静默补拉（帖子转墓碑/消失）。
  // reset 是总线声明的空洞：强重取（清 pending 与易变投影）；重连只轻量补拉。
  useEventHub(
    ["post.created", "post.deleted", "stream.reset", "stream.reconnected"],
    (dispatch) => {
      if (dispatch.topic === "stream.reset") {
        void load(false);
        return;
      }
      if (dispatch.topic === "stream.reconnected") {
        scheduleRefresh();
        return;
      }
      if (dispatch.topic !== "post.created" && dispatch.topic !== "post.deleted") return;
      const current = threadRef.current;
      if (!current) return;
      const event = dispatch.event;
      if (
        event.root_id === current.root_id ||
        event.post_id === current.root_id ||
        event.post_id === postId
      ) {
        if (dispatch.topic === "post.deleted") {
          // 删除必须立即提交（静默补拉只在「有新回复」时替换视图，删除会被忽略）。
          void load(false);
        } else {
          scheduleRefresh();
        }
      }
    },
  );

  // 活跃视图：首连 since / hello 后补拉 / reset 强重取（thread 加载出 as_of_seq 后才注册）。
  useEventHubView(
    thread && thread.as_of_seq > 0
      ? {
          asOfSeq: thread.as_of_seq,
          catchUp: () => load(true),
          reload: () => load(false),
        }
      : null,
  );

  useEffect(() => {
    return () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  const nodes = useMemo(() => thread?.posts ?? [], [thread]);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const focalId = thread?.focal_id ?? postId;
  const focalInPosts = useMemo(
    () => Boolean(thread?.posts.some((post) => post.id === focalId)),
    [thread, focalId],
  );
  const focalFromPosts = useMemo(
    () => nodeMap.get(focalId) ?? nodeMap.get(postId) ?? null,
    [nodeMap, focalId, postId],
  );

  // 深链超过 maxDepth：focal 不在 posts 里 → 用现有单帖接口补出焦点帖（不改接口）。
  useEffect(() => {
    if (!client || !postId || !thread || focalInPosts) return;
    let alive = true;
    void client
      .post(postId)
      .then((post) => {
        if (alive) setSyntheticFocal(post);
      })
      .catch((err: unknown) => {
        if (alive) setError((err as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [client, postId, thread, focalInPosts]);

  // 单帖 seed 被完整线程替换、合成 focal 还没回来时，保留上一帧的 focal，
  // 避免 ContentSwap 已进入 content 却渲染空内容（闪空）。
  const lastFocalRef = useRef<ThreadNode | null>(null);
  if (focalFromPosts) lastFocalRef.current = focalFromPosts;

  const focal = useMemo<ThreadNode | null>(() => {
    if (focalFromPosts) return focalFromPosts;
    if (!syntheticFocal) return lastFocalRef.current;
    return {
      ...syntheticFocal,
      depth: 0,
      is_spine: true,
      is_self_continuation: false,
      child_count: syntheticFocal.reply_count,
    };
  }, [focalFromPosts, syntheticFocal]);

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

  const collapsedCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const group of thread?.collapsed ?? []) {
      map.set(group.parent_id, (map.get(group.parent_id) ?? 0) + group.count);
    }
    return map;
  }, [thread?.collapsed]);

  const deepGap = Boolean(thread && focal && !focalInPosts);
  // focal 不在 posts，且它的父帖也解析不到 → 本页只有「缺口行 + focal」；
  // 父帖能解析时按正常祖先链渲染，不要伪造「更早的回复未加载」。
  const unresolvedGap = Boolean(
    deepGap && focal?.parent_id !== null && !nodeMap.has(focal?.parent_id ?? ""),
  );
  const plan = useMemo<TimelinePlan>(() => {
    if (!focal) {
      return { rows: [], replyNodes: [], gapParentId: null, gapVisible: false };
    }
    return buildTimelinePlan({
      focal,
      ancestors: ancestorChain,
      nodes,
      nodeMap,
      collapsedCounts,
      deepGap,
      unresolvedGap,
      loaded,
    });
  }, [focal, ancestorChain, nodes, nodeMap, collapsedCounts, deepGap, unresolvedGap, loaded]);

  type RenderRow =
    | { kind: "context-gap"; key: string; parentId: string | null }
    | PlanRow
    | { kind: "reply-skeleton"; key: string };

  const rows = useMemo<RenderRow[]>(() => {
    const out: RenderRow[] = [];
    if (plan.gapVisible && (plan.gapParentId || plan.gapVisible)) {
      out.push({
        kind: "context-gap",
        key: "context-gap",
        parentId: plan.gapParentId,
      });
    }
    out.push(...plan.rows);
    if (!loaded) {
      out.push({ kind: "reply-skeleton", key: "reply-skeleton-1" });
      out.push({ kind: "reply-skeleton", key: "reply-skeleton-2" });
    }
    return out;
  }, [plan.rows, plan.gapParentId, plan.gapVisible, loaded]);

  /** 只随布局变化的键：锚定/补偿只在它变化时跑，选中态等纯渲染不触发。 */
  const anchorKey = `${postId}|${ancestorChain.length}|${plan.rows.length}|${loaded ? 1 : 0}|${thread?.as_of_seq ?? 0}`;


  // 首次滚动即解锁：wheel/touch/pointer/key，以及「不是我们写进去的」scroll。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const unlock = () => {
      anchorLocked.current = false;
    };
    const onScroll = () => {
      if (Math.abs(container.scrollTop - programmaticTop.current) > 1) unlock();
    };
    container.addEventListener("wheel", unlock, { passive: true });
    container.addEventListener("touchstart", unlock, { passive: true });
    container.addEventListener("pointerdown", unlock);
    container.addEventListener("keydown", unlock);
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("wheel", unlock);
      container.removeEventListener("touchstart", unlock);
      container.removeEventListener("pointerdown", unlock);
      container.removeEventListener("keydown", unlock);
      container.removeEventListener("scroll", onScroll);
    };
  }, [postId]);

  // 窗口尺寸变化：仍未解锁时重算 F / spacer / scrollTop。
  useEffect(() => {
    const onResize = () => {
      const container = containerRef.current;
      const row = focalRowRef.current;
      if (!container || !row || !anchorLocked.current) return;
      anchorToFocal(container, row, spacerRef.current, programmaticTop);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 滚动位置记忆：首可见行 + 行内偏移（sessionStorage，同一会话返回可恢复）。
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !postId) return;
    let frame = 0;
    const save = () => {
      // 卸载清理时 DOM 可能已被摘除：此时量出来全是 0，会覆盖掉上一次的好记忆。
      if (!container.isConnected || container.clientHeight === 0) return;
      const first = readFirstVisible(container);
      lastFirstRef.current = first;
      saveThreadScrollMemory(postId, {
        anchorId: first?.id ?? null,
        offsetPx: first?.offsetPx ?? 0,
        scrollTop: container.scrollTop,
      });
    };
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        save();
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") save();
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", onVisibility);
      if (frame !== 0) cancelAnimationFrame(frame);
      save();
    };
  }, [postId]);

  // ?reply=1 是明确的回复意图：线程到位后直接展开编辑器（只自动展开一次，
  // 关闭后即便线程刷新也不再弹回）。
  useEffect(() => {
    if (!wantReply || !focal || focal.deleted_at !== null) return;
    if (autoReplyOpened.current) return;
    autoReplyOpened.current = true;
    setReplyOpen(true);
  }, [wantReply, focal]);

  // 键盘：j/k 移动，Enter 打开该条详情，r 回复
  const replyNodes = plan.replyNodes;
  const kbNodes = useMemo(
    () => (focal ? [focal, ...replyNodes] : []),
    [focal, replyNodes],
  );
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      // j/k、PageDown/Space/方向键都会滚动：先解锁锚定，否则重渲染立刻把 scrollTop 写回 focal。
      if (
        ["j", "k", "PageDown", "PageUp", "Home", "End", " ", "ArrowDown", "ArrowUp"].includes(
          event.key,
        )
      ) {
        anchorLocked.current = false;
      }
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

  if (error && !focal) {
    return (
      <div className="flex h-full flex-col">
        <ThreadHeader source={source} />
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

  const lastIndex = rows.length - 1;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ThreadHeader source={source} />
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className="h-full overflow-y-auto"
          style={{ overflowAnchor: "none" }}
          data-testid="thread-scroll"
        >
          <ContentSwap
            ready={Boolean(focal)}
            animateHeight={false}
            skeleton={<ThreadSkeleton />}
            testId="thread-swap"
          >
            {focal ? (
              <>
                <div data-testid="thread-timeline" className="divide-y divide-border/60">
                  {rows.map((row, index) => {
                    const first = index === 0;
                    const last = index === lastIndex;

                    if (row.kind === "context-gap") {
                      return (
                        <TimelineRow
                          key={row.key}
                          kind="context-gap"
                          first={first}
                          last={last}
                          testId="context-gap"
                        >
                          <div className="py-3 pl-[68px] pr-4">
                            <p className="text-sm text-muted-foreground">
                              更早的回复未加载
                            </p>
                            {row.parentId ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                data-testid="context-gap-open"
                                data-node-id={row.parentId}
                                className="-ml-2 mt-1 h-8 px-2 text-sm"
                                onClick={() => navigate(`/p/${encodeURIComponent(row.parentId!)}`)}
                              >
                                <ChevronRightIcon data-icon="inline-start" />
                                查看上一帖
                              </Button>
                            ) : null}
                          </div>
                        </TimelineRow>
                      );
                    }

                    if (row.kind === "subthread") {
                      return (
                        <TimelineRow
                          key={row.key}
                          kind="subthread"
                          first={first}
                          last={last}
                        >
                          <div className="py-2 pl-[68px] pr-4">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              data-testid="subthread-entry"
                              data-node-id={row.nodeId}
                              className="-ml-2 h-8 gap-1.5 px-2 text-sm text-muted-foreground hover:text-foreground"
                              onClick={() => navigate(`/p/${encodeURIComponent(row.nodeId)}`)}
                            >
                              <ChevronRightIcon data-icon="inline-start" />
                              查看该子线程 · {row.count} 条回复
                            </Button>
                          </div>
                        </TimelineRow>
                      );
                    }

                    if (row.kind === "reply-skeleton") {
                      return (
                        <TimelineRow
                          key={row.key}
                          kind="reply-skeleton"
                          first={first}
                          last={last}
                        >
                          <PostSkeleton compact />
                        </TimelineRow>
                      );
                    }

                    const node = row.node;
                    const isFocal = row.role === "focal";
                    const kbIndex = isFocal
                      ? 0
                      : kbNodes.findIndex((candidate) => candidate.id === node.id);
                    return (
                      <TimelineRow
                        key={row.key}
                        kind={row.role}
                        first={first}
                        last={last}
                        postId={node.id}
                        stub={isFocal && !first}
                        testId={isFocal ? "focal-card-row" : undefined}
                        avatarTop={
                          row.compact ? COMPACT_PAD_TOP : isFocal ? FOCAL_PAD_TOP : THREAD_PAD_TOP
                        }
                        avatarBottom={
                          row.compact
                            ? COMPACT_PAD_TOP + COMPACT_AVATAR
                            : (isFocal ? FOCAL_PAD_TOP : THREAD_PAD_TOP) + THREAD_AVATAR
                        }
                        rowRef={isFocal ? focalRowRef : undefined}
                      >
                        <div data-testid={isFocal ? "focal-card" : undefined}>
                          <PostCard
                            post={node}
                            variant={isFocal ? "focal" : row.role === "ancestor" ? "ancestor" : "reply"}
                            selected={kbIndex >= 0 && kbIndex === selectedIndex}
                            replyingTo={row.replyingTo}
                            selfContinuation={row.compact}
                            selfHeader={row.compactHeader}
                            avatarPx={row.compact ? undefined : THREAD_AVATAR}
                            avatarGapPx={THREAD_AVATAR_GAP}
                            paddingTop={isFocal ? FOCAL_PAD_TOP : THREAD_PAD_TOP}
                            onOpen={isFocal ? undefined : openPost}
                            onReply={replyPost}
                            onQuote={quotePost}
                          />
                          {isFocal ? (
                            <div className="flex flex-wrap items-center gap-2 border-t border-border/60 py-2 pl-[68px] pr-4 text-xs text-muted-foreground">
                              <span>{fullTime(node.created_at)}</span>
                              <span aria-hidden>·</span>
                              <span data-testid="reply-count">
                                {node.reply_count > 0
                                  ? `${node.reply_count} 条回复`
                                  : "还没有回复"}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </TimelineRow>
                    );
                  })}
                </div>

                {staticMode ? (
                  <div
                    className="border-b border-border/60 px-4 py-3 text-sm text-muted-foreground"
                    data-testid="reply-readonly"
                  >
                    静态归档 · 只读：这条线程以导出时的快照为准，不能回复。
                  </div>
                ) : focal.deleted_at === null ? null : (
                  <div
                    className="border-b border-border/60 px-4 py-3 text-sm text-muted-foreground"
                    data-testid="reply-unavailable"
                  >
                    此帖已删除，不能再回复。
                  </div>
                )}

                <div
                  ref={spacerRef}
                  aria-hidden
                  data-testid="thread-tail-spacer"
                  style={{ height: "0px" }}
                />

                {focal.deleted_at === null && !staticMode ? (
                  <div className="sticky bottom-0 z-20 border-t border-border/60 bg-background/85 px-3 py-2 backdrop-blur-md">
                    <Button
                      type="button"
                      variant="outline"
                      data-testid="reply-open"
                      aria-label={`回复 @${focal.author}`}
                      onClick={() => setReplyOpen(true)}
                      className="h-10 w-full justify-start rounded-full border-border/70 bg-muted/40 px-4 text-sm font-normal text-muted-foreground hover:bg-muted/70"
                    >
                      发布你的回复
                    </Button>
                  </div>
                ) : null}

                <ThreadAnchoring
                  containerRef={containerRef}
                  rowRef={focalRowRef}
                  spacerRef={spacerRef}
                  postId={postId}
                  anchorKey={anchorKey}
                  loaded={loaded}
                  lastFirstRef={lastFirstRef}
                  directionRef={directionRef}
                  anchorLocked={anchorLocked}
                  anchoredFor={anchoredFor}
                  programmaticTop={programmaticTop}
                />
              </>
            ) : null}
          </ContentSwap>
        </div>
        {newReplyCount > 0 ? (
          <div className="pointer-events-none absolute right-3 top-3 z-20">
            <Button
              type="button"
              data-testid="new-replies-pill"
              className="pointer-events-auto h-7 rounded-full px-3"
              onClick={mergePending}
            >
              <ArrowUpIcon data-icon="inline-start" />
              {newReplyCount} 条新回复
            </Button>
          </div>
        ) : null}
      </div>
      {focal && focal.deleted_at === null && !staticMode ? (
        <ReplyComposer
          post={focal}
          open={replyOpen}
          onOpenChange={setReplyOpen}
          onPosted={() => void load(false)}
        />
      ) : null}
    </div>
  );
}

function ThreadHeader({ source }: { source: string }) {
  return (
    <PageHeader
      title="帖子"
      back
      onBack={() => goBack("/")}
      backTestId="thread-back"
      source={`来自${source}`}
      sourceTestId="thread-source"
      // 吸顶栏：半透明玻璃 + thread-hairline 下边线（视觉复核项 9）。
      tone="thread"
    />
  );
}

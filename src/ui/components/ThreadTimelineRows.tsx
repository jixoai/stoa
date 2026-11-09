/**
 * 线程平铺行渲染件（report-longform §4.2 抽取 / report-thread-timeline §3 既有度量）：
 * ThreadPage 与 ArticlePage 的嵌入式讨论区共用同一份「行 + 导轨 + 子线程入口 +
 * 回复给 @x + 删除占位」实现——**禁止第二套度量**（design §11 冲突面策略）。
 *
 * 几何常量（2026-11-08 视觉复核）：头像 46 / 正文列 x=68 / 导轨 x=38；
 * compact 自接续接行 24px 头像同轴（中心 39）。
 */
import type { CSSProperties, ReactNode, Ref } from "react";
import type { PostView, ThreadNode } from "@core/types";
import { ChevronRightIcon } from "lucide-react";
import { PostCard } from "@/components/PostCard";
import { PostSkeleton } from "@/components/Skeletons";
import { Button } from "@/components/ui/button";
import type { PlanRow } from "@/lib/thread-plan";

// 线程 timeline 行几何（design §3）
export const THREAD_AVATAR = 46;
export const THREAD_AVATAR_GAP = 6; // 16 + 46 + 6 = 正文列 x=68
export const THREAD_PAD_TOP = 12; // 普通行 pt-3
export const FOCAL_PAD_TOP = 22; // focal 多 10px：首字到吸顶栏 20→28–30
export const COMPACT_PAD_TOP = 6; // 紧凑行 py-1.5
export const COMPACT_AVATAR = 24;

type RowKind = "ancestor" | "focal" | "reply" | "subthread" | "context-gap" | "reply-skeleton";

export interface TimelineRowProps {
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

/** 导轨包裹行（画在行包裹层：focal 附加内容 / 子线程入口 / 删除占位都在同一条 trunk 上）。 */
export function TimelineRow({
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

export interface ThreadTimelineRowsProps {
  /** 已挑选的行（ThreadPage 传 plan.rows；讨论区传过滤后的 reply/subthread 行）。 */
  rows: PlanRow[];
  /** false 时追加两条回复骨架（ThreadPage 首屏「回复区在下方用骨架占位」）。 */
  loaded: boolean;
  gapVisible?: boolean;
  gapParentId?: string | null;
  /** 键盘高亮的节点 id（j/k 选中态；null/缺省＝无选中）。 */
  selectedId?: string | null;
  /** focal 行 ref（滚动锚定用）。 */
  focalRowRef?: Ref<HTMLDivElement>;
  /** focal 行附加内容（ThreadPage 的时间/回复数 footer）。 */
  renderFocalExtra?: (node: ThreadNode) => ReactNode;
  /**
   * 打开帖子（article → `#/a/<id>`）。
   * focal 行：note 不接（本页就是它的线程页）；**article 接**——摘要卡的
   * 「阅读全文」入口由此渲染（spec report-app-ui「/p/<articleId> focal 用摘要卡 +
   * 「阅读全文」入口」，复核 B1）。
   */
  onOpen?: (post: PostView) => void;
  onReply?: (post: PostView) => void;
  onQuote?: (post: PostView) => void;
  /** 子线程入口 / 缺口「查看上一帖」的目标（默认线程页 `/p/<id>`）。 */
  onOpenThread: (postId: string) => void;
  /** 自定义子线程入口文案前缀（讨论区用；缺省「查看该子线程」）。 */
  subthreadLabel?: string;
}

/**
 * 平铺行列表：缺口行（可选）→ plan rows → 骨架行（未加载）。
 * `first/last` 按最终渲染序列计算（导轨端点）。
 */
export function ThreadTimelineRows({
  rows,
  loaded,
  gapVisible = false,
  gapParentId = null,
  selectedId = null,
  focalRowRef,
  renderFocalExtra,
  onOpen,
  onReply,
  onQuote,
  onOpenThread,
  subthreadLabel = "查看该子线程",
}: ThreadTimelineRowsProps) {
  // 槽位：缺口行（可选）→ plan rows → 骨架行（未加载）；first/last 按最终序列计算。
  type Slot = Omit<TimelineRowProps, "first" | "last" | "children"> & { children: ReactNode };
  const slots: Slot[] = [];
  if (gapVisible) {
    slots.push({
      kind: "context-gap",
      children: (
        <div className="py-3 pl-[68px] pr-4">
          <p className="text-sm text-muted-foreground">更早的回复未加载</p>
          {gapParentId ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="context-gap-open"
              data-node-id={gapParentId}
              className="-ml-2 mt-1 h-8 px-2 text-sm"
              onClick={() => onOpenThread(gapParentId)}
            >
              <ChevronRightIcon data-icon="inline-start" />
              查看上一帖
            </Button>
          ) : null}
        </div>
      ),
    });
  }
  for (const row of rows) {
    if (row.kind === "subthread") {
      slots.push({
        kind: "subthread",
        children: (
          <div className="py-2 pl-[68px] pr-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="subthread-entry"
              data-node-id={row.nodeId}
              className="-ml-2 h-8 gap-1.5 px-2 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => onOpenThread(row.nodeId)}
            >
              <ChevronRightIcon data-icon="inline-start" />
              {subthreadLabel} · {row.count} 条回复
            </Button>
          </div>
        ),
      });
      continue;
    }
    const node = row.node;
    const isFocal = row.role === "focal";
    const selected = selectedId !== null && node.id === selectedId;
    slots.push({
      kind: row.role,
      postId: node.id,
      testId: isFocal ? "focal-card-row" : undefined,
      stub: isFocal && rows[0] !== row,
      avatarTop: row.compact ? COMPACT_PAD_TOP : isFocal ? FOCAL_PAD_TOP : THREAD_PAD_TOP,
      avatarBottom: row.compact
        ? COMPACT_PAD_TOP + COMPACT_AVATAR
        : (isFocal ? FOCAL_PAD_TOP : THREAD_PAD_TOP) + THREAD_AVATAR,
      rowRef: isFocal ? focalRowRef : undefined,
      children: (
        <div data-testid={isFocal ? "focal-card" : undefined}>
          <PostCard
            post={node}
            variant={isFocal ? "focal" : row.role === "ancestor" ? "ancestor" : "reply"}
            selected={selected}
            replyingTo={row.replyingTo}
            selfContinuation={row.compact}
            selfHeader={row.compactHeader}
            avatarPx={row.compact ? undefined : THREAD_AVATAR}
            avatarGapPx={THREAD_AVATAR_GAP}
            paddingTop={isFocal ? FOCAL_PAD_TOP : THREAD_PAD_TOP}
            // focal note：不导航（focal = 本页主体，卡点击无去处）；
            // focal article：接 onOpen → 摘要卡「阅读全文」渲染并跳 `#/a/<id>`。
            onOpen={isFocal && node.kind !== "article" ? undefined : onOpen}
            onReply={onReply}
            onQuote={onQuote}
          />
          {isFocal && renderFocalExtra ? renderFocalExtra(node) : null}
        </div>
      ),
    });
  }
  if (!loaded) {
    for (const index of [0, 1]) {
      slots.push({
        kind: "reply-skeleton",
        children: <PostSkeleton compact />,
      });
    }
  }
  const last = slots.length - 1;
  return (
    <div data-testid="thread-timeline" className="divide-y divide-border/60">
      {slots.map((slot, index) => (
        <TimelineRow key={`${slot.kind}-${index}`} {...slot} first={index === 0} last={index === last} />
      ))}
    </div>
  );
}

/**
 * 骨架 → 内容的稳定交接（design report-app-grade §3.2）。
 *
 * 时序（与路由转场配合）：
 *   1. 路由切换时先用**已有数据/骨架**完成目标页排版（View Transition 快照里就是最终结构）；
 *   2. 数据在转场期间回来 → 这里做一次交叉淡入：骨架淡出、内容淡入；
 *   3. 容器高度从骨架高度**平滑过渡**到内容高度，避免「骨架塌掉再弹开」的二次抖动。
 *
 * 命中实体缓存（ready 在挂载时已为 true）时直接渲染内容，不播任何动画。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import { isViewTransitionRunning, useTransitionEpoch } from "@/lib/router";

type Phase = "skeleton" | "swap" | "content";

const SWAP_MS = 240;

export interface ContentSwapProps {
  /** 数据是否已经可以渲染（缓存命中时初始即为 true）。 */
  ready: boolean;
  skeleton: ReactNode;
  children: ReactNode;
  className?: string;
  /** 骨架阶段的最小高度（撑住转场快照，避免半屏空页）。 */
  skeletonMinHeight?: string;
  /**
   * 骨架→内容的容器高度过渡（默认 240ms）。
   *
   * 线程页把它设为 false：内容必须**以最终高度一次落地**，锚定在同一 layout 帧完成；
   * 否则容器先被钳在骨架高度，`scrollTop = focalOffset` 被浏览器 clamp，出现
   * 「先看到上文再跳到 focal」的中间帧（design report-thread-timeline §4.2）。
   * 骨架淡出照旧；内容侧的 `report-swap-in` 带 4px 位移，会让 focal 在首帧后
   * 再移动 4px，故该模式下不播。
   */
  animateHeight?: boolean;
  testId?: string;
}

export function ContentSwap({
  ready,
  skeleton,
  children,
  className,
  skeletonMinHeight = "58dvh",
  animateHeight = true,
  testId,
}: ContentSwapProps) {
  const [phase, setPhase] = useState<Phase>(ready ? "content" : "skeleton");
  const epoch = useTransitionEpoch();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const skeletonRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // 数据到位：**等正在播放的路由转场结束**再做交接（转场快照必须与落位后的页面一致，
  // 否则快照撤掉那一刻会看到高度跳变）；然后先把容器钉在骨架高度，同一帧换成内容，
  // 交给下一个 effect 做高度过渡。
  useLayoutEffect(() => {
    if (phase !== "skeleton" || !ready) return;
    if (isViewTransitionRunning()) return;
    const box = boxRef.current;
    if (box && animateHeight) {
      const from = skeletonRef.current?.offsetHeight ?? 0;
      box.style.height = `${from}px`;
      box.style.overflow = "hidden";
    }
    setPhase("swap");
  }, [ready, phase, epoch, animateHeight]);

  useLayoutEffect(() => {
    if (phase !== "swap") return;
    const box = boxRef.current;
    const content = contentRef.current;
    if (!box || !content) return;
    if (!animateHeight) {
      // 高度直落：容器不钉骨架高度、不做 transition，内容以最终高度参与布局（锚定可在同帧完成）。
      box.style.transition = "none";
      box.style.height = "";
      box.style.overflow = "";
      return;
    }
    const from = box.offsetHeight;
    const to = content.offsetHeight;
    box.style.transition = "none";
    box.style.height = `${from}px`;
    const raf = requestAnimationFrame(() => {
      box.style.transition = `height ${SWAP_MS}ms var(--ios-ease-out)`;
      box.style.height = `${to}px`;
    });
    return () => cancelAnimationFrame(raf);
  }, [phase, animateHeight]);

  useEffect(() => {
    if (phase !== "swap") return;
    const timer = window.setTimeout(() => {
      const box = boxRef.current;
      if (box) {
        box.style.transition = "";
        box.style.height = "";
        box.style.overflow = "";
      }
      setPhase("content");
    }, SWAP_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return (
    <div
      ref={boxRef}
      className={cn("relative", className)}
      style={phase === "skeleton" ? { minHeight: skeletonMinHeight } : undefined}
      data-testid={testId}
      data-phase={phase}
    >
      {phase !== "content" ? (
        <div
          ref={skeletonRef}
          className={cn(phase === "swap" && "pointer-events-none absolute inset-x-0 top-0 report-swap-out")}
          aria-hidden={phase === "swap" ? true : undefined}
        >
          {skeleton}
        </div>
      ) : null}
      {phase !== "skeleton" ? (
        <div
          ref={contentRef}
          className={cn(phase === "swap" && animateHeight && "report-swap-in")}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

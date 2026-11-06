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
  testId?: string;
}

export function ContentSwap({
  ready,
  skeleton,
  children,
  className,
  skeletonMinHeight = "58dvh",
  testId,
}: ContentSwapProps) {
  const [phase, setPhase] = useState<Phase>(ready ? "content" : "skeleton");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const skeletonRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // 数据到位：先把容器钉在骨架高度，再在同一帧里换成内容，交给下一个 effect 做高度过渡。
  useLayoutEffect(() => {
    if (phase !== "skeleton" || !ready) return;
    const box = boxRef.current;
    const from = skeletonRef.current?.offsetHeight ?? 0;
    if (box) {
      box.style.height = `${from}px`;
      box.style.overflow = "hidden";
    }
    setPhase("swap");
  }, [ready, phase]);

  useLayoutEffect(() => {
    if (phase !== "swap") return;
    const box = boxRef.current;
    const content = contentRef.current;
    if (!box || !content) return;
    const from = box.offsetHeight;
    const to = content.offsetHeight;
    box.style.transition = "none";
    box.style.height = `${from}px`;
    const raf = requestAnimationFrame(() => {
      box.style.transition = `height ${SWAP_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      box.style.height = `${to}px`;
    });
    return () => cancelAnimationFrame(raf);
  }, [phase]);

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
        <div ref={contentRef} className={cn(phase === "swap" && "report-swap-in")}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

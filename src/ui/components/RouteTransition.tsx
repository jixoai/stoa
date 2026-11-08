/**
 * 路由转场容器。
 *
 * 主路径（现代浏览器）：View Transitions API。本组件只提供一个稳定的 DOM 容器，
 * 真正的新旧页快照与共享元素连续变形由浏览器完成（见 lib/router.ts 与 app.css）。
 *
 * 降级路径（`document.startViewTransition` 不存在）：`motion/react` 的
 * `AnimatePresence` 做同一语义的 transform/opacity 转场；`prefers-reduced-motion`
 * 时两条路径都瞬时完成。
 */
import type { ReactNode } from "react";
import { cn } from "cn";
import { AnimatePresence, domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import {
  supportsViewTransitions,
  useTransitionDirection,
  type TransitionDirection,
} from "@/lib/router";

// iOS 语义（与 app.css 的 ::view-transition 曲线保持一致）：
//   进场 = 强减速（--ios-ease-nav）；退场 = 加速离开（--ios-ease-in）。
const EASE_IN = [0.42, 0, 1, 1] as const;
const EASE_OUT = [0, 0, 0.58, 1] as const;
const EASE_NAV = [0.32, 0.72, 0, 1] as const;
const NAV_SECONDS = 0.38;

function variantsFor(kind: "root" | "detail", direction: TransitionDirection) {
  if (kind === "root") {
    return {
      enter: { opacity: 0, transition: { duration: 0.2, ease: EASE_OUT } },
      center: { opacity: 1, transition: { duration: 0.2, ease: EASE_OUT } },
      exit: { opacity: 0, transition: { duration: 0.15, ease: EASE_IN } },
    };
  }
  if (direction === "back") {
    return {
      enter: { x: "-30%", opacity: 0.85, transition: { duration: NAV_SECONDS, ease: EASE_NAV } },
      center: { x: "0%", opacity: 1, transition: { duration: NAV_SECONDS, ease: EASE_NAV } },
      exit: { x: "100%", opacity: 1, transition: { duration: NAV_SECONDS, ease: EASE_IN } },
    };
  }
  if (direction === "fade") {
    return {
      enter: { opacity: 0, y: 8, transition: { duration: 0.2, ease: EASE_OUT } },
      center: { opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE_OUT } },
      exit: { opacity: 0, transition: { duration: 0.15, ease: EASE_IN } },
    };
  }
  return {
    enter: { x: "100%", opacity: 1, transition: { duration: NAV_SECONDS, ease: EASE_NAV } },
    center: { x: "0%", opacity: 1, transition: { duration: NAV_SECONDS, ease: EASE_NAV } },
    exit: { x: "-30%", opacity: 0.85, transition: { duration: NAV_SECONDS, ease: EASE_IN } },
  };
}

export function RouteTransition({
  routeKey,
  kind,
  className,
  testId,
  children,
}: {
  routeKey: string;
  kind: "root" | "detail";
  className?: string;
  /** 稳定测试锚点（QA/停留引擎按覆盖层子树加 hold）。 */
  testId?: string;
  children: ReactNode;
}) {
  const direction = useTransitionDirection();
  const reduced = useReducedMotion();
  const native = supportsViewTransitions();
  const variants = variantsFor(kind, direction);

  if (native || reduced) {
    return (
      <div data-testid={testId} className={cn("flex h-full min-h-0 flex-col", className)}>
        {children}
      </div>
    );
  }

  return (
    <LazyMotion features={domAnimation} strict>
      <AnimatePresence initial={false} mode={kind === "detail" ? "popLayout" : "sync"} custom={direction}>
        <m.div
          key={routeKey}
          data-testid={testId}
          custom={direction}
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
          className={cn("flex h-full min-h-0 flex-col will-change-transform", className)}
        >
          {children}
        </m.div>
      </AnimatePresence>
    </LazyMotion>
  );
}

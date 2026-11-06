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

const EASE = [0.22, 1, 0.36, 1] as const;

function variantsFor(kind: "root" | "detail", direction: TransitionDirection) {
  if (kind === "root") {
    return {
      enter: { opacity: 0 },
      center: { opacity: 1 },
      exit: { opacity: 0 },
    };
  }
  if (direction === "back") {
    return {
      enter: { x: "-22%", opacity: 0.9 },
      center: { x: "0%", opacity: 1 },
      exit: { x: "100%", opacity: 1 },
    };
  }
  if (direction === "fade") {
    return {
      enter: { opacity: 0, y: 8 },
      center: { opacity: 1, y: 0 },
      exit: { opacity: 0 },
    };
  }
  return {
    enter: { x: "100%", opacity: 1 },
    center: { x: "0%", opacity: 1 },
    exit: { x: "-18%", opacity: 0.92 },
  };
}

export function RouteTransition({
  routeKey,
  kind,
  className,
  children,
}: {
  routeKey: string;
  kind: "root" | "detail";
  className?: string;
  children: ReactNode;
}) {
  const direction = useTransitionDirection();
  const reduced = useReducedMotion();
  const native = supportsViewTransitions();
  const variants = variantsFor(kind, direction);

  if (native || reduced) {
    return <div className={cn("flex h-full min-h-0 flex-col", className)}>{children}</div>;
  }

  return (
    <LazyMotion features={domAnimation} strict>
      <AnimatePresence initial={false} mode={kind === "detail" ? "popLayout" : "sync"} custom={direction}>
        <m.div
          key={routeKey}
          custom={direction}
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.22, ease: EASE }}
          className={cn("flex h-full min-h-0 flex-col will-change-transform", className)}
        >
          {children}
        </m.div>
      </AnimatePresence>
    </LazyMotion>
  );
}

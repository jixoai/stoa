/**
 * 全屏媒体查看器（design report-app-grade §3.2 / spec report-app-ui）。
 *
 * - Pointer Events + `touch-action: none`（不让浏览器接管手势）：
 *   双指缩放、双击放大/还原、单指拖动平移（边界回弹）、左右滑动切换同帖多图、
 *   下滑关闭（跟手 + 阈值）、点击空白关闭；
 * - 桌面 `←/→/Esc`；顶部 `i/n`；底部缩略条；
 * - 视频用独立 `<video controls>`，不自动播放；
 * - 加载中骨架、失败重试；关闭只卸载覆盖层，不改变列表布局与滚动位置。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MediaRef } from "@core/types";
import { cn } from "cn";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ImageOffIcon,
  Loader2Icon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConnection } from "@/state/connection";
import { mediaFileName, mediaKind, useMediaUrl } from "@/lib/media";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const CLOSE_THRESHOLD = 120;
const SWIPE_THRESHOLD = 64;
const DOUBLE_TAP_MS = 320;

interface ViewState {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: ViewState = { scale: 1, x: 0, y: 0 };

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rubber(value: number, limit: number): number {
  if (value > limit) return limit + (value - limit) * 0.3;
  if (value < -limit) return -limit + (value + limit) * 0.3;
  return value;
}

/** 单张媒体的加载态：骨架 / 失败重试 / 图片 / 视频。 */
function ViewerMedia({ media, zoomed }: { media: MediaRef; zoomed: boolean }) {
  const [nonce, setNonce] = useState(0);
  return (
    <ViewerMediaBody
      key={nonce}
      media={media}
      zoomed={zoomed}
      onRetry={() => setNonce((value) => value + 1)}
    />
  );
}

function ViewerMediaBody({
  media,
  zoomed,
  onRetry,
}: {
  media: MediaRef;
  zoomed: boolean;
  onRetry: () => void;
}) {
  const { client } = useConnection();
  const state = useMediaUrl(client, media.hash);
  const kind = mediaKind(media.ext);

  if (state.loading) {
    return (
      <div className="relative flex h-[60vh] w-[80vw] max-w-3xl items-center justify-center">
        <Skeleton className="absolute inset-0 rounded-xl opacity-40" />
        <Loader2Icon className="size-6 animate-spin text-white/80" />
      </div>
    );
  }
  if (!state.url || state.error) {
    return (
      <div className="flex flex-col items-center gap-3 text-white/85">
        <ImageOffIcon className="size-8" />
        <p className="max-w-xs text-center text-sm">{state.error ?? "媒体不可用"}</p>
        <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
          <RotateCcwIcon data-icon="inline-start" />
          重试
        </Button>
      </div>
    );
  }
  if (kind === "video") {
    return (
      <video
        src={state.url}
        controls
        playsInline
        preload="metadata"
        aria-label={`视频 ${mediaFileName(media)}`}
        data-testid="viewer-video"
        className="max-h-[82vh] max-w-[92vw] rounded-lg bg-black object-contain"
      />
    );
  }
  return (
    <img
      src={state.url}
      alt={mediaFileName(media)}
      draggable={false}
      data-testid="viewer-image"
      className={cn(
        "max-h-[82vh] max-w-[92vw] select-none object-contain",
        zoomed && "cursor-grab",
      )}
    />
  );
}

function Thumb({ media, active, onClick }: { media: MediaRef; active: boolean; onClick: () => void }) {
  const { client } = useConnection();
  const state = useMediaUrl(client, media.hash);
  const kind = mediaKind(media.ext);
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={mediaFileName(media)}
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "relative size-12 shrink-0 overflow-hidden rounded-md border p-0",
        active ? "border-background" : "border-transparent opacity-60 hover:opacity-100",
      )}
    >
      {state.url && kind === "image" ? (
        <img src={state.url} alt="" className="size-full object-cover" draggable={false} />
      ) : state.url && kind === "video" ? (
        <video src={state.url} muted playsInline preload="metadata" className="size-full object-cover" />
      ) : (
        <Skeleton className="size-full rounded-none" />
      )}
    </Button>
  );
}

export interface ImageViewerProps {
  media: MediaRef[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export function ImageViewer({ media, index, onIndexChange, onClose }: ImageViewerProps) {
  const item = media[index] ?? media[0]!;
  const kind = mediaKind(item.ext);
  const [view, setView] = useState<ViewState>(IDENTITY);
  const [swipeX, setSwipeX] = useState(0);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const dragYRef = useRef(0);
  const swipeXRef = useRef(0);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({
    mode: "none" as "none" | "pan" | "pinch" | "drag",
    startX: 0,
    startY: 0,
    startTx: 0,
    startTy: 0,
    startScale: 1,
    startDist: 0,
    startMidX: 0,
    startMidY: 0,
    moved: false,
  });
  const tap = useRef<{ at: number; x: number; y: number } | null>(null);

  const closeNow = useCallback(() => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, 160);
  }, [closing, onClose]);

  // 切换图片时重置缩放/位移。
  useEffect(() => {
    setView(IDENTITY);
    setSwipeX(0);
    setDragY(0);
    dragYRef.current = 0;
    swipeXRef.current = 0;
    setDragging(false);
  }, [index]);

  // 键盘：←/→ 切换，Esc 关闭。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNow();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (index > 0) onIndexChange(index - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (index < media.length - 1) onIndexChange(index + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeNow, index, media.length, onIndexChange]);

  const bounds = useCallback(() => {
    const stage = stageRef.current;
    const img = stage?.querySelector<HTMLElement>("[data-testid='viewer-image']");
    if (!stage || !img) return { maxX: 0, maxY: 0 };
    const scale = viewRef.current.scale;
    return {
      maxX: Math.max(0, (img.clientWidth * scale - stage.clientWidth) / 2),
      maxY: Math.max(0, (img.clientHeight * scale - stage.clientHeight) / 2),
    };
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (kind === "video") return;
    const stage = stageRef.current;
    if (!stage || closing) return;
    // 新手势的主指针必然是新触摸序列：清掉上一轮可能残留的指针
    // （某些浏览器在 touchEnd 时只补发一个 pointerup）。
    if (event.isPrimary) pointers.current.clear();
    stage.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const g = gesture.current;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      g.mode = "pinch";
      g.startDist = Math.max(1, distance(a, b));
      g.startScale = viewRef.current.scale;
      g.startMidX = (a.x + b.x) / 2;
      g.startMidY = (a.y + b.y) / 2;
      g.startTx = viewRef.current.x;
      g.startTy = viewRef.current.y;
      g.moved = true;
    } else if (pointers.current.size === 1) {
      g.mode = viewRef.current.scale > 1 ? "pan" : "drag";
      g.startX = event.clientX;
      g.startY = event.clientY;
      g.startTx = viewRef.current.x;
      g.startTy = viewRef.current.y;
      g.moved = false;
      setDragging(true);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const g = gesture.current;

    if (g.mode === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const ratio = distance(a, b) / g.startDist;
      const scale = clamp(g.startScale * ratio, MIN_SCALE, MAX_SCALE);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const limit = bounds();
      setView({
        scale,
        x: rubber(g.startTx + (midX - g.startMidX), limit.maxX),
        y: rubber(g.startTy + (midY - g.startMidY), limit.maxY),
      });
      return;
    }

    if (g.mode === "pan") {
      const dx = event.clientX - g.startX;
      const dy = event.clientY - g.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) g.moved = true;
      const limit = bounds();
      setView({
        scale: viewRef.current.scale,
        x: rubber(g.startTx + dx, limit.maxX),
        y: rubber(g.startTy + dy, limit.maxY),
      });
      return;
    }

    if (g.mode === "drag") {
      const dx = event.clientX - g.startX;
      const dy = event.clientY - g.startY;
      if (!g.moved && Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      g.moved = true;
      if (Math.abs(dx) > Math.abs(dy)) {
        const atStart = index === 0 && dx > 0;
        const atEnd = index === media.length - 1 && dx < 0;
        const next = atStart || atEnd ? dx * 0.25 : dx;
        swipeXRef.current = next;
        dragYRef.current = 0;
        setSwipeX(next);
        setDragY(0);
      } else if (dy > 0) {
        dragYRef.current = dy;
        swipeXRef.current = 0;
        setDragY(dy);
        setSwipeX(0);
      } else {
        dragYRef.current = dy * 0.2;
        swipeXRef.current = 0;
        setDragY(dy * 0.2);
        setSwipeX(0);
      }
    }
  };

  const registerTap = (event: React.PointerEvent<HTMLDivElement>) => {
    const now = performance.now();
    const previous = tap.current;
    tap.current = { at: now, x: event.clientX, y: event.clientY };
    if (
      previous &&
      now - previous.at < DOUBLE_TAP_MS &&
      distance(previous, { x: event.clientX, y: event.clientY }) < 30
    ) {
      tap.current = null;
      toggleZoom(event.clientX, event.clientY);
    }
  };

  const finishGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    pointers.current.delete(event.pointerId);
    setDragging(false);

    if (g.mode === "pinch") {
      if (pointers.current.size === 1) {
        const [remaining] = [...pointers.current.values()] as [{ x: number; y: number }];
        g.mode = viewRef.current.scale > 1 ? "pan" : "drag";
        g.startX = remaining.x;
        g.startY = remaining.y;
        g.startTx = viewRef.current.x;
        g.startTy = viewRef.current.y;
        g.moved = true;
        return;
      }
      // 缩回 1x 时把位移归零
      if (viewRef.current.scale <= 1.02) setView(IDENTITY);
      g.mode = "none";
      return;
    }

    if (g.mode === "pan") {
      const { maxX, maxY } = bounds();
      setView({
        scale: viewRef.current.scale,
        x: clamp(viewRef.current.x, -maxX, maxX),
        y: clamp(viewRef.current.y, -maxY, maxY),
      });
      if (!g.moved) registerTap(event);
      g.mode = "none";
      return;
    }

    if (g.mode === "drag") {
      if (dragYRef.current > CLOSE_THRESHOLD) {
        closeNow();
        return;
      }
      if (Math.abs(swipeXRef.current) > SWIPE_THRESHOLD) {
        if (swipeXRef.current < 0 && index < media.length - 1) onIndexChange(index + 1);
        else if (swipeXRef.current > 0 && index > 0) onIndexChange(index - 1);
      }
      swipeXRef.current = 0;
      dragYRef.current = 0;
      setSwipeX(0);
      setDragY(0);
      g.mode = "none";

      if (!g.moved) registerTap(event);
    }
  };

  const toggleZoom = (clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const current = viewRef.current;
    if (current.scale > 1.05) {
      setView(IDENTITY);
      return;
    }
    const rect = stage.getBoundingClientRect();
    const nextScale = 2.5;
    setView({
      scale: nextScale,
      x: (clientX - rect.left - rect.width / 2) * (1 - nextScale),
      y: (clientY - rect.top - rect.height / 2) * (1 - nextScale),
    });
  };

  const backdropOpacity = Math.max(0.35, 1 - dragY / 480);
  const chromeOpacity = Math.max(0, 1 - dragY / 260);
  const zoomed = view.scale > 1.05;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="媒体查看器"
      data-testid="image-viewer"
      className={cn(
        "fixed inset-0 z-[100] select-none transition-opacity duration-150",
        closing && "opacity-0",
      )}
      style={{ touchAction: "none" }}
    >
      <div
        className="media-backdrop absolute inset-0"
        style={{ opacity: backdropOpacity }}
        onClick={closeNow}
      />

      <div
        ref={stageRef}
        data-testid="viewer-stage"
        className="absolute inset-0 flex items-center justify-center overflow-hidden"
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onTouchEnd={(event) => {
          if (event.touches.length === 0) {
            pointers.current.clear();
            gesture.current.mode = "none";
            setDragging(false);
            setSwipeX(0);
            setDragY(0);
            swipeXRef.current = 0;
            dragYRef.current = 0;
          }
        }}
        onClick={(event) => {
          if (event.target === stageRef.current && !zoomed) closeNow();
        }}
      >
        <div
          data-testid="viewer-transform"
          className="relative flex items-center justify-center"
          style={{
            transform: `translate3d(${view.x + swipeX}px, ${view.y + dragY}px, 0) scale(${view.scale})`,
            transition: dragging ? "none" : "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          <ViewerMedia key={item.hash} media={item} zoomed={zoomed} />
        </div>
      </div>

      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between gap-2 bg-gradient-to-b from-black/45 to-transparent px-2 pb-8 pt-2"
        style={{ opacity: chromeOpacity }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="关闭"
          data-testid="viewer-close"
          className="pointer-events-auto size-11 text-white hover:bg-white/15 hover:text-white"
          onClick={closeNow}
        >
          <XIcon />
        </Button>
        <span className="rounded-full bg-black/35 px-2.5 py-1 text-xs tabular-nums text-white">
          {index + 1}/{media.length}
        </span>
        <span className="size-11" aria-hidden />
      </div>

      {media.length > 1 ? (
        <div
          className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-center gap-2 bg-gradient-to-t from-black/45 to-transparent px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-8"
          style={{ opacity: chromeOpacity }}
        >
          {index > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="上一张"
              className="size-11 shrink-0 text-white hover:bg-white/15 hover:text-white"
              onClick={() => onIndexChange(index - 1)}
            >
              <ChevronLeftIcon />
            </Button>
          ) : null}
          <div className="flex max-w-full gap-1.5 overflow-x-auto">
            {media.map((ref, thumbIndex) => (
              <Thumb
                key={`${ref.hash}-${thumbIndex}`}
                media={ref}
                active={thumbIndex === index}
                onClick={() => onIndexChange(thumbIndex)}
              />
            ))}
          </div>
          {index < media.length - 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="下一张"
              className="size-11 shrink-0 text-white hover:bg-white/15 hover:text-white"
              onClick={() => onIndexChange(index + 1)}
            >
              <ChevronRightIcon />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

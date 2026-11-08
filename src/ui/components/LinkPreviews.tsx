/**
 * 帖子预览区（report-link-preview P1-17/18）：官方 Carousel 承载 0..3 张卡。
 *
 * - 一页一张、平权、顺序＝正文出现顺序；单条退化为单卡（无箭头/指示点）；
 * - 触摸拖拽 / 桌面 hover 箭头 / 底部指示点 / ←→ 键盘（官方件自带）；
 * - `post.updated` 更新只改对应 slide；数组变化时按 canonicalUrl 找回当前页，
 *   不因标题/封面的阶段更新重置到第 1 页；
 * - 静态归档：ready/partial 进轮播，pending/failed 退化为可点普通链接。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PostView } from "@core/types";
import type { PreviewLink } from "@core/plugins/types";
import { useConnection } from "@/state/connection";
import { useLinkPreviewEnabled } from "@/state/plugins";
import { usePostPreviews } from "@/state/post-previews";
import { capPreviews, resolveCarouselIndex } from "@/lib/link-preview";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LinkPreviewCard } from "@/components/LinkPreviewCard";

function domainOf(preview: PreviewLink): string {
  try {
    return new URL(preview.final_url ?? preview.url).hostname;
  } catch {
    return preview.url;
  }
}

/** 静态归档的 pending/failed：没有 worker 会再推进，退化为普通链接（官方 Card 底座）。 */
function StaticPlainLink({ preview }: { preview: PreviewLink }) {
  return (
    <Card size="sm" data-testid="link-preview-plain-card" className="gap-0 overflow-hidden !p-0">
      <a
        href={preview.final_url ?? preview.url}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="link-preview-plain-link"
        data-preview-status={preview.status}
        className="flex min-h-10 items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="min-w-0 truncate font-medium text-foreground">{domainOf(preview)}</span>
        <span className="shrink-0">
          ·{" "}
          {preview.status === "failed"
            ? "预览不可用"
            : preview.title || preview.label || "打开链接"}
        </span>
      </a>
    </Card>
  );
}

export function LinkPreviews({ post }: { post: Pick<PostView, "id" | "previews"> }) {
  const previews = usePostPreviews(post);
  const pluginEnabled = useLinkPreviewEnabled();
  const { staticMode } = useConnection();
  const reduced = useReducedMotion();
  const [api, setApi] = useState<CarouselApi | null>(null);
  const [selected, setSelected] = useState(0);
  /** 当前页的 canonicalUrl：数组更新时用它找回同一张卡。 */
  const selectedUrl = useRef<string | null>(null);
  const cardsRef = useRef<PreviewLink[]>([]);

  const visible = useMemo(() => capPreviews(previews), [previews]);
  const cards = useMemo(
    () =>
      staticMode
        ? visible.filter(
            (preview) => preview.status === "ready" || preview.status === "partial",
          )
        : visible,
    [visible, staticMode],
  );
  const plain = useMemo(
    () =>
      staticMode
        ? visible.filter(
            (preview) => preview.status === "pending" || preview.status === "failed",
          )
        : [],
    [visible, staticMode],
  );
  cardsRef.current = cards;

  useEffect(() => {
    if (!api) return;
    const sync = () => {
      const index = api.selectedScrollSnap();
      setSelected(index);
      const url = cardsRef.current[index]?.url ?? null;
      if (url) selectedUrl.current = url;
    };
    sync();
    api.on("select", sync);
    api.on("reInit", sync);
    return () => {
      api.off("select", sync);
      api.off("reInit", sync);
    };
  }, [api]);

  // 事件更新后按 URL 保持当前页；URL 被移除时钳到最近合法页（瞬跳，不播动画）。
  useEffect(() => {
    if (!api || cards.length === 0) return;
    const current = api.selectedScrollSnap();
    const target = resolveCarouselIndex(cards, selectedUrl.current, current);
    if (target !== current) api.scrollTo(target, true);
  }, [api, cards]);

  // 数组缩短时同步指示点状态；卡片消失则清空 URL 身份。
  useEffect(() => {
    if (cards.length === 0) {
      selectedUrl.current = null;
      setSelected(0);
      return;
    }
    if (selected > cards.length - 1) {
      const clamped = cards.length - 1;
      selectedUrl.current = cards[clamped]?.url ?? null;
      setSelected(clamped);
    }
  }, [cards, selected]);

  if (!pluginEnabled) return null;
  if (cards.length === 0 && plain.length === 0) return null;

  return (
    <div
      data-testid="link-previews"
      data-preview-count={cards.length + plain.length}
      data-active-index={selected}
      className="mt-2 flex flex-col gap-2"
    >
      {cards.length === 1 ? (
        <LinkPreviewCard preview={cards[0]!} />
      ) : cards.length > 1 ? (
        <Carousel
          className="group/carousel"
          opts={{ align: "start", loop: false, duration: reduced ? 0 : 18 }}
          setApi={setApi}
          aria-label="链接预览"
        >
          <CarouselContent>
            {cards.map((preview, index) => (
              <CarouselItem key={preview.url} data-preview-index={index}>
                <LinkPreviewCard preview={preview} />
              </CarouselItem>
            ))}
          </CarouselContent>
          <CarouselPrevious
            data-testid="previews-prev"
            aria-label="上一张"
            className="left-2 z-10 hidden opacity-0 transition-opacity pointer-events-none group-hover/carousel:pointer-events-auto group-hover/carousel:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 sm:inline-flex"
          />
          <CarouselNext
            data-testid="previews-next"
            aria-label="下一张"
            className="right-2 z-10 hidden opacity-0 transition-opacity pointer-events-none group-hover/carousel:pointer-events-auto group-hover/carousel:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 sm:inline-flex"
          />
          <div className="mt-1.5 flex items-center justify-center gap-1">
            {cards.map((preview, index) => (
              <Button
                key={preview.url}
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="previews-dot"
                data-index={index}
                aria-label={`第 ${index + 1} 页预览`}
                aria-current={index === selected ? "true" : undefined}
                className="size-11 rounded-full p-0 hover:bg-transparent dark:hover:bg-transparent"
                onClick={(event) => {
                  event.stopPropagation();
                  api?.scrollTo(index);
                }}
              >
                <span
                  className={
                    index === selected
                      ? "size-1.5 rounded-full bg-foreground"
                      : "size-1.5 rounded-full bg-foreground/25"
                  }
                />
              </Button>
            ))}
          </div>
        </Carousel>
      ) : null}
      {plain.map((preview) => (
        <StaticPlainLink key={`plain-${preview.url}`} preview={preview} />
      ))}
    </div>
  );
}

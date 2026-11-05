import { useState } from "react";
import { cn } from "cn";
import type { MediaRef } from "@core/types";
import { ImageOffIcon, Maximize2Icon } from "lucide-react";
import { useConnection } from "@/state/connection";
import { useMediaUrl } from "@/lib/media";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

function MediaTile({
  media,
  className,
  onOpen,
  testId,
}: {
  media: MediaRef;
  className?: string;
  onOpen: () => void;
  testId: string;
}) {
  const { client } = useConnection();
  const state = useMediaUrl(client, media.hash);
  if (state.loading)
    return <Skeleton data-testid={testId} className={cn("h-full w-full rounded-none", className)} />;
  if (!state.url) {
    return (
      <span
        data-testid={testId}
        className={cn(
          "flex h-full min-h-24 w-full items-center justify-center bg-muted text-muted-foreground",
          className,
        )}
      >
        <ImageOffIcon className="size-5" />
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onOpen}
      className={cn(
        "group relative block h-full w-full overflow-hidden bg-muted focus-visible:outline-none",
        className,
      )}
      aria-label="查看图片"
    >
      <img
        src={state.url}
        alt={media.hash.slice(0, 8)}
        loading="lazy"
        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.01]"
      />
      <span className="absolute inset-0 hidden items-center justify-center bg-foreground/30 text-background group-hover:flex">
        <Maximize2Icon className="size-5" />
      </span>
    </button>
  );
}

/**
 * 媒体网格：1 图按原比例（高 ≤510）；2 图两列；3 图左大右二；4 图 2×2。
 * 统一 2px 间距、16px 圆角、object-fit: cover；点击开 lightbox（design §12.5）。
 */
export function MediaGrid({ media, className }: { media: MediaRef[]; className?: string }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const items = media.slice(0, 4);
  if (items.length === 0) return null;
  const count = items.length;
  const gridClass =
    count === 1
      ? "grid-cols-1"
      : count === 3
        ? "grid-cols-2 grid-rows-2"
        : "grid-cols-2";
  const tileAspect = count === 1 ? "" : "aspect-square";

  return (
    <>
      <div
        data-testid="media-grid"
        data-count={count}
        className={cn("mt-2 grid gap-0.5 overflow-hidden rounded-2xl", gridClass, className)}
      >
        {items.map((item, index) => (
          <MediaTile
            key={item.hash}
            media={item}
            testId={`media-tile-${index}`}
            onOpen={() => setOpenIndex(index)}
            className={cn(
              tileAspect,
              count === 3 && index === 0 && "row-span-2 aspect-auto h-full",
              count === 1 && "max-h-[510px]",
            )}
          />
        ))}
      </div>

      <Dialog open={openIndex !== null} onOpenChange={(open) => !open && setOpenIndex(null)}>
        <DialogContent
          showCloseButton
          className="max-w-[calc(100%-1rem)] gap-0 p-2 sm:max-w-5xl"
        >
          <DialogTitle className="sr-only">图片预览</DialogTitle>
          {openIndex !== null && items[openIndex] ? (
            <LightboxImage media={items[openIndex]!} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function LightboxImage({ media }: { media: MediaRef }) {
  const { client } = useConnection();
  const state = useMediaUrl(client, media.hash);
  if (state.loading) return <Skeleton className="h-[60vh] w-full rounded-lg" />;
  if (!state.url) {
    return (
      <span className="flex h-64 items-center justify-center text-muted-foreground">
        <ImageOffIcon className="mr-2 size-5" /> 图片不可用
      </span>
    );
  }
  return (
    <img
      src={state.url}
      alt={media.hash.slice(0, 8)}
      className="max-h-[85vh] w-full rounded-lg object-contain"
    />
  );
}

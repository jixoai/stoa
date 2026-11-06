import { useState } from "react";
import { cn } from "cn";
import type { MediaRef } from "@core/types";
import { DownloadIcon, FileTextIcon, ImageOffIcon, Maximize2Icon } from "lucide-react";
import { useConnection } from "@/state/connection";
import { mediaFileName, mediaKind, useMediaUrl } from "@/lib/media";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ImageViewer } from "@/components/ImageViewer";

/** 不可预览附件的下载占位：文件名 + 大小 + 下载按钮（design §12.5）。 */
function MediaDownload({
  media,
  url,
  testId,
  className,
}: {
  media: MediaRef;
  url: string;
  testId?: string;
  className?: string;
}) {
  const name = mediaFileName(media);
  return (
    <div
      data-testid={testId}
      data-media-kind="file"
      className={cn(
        "flex min-h-24 flex-col items-start justify-center gap-1 overflow-hidden bg-muted p-3 text-muted-foreground",
        className,
      )}
    >
      <FileTextIcon className="size-5" />
      <span className="max-w-full truncate text-xs font-medium text-foreground">{name}</span>
      <span className="text-[11px]">{formatBytes(media.bytes)}</span>
      <Button
        type="button"
        variant="outline"
        size="xs"
        nativeButton={false}
        render={<a href={url} download={name} />}
        className="mt-1"
      >
        <DownloadIcon data-icon="inline-start" />
        下载
      </Button>
    </div>
  );
}

function MediaTile({
  media,
  fill,
  className,
  onOpen,
  testId,
}: {
  media: MediaRef;
  /** 网格铺满模式：图片/视频绝对定位裁切（2~4 图等高格子） */
  fill: boolean;
  className?: string;
  onOpen: () => void;
  testId: string;
}) {
  const { client } = useConnection();
  const state = useMediaUrl(client, media.hash);
  const kind = mediaKind(media.ext);
  if (state.loading)
    return <Skeleton data-testid={testId} className={cn("h-full min-h-24 w-full rounded-none", className)} />;
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
  if (kind === "video") {
    return (
      <div
        data-testid={testId}
        data-media-kind="video"
        className={cn("relative overflow-hidden bg-black", className)}
      >
        <video
          src={state.url}
          controls
          playsInline
          preload="metadata"
          aria-label={`视频 ${mediaFileName(media)}`}
          data-testid={`${testId}-video`}
          className={cn(
            "bg-black",
            fill ? "absolute inset-0 h-full w-full object-cover" : "max-h-[510px] w-full",
          )}
        />
        <Button
          type="button"
          variant="secondary"
          size="icon-xs"
          aria-label="查看视频"
          onClick={onOpen}
          className="absolute right-2 top-2 opacity-90"
        >
          <Maximize2Icon />
        </Button>
      </div>
    );
  }
  if (kind === "file") {
    return (
      <MediaDownload
        media={media}
        url={state.url}
        testId={testId}
        className={cn(fill && "h-full", className)}
      />
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      data-testid={testId}
      data-media-kind="image"
      onClick={onOpen}
      aria-label="查看图片"
      className={cn(
        "group relative block h-auto w-full overflow-hidden rounded-none border-0 bg-muted p-0 focus-visible:outline-none",
        className,
      )}
    >
      <img
        src={state.url}
        alt={media.hash.slice(0, 8)}
        loading="lazy"
        className={cn(
          "w-full object-cover transition-transform duration-200 group-hover:scale-[1.01]",
          fill ? "absolute inset-0 h-full" : "max-h-[510px]",
        )}
      />
      <span className="absolute inset-0 hidden items-center justify-center bg-foreground/30 text-background group-hover:flex">
        <Maximize2Icon className="size-5" />
      </span>
    </Button>
  );
}

/**
 * 媒体网格：1 图按原比例（高 ≤510）；2 图两列；3 图左大右二；4 图 2×2。
 * 统一 2px 间距、16px 圆角；图片 object-fit: cover 收敛进等高格子，视频用
 * `<video controls>` 播放，未知类型给下载占位；点击图片开 lightbox（design §12.5）。
 */
export function MediaGrid({ media, className }: { media: MediaRef[]; className?: string }) {
  const [viewer, setViewer] = useState<{ list: MediaRef[]; index: number } | null>(null);
  const items = media.slice(0, 4);
  if (items.length === 0) return null;
  const count = items.length;
  const gridClass =
    count === 1
      ? "grid-cols-1"
      : count === 3
        ? "grid-cols-2 grid-rows-2"
        : "grid-cols-2";
  const fill = count > 1;

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
            fill={fill}
            testId={`media-tile-${index}`}
            onOpen={() => {
              const list = items.filter((ref) => mediaKind(ref.ext) !== "file");
              const target = list.findIndex((ref) => ref.hash === item.hash);
              setViewer({ list, index: target >= 0 ? target : 0 });
            }}
            className={cn(
              fill && "aspect-square",
              count === 3 && index === 0 && "row-span-2 aspect-auto",
              count === 1 && "max-h-[510px]",
            )}
          />
        ))}
      </div>

      {viewer && viewer.list.length > 0 ? (
        <ImageViewer
          media={viewer.list}
          index={viewer.index}
          onIndexChange={(index) => setViewer((current) => (current ? { ...current, index } : current))}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </>
  );
}

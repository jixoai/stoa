/**
 * 单张链接预览卡（report-link-preview P1-17，官方 Card 收编件底座）。
 *
 * 状态融合与防 CLS：媒体区恒为 4:3；标题/描述/操作行都预留固定高度，
 * pending 用同尺寸 Skeleton 占位，partial/ready 只替换内容，高度差 ≤2px。
 * 类型图标底纹始终铺在媒体区底层：封面缺失/加载中/失败时自然回退，不再出现空白块。
 *
 * failed 混合策略：冷启动即 failed 用 40px 紧凑行（design §10.2）；同一挂载实例
 * 若先经历 pending/partial 再 failed，则保留整卡槽位（4:3 + 文本区），紧凑链接叠在
 * 槽内底部，避免运行期一次显著 CLS。
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";
import type { PreviewLink } from "@core/plugins/types";
import {
  AudioLinesIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  LinkIcon,
  VideoIcon,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useConnection } from "@/state/connection";
import { useMediaUrl } from "@/lib/media";
import { useReducedMotion } from "@/lib/use-reduced-motion";

const KIND_ICON = {
  page: GlobeIcon,
  image: ImageIcon,
  video: VideoIcon,
  audio: AudioLinesIcon,
  document: FileTextIcon,
  unknown: LinkIcon,
} as const;

const ERROR_TEXT: Record<string, string> = {
  timeout: "预览超时",
  blocked_size: "内容过大",
  http_error: "站点返回错误",
  blocked_scheme: "出于安全原因已跳过预览",
  blocked_private: "出于安全原因已跳过预览",
  blocked_port: "出于安全原因已跳过预览",
  too_many_redirects: "站点返回错误",
  unsupported: "预览暂不可用",
  network: "预览暂不可用",
  parse_error: "预览暂不可用",
  crop_failed: "预览暂不可用",
};

function domainOf(preview: PreviewLink): string {
  try {
    return new URL(preview.final_url ?? preview.url).hostname;
  } catch {
    return preview.url;
  }
}

/**
 * 外链封面只在 https（或 http 本地开发壳）下加载；https 壳不放行混合内容。
 * 静态归档不加载外链封面（离线不依赖外网，design §12）。
 */
function canLoadExternalCover(url: string): boolean {
  if (/^https:\/\//i.test(url)) return true;
  if (typeof window === "undefined" || window.location.protocol !== "http:") return false;
  return /^http:\/\//i.test(url);
}

/** 本地 `/api/media/<hash>` 封面走授权 blob；静态走归档相对路径。 */
function CoverImage({ preview }: { preview: PreviewLink }) {
  const { client, staticMode } = useConnection();
  const cover = preview.cover;
  const localHash = useMemo(() => {
    const match = /^\/api\/media\/([a-fA-F0-9]{64})$/.exec(cover?.url ?? "");
    return match?.[1] ?? null;
  }, [cover?.url]);
  const media = useMediaUrl(client, localHash);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [cover?.url]);
  if (!cover || cover.kind === "favicon" || broken) return null;
  if (localHash) {
    // 加载中/失败都返回 null，让底层类型图标底纹露出；不额外制造骨架抖动。
    if (media.loading || !media.url) return null;
    return (
      <img
        src={media.url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="absolute inset-0 size-full object-cover"
        data-testid="preview-media"
      />
    );
  }
  if (staticMode || !canLoadExternalCover(cover.url)) return null;
  return (
    <img
      src={cover.url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="absolute inset-0 size-full object-cover"
      data-testid="preview-media"
    />
  );
}

function KindWash({ preview }: { preview: PreviewLink }) {
  const Icon = KIND_ICON[preview.kind] ?? LinkIcon;
  return (
    <div
      data-testid="link-preview-icon-wash"
      className="flex size-full items-center justify-center bg-[linear-gradient(135deg,var(--muted),var(--accent))]"
    >
      <Icon className="size-10 text-muted-foreground/60" aria-hidden />
    </div>
  );
}

/** failed 的紧凑链接行：冷启动卡片与保留槽位的叠层共用。 */
function FailedLink({
  preview,
  className,
  testId = "link-preview-failed",
}: {
  preview: PreviewLink;
  className?: string;
  testId?: string;
}) {
  const domain = domainOf(preview);
  const Icon = KIND_ICON[preview.kind] ?? LinkIcon;
  const href = preview.final_url ?? preview.url;
  const errorText = ERROR_TEXT[preview.error_code ?? ""] ?? "预览暂不可用";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      className={cn(
        "flex min-h-10 items-center gap-2 px-3 py-2 text-xs text-muted-foreground",
        className,
      )}
      onClick={(event) => event.stopPropagation()}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 truncate font-medium text-foreground">{domain}</span>
      <span className="shrink-0">· {errorText}</span>
      <ExternalLinkIcon className="ml-auto size-3.5 shrink-0" aria-hidden />
    </a>
  );
}

/**
 * 槽位保留态：同一实例从 pending/partial 变成 failed 后继续占住整卡高度
 * （4:3 媒体区 + 文本区 + 底部行），紧凑链接叠在文本区中部。
 * 占位块与正常卡完全同构，只用于高度，不参与读屏。
 */
function ReservedFailedCard({ preview, className }: { preview: PreviewLink; className?: string }) {
  return (
    <Card
      size="sm"
      data-testid="link-preview-card"
      data-preview-status="failed"
      data-preview-phase={preview.phase}
      data-preview-url={preview.url}
      data-preview-error={preview.error_code ?? undefined}
      data-preview-reserved="true"
      className={cn("relative gap-0 overflow-hidden !p-0", className)}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
        <KindWash preview={preview} />
      </div>
      <div className="relative px-3 pt-2.5">
        <div aria-hidden="true">
          <div className="h-4" />
          <div className="mt-1 min-h-10" />
          <div className="mt-1 min-h-10" />
        </div>
        <FailedLink
          preview={preview}
          testId="link-preview-failed-reserved"
          className="absolute inset-x-3 top-1/2 -translate-y-1/2 rounded-lg hover:bg-muted/40"
        />
      </div>
      <div className="h-6" aria-hidden="true" />
    </Card>
  );
}

function LinkPreviewCardImpl({
  preview,
  className,
}: {
  preview: PreviewLink;
  className?: string;
}) {
  // DEV 渲染计数（N7 探针；生产构建被 Vite 常量折叠移除）。
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const target = window as Window & { __linkPreviewRenderCounts?: Record<string, number> };
    target.__linkPreviewRenderCounts ??= {};
    target.__linkPreviewRenderCounts[preview.url] =
      (target.__linkPreviewRenderCounts[preview.url] ?? 0) + 1;
  }
  const reduced = useReducedMotion();
  const domain = domainOf(preview);
  const Icon = KIND_ICON[preview.kind] ?? LinkIcon;
  const href = preview.final_url ?? preview.url;
  const failed = preview.status === "failed";
  const pending = preview.status === "pending";
  const title = preview.title || preview.label || domain;
  /** 一旦在本次挂载里占过整卡槽位，后续 failed 不再塌成紧凑行（防运行期 CLS）。 */
  const hadReservedSlot = useRef(false);
  useEffect(() => {
    if (preview.status !== "failed") {
      hadReservedSlot.current = true;
    }
  }, [preview.status]);

  if (failed) {
    if (hadReservedSlot.current) {
      return <ReservedFailedCard preview={preview} className={className} />;
    }
    return (
      <Card
        size="sm"
        data-testid="link-preview-card"
        data-preview-status={preview.status}
        data-preview-phase={preview.phase}
        data-preview-url={preview.url}
        data-preview-error={preview.error_code ?? undefined}
        className={cn("gap-0 overflow-hidden !p-0", className)}
      >
        <FailedLink preview={preview} className="hover:bg-muted/40" />
      </Card>
    );
  }

  return (
    <Card
      size="sm"
      data-testid="link-preview-card"
      data-preview-status={preview.status}
      data-preview-phase={preview.phase}
      data-preview-url={preview.url}
      aria-busy={pending || undefined}
      className={cn("gap-0 overflow-hidden !p-0", className)}
    >
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="link-preview-open"
        className="block outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={(event) => event.stopPropagation()}
      >
        {/* key=status 只作用于非交互内容层：主 <a> 不重挂，焦点不丢；
            阶段推进（pending→partial→ready）时重放 160ms 淡入。 */}
        <div
          key={preview.status}
          className={cn(
            !reduced && "animate-in fade-in-0 duration-[160ms] motion-reduce:animate-none",
          )}
        >
          <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
            <KindWash preview={preview} />
            {pending ? (
              <Skeleton className="absolute inset-0 rounded-none motion-reduce:animate-none" />
            ) : (
              <CoverImage preview={preview} />
            )}
          </div>
          <div className="px-3 pt-2.5">
            <div className="flex h-4 items-center gap-1.5 text-[11px] text-muted-foreground">
              <Icon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{domain}</span>
            </div>
            <div className="mt-1 line-clamp-2 min-h-10 text-sm font-medium leading-5">
              {pending ? (
                <Skeleton className="h-3.5 w-3/4 motion-reduce:animate-none" />
              ) : (
                title
              )}
            </div>
            <div className="mt-1 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">
              {pending ? (
                <span className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-full motion-reduce:animate-none" />
                  <Skeleton className="h-3 w-2/3 motion-reduce:animate-none" />
                </span>
              ) : (
                preview.description || ""
              )}
            </div>
          </div>
        </div>
      </a>
      <div className="flex h-6 items-center justify-end px-3 pb-2 text-[11px]">
        {pending ? null : (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="link-preview-source"
            className="text-link underline-offset-2 hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            原文 ↗
          </a>
        )}
      </div>
    </Card>
  );
}

/** preview 引用稳定时跳过重渲染：事件风暴只更新变化的那张卡（N7）。 */
export const LinkPreviewCard = memo(LinkPreviewCardImpl);

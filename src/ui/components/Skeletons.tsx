/**
 * 骨架屏：**逐像素对齐 PostCard 的排版度量**（px-4、46px 头像、正文列 x=68、行高、操作栏 44px）。
 *
 * 目的（design report-app-grade §3.2）：骨架与真实卡片占位接近时，数据回来后的
 * 高度变化最小；配合 ContentSwap 的交叉淡入，路由完成后不再出现布局跳动。
 */
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "cn";

function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div className="mt-1.5 flex flex-col gap-[5px]">
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          className={cn(
            "h-[13px]",
            index === lines - 1 ? "w-3/5" : index === 0 ? "w-full" : "w-11/12",
          )}
        />
      ))}
    </div>
  );
}

/** 单条帖子骨架（feed / focal 两种密度；compact 用于回复区预占）。 */
export function PostSkeleton({
  variant = "feed",
  withMedia = false,
  compact = false,
}: {
  variant?: "feed" | "focal";
  withMedia?: boolean;
  compact?: boolean;
}) {
  if (compact) {
    // 与 PostCard 自接链紧凑行同度量：46px 头像槽内同轴居中（中心 39，正文列 68）。
    return (
      <div
        className="relative flex items-start px-4 py-1.5"
        style={{ gap: 6 }}
        data-testid="post-skeleton"
        aria-hidden
      >
        <div
          className="flex w-[46px] shrink-0 items-start justify-center"
          data-testid="skeleton-avatar-slot"
        >
          <Skeleton className="size-6 rounded-full" data-testid="skeleton-avatar" />
        </div>
        <div className="min-w-0 flex-1">
          <Skeleton className="h-[13px] w-20" />
          <div className="mt-1.5 flex flex-col gap-1.5">
            <Skeleton className="h-[13px] w-full" />
            <Skeleton className="h-[13px] w-2/3" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className="px-4 pb-1.5"
      style={{ paddingTop: variant === "focal" ? 22 : 12 }}
      data-testid="post-skeleton"
      aria-hidden
    >
      <div className="flex" style={{ gap: 6 }}>
        <Skeleton className="size-[46px] shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Skeleton className="h-[13px] w-24" />
            <Skeleton className="h-[13px] w-14" />
            <Skeleton className="h-[13px] w-10" />
          </div>
          {variant === "focal" ? (
            <>
              <SkeletonLines lines={4} />
              <Skeleton className="mt-3 h-40 w-full rounded-xl" />
            </>
          ) : (
            <SkeletonLines lines={withMedia ? 2 : 3} />
          )}
          {withMedia ? <Skeleton className="mt-2 h-32 w-full rounded-xl" /> : null}
          <div className="-mt-1.5 flex w-full items-center justify-between pt-1.5">
            <Skeleton className="h-11 w-16 rounded-lg" />
            <Skeleton className="h-11 w-14 rounded-lg" />
            <Skeleton className="h-11 w-14 rounded-lg" />
            <Skeleton className="h-11 w-20 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** 时间线首屏骨架：与 PostCard 列表同样的分隔线节奏。 */
export function PostListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="divide-y divide-border/60" data-testid="post-list-skeleton" aria-hidden>
      {Array.from({ length: count }).map((_, index) => (
        <PostSkeleton key={index} withMedia={index === 0} />
      ))}
    </div>
  );
}

/** 线程页骨架：与 timeline 行同度量（全宽 divide-y、46px 头像列、正文列 x=68）。 */
export function ThreadSkeleton() {
  return (
    <div data-testid="thread-skeleton" aria-hidden>
      <div className="divide-y divide-border/60">
        <PostSkeleton variant="focal" />
        <PostSkeleton />
        <PostSkeleton compact />
      </div>
    </div>
  );
}

/** 成员资料卡骨架（身份行 + 简介 + 计数），与 ProfilePage 的资料卡同度量。 */
export function ProfileCardSkeleton() {
  return (
    <section className="border-b border-border/60 px-4 pb-4 pt-3" data-testid="profile-skeleton" aria-hidden>
      <div className="flex items-start gap-3">
        <Skeleton className="size-16 shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-full" />
          <div className="flex gap-3 pt-1">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      </div>
    </section>
  );
}

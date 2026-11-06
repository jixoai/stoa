/**
 * 骨架屏：**逐像素对齐 PostCard 的排版度量**（px-4 py-3、42px 头像、行高、操作栏 44px）。
 *
 * 目的（design report-app-grade §3.2）：骨架与真实卡片占位接近时，数据回来后的
 * 高度变化最小；配合 ContentSwap 的交叉淡入，路由完成后不再出现布局跳动。
 */
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "cn";

function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          className={cn("h-4", index === lines - 1 ? "w-3/5" : index === 0 ? "w-full" : "w-11/12")}
        />
      ))}
    </div>
  );
}

/** 单条帖子骨架（feed / focal 两种密度）。 */
export function PostSkeleton({
  variant = "feed",
  withMedia = false,
}: {
  variant?: "feed" | "focal";
  withMedia?: boolean;
}) {
  return (
    <div className="px-4 py-3" data-testid="post-skeleton" aria-hidden>
      <div className="flex gap-3">
        <Skeleton className="size-[42px] shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-10" />
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
          <div className="mt-2 flex items-center gap-2">
            <Skeleton className="h-9 w-20 rounded-lg" />
            <Skeleton className="h-9 w-16 rounded-lg" />
            <Skeleton className="h-9 w-24 rounded-lg" />
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

/** 线程页骨架：焦点帖 + 两条回复（含自接链的紧凑行）。 */
export function ThreadSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="thread-skeleton" aria-hidden>
      <div className="rounded-xl border border-border/60 bg-card/40">
        <PostSkeleton variant="focal" />
      </div>
      <div className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60 bg-card/40">
        <PostSkeleton />
        <PostSkeleton />
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

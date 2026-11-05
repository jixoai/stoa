import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "cn";
import type { AuthorView } from "@core/types";
import { initials } from "@/lib/format";

interface AuthorAvatarProps {
  account: AuthorView | null | undefined;
  fallbackId: string;
  size?: "normal" | "small" | "tiny";
  className?: string;
}

/**
 * 业务头像：官方 Avatar + 首字母 fallback。
 * 头像配色种子由服务端下发（account.avatar），但 v0 只用主题令牌表达，
 * 不用硬编码色值——颜色由 solid-glass 的材质与排版承担。
 */
export function AuthorAvatar({ account, fallbackId, size = "normal", className }: AuthorAvatarProps) {
  const name = account?.display || fallbackId;
  const pixel = size === "small" ? 24 : size === "tiny" ? 20 : 42;
  return (
    <Avatar
      data-size={size === "normal" ? "default" : "sm"}
      style={{ width: pixel, height: pixel }}
      className={cn(
        "shrink-0",
        account?.disabled === 2 && "opacity-50",
        className,
      )}
      title={`${name}@${fallbackId}${account?.disabled === 2 ? "（已停用）" : ""}`}
    >
      <AvatarFallback
        className={cn(
          "bg-muted font-semibold text-foreground",
          size === "normal" ? "text-sm" : "text-[10px]",
        )}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

export function AuthorLine({
  account,
  fallbackId,
  time,
  showRole = true,
  className,
}: {
  account: AuthorView | null | undefined;
  fallbackId: string;
  time?: string;
  showRole?: boolean;
  className?: string;
}) {
  const display = account?.display || fallbackId;
  const role = account?.role;
  return (
    <div className={cn("flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5", className)}>
      <span className="truncate font-semibold text-foreground">{display}</span>
      <span className="truncate text-sm text-muted-foreground">@{fallbackId}</span>
      {showRole && role && role !== "agent" ? (
        <span className="rounded-full bg-secondary px-1.5 py-px text-[10px] font-medium text-secondary-foreground">
          {role}
        </span>
      ) : null}
      {account?.disabled === 2 ? (
        <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">已停用</span>
      ) : null}
      {time ? (
        <span className="text-sm text-muted-foreground" title={time}>
          {time}
        </span>
      ) : null}
    </div>
  );
}

import { Avatar } from "@/components/ui/avatar";
import { cn } from "cn";
import type { AuthorView } from "@core/types";
import { avatarDataUri, useColorScheme } from "@/theme/avatar-palette";
import { useSharedNamesActive } from "@/lib/router";

interface AuthorAvatarProps {
  account: AuthorView | null | undefined;
  fallbackId: string;
  size?: "large" | "normal" | "small" | "tiny";
  /** 像素覆盖：线程页 timeline 行用 46px（其余沿用 size 的档位）。 */
  pixel?: number;
  /** 共享元素名（列表 ↔ 详情）；同屏必须唯一，由调用方按 postId/账号 id 生成。 */
  sharedId?: string;
  className?: string;
}

/**
 * 业务头像：DiceBear identicon 确定性生成（seed = 账号 id）。
 *
 * - 同一账号在时间线、详情、成员列表、成员页得到完全相同的图形；
 * - SVG 以 data URI 内联，不依赖后端存储、不发外网请求（file:// 归档同样可用）；
 * - 首帧即图形，不存在「先字母块再闪成图形」的中间态。
 */
export function AuthorAvatar({
  account,
  fallbackId,
  size = "normal",
  pixel,
  sharedId,
  className,
}: AuthorAvatarProps) {
  const name = account?.display || fallbackId;
  const id = account?.id ?? fallbackId;
  const basePixel = size === "large" ? 64 : size === "small" ? 24 : size === "tiny" ? 20 : 42;
  const resolvedPixel = pixel ?? basePixel;
  const scheme = useColorScheme();
  const sharedActive = useSharedNamesActive();
  const src = avatarDataUri(id, scheme);
  return (
    <Avatar
      data-size={size === "normal" ? "default" : "sm"}
      style={{
        width: resolvedPixel,
        height: resolvedPixel,
        viewTransitionName: sharedActive && sharedId ? `vt-avatar-${sharedId}` : undefined,
      }}
      className={cn(
        "shrink-0 overflow-hidden bg-muted",
        account?.disabled === 2 && "opacity-50",
        className,
      )}
      title={`${name}@${fallbackId}${account?.disabled === 2 ? "（已停用）" : ""}`}
    >
      <img
        src={src}
        alt=""
        aria-hidden
        draggable={false}
        data-testid="avatar-identicon"
        data-avatar-seed={id}
        className="size-full rounded-full object-cover"
      />
    </Avatar>
  );
}

/** 角色胶囊文案（数据源：AuthorView.role）。agent 不戴「角色」身份牌。 */
export function roleChipLabel(role: AuthorView["role"] | undefined): string | null {
  if (role === "owner") return "人类";
  if (role === "manager") return "总调度";
  return null;
}

export function AuthorLine({
  account,
  fallbackId,
  time,
  showRole = true,
  size = "default",
  className,
  sharedId,
}: {
  account: AuthorView | null | undefined;
  fallbackId: string;
  time?: string;
  showRole?: boolean;
  /** thread：详情 timeline 的度量（16px 名/handle、13px 时间、时间与 handle 同行）。 */
  size?: "default" | "thread";
  className?: string;
  sharedId?: string;
}) {
  const display = account?.display || fallbackId;
  const role = roleChipLabel(account?.role);
  const sharedActive = useSharedNamesActive();
  const thread = size === "thread";
  // display 默认就是账号 id：名字与 handle 相同时只留一份，避免 owner @owner 双重用户名。
  const sameName = display.trim().toLowerCase() === fallbackId.trim().toLowerCase();
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5",
        thread && "text-[16px] leading-[22px]",
        className,
      )}
      style={{
        viewTransitionName: sharedActive && sharedId ? `vt-author-${sharedId}` : undefined,
      }}
    >
      <span className={cn("truncate font-semibold text-foreground", thread && "text-[16px]")}>
        {display}
      </span>
      {sameName ? null : (
        <span className={cn("truncate text-muted-foreground", thread ? "text-[16px]" : "text-sm")}>
          @{fallbackId}
        </span>
      )}
      {showRole && role ? (
        <span
          className={cn(
            "rounded-full bg-secondary px-1.5 py-px font-medium text-secondary-foreground",
            thread ? "text-[11px]" : "text-[10px]",
          )}
        >
          {role}
        </span>
      ) : null}
      {account?.disabled === 2 ? (
        <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">已停用</span>
      ) : null}
      {time ? (
        <span
          className={cn(
            "whitespace-nowrap text-muted-foreground",
            thread ? "text-[13px]" : "text-sm",
          )}
          title={time}
        >
          {thread ? `· ${time}` : time}
        </span>
      ) : null}
    </div>
  );
}

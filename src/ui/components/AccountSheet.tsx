/**
 * 账号抽屉（X 式）：头像/昵称/粉丝数 + 个人资料、收藏、连接与成员、主题、退出。
 *
 * 只做我们有真实能力的入口——不照搬 X 的 Premium/社群/创作者工作室。
 * 静态归档下写操作入口隐藏（收藏仍可看导出快照里的列表）。
 */
import { useEffect, useState } from "react";
import {
  BookmarkIcon,
  LogOutIcon,
  MoonIcon,
  ServerIcon,
  SettingsIcon,
  SunIcon,
  UserRoundIcon,
  UsersRoundIcon,
} from "lucide-react";
import type { ProfileAccountView } from "@/lib/api";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import { useConnection } from "@/state/connection";
import { getCachedIdentity, getCachedProfile, rememberProfile } from "@/state/cache";
import { goBack, navigate } from "@/lib/router";
import { roleLabel } from "@/lib/format";
import { useTheme } from "@/lib/theme";

interface AccountSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 关闭本抽屉后打开「信息」sheet（连接与成员）。 */
  onOpenInfo: () => void;
}

export function AccountSheet({ open, onOpenChange, onOpenInfo }: AccountSheetProps) {
  const { account, accounts, staticMode, client, logout } = useConnection();
  const { dark, toggle } = useTheme();
  const [profile, setProfile] = useState<ProfileAccountView | null>(() =>
    account ? getCachedProfile(account.id) : null,
  );

  const me = account?.id ?? "";
  const identity = profile ?? (me ? getCachedIdentity(me) : null);
  const accountRow = accounts.find((row) => row.id === me) ?? null;
  const display = identity?.display ?? accountRow?.display ?? me;
  const role = identity?.role ?? accountRow?.role ?? account?.role ?? "agent";

  useEffect(() => {
    if (!open || !client || !me || staticMode) return;
    let alive = true;
    client
      .profile(me, { limit: 1 })
      .then((page) => {
        if (!alive) return;
        rememberProfile(page.account);
        setProfile(page.account);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, client, me, staticMode]);

  // 抽屉是 #/account 路由：动作直接 replace 到目标页，返回时不会再弹回抽屉。
  const go = (path: string) => {
    navigate(path, true);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="account-sheet"
        className="max-h-[88dvh] gap-0 rounded-t-2xl pb-[env(safe-area-inset-bottom)] xl:hidden"
      >
        <SheetHeader className="pb-2 pt-4">
          <SheetTitle className="sr-only">账号</SheetTitle>
          <div className="flex items-start gap-3">
            <AuthorAvatar account={identity} fallbackId={me || "?"} size="large" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-semibold leading-tight">{display}</div>
              <div className="truncate text-sm text-muted-foreground">@{me || "unknown"}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{roleLabel(role)}</span>
                {profile ? (
                  <>
                    <span>
                      <strong className="font-semibold text-foreground">
                        {profile.following_count}
                      </strong>{" "}
                      正在关注
                    </span>
                    <span>
                      <strong className="font-semibold text-foreground">
                        {profile.follower_count}
                      </strong>{" "}
                      关注者
                    </span>
                  </>
                ) : (
                  <Skeleton className="h-3 w-24" />
                )}
              </div>
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
          <div className="flex flex-col">
            <Button
              variant="ghost"
              className="h-11 justify-start gap-3 px-2 text-[0.95rem] font-normal"
              data-testid="account-menu-profile"
              onClick={() => go(`/u/${encodeURIComponent(me)}`)}
            >
              <UserRoundIcon className="size-5" />
              个人资料
            </Button>
            <Button
              variant="ghost"
              className="h-11 justify-start gap-3 px-2 text-[0.95rem] font-normal"
              data-testid="account-menu-bookmarks"
              onClick={() => go("/bookmarks")}
            >
              <BookmarkIcon className="size-5" />
              收藏
            </Button>
            <Button
              variant="ghost"
              className="h-11 justify-start gap-3 px-2 text-[0.95rem] font-normal"
              data-testid="account-menu-info"
              onClick={() => onOpenInfo()}
            >
              <UsersRoundIcon className="size-5" />
              连接与成员
            </Button>

            <Separator className="my-2" />

            <Button
              variant="ghost"
              className="h-11 justify-start gap-3 px-2 text-[0.95rem] font-normal"
              data-testid="account-menu-settings"
              onClick={() => navigate("/settings", true)}
            >
              <SettingsIcon className="size-5" />
              设置
            </Button>

            <Button
              variant="ghost"
              className="h-11 justify-start gap-3 px-2 text-[0.95rem] font-normal"
              data-testid="account-menu-theme"
              onClick={toggle}
            >
              {dark ? <SunIcon className="size-5" /> : <MoonIcon className="size-5" />}
              {dark ? "切换到浅色" : "切换到深色"}
            </Button>
            {staticMode ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                静态归档 · 只读：收藏列表来自导出时的快照，不能新增或取消。
              </p>
            ) : (
              <>
                <Button
                  variant="ghost"
                  className="h-11 justify-start gap-3 px-2 text-[0.95rem] font-normal"
                  data-testid="account-menu-switch"
                  onClick={() => navigate("/instances", true)}
                >
                  <ServerIcon className="size-5" />
                  连接其它实例
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 justify-start gap-3 px-2 text-[0.95rem] font-normal text-destructive hover:bg-destructive/10 hover:text-destructive"
                  data-testid="account-menu-logout"
                  onClick={() => {
                    logout();
                    goBack();
                  }}
                >
                  <LogOutIcon className="size-5" />
                  退出登录
                </Button>
              </>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

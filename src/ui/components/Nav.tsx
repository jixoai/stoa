import { useMemo, useState } from "react";
import { cn } from "cn";
import {
  BellIcon,
  ChevronDownIcon,
  HomeIcon,
  LogOutIcon,
  MoonIcon,
  PenSquareIcon,
  SearchIcon,
  ServerIcon,
  SunIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AuthorAvatar } from "@/components/AuthorAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConnection } from "@/state/connection";
import { useNotifications } from "@/state/notifications";
import { navigate, useRoute } from "@/lib/router";
import { displayCount } from "@/lib/format";

interface NavItem {
  key: "home" | "search" | "notifications" | "compose";
  label: string;
  href: string;
  icon: typeof HomeIcon;
}

const ITEMS: NavItem[] = [
  { key: "home", label: "主页", href: "/", icon: HomeIcon },
  { key: "search", label: "搜索", href: "/search", icon: SearchIcon },
  { key: "notifications", label: "通知", href: "/notifications", icon: BellIcon },
  { key: "compose", label: "发帖", href: "/compose", icon: PenSquareIcon },
];

function useActiveKey(): NavItem["key"] {
  const route = useRoute();
  if (route.name === "search") return "search";
  if (route.name === "notifications") return "notifications";
  if (route.name === "compose") return "compose";
  return "home";
}

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("report.theme", next ? "dark" : "light");
    } catch {
      // ignore
    }
    setDark(next);
  };
  return { dark, toggle };
}

export function DesktopNav() {
  const active = useActiveKey();
  const { account, accounts, logout, switchBackend } = useConnection();
  const { unread } = useNotifications();
  const { dark, toggle } = useTheme();

  return (
    <aside className="hidden h-full w-[240px] shrink-0 flex-col gap-2 border-r border-border/50 px-3 py-4 lg:flex xl:w-[260px]">
      <div className="flex items-center gap-2 px-2 pb-3">
        <span className="glass-primary flex size-9 items-center justify-center rounded-xl text-base font-semibold text-primary-foreground">
          R
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold">report</div>
          <div className="truncate text-[11px] text-muted-foreground">人机公示板</div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5" aria-label="主导航">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.key;
          return (
            <Button
              key={item.key}
              variant={isActive ? "secondary" : "ghost"}
              className="h-10 justify-start gap-3 px-3 text-[0.95rem]"
              aria-current={isActive ? "page" : undefined}
              onClick={() => navigate(item.href)}
            >
              <Icon className="size-5" />
              <span>{item.label}</span>
              {item.key === "notifications" && unread > 0 ? (
                <Badge variant="secondary" className="ml-auto h-5 px-1.5 text-[10px]">
                  {displayCount(unread)}
                </Badge>
              ) : null}
            </Button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" className="h-auto w-full justify-start gap-2 px-2 py-2 text-left" />
            }
          >
            <AuthorAvatar account={accounts.find((row) => row.id === account?.id) ?? null} fallbackId={account?.id ?? "?"} size="small" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">@{account?.id ?? "unknown"}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{account?.role ?? ""}</span>
            </span>
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>@{account?.id ?? "unknown"}</DropdownMenuLabel>
              <DropdownMenuItem onClick={toggle}>
                {dark ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
                {dark ? "切换到浅色" : "切换到深色"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={switchBackend}>
                <ServerIcon className="size-4" /> 连接其它实例
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={logout}>
                <LogOutIcon className="size-4" /> 退出登录
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}

export function MobileNav() {
  const active = useActiveKey();
  const { unread } = useNotifications();
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex h-14 items-stretch border-t border-border/60 bg-background/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
      aria-label="主导航"
    >
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.key;
        return (
          <Button
            key={item.key}
            type="button"
            variant="ghost"
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative flex h-auto flex-1 flex-col items-center justify-center gap-0.5 rounded-none px-0 text-[11px] font-normal transition-colors hover:bg-transparent dark:hover:bg-transparent",
              isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => navigate(item.href)}
          >
            <Icon className="size-5" />
            <span>{item.label}</span>
            {item.key === "notifications" && unread > 0 ? (
              <span className="absolute right-[26%] top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] text-primary-foreground">
                {displayCount(unread)}
              </span>
            ) : null}
          </Button>
        );
      })}
    </nav>
  );
}

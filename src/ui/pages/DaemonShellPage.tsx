/**
 * daemon 壳页（daemon-unified-port design §7 / spec「实例壳与浮动小球」，S4）。
 *
 * 全屏 iframe 呈现实例（`/i/<slug>/` 或 standalone 的 TCP origin），iframe 之外只有右下
 * **浮动小球**：点击展开 daemon 快捷菜单（回到 daemon / 切换实例 / 刷新 / 复制链接 / 退出登录）。
 *
 * 纪律：组件只用仓内 shadcn 官方收编件（Button/DropdownMenu）；图标 lucide 单色；
 * 无 HTML 外阴影（小球光影由元素内部渐变承担）；键盘可达（Button 可聚焦、菜单自带
 * Enter/Space/Esc 与焦点归还）；`prefers-reduced-motion` 下不做位移动画。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftIcon,
  CopyIcon,
  LogOutIcon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ShellInstance {
  id: string;
  slug: string;
  name: string;
  status: string;
  iframeUrl: string;
}

export interface ShellBoot {
  current: ShellInstance;
  instances: ShellInstance[];
}

/** 服务端注入的壳数据（`window.__STOA_SHELL__`）。 */
export function readShellBoot(): ShellBoot | null {
  const boot = (window as Window & { __STOA_SHELL__?: ShellBoot }).__STOA_SHELL__;
  if (!boot || typeof boot !== "object") return null;
  if (!boot.current || typeof boot.current.slug !== "string") return null;
  return boot;
}

function shellPath(slug: string): string {
  return `/shell/${encodeURIComponent(slug)}`;
}

export function DaemonShellPage({ boot }: { boot: ShellBoot }) {
  const [current, setCurrent] = useState<ShellInstance>(boot.current);
  const [frameKey, setFrameKey] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const others = useMemo(
    () => boot.instances.filter((item) => item.id !== current.id),
    [boot.instances, current.id],
  );

  /** 切换实例：地址栏与 iframe 同步（design §7「URL 与 iframe 同步」）。 */
  const switchTo = useCallback((instance: ShellInstance) => {
    setCurrent(instance);
    setFrameKey((key) => key + 1);
    window.history.replaceState(null, "", shellPath(instance.slug));
    setNote(null);
  }, []);

  const refresh = useCallback(() => {
    setFrameKey((key) => key + 1);
  }, []);

  const copyLink = useCallback(async () => {
    const link = `${window.location.origin}${shellPath(current.slug)}`;
    try {
      await navigator.clipboard.writeText(link);
      setNote("已复制当前链接");
    } catch {
      setNote("复制失败，请手动复制地址栏链接");
    }
  }, [current.slug]);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/daemon/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  }, []);

  // 提示 2.6s 后自动消失（aria-live 由下方 role=status 承担）。
  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 2600);
    return () => window.clearTimeout(timer);
  }, [note]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-background">
      <iframe
        key={frameKey}
        src={current.iframeUrl}
        title={`实例 ${current.name}`}
        className="h-full w-full border-0"
        allow="clipboard-write"
        referrerPolicy="same-origin"
        data-testid="daemon-shell-frame"
      />

      {/* 浮动小球：固定右下，44px；光影由内部渐变承担（不用 box-shadow）。 */}
      <div className="fixed right-5 bottom-5 z-50">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon"
                className="size-11 rounded-full border border-border/70 bg-gradient-to-b from-background/95 to-background/70 text-foreground backdrop-blur-md transition-transform hover:scale-[1.03] active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100"
                aria-label="daemon 快捷菜单"
                title="daemon 快捷菜单"
                data-testid="daemon-shell-ball"
              />
            }
          >
            <ServerIcon className="size-5" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-60">
            <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
              <span className="truncate">当前：{current.name}</span>
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => window.location.assign("/")}
              data-testid="daemon-shell-home"
            >
              <ArrowLeftIcon />
              回到 daemon
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              切换实例
            </DropdownMenuLabel>
            {others.length === 0 ? (
              <DropdownMenuItem disabled>没有其它运行中的实例</DropdownMenuItem>
            ) : (
              others.map((instance) => (
                <DropdownMenuItem
                  key={instance.id}
                  onClick={() => switchTo(instance)}
                  data-testid={`daemon-shell-switch-${instance.slug}`}
                >
                  <ServerIcon />
                  <span className="truncate">{instance.name}</span>
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={refresh} data-testid="daemon-shell-refresh">
              <RefreshCwIcon />
              刷新当前实例
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void copyLink()} data-testid="daemon-shell-copy">
              <CopyIcon />
              复制当前链接
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => void logout()}
              data-testid="daemon-shell-logout"
            >
              <LogOutIcon />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span role="status" aria-live="polite" className="sr-only">
          {note ?? ""}
        </span>
        {note ? (
          <div className="absolute right-0 bottom-14 w-max max-w-[220px] rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground">
            {note}
          </div>
        ) : null}
      </div>
    </div>
  );
}

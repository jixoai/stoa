/**
 * 根页关闭提醒（design report-ux-r2 §3 / spec report-nav）。
 *
 * 只在「根页且没有可回的应用内页面」时生效：
 * - 优先 `CloseWatcher`：监听平台关闭请求（返回手势/关闭），确认后才放行；
 * - 浏览器不支持时压一条合成历史条目，`popstate` 时弹确认；确认后再次 back 放行；
 * - 子页（详情/成员/标签/发帖）不拦截——返回就是回上一页。
 */
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface CloseWatcherLike {
  oncancel: ((event: Event) => void) | null;
  onclose: ((event: Event) => void) | null;
  destroy(): void;
}

type CloseWatcherCtor = new () => CloseWatcherLike;

interface GuardState {
  __reportGuard?: boolean;
  __report?: boolean;
  idx?: number;
}

function isGuardState(state: unknown): boolean {
  return Boolean(state && typeof state === "object" && (state as GuardState).__reportGuard === true);
}

/** 退回「应用根基线」（initHistory 的 idx 0）才是关闭语义；子页/外部导航放行。 */
function isRootBaseline(state: unknown): boolean {
  return Boolean(
    state &&
      typeof state === "object" &&
      (state as GuardState).__report === true &&
      (state as GuardState).idx === 0,
  );
}

function closeWatcherCtor(): CloseWatcherCtor | null {
  const ctor = (window as unknown as { CloseWatcher?: CloseWatcherCtor }).CloseWatcher;
  return typeof ctor === "function" ? ctor : null;
}

export function LeaveGuard({ active, routeKey }: { active: boolean; routeKey: string }) {
  const [ask, setAsk] = useState(false);
  const leavePending = useRef(false);
  const bypass = useRef(false);
  // 合成条目是否正在栈顶（replaceState 会让 state 丢旗标，这里以引用为准）。
  const guardEntry = useRef(isGuardState(window.history.state));

  const pushGuard = () => {
    window.history.pushState(
      { ...(window.history.state ?? {}), __reportGuard: true },
      "",
      window.location.href,
    );
    guardEntry.current = true;
  };

  // 合成历史条目：根页时垫一层同 URL 条目，返回先落回这一层 → 弹确认。
  useEffect(() => {
    if (!active) return;
    if (!guardEntry.current) pushGuard();
    const onPop = (event: PopStateEvent) => {
      if (leavePending.current) {
        leavePending.current = false;
        guardEntry.current = false;
        window.history.back();
        return;
      }
      if (bypass.current) {
        bypass.current = false;
        return;
      }
      // 只有弹回根基线（合成条目被 pop）才拦截；前进到子页/根 tab 不拦。
      if (!guardEntry.current || !isRootBaseline(event.state)) return;
      guardEntry.current = false;
      setAsk(true);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
    };
  }, [active, routeKey]);

  // CloseWatcher：现代浏览器的平台关闭请求（返回手势/关闭），确认后才放行。
  useEffect(() => {
    if (!active) return;
    const Ctor = closeWatcherCtor();
    if (!Ctor) return;
    let watcher: CloseWatcherLike | null = null;
    try {
      watcher = new Ctor();
    } catch {
      return;
    }
    watcher.oncancel = (event) => {
      event.preventDefault();
      setAsk(true);
    };
    return () => {
      watcher?.destroy();
    };
  }, [active]);

  const keepHere = () => {
    setAsk(false);
    if (!guardEntry.current) pushGuard();
  };

  const leave = () => {
    setAsk(false);
    if (guardEntry.current) {
      // 合成条目仍在栈顶（CloseWatcher 路径）：先弹出它，再真正退出。
      leavePending.current = true;
      window.history.back();
      return;
    }
    bypass.current = true;
    window.history.back();
  };

  return (
    <Dialog
      open={ask}
      onOpenChange={(open) => {
        if (!open) keepHere();
      }}
    >
      <DialogContent data-testid="leave-confirm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>离开 report？</DialogTitle>
          <DialogDescription>
            确认离开当前页面吗？未发布的草稿会保留在本机。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" data-testid="leave-confirm-cancel" onClick={keepHere}>
            留下
          </Button>
          <Button data-testid="leave-confirm-ok" onClick={leave}>
            离开
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

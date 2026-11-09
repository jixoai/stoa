/**
 * 浮层的「返回即关闭」（图片预览 / 回复编辑器）。
 *
 * 官方实现口径（node_modules/@base-ui/react 实证）：
 * - Base UI 只在 **Drawer** 里接 `CloseWatcher`（仅 Android、监听 `cancel`），
 *   Dialog/Sheet 本身只有 Esc 与点遮罩；桌面浏览器的返回键是**历史导航**，CloseWatcher
 *   根本收不到。账号抽屉/设置/信息面板已改为独立路由（#/account 等），不再用本 hook。
 * - 因此这里用**合成历史条目 + popstate**：打开浮层时压一层同 URL 条目，返回（按钮/手势/
 *   iOS 侧滑）先弹这层 → 关闭浮层，路由不变；用 X/Esc 关闭时把合成条目弹回，避免死条目。
 *   与 `LeaveGuard` 的根页关闭守卫同一套机制，CloseWatcher 不再重复接线。
 *
 * 约束：浮层按 LIFO 关闭（后开的先关）；不支持 `history` 的环境直接跳过（Esc/按钮兜底）。
 */
import { useEffect, useRef } from "react";

interface OverlayState {
  __overlay?: boolean;
}

interface Entry {
  id: number;
  close: () => void;
}

let nextId = 1;
let pendingProgrammaticBack = 0;
const stack: Entry[] = [];

function isOverlayState(state: unknown): boolean {
  return Boolean(state && typeof state === "object" && (state as OverlayState).__overlay === true);
}

function closeTop(): void {
  const top = stack[stack.length - 1];
  if (!top) return;
  stack.pop();
  top.close();
}

// 单例 popstate：只有「栈非空」时拦截；合成条目弹出时关闭最上层浮层。
if (typeof window !== "undefined") {
  window.addEventListener("popstate", (event) => {
    if (pendingProgrammaticBack > 0) {
      pendingProgrammaticBack -= 1;
      return;
    }
    if (stack.length === 0) return;
    // 弹回的仍是浮层条目（嵌套浮层）→ 关上一层；弹到应用条目同样视为关闭请求。
    void event;
    closeTop();
  });
}

export function useBackClose(active: boolean, onClose: () => void): void {
  const handler = useRef(onClose);
  handler.current = onClose;

  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const id = nextId++;
    const entry: Entry = { id, close: () => handler.current() };
    // 压一层同 URL 条目（保留路由 state，只打上浮层标记）。
    if (!isOverlayState(window.history.state)) {
      window.history.pushState({ ...(window.history.state ?? {}), __overlay: true }, "");
    }
    stack.push(entry);
    return () => {
      const at = stack.findIndex((row) => row.id === id);
      if (at >= 0) stack.splice(at, 1);
      // 通过 X / Esc 关闭：把本次压入的合成条目弹回（此时已出栈，不会被自己再关一次）。
      if (isOverlayState(window.history.state)) {
        pendingProgrammaticBack += 1;
        window.history.back();
      }
    };
  }, [active]);
}

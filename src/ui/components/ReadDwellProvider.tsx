/**
 * 视窗停留已读的 Provider（report-read-dwell design §2.1/§7）。
 *
 * - 只有「非静态归档 + 浏览器支持 IntersectionObserver」才创建引擎；
 * - 静态模式/无 IO 环境：直接渲染 children，不建观察器、不写 localStorage、
 *   卡片不渲染 data-read（PostCard 侧也按 staticMode 门控）；
 * - 无 Provider 时 `useReadDwell()` 返回 no-op（组件单测/独立渲染不抛错）；
 * - `window.__reportReadDwell` 由 read-dwell 模块级安装，禁用态也在场。
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useConnection } from "@/state/connection";
import { useNotifications } from "@/state/notifications";
import {
  ReadDwellEngine,
  setReadDwellEnabled,
  type DwellTargetInput,
} from "@/state/read-dwell";

export interface ReadDwellApi {
  active: boolean;
  observe: (el: HTMLElement, target: DwellTargetInput) => void;
  unobserve: (el: HTMLElement) => void;
  /** 无 scope＝全局暂停；带 scope＝只暂停 scope 之外的目标（详情覆盖层）。 */
  hold: (reason: string, scope?: Element | null) => void;
  release: (reason: string) => void;
}

const NOOP_API: ReadDwellApi = {
  active: false,
  observe: () => {},
  unobserve: () => {},
  hold: () => {},
  release: () => {},
};

const ReadDwellContext = createContext<ReadDwellApi>(NOOP_API);

export function useReadDwell(): ReadDwellApi {
  return useContext(ReadDwellContext);
}

function intersectionObserverSupported(): boolean {
  return typeof IntersectionObserver !== "undefined";
}

export function ReadDwellProvider({ children }: { children: ReactNode }) {
  const { staticMode, account } = useConnection();
  const { markPostRead, isPostRead } = useNotifications();

  // 回调走 ref：NotificationsProvider 每次渲染都会给出新的闭包，但引擎只建一次。
  const latest = useRef({ markPostRead, isPostRead });
  latest.current = { markPostRead, isPostRead };
  const selfIdRef = useRef<string | null>(account?.id ?? null);
  selfIdRef.current = account?.id ?? null;

  const enabled = !staticMode && intersectionObserverSupported();
  // 账号切换重建引擎（api 身份变化 → PostCard 重新注册到新引擎），
  // 避免 reset() 后既有卡片失去观察。
  const engine = useMemo(() => {
    if (!enabled) return null;
    return new ReadDwellEngine({
      markPostRead: (postId) => latest.current.markPostRead(postId),
      isRead: (postId, seq) => latest.current.isPostRead(postId, seq),
      getSelfId: () => selfIdRef.current,
    });
  }, [enabled, account?.id]);

  // 诊断开关：静态/降级时 enabled=false 且计数归零（A5）。
  useEffect(() => {
    setReadDwellEnabled(Boolean(engine));
    return () => setReadDwellEnabled(false);
  }, [engine]);

  useEffect(() => {
    return () => engine?.dispose();
  }, [engine]);

  const api = useMemo<ReadDwellApi>(() => {
    if (!engine) return NOOP_API;
    return {
      active: true,
      observe: (el, target) => engine.observe(el, target),
      unobserve: (el) => engine.unobserve(el),
      hold: (reason, scope) => engine.hold(reason, scope),
      release: (reason) => engine.release(reason),
    };
  }, [engine]);

  return <ReadDwellContext.Provider value={api}>{children}</ReadDwellContext.Provider>;
}

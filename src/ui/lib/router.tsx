/**
 * hash 路由 + 真实历史栈 + View Transitions（design report-app-grade §3.1/§7）。
 *
 * - 任意静态宿主（含 `file://`）零配置可用，不依赖 SPA fallback；
 * - 每次进入详情/成员页/标签页/发帖箱 push 一条历史，返回 = popstate 弹栈；
 * - 深链（新标签直接打开子页）构造合成栈：根 → 子页，保证「返回」有去处；
 * - 转场主路径 = View Transitions API：方向由 `depth` 与历史索引决定，通过
 *   `html[data-vt=forward|back|fade]` 驱动 `::view-transition-old/new(*)`；
 * - `startViewTransition` 不存在时由调用方（RouteTransition）用 motion 降级；
 * - `prefers-reduced-motion` 时全部瞬时（不调用 View Transitions）。
 *
 * 路由表：`#/`、`#/?tab=following`、`#/p/<id>`、`#/u/<account>`、`#/tag/<tag>`、
 *         `#/search[?q=]`、`#/notifications`、`#/compose[?quote=]`
 */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { FeedTab } from "@core/types";

export type Route =
  | { name: "home"; tab: FeedTab }
  | { name: "post"; id: string; reply?: boolean }
  | { name: "profile"; account: string }
  | { name: "tag"; tag: string }
  | { name: "search"; q: string }
  | { name: "notifications" }
  | { name: "compose"; quote: string | null };

export type TransitionDirection = "forward" | "back" | "fade";

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [pathPart = "/", queryPart = ""] = raw.split("?");
  const params = new URLSearchParams(queryPart);
  const segments = pathPart.split("/").filter(Boolean);
  if (segments[0] === "p" && segments[1]) {
    return { name: "post", id: decodeURIComponent(segments[1]), reply: params.get("reply") === "1" };
  }
  if (segments[0] === "u" && segments[1]) {
    return { name: "profile", account: decodeURIComponent(segments[1]) };
  }
  if (segments[0] === "tag" && segments[1]) {
    return { name: "tag", tag: decodeURIComponent(segments[1]) };
  }
  if (segments[0] === "search") return { name: "search", q: params.get("q") ?? "" };
  if (segments[0] === "notifications") return { name: "notifications" };
  if (segments[0] === "compose") return { name: "compose", quote: params.get("quote") };
  return { name: "home", tab: params.get("tab") === "following" ? "following" : "recommended" };
}

export function routePath(route: Route): string {
  switch (route.name) {
    case "post":
      return `/p/${encodeURIComponent(route.id)}${route.reply ? "?reply=1" : ""}`;
    case "profile":
      return `/u/${encodeURIComponent(route.account)}`;
    case "tag":
      return `/tag/${encodeURIComponent(route.tag)}`;
    case "search":
      return route.q ? `/search?q=${encodeURIComponent(route.q)}` : "/search";
    case "notifications":
      return "/notifications";
    case "compose":
      return route.quote ? `/compose?quote=${encodeURIComponent(route.quote)}` : "/compose";
    default:
      return route.tab === "following" ? "/?tab=following" : "/";
  }
}

/** 稳定的路由键（滚动记忆 / 转场 / 来源标注共用）。 */
export function routeKey(route: Route): string {
  switch (route.name) {
    case "post":
      return `post:${route.id}${route.reply ? ":reply" : ""}`;
    case "profile":
      return `profile:${route.account}`;
    case "tag":
      return `tag:${route.tag}`;
    case "search":
      return `search:${route.q}`;
    case "notifications":
      return "notifications";
    case "compose":
      return `compose:${route.quote ?? ""}`;
    default:
      return `home:${route.tab}`;
  }
}

export function routeLabel(route: Route): string {
  switch (route.name) {
    case "post":
      return "帖子";
    case "profile":
      return "成员";
    case "tag":
      return "标签";
    case "search":
      return "搜索";
    case "notifications":
      return "通知";
    case "compose":
      return "发帖";
    default:
      return "主页";
  }
}

/** 0 = 根页（底部四导航）；1 = 详情/成员/标签/发帖箱（push 一层）。 */
export function routeDepth(route: Route): number {
  return route.name === "home" || route.name === "search" || route.name === "notifications" ? 0 : 1;
}

export function isRootRoute(route: Route): boolean {
  return routeDepth(route) === 0;
}

interface ReportHistoryState {
  __report: true;
  idx: number;
}

function isReportState(value: unknown): value is ReportHistoryState {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as ReportHistoryState).__report === true &&
      typeof (value as ReportHistoryState).idx === "number",
  );
}

// ── store ────────────────────────────────────────────────────────────────────

let currentRoute: Route = parseHash(typeof window === "undefined" ? "#/" : window.location.hash);
let currentIdx = 0;
const listeners = new Set<() => void>();
const sources = new Map<string, string>();
/** 当前转场方向（motion 降级路径消费） */
let currentDirection: TransitionDirection = "fade";
const directionListeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setDirection(direction: TransitionDirection): void {
  if (currentDirection === direction) return;
  currentDirection = direction;
  for (const listener of directionListeners) listener();
}

function rememberSource(next: Route, from: Route | null): void {
  if (routeDepth(next) === 0) return;
  const key = routeKey(next);
  if (sources.has(key)) return;
  sources.set(key, from ? routeLabel(from) : "主页");
}

/** 详情/成员/标签页头部的来源标注（"主页 / 搜索 / 通知 / 成员 / 标签"）。 */
export function routeSource(route: Route): string {
  return sources.get(routeKey(route)) ?? "主页";
}

function initHistory(): void {
  if (typeof window === "undefined") return;
  if (isReportState(window.history.state)) {
    currentIdx = window.history.state.idx;
    return;
  }
  const detailUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (routeDepth(currentRoute) > 0) {
    // 深链：合成「根 → 子页」两层历史，返回落到主页而不是退出应用
    rememberSource(currentRoute, null);
    window.history.replaceState(
      { __report: true, idx: 0 } satisfies ReportHistoryState,
      "",
      `${window.location.pathname}${window.location.search}#/`,
    );
    window.history.pushState(
      { __report: true, idx: 1 } satisfies ReportHistoryState,
      "",
      detailUrl,
    );
    currentIdx = 1;
  } else {
    window.history.replaceState(
      { __report: true, idx: 0 } satisfies ReportHistoryState,
      "",
      detailUrl,
    );
    currentIdx = 0;
  }
}

initHistory();

// ── View Transitions ─────────────────────────────────────────────────────────

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransition;
};

let transitionSeq = 0;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function supportsViewTransitions(): boolean {
  return typeof document !== "undefined" && "startViewTransition" in document;
}

/**
 * 官方 View Transitions 主路径：整页快照 + 同名共享元素由浏览器连续变形。
 * 快速连点：先 skip 正在跑的转场，再开新的，避免堆叠。
 */
function runTransition(direction: TransitionDirection, commit: () => void): void {
  setDirection(direction);
  const doc = document as ViewTransitionDocument;
  if (!doc.startViewTransition || prefersReducedMotion()) {
    commit();
    return;
  }
  // 快速连点：规范保证「新的 startViewTransition 会 skip 掉上一个」，无需手动 skip；
  // 上一个的 finished 会被拒绝（已 catch），不会留下未处理 rejection。
  const root = document.documentElement;
  const seq = ++transitionSeq;
  root.dataset.vt = direction;
  try {
    const transition = doc.startViewTransition(() => {
      commit();
    });
    void transition.finished
      .catch(() => undefined)
      .finally(() => {
        if (seq === transitionSeq) delete root.dataset.vt;
      });
  } catch {
    // 浏览器拒绝（例如隐藏标签页）：退化为瞬时切换
    delete root.dataset.vt;
    commit();
  }
}

function commitRoute(next: Route, opts: { replace?: boolean; idx?: number } = {}): void {
  currentRoute = next;
  if (opts.idx !== undefined) currentIdx = opts.idx;
  else currentIdx = opts.replace ? currentIdx : currentIdx + 1;
  flushSync(() => emit());
}

function navigateWithTransition(
  next: Route,
  opts: { replace?: boolean; direction: TransitionDirection; from: Route | null },
): void {
  rememberSource(next, opts.from);
  const target = `#${routePath(next)}`;
  runTransition(opts.direction, () => {
    const url = `${window.location.pathname}${window.location.search}${target}`;
    if (opts.replace) {
      window.history.replaceState(
        { __report: true, idx: currentIdx } satisfies ReportHistoryState,
        "",
        url,
      );
      commitRoute(next, { replace: true });
    } else {
      window.history.pushState(
        { __report: true, idx: currentIdx + 1 } satisfies ReportHistoryState,
        "",
        url,
      );
      commitRoute(next);
    }
  });
}

// Browser back/forward → popstate；hash links / manual hash edits → hashchange.
let suppressHashChangeUntil = 0;

if (typeof window !== "undefined") {
  window.addEventListener("popstate", (event) => {
    // back/forward 会先发 popstate 再发 hashchange；后者由这里统一处理，
    // 否则同一次返回会启动两次 View Transition（第一次被第二次 skip）。
    suppressHashChangeUntil = performance.now() + 300;
    const next = parseHash(window.location.hash);
    if (routeKey(next) === routeKey(currentRoute)) return;
    const nextIdx = isReportState(event.state) ? event.state.idx : 0;
    const direction: TransitionDirection =
      nextIdx < currentIdx ? "back" : nextIdx > currentIdx ? "forward" : "fade";
    const from = currentRoute;
    rememberSource(next, from);
    runTransition(direction, () => commitRoute(next, { idx: nextIdx }));
  });

  window.addEventListener("hashchange", () => {
    if (performance.now() < suppressHashChangeUntil) return;
    const next = parseHash(window.location.hash);
    if (routeKey(next) === routeKey(currentRoute)) return;
    const from = currentRoute;
    rememberSource(next, from);
    const direction: TransitionDirection =
      routeDepth(next) > routeDepth(from) ? "forward" : routeDepth(next) < routeDepth(from) ? "back" : "fade";
    runTransition(direction, () => {
      // 原生 hash 跳转没有带 report state；补一条，保证后续 popstate 方向正确
      window.history.replaceState(
        { __report: true, idx: currentIdx + 1 } satisfies ReportHistoryState,
        "",
        window.location.href,
      );
      commitRoute(next);
    });
  });
}

// ── hooks / public API ───────────────────────────────────────────────────────

export function useRoute(): Route {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentRoute,
    () => currentRoute,
  );
}

const SharedNamesContext = createContext(true);

/**
 * 共享元素名只在「当前可见的一层」生效：详情覆盖层打开时底层根页仍挂载，
 * 若两层都带同名 view-transition-name，浏览器会因重名放弃整次转场。
 */
export function SharedNamesProvider({ active, children }: { active: boolean; children: ReactNode }) {
  return <SharedNamesContext.Provider value={active}>{children}</SharedNamesContext.Provider>;
}

export function useSharedNamesActive(): boolean {
  return useContext(SharedNamesContext);
}

const RouteScope = createContext<Route | null>(null);

/** 详情覆盖层打开时，底层根页仍按它自己的路由渲染（不跟随 URL 变化）。 */
export function RouteScopeProvider({ route, children }: { route: Route; children: ReactNode }) {
  return <RouteScope.Provider value={route}>{children}</RouteScope.Provider>;
}

export function usePageRoute(): Route {
  const scoped = useContext(RouteScope);
  const live = useRoute();
  return scoped ?? live;
}

export function useTransitionDirection(): TransitionDirection {
  return useSyncExternalStore(
    (listener) => {
      directionListeners.add(listener);
      return () => directionListeners.delete(listener);
    },
    () => currentDirection,
    () => currentDirection,
  );
}

export function navigate(path: string, replace = false): void {
  const next = parseHash(path.startsWith("#") ? path : `#${path.startsWith("/") ? path : `/${path}`}`);
  const target = `#${routePath(next)}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === `${window.location.pathname}${window.location.search}${target}`) {
    return;
  }
  // 同一路由（键相同）不产生新的历史条目：避免重复点「主页」堆历史。
  if (routeKey(next) === routeKey(currentRoute)) return;
  const from = currentRoute;
  const fromDepth = routeDepth(from);
  const nextDepth = routeDepth(next);
  const direction: TransitionDirection = replace
    ? "fade"
    : nextDepth < fromDepth
      ? "back"
      : nextDepth > fromDepth
        ? "forward"
        : nextDepth === 0
          ? "fade"
          : "forward";
  navigateWithTransition(next, { replace, direction, from });
}

export function goBack(fallback = "/"): void {
  if (currentIdx > 0) {
    window.history.back();
  } else {
    navigate(fallback, true);
  }
}

export function useHashLink(): (path: string) => void {
  return (path: string) => navigate(path);
}

/** 供 QA/调试读取当前历史深度。 */
export function historyDepth(): number {
  return currentIdx;
}

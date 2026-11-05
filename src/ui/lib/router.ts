/**
 * hash 路由 —— 任意静态宿主（含 file://）零配置可用，不依赖 SPA fallback。
 * 路由表：`#/`、`#/p/<id>`、`#/search[?q=]`、`#/notifications`、`#/compose[?quote=]`
 */
import { useCallback, useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "post"; id: string; reply?: boolean }
  | { name: "search"; q: string }
  | { name: "notifications" }
  | { name: "compose"; quote: string | null };

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart = ""] = raw.split("?");
  const params = new URLSearchParams(queryPart);
  const segments = pathPart!.split("/").filter(Boolean);
  if (segments[0] === "p" && segments[1]) {
    return { name: "post", id: decodeURIComponent(segments[1]), reply: params.get("reply") === "1" };
  }
  if (segments[0] === "search") return { name: "search", q: params.get("q") ?? "" };
  if (segments[0] === "notifications") return { name: "notifications" };
  if (segments[0] === "compose") return { name: "compose", quote: params.get("quote") };
  return { name: "home" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(path: string, replace = false): void {
  const target = path.startsWith("#") ? path : `#${path.startsWith("/") ? path : `/${path}`}`;
  if (window.location.hash === target) return;
  if (replace) {
    const url = `${window.location.pathname}${window.location.search}${target}`;
    window.history.replaceState(null, "", url);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = target;
  }
}

export function goBack(fallback = "/"): void {
  if (window.history.length > 1) window.history.back();
  else navigate(fallback);
}

export function useHashLink(): (path: string) => void {
  return useCallback((path: string) => navigate(path), []);
}

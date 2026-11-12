import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DaemonConsolePage, readDaemonBoot } from "./pages/DaemonConsolePage";
import { DaemonLoginPage } from "./pages/DaemonLoginPage";
import { DaemonShellPage, readShellBoot } from "./pages/DaemonShellPage";
import "./app.css";

// 深色路径：系统偏好为默认，用户手动切换后以 localStorage 为准（solid-glass 只认 .dark）
function applyTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("report.theme");
  } catch {
    saved = null;
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const sync = () => {
    if (saved) {
      document.documentElement.classList.toggle("dark", saved === "dark");
    } else {
      document.documentElement.classList.toggle("dark", media.matches);
    }
  };
  sync();
  media.addEventListener?.("change", () => {
    try {
      if (localStorage.getItem("report.theme")) return;
    } catch {
      // ignore
    }
    sync();
  });
}

applyTheme();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
// 渲染开关：注入 window.__STOA_SHELL__ → 壳页（/shell/<slug>）；
// `/login`（服务端不注入 boot）→ 登录页；注入 window.__STOA_DAEMON__ → 控制台；否则公示板。
const shellBoot = readShellBoot();
const isDaemonLogin = !shellBoot && window.location.pathname.replace(/\/+$/, "") === "/login";
const daemonBoot = shellBoot || isDaemonLogin ? null : readDaemonBoot();
createRoot(root).render(
  <StrictMode>
    {shellBoot ? (
      <DaemonShellPage boot={shellBoot} />
    ) : isDaemonLogin ? (
      <DaemonLoginPage />
    ) : daemonBoot ? (
      <DaemonConsolePage boot={daemonBoot} />
    ) : (
      <App />
    )}
  </StrictMode>,
);

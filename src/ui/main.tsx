import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
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
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

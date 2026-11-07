/** 主题（solid-glass 只认 .dark）：系统偏好为默认，手动切换后写 localStorage。 */
import { useCallback, useEffect, useState } from "react";

const KEY = "report.theme";

export function useTheme(): { dark: boolean; toggle: () => void } {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = useCallback(() => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {
      // ignore
    }
    setDark(next);
  }, []);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  return { dark, toggle };
}

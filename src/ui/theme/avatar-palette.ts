/**
 * 确定性头像（spec report-app-ui「确定性生成头像」）。
 *
 * - 图案：DiceBear `identicon`（成熟库，本地生成 SVG data URI，零外网请求）；
 * - seed = 账号 id → 同一账号在任何会话/设备/刷新前后都是同一图形；
 * - 配色：从主题令牌（--brand / --link / --syn-* 等 oklch 值）解析后转 sRGB；
 *   浅色用深一档、深色用亮一档，保证在 bg-muted 上可读；
 * - 本文件位于 theme/ 层（ui-lint 的 vendor 白名单）：仅此处允许写兜底色值。
 */
import { createAvatar } from "@dicebear/core";
import * as identicon from "@dicebear/identicon";
import { useSyncExternalStore } from "react";

export type ColorScheme = "light" | "dark";

const LIGHT_TOKENS = ["--brand", "--link", "--syn-name", "--code-inline", "--syn-string"];
const DARK_TOKENS = ["--brand", "--link", "--syn-name", "--code-inline", "--syn-string"];

/** 兜底（令牌读取失败时）：与主题令牌同色系的近似值，无 # 前缀（DiceBear 约定）。 */
const LIGHT_FALLBACK = ["0f766e", "1d4ed8", "7e22ce", "b91c1c", "15803d"];
const DARK_FALLBACK = ["5eead4", "93c5fd", "c4b5fd", "fca5a5", "86efac"];

function oklchToHex(value: string): string | null {
  const match = /oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/i.exec(value.trim());
  if (!match) return null;
  let l = Number(match[1]);
  if (match[2] === "%") l /= 100;
  const c = Number(match[3]);
  const h = Number(match[4]);
  if (!Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(h)) return null;

  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);

  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = lPrime ** 3;
  const m3 = mPrime ** 3;
  const s3 = sPrime ** 3;

  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
  const hex = linear
    .map((channel) => {
      const clamped = Math.min(1, Math.max(0, channel));
      const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, srgb)) * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("");
  return hex;
}

const paletteCache = new Map<ColorScheme, string[]>();

function paletteFor(scheme: ColorScheme): string[] {
  const cached = paletteCache.get(scheme);
  if (cached) return cached;
  const fallback = scheme === "light" ? LIGHT_FALLBACK : DARK_FALLBACK;
  let colors = fallback;
  try {
    const style = getComputedStyle(document.documentElement);
    const tokens = scheme === "light" ? LIGHT_TOKENS : DARK_TOKENS;
    const parsed = tokens
      .map((token) => oklchToHex(style.getPropertyValue(token)))
      .filter((hex): hex is string => Boolean(hex && hex.length === 6));
    if (parsed.length >= 3) colors = parsed;
  } catch {
    colors = fallback;
  }
  paletteCache.set(scheme, colors);
  return colors;
}

/** 主题切换时清缓存（令牌值可能被换肤覆盖）。 */
function clearPaletteCache(): void {
  paletteCache.clear();
}

const avatarCache = new Map<string, string>();

/** 同一 (seed, scheme) 永远得到同一张图（本地生成，不发请求）。 */
export function avatarDataUri(seed: string, scheme: ColorScheme): string {
  const key = `${scheme}|${seed}`;
  const cached = avatarCache.get(key);
  if (cached) return cached;
  const uri = createAvatar(identicon, {
    seed,
    size: 96,
    scale: 94,
    radius: 0,
    rowColor: paletteFor(scheme),
  }).toDataUri();
  if (avatarCache.size > 800) avatarCache.clear();
  avatarCache.set(key, uri);
  return uri;
}

function subscribeScheme(listener: () => void): () => void {
  const observer = new MutationObserver(() => {
    clearPaletteCache();
    listener();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener?.("change", listener);
  return () => {
    observer.disconnect();
    media.removeEventListener?.("change", listener);
  };
}

function currentScheme(): ColorScheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribeScheme, currentScheme, () => "light");
}

/**
 * 滚动位置记忆（design report-app-grade §6 / spec report-app-ui）。
 *
 * - 按 `(path, feedTab)` 持久化 `{anchorPostId, offsetPx, scrollTop, savedAt}`；
 * - `sessionStorage`（同会话返回）＋ `localStorage`（关掉重开）双写，读取取较新的一份；
 * - 恢复优先级：锚点元素 → `scrollTop` → 顶部；恢复在数据就绪后的 layout 阶段完成，
 *   不触发重排（列表顺序不变，只设置 scrollTop）。
 */
export interface SavedScroll {
  path: string;
  feedTab: string;
  anchorPostId: string | null;
  offsetPx: number;
  scrollTop: number;
  savedAt: number;
}

const PREFIX = "report.scroll.v1:";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 24;

export function scrollMemoryKey(path: string, feedTab: string): string {
  return `${PREFIX}${path}|${feedTab}`;
}

function parseEntry(raw: string | null): SavedScroll | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedScroll>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.scrollTop !== "number" || typeof parsed.savedAt !== "number") return null;
    return {
      path: typeof parsed.path === "string" ? parsed.path : "",
      feedTab: typeof parsed.feedTab === "string" ? parsed.feedTab : "",
      anchorPostId: typeof parsed.anchorPostId === "string" ? parsed.anchorPostId : null,
      offsetPx: typeof parsed.offsetPx === "number" ? parsed.offsetPx : 0,
      scrollTop: Math.max(0, parsed.scrollTop),
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

export function loadScrollMemory(key: string): SavedScroll | null {
  let session: SavedScroll | null = null;
  let local: SavedScroll | null = null;
  try {
    session = parseEntry(sessionStorage.getItem(key));
  } catch {
    session = null;
  }
  try {
    local = parseEntry(localStorage.getItem(key));
  } catch {
    local = null;
  }
  if (!session) return local;
  if (!local) return session;
  return session.savedAt >= local.savedAt ? session : local;
}

function pruneLocal(): void {
  try {
    const now = Date.now();
    const entries: Array<{ key: string; savedAt: number }> = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(PREFIX)) continue;
      const entry = parseEntry(localStorage.getItem(key));
      if (!entry || now - entry.savedAt > MAX_AGE_MS) {
        localStorage.removeItem(key);
        index -= 1;
        continue;
      }
      entries.push({ key, savedAt: entry.savedAt });
    }
    entries.sort((a, b) => b.savedAt - a.savedAt);
    for (const stale of entries.slice(MAX_ENTRIES)) localStorage.removeItem(stale.key);
  } catch {
    // storage denied / private mode: memory-only session still works
  }
}

export function saveScrollMemory(key: string, entry: Omit<SavedScroll, "savedAt">): void {
  const payload: SavedScroll = { ...entry, savedAt: Date.now() };
  const raw = JSON.stringify(payload);
  try {
    sessionStorage.setItem(key, raw);
  } catch {
    // ignore
  }
  try {
    localStorage.setItem(key, raw);
    pruneLocal();
  } catch {
    // ignore
  }
}

export function clearScrollMemory(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

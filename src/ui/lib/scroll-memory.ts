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

// ── 线程页滚动记忆（design report-thread-timeline §4.3）─────────────────────────
//
// 只写 `sessionStorage`：线程页的恢复语义是「同一会话内返回」，关掉重开不
// 强求复现旧位置（与列表页的双写策略不同，避免深链下次打开被旧位置劫持）。

export interface ThreadScrollMemory {
  /** 容器顶边下方第一条 post 行的 data-post-id（跳过 subthread 入口）。 */
  anchorId: string | null;
  /** 该行 top − 容器 top（可为负）。 */
  offsetPx: number;
  scrollTop: number;
  savedAt: number;
}

const THREAD_PREFIX = "report.thread.v1:";

export function threadScrollKey(postId: string): string {
  return `${THREAD_PREFIX}${postId}`;
}

export function loadThreadScrollMemory(postId: string): ThreadScrollMemory | null {
  if (!postId) return null;
  try {
    const raw = sessionStorage.getItem(threadScrollKey(postId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ThreadScrollMemory>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.scrollTop !== "number" || typeof parsed.savedAt !== "number") return null;
    return {
      anchorId: typeof parsed.anchorId === "string" ? parsed.anchorId : null,
      offsetPx: typeof parsed.offsetPx === "number" ? parsed.offsetPx : 0,
      scrollTop: Math.max(0, parsed.scrollTop),
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

export function saveThreadScrollMemory(
  postId: string,
  entry: Omit<ThreadScrollMemory, "savedAt">,
): void {
  if (!postId) return;
  const payload: ThreadScrollMemory = { ...entry, savedAt: Date.now() };
  try {
    sessionStorage.setItem(threadScrollKey(postId), JSON.stringify(payload));
  } catch {
    // ignore (storage denied / private mode)
  }
}

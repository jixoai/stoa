/**
 * 文章内媒体的共享入口（report-longform §4.4/§4.2）：
 *
 * - 池：把帖子/被引用帖的附件元数据（hash → MediaRef，含真实 `ext`）注入上下文，
 *   让正文行内图片与指令块 media 引用复用真实扩展名（决定 viewer 的图片/视频分支）；
 * - 查看器：`ArticleBody` 挂一个 Provider，行内图片与 compare 图片经 `open()` 打开
 *   既有 `ImageViewer`（手势/计数/关闭全部复用，不写第二个查看器）；
 * - 未命中池的 `/api/media/<hash>` 按图片兜底（Markdown 图片语法本身即图片语义）。
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { MediaRef } from "@core/types";
import { ImageViewer } from "@/components/ImageViewer";

const LOCAL_MEDIA_PREFIX = "/api/media/";

const ArticleMediaContext = createContext<Map<string, MediaRef>>(new Map());

export interface ArticleViewerApi {
  /** 打开查看器；空数组忽略。 */
  open: (media: MediaRef[]) => void;
}

const NOOP_VIEWER: ArticleViewerApi = { open: () => {} };
const ArticleViewerContext = createContext<ArticleViewerApi>(NOOP_VIEWER);

export function useArticleViewer(): ArticleViewerApi {
  return useContext(ArticleViewerContext);
}

/** `/api/media/<hash>` → MediaRef（非本地引用返回 null）。 */
export function articleMediaRef(src: string, pool: Map<string, MediaRef>): MediaRef | null {
  if (!src.startsWith(LOCAL_MEDIA_PREFIX)) return null;
  const hash = src.slice(LOCAL_MEDIA_PREFIX.length);
  const known = pool.get(hash);
  if (known) return known;
  return { hash, ext: "png", bytes: 0, url: src };
}

/** 远程 http(s) 图片：不需要本地媒体池解析，直接交给查看器/ img。 */
export function isRemoteImageUrl(src: string): boolean {
  return /^https?:/i.test(src);
}

/** 上下文版的 `articleMediaRef`（Markdown 行内图片用）。 */
export function useArticleMediaRefs(): (src: string) => MediaRef | null {
  const pool = useContext(ArticleMediaContext);
  return useMemo(() => (src: string) => articleMediaRef(src, pool), [pool]);
}

export function ArticleMediaProvider({
  media,
  children,
}: {
  media: MediaRef[];
  children: ReactNode;
}) {
  const pool = useMemo(() => {
    const next = new Map<string, MediaRef>();
    for (const ref of media) next.set(ref.hash, ref);
    return next;
  }, [media]);
  const [viewer, setViewer] = useState<{ media: MediaRef[]; index: number } | null>(null);
  const api = useMemo<ArticleViewerApi>(
    () => ({
      open: (items: MediaRef[]) => {
        if (items.length > 0) setViewer({ media: items, index: 0 });
      },
    }),
    [],
  );
  return (
    <ArticleMediaContext.Provider value={pool}>
      <ArticleViewerContext.Provider value={api}>
        {children}
        {viewer ? (
          <ImageViewer
            media={viewer.media}
            index={viewer.index}
            onIndexChange={(index) => setViewer((prev) => (prev ? { ...prev, index } : prev))}
            onClose={() => setViewer(null)}
          />
        ) : null}
      </ArticleViewerContext.Provider>
    </ArticleMediaContext.Provider>
  );
}

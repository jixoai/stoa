/**
 * 客户端预览事件合并（report-link-preview P1-16 / design §8.2）。
 *
 * `post.updated` 每阶段携带该帖最新完整 previews；这里按 **canonicalUrl** 逐条比较
 * `updated_at`（较新覆盖较旧，较旧的其它链接保留），REST 的 `post.previews` 与事件
 * store 同样取较新者合并——feed 刷新返回整帖时不会回退到旧事件。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { PreviewLink } from "@core/plugins/types";
import type { PostView } from "@core/types";
import {
  applyPreviewUpdate,
  capPreviews,
  mergePreviewLists,
  type PreviewEntry,
} from "@/lib/link-preview";
import { useConnection } from "@/state/connection";
import { useEventHub } from "@/state/hub/provider";
import type { HubEventPayload } from "@/state/hub/types";

export type PostPreviewEntry = PreviewEntry;

interface PostPreviewsContextValue {
  apply: (postId: string, previews: PreviewLink[], updatedAt: number) => void;
  get: (postId: string) => PostPreviewEntry | undefined;
}

const PostPreviewsContext = createContext<PostPreviewsContextValue | null>(null);

export function PostPreviewsProvider({ children }: { children: ReactNode }) {
  const { phase, client, account, staticMode } = useConnection();
  const [entries, setEntries] = useState<Record<string, PostPreviewEntry>>({});

  // 换后端/账号/静态模式或断线回 connecting：事件投影属于旧实例，整体清空（N5）。
  useEffect(() => {
    setEntries({});
  }, [client, account?.id, staticMode, phase]);

  const apply = useCallback((postId: string, previews: PreviewLink[], updatedAt: number) => {
    if (!postId || !Array.isArray(previews)) return;
    setEntries((current) => {
      const existing = current[postId];
      const next = applyPreviewUpdate(existing, previews, updatedAt);
      if (!next || next === existing) return current;
      return { ...current, [postId]: next };
    });
  }, []);

  const get = useCallback((postId: string) => entries[postId], [entries]);

  useEventHub(["post.updated", "stream.reset"], (dispatch) => {
    if (dispatch.topic === "stream.reset") {
      // 空洞/换库：事件投影不可再信，等 REST 重取。
      setEntries({});
      return;
    }
    if (dispatch.topic !== "post.updated") return;
    const payload = (dispatch.event.payload ?? {}) as HubEventPayload;
    const postId = payload.post_id ?? dispatch.event.post_id;
    if (!postId || !Array.isArray(payload.previews)) return;
    apply(postId, payload.previews, dispatch.event.created_at);
  });

  const value = useMemo<PostPreviewsContextValue>(() => ({ apply, get }), [apply, get]);
  return <PostPreviewsContext.Provider value={value}>{children}</PostPreviewsContext.Provider>;
}

function usePostPreviewsContext(): PostPreviewsContextValue | null {
  return useContext(PostPreviewsContext);
}

/** 返回该帖合并后的 previews：REST 字段与事件 store 按条取较新者（最多 3 条）。 */
export function usePostPreviews(post: Pick<PostView, "id" | "previews">): PreviewLink[] {
  const context = usePostPreviewsContext();
  const entry = context?.get(post.id);
  return useMemo(
    () => capPreviews(mergePreviewLists(post.previews ?? [], entry?.previews ?? [])),
    [post.previews, entry],
  );
}

/**
 * 收藏状态（当前账号已收藏的帖子 id）。
 *
 * - 只缓存 id 集合：列表页的帖子由 `/api/bookmarks` 取，卡片按钮态只看集合；
 * - 乐观更新 + 失败回滚（网络失败不会留下假状态）；
 * - 静态归档：id 集合来自导出快照，写操作给只读 toast（不出网络请求）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "@/components/ui/toast";
import { useConnection } from "@/state/connection";
import { toastReadOnly } from "@/lib/readonly";

interface BookmarksValue {
  ids: Set<string>;
  /** id 集合是否已加载（列表页用它决定要不要按收藏过滤） */
  ready: boolean;
  isBookmarked: (postId: string) => boolean;
  toggle: (postId: string) => void;
}

const BookmarksContext = createContext<BookmarksValue | null>(null);

export function BookmarksProvider({ children }: { children: ReactNode }) {
  const { client, phase, staticMode, account } = useConnection();
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  const [ready, setReady] = useState(false);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const inflight = useRef(new Set<string>());

  useEffect(() => {
    if (phase !== "ready" || !client) return;
    let alive = true;
    setReady(false);
    client
      .bookmarkIds()
      .then((list) => {
        if (!alive) return;
        setIds(new Set(list));
        setReady(true);
      })
      .catch(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [client, phase, account?.id]);

  const isBookmarked = useCallback((postId: string) => idsRef.current.has(postId), []);

  const toggle = useCallback(
    (postId: string) => {
      if (staticMode) {
        toastReadOnly();
        return;
      }
      if (!client || inflight.current.has(postId)) return;
      inflight.current.add(postId);
      const was = idsRef.current.has(postId);
      const apply = (value: boolean) =>
        setIds((prev) => {
          const next = new Set(prev);
          if (value) next.add(postId);
          else next.delete(postId);
          return next;
        });
      apply(!was);
      void (was ? client.unbookmark(postId) : client.bookmark(postId))
        .then(() => {
          toast.add({
            type: "success",
            title: was ? "已取消收藏" : "已收藏",
            description: was ? "该帖已从「收藏」移除" : "可在账号菜单的「收藏」里找到",
            timeout: 2200,
          });
        })
        .catch((err: Error) => {
          apply(was);
          toast.add({ type: "error", title: "收藏失败", description: err.message, timeout: 3200 });
        })
        .finally(() => inflight.current.delete(postId));
    },
    [client, staticMode],
  );

  const value = useMemo<BookmarksValue>(
    () => ({ ids, ready, isBookmarked, toggle }),
    [ids, ready, isBookmarked, toggle],
  );
  return <BookmarksContext.Provider value={value}>{children}</BookmarksContext.Provider>;
}

export function useBookmarks(): BookmarksValue {
  const value = useContext(BookmarksContext);
  if (!value) throw new Error("useBookmarks must be used inside BookmarksProvider");
  return value;
}

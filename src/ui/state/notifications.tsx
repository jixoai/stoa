/**
 * 通知状态：REST peek 拉未读 + SSE 增量（按 seq 去重）。
 * UI 不自动推进游标——「全部标为已读」时才 ack（design §7 的交付语义在网页侧的投影）。
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
import type { NotificationEventLine, NotificationLine, ThreadSnapshotLine } from "@core/types";
import { useConnection } from "@/state/connection";

interface NotificationsValue {
  lines: NotificationLine[];
  events: NotificationEventLine[];
  snapshots: ThreadSnapshotLine[];
  unread: number;
  target: number | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  ack: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { client, subscribeEvents, sseState } = useConnection();
  const [lines, setLines] = useState<NotificationLine[]>([]);
  const [target, setTarget] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const linesRef = useRef<NotificationLine[]>([]);
  linesRef.current = lines;

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.notifications({ peek: true });
      setLines(result.events);
      setTarget(result.target);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 重连后按服务端游标补拉未读（SSE 只负责增量）
  useEffect(() => {
    if (sseState === "open") void refresh();
  }, [sseState, refresh]);

  useEffect(() => {
    return subscribeEvents((event) => {
      setLines((prev) => {
        if (prev.some((line) => "seq" in line && line.seq === event.seq)) return prev;
        return [...prev, event];
      });
      setTarget((prev) => (prev === null || event.seq > prev ? event.seq : prev));
    });
  }, [subscribeEvents]);

  const ack = useCallback(async () => {
    if (!client) return;
    const current = linesRef.current;
    const max = current.reduce((value, line) => {
      const seq = "seq" in line ? line.seq : line.of_seq;
      return Math.max(value, seq);
    }, 0);
    if (max <= 0) {
      setLines([]);
      return;
    }
    try {
      await client.ackNotifications(max);
      setLines([]);
      setTarget(null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [client]);

  const events = useMemo(
    () => lines.filter((line): line is NotificationEventLine => "seq" in line),
    [lines],
  );
  const snapshots = useMemo(
    () => lines.filter((line): line is ThreadSnapshotLine => line.type === "thread.snapshot"),
    [lines],
  );

  const value = useMemo<NotificationsValue>(
    () => ({
      lines,
      events,
      snapshots,
      unread: events.length,
      target,
      loading,
      error,
      refresh,
      ack,
    }),
    [lines, events, snapshots, target, loading, error, refresh, ack],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used inside NotificationsProvider");
  return value;
}

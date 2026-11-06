/**
 * 成员页的「事件流订阅」（design §5.0）——SSE `author=<acct>` 过滤。
 *
 * 这是**技术订阅**：只接收该成员产生的事件，用于成员页时间线即时更新；
 * 它不产生 follows 边，关注仍是页面上的显式按钮。
 */
import { useEffect, useRef, useState } from "react";
import type { NotificationEventLine } from "@core/types";
import { ReportStream, type SseState } from "@/lib/api";
import { useConnection } from "@/state/connection";

export function useAuthorStream(
  accountId: string | null,
  onEvent: (event: NotificationEventLine) => void,
): SseState {
  const { client, auth } = useConnection();
  const [state, setState] = useState<SseState>("idle");
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!client || !auth || !accountId) {
      setState("idle");
      return;
    }
    const stream = new ReportStream(
      client,
      auth.mode,
      {
        onEvent: (event) => handler.current(event),
        onState: setState,
      },
      { author: accountId },
    );
    stream.start();
    return () => stream.stop();
  }, [client, auth, accountId]);

  return state;
}

/**
 * EventHub React 门面（design §4.5）。
 *
 * - 全局**每标签页一条** EventSource：随 client/ep/account 重建；静态归档不建流。
 * - `useEventHub(topics, handler)`：handler 走 ref，事件到达不触发 render；
 *   页面只消费领域 store，不直接消费裸事件（顺序/去重/水位都在引擎单点）。
 * - `useHubStatus()`：状态指示器（实时/重连中/轮询兜底/未连接）。
 * - `useEventHubView(view)`：把当前活跃视图的 REST seed 水位与 catch-up/reload
 *   交给总线（首连 since、hello 后补拉、reset 强重取）。
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReportClient } from "@/lib/api";
import { EventHub, type EventSourceLike } from "./event-hub";
import {
  hubStatusOff,
  type HubDispatch,
  type HubStatus,
  type HubTopic,
  type HubView,
} from "./types";

interface EventHubContextValue {
  hub: EventHub | null;
  status: HubStatus;
}

const EventHubContext = createContext<EventHubContextValue | null>(null);

export interface EventHubProviderProps {
  client: ReportClient | null;
  authMode: "open" | "auth";
  accountId: string | null;
  /** 静态归档：无 EventSource、无实时指示（design §4.9）。 */
  staticMode: boolean;
  /** 测试注入假 EventSource。 */
  createSource?: (url: string) => EventSourceLike;
  children: ReactNode;
}

export function EventHubProvider({
  client,
  authMode,
  accountId,
  staticMode,
  createSource,
  children,
}: EventHubProviderProps) {
  const [hub, setHub] = useState<EventHub | null>(null);
  const [status, setStatus] = useState<HubStatus>(() => hubStatusOff());

  useEffect(() => {
    if (!client || !accountId || staticMode) {
      setHub(null);
      return;
    }
    const instance = new EventHub({
      accountId,
      createSource,
      openUrl: async (since) => {
        const params = new URLSearchParams();
        params.set("hub", "2");
        if (authMode === "auth") {
          // 一次性 60s 票据：每次（重）连都必须换新，access token 永不进 URL。
          params.set("ticket", await client.streamTicket());
        } else {
          params.set("as", accountId);
        }
        if (since !== null) params.set("since", String(since));
        return `${client.base}/api/stream?${params.toString()}`;
      },
    });
    instance.start();
    setHub(instance);
    return () => {
      instance.stop();
      setHub(null);
    };
  }, [client, authMode, accountId, staticMode, createSource]);

  useEffect(() => {
    if (!hub) {
      setStatus(hubStatusOff());
      return;
    }
    setStatus(hub.getStatus());
    return hub.subscribe("stream.state", (dispatch) => {
      if (dispatch.topic === "stream.state") setStatus(dispatch.status);
    });
  }, [hub]);

  return (
    <EventHubContext.Provider value={{ hub, status }}>{children}</EventHubContext.Provider>
  );
}

function useEventHubContext(): EventHubContextValue | null {
  return useContext(EventHubContext);
}

/** 总线实例（`ack` 水位等非响应式读取用；未挂载时 null）。 */
export function useEventHubApi(): EventHub | null {
  return useEventHubContext()?.hub ?? null;
}

export function useHubStatus(): HubStatus {
  return useEventHubContext()?.status ?? hubStatusOff();
}

/**
 * 订阅主题。handler 存 ref：事件送达不引起 render；订阅只在 hub/主题变化时重建。
 */
export function useEventHub(
  topics: HubTopic | readonly HubTopic[],
  handler: (dispatch: HubDispatch) => void,
): void {
  const hub = useEventHubApi();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = typeof topics === "string" ? topics : topics.join("|");
  useEffect(() => {
    if (!hub) return;
    const list = typeof topics === "string" ? [topics] : topics;
    return hub.subscribe(list, (dispatch) => handlerRef.current(dispatch));
    // `key` 覆盖了主题集合的内容；topics 数组每次渲染重建但内容相同。
  }, [hub, key]);
}

/**
 * 注册活跃视图：`since = min(seed.as_of_seq)`、hello 后落后视图强制补拉、
 * reset 时强重取。view 对象可以每帧新建（内部读 ref），只有有无/总线变化才重注册。
 */
export function useEventHubView(view: HubView | null): void {
  const hub = useEventHubApi();
  const viewRef = useRef<HubView | null>(view);
  viewRef.current = view;
  const enabled = view !== null;
  useEffect(() => {
    if (!hub || !enabled) return;
    return hub.registerView(() => viewRef.current);
  }, [hub, enabled]);
}

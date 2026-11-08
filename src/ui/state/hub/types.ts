/**
 * EventHub 客户端契约（design §2.3 / §4.4 / §4.5）。
 *
 * 这一层**零 React、零 UI 依赖**：`event-hub.ts` 与单元测试共用这里的类型，
 * 页面层只通过 `provider.tsx` 暴露的 hooks 消费。
 */
import type { NotificationEventLine, Role } from "@core/types";
import type { PreviewLink } from "@core/plugins/types";

/**
 * 数据帧：服务端 `event: hub` 的载荷。`post_deleted` 是**读时投影**
 * （`LEFT JOIN posts`），不是落库字段；旧后端/legacy 帧可能没有它。
 */
export interface HubEventLine extends NotificationEventLine {
  /** 该帖已软删；`post_deleted=true` 的帧不计入未读 */
  post_deleted?: boolean;
}

/** 控制帧（无 `id:`）：hello / caught_up / heartbeat / cursor / reset / bye / plugin.updated。 */
export interface HubHelloFrame {
  hub?: number;
  account: string;
  role: Role;
  cursor: number;
  as_of_seq: number;
  /** 服务端采用的 effectiveSince；null = 首连无积压 */
  since: number | null;
  replay_limit?: number;
  heartbeat_ms?: number;
  instance_id?: string;
  auth_mode: "open" | "auth";
}

export interface HubCaughtUpFrame {
  as_of_seq: number;
  replayed?: number;
}

export interface HubHeartbeatFrame {
  as_of_seq: number;
  unread_count: number;
}

export interface HubCursorFrame {
  cursor: number;
  unread_count: number;
}

export interface HubResetFrame {
  as_of_seq: number;
  reason: "replay_limit" | "rollback";
}

export interface HubByeFrame {
  reason: "recycle" | "shutdown" | "auth";
}

/** 插件开关控制帧（PATCH /api/plugins 后广播；无 DB 事件）。 */
export interface HubPluginUpdatedFrame {
  plugin_id: string;
  enabled: boolean;
  version?: string;
}

/**
 * 状态机（design §4.2）。`degraded` 有两个来源：
 * - `catching_up`：服务端声明了空洞（reset/rollback），REST 尚未确认水位；
 * - `reconnect_failed`：连续失败达到阈值（≥5），界面显示「轮询兜底」。
 */
export type HubState = "off" | "connecting" | "live" | "reconnecting" | "degraded";

export type HubDegradedReason = "catching_up" | "reconnect_failed";

export interface HubStatus {
  state: HubState;
  reason: HubDegradedReason | null;
  /** 当前连接的账号（off 时为 null） */
  account: string | null;
  /** 服务端已读游标镜像（hello/cursor 帧/ack 响应来源；不用于压制事件） */
  cursor: number;
  /** 客户端已应用的流位置（`lastSeq`），仅在 caught_up/heartbeat/帧之后推进 */
  asOfSeq: number;
  /** 下次连接发送的 `since`（reset 后前跳） */
  resumeSeq: number | null;
  /** 连续失败次数（hello 清零） */
  attempts: number;
  /** reset 空洞待 REST 确认（此时不假装实时） */
  catchingUp: boolean;
  /** 当前空洞类型（null = 无空洞） */
  catchUpReason: "replay_limit" | "rollback" | null;
  /** degraded 兜底轮询是否在跑（仅 reconnect_failed；catching_up 走 REST 重取不算轮询） */
  degradedPolling: boolean;
  connectedAt: number | null;
  lastFrameAt: number | null;
  heartbeatMs: number;
  /** 最近一次连接请求的 since（诊断用） */
  since: number | null;
}

/** 活跃视图：首连 `since=min(seed.as_of_seq)` 与 hello 后强制 catch-up 的依据。 */
export interface HubView {
  /** 该视图渲染所用的服务端水位（0 = 未知/尚未加载） */
  asOfSeq: number;
  /** 轻量补拉：保留当前列表，只取更新（reconnected / hello 窗口） */
  catchUp: () => void | Promise<void>;
  /** 强重取：清空易变投影后从 REST 重新取（reset 空洞） */
  reload: () => void | Promise<void>;
}

/** 主题（design §4.4 + `stream.heartbeat` 对账通道）。 */
export type HubTopic =
  | "post.created"
  | "post.updated"
  | "post.deleted"
  | "thread.invited"
  | "notification.created"
  | "plugin.updated"
  | "cursor.acked"
  | "stream.reset"
  | "stream.reconnected"
  | "stream.state"
  | "stream.heartbeat"
  | "*";

/** 派发给订阅者的事件（按 topic 判别，便于 switch 收窄）。 */
export type HubDispatch =
  | { topic: "post.created"; event: HubEventLine & { type: "post.created" } }
  | { topic: "post.updated"; event: HubEventLine & { type: "post.updated" } }
  | { topic: "post.deleted"; event: HubEventLine & { type: "post.deleted" } }
  | { topic: "thread.invited"; event: HubEventLine & { type: "thread.invited" } }
  | { topic: "*"; event: HubEventLine }
  | {
      topic: "notification.created";
      event: HubEventLine & { type: "post.created" | "thread.invited" };
    }
  | { topic: "plugin.updated"; pluginId: string; enabled: boolean; version: string | null }
  | { topic: "cursor.acked"; cursor: number; unreadCount: number }
  | {
      topic: "stream.reset";
      asOfSeq: number;
      reason: "replay_limit" | "rollback";
    }
  | { topic: "stream.reconnected"; hello: HubHelloFrame }
  | { topic: "stream.state"; status: HubStatus }
  | { topic: "stream.heartbeat"; asOfSeq: number; unreadCount: number };

export type HubListener = (dispatch: HubDispatch) => void;

/** 数据帧 topic 集合（不含派生/控制主题）。 */
export const HUB_DATA_TOPICS: readonly HubTopic[] = [
  "post.created",
  "post.updated",
  "post.deleted",
  "thread.invited",
];

export function isDataTopic(
  topic: HubTopic,
): topic is "post.created" | "post.updated" | "post.deleted" | "thread.invited" {
  return (
    topic === "post.created" ||
    topic === "post.updated" ||
    topic === "post.deleted" ||
    topic === "thread.invited"
  );
}

/** 数据帧的 `payload` 只带引用字段（design §2.2）。 */
export interface HubEventPayload {
  parent_id?: string | null;
  root_id?: string | null;
  self_thread_id?: string | null;
  quoted_post_id?: string | null;
  reply_to_account_id?: string | null;
  post_id?: string | null;
  snapshot_seq?: number;
  account_id?: string;
  /** post.updated：阶段/状态与最新 previews（≤3，不带正文）。 */
  phase?: string;
  status?: string;
  previews?: PreviewLink[];
}

export function eventPayload(event: HubEventLine): HubEventPayload {
  const payload = event.payload;
  return payload && typeof payload === "object" ? (payload as HubEventPayload) : {};
}

/** `post.created` 是否是根帖（feed 只关心根帖；回复进线程页）。 */
export function isRootCreated(event: HubEventLine): boolean {
  if (event.type !== "post.created") return false;
  const payload = eventPayload(event);
  return (payload.parent_id ?? null) === null;
}

export function hubStatusOff(): HubStatus {
  return {
    state: "off",
    reason: null,
    account: null,
    cursor: 0,
    asOfSeq: 0,
    resumeSeq: null,
    attempts: 0,
    catchingUp: false,
    catchUpReason: null,
    degradedPolling: false,
    connectedAt: null,
    lastFrameAt: null,
    heartbeatMs: 15_000,
    since: null,
  };
}

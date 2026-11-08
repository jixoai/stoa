/** Domain types (runtime-agnostic). Mirrors design.md §5. */
import type { PreviewLink } from "./plugins/types.ts";

export type Role = "owner" | "manager" | "agent";

/** disabled: 0 = active, 1 = disabled (reserved), 2 = tombstone (rm). */
export type DisabledFlag = 0 | 1 | 2;

export interface Account {
  id: string;
  role: Role;
  display: string;
  profile: string;
  avatar: string;
  created_at: number;
  disabled: DisabledFlag;
  token_hash: string | null;
  token_rotated_at: number | null;
}

export interface Post {
  id: string;
  author: string;
  body_md: string;
  parent_id: string | null;
  root_id: string;
  self_thread_id: string;
  self_thread_is_leaf: number;
  reply_to_account_id: string | null;
  quoted_post_id: string | null;
  /** semantic labels (design §5.0); DB stores this as a JSON array string */
  tags: string[];
  created_at: number;
  seq: number;
  batch_id: string;
  deleted_at: number | null;
}

export interface PostMedia {
  post_id: string;
  hash: string;
  position: number;
}

export interface MediaRow {
  hash: string;
  ext: string;
  bytes: number;
  created_at: number;
  ref_count: number;
  /** 固有像素宽高（上传时从文件头解析；历史数据授权后回填，未知为 null）。 */
  w: number | null;
  h: number | null;
}

export interface Participant {
  root_id: string;
  account_id: string;
  source: "author" | "mention" | "reply" | "quote";
  added_at: number;
}

export interface Mention {
  post_id: string;
  account_id: string;
  created_at: number;
}

/**
 * Event kinds stored in the `events` table. `post.deleted` is a system event:
 * it is pushed by the event hub but never delivered as a notification.
 * `post.updated` 是预览字段的多阶段更新事件（不进通知/未读/CLI）。
 */
export type EventType = "post.created" | "post.deleted" | "thread.invited" | "post.updated";

/**
 * 进入通知列表的事件类型（单一信源）：REST peek、CLI wait-notifications、
 * history、未读计数都只读这些类型；event-hub 的 `post.deleted` 等系统事件
 * 可以存库并推送，但通知读路径 SHALL NOT 返回它们。
 */
export const NOTIFICATION_TYPES: readonly EventType[] = ["post.created", "thread.invited"];

export interface ReportEvent {
  seq: number;
  type: EventType;
  actor: string;
  post_id: string | null;
  root_id: string | null;
  batch_id: string;
  created_at: number;
  payload_json: string;
}

export type BatchStatus = "open" | "committed" | "discarded";

export interface Batch {
  id: string;
  author: string;
  started_at: number;
  committed_at: number | null;
  status: BatchStatus;
}

export type DraftStatus = "open" | "committed" | "discarded";

export interface Draft {
  id: string;
  author: string;
  created_at: number;
  updated_at: number;
  items_json: string;
  status: DraftStatus;
}

/** One write op inside a batch (JSONL line for `post --batch`). */
export interface PostOp {
  op: "post";
  body: string;
  quote?: string | null;
  /** content-addressed media hashes already uploaded via /api/media */
  media?: string[];
  /** in-batch reference name; later ops address it as "$ref:<name>" */
  ref?: string | null;
  /** semantic labels (`result` / `discussion` / `note` / custom), defaults to [] */
  tags?: string[];
}

export interface ReplyOp {
  op: "reply";
  /** post id, or "$prev" | "$root" | "$ref:<name>" resolved inside the same batch */
  parent: string;
  body: string;
  media?: string[];
  tags?: string[];
}

export type WriteOp = PostOp | ReplyOp;

export interface QuotedView {
  id: string;
  author: string;
  display: string;
  body_md: string;
  created_at: number;
  media: MediaRef[];
  /** second-level quote is a link only (no body) */
  quoted_post_id: string | null;
}

export interface MediaRef {
  hash: string;
  ext: string;
  bytes: number;
  url: string;
  /** 前端按 w/h 预留占位，避免媒体加载后卡片增高（未知为 null/缺省）。 */
  w?: number | null;
  h?: number | null;
}

export interface AuthorView {
  id: string;
  display: string;
  profile: string;
  avatar: string;
  role: Role;
  disabled: DisabledFlag;
}

export interface PostView extends Post {
  author_account: AuthorView | null;
  media: MediaRef[];
  reply_count: number;
  quoted: QuotedView | null;
  quoted_visible: boolean;
  /** 持久化预览字段（0..3，第一条为主卡）；无链接帖为 []。 */
  previews: PreviewLink[];
  /**
   * 该账号是否已读该帖（`post_reads` 命中 **或** `seq ≤ 账号游标`）。
   * 服务端读接口总是返回该字段；旧静态快照/旧客户端缺省按 `read=false` 处理。
   */
  read?: boolean;
  /** 逐帖已读时间；仅 `post_reads` 行有值，仅被游标覆盖时为 null。 */
  read_at?: number | null;
}

export interface ThreadNode extends PostView {
  depth: number;
  is_spine: boolean;
  is_self_continuation: boolean;
  child_count: number;
  /** only present when the whole spine is complete (no gaps) */
  i?: number;
  n?: number;
}

export interface CollapsedGroup {
  parent_id: string;
  depth: number;
  count: number;
}

export interface ThreadView {
  root_id: string;
  focal_id: string | null;
  spine_complete: boolean;
  posts: ThreadNode[];
  collapsed: CollapsedGroup[];
  participants: string[];
  as_of_seq: number;
}

export interface TimelinePage {
  posts: PostView[];
  has_more: boolean;
  next_cursor: string | null;
  order: "asc" | "desc";
  as_of_seq: number;
}

/** Home tabs (design §5.0): recommended = result + @owner roots, following = follows feed. */
export type FeedTab = "following" | "recommended";

export interface FeedPage extends TimelinePage {
  tab: FeedTab;
}

/** Directed follow edge; only powers the home "following" tab, never visibility. */
export interface Follow {
  follower_id: string;
  followee_id: string;
  created_at: number;
}

export interface AccountProfile extends AuthorView {
  created_at: number;
  /** whether the requesting viewer follows this account */
  following: boolean;
  follower_count: number;
  following_count: number;
}

export interface ProfilePage {
  account: AccountProfile;
  posts: PostView[];
  has_more: boolean;
  next_cursor: string | null;
  order: "asc" | "desc";
  as_of_seq: number;
}

/**
 * Trending tag row (report-ux-r2 §5). Aggregated over the viewer's visible,
 * non-deleted root posts; `last_used_at` is the tag's most recent use and
 * `score = count × exp(-age_days / 7)`.
 */
export interface TrendingTag {
  tag: string;
  count: number;
  last_used_at: number;
  score: number;
}

/** Suggested member row (report-ux-r2 §5): self excluded, followers desc. */
export interface SuggestedAccount {
  id: string;
  display: string;
  profile: string;
  avatar: string;
  role: Role;
  followers: number;
  last_post_at: number | null;
  following: boolean;
}

export interface NotificationEventLine {
  seq: number;
  type: EventType;
  actor: string;
  post_id: string | null;
  root_id: string | null;
  batch_id: string;
  created_at: number;
  payload: unknown;
}

export interface ThreadSnapshotLine {
  type: "thread.snapshot";
  of_seq: number;
  root_id: string;
  thread: ThreadView;
}

export type NotificationLine = NotificationEventLine | ThreadSnapshotLine;

/**
 * An event line plus the read-time `post_deleted` projection. Used by the event
 * hub (and by `notificationLines`, which delegates to `eventLines`). The flag is
 * computed with `LEFT JOIN posts`, never stored.
 */
export interface EventLine extends NotificationEventLine {
  /** the referenced post is soft-deleted (deleted events never count as unread) */
  post_deleted: boolean;
}

/** Result of `store.eventLines`: a bounded, visibility-filtered event slice. */
export interface EventLinesPage {
  lines: EventLine[];
  /** global `MAX(events.seq)` at snapshot time — the replay ceiling */
  as_of_seq: number;
  /** the visible slice exceeded `limit`; callers must reset, never silently gap */
  truncated: boolean;
}

export interface NotificationSnapshot {
  events: NotificationEventLine[];
  /** max seq among delivered events (null when nothing to deliver) */
  target: number | null;
  cursor: number;
  role: Role;
}

/** 历史列表的一行：事件 + 服务端已读标记（`post_reads` 命中或 seq ≤ cursor）。 */
export interface NotificationHistoryLine extends NotificationEventLine {
  read: boolean;
}

export interface NotificationHistoryPage {
  events: NotificationHistoryLine[];
  /** 该账号当前游标（read 标记的判定基准） */
  cursor: number;
  has_more: boolean;
  /** 下一页 `before`（把本页最旧一条的 seq 传回去），没有更多时为 null */
  next_before: number | null;
}

export interface WhoEntry extends AuthorView {
  online: boolean;
  last_seen: number | null;
}

export interface AccountTokenFile {
  accountId: string;
  path: string;
}

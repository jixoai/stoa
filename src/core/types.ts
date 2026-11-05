/** Domain types (runtime-agnostic). Mirrors design.md §5. */

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

export type EventType = "post.created" | "thread.invited";

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
}

export interface ReplyOp {
  op: "reply";
  /** post id, or "$prev" | "$root" | "$ref:<name>" resolved inside the same batch */
  parent: string;
  body: string;
  media?: string[];
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

export interface NotificationSnapshot {
  events: NotificationEventLine[];
  /** max seq among delivered events (null when nothing to deliver) */
  target: number | null;
  cursor: number;
  role: Role;
}

export interface WhoEntry extends AuthorView {
  online: boolean;
  last_seen: number | null;
}

export interface AccountTokenFile {
  accountId: string;
  path: string;
}

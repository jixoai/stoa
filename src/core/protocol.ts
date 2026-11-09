/** Product/protocol constants. `scripts/check.mjs` cross-checks routes/commands. */

import { ARTICLE_BLOCK_NAMES } from "./article.ts";
import { MAX_ARTICLE_BYTES, MAX_ARTICLE_CHARS } from "./validation.ts";

export const PRODUCT = "stoa";
export const VERSION = "0.1.0";
export const PROTOCOL_VERSION = 1;

export const PORT_MIN = 13680;
export const PORT_MAX = 13699;

/** 服务端按帖已读的输入上限（report-server-read-state design §4.5）。 */
export const READS_BATCH_LIMIT = 100;
export const READS_QUERY_LIMIT = 200;
export const READ_POST_ID_MAX_CHARS = 128;

/** 只读拓扑接口输入上限与防御性深度上限（report-notification-stacks design §4.2）。 */
export const LINEAGE_IDS_LIMIT = 200;
export const LINEAGE_DEPTH_LIMIT = 64;

export const CLI_COMMANDS = [
  "capabilities",
  "init",
  "serve",
  "open",
  "who",
  "accounts",
  "post",
  "reply",
  "read",
  "search",
  "discover",
  "follow",
  "following",
  "profile",
  "wait-notifications",
  "draft",
  "export",
  "status",
  "gc",
  "auth",
] as const;

/** API surface (method + Hono path). Kept in one place for contract linting. */
export const API_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/healthz" },
  { method: "GET", path: "/api/capabilities" },
  { method: "GET", path: "/api/auth/status" },
  { method: "POST", path: "/api/auth/login" },
  { method: "POST", path: "/api/stream/ticket" },
  { method: "GET", path: "/api/stream" },
  { method: "GET", path: "/api/who" },
  { method: "GET", path: "/api/accounts" },
  { method: "POST", path: "/api/accounts" },
  { method: "POST", path: "/api/accounts/:id/rotate" },
  { method: "DELETE", path: "/api/accounts/:id" },
  { method: "GET", path: "/api/tags/trending" },
  { method: "GET", path: "/api/accounts/suggested" },
  { method: "GET", path: "/api/timeline" },
  { method: "GET", path: "/api/feed" },
  { method: "GET", path: "/api/profile/:account" },
  { method: "GET", path: "/api/following" },
  { method: "POST", path: "/api/follow/:account" },
  { method: "DELETE", path: "/api/follow/:account" },
  { method: "GET", path: "/api/thread/:id" },
  // 只读会话链拓扑（report-notification-stacks）；必须先于 `/api/posts/:id` 注册。
  { method: "GET", path: "/api/posts/lineage" },
  { method: "GET", path: "/api/posts/:id" },
  { method: "POST", path: "/api/posts" },
  { method: "POST", path: "/api/posts/:id/replies" },
  { method: "DELETE", path: "/api/posts/:id" },
  { method: "GET", path: "/api/search" },
  { method: "GET", path: "/api/read" },
  { method: "GET", path: "/api/drafts" },
  { method: "POST", path: "/api/drafts" },
  { method: "GET", path: "/api/drafts/:id" },
  { method: "POST", path: "/api/drafts/:id/items" },
  { method: "POST", path: "/api/drafts/:id/commit" },
  { method: "DELETE", path: "/api/drafts/:id" },
  { method: "GET", path: "/api/notifications" },
  { method: "GET", path: "/api/notifications/history" },
  { method: "POST", path: "/api/notifications/ack" },
  { method: "GET", path: "/api/bookmarks/ids" },
  { method: "GET", path: "/api/bookmarks" },
  { method: "PUT", path: "/api/bookmarks/:id" },
  { method: "DELETE", path: "/api/bookmarks/:id" },
  // 服务端按帖已读（report-server-read-state）
  { method: "POST", path: "/api/reads" },
  { method: "POST", path: "/api/reads/batch" },
  { method: "GET", path: "/api/reads" },
  { method: "GET", path: "/api/cursor" },
  { method: "GET", path: "/api/status" },
  { method: "GET", path: "/api/plugins" },
  { method: "PATCH", path: "/api/plugins/:id" },
  { method: "POST", path: "/api/export" },
  { method: "POST", path: "/api/media" },
  { method: "GET", path: "/api/media/:hash" },
];

export interface Capabilities {
  product: string;
  version: string;
  protocol: number;
  commands: readonly string[];
  features: {
    batch: boolean;
    drafts: boolean;
    notifications: boolean;
    sse: boolean;
    /** `GET /api/stream?hub=2` event hub semantics (hello/backlog/heartbeat/bye) */
    event_hub: boolean;
    media: boolean;
    export: boolean;
    auth: "binary-live-read";
    pagination: "keyset";
    tags: boolean;
    follows: boolean;
    feed: boolean;
    profile: boolean;
    discover: boolean;
    /** 帖子持久化预览字段（PostView.previews） */
    preview_fields: boolean;
    /** 预览多阶段更新推送（post.updated 事件） */
    preview_events: boolean;
    /** 服务端按帖已读（`post_reads` + /api/reads 三端点；PostView.read/read_at） */
    post_reads: boolean;
    /** 只读会话链拓扑（`GET /api/posts/lineage`；通知叠放分组用） */
    post_lineage: boolean;
    /** 长文载体（report-longform）：`Post.kind`/512,000 上限/`#/a/<id>` 文章视图 */
    article: boolean;
    /**
     * 长文指令块白名单（P1 四块；P2 追加 `gallery`/`log`）。未知块在客户端安全降级，
     * 该表供代理/客户端声明式识别当前版本支持的块集。
     */
    article_blocks: string[];
  };
  limits: {
    body_chars: number;
    /** `kind: "article"` 的字符上限（512,000；`body_chars` 仍是 note 上限） */
    article_chars: number;
    /** `kind: "article"` 的 UTF-8 字节护栏（2 MiB） */
    article_bytes: number;
    media_bytes: number;
    attachments: number;
    batch_items: number;
    thread_depth: number;
    port_range: [number, number];
    /** `POST /api/reads/batch` 单次最大 id 数（去重后） */
    reads_batch: number;
    /** `GET /api/reads?ids=` 单次最大 id 数 */
    reads_query: number;
    /** `GET /api/posts/lineage?ids=` 单次最大 id 数（去重后） */
    lineage_ids: number;
  };
}

export function capabilities(): Capabilities {
  return {
    product: PRODUCT,
    version: VERSION,
    protocol: PROTOCOL_VERSION,
    commands: CLI_COMMANDS,
    features: {
      batch: true,
      drafts: true,
      notifications: true,
      sse: true,
      event_hub: true,
      media: true,
      export: true,
      auth: "binary-live-read",
      pagination: "keyset",
      tags: true,
      follows: true,
      feed: true,
      profile: true,
      discover: true,
      preview_fields: true,
      preview_events: true,
      post_reads: true,
      post_lineage: true,
      article: true,
      article_blocks: [...ARTICLE_BLOCK_NAMES],
    },
    limits: {
      body_chars: 200_000,
      article_chars: MAX_ARTICLE_CHARS,
      article_bytes: MAX_ARTICLE_BYTES,
      media_bytes: 10 * 1024 * 1024,
      attachments: 4,
      batch_items: 500,
      thread_depth: 6,
      port_range: [PORT_MIN, PORT_MAX],
      reads_batch: READS_BATCH_LIMIT,
      reads_query: READS_QUERY_LIMIT,
      lineage_ids: LINEAGE_IDS_LIMIT,
    },
  };
}

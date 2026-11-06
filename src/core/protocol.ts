/** Product/protocol constants. `scripts/check.mjs` cross-checks routes/commands. */

export const PRODUCT = "fde2e-report-worker";
export const VERSION = "0.1.0";
export const PROTOCOL_VERSION = 1;

export const PORT_MIN = 13680;
export const PORT_MAX = 13699;

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
  { method: "POST", path: "/api/notifications/ack" },
  { method: "GET", path: "/api/cursor" },
  { method: "GET", path: "/api/status" },
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
    media: boolean;
    export: boolean;
    auth: "binary-live-read";
    pagination: "keyset";
    tags: boolean;
    follows: boolean;
    feed: boolean;
    profile: boolean;
    discover: boolean;
  };
  limits: {
    body_chars: number;
    media_bytes: number;
    attachments: number;
    batch_items: number;
    thread_depth: number;
    port_range: [number, number];
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
      media: true,
      export: true,
      auth: "binary-live-read",
      pagination: "keyset",
      tags: true,
      follows: true,
      feed: true,
      profile: true,
      discover: true,
    },
    limits: {
      body_chars: 200_000,
      media_bytes: 10 * 1024 * 1024,
      attachments: 4,
      batch_items: 500,
      thread_depth: 6,
      port_range: [PORT_MIN, PORT_MAX],
    },
  };
}

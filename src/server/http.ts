import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { errorMessage, fail, ReportError } from "../core/errors.ts";
import { capabilities } from "../core/protocol.ts";
import { parseLimit, parseTime } from "../core/pagination.ts";
import { validateWriteOp, assertBody, MAX_MEDIA_BYTES, MEDIA_TYPES, ALLOWED_EXTS, EXT_CONTENT_TYPE } from "../core/validation.ts";
import type { Account, NotificationLine, Role, WriteOp } from "../core/types.ts";
import { newUlid } from "../core/ids.ts";
import type { AuthManager } from "./auth.ts";
import type { Presence } from "./presence.ts";
import type { Store } from "./store.ts";
import type { IdleLease } from "./lease.ts";
import { Hub } from "./hub.ts";
import { runExport } from "./export.ts";
import type { PreviewService } from "./preview/service.ts";
import { builtinPlugin, LINK_PREVIEW } from "../core/plugins/builtin.ts";
import type { PluginDependencyView, PluginView } from "../core/plugins/types.ts";
import { previewPluginVersion, previewRulesVersion, PREVIEW_LIMITS } from "./preview/link-preview/provider.ts";
import { join, resolve } from "node:path";

export interface AppDeps {
  store: Store;
  auth: AuthManager;
  presence: Presence;
  dataDir: string;
  instanceId: string;
  startedAt: number;
  openExposed: boolean;
  port: number | null;
  /** built static UI (same-origin); served when present */
  uiDir?: string | null;
  /** idle lease (design §1); absent in unit-test apps and when disabled */
  lease?: IdleLease | null;
  /** shared event hub; created on demand when the caller does not inject one */
  hub?: Hub;
  /** preview plugin service (worker/scan); absent in unit-test apps */
  previews?: PreviewService | null;
}

/**
 * CORS headers for a given origin. Raw `Response` objects bypass Hono middleware,
 * so every handler that builds its own response must apply this too.
 */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-report-account",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

const ALLOWED_ORIGINS = new Set([
  "https://report.worker.fde2e.com",
  "https://alpha-report.fde2e.com",
]);
const LOCAL_HOST_RE = /^https:\/\/local-[a-z0-9-]+\.fde2e\.com$/;
const LOCALHOST_RE = /^http:\/\/localhost(:\d+)?$/;
const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (LOCAL_HOST_RE.test(origin)) return true;
  if (LOCALHOST_RE.test(origin)) return true;
  if (LOOPBACK_RE.test(origin)) return true;
  return false;
}

function identity(c: Context, deps: AppDeps): Account {
  const found = deps.auth.resolve({
    header: (name) => c.req.header(name),
    query: (name) => c.req.query(name),
  });
  if (!found) {
    fail(
      "UNAUTHORIZED",
      deps.auth.current().mode === "open"
        ? "unknown account (open mode: declare X-Report-Account or ?as=)"
        : "authentication required (Authorization: Bearer <account-token|access-token>)",
    );
  }
  return found.account;
}

function requireGlobal(account: Account): void {
  if (account.role !== "owner" && account.role !== "manager") {
    fail("FORBIDDEN", "owner/manager only");
  }
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    fail("BAD_REQUEST", "invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    fail("BAD_REQUEST", "JSON body must be an object");
  }
  return body as Record<string, unknown>;
}

function optionalInt(c: Context, name: string): number | null {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) fail("BAD_REQUEST", `${name} must be a non-negative integer`);
  return n;
}

/** Strict seq parser for SSE resume params; invalid values are treated as absent. */
function parseSeqParam(raw: string | undefined | null): number | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** `effectiveSince = max(since, after, Last-Event-ID)`; null when none is valid. */
function parseEffectiveSince(
  candidates: Array<string | undefined | null>,
): number | null {
  let max: number | null = null;
  for (const raw of candidates) {
    const value = parseSeqParam(raw);
    if (value !== null && (max === null || value > max)) max = value;
  }
  return max;
}

function viewer(account: Account): { id: string; role: Role } {
  return { id: account.id, role: account.role };
}

/**
 * Legacy `report` frames predate the hub's read-time projection: strip
 * `post_deleted` so old shells receive exactly the historical field set.
 */
function legacyReportLine(line: NotificationLine): NotificationLine {
  if ("post_deleted" in line) {
    const { post_deleted: _postDeleted, ...rest } = line as NotificationLine & {
      post_deleted: boolean;
    };
    return rest as NotificationLine;
  }
  return line;
}

function publicAccount(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    role: account.role,
    display: account.display,
    profile: account.profile,
    avatar: account.avatar,
    created_at: account.created_at,
    disabled: account.disabled,
    token_rotated_at: account.token_rotated_at,
    env_file: `accounts/${account.id}.env`,
  };
}

/** unit-test apps without a PreviewService 也返回同一 PluginView 形状。 */
function fallbackPluginView(store: Store): PluginView {
  const requires: PluginDependencyView[] = (LINK_PREVIEW.requires ?? []).map((dep) => {
    const builtin = builtinPlugin(dep.id);
    return {
      ...dep,
      status: builtin ? (store.pluginEnabled(dep.id) ? "enabled" : "disabled") : "missing",
    };
  });
  const viewerBase = process.env.FDE2E_FILEVIEWER_BASE?.trim();
  return {
    id: LINK_PREVIEW.id,
    name: LINK_PREVIEW.name,
    description: LINK_PREVIEW.description,
    version: previewPluginVersion(),
    rules_version: previewRulesVersion(),
    kind: LINK_PREVIEW.kind,
    capabilities: LINK_PREVIEW.capabilities,
    enabled: store.pluginEnabled(LINK_PREVIEW.id),
    default_enabled: LINK_PREVIEW.defaultEnabled,
    requires,
    viewer_base: viewerBase && viewerBase ? viewerBase : null,
    limits: { ...PREVIEW_LIMITS },
  };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const hub =
    deps.hub ??
    new Hub({
      store: deps.store,
      presence: deps.presence,
      instanceId: deps.instanceId,
      lease: deps.lease ?? null,
    });

  app.use("*", async (c, next) => {
    const headers = corsHeaders(c.req.header("origin"));
    for (const [k, v] of Object.entries(headers)) c.header(k, v);
    c.header("Vary", "Origin", { append: true });
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    // Every request is activity; while one is in flight the lease cannot expire.
    const releaseLease = deps.lease?.hold() ?? null;
    try {
      await next();
    } finally {
      releaseLease?.();
    }
  });

  app.onError((err, c) => {
    if (err instanceof ReportError) {
      return c.json(
        { ok: false, error: err.message, code: err.code },
        err.status as ContentfulStatusCode,
      );
    }
    console.error(`[report] internal error: ${errorMessage(err)}`);
    return c.json({ ok: false, error: "internal error", code: "INTERNAL" }, 500);
  });

  app.notFound((c) => c.json({ ok: false, error: "not found", code: "NOT_FOUND" }, 404));

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      dataDir: deps.dataDir,
      instanceId: deps.instanceId,
      startedAt: deps.startedAt,
      pid: process.pid,
      port: deps.port,
      protocol: capabilities().protocol,
      version: capabilities().version,
      lease: deps.lease?.snapshot() ?? null,
      hub: hub.snapshot(),
      ...(deps.previews ? { preview_policy: deps.previews.policySnapshot() } : {}),
    }),
  );

  app.get("/api/capabilities", (c) => c.json({ ok: true, ...capabilities() }));

  app.get("/api/auth/status", (c) => c.json({ ok: true, ...deps.auth.status(deps.openExposed) }));

  app.post("/api/auth/login", async (c) => {
    const body = await readJson(c);
    const secret = typeof body.secret === "string" ? body.secret : "";
    if (!secret) fail("BAD_REQUEST", "secret is required");
    const mode = deps.auth.current().mode;
    if (mode === "open") fail("BAD_REQUEST", "authentication is disabled (FDE2E_REPORT_AUTH is empty)");
    if (!deps.auth.verifyLogin(secret)) fail("UNAUTHORIZED", "wrong secret");
    const issued = deps.auth.issueAccessToken("owner");
    return c.json({ ok: true, token: issued.token, exp: issued.exp, sub: "owner" });
  });

  app.post("/api/stream/ticket", async (c) => {
    const account = identity(c, deps);
    const ticket = deps.auth.issueTicket(account.id);
    return c.json({ ok: true, ticket: ticket.ticket, expires_at: ticket.expiresAt, ttl_ms: 60_000 });
  });

  // ── SSE (ticket-only in auth mode; 204 on failure so EventSource stops) ──────
  app.get("/api/stream", async (c) => {
    const mode = deps.auth.current().mode;
    let account: Account | null = null;
    if (mode === "auth") {
      account = deps.auth.consumeTicket(c.req.query("ticket") ?? "");
      if (!account) {
        c.header("Cache-Control", "no-store");
        return c.body(null, 204);
      }
    } else {
      const declared = c.req.query("as") ?? c.req.header("x-report-account") ?? "owner";
      const found = deps.store.getAccount(declared);
      if (!found || found.disabled !== 0) {
        c.header("Cache-Control", "no-store");
        return c.body(null, 204);
      }
      account = found;
    }
    const who = account;

    // ── hub=2 (event hub, design §3.4): explicit opt-in; legacy path untouched ──
    if (c.req.query("hub") === "2") {
      // `since` is the documented resume param; `after` is accepted as an alias
      // for probe/back-compat parity with the pagination vocabulary.
      const effectiveSince = parseEffectiveSince([
        c.req.query("since"),
        c.req.query("after"),
        c.req.header("last-event-id"),
      ]);
      if (!hub.admit(who.id)) {
        // Any non-200 makes EventSource fail permanently; the client state
        // machine owns reconnect + ticket rotation (design §3.5).
        c.header("Retry-After", "5");
        c.header("Cache-Control", "no-store");
        return c.body(null, 503);
      }
      c.header("X-Accel-Buffering", "no");
      c.header("Cache-Control", "no-cache, no-transform");
      c.header("Connection", "keep-alive");
      const sseResponse = await streamSSE(c, async (stream) => {
        await hub.serve({
          account: who,
          stream,
          authMode: mode,
          since: effectiveSince,
          signal: c.req.raw.signal,
        });
      });
      const headers = new Headers(sseResponse.headers);
      headers.set("cache-control", "no-cache, no-transform");
      headers.set("x-accel-buffering", "no");
      return new Response(sseResponse.body, {
        status: sseResponse.status,
        statusText: sseResponse.statusText,
        headers,
      });
    }

    hub.noteLegacyConnect();
    // ── legacy stream (no `hub` param): wire format stays byte-for-byte ───────
    // Optional event-stream filter (member-page live subscription): only events
    // produced by this author are pushed. This is a technical subscription
    // filter, not a follow edge — `follows` never participates here.
    const authorFilter = (c.req.query("author") ?? "").trim() || null;
    const signal = c.req.raw.signal;
    const release = deps.presence.connect(who.id);
    // An open event stream is a subscription: it keeps the instance alive.
    const releaseLease = deps.lease?.hold();
    // Idempotent: Hono swallows write errors, so abort/signal is the only
    // reliable recycle signal (same rule as the hub). Kept byte-identical:
    // no extra frames, only presence/lease release + loop exit.
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      releaseLease?.();
      release();
    };
    c.header("X-Accel-Buffering", "no");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("Connection", "keep-alive");
    try {
      const sseResponse = await streamSSE(c, async (stream) => {
        let lastSeq = deps.store.getCursor(who.id);
        stream.onAbort(cleanup);
        const onSignalAbort = (): void => cleanup();
        signal.addEventListener("abort", onSignalAbort);
        try {
          await stream.writeSSE({
            event: "hello",
            data: JSON.stringify({
              account: who.id,
              cursor: lastSeq,
              as_of_seq: deps.store.maxEventSeq(),
              auth_mode: mode,
              author: authorFilter,
            }),
          });
          for (;;) {
            if (stream.aborted || signal.aborted) return;
            const changed = await deps.store.waitForChange(15_000, signal);
            if (stream.aborted || signal.aborted) return;
            deps.presence.touch(who.id);
            if (changed) {
              // Visibility is already applied inside notificationLines; the author
              // filter is a single actor match on top of it. `lastSeq` keeps
              // advancing over *all* visible events (the account-global coordinate),
              // so a filtered stream never re-delivers or skips cursor positions.
              const snapshot = deps.store.notificationLines(who.id, lastSeq, { includeSelf: true });
              for (const line of snapshot.lines) {
                if ("type" in line && line.type === "thread.snapshot") continue;
                const seq = (line as { seq?: number }).seq;
                if (typeof seq === "number" && seq > lastSeq) lastSeq = seq;
                if (authorFilter && (line as { actor?: string }).actor !== authorFilter) continue;
                await stream.writeSSE({
                  event: "report",
                  data: JSON.stringify(legacyReportLine(line)),
                });
              }
            } else {
              await stream.write(": ping\n\n");
            }
          }
        } finally {
          signal.removeEventListener("abort", onSignalAbort);
          cleanup();
        }
      });
      const headers = new Headers(sseResponse.headers);
      headers.set("cache-control", "no-cache, no-transform");
      headers.set("x-accel-buffering", "no");
      return new Response(sseResponse.body, {
        status: sseResponse.status,
        statusText: sseResponse.statusText,
        headers,
      });
    } catch {
      cleanup();
      throw new ReportError("INTERNAL", "stream failed");
    }
  });

  // ── who / accounts ──────────────────────────────────────────────────────────
  app.get("/api/who", (c) => {
    const me = identity(c, deps);
    void me;
    const accounts = deps.store.listAccounts(false).map((account) => ({
      id: account.id,
      role: account.role,
      display: account.display,
      profile: account.profile,
      avatar: account.avatar,
      disabled: account.disabled,
      online:
        account.role === "owner" || account.role === "manager"
          ? true
          : deps.presence.isOnline(account.id),
      last_seen: deps.presence.lastSeenOf(account.id),
    }));
    return c.json({ ok: true, accounts, presence_ttl_ms: 90_000 });
  });

  app.get("/api/accounts", (c) => {
    identity(c, deps);
    return c.json({ ok: true, accounts: deps.store.listAccounts(false).map(publicAccount) });
  });

  app.post("/api/accounts", async (c) => {
    const me = identity(c, deps);
    requireGlobal(me);
    const body = await readJson(c);
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) fail("BAD_REQUEST", "id is required");
    const created = deps.store.createAccount({
      id,
      display: typeof body.display === "string" ? body.display : undefined,
      profile: typeof body.profile === "string" ? body.profile : undefined,
    });
    return c.json(
      {
        ok: true,
        account: publicAccount(created.account),
        env_file: created.envPath,
        note: "hand this 0600 file to that account only; the token is never returned over HTTP",
      },
      201,
    );
  });

  app.post("/api/accounts/:id/rotate", (c) => {
    const me = identity(c, deps);
    requireGlobal(me);
    const rotated = deps.store.rotateAccount(c.req.param("id"));
    return c.json({
      ok: true,
      account: publicAccount(rotated.account),
      env_file: rotated.envPath,
    });
  });

  app.delete("/api/accounts/:id", (c) => {
    const me = identity(c, deps);
    requireGlobal(me);
    deps.store.removeAccount(c.req.param("id"));
    return c.json({ ok: true, removed: c.req.param("id"), tombstone: true });
  });

  // ── discovery (report-ux-r2 §5): trending tags + suggested members ──────────
  // Both paths reuse the caller's visibility slice; an agent only aggregates the
  // conversations it participates in, so no hidden thread's tags or activity leak.
  app.get("/api/tags/trending", (c) => {
    const account = identity(c, deps);
    const tags = deps.store.trendingTags({
      viewer: viewer(account),
      limit: parseLimit(c.req.query("limit"), 12, 50),
    });
    return c.json({ ok: true, tags });
  });

  app.get("/api/accounts/suggested", (c) => {
    const account = identity(c, deps);
    const accounts = deps.store.suggestedAccounts({
      viewer: viewer(account),
      limit: parseLimit(c.req.query("limit"), 6, 50),
    });
    return c.json({ ok: true, accounts });
  });

  // ── posts / timeline / thread / search / read ───────────────────────────────
  app.get("/api/timeline", (c) => {
    const account = identity(c, deps);
    const page = deps.store.timeline({
      viewer: viewer(account),
      limit: parseLimit(c.req.query("limit"), 20, 100),
      before: c.req.query("before") ?? null,
      after: c.req.query("after") ?? null,
      tag: c.req.query("tag") ?? null,
    });
    return c.json({ ok: true, ...page });
  });

  // ── home feed (two independent tabs; design §5.0) ───────────────────────────
  app.get("/api/feed", (c) => {
    const account = identity(c, deps);
    const tabRaw = c.req.query("tab") ?? "recommended";
    if (tabRaw !== "following" && tabRaw !== "recommended") {
      fail("BAD_REQUEST", `tab must be "recommended" or "following" (got "${tabRaw}")`);
    }
    const page = deps.store.feed({
      viewer: viewer(account),
      tab: tabRaw,
      limit: parseLimit(c.req.query("limit"), 20, 100),
      before: c.req.query("before") ?? null,
      after: c.req.query("after") ?? null,
    });
    return c.json({ ok: true, ...page });
  });

  // ── member page: profile card + that member's visible root posts ────────────
  app.get("/api/profile/:account", (c) => {
    const account = identity(c, deps);
    const page = deps.store.profile({
      viewer: viewer(account),
      accountId: c.req.param("account"),
      limit: parseLimit(c.req.query("limit"), 20, 100),
      before: c.req.query("before") ?? null,
      after: c.req.query("after") ?? null,
    });
    if (!page) fail("NOT_FOUND", `account "${c.req.param("account")}" not found`);
    const target = page.account;
    const alwaysOnline = target.role === "owner" || target.role === "manager";
    return c.json({
      ok: true,
      ...page,
      account: {
        ...target,
        online: alwaysOnline || deps.presence.isOnline(target.id),
        last_seen: deps.presence.lastSeenOf(target.id),
      },
    });
  });

  // ── follows (home-tab routing only) ─────────────────────────────────────────
  app.get("/api/following", (c) => {
    const account = identity(c, deps);
    const accounts = deps.store.listFollowing(account.id).map(({ account: followed, followed_at }) => ({
      ...publicAccount(followed),
      followed_at,
      online:
        followed.role === "owner" || followed.role === "manager"
          ? true
          : deps.presence.isOnline(followed.id),
      last_seen: deps.presence.lastSeenOf(followed.id),
    }));
    return c.json({ ok: true, follower: account.id, accounts });
  });

  app.post("/api/follow/:account", (c) => {
    const account = identity(c, deps);
    const target = c.req.param("account");
    const edge = deps.store.follow(account.id, target);
    return c.json(
      {
        ok: true,
        follower: account.id,
        followee: target,
        following: true,
        created_at: edge.created_at,
      },
      201,
    );
  });

  app.delete("/api/follow/:account", (c) => {
    const account = identity(c, deps);
    const target = c.req.param("account");
    const removed = deps.store.unfollow(account.id, target);
    return c.json({ ok: true, follower: account.id, followee: target, following: false, removed });
  });

  // ── bookmarks（收藏；账号私有，列表仍过滤可见性）────────────────────────
  app.get("/api/bookmarks/ids", (c) => {
    const account = identity(c, deps);
    return c.json({ ok: true, ids: deps.store.bookmarkedIds(account.id) });
  });

  app.get("/api/bookmarks", (c) => {
    const account = identity(c, deps);
    const page = deps.store.bookmarks({
      viewer: viewer(account),
      limit: parseLimit(c.req.query("limit"), 20, 100),
      before: c.req.query("before") ?? null,
      after: c.req.query("after") ?? null,
    });
    return c.json({ ok: true, ...page });
  });

  app.put("/api/bookmarks/:id", (c) => {
    const account = identity(c, deps);
    const postId = c.req.param("id");
    const res = deps.store.bookmark(account.id, postId);
    return c.json(
      { ok: true, post_id: postId, account: account.id, bookmarked: true, created: res.created, created_at: res.created_at },
      res.created ? 201 : 200,
    );
  });

  app.delete("/api/bookmarks/:id", (c) => {
    const account = identity(c, deps);
    const postId = c.req.param("id");
    const removed = deps.store.unbookmark(account.id, postId);
    return c.json({ ok: true, post_id: postId, account: account.id, bookmarked: false, removed });
  });

  app.get("/api/thread/:id", (c) => {
    const account = identity(c, deps);
    const thread = deps.store.thread({
      viewer: viewer(account),
      postId: c.req.param("id"),
      focalId: c.req.query("focal") ?? null,
    });
    if (!thread) fail("NOT_FOUND", "thread not found");
    return c.json({ ok: true, thread });
  });

  app.get("/api/posts/:id", (c) => {
    const account = identity(c, deps);
    const post = deps.store.getPostView(c.req.param("id"), viewer(account));
    if (!post) fail("NOT_FOUND", "post not found");
    return c.json({ ok: true, post });
  });

  app.post("/api/posts", async (c) => {
    const account = identity(c, deps);
    const body = await readJson(c);
    const op: WriteOp = {
      op: "post",
      body: assertBody(body.body),
      quote: typeof body.quote === "string" && body.quote ? body.quote : null,
      media: Array.isArray(body.media) ? (body.media as string[]) : [],
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
    };
    const result = deps.store.commitOps({
      author: account.id,
      batchId: newUlid(),
      ops: [op],
    });
    return c.json({ ok: true, ...result }, 201);
  });

  app.post("/api/posts/:id/replies", async (c) => {
    const account = identity(c, deps);
    const body = await readJson(c);
    const op: WriteOp = {
      op: "reply",
      parent: c.req.param("id"),
      body: assertBody(body.body),
      media: Array.isArray(body.media) ? (body.media as string[]) : [],
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
    };
    const result = deps.store.commitOps({
      author: account.id,
      batchId: newUlid(),
      ops: [op],
    });
    return c.json({ ok: true, ...result }, 201);
  });

  app.delete("/api/posts/:id", (c) => {
    const account = identity(c, deps);
    deps.store.softDelete(c.req.param("id"), viewer(account));
    return c.json({ ok: true, deleted: c.req.param("id") });
  });

  app.get("/api/search", (c) => {
    const account = identity(c, deps);
    const q = c.req.query("q") ?? "";
    const limit = parseLimit(c.req.query("limit"), 30, 100);
    const posts = deps.store.search({ viewer: viewer(account), q, limit });
    if (c.req.query("accounts") === "1") {
      const accounts = deps.store.searchAccounts({ q, limit }).map((found) => ({
        id: found.id,
        role: found.role,
        display: found.display,
        profile: found.profile,
        avatar: found.avatar,
        disabled: found.disabled,
        online:
          found.role === "owner" || found.role === "manager"
            ? true
            : deps.presence.isOnline(found.id),
        last_seen: deps.presence.lastSeenOf(found.id),
      }));
      return c.json({ ok: true, posts, query: q, accounts });
    }
    return c.json({ ok: true, posts, query: q });
  });

  app.get("/api/read", (c) => {
    const account = identity(c, deps);
    const threadId = c.req.query("thread");
    if (threadId) {
      const thread = deps.store.thread({
        viewer: viewer(account),
        postId: threadId,
        focalId: c.req.query("focal") ?? null,
      });
      if (!thread) fail("NOT_FOUND", "thread not found");
      return c.json({ ok: true, thread });
    }
    const orderRaw = c.req.query("order");
    const result = deps.store.readPosts({
      viewer: viewer(account),
      author: c.req.query("author") ?? null,
      tag: c.req.query("tag") ?? null,
      since: parseTime(c.req.query("since")),
      until: parseTime(c.req.query("until")),
      limit: parseLimit(c.req.query("limit"), 50, 200),
      order: orderRaw === "asc" || orderRaw === "desc" ? orderRaw : "desc",
      after: c.req.query("after") ?? null,
    });
    return c.json({ ok: true, ...result });
  });

  // ── drafts ──────────────────────────────────────────────────────────────────
  app.get("/api/drafts", (c) => {
    const account = identity(c, deps);
    const drafts = deps.store.listDrafts(account.id).map((draft) => ({
      ...draft,
      items: JSON.parse(draft.items_json) as WriteOp[],
    }));
    return c.json({ ok: true, drafts });
  });

  app.post("/api/drafts", (c) => {
    const account = identity(c, deps);
    const draft = deps.store.createDraft(account.id);
    return c.json({ ok: true, draft: { ...draft, items: [] } }, 201);
  });

  app.get("/api/drafts/:id", (c) => {
    const account = identity(c, deps);
    const draft = deps.store.requireDraft(c.req.param("id"), account.id);
    return c.json({ ok: true, draft: { ...draft, items: JSON.parse(draft.items_json) } });
  });

  app.post("/api/drafts/:id/items", async (c) => {
    const account = identity(c, deps);
    const body = await readJson(c);
    const op = validateWriteOp(body.op);
    const appended = deps.store.appendDraftItem(c.req.param("id"), account.id, op);
    return c.json({ ok: true, draft_id: appended.draft.id, items: appended.items });
  });

  app.post("/api/drafts/:id/commit", (c) => {
    const account = identity(c, deps);
    const result = deps.store.commitDraft(c.req.param("id"), account.id);
    return c.json({ ok: true, ...result });
  });

  app.delete("/api/drafts/:id", (c) => {
    const account = identity(c, deps);
    deps.store.discardDraft(c.req.param("id"), account.id);
    return c.json({ ok: true, discarded: c.req.param("id") });
  });

  // ── notifications (one-shot long poll; cursor advances only on explicit ack) ─
  app.get("/api/notifications", async (c) => {
    const account = identity(c, deps);
    const wait = c.req.query("wait") === "1";
    const peek = c.req.query("peek") === "1";
    const cursorOverride = optionalInt(c, "cursor");
    // `limit` applies to one-shot peeks (default 100 / max 200); the blocking
    // long poll keeps its historical unbounded delivery so a large committed
    // batch is never split across invocations.
    const peekLimit = peek ? parseLimit(c.req.query("limit"), 100, 200) : null;
    const release = deps.presence.connect(account.id);
    // A blocking long poll (wait-notifications) is activity while it blocks.
    const releaseLease = deps.lease?.hold();
    try {
      const deadline = Date.now() + 25_000;
      for (;;) {
        const snapshot = deps.store.notificationLines(account.id, cursorOverride, {
          limit: peekLimit ?? undefined,
        });
        if (snapshot.lines.length > 0 || !wait || peek) {
          return c.json({
            ok: true,
            events: snapshot.lines,
            target: snapshot.target,
            cursor: snapshot.cursor,
            role: snapshot.role,
            // `unread_count` is always the ACCOUNT-wide unread (stored cursor).
            // A `?cursor=` override only replays the list for debug/CLI use; it
            // must not change the badge semantics.
            unread_count: deps.store.unreadCount(account.id),
            unread_by_target: deps.store.unreadByTarget(account.id),
            limit: peekLimit,
            has_more: snapshot.truncated,
          });
        }
        if (Date.now() >= deadline) {
          return c.json({
            ok: true,
            events: [],
            target: null,
            cursor: snapshot.cursor,
            role: snapshot.role,
            unread_count: deps.store.unreadCount(account.id),
            unread_by_target: deps.store.unreadByTarget(account.id),
            limit: peekLimit,
            has_more: false,
          });
        }
        deps.presence.touch(account.id);
        await deps.store.waitForChange(Math.min(1000, Math.max(50, deadline - Date.now())));
      }
    } finally {
      release();
      releaseLease?.();
    }
  });

  // 历史列表（始终可见）：已读/未读一并返回，read 由账号游标判定；纯读，不推进游标。
  app.get("/api/notifications/history", (c) => {
    const account = identity(c, deps);
    const limit = optionalInt(c, "limit");
    const before = optionalInt(c, "before");
    const page = deps.store.notificationHistory(account.id, {
      limit: limit ?? 50,
      before,
    });
    return c.json({
      ok: true,
      events: page.events,
      cursor: page.cursor,
      has_more: page.has_more,
      next_before: page.next_before,
      unread_count: deps.store.unreadCount(account.id, page.cursor),
      unread_by_target: deps.store.unreadByTarget(account.id, page.cursor),
    });
  });

  app.post("/api/notifications/ack", async (c) => {
    const account = identity(c, deps);
    const body = await readJson(c);
    const target = body.target;
    if (typeof target !== "number" || !Number.isInteger(target) || target < 0) {
      fail("BAD_REQUEST", "target must be a non-negative integer seq");
    }
    const cursor = deps.store.advanceCursor(account.id, target);
    const unreadCount = deps.store.unreadCount(account.id, cursor);
    // Multi-tab/multi-device: every live stream of this account learns the new
    // cursor (and the authoritative unread count) within one frame.
    hub.broadcastCursor(account.id, cursor, unreadCount);
    return c.json({ ok: true, cursor, unread_count: unreadCount });
  });

  app.get("/api/cursor", (c) => {
    const account = identity(c, deps);
    return c.json({ ok: true, account: account.id, cursor: deps.store.getCursor(account.id) });
  });

  // ── plugins（report-link-preview P1-12：仅内置 link-preview）─────────────────
  app.get("/api/plugins", (c) => {
    identity(c, deps);
    const plugins = deps.previews ? [deps.previews.pluginView()] : [fallbackPluginView(deps.store)];
    return c.json({ ok: true, plugins });
  });

  app.patch("/api/plugins/:id", async (c) => {
    const me = identity(c, deps);
    requireGlobal(me);
    const id = c.req.param("id");
    if (id !== LINK_PREVIEW.id || !builtinPlugin(id)) {
      fail("NOT_FOUND", `plugin "${id}" not found`);
    }
    const body = await readJson(c);
    if (typeof body.enabled !== "boolean") {
      fail("BAD_REQUEST", "enabled must be a boolean");
    }
    const enabled = body.enabled;
    let plugin: PluginView;
    if (deps.previews) {
      plugin = deps.previews.setEnabled(enabled, me.id);
    } else {
      deps.store.setPluginEnabled(id, enabled, me.id);
      plugin = fallbackPluginView(deps.store);
    }
    // 控制帧（无 DB 事件）：其他标签页立即隐藏/恢复卡片（design §8.2）。
    hub.broadcastControl("plugin.updated", {
      plugin_id: id,
      enabled: plugin.enabled,
      version: plugin.version,
    });
    return c.json({ ok: true, plugin });
  });

  // ── status / export ─────────────────────────────────────────────────────────
  app.get("/api/status", (c) => {
    const account = identity(c, deps);
    const global = account.role === "owner" || account.role === "manager";
    const drafts = global
      ? deps.store.draftSummaries()
      : deps.store.draftSummaries().filter((draft) => draft.author === account.id);
    return c.json({
      ok: true,
      server: {
        instanceId: deps.instanceId,
        pid: process.pid,
        port: deps.port,
        dataDir: deps.dataDir,
        startedAt: deps.startedAt,
        openMode: deps.auth.current().mode === "open",
        openExposed: deps.openExposed,
        lease: deps.lease?.snapshot() ?? null,
      },
      account: { id: account.id, role: account.role },
      auth: deps.auth.status(deps.openExposed),
      counts: deps.store.statusCounts(),
      drafts,
      pending_export: deps.store.pendingExport(),
      hub: hub.snapshot(),
      preview_worker: deps.previews?.stats() ?? null,
    });
  });

  app.post("/api/export", (c) => {
    const account = identity(c, deps);
    requireGlobal(account);
    try {
      const result = runExport({ dataDir: deps.dataDir, viewer: account.id });
      deps.store.setPendingExport(false);
      return c.json({ ok: true, ...result });
    } catch (err) {
      deps.store.setPendingExport(true);
      fail("INTERNAL", `export failed: ${errorMessage(err)}`);
    }
  });

  // ── media ───────────────────────────────────────────────────────────────────
  app.post("/api/media", async (c) => {
    identity(c, deps);
    const length = Number(c.req.header("content-length") ?? "0");
    if (length > MAX_MEDIA_BYTES) {
      fail("PAYLOAD_TOO_LARGE", `media exceeds ${MAX_MEDIA_BYTES} bytes`);
    }
    const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    let ext = MEDIA_TYPES[contentType] ?? null;
    const filename = c.req.header("x-filename");
    if (filename) {
      const candidate = filename.split(".").pop()?.toLowerCase() ?? "";
      if (ALLOWED_EXTS.has(candidate)) ext = candidate === "jpeg" ? "jpg" : candidate;
    }
    if (!ext) {
      fail(
        "UNSUPPORTED_MEDIA_TYPE",
        `unsupported media type "${contentType || "(none)"}" (allowed: ${Object.keys(MEDIA_TYPES).join(", ")})`,
      );
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const media = deps.store.saveMedia(bytes, ext);
    return c.json(
      {
        ok: true,
        hash: media.hash,
        ext: media.ext,
        bytes: media.bytes,
        url: `/api/media/${media.hash}`,
        ...(media.w && media.h ? { w: media.w, h: media.h } : {}),
      },
      201,
    );
  });

  app.get("/api/media/:hash", async (c) => {
    identity(c, deps);
    const hash = c.req.param("hash");
    const media = deps.store.getMedia(hash);
    if (!media) fail("NOT_FOUND", "media not found");
    const file = Bun.file(deps.store.mediaPath(media.hash, media.ext));
    if (!(await file.exists())) fail("NOT_FOUND", "media file missing");
    return new Response(file, {
      headers: {
        ...corsHeaders(c.req.header("origin")),
        "content-type": EXT_CONTENT_TYPE[media.ext] ?? "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  });

  // Same-origin static UI (design §1: the local instance serves the same build the
  // shell hosts). Hash routing means no rewrite rules are required.
  if (deps.uiDir) {
    const root = resolve(deps.uiDir);
    app.get("*", async (c) => {
      const pathname = decodeURIComponent(new URL(c.req.url).pathname);
      const rel = pathname === "/" ? "/index.html" : pathname;
      if (rel.includes("..")) return c.text("bad path", 400);
      const file = Bun.file(join(root, rel));
      if (await file.exists()) {
        const headers: Record<string, string> = { ...corsHeaders(c.req.header("origin")) };
        if (rel.endsWith(".html")) headers["cache-control"] = "no-cache";
        return new Response(file, { headers });
      }
      if (rel.startsWith("/api/")) {
        return c.json({ ok: false, error: "not found", code: "NOT_FOUND" }, 404);
      }
      return new Response(Bun.file(join(root, "index.html")), {
        headers: { ...corsHeaders(c.req.header("origin")), "cache-control": "no-cache" },
      });
    });
  }


  return app;
}

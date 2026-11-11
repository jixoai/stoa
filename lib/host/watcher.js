/**
 * SSE watcher → session injection for the dsh host half (S5; design §4).
 *
 * The watcher subscribes to the instance's event hub with the manager's
 * credentials (`POST /api/stream/ticket` + `GET /api/stream?hub=2&since=…`) and
 * consumes the board's existing notification semantics — `post.created` /
 * `thread.invited` (`NOTIFICATION_TYPES` in `src/core/types.ts`), visibility
 * already viewer-scoped server-side. It does not invent extra filters: it only
 * drops the account's own events and soft-deleted posts.
 *
 * Everything is dependency-injected (`fetchImpl`, `timers`, `excerpt`, `inject`)
 * so the module runs under `bun test` without dsh or a live board:
 * - dedupe/resume by `seq` cursor (`hello`/`heartbeat`/`caught_up` washmarks);
 * - 1.5s batch merge → one injected user message;
 * - exponential backoff when the instance is unreachable, logged through the
 *   injected logger (never stdout).
 */

/** Board notification semantics (`src/core/types.ts` NOTIFICATION_TYPES). */
export const NOTIFICATION_TYPES = new Set(["post.created", "thread.invited"]);
/** Same-batch merge window (design §4). */
export const MERGE_WINDOW_MS = 1500;
/** Excerpt bound for one injected line. */
export const SUMMARY_MAX_CHARS = 280;
/** Reconnect backoff ladder (ms), capped at the last step. */
export const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 60000];

/** `source=author|mention|reply|quote` labels shown in the injected header. */
export const SOURCE_LABELS = {
  reply: "回复你",
  mention: "提到了你",
  quote: "引用了你的帖子",
  thread: "回复了你的帖子",
  post: "在你的会话里发帖",
};
/** The matching predicate phrase for the single-event form. */
export const SOURCE_PHRASES = {
  reply: "回复了你的帖子",
  mention: "提到了你",
  quote: "引用了你的帖子",
  thread: "回复了你的帖子",
  post: "发了新帖",
};

/** Collapse whitespace so one excerpt stays a single injected line. */
export function collapseSummary(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** Bound one excerpt to `max` characters (ellipsis included in the bound). */
export function truncateSummary(text, max = SUMMARY_MAX_CHARS) {
  const flat = collapseSummary(text);
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Classify one notification line into an injectable item, or null when it is
 * not addressed to this account. Mirrors the board's own `eventText` reading of
 * the payloads (`src/ui/pages/NotificationsPage.tsx`).
 *
 * @param {object} line - one hub `EventLine`
 * @param {string|null} selfId - the account this watcher subscribes as
 */
export function classifyEvent(line, selfId = null) {
  if (!line || typeof line !== "object") return null;
  const type = line.type;
  if (!NOTIFICATION_TYPES.has(type)) return null;
  if (line.post_deleted === true) return null;
  const actor = typeof line.actor === "string" ? line.actor : "";
  if (selfId && actor === selfId) return null;
  const payload = line.payload && typeof line.payload === "object" ? line.payload : {};
  const postId =
    (typeof line.post_id === "string" && line.post_id) ||
    (typeof payload.post_id === "string" && payload.post_id) ||
    null;
  let kind = "post";
  if (type === "thread.invited") {
    kind = payload.via === "quote" ? "quote" : "mention";
  } else if (typeof payload.quoted_post_id === "string" && payload.quoted_post_id) {
    kind = "quote";
  } else if (typeof payload.reply_to_account_id === "string" && payload.reply_to_account_id) {
    kind = payload.reply_to_account_id === selfId ? "reply" : "post";
  } else if (typeof payload.parent_id === "string" && payload.parent_id) {
    kind = "thread";
  }
  return {
    seq: typeof line.seq === "number" ? line.seq : 0,
    type,
    kind,
    label: SOURCE_LABELS[kind] ?? kind,
    phrase: SOURCE_PHRASES[kind] ?? "",
    actor: actor || "（未知账号）",
    postId,
    rootId: typeof line.root_id === "string" ? line.root_id : null,
    createdAt: typeof line.created_at === "number" ? line.created_at : null,
    excerpt: null,
  };
}

/** One `- [标签] 作者 #帖id` line for the multi-event form. */
export function formatEventLine(item, excerptMax = 120) {
  const head = `- [${item.label}] ${item.actor}${item.postId ? ` #${item.postId}` : ""}`;
  return item.excerpt ? `${head}：${truncateSummary(item.excerpt, excerptMax)}` : head;
}

/** Compose the injected user message text (design §4 example, ≤280 字摘要). */
export function buildInjectionText(items) {
  const parts = [];
  if (items.length === 1) {
    const item = items[0];
    parts.push(`[Stoa · ${item.label}] ${item.actor} ${item.phrase}${item.postId ? ` #${item.postId}` : ""}：`);
    if (item.excerpt) parts.push(`> ${truncateSummary(item.excerpt)}`);
  } else {
    parts.push(`[Stoa · ${items.length} 条新消息]`);
    for (const item of items) parts.push(formatEventLine(item));
  }
  parts.push("需要回应时用 stoa_reply（post_id 见上）；不需要就继续手头工作。");
  return parts.join("\n");
}

/** Streaming SSE frame splitter (blank-line dispatch, `\r` normalized). */
export function createSseParser() {
  let buffer = "";
  return {
    /** Feed one chunk; returns the complete frames it produced. */
    push(chunk) {
      buffer += String(chunk ?? "").replace(/\r/g, "");
      const frames = [];
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const frame = parseSseBlock(block);
        if (frame) frames.push(frame);
        index = buffer.indexOf("\n\n");
      }
      return frames;
    },
  };
}

/** Parse one SSE block into `{event, id, data}` (null when it carries no data). */
export function parseSseBlock(block) {
  let event = "message";
  let id = null;
  const data = [];
  for (const rawLine of String(block ?? "").split("\n")) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon >= 0 ? rawLine.slice(0, colon) : rawLine;
    let value = colon >= 0 ? rawLine.slice(colon + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, id, data: data.join("\n") };
}

/**
 * Watch one instance and inject notifications into one agent session.
 *
 * @param {{
 *   baseUrl: string,
 *   board: ReturnType<import('./session.js').createBoardClient>,
 *   selfId?: string|null,
 *   fetchImpl?: typeof fetch,
 *   timers?: {setTimeout: Function, clearTimeout: Function, sleep?: (ms: number) => Promise<void>},
 *   log?: {info?: Function, warn?: Function},
 *   inject: (text: string, items: object[]) => void,
 *   excerpt?: (item: object) => Promise<string|null>,
 *   mergeWindowMs?: number,
 *   onStatus?: (status: object) => void,
 * }} options
 */
export function createWatcher(options) {
  const board = options.board;
  const baseUrl = String(options.baseUrl).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timers = options.timers ?? globalThis;
  const log = options.log ?? {};
  const selfId = options.selfId ?? "manager";
  const mergeWindowMs = options.mergeWindowMs ?? MERGE_WINDOW_MS;
  const inject = options.inject;
  const fetchExcerpt = options.excerpt ?? null;

  let cursor = typeof options.since === "number" ? options.since : null;
  let controller = null;
  let flushTimer = null;
  /** Pending backoff sleep `{finish, timer}`; `stop()` releases it at once. */
  let pendingSleep = null;
  let pending = [];
  let aborted = false;
  let failures = 0;
  let running = false;
  let state = "idle";
  /** Sentinel resolved into the read race when `stop()` is called. */
  const ABORTED = Symbol("stoa-watcher-aborted");
  let releaseAbortGate = () => {};
  const abortGate = new Promise((resolve) => {
    releaseAbortGate = () => resolve(ABORTED);
  });
  /**
   * Settles once the run loop has fully exited. `stop()` returns it so a host
   * `dispose()` can await "watcher stopped" instead of only flipping a flag.
   */
  let signalFinished = () => {};
  const finished = new Promise((resolve) => {
    let settled = false;
    signalFinished = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  const stats = { injected: 0, batches: 0, events: 0, reconnects: 0, lastError: null, lastSeq: cursor };

  /**
   * Backoff sleep that `stop()` can interrupt: the pending timer handle is kept
   * so `dispose()` never leaves a reconnect armed for up to 60s. A composition
   * that injects a custom `timers.sleep` (tests) cannot be cancelled at the
   * timer level, but the wake resolver still releases the loop immediately.
   */
  function sleepBackoff(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        pendingSleep = null;
        resolve();
      };
      if (typeof timers.sleep === "function") {
        pendingSleep = { finish, timer: null };
        Promise.resolve(timers.sleep(ms)).then(finish, finish);
        return;
      }
      const timer = timers.setTimeout(finish, ms);
      pendingSleep = { finish, timer };
    });
  }

  /** Clear the armed backoff timer and release the loop (idempotent). */
  function wakeSleep() {
    const pending = pendingSleep;
    if (!pending) return;
    if (pending.timer !== null && pending.timer !== undefined) timers.clearTimeout(pending.timer);
    pending.finish();
  }

  const status = () => ({
    state,
    lastSeq: cursor,
    injected: stats.injected,
    batches: stats.batches,
    events: stats.events,
    reconnects: stats.reconnects,
    lastError: stats.lastError,
  });
  const notify = () => {
    if (typeof options.onStatus === "function") options.onStatus(status());
  };

  /** Flush the pending batch as one steer message. */
  function flush() {
    if (flushTimer !== null) {
      timers.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const text = buildInjectionText(batch);
    stats.batches += 1;
    stats.injected += 1;
    try {
      inject(text, batch);
    } catch (error) {
      log.warn?.(`stoa: injection failed: ${String(error?.message ?? error)}`);
    }
    notify();
  }

  /** Accept one raw hub line: dedupe, classify, excerpt, batch. */
  function acceptLine(line) {
    if (aborted) return;
    const seq = typeof line?.seq === "number" ? line.seq : null;
    if (seq !== null) {
      if (cursor !== null && seq <= cursor) return; // already delivered (dedupe/resume)
      cursor = seq;
    }
    const item = classifyEvent(line, selfId);
    if (!item) return;
    stats.events += 1;
    pending.push(item);
    if (fetchExcerpt) {
      const target = item.postId ?? item.rootId;
      if (target) {
        void Promise.resolve(fetchExcerpt(item, target))
          .then((text) => {
            if (typeof text === "string" && text.trim()) item.excerpt = text;
          })
          .catch(() => {});
      }
    }
    if (flushTimer === null) flushTimer = timers.setTimeout(flush, mergeWindowMs);
  }

  function handleFrame(frame) {
    let parsed = null;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      return;
    }
    if (frame.event === "hub") {
      acceptLine(parsed);
      return;
    }
    if (frame.event === "hello") {
      stats.reconnects = cursor === null ? stats.reconnects : stats.reconnects + 1;
      if (cursor === null && typeof parsed?.as_of_seq === "number") {
        // First connect: the board starts at the tip — no historical backlog.
        cursor = parsed.as_of_seq;
      }
      if (parsed?.hub !== 2) log.warn?.("stoa: board did not negotiate the event hub (hub!=2)");
      state = "live";
      failures = 0;
      notify();
      return;
    }
    if (frame.event === "heartbeat" || frame.event === "caught_up") {
      if (typeof parsed?.as_of_seq === "number" && (cursor === null || parsed.as_of_seq > cursor)) {
        cursor = parsed.as_of_seq;
      }
      return;
    }
    if (frame.event === "reset") {
      if (typeof parsed?.as_of_seq === "number") cursor = parsed.as_of_seq;
      log.warn?.(`stoa: event stream hole (${parsed?.reason ?? "unknown"}); resuming at seq ${parsed?.as_of_seq ?? "?"}`);
      notify();
      return;
    }
    if (frame.event === "bye") {
      throw Object.assign(new Error(`stream closed by the board (${parsed?.reason ?? "bye"})`), { streamEnded: true });
    }
  }

  /** Consume one SSE response body until EOF/abort. */
  async function pump(response) {
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error("stream response has no readable body");
    const decoder = new TextDecoder();
    const parser = createSseParser();
    for (;;) {
      if (aborted) return;
      // A synthetic/never-resolving body stream cannot observe the fetch abort,
      // so race the read against the stop gate — otherwise `dispose()` would
      // await a reader that never settles.
      const outcome = await Promise.race([reader.read(), abortGate]);
      if (outcome === ABORTED) {
        try {
          await reader.cancel?.();
        } catch {
          /* the stream may already be closed */
        }
        return;
      }
      const { value, done } = outcome;
      if (done) return;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) handleFrame(frame);
    }
  }

  async function issueStream(extraHeaders = {}) {
    const ticketBody = await board.post("/api/stream/ticket", {});
    const ticket = typeof ticketBody?.ticket === "string" ? ticketBody.ticket : "";
    if (!ticket) throw new Error("board did not issue a stream ticket");
    const params = new URLSearchParams({ hub: "2", ticket });
    if (cursor !== null) params.set("since", String(cursor));
    return fetchImpl(`${baseUrl}/api/stream?${params.toString()}`, {
      method: "GET",
      headers: { accept: "text/event-stream", ...extraHeaders },
      signal: controller.signal,
    });
  }

  async function run() {
    running = true;
    notify();
    try {
      while (!aborted) {
        try {
          state = "connecting";
          notify();
          controller = new AbortController();
          const response = await Promise.race([issueStream(), abortGate]);
          if (aborted || response === ABORTED) break;
          if (!response.ok || !response.body) {
            // In auth mode an invalid/consumed ticket answers 204 with no body;
            // both cases reconnect under backoff with a fresh ticket.
            throw new Error(`stream HTTP ${response.status}`);
          }
          await pump(response);
          if (aborted) break;
          throw new Error("stream closed");
        } catch (error) {
          if (aborted) break;
          const message = String(error?.message ?? error);
          stats.lastError = message;
          // One warn per failure streak; the ladder keeps retries quiet afterwards.
          if (failures === 0) log.warn?.(`stoa: stream unavailable (${message}); retrying with backoff`);
          const delay = BACKOFF_STEPS_MS[Math.min(failures, BACKOFF_STEPS_MS.length - 1)];
          failures += 1;
          state = "backoff";
          notify();
          await sleepBackoff(delay);
        } finally {
          controller = null;
        }
      }
      state = "stopped";
      notify();
    } finally {
      running = false;
      signalFinished();
    }
  }

  return {
    start() {
      if (running || aborted) return null;
      const task = run().catch((error) => {
        log.warn?.(`stoa: watcher stopped: ${String(error?.message ?? error)}`);
      });
      return task;
    },
    /**
     * Stop the loop. Returns a promise that settles once the run loop exited
     * (used by `dispose()`/`/stoa off`); calling it twice joins the same exit.
     */
    stop() {
      if (!aborted) {
        aborted = true;
        if (flushTimer !== null) {
          timers.clearTimeout(flushTimer);
          flushTimer = null;
        }
        pending = [];
        wakeSleep();
        releaseAbortGate();
        controller?.abort();
        notify();
      }
      if (!running) signalFinished();
      return finished;
    },
    /** Test/inspection seam: feed one already-parsed hub line. */
    acceptLine(line) {
      if (aborted) return;
      acceptLine(line);
    },
    /** Test/inspection seam: run the pending batch now. */
    flush,
    status,
  };
}

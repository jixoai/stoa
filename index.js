/**
 * Host half of the Stoa dsh bundle — `/stoa` session mode
 * (openspec change stoa-dsh-session-mode; design §2–§6).
 *
 * One bundle entry composes both faces: `client.js` owns the visible UI
 * (daemon console panel), this module owns the host-side session mode:
 *
 * - `/stoa` host command (on/status/off/subagents) — UI result only;
 * - one Stoa instance per session (`POST /api/daemon/services`, idempotent);
 * - session-scoped tools (`stoa_post/reply/read/status/open_account`);
 * - SSE watcher that injects board notifications via
 *   `agent.steer(createUserMessage({..., source:{kind:'stoa'}}))`;
 * - lazily created board accounts for subagents (`[[stoa:<id>]]` reuse).
 *
 * dsh packages are imported lazily (`@deepseek-ai/dsh-llm` for messages,
 * `@deepseek-ai/dsh-tools` for `defineTool`) so a composition without them
 * degrades with a readable error instead of failing plugin load.
 */

import { readFileSync } from "node:fs";
import { parseStoaMarker, createAccountManager } from "./lib/host/accounts.js";
import { registerStoaCommand } from "./lib/host/command.js";
import {
  DAEMON_TIMEOUT_MS,
  accountEnvPath,
  createAssociationStore,
  createBoardClient,
  createDaemonClient,
  createInstanceManager,
  daemonBaseUrl,
  readAccountToken,
  redactSecrets,
} from "./lib/host/session.js";
import { registerStoaTools } from "./lib/host/tools.js";
import { createWatcher } from "./lib/host/watcher.js";

/** Injected user-message source tag (design §1: MessageSourceMap['stoa']). */
export const STOA_MESSAGE_SOURCE = { kind: "stoa" };
/**
 * dsh activation contract: a plugin without `inject` activates immediately,
 * concurrently with every other Loader row (`vendor/loader/src/config/group.ts`
 * runs `Promise.all`), so `ctx.get('commands'|'tools')` would be undefined and
 * this host would silently register nothing. Declaring both services makes the
 * fiber stay PENDING until they are ACTIVE (`vendor/cordis/src/fiber.ts`
 * `_refresh`). `storage` is deliberately absent: it is read lazily on the first
 * `/stoa` so the KV unit is opened after the whole composition is mounted.
 */
export const inject = ["commands", "tools"];
/** Max parent hops when resolving a subagent's owning session. */
const MAX_PARENT_HOPS = 8;
/**
 * Upper bound on how long `dispose()` waits for an in-flight `/stoa` to settle
 * before the association KV unit is closed. A loopback mount plus a local KV
 * write normally lands in well under a second; the daemon HTTP budget is 20 s
 * (`DAEMON_TIMEOUT_MS`), which a profile unload must not inherit. On timeout
 * the enable aborts at its next checkpoint (`disposed` is already true) and its
 * result is mapped to the readable disposed error, so unload stays bounded.
 */
const DISPOSE_INFLIGHT_WAIT_MS = 5000;

/** Readable failure for any work that resumes after the host was disposed. */
function disposedError(what) {
  const error = new Error(`Stoa 宿主已卸载（dispose）：${what}已中止，未启用任何资源。请重新加载 dsh profile 后再执行 /stoa。`);
  error.code = "STOA_DISPOSED";
  return error;
}

/** Lazy, memoized import of `@deepseek-ai/dsh-llm`'s `createUserMessage`. */
function createLazyLlmLoader(overrides) {
  let promise = null;
  return function loadCreateUserMessage() {
    if (typeof overrides.createUserMessage === "function") return Promise.resolve(overrides.createUserMessage);
    if (!promise) {
      promise = import("@deepseek-ai/dsh-llm")
        .then((module) => (typeof module?.createUserMessage === "function" ? module.createUserMessage : null))
        .catch(() => null);
    }
    return promise;
  };
}

/** Lazy, memoized import of `@deepseek-ai/dsh-tools`'s `defineTool`. */
function createLazyToolLoader(overrides) {
  let promise = null;
  return function loadDefineTool() {
    if (typeof overrides.defineTool === "function") return Promise.resolve(overrides.defineTool);
    if (typeof overrides.loadDefineTool === "function") return Promise.resolve(overrides.loadDefineTool());
    if (!promise) {
      promise = import("@deepseek-ai/dsh-tools")
        .then((module) => (typeof module?.defineTool === "function" ? module.defineTool : null))
        .catch(() => null);
    }
    return promise;
  };
}

/** Logger over `ctx.logger`; falls back to stderr (never stdout). */
function createLogger(ctx, overrides) {
  if (overrides.log) return overrides.log;
  const logger = ctx?.logger;
  return {
    info(message) {
      try {
        if (typeof logger?.info === "function") logger.info(message);
      } catch {
        /* logging must never break the session */
      }
    },
    warn(message) {
      try {
        if (typeof logger?.warn === "function") {
          logger.warn(message);
          return;
        }
      } catch {
        /* fall through to stderr */
      }
      process.stderr.write(`[stoa] ${String(message)}\n`);
    },
  };
}

/**
 * Build the host-side session mode over one cordis context.
 *
 * @param {object} ctx - cordis context (`get`/`on`/`effect`/`logger`)
 * @param {{env?: object, fetchImpl?: Function, timers?: object, log?: object,
 *          createUserMessage?: Function, defineTool?: Function,
 *          loadDefineTool?: Function}} [overrides] - test seams
 */
export function createStoaHost(ctx, overrides = {}) {
  const env = overrides.env ?? (typeof process !== "undefined" ? process.env : {});
  const log = createLogger(ctx, overrides);
  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
  const timers = overrides.timers ?? globalThis;
  const loadCreateUserMessage = createLazyLlmLoader(overrides);
  const loadDefineTool = createLazyToolLoader(overrides);

  /** sessionId → {enabled, subagentsEnabled, record, watcher, agent, board, accounts, clients} */
  const sessions = new Map();
  /** childId → {runId, parentSessionId} registered by `subagent/start`. */
  const children = new Map();
  /**
   * Lazily created per-call board clients: `sessionId:baseUrl:accountId` → client.
   * The base URL is part of the key: re-enabling a session against a re-mounted
   * instance (daemon picked a new port) must never reuse a client aimed at the
   * old instance (S6-3 instance-change invalidation).
   */
  const clients = new Map();
  let disposed = false;
  /** Deferred result of the first `dispose()`; later calls join it (awaitable). */
  let disposePromise = null;

  const getService = (name) => {
    try {
      return typeof ctx?.get === "function" ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };
  const getAgent = (sessionId) => {
    const agents = getService("agents");
    try {
      return typeof agents?.get === "function" ? agents.get(sessionId) : undefined;
    } catch {
      return undefined;
    }
  };

  const daemon = createDaemonClient({ env, fetchImpl, timers, baseUrl: daemonBaseUrl(env) });
  /**
   * Association store, opened on the first `/stoa` (never at construction):
   * `ctx.storage` only exists once the composition mounted it, and a hot
   * profile reload must be able to re-open the same KV unit after our dispose
   * closed it (`dsh-storage-json` rejects a second open of a live unit).
   * One memoized promise = one open per host instance.
   */
  let storePromise = null;
  function ensureStore() {
    if (disposed) return Promise.reject(disposedError("打开关联存储"));
    if (!storePromise) {
      const opening = createAssociationStore({
        storage: getService("storage"),
        env,
        onWarn: (message) => log.warn?.(message),
      })
        .then(async (store) => {
          // `dispose()` may win the race against a slow KV open: release the
          // handle at once instead of leaving a live unit behind for a reload
          // (`dsh-storage-json` rejects a second open while one is live).
          if (disposed) {
            try {
              await store.close?.();
            } catch {
              /* the open handle is already unusable; nothing else to release */
            }
            throw disposedError("打开关联存储");
          }
          return store;
        })
        .catch((error) => {
          if (storePromise === opening) storePromise = null;
          throw error;
        });
      storePromise = opening;
    }
    return storePromise;
  }
  const instanceManager = createInstanceManager({ ensureStore, daemon, fetchImpl, timers });
  function entryFor(sessionId, { create = false } = {}) {
    let entry = sessions.get(sessionId) ?? null;
    if (!entry && create) {
      entry = {
        sessionId,
        enabled: false,
        subagentsEnabled: true,
        record: null,
        watcher: null,
        agent: null,
        board: null,
        accountManager: null,
        accounts: new Map(),
        /** Enable generation; `/stoa off` and a new enable bump it. */
        epoch: 0,
        /** A previous `/stoa off` could not confirm the daemon stop (retryable). */
        stopPending: false,
      };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  /** Drop every cached subagent client of one session (instance changed). */
  function clearClientsFor(sessionId) {
    const prefix = `${sessionId}:`;
    for (const key of [...clients.keys()]) {
      if (key.startsWith(prefix)) clients.delete(key);
    }
  }

  /** Client-cache key for one account; keys are scoped to the owning entry. */
  function clientKeyFor(entry, accountId) {
    return `${entry.sessionId}:${entry.record?.baseUrl ?? ""}:${accountId}`;
  }

  /**
   * Forget one ended subagent's lazily-created account and its cached board
   * client. `subagent/end` only carries the child id while the account map and
   * client keys live on the session that ran `/stoa`, so this scans the owner
   * entries instead of prefix-matching the child id (review r3 P3-6).
   */
  function forgetSubagentAccount(childId) {
    for (const entry of sessions.values()) {
      const cached = entry.accounts.get(childId);
      if (!cached) continue;
      entry.accounts.delete(childId);
      clients.delete(clientKeyFor(entry, cached.id));
      return;
    }
  }

  function boardFor(entry, accountId, token) {
    const key = clientKeyFor(entry, accountId);
    let client = clients.get(key);
    if (!client) {
      client = createBoardClient({
        baseUrl: entry.record.baseUrl,
        socket: entry.record.socket ?? null,
        token,
        fetchImpl,
        timers,
        account: accountId === "manager" ? null : accountId,
      });
      clients.set(key, client);
    }
    return client;
  }

  function redact(text) {
    const secrets = [];
    for (const entry of sessions.values()) {
      const token = entry.board?.token;
      if (typeof token === "string") secrets.push(token);
      for (const account of entry.accounts.values()) secrets.push(account.token);
    }
    return redactSecrets(text, secrets);
  }

  /**
   * Manager credentials: the 0600 `accounts/manager.env` token when present,
   * else an open-mode instance (verified through `/api/auth/status`) with no
   * token — an auth-mode instance without that file fails loudly.
   */
  async function managerCredentials(record) {
    const token = readAccountToken(record.dataDir, "manager");
    if (token) return { token, mode: "auth" };
    const probe = createBoardClient({ baseUrl: record.baseUrl, socket: record.socket ?? null, token: null, fetchImpl, timers, account: "manager" });
    try {
      const status = await probe.get("/api/auth/status", DAEMON_TIMEOUT_MS);
      if (status?.mode === "open") return { token: null, mode: "open" };
    } catch {
      /* fall through to the readable error below */
    }
    throw new Error(
      `未找到 manager 凭据（${accountEnvPath(record.dataDir, "manager")}）：请在 daemon 控制台重建该实例账号，或确认实例处于开放模式。`,
    );
  }

  /**
   * Deliver one notification batch to the session agent.
   *
   * Resolve the agent freshly on every call (`agents.get`) and fall back to the
   * cached entry agent only when the registry has none — a disposed agent must
   * not be steered. `steer` can throw synchronously (closed session / disposed
   * agent), so the whole delivery is guarded: a failed injection returns false
   * and is logged by the caller instead of rejecting into the watcher.
   */
  async function injectInto(entry, text) {
    const agent = getAgent(entry.sessionId) ?? entry.agent;
    if (!agent || typeof agent.steer !== "function" || typeof entry.createUserMessage !== "function") return false;
    try {
      const message = entry.createUserMessage({
        content: [{ type: "text", text }],
        source: { ...STOA_MESSAGE_SOURCE },
      });
      agent.steer(message);
      return true;
    } catch (error) {
      log.warn?.(`stoa: injection skipped (${String(error?.message ?? error)})`);
      return false;
    }
  }

  /** In-flight `/stoa` per session: concurrent invocations share one promise. */
  const enabling = new Map();
  /** In-flight `/stoa off` per session: a following enable waits for the stop. */
  const stopping = new Map();

  /** Readable cancellation error for a dsh command invocation signal. */
  function signalAbortError(signal) {
    const reason = signal?.reason;
    const detail = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
    return new Error(`/stoa 已被取消${detail ? `（${detail}）` : ""}：本次未启用任何资源（可重试 /stoa）。`);
  }

  /**
   * `/stoa` (default, idempotent): ensure one instance and one live watcher.
   * Concurrent invocations for the same session share one in-flight promise so
   * two `location:auto` mounts can never race into two instances (S3-2).
   *
   * Every await re-checks two invalidation sources before any resource is
   * published — host `dispose()` and a newer `/stoa off`/enable generation —
   * so a slow mount resolution can never install a watcher (or keep a live
   * one) after the host was torn down. `options.signal` is the dsh command
   * invocation's cancellation signal (`packages/interaction/commands/src/
   * index.ts` `withAbort`): checking it at the same checkpoints means a
   * cancelled `/stoa` never publishes a watcher either.
   */
  function enableSession(sessionId, agent, options = {}) {
    if (disposed) return Promise.reject(disposedError("/stoa"));
    const signal = options.signal ?? null;
    if (signal?.aborted) return Promise.reject(signalAbortError(signal));
    const entry = entryFor(sessionId, { create: true });
    if (agent) entry.agent = agent;
    const inFlight = enabling.get(sessionId);
    if (inFlight) return inFlight;
    const epoch = entry.epoch + 1;
    entry.epoch = epoch;
    /** Whether this run resolved a mounted/reused instance (for off retry). */
    let mounted = false;
    const checkCurrent = () => {
      if (disposed) throw disposedError("/stoa");
      if (signal?.aborted) throw signalAbortError(signal);
      if (entry.epoch !== epoch) {
        throw new Error("Stoa 会话模式启用已被 /stoa off 取消：本次未启用（已挂载的实例随 off 停止；可重新执行 /stoa）。");
      }
    };
    const task = (async () => {
      // A `/stoa off` that is still stopping the instance must settle first:
      // otherwise this enable could adopt the instance right before the stop
      // lands and leave a watcher aimed at a dead service.
      const stopTask = stopping.get(sessionId);
      if (stopTask) {
        try {
          await stopTask;
        } catch {
          /* off reports its own warning; enabling still re-probes below */
        }
      }
      checkCurrent();
      // Always re-ensure: a repeat `/stoa` probes the stored instance (cheap) and
      // re-mounts with the recorded data directory when the instance is gone.
      let outcome;
      try {
        outcome = await instanceManager.ensure(sessionId);
      } catch (error) {
        // `dispose()` closes the KV unit only after its bounded wait for this
        // enable; if the wait expired anyway, the `store.set` rejection carries
        // the backend's raw wording ("unit '…' is closed"). Never let that
        // internal English reach the /stoa result (review r3 P2).
        if (disposed && error?.code !== "STOA_DISPOSED") throw disposedError("/stoa");
        throw error;
      }
      mounted = true;
      const previous = entry.record;
      entry.record = outcome.record;
      checkCurrent();
      const sameInstance =
        previous !== null &&
        previous.baseUrl === entry.record.baseUrl &&
        previous.serviceId === entry.record.serviceId;
      if (entry.enabled && entry.watcher && sameInstance) {
        entry.stopPending = false;
        return describeState(entry);
      }
      // A different instance (re-mounted after off, daemon restart, new port)
      // invalidates subagent account tokens and their cached board clients.
      if (!sameInstance) {
        entry.accounts.clear();
        clearClientsFor(sessionId);
      }
      entry.watcher?.stop();
      entry.watcher = null;
      entry.enabled = false;
      const credentials = await managerCredentials(entry.record);
      checkCurrent();
      const createUserMessage = await loadCreateUserMessage();
      checkCurrent();
      if (typeof createUserMessage !== "function") {
        throw new Error("无法加载 @deepseek-ai/dsh-llm 的 createUserMessage：本组合无法注入消息，会话模式未启用（stoa_* 工具需 /stoa 成功后才可用）。");
      }
      entry.createUserMessage = createUserMessage;
      // `x-report-account: manager` is always safe: auth mode ignores it and
      // derives identity from the bearer token (`src/server/auth.ts:109-146`),
      // open mode needs it to stop the manager's own posts from being seen as
      // somebody else's and injected back (self-feedback loop).
      entry.board = createBoardClient({
        baseUrl: entry.record.baseUrl,
        socket: entry.record.socket ?? null,
        token: credentials.token,
        fetchImpl,
        timers,
        account: "manager",
      });
      entry.accountManager = createAccountManager({
        board: entry.board,
        dataDir: entry.record.dataDir,
        readFile: (path, encoding) => readFileSync(path, encoding),
      });
      const watcher = createWatcher({
        baseUrl: entry.record.baseUrl,
        socket: entry.record.socket ?? null,
        board: entry.board,
        selfId: "manager",
        fetchImpl,
        timers,
        log,
        inject: (text) => {
          void injectInto(entry, text)
            .then((delivered) => {
              if (!delivered) log.warn?.("stoa: notification dropped (no live agent to steer yet)");
            })
            .catch((error) => {
              log.warn?.(`stoa: injection failed (${String(error?.message ?? error)})`);
            });
        },
        excerpt: async (item, postId) => {
          const body = await entry.board.get(`/api/posts/${encodeURIComponent(postId)}`, DAEMON_TIMEOUT_MS);
          const post = body?.post;
          return typeof post?.body_md === "string" ? post.body_md : null;
        },
        onStatus: (status) => {
          entry.lastInjection = status;
        },
      });
      // Last checkpoint: nothing below awaits, so this is the publish barrier.
      checkCurrent();
      entry.watcher = watcher;
      entry.enabled = true;
      entry.stopPending = false;
      watcher.start();
      log.info?.(`stoa: session mode on (${entry.record.baseUrl}, service ${entry.record.serviceId})`);
      return describeState(entry);
    })().catch((error) => {
      // A failed/cancelled enable that already reached the daemon may have left
      // a live instance behind; record it so the next `/stoa off` still stops it
      // instead of treating the session as a plain no-op.
      if (mounted && !entry.enabled) entry.stopPending = true;
      throw error;
    });
    const tracked = task.finally(() => {
      if (enabling.get(sessionId) === tracked) enabling.delete(sessionId);
    });
    enabling.set(sessionId, tracked);
    return tracked;
  }

  function describeState(entry) {
    return {
      sessionId: entry.sessionId,
      record: entry.record,
      injection: entry.watcher?.status() ?? entry.lastInjection ?? null,
    };
  }

  /** Session (or owning session) that enabled the mode; null when off/unknown. */
  function ownerEntryFor(sessionId) {
    const ownerId = rootSessionOf(sessionId);
    const entry = sessions.get(ownerId);
    if (!entry || !entry.enabled || !entry.record) return null;
    return entry;
  }

  /** Walk `subagent/start` parents up to the session that owns an instance. */
  function rootSessionOf(sessionId) {
    let id = sessionId;
    for (let hop = 0; hop < MAX_PARENT_HOPS; hop += 1) {
      const info = children.get(id);
      if (!info || typeof info.parentSessionId !== "string" || !info.parentSessionId) return id;
      id = info.parentSessionId;
    }
    return id;
  }

  /**
   * First user-message text of one session (marker source), or null.
   *
   * Primary read is `sessionQuery.readSession` — `session.ownEvents()` /
   * `snapshotEvents()` are deprecated and prohibit new calls
   * (`packages/core/session/src/index.ts:741-750`). The snapshot carries the
   * fork-inherited prefix, so only events after `inheritedEventCount` are the
   * child's own (the parent's first prompt must never supply the marker).
   * The live `ownEvents()` read stays as a fallback for compositions without
   * `sessionQuery` or while persistence lags the in-memory log.
   */
  async function firstUserText(sessionId) {
    const fromEvents = (events) => {
      for (const event of events ?? []) {
        if (event?.type !== "user/message") continue;
        const content = event?.data?.content;
        if (!Array.isArray(content)) return "";
        return content
          .filter((block) => block && block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n");
      }
      return null;
    };
    try {
      const query = getService("sessionQuery");
      if (query && typeof query.readSession === "function") {
        const loaded = await query.readSession(sessionId);
        const events = Array.isArray(loaded?.events) ? loaded.events : [];
        const inherited = typeof loaded?.inheritedEventCount === "number" ? loaded.inheritedEventCount : 0;
        const ownText = fromEvents(events.slice(Math.max(0, inherited)));
        if (ownText !== null) return ownText;
      }
    } catch {
      /* fall through to the live session read */
    }
    try {
      const own = getAgent(sessionId)?.session?.ownEvents?.();
      const ownText = fromEvents(own);
      if (ownText !== null) return ownText;
    } catch {
      /* marker lookup is best-effort: an unreadable log just means auto-naming */
    }
    return null;
  }

  /**
   * Execution-time resolution for one calling agent: `sessionId → instance`,
   * `agent → account`. Returns null when the session never enabled the mode
   * (tools answer with the `/stoa` hint); throws for known degraded states.
   */
  async function callContextFor(sessionId) {
    const entry = ownerEntryFor(sessionId);
    if (!entry) return null;
    const base = {
      baseUrl: entry.record.baseUrl,
      dataDir: entry.record.dataDir,
      serviceId: entry.record.serviceId,
      publicUrl: entry.record.publicUrl,
    };
    if (sessionId === entry.sessionId) {
      return { ...base, accountId: "manager", board: entry.board };
    }
    if (!entry.subagentsEnabled) {
      throw new Error("本会话已关闭子代理自动开号：主 Agent 可执行 /stoa subagents=on 后重试。");
    }
    const cached = entry.accounts.get(sessionId);
    if (cached) {
      return { ...base, accountId: cached.id, board: boardFor(entry, cached.id, cached.token) };
    }
    const markerId = parseStoaMarker(await firstUserText(sessionId));
    const account = await entry.accountManager.ensureSubagentAccount({ markerId });
    entry.accounts.set(sessionId, { id: account.id, token: account.token });
    log.info?.(`stoa: subagent ${sessionId} → account ${account.id}${markerId ? " (marker)" : ""}`);
    return { ...base, accountId: account.id, board: boardFor(entry, account.id, account.token) };
  }

  const runtime = {
    env,
    log,
    redact,
    enableSession,
    callContextFor,
    describeSession(sessionId) {
      const entry = ownerEntryFor(sessionId) ?? sessions.get(sessionId) ?? null;
      return {
        injection: entry?.watcher?.status() ?? entry?.lastInjection ?? null,
        subagents: { enabled: entry?.subagentsEnabled ?? true, runs: children.size },
      };
    },
    isSubagentsEnabled(sessionId) {
      return sessions.get(sessionId)?.subagentsEnabled ?? true;
    },
    async setSubagentsEnabled(sessionId, enabled) {
      const entry = entryFor(sessionId, { create: true });
      entry.subagentsEnabled = enabled === true;
      return entry.subagentsEnabled;
    },
    async openAccountFor(sessionId, options) {
      // Resolve the *owner* entry: a subagent calling this tool must not look up
      // `sessions.get(childId)` (undefined → TypeError). The account always
      // belongs to the instance of the session that ran `/stoa`.
      const entry = ownerEntryFor(sessionId);
      if (!entry) return null;
      if (sessionId !== entry.sessionId && !entry.subagentsEnabled) {
        throw new Error("本会话已关闭子代理自动开号：主 Agent 可执行 /stoa subagents=on 后重试。");
      }
      return entry.accountManager.openAccount(options ?? {});
    },
    async statusText(sessionId) {
      if (disposed) return "Stoa 会话模式：未启用（宿主已卸载；重新加载 dsh profile 后再执行 /stoa）。";
      const entry = sessions.get(sessionId);
      if (!entry || !entry.enabled || !entry.record) {
        const association = await instanceManager.get(sessionId);
        const lines = ["Stoa 会话模式：未启用"];
        if (association) lines.push(`（已有登记：${association.baseUrl || "?"}，数据目录 ${association.dataDir || "?"}）`);
        lines.push("执行 /stoa 启用；/stoa subagents=on|off 控制子代理自动开号。");
        return lines.join("\n");
      }
      const injection = entry.watcher?.status() ?? null;
      const lines = [
        "Stoa 会话模式：已启用",
        `实例：${entry.record.baseUrl}（service ${entry.record.serviceId}）`,
        `数据目录：${entry.record.dataDir}`,
        `主账号：manager`,
        `子代理账号：${entry.accounts.size} 个（自动开号 ${entry.subagentsEnabled ? "on" : "off"}；已登记子代理 ${children.size} 个）`,
        `自动注入：${injection?.state ?? "unknown"}${
          typeof injection?.lastSeq === "number" ? `（seq=${injection.lastSeq}；已注入 ${injection.injected} 批；断线重连 ${injection.reconnects} 次）` : ""
        }`,
      ];
      if (injection?.lastError) lines.push(`最近错误：${redact(injection.lastError)}`);
      lines.push("执行 /stoa off 停止本会话实例（保留登记与目录）。");
      return lines.join("\n");
    },
    /**
     * `/stoa off`: stop injection first, then STOP the session's instance but
     * keep its registration/data directory (daemon semantics).
     *
     * Serialization: bump the session's enable generation and join any
     * in-flight `/stoa` before deciding. An in-flight enable that resolved a
     * mount marks `stopPending` when it aborts, so off still stops the instance
     * it just created ("off 回没启用，随后 mount 完成开启注入" is impossible).
     *
     * A failed daemon stop keeps `stopPending` set: the next `/stoa off`
     * retries instead of answering "本来就没有启用" forever.
     */
    disableSession(sessionId) {
      // Concurrent `/stoa off` calls share one stop; a following enable awaits
      // the same promise (registered below) before it probes/mounts anything.
      const existing = stopping.get(sessionId);
      if (existing) return existing;
      const task = (async () => {
        const entry = sessions.get(sessionId);
        if (disposed) {
          // dispose already stopped watchers; never touch the daemon from a dead host.
          if (!entry) return { stopped: false, warning: null };
          entry.epoch += 1;
          entry.enabled = false;
          entry.watcher = null;
          return { stopped: false, warning: null };
        }
        if (entry) entry.epoch += 1;
        const inFlight = enabling.get(sessionId);
        if (inFlight) {
          try {
            await inFlight;
          } catch {
            /* the invalidated enable reports its own readable error to its caller */
          }
        }
        const current = sessions.get(sessionId);
        if (!current) return { stopped: false, warning: null };
        const hadEnabled = current.enabled === true || current.watcher !== null;
        const retried = current.stopPending === true;
        if (!hadEnabled && !retried) return { stopped: false, warning: null };
        const watcher = current.watcher;
        current.watcher = null;
        current.enabled = false;
        try {
          await watcher?.stop();
        } catch {
          /* watcher stop is best-effort; aborted state was already set */
        }
        let warning = null;
        try {
          await instanceManager.stop(sessionId);
          current.stopPending = false;
        } catch (error) {
          if (error?.status === 404 || error?.code === "NOT_FOUND") {
            // The registration was removed in the daemon console: there is
            // nothing left to stop, and retrying would warn on every
            // `/stoa off` forever (review r3 P3-3). Converge as "already
            // stopped" instead of arming another retry.
            current.stopPending = false;
            warning = "daemon 登记已不存在（视为已停）：该服务已在控制台删除，无需再重试停机。";
          } else {
            current.stopPending = true;
            warning = `daemon 未确认停机（${redact(String(error?.message ?? error))}）——实例可能已经不可达；再次执行 /stoa off 会重试停机。`;
          }
        }
        log.info?.(`stoa: session mode off (${current.record?.baseUrl ?? "?"})`);
        return { stopped: hadEnabled || retried, warning, retried };
      })();
      const tracked = task.finally(() => {
        if (stopping.get(sessionId) === tracked) stopping.delete(sessionId);
      });
      stopping.set(sessionId, tracked);
      return tracked;
    },
  };

  // ---- registrations -------------------------------------------------------
  const subagentDisposers = [];
  const onSubagentStart = (info) => {
    if (!info || typeof info.id !== "string") return;
    children.set(info.id, {
      runId: info.runId ?? null,
      parentSessionId: typeof info.parentSessionId === "string" ? info.parentSessionId : null,
    });
  };
  const onSubagentEnd = (info) => {
    if (!info || typeof info.id !== "string") return;
    children.delete(info.id);
    // The child run is over: its lazily-created account mapping and cached
    // board client must not outlive it (review r3 P3-6).
    forgetSubagentAccount(info.id);
  };
  if (typeof ctx?.on === "function") {
    try {
      const disposeStart = ctx.on("subagent/start", onSubagentStart);
      if (typeof disposeStart === "function") subagentDisposers.push(disposeStart);
      const disposeEnd = ctx.on("subagent/end", onSubagentEnd);
      if (typeof disposeEnd === "function") subagentDisposers.push(disposeEnd);
    } catch (error) {
      log.warn?.(`stoa: subagent lifecycle subscription failed: ${String(error?.message ?? error)}`);
    }
  }

  const command = registerStoaCommand({ commands: getService("commands"), runtime, log });
  if (!command.registered && command.error) log.warn?.(command.error);

  // Tool specs need `defineTool`, which only exists in a dsh host composition.
  const toolState = { registered: [], error: null, ready: false };
  const registrationDisposers = [];
  if (command.disposer) registrationDisposers.push(command.disposer);
  const toolsReady = (async () => {
    if (disposed) {
      toolState.error = "stoa host was disposed before tools registered";
      toolState.ready = true;
      return toolState;
    }
    const tools = getService("tools");
    if (!tools || typeof tools.register !== "function") {
      toolState.error = "ctx.tools is not available in this composition";
      toolState.ready = true;
      log.warn?.(`stoa: ${toolState.error}`);
      return toolState;
    }
    const defineTool = await loadDefineTool();
    // Disposal may win while the lazy import is pending: never publish
    // registrations whose disposers would then never run.
    if (disposed) {
      toolState.error = "stoa host was disposed while defineTool was loading";
      toolState.ready = true;
      return toolState;
    }
    const outcome = registerStoaTools({ tools, defineTool, runtime, log });
    toolState.registered = outcome.registered;
    toolState.error = outcome.error;
    toolState.ready = true;
    for (const disposeTool of outcome.disposers) registrationDisposers.push(disposeTool);
    if (outcome.error) log.warn?.(outcome.error);
    return toolState;
  })();

  /**
   * Settle `promise` within `ms`: resolves `{value, settled}` either way, so a
   * hung backend can never block profile unload. Uses the injected timer
   * source (tests drive the bound deterministically).
   */
  function settleWithin(promise, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value, settled) => {
        if (done) return;
        done = true;
        try {
          timers.clearTimeout?.(handle);
        } catch {
          /* timer cleanup is best-effort */
        }
        resolve({ value, settled });
      };
      const handle = timers.setTimeout(() => finish(undefined, false), ms);
      Promise.resolve(promise).then(
        (value) => finish(value, true),
        () => finish(undefined, true),
      );
    });
  }

  /**
   * Tear the host down. Idempotent and awaitable: the returned promise settles
   * once every watcher run loop has stopped and the lazily-opened KV unit is
   * closed (cordis awaits async effect disposers — `vendor/cordis/src/fiber.ts`
   * `_unload` does `await runDisposable(dispose)` under `Promise.all`, so
   * `apply`'s effect hands this promise to the loader).
   */
  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    // Snapshot the in-flight enables *before* clearing the map: an enable that
    // already reached the daemon must be allowed to finish writing its
    // association while the KV unit is still open. Closing first made
    // `store.set` hit a closed unit, lost the association and let the next
    // reload mount a second instance (review r3 P2).
    const inflightEnables = [...enabling.values()];
    const watcherStops = [];
    for (const entry of sessions.values()) {
      entry.enabled = false;
      const watcher = entry.watcher;
      entry.watcher = null;
      if (watcher) {
        try {
          watcherStops.push(Promise.resolve(watcher.stop()));
        } catch {
          /* best-effort teardown */
        }
      }
    }
    for (const disposeSub of subagentDisposers.splice(0)) {
      try {
        disposeSub();
      } catch {
        /* best-effort teardown */
      }
    }
    for (const disposeRegistration of registrationDisposers.splice(0)) {
      try {
        disposeRegistration();
      } catch {
        /* best-effort teardown */
      }
    }
    clients.clear();
    enabling.clear();
    stopping.clear();
    // Close the KV unit only when this host actually opened it (never open a
    // unit just to close it). A profile reload then re-opens the same unit and
    // reads the existing associations back instead of creating a second store.
    const opening = storePromise;
    storePromise = null;
    disposePromise = (async () => {
      await Promise.all(watcherStops.map((stop) => stop.catch(() => {})));
      if (inflightEnables.length > 0) {
        // Bounded so a hung daemon mount cannot pin profile unload. Once
        // `disposed` is set, the enable checkpoints abort at their next await
        // boundary; the wait only has to cover the association write that
        // follows a completed mount.
        await settleWithin(Promise.allSettled(inflightEnables), DISPOSE_INFLIGHT_WAIT_MS);
      }
      if (!opening) return;
      const opened = await settleWithin(opening, DISPOSE_INFLIGHT_WAIT_MS);
      const store = opened.value;
      if (!store) return;
      try {
        await store.close?.();
      } catch {
        /* a failed/aborted open already surfaced to its caller; nothing to close */
      }
    })();
    return disposePromise;
  }

  return { runtime, command, tools: toolState, toolsReady, sessions, children, clients, dispose };
}

/**
 * dsh plugin entry (Host row of the bundle patch). dsh mounts this module via
 * `plugin.name = '@jixoai/stoa'`; `ctx.effect` owns the session mode for the
 * lifetime of the composition. The disposer returns `host.dispose()`'s promise
 * so cordis awaits watcher stop + KV close before the profile reports unloaded.
 */
export function apply(ctx) {
  if (ctx && typeof ctx.effect === "function") {
    ctx.effect(
      () => {
        const host = createStoaHost(ctx);
        return () => host.dispose();
      },
      "stoa: dsh session mode",
    );
    return;
  }
  const host = createStoaHost(ctx ?? {});
  return () => host.dispose();
}

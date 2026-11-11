/**
 * Session ↔ Stoa instance plumbing for the dsh host half
 * (openspec change stoa-dsh-session-mode, S3; design §2/§4).
 *
 * Responsibilities:
 * - daemon base URL (`STOA_DAEMON_URL`, default `http://127.0.0.1:13679`);
 * - per-session instance association (`sessionId → {serviceId, dataDir, baseUrl}`)
 *   stored in `ctx.storage` when a usable KV backend is mounted, else in the
 *   fallback file `$DSH_HOME/storages/stoa-sessions.json` (0600);
 * - instance ensure/stop through the daemon HTTP API
 *   (`POST /api/daemon/services {location:'auto', name:'dsh-<sid6>'}`,
 *   `POST /api/daemon/services/:id/stop`);
 * - 0600 credential reading (`<dataDir>/accounts/<id>.env`) — tokens live only
 *   in memory, and every string that leaves this module is scrubbed through
 *   `redactSecrets` on error paths.
 *
 * No dsh package is imported here: the storage hub is duck-typed and the whole
 * module is plain ESM so `bun test` can load it without the harness.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Default daemon base URL (loopback, daemon's own listener). */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:13679";
/** Env override for the daemon base URL. */
export const DAEMON_URL_ENV = "STOA_DAEMON_URL";
/** `ctx.storage` key prefix for one session's instance association. */
export const ASSOCIATION_PREFIX = "stoa/session/";
/** Fallback association file, relative to `$DSH_HOME`. */
export const FALLBACK_STORE_SEGMENTS = ["storages", "stoa-sessions.json"];
/** Health probe budget for one instance (loopback, cheap). */
export const PROBE_TIMEOUT_MS = 2000;
/** Cap on one daemon HTTP call (mount waits for the child to become healthy). */
export const DAEMON_TIMEOUT_MS = 20000;
/** Board/API call budget. */
export const BOARD_TIMEOUT_MS = 15000;

/** Per-account token keys, mirroring `src/core/auth.ts` (new prefix first). */
export function accountTokenKeys(accountId) {
  const upper = String(accountId).toUpperCase().replace(/-/g, "_");
  return { primary: `STOA_TOKEN_${upper}`, legacy: `FDE2E_REPORT_TOKEN_${upper}` };
}

/** @returns {string} daemon base URL without a trailing slash. */
export function daemonBaseUrl(env = {}) {
  const raw = typeof env?.[DAEMON_URL_ENV] === "string" ? env[DAEMON_URL_ENV].trim() : "";
  return (raw || DEFAULT_DAEMON_URL).replace(/\/+$/, "");
}

/** `dsh-<sessionId 前 6 位>`（slug 化后；不足 6 位就短名）。 */
export function serviceNameFor(sessionId) {
  const slug = String(sessionId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 6);
  return `dsh-${slug || "session"}`;
}

/** 0600 account env file path inside one instance data dir. */
export function accountEnvPath(dataDir, accountId) {
  return join(String(dataDir), "accounts", `${accountId}.env`);
}

/** Minimal dotenv-style parser: `KEY=value`, `#` comments, optional `export`. */
export function parseEnvText(text) {
  const values = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/**
 * Read one account token from its 0600 env file. Returns null when the file is
 * missing/unreadable or carries no token — never logs, never throws.
 * @param {string} dataDir
 * @param {string} accountId
 */
export function readAccountToken(dataDir, accountId, fs = defaultFs) {
  const file = accountEnvPath(dataDir, accountId);
  try {
    const values = parseEnvText(fs.readFileSync(file, "utf8"));
    const keys = accountTokenKeys(accountId);
    const token = values[keys.primary] || values[keys.legacy] || "";
    return token || null;
  } catch {
    return null;
  }
}

/** Replace every secret occurrence in one string (tokens must never leak). */
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 6) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/** `$DSH_HOME` resolution (mirrors `@deepseek-ai/dsh-home-paths`): env, else `~/.dsh`. */
export function resolveDshHome(env = {}, homedir = osHomedir) {
  const raw = typeof env?.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  const selected = raw || join(homedir(), ".dsh");
  const expanded = selected === "~"
    ? homedir()
    : selected.startsWith("~/")
      ? join(homedir(), selected.slice(2))
      : selected;
  return resolve(expanded);
}

const defaultFs = {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
  statSync,
};

/** Read/parse the fallback association file; a broken file reads as empty. */
function readFallbackFile(file) {
  try {
    if (!defaultFs.existsSync(file)) return {};
    const parsed = JSON.parse(defaultFs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/** Atomic 0600 write of the fallback association file. */
function writeFallbackFile(file, data, fs = defaultFs) {
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/** Retry delay for a transient KV open failure (one retry). */
export const KV_OPEN_RETRY_MS = 50;

/**
 * Open the storage-hub KV unit through duck-typed dsh contracts (the hub
 * exposes `backend.get(name)`; a backend may carry a `kv` facet).
 *
 * Two failure classes are deliberately distinct:
 * - **no backend / no kv facet** — a composition without a storage plugin;
 *   the caller falls back to the 0600 file (normal degradation);
 * - **the KV backend exists but is unusable** (`backend.names()`/`get()` throws,
 *   or `kv.open` rejects) — retried once for `open`, then raised loudly.
 *   Silently switching to the file store here would split the association
 *   source of truth and let a reload auto-mount a second instance
 *   (`dsh-storage-json` keeps the first association invisible).
 */
async function openKvUnit(storage, options = {}) {
  const backends = storage?.backend;
  if (!backends || typeof backends.get !== "function") return null;
  const sleep = typeof options.sleep === "function"
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let names;
  try {
    names = typeof backends.names === "function" ? backends.names() : [];
  } catch (error) {
    // A registry that cannot even enumerate its backends is a *broken* storage,
    // not an absent one: silently treating it as "no backend" would fall back
    // to the file store and split the association source of truth — the same
    // failure family as a rejecting `kv.open` (review r3 P3-2).
    const detail = String(error?.message ?? error);
    options.onWarn?.(`stoa: 无法枚举关联存储后端（${detail}）；为避免关联源分裂，本次不回退到文件存储。`);
    throw new Error(
      `无法枚举 Stoa 关联存储后端（${detail}）。为避免关联源分裂，本次不回退到文件存储；请重试 /stoa（若持续失败，检查 dsh storage 后端）。`,
    );
  }
  const listed = Array.isArray(names) ? names : [];
  const ordered = [...listed.filter((name) => name === "json"), ...listed.filter((name) => name !== "json")];
  const failures = [];
  for (const name of ordered) {
    let backend = null;
    try {
      backend = backends.get(name);
    } catch (error) {
      // `get` failing for a listed backend is also a broken storage, never
      // evidence for "no backend at all" (see the names() branch above).
      failures.push({ name, error });
      continue;
    }
    const kv = backend?.kv;
    if (!kv || typeof kv.open !== "function") continue;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` — hyphenated names are rejected.
        return await kv.open({ name: "stoa_sessions", version: 1, tables: ["sessions"], hasGlobal: false });
      } catch (error) {
        lastError = error;
        if (attempt === 0) await sleep(KV_OPEN_RETRY_MS);
      }
    }
    failures.push({ name, error: lastError });
  }
  if (failures.length === 0) return null;
  const detail = failures.map(({ name, error }) => `${name}: ${String(error?.message ?? error)}`).join("; ");
  options.onWarn?.(`stoa: 关联存储打开失败（${detail}）；为避免关联源分裂，本次不回退到文件存储。`);
  throw new Error(
    `无法打开 Stoa 关联存储（${detail}）。为避免关联源分裂，本次不回退到文件存储；请重试 /stoa（若持续失败，检查 dsh storage 后端）。`,
  );
}

/**
 * Per-session association store. Prefers `ctx.storage` (mounted KV backend),
 * falls back to `$DSH_HOME/storages/stoa-sessions.json` (0600). Both forms keep
 * one in-memory map plus durable writes, and never log values.
 *
 * @param {{storage?: unknown, env?: Record<string, string|undefined>, homedir?: () => string,
 *          fs?: typeof defaultFs, onWarn?: (message: string) => void,
 *          sleep?: (ms: number) => Promise<void>}} [options]
 */
export async function createAssociationStore(options = {}) {
  const env = options.env ?? {};
  const fs = options.fs ?? defaultFs;
  const unit = await openKvUnit(options.storage, { onWarn: options.onWarn, sleep: options.sleep });
  if (unit) {
    let cache = {};
    try {
      const loaded = await unit.loadAll();
      const rows = loaded?.tables?.sessions;
      if (rows && typeof rows === "object") cache = { ...rows };
    } catch {
      cache = {};
    }
    return {
      kind: "storage",
      path: null,
      get(key) {
        return cache[key] ?? null;
      },
      async set(key, value) {
        cache[key] = value;
        await unit.putRecord("sessions", key, value);
      },
      list() {
        return Object.values(cache);
      },
      /**
       * Release the KV unit. `dsh-storage-json` rejects a second `open` while
       * one handle is live (`unit '…' is already open`), so a profile reload can
       * only read the association back if the previous host closed its unit.
       */
      async close() {
        try {
          await unit.close?.();
        } catch {
          /* teardown is best-effort; the backend also closes units on unmount */
        }
      },
    };
  }
  const file = join(resolveDshHome(env, options.homedir ?? osHomedir), ...FALLBACK_STORE_SEGMENTS);
  const cache = readFallbackFile(file);
  return {
    kind: "file",
    path: file,
    get(key) {
      return cache[key] ?? null;
    },
    async set(key, value) {
      cache[key] = value;
      writeFallbackFile(file, cache, fs);
    },
    list() {
      return Object.values(cache);
    },
    async close() {},
  };
}

/** JSON fetch with a bounded timeout; returns `{status, body}` (body may be null). */
async function requestJson(url, options = {}) {
  const fetchImpl = options.fetchImpl;
  const timers = options.timers ?? globalThis;
  const controller = new AbortController();
  const timer = timers.setTimeout(() => controller.abort(), options.timeoutMs ?? BOARD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = typeof response.text === "function" ? await response.text() : "";
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { ok: false, error: text.slice(0, 400) };
      }
    }
    return { status: response.status, ok: response.ok === true, body };
  } catch (error) {
    const cause = error instanceof Error && error.name === "AbortError"
      ? `request timed out after ${options.timeoutMs ?? BOARD_TIMEOUT_MS}ms`
      : String(error?.message ?? error);
    const wrapped = new Error(`${options.what ?? "request"} failed: ${cause}`);
    wrapped.cause = error;
    throw wrapped;
  } finally {
    timers.clearTimeout(timer);
  }
}

function daemonErrorBody(body) {
  if (body && typeof body.error === "string" && body.error) {
    const code = typeof body.code === "string" ? ` (${body.code})` : "";
    return `${body.error}${code}`;
  }
  return null;
}

/**
 * Daemon client: service list / mount / stop. Every failure is raised as a
 * readable Error whose message carries the next action.
 */
export function createDaemonClient(options = {}) {
  const baseUrl = (options.baseUrl ?? daemonBaseUrl(options.env)).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timers = options.timers ?? globalThis;
  const request = (path, init = {}) =>
    requestJson(`${baseUrl}${path}`, { fetchImpl, timers, what: `stoa daemon ${init.method ?? "GET"} ${path}`, ...init });

  return {
    baseUrl,
    /** `GET /api/daemon/services` → records. */
    async listServices() {
      const { ok, body, status } = await request("/api/daemon/services");
      if (!ok) throw new Error(daemonErrorBody(body) ?? `HTTP ${status} from /api/daemon/services`);
      return Array.isArray(body?.services) ? body.services : [];
    },
    /**
     * `POST /api/daemon/services` — idempotent reuse is the daemon's own contract
     * (same dataDir while running is adopted).
     * @param {{location?: string, name?: string, dataDir?: string}} mount
     */
    async mount(mount) {
      const payload = {};
      if (mount.dataDir) payload.dataDir = mount.dataDir;
      if (mount.location) payload.location = mount.location;
      if (mount.name) payload.name = mount.name;
      const { ok, body, status } = await request("/api/daemon/services", {
        method: "POST",
        body: payload,
        headers: { "content-type": "application/json", accept: "application/json" },
        timeoutMs: DAEMON_TIMEOUT_MS,
      });
      if (!ok || !body?.service) {
        throw new Error(daemonErrorBody(body) ?? `HTTP ${status} from POST /api/daemon/services`);
      }
      return { service: body.service, reused: body.reused === true, adopted: body.adopted === true, warnings: body.warnings ?? [] };
    },
    /** `POST /api/daemon/services/:id/stop`（保留登记与目录=daemon 语义）. */
    async stop(serviceId) {
      const { ok, body, status } = await request(`/api/daemon/services/${encodeURIComponent(serviceId)}/stop`, { method: "POST" });
      if (!ok) {
        const failure = new Error(daemonErrorBody(body) ?? `HTTP ${status} from stop ${serviceId}`);
        // Structured classification for callers: `/stoa off` treats 404
        // (NOT_FOUND) as "registration already gone = stopped" without
        // matching on message wording (review r3 P3-3).
        failure.status = status;
        failure.code = typeof body?.code === "string" ? body.code : null;
        throw failure;
      }
      return body?.service ?? null;
    },
  };
}

/**
 * Board (instance) client: one instance base URL + one account token, sent as
 * `Authorization: Bearer …`. Tokens never appear in errors — messages are
 * scrubbed before they are raised.
 */
export function createBoardClient(options = {}) {
  const baseUrl = String(options.baseUrl ?? "").replace(/\/+$/, "");
  const token = options.token ?? null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timers = options.timers ?? globalThis;
  const account = options.account ?? null;
  const secrets = [token].filter(Boolean);

  async function call(method, path, body, timeoutMs) {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (account) headers["x-report-account"] = account;
    if (body !== undefined) headers["content-type"] = "application/json";
    let outcome;
    try {
      outcome = await requestJson(`${baseUrl}${path}`, {
        fetchImpl,
        timers,
        method,
        body,
        headers,
        timeoutMs: timeoutMs ?? BOARD_TIMEOUT_MS,
        what: `stoa ${method} ${path.split("?")[0]}`,
      });
    } catch (error) {
      // Transport failures carry no credential by construction; scrub anyway so
      // an exotic fetch error can never surface a token.
      throw new Error(redactSecrets(String(error?.message ?? error), secrets));
    }
    const { ok, body: parsed, status } = outcome;
    if (!ok) {
      const detail = parsed && typeof parsed.error === "string" ? parsed.error : `HTTP ${status}`;
      const failure = new Error(redactSecrets(`${detail} (${method} ${path.split("?")[0]})`, secrets));
      // Callers classify on the HTTP status (409 = real id conflict, 401/403 =
      // auth) instead of guessing from message text.
      failure.status = status;
      failure.boardBody = parsed;
      throw failure;
    }
    return parsed ?? {};
  }

  return {
    baseUrl,
    account,
    /** Host-side only: needed to scrub error text; never serialized into results. */
    token,
    get: (path, timeoutMs) => call("GET", path, undefined, timeoutMs),
    post: (path, body, timeoutMs) => call("POST", path, body ?? {}, timeoutMs),
  };
}

/** Health probe (`GET /healthz` — no auth) with a short budget. */
export async function probeInstance(baseUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timers = options.timers ?? globalThis;
  try {
    const { ok, body } = await requestJson(`${String(baseUrl).replace(/\/+$/, "")}/healthz`, {
      fetchImpl,
      timers,
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      what: "stoa healthz probe",
    });
    if (!ok || !body) return null;
    return body;
  } catch {
    return null;
  }
}

function recordFromService(service, previous) {
  return {
    serviceId: String(service?.id ?? previous?.serviceId ?? ""),
    name: String(service?.name ?? previous?.name ?? ""),
    dataDir: String(service?.dataDir ?? previous?.dataDir ?? ""),
    baseUrl: String(service?.url ?? previous?.baseUrl ?? "").replace(/\/+$/, ""),
    publicUrl: service?.publicUrl ?? previous?.publicUrl ?? null,
    port: service?.port ?? previous?.port ?? null,
    createdAt: previous?.createdAt ?? Date.now(),
  };
}

/**
 * Instance manager: one instance per session, idempotent ensure, stop that
 * keeps the registration and data directory.
 *
 * The association store is resolved lazily (`ensureStore`) so the host opens
 * the KV unit only on the first `/stoa`, after every service is mounted — and
 * closes it on dispose, which is what lets a profile reload re-open the same
 * unit instead of falling back to a second (file) source of truth.
 *
 * @param {{
 *   store?: Awaited<ReturnType<typeof createAssociationStore>>,
 *   ensureStore?: () => Promise<Awaited<ReturnType<typeof createAssociationStore>>>,
 *   daemon: ReturnType<typeof createDaemonClient>,
 *   fetchImpl?: typeof fetch,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 * }} options
 */
export function createInstanceManager(options) {
  const ensureStore = typeof options.ensureStore === "function"
    ? options.ensureStore
    : async () => options.store;
  const daemon = options.daemon;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timers = options.timers ?? globalThis;
  const keyOf = (sessionId) => `${ASSOCIATION_PREFIX}${sessionId}`;

  async function mountFor(sessionId, previous, store) {
    const mount = previous && previous.dataDir
      ? { dataDir: previous.dataDir, name: previous.name || serviceNameFor(sessionId) }
      : { location: "auto", name: serviceNameFor(sessionId) };
    const outcome = await daemon.mount(mount);
    const record = recordFromService(outcome.service, previous);
    await store.set(keyOf(sessionId), record);
    return { record, reused: outcome.reused || outcome.adopted, mounted: !(outcome.reused || outcome.adopted), warnings: outcome.warnings };
  }

  return {
    /**
     * Ensure the session has one live instance. Repeat calls reuse the stored
     * association (a healthy instance is never re-mounted — S3-2 idempotency).
     * @returns {Promise<{record: object, reused: boolean, mounted: boolean, warnings: string[]}>}
     */
    async ensure(sessionId) {
      const store = await ensureStore();
      const previous = store.get(keyOf(sessionId));
      if (previous && previous.baseUrl) {
        const health = await probeInstance(previous.baseUrl, { fetchImpl, timers });
        if (health) return { record: previous, reused: true, mounted: false, warnings: [] };
      }
      return mountFor(sessionId, previous, store);
    },
    /** Read the stored association without any network call. */
    async get(sessionId) {
      const store = await ensureStore();
      return store.get(keyOf(sessionId));
    },
    /** Stop the session's instance; registration and data directory stay. */
    async stop(sessionId) {
      const store = await ensureStore();
      const record = store.get(keyOf(sessionId));
      if (!record || !record.serviceId) return { stopped: false, record: null };
      await daemon.stop(record.serviceId);
      return { stopped: true, record };
    },
    /** `POST /api/stream/ticket`-ready credential: manager token from the instance data dir. */
    async managerToken(sessionId) {
      const store = await ensureStore();
      const record = store.get(keyOf(sessionId));
      if (!record || !record.dataDir) return null;
      return readAccountToken(record.dataDir, "manager");
    },
  };
}

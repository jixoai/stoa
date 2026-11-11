/**
 * Host-half guard for the Stoa dsh session mode
 * (openspec change stoa-dsh-session-mode; tasks S3–S6, S7-2).
 *
 * Everything runs as plain node/bun modules with injected seams: no port is
 * opened, no dsh package is required, no network is touched. The five
 * lib/host modules and `index.js` are loaded through file URLs so TypeScript
 * never has to type plain ESM.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dir, "..");
const hostModule = <T = any>(name: string): Promise<T> =>
  import(pathToFileURL(join(root, "lib", "host", name)).href) as Promise<T>;
const rootModule = <T = any>(name: string): Promise<T> =>
  import(pathToFileURL(join(root, name)).href) as Promise<T>;

const session = await hostModule("session.js");
const accounts = await hostModule("accounts.js");
const watcherMod = await hostModule("watcher.js");
const toolsMod = await hostModule("tools.js");
const commandMod = await hostModule("command.js");
const namesMod = await hostModule<{ pickName: (options?: any) => { id: string; display: string } }>("../names.js");
const hostEntry = await rootModule("index.js");

const FAKE_TOKEN = "FAKE_TOKEN_do_not_leak_0123456789";
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** Every test gets its own `$DSH_HOME` so the fallback association store never
 * touches the developer's real `~/.dsh` and tests cannot see each other. */
const DSH_HOME = mkdtempSync(join(tmpdir(), "stoa-host-home-"));
let sessionCounter = 0;
const nextSessionId = () => `sess-${++sessionCounter}`;
/** Stand-in for `@deepseek-ai/dsh-llm#createUserMessage` (dsh-free tests). */
const createUserMessage = (input: any) => ({ id: `msg-${Math.random().toString(36).slice(2)}`, role: "user", ...input });

// ── fakes ────────────────────────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Route {
  match: RegExp;
  method?: string;
  respond: (call: Call) => unknown;
}

function jsonResponse(status: number, body: unknown): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

/** URL-routed fake fetch that records every call. */
function createFakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const impl = async (url: string, init: any = {}) => {
    const call: Call = {
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    for (const route of routes) {
      if (route.method && route.method !== call.method) continue;
      if (!route.match.test(call.url)) continue;
      const response = route.respond(call);
      if (response === undefined) throw new Error(`no fake response for ${call.url}`);
      return response;
    }
    throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
  };
  return { impl, calls, count: (pattern: RegExp, method?: string) => calls.filter((c) => pattern.test(c.url) && (!method || c.method === method)).length };
}

/** Poll a predicate across macrotask turns (bounded; watcher pumps are async). */
async function until(predicate: () => boolean, ticks = 100): Promise<boolean> {
  for (let tick = 0; tick < ticks; tick += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return predicate();
}

function createFakeTimers() {
  const queue: Array<{ id: number; fn: () => void; at: number }> = [];
  let nextId = 0;
  return {
    now: 0,
    setTimeout(fn: () => void, ms = 0) {
      const entry = { id: ++nextId, fn, at: this.now + ms };
      queue.push(entry);
      return entry.id;
    },
    clearTimeout(handle: number) {
      const index = queue.findIndex((entry) => entry.id === handle);
      if (index >= 0) queue.splice(index, 1);
    },
    pending: () => queue.length,
    runNext() {
      const entry = queue.shift();
      if (!entry) return false;
      this.now = entry.at;
      entry.fn();
      return true;
    },
    runAll() {
      while (this.runNext()) ;
    },
    /** Backoff sleeps collapse to one macrotask so reconnect loops yield. */
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

/** SSE response yields the given chunks, then keeps the connection open (or EOFs). */
function sseResponse(chunks: string[], options: { eof?: boolean } = {}) {
  const encoder = new TextEncoder();
  const pending = [...chunks];
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () => {
            if (pending.length > 0) return { value: encoder.encode(pending.shift()!), done: false };
            if (options.eof) return { value: undefined, done: true };
            return new Promise(() => {});
          },
        };
      },
    },
  };
}

function hubFrame(seq: number, line: Record<string, unknown>): string {
  return `event: hub\ndata: ${JSON.stringify({ seq, ...line })}\nid: ${seq}\n\n`;
}

function createLogger() {
  const lines: string[] = [];
  return {
    lines,
    info: (message: string) => lines.push(`info ${message}`),
    warn: (message: string) => lines.push(`warn ${message}`),
  };
}

/**
 * In-memory stand-in for `ctx.storage` + `dsh-storage-json`: a second `open`
 * of a unit that is still open rejects with the backend's own wording, and
 * `close()` releases it. `rows` survives close, so a "reload" can read back
 * exactly what the previous host wrote.
 */
function createFakeStorage() {
  const rows: Record<string, unknown> = {};
  const live = new Set<string>();
  const opened: string[] = [];
  const closed: string[] = [];
  const backend = {
    kv: {
      async open(descriptor: { name: string }) {
        if (live.has(descriptor.name)) {
          throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`);
        }
        live.add(descriptor.name);
        opened.push(descriptor.name);
        return {
          async loadAll() {
            return { tables: { sessions: { ...rows } }, global: null };
          },
          async putRecord(_table: string, key: string, value: unknown) {
            if (!live.has(descriptor.name)) throw new Error("closed");
            rows[key] = value;
          },
          async close() {
            live.delete(descriptor.name);
            closed.push(descriptor.name);
          },
        };
      },
    },
  };
  return {
    storage: { backend: { names: () => ["json"], get: () => backend } },
    rows,
    opened,
    closed,
    isOpen: () => live.has("stoa_sessions"),
  };
}

function createAgent(id: string, extra: Record<string, unknown> = {}) {
  const steered: any[] = [];
  return {
    id,
    steered,
    steer(message: any) {
      steered.push(message);
    },
    ...extra,
  };
}

/** Fake cordis context: captured registrations, services, lifecycle handlers. */
function createFakeContext(services: Record<string, unknown> = {}) {
  const commands: any[] = [];
  const tools: any[] = [];
  const effects: string[] = [];
  const handlers = new Map<string, ((...args: any[]) => void)[]>();
  const ctx = {
    services,
    get(name: string) {
      if (name === "commands" && services.commands === undefined) return { register: (definition: any) => commands.push(definition) };
      if (name === "tools" && services.tools === undefined) return { register: (definition: any) => tools.push(definition) };
      return (services as any)[name];
    },
    on(name: string, handler: (...args: any[]) => void) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {
        const current = handlers.get(name) ?? [];
        handlers.set(name, current.filter((entry) => entry !== handler));
      };
    },
    effect(run: () => unknown, label?: string) {
      effects.push(label ?? "");
      return run();
    },
    logger: { info: () => undefined, warn: () => undefined },
  };
  return { ctx, commands, tools, effects, handlers, emit: (name: string, ...args: any[]) => { for (const handler of handlers.get(name) ?? []) handler(...args); } };
}

/** Instance directory with the manager/child credentials the board hands out. */
function createInstanceDir(tokens: Record<string, string> = { manager: FAKE_TOKEN }) {
  const dir = mkdtempSync(join(tmpdir(), "stoa-host-test-"));
  mkdirSync(join(dir, "accounts"), { recursive: true, mode: 0o700 });
  for (const [accountId, token] of Object.entries(tokens)) {
    const upper = accountId.toUpperCase().replace(/-/g, "_");
    writeFileSync(join(dir, "accounts", `${accountId}.env`), `STOA_ACCOUNT=${accountId}\nSTOA_TOKEN_${upper}=${token}\n`, { mode: 0o600 });
  }
  return dir;
}

const ENV = { STOA_DAEMON_URL: "http://127.0.0.1:13679", DSH_HOME };

/** Shared host options: no real dsh, no real home, no real delays. Each host
 * gets its own `$DSH_HOME`, so per-session associations never leak between
 * tests even though they all use the same session id. */
function hostOptions(fetchImpl: any, log = createLogger(), timers = createFakeTimers()) {
  return {
    env: { ...ENV, DSH_HOME: mkdtempSync(join(tmpdir(), "stoa-host-home-")) },
    fetchImpl,
    timers,
    log,
    createUserMessage,
  };
}

/** Routes for a healthy mounted instance (daemon + board). */
function instanceRoutes(options: { dataDir: string; baseUrl?: string; ticket?: string; extra?: Route[] } = { dataDir: "" }) {
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:13680";
  const service = { id: "svc-1", name: "dsh-sess-1", dataDir: options.dataDir, url: baseUrl, publicUrl: null, port: 13680, status: "running" };
  const routes: Route[] = [
    { match: /\/healthz$/, respond: () => jsonResponse(200, { ok: true, dataDir: options.dataDir, url: baseUrl }) },
    { match: /\/api\/daemon\/services$/, method: "POST", respond: () => jsonResponse(200, { ok: true, service, reused: false, adopted: false, warnings: [] }) },
    { match: /\/api\/stream\/ticket$/, respond: () => jsonResponse(200, { ok: true, ticket: options.ticket ?? "ticket-1", expires_at: 0, ttl_ms: 60000 }) },
    { match: /\/api\/stream\?/, respond: () => sseResponse([`event: hello\ndata: ${JSON.stringify({ hub: 2, as_of_seq: 40, since: null })}\n\n`]) },
  ];
  return { routes: [...routes, ...(options.extra ?? [])], service, baseUrl };
}

// ── S3: command registration + parsing ───────────────────────────────────────

describe("/stoa command (S3)", () => {
  test("registers the dsh command shape (name/description/input/handler)", async () => {
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(async () => { throw new Error("no network"); }));
    try {
      expect(fake.commands).toHaveLength(1);
      const definition = fake.commands[0];
      expect(definition.name).toBe("stoa");
      expect(typeof definition.description).toBe("string");
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.input).toEqual({ hint: "[on|status|off] [subagents=on|off]" });
      expect(typeof definition.handler).toBe("function");
      expect(definition.recordInput).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  test("parses the grammar and rejects unknown/conflicting input", () => {
    expect(commandMod.parseStoaCommand("")).toEqual({ action: "on", subagents: null, error: null });
    expect(commandMod.parseStoaCommand("  ")).toEqual({ action: "on", subagents: null, error: null });
    expect(commandMod.parseStoaCommand("on")).toEqual({ action: "on", subagents: null, error: null });
    expect(commandMod.parseStoaCommand("status")).toEqual({ action: "status", subagents: null, error: null });
    expect(commandMod.parseStoaCommand("off")).toEqual({ action: "off", subagents: null, error: null });
    expect(commandMod.parseStoaCommand("subagents=off")).toEqual({ action: "on", subagents: "off", error: null });
    expect(commandMod.parseStoaCommand("on subagents=on")).toEqual({ action: "on", subagents: "on", error: null });
    expect(commandMod.parseStoaCommand("off subagents=off").subagents).toBe("off");
    expect(commandMod.parseStoaCommand("wat").error).toContain("未知参数");
    expect(commandMod.parseStoaCommand("subagents=maybe").error).toContain("未知参数");
    expect(commandMod.parseStoaCommand("on off").error).toContain("冲突");
  });

  test("a command handler result only carries {kind, text}", async () => {
    const dir = createInstanceDir();
    const { routes } = instanceRoutes({ dataDir: dir });
    const fakeFetch = createFakeFetch(routes);
    const fake = createFakeContext();
    const log = createLogger();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl, log));
    try {
      const agent = createAgent("sess-1");
      const result = await fake.commands[0].handler({ agent, rawInput: "status" });
      expect(Object.keys(result).sort()).toEqual(["kind", "text"]);
      expect(result.kind).toBe("success");
      expect(result.text).toContain("未启用");
    } finally {
      host.dispose();
    }
  });
});

// ── S3: instance association (idempotent) ────────────────────────────────────

describe("session instance association (S3)", () => {
  test("two /stoa calls mount one instance and reuse it", async () => {
    const dir = createInstanceDir();
    const { routes, baseUrl } = instanceRoutes({ dataDir: dir });
    const fakeFetch = createFakeFetch(routes);
    const fake = createFakeContext();
    const log = createLogger();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl, log));
    try {
      const agent = createAgent("sess-1");
      const first = await fake.commands[0].handler({ agent, rawInput: "" });
      expect(first.kind).toBe("success");
      expect(first.text).toContain(baseUrl);
      expect(first.text).toContain(dir);
      const second = await fake.commands[0].handler({ agent, rawInput: "on" });
      expect(second.kind).toBe("success");

      expect(fakeFetch.count(/\/api\/daemon\/services$/, "POST")).toBe(1);
      // The first call mounts (no probe); the second reuses through one /healthz probe.
      expect(fakeFetch.count(/\/healthz/)).toBe(1);
      expect(host.sessions.get("sess-1")?.record?.serviceId).toBe("svc-1");
    } finally {
      host.dispose();
    }
  });

  test("the storage-backed association survives close → re-open (dsh-json rejects double-open)", async () => {
    const fakeStorage = createFakeStorage();
    const env = { DSH_HOME: mkdtempSync(join(tmpdir(), "stoa-host-home-")) };
    const first = await session.createAssociationStore({ storage: fakeStorage.storage, env });
    try {
      expect(first.kind).toBe("storage");
      await first.set("stoa/session/sess-1", { serviceId: "svc-1", baseUrl: "http://127.0.0.1:13680" });
      expect(fakeStorage.isOpen()).toBe(true);
    } finally {
      await first.close();
    }
    expect(fakeStorage.closed).toEqual(["stoa_sessions"]);
    const second = await session.createAssociationStore({ storage: fakeStorage.storage, env });
    try {
      expect(second.kind).toBe("storage");
      expect(second.get("stoa/session/sess-1")).toEqual({ serviceId: "svc-1", baseUrl: "http://127.0.0.1:13680" });
    } finally {
      await second.close();
    }
  });

  test("a profile reload re-opens the same association and never mounts a second service", async () => {
    const dir = createInstanceDir();
    const fakeStorage = createFakeStorage();
    const fakeFetch = createFakeFetch(instanceRoutes({ dataDir: dir }).routes);
    const firstCtx = createFakeContext();
    firstCtx.ctx.services.storage = fakeStorage.storage;
    const firstHost = hostEntry.createStoaHost(firstCtx.ctx, hostOptions(fakeFetch.impl));
    // No /stoa yet: the KV unit must not be opened at construction.
    expect(fakeStorage.opened).toEqual([]);
    const first = await firstCtx.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "" });
    expect(first.kind).toBe("success");
    expect(fakeStorage.opened).toEqual(["stoa_sessions"]);
    await firstHost.dispose();
    expect(fakeStorage.isOpen()).toBe(false);
    // Reload: a fresh host over the same storage must reuse the association
    // rather than treating it as missing and mounting another instance.
    const secondCtx = createFakeContext();
    secondCtx.ctx.services.storage = fakeStorage.storage;
    const secondHost = hostEntry.createStoaHost(secondCtx.ctx, hostOptions(fakeFetch.impl));
    try {
      const second = await secondCtx.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "" });
      expect(second.kind).toBe("success");
      expect(fakeFetch.count(/\/api\/daemon\/services$/, "POST")).toBe(1);
      expect(secondHost.sessions.get("sess-1")?.record?.serviceId).toBe("svc-1");
      expect(fakeStorage.opened).toEqual(["stoa_sessions", "stoa_sessions"]);
    } finally {
      secondHost.dispose();
    }
  });

  test("concurrent /stoa invocations share one in-flight mount", async () => {
    const dir = createInstanceDir();
    const service = { id: "svc-1", name: "dsh-sess-1", dataDir: dir, url: "http://127.0.0.1:13680" };
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeFetch = createFakeFetch([
      {
        match: /\/api\/daemon\/services$/,
        method: "POST",
        respond: async () => {
          await gate;
          return jsonResponse(200, { ok: true, service, reused: false, adopted: false, warnings: [] });
        },
      },
      { match: /\/api\/stream\/ticket$/, respond: () => jsonResponse(200, { ok: true, ticket: "ticket-1" }) },
      { match: /\/api\/stream\?/, respond: () => sseResponse([`event: hello\ndata: ${JSON.stringify({ hub: 2, as_of_seq: 1 })}\n\n`]) },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const one = fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "" });
      const two = fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      const [first, second] = await Promise.all([one, two]);
      expect(first.kind).toBe("success");
      expect(second.kind).toBe("success");
      expect(fakeFetch.count(/\/api\/daemon\/services$/, "POST")).toBe(1);
    } finally {
      host.dispose();
    }
  });

  test("re-mounts with the stored dataDir when the instance is gone", async () => {
    const dir = createInstanceDir();
    let healthy = false;
    const mounted: any[] = [];
    const fakeFetch = createFakeFetch([
      { match: /\/healthz$/, respond: () => (healthy ? jsonResponse(200, { ok: true }) : jsonResponse(503, { ok: false })) },
      {
        match: /\/api\/daemon\/services$/,
        method: "POST",
        respond: (call) => {
          mounted.push(call.body);
          healthy = true;
          return jsonResponse(200, { ok: true, service: { id: "svc-1", name: "dsh-sess-1", dataDir: dir, url: "http://127.0.0.1:13680" }, reused: false });
        },
      },
      { match: /\/api\/stream\/ticket$/, respond: () => jsonResponse(200, { ok: true, ticket: "t" }) },
      { match: /\/api\/stream\?/, respond: () => sseResponse([`event: hello\ndata: ${JSON.stringify({ hub: 2, as_of_seq: 40, since: null })}\n\n`]) },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const agent = createAgent("sess-1");
      await fake.commands[0].handler({ agent, rawInput: "" });
      expect(mounted).toHaveLength(1);
      expect(mounted[0]).toEqual({ location: "auto", name: "dsh-sess-1" });
      // Instance died: the next /stoa re-mounts with the recorded directory.
      healthy = false;
      await fake.commands[0].handler({ agent, rawInput: "" });
      expect(mounted).toHaveLength(2);
      expect(mounted[1]).toEqual({ dataDir: dir, name: "dsh-sess-1" });
    } finally {
      host.dispose();
    }
  });

  test("daemon down reports the actionable reason and can be retried", async () => {
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:13679");
    }));
    try {
      const result = await fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "" });
      expect(result.kind).toBe("error");
      expect(result.text).toContain("stoa daemon start");
      expect(result.text).toContain("重试");
    } finally {
      host.dispose();
    }
  });

  test("/stoa off stops the instance but keeps the association", async () => {
    const dir = createInstanceDir();
    const stopped: string[] = [];
    const { routes } = instanceRoutes({ dataDir: dir });
    const fakeFetch = createFakeFetch([
      ...routes,
      {
        match: /\/api\/daemon\/services\/([^/]+)\/stop$/,
        method: "POST",
        respond: (call) => {
          stopped.push(call.url);
          return jsonResponse(200, { ok: true, service: { id: "svc-1", status: "stopped" } });
        },
      },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const agent = createAgent("sess-1");
      await fake.commands[0].handler({ agent, rawInput: "on" });
      expect(await until(() => host.sessions.get("sess-1")?.watcher?.status().state === "live")).toBe(true);

      const off = await fake.commands[0].handler({ agent, rawInput: "off" });
      expect(off.kind).toBe("success");
      expect(off.text).toContain("已关闭");
      expect(stopped).toEqual(["http://127.0.0.1:13679/api/daemon/services/svc-1/stop"]);
      const entry = host.sessions.get("sess-1");
      expect(entry?.enabled).toBe(false);
      expect(entry?.watcher).toBe(null);
      expect(entry?.record?.dataDir).toBe(dir);

      // Tool calls after /stoa off report the executable hint again.
      const specs = toolsMod.buildToolSpecs(makeRuntimeForTool(host, fake.ctx));
      const statusTool = specs.find((spec: any) => spec.name === "stoa_status");
      const output = JSON.parse(await statusTool.execute({}, { agent: { id: "sess-1" } }));
      expect(output.ok).toBe(false);
      expect(output.hint).toContain("先执行 /stoa");
    } finally {
      host.dispose();
    }
  });
});

// ── credentials discipline ───────────────────────────────────────────────────

describe("credential discipline", () => {
  test("token never appears in command results, tool results, or logs", async () => {
    const dir = createInstanceDir({ manager: FAKE_TOKEN });
    const { routes } = instanceRoutes({
      dataDir: dir,
      extra: [
        { match: /\/api\/notifications\?/, respond: () => jsonResponse(200, { ok: true, unread_count: 2 }) },
        { match: /\/api\/posts\/[^/]+$/, respond: () => jsonResponse(200, { ok: true, post: { id: "p1", body_md: "摘要正文" } }) },
      ],
    });
    const fakeFetch = createFakeFetch(routes);
    const fake = createFakeContext();
    const log = createLogger();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl, log));
    try {
      const agent = createAgent("sess-1");
      const result = await fake.commands[0].handler({ agent, rawInput: "on" });
      const specs = toolsMod.buildToolSpecs(makeRuntimeForTool(host, fake.ctx));
      const statusTool = specs.find((spec: any) => spec.name === "stoa_status");
      const toolOutput = await statusTool.execute({}, { agent: { id: "sess-1" } });
      const everything = [result.text, toolOutput, ...log.lines].join("\n");
      expect(everything).not.toContain(FAKE_TOKEN);
      expect(JSON.parse(toolOutput).account).toBe("manager");
      expect(fakeFetch.calls.every((call) => call.headers.authorization === undefined || call.headers.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
    } finally {
      host.dispose();
    }
  });

  test("stoa_status scrubs injection.lastError before it reaches the model", async () => {
    const dir = createInstanceDir({ manager: FAKE_TOKEN });
    const { routes } = instanceRoutes({
      dataDir: dir,
      extra: [{ match: /\/api\/notifications\?/, respond: () => jsonResponse(200, { ok: true, unread_count: 0 }) }],
    });
    const fakeFetch = createFakeFetch(routes);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const agent = createAgent("sess-1");
      await fake.commands[0].handler({ agent, rawInput: "on" });
      const entry = host.sessions.get("sess-1");
      entry.watcher.status = () => ({ state: "backoff", lastSeq: 3, lastError: `bad token ${FAKE_TOKEN}` });
      const specs = toolsMod.buildToolSpecs(host.runtime);
      const statusTool = specs.find((spec: any) => spec.name === "stoa_status");
      const output = await statusTool.execute({}, { agent });
      expect(output).not.toContain(FAKE_TOKEN);
      expect(JSON.parse(output).injection.lastError).toContain("***");
    } finally {
      host.dispose();
    }
  });

  test("board errors echoing a credential are scrubbed", async () => {
    const board = session.createBoardClient({
      baseUrl: "http://127.0.0.1:13680",
      token: FAKE_TOKEN,
      fetchImpl: async () => jsonResponse(401, { ok: false, error: `bad token ${FAKE_TOKEN}` }),
    });
    const error = await board.get("/api/accounts").then(
      () => null,
      (thrown: Error) => thrown,
    );
    expect(error?.message).not.toContain(FAKE_TOKEN);
    expect(error?.message).toContain("***");
    expect(session.redactSecrets(`x ${FAKE_TOKEN} y`, [FAKE_TOKEN])).toBe("x *** y");
  });

  test("the manager token file is read as 0600 and never cached outside memory", () => {
    const dir = createInstanceDir();
    const file = join(dir, "accounts", "manager.env");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(session.readAccountToken(dir, "manager")).toBe(FAKE_TOKEN);
    expect(session.readAccountToken(dir, "missing")).toBe(null);
  });

  test("an auth-mode instance without a manager token fails loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stoa-host-test-empty-"));
    const { routes } = instanceRoutes({ dataDir: dir });
    const fakeFetch = createFakeFetch([
      ...routes,
      { match: /\/api\/auth\/status$/, respond: () => jsonResponse(200, { ok: true, mode: "auth" }) },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const result = await fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "" });
      expect(result.kind).toBe("error");
      expect(result.text).toContain("manager 凭据");
    } finally {
      host.dispose();
    }
  });
});

// ── S6: marker parsing + naming + subagent identity ──────────────────────────

describe("subagent identities (S6)", () => {
  test("marker parsing takes the first legal id and ignores illegal ones", () => {
    expect(accounts.parseStoaMarker("任务 [[stoa:lin-xiaoman]] 完成")).toBe("lin-xiaoman");
    expect(accounts.parseStoaMarker("[[stoa:Bad]] [[stoa:zi-2]]")).toBe("zi-2");
    expect(accounts.parseStoaMarker("[[stoa:]] [[stoa:UPPER]] [[stoa:bad!]]")).toBe(null);
    expect(accounts.parseStoaMarker("没有标记")).toBe(null);
    expect(accounts.parseStoaMarker(null)).toBe(null);
    expect(accounts.slugifyAccountId("Lin XiaoMan")).toBe("lin-xiaoman");
    expect(accounts.slugifyAccountId("!!!")).toBe(null);
  });

  test("reserved identities are rejected as subagent ids and never read a token", async () => {
    expect(() => accounts.parseStoaMarker("[[stoa:owner]]")).toThrow("保留身份");
    expect(() => accounts.parseStoaMarker("[[stoa:manager]]")).toThrow("保留身份");
    expect(accounts.parseStoaMarker("[[stoa:owner]] [[stoa:zi-2]]")).toBe("zi-2");
    const dir = createInstanceDir({ manager: FAKE_TOKEN });
    const reads: string[] = [];
    const boardCalls: string[] = [];
    const board = {
      get: async (url: string) => {
        boardCalls.push(url);
        return { accounts: [] };
      },
      post: async (url: string) => {
        boardCalls.push(url);
        throw new Error("must not create a reserved account");
      },
    };
    const manager = accounts.createAccountManager({
      board,
      dataDir: dir,
      readFile: (path: string) => {
        reads.push(path);
        throw new Error("must not read a token");
      },
    });
    for (const id of ["owner", "manager"]) {
      const markerError = await manager.ensureSubagentAccount({ markerId: id }).then(
        () => null,
        (error: Error) => error,
      );
      expect(markerError?.message).toContain("保留身份");
    }
    const namedError = await manager.ensureSubagentAccount({ name: "Manager" }).then(
      () => null,
      (error: Error) => error,
    );
    expect(namedError?.message).toContain("保留身份");
    const openedError = await manager.openAccount({ name: "owner" }).then(
      () => null,
      (error: Error) => error,
    );
    expect(openedError?.message).toContain("保留身份");
    expect(await manager.find("manager")).toBe(null);
    expect(reads).toEqual([]);
    expect(boardCalls).toEqual([]);
  });

  test("account creation classifies 403 as auth and only 409 as a name conflict", async () => {
    const dir = createInstanceDir();
    const authFetch = createFakeFetch([
      { match: /\/api\/accounts$/, method: "GET", respond: () => jsonResponse(200, { ok: true, accounts: [] }) },
      { match: /\/api\/accounts$/, method: "POST", respond: () => jsonResponse(403, { ok: false, error: "forbidden" }) },
    ]);
    const authBoard = session.createBoardClient({ baseUrl: "http://127.0.0.1:13680", token: "t", fetchImpl: authFetch.impl });
    const authManager = accounts.createAccountManager({ board: authBoard, dataDir: dir, readFile: (path: string) => readFileSync(path, "utf8") });
    const authError = await authManager.ensureSubagentAccount({}).then(
      () => null,
      (error: Error) => error,
    );
    expect(authError?.message).toContain("鉴权失败");
    expect(authError?.message).toContain("403");
    expect(authFetch.count(/\/api\/accounts$/, "POST")).toBe(1);

    const conflictFetch = createFakeFetch([
      { match: /\/api\/accounts$/, method: "GET", respond: () => jsonResponse(200, { ok: true, accounts: [] }) },
      { match: /\/api\/accounts$/, method: "POST", respond: () => jsonResponse(409, { ok: false, error: "account already exists" }) },
    ]);
    const conflictBoard = session.createBoardClient({ baseUrl: "http://127.0.0.1:13680", token: "t", fetchImpl: conflictFetch.impl });
    const conflictManager = accounts.createAccountManager({ board: conflictBoard, dataDir: dir });
    const conflictError = await conflictManager.ensureSubagentAccount({}).then(
      () => null,
      (error: Error) => error,
    );
    expect(conflictError?.message).toContain("could not allocate");
    expect(conflictFetch.count(/\/api\/accounts$/, "POST")).toBe(5);
  });

  test("a subagent with a marker posts as that account, a plain one auto-names", async () => {
    const dir = createInstanceDir();
    const childMarker = "yuanqi";
    writeFileSync(join(dir, "accounts", `${childMarker}.env`), `STOA_TOKEN_${childMarker.toUpperCase()}=child-token-marker\n`, { mode: 0o600 });
    const created: any[] = [];
    const { routes } = instanceRoutes({
      dataDir: dir,
      extra: [
        { match: /\/api\/accounts$/, method: "GET", respond: () => jsonResponse(200, { ok: true, accounts: [{ id: "manager", display: "manager" }, { id: childMarker, display: "元气" }] }) },
        {
          match: /\/api\/accounts$/,
          method: "POST",
          respond: (call) => {
            created.push(call.body);
            const id = (call.body as any).id as string;
            const file = join(dir, "accounts", `${id}.env`);
            writeFileSync(file, `STOA_TOKEN_${id.toUpperCase().replace(/-/g, "_")}=auto-token-${id}\n`, { mode: 0o600 });
            return jsonResponse(201, { ok: true, account: { id }, env_file: file });
          },
        },
        { match: /\/api\/posts$/, method: "POST", respond: () => jsonResponse(201, { ok: true, posts: [{ id: "post-1", author: "x", body_md: "hi" }] }) },
      ],
    });
    const fakeFetch = createFakeFetch(routes);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const parentAgent = createAgent("sess-1");
      await fake.commands[0].handler({ agent: parentAgent, rawInput: "on" });

      const childAgent = createAgent("child-1", {
        session: { ownEvents: () => [{ type: "user/message", data: { content: [{ type: "text", text: `请分析 [[stoa:${childMarker}]]` }] } }] },
      });
      fake.ctx.services.agents = { get: (id: string) => (id === "child-1" ? childAgent : undefined) };
      fake.emit("subagent/start", { runId: "run-1", id: "child-1", parentSessionId: "sess-1", provider: "local", local: true });

      const runtime = host.runtime;
      const context = await runtime.callContextFor("child-1");
      expect(context?.accountId).toBe(childMarker);
      expect(context?.dataDir).toBe(dir);
      expect(created).toHaveLength(0); // marker reuse must not create an account

      const specs = toolsMod.buildToolSpecs(runtime);
      const postTool = specs.find((spec: any) => spec.name === "stoa_post");
      const output = JSON.parse(await postTool.execute({ body: "hello" }, { agent: childAgent }));
      expect(output.ok).toBe(true);
      expect(output.as).toBe(childMarker);
      const postCall = fakeFetch.calls.filter((call) => /\/api\/posts$/.test(call.url) && call.method === "POST").at(-1);
      expect(postCall?.headers["x-report-account"]).toBe(childMarker);
      expect(postCall?.headers.authorization).toBe("Bearer child-token-marker");
      expect(JSON.stringify(output)).not.toContain("child-token-marker");

      // A marker-less child gets a pool name (auto-created).
      const plainAgent = createAgent("child-2", { session: { ownEvents: () => [{ type: "user/message", data: { content: [{ type: "text", text: "没有标记" }] } }] } });
      fake.ctx.services.agents = { get: (id: string) => (id === "child-2" ? plainAgent : undefined) };
      fake.emit("subagent/start", { runId: "run-2", id: "child-2", parentSessionId: "sess-1" });
      const plain = await runtime.callContextFor("child-2");
      expect(plain?.accountId).toMatch(ID_RE);
      expect(created).toHaveLength(1);
      expect((created[0] as any).id).toBe(plain?.accountId);
      expect((created[0] as any).display.length).toBeGreaterThan(0);

      // subagents=off stops auto-naming for a registered child (still registered).
      await fake.commands[0].handler({ agent: parentAgent, rawInput: "subagents=off" });
      await expect(runtime.callContextFor("child-2" as any)).rejects.toThrow("已关闭子代理自动开号");
      // subagent/end forgets the registration: a stale child falls back to the /stoa hint.
      fake.emit("subagent/end", { runId: "run-2", id: "child-2", parentSessionId: "sess-1" });
      expect(await runtime.callContextFor("child-2" as any)).toBe(null);
    } finally {
      host.dispose();
    }
  });

  test("stoa_open_account from a subagent resolves the owner instance instead of throwing", async () => {
    const dir = createInstanceDir();
    const created: any[] = [];
    const { routes } = instanceRoutes({
      dataDir: dir,
      extra: [
        { match: /\/api\/accounts$/, method: "GET", respond: () => jsonResponse(200, { ok: true, accounts: [] }) },
        {
          match: /\/api\/accounts$/,
          method: "POST",
          respond: (call) => {
            created.push(call.body);
            const id = (call.body as any).id as string;
            const file = join(dir, "accounts", `${id}.env`);
            writeFileSync(file, `STOA_TOKEN_${id.toUpperCase().replace(/-/g, "_")}=child-opened-token-123\n`, { mode: 0o600 });
            return jsonResponse(201, { ok: true, account: { id }, env_file: file });
          },
        },
      ],
    });
    const fakeFetch = createFakeFetch(routes);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      await fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "on" });
      fake.emit("subagent/start", { runId: "run-1", id: "child-1", parentSessionId: "sess-1" });
      const specs = toolsMod.buildToolSpecs(host.runtime);
      const openTool = specs.find((spec: any) => spec.name === "stoa_open_account");
      const output = JSON.parse(await openTool.execute({ name: "helper" }, { agent: createAgent("child-1") }));
      expect(output).toEqual({ ok: true, id: "helper", display: "helper", marker: "[[stoa:helper]]" });
      expect(created).toEqual([{ id: "helper", display: "helper" }]);
      expect(fakeFetch.calls.filter((call) => /\/api\/accounts$/.test(call.url) && call.method === "POST")[0]?.url.startsWith("http://127.0.0.1:13680")).toBe(true);
    } finally {
      host.dispose();
    }
  });

  test("marker lookup prefers sessionQuery.readSession and skips the inherited prefix", async () => {
    const dir = createInstanceDir();
    const { routes } = instanceRoutes({
      dataDir: dir,
      extra: [
        { match: /\/api\/accounts$/, method: "GET", respond: () => jsonResponse(200, { ok: true, accounts: [] }) },
        {
          match: /\/api\/accounts$/,
          method: "POST",
          respond: (call) => {
            const id = (call.body as any).id as string;
            const file = join(dir, "accounts", `${id}.env`);
            writeFileSync(file, `STOA_TOKEN_${id.toUpperCase().replace(/-/g, "_")}=marker-token-${id}\n`, { mode: 0o600 });
            return jsonResponse(201, { ok: true, account: { id }, env_file: file });
          },
        },
      ],
    });
    const fakeFetch = createFakeFetch(routes);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      await fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "on" });
      const readCalls: string[] = [];
      fake.ctx.services.sessionQuery = {
        readSession: async (id: string) => {
          readCalls.push(id);
          return {
            inheritedEventCount: 1,
            events: [
              { type: "user/message", data: { content: [{ type: "text", text: "父会话提示 [[stoa:from-parent]]" }] } },
              { type: "user/message", data: { content: [{ type: "text", text: "任务 [[stoa:from-session-query]]" }] } },
            ],
          };
        },
      };
      const fromQuery = createAgent("child-sq", {
        session: {
          ownEvents: () => [{ type: "user/message", data: { content: [{ type: "text", text: "[[stoa:from-own-events]]" }] } }],
        },
      });
      fake.ctx.services.agents = { get: (id: string) => (id === "child-sq" ? fromQuery : undefined) };
      fake.emit("subagent/start", { runId: "run-a", id: "child-sq", parentSessionId: "sess-1" });
      const context = await host.runtime.callContextFor("child-sq");
      expect(readCalls).toEqual(["child-sq"]);
      expect(context?.accountId).toBe("from-session-query");

      // A throwing readSession (persistence lag / replay rejection) falls back
      // to the live ownEvents read.
      fake.ctx.services.sessionQuery = { readSession: async () => { throw new Error("replay validation failed"); } };
      const fallbackAgent = createAgent("child-own", {
        session: {
          ownEvents: () => [{ type: "user/message", data: { content: [{ type: "text", text: "[[stoa:from-own-events]]" }] } }],
        },
      });
      fake.ctx.services.agents = { get: (id: string) => (id === "child-own" ? fallbackAgent : undefined) };
      fake.emit("subagent/start", { runId: "run-b", id: "child-own", parentSessionId: "sess-1" });
      const fallback = await host.runtime.callContextFor("child-own");
      expect(fallback?.accountId).toBe("from-own-events");
    } finally {
      host.dispose();
    }
  });

  test("stoa_open_account pre-opens an explicit account and returns its marker", async () => {
    const dir = createInstanceDir();
    const { routes } = instanceRoutes({
      dataDir: dir,
      extra: [
        { match: /\/api\/accounts$/, method: "GET", respond: () => jsonResponse(200, { ok: true, accounts: [] }) },
        {
          match: /\/api\/accounts$/,
          method: "POST",
          respond: (call) => {
            const id = (call.body as any).id as string;
            const file = join(dir, "accounts", `${id}.env`);
            writeFileSync(file, `STOA_TOKEN_${id.toUpperCase().replace(/-/g, "_")}=preopened-token-123456\n`, { mode: 0o600 });
            return jsonResponse(201, { ok: true, account: { id }, env_file: file });
          },
        },
      ],
    });
    const fakeFetch = createFakeFetch(routes);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const agent = createAgent("sess-1");
      await fake.commands[0].handler({ agent, rawInput: "on" });
      const specs = toolsMod.buildToolSpecs(host.runtime);
      const openTool = specs.find((spec: any) => spec.name === "stoa_open_account");
      const output = JSON.parse(await openTool.execute({ name: "Lin XiaoMan", display: "林小满" }, { agent }));
      expect(output).toEqual({ ok: true, id: "lin-xiaoman", display: "林小满", marker: "[[stoa:lin-xiaoman]]" });
    } finally {
      host.dispose();
    }
  });
});

// ── S4: tool specs ───────────────────────────────────────────────────────────

function makeRuntimeForTool(host: any, _ctx: any) {
  return host.runtime;
}

describe("session tools (S4)", () => {
  test("registers defineTool-ready specs with descriptions and parameter schemas", () => {
    const registered: any[] = [];
    const outcome = toolsMod.registerStoaTools({
      tools: { register: (definition: any) => registered.push(definition) },
      defineTool: (spec: any) => spec,
      runtime: {},
      log: createLogger(),
    });
    expect(outcome.error).toBe(null);
    expect(outcome.registered).toEqual(["stoa_post", "stoa_reply", "stoa_read", "stoa_status", "stoa_open_account"]);
    expect(registered.map((spec) => spec.name)).toEqual(toolsMod.TOOL_NAMES);
    for (const spec of registered) {
      expect(typeof spec.description).toBe("string");
      expect(spec.description.length).toBeGreaterThan(10);
      expect(spec.output.schema.type).toBe("string");
      const rendered = spec.output.render({}, "hello");
      expect(rendered).toEqual([{ type: "text", text: "hello" }]);
    }
    const reply = registered.find((spec) => spec.name === "stoa_reply");
    expect(reply.parameters.post_id.required).toBe(true);
    expect(reply.parameters.post_id.type).toBe("string");
    expect(reply.parameters.body.required).toBe(true);
    const read = registered.find((spec) => spec.name === "stoa_read");
    expect(read.parameters.limit.type).toBe("integer");
    expect(read.parameters.thread.type).toBe("string");
  });

  test("tools answer with the /stoa hint when the session never enabled the mode", async () => {
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(async () => { throw new Error("no network"); }));
    try {
      const specs = toolsMod.buildToolSpecs(host.runtime);
      for (const name of ["stoa_post", "stoa_reply", "stoa_read", "stoa_status", "stoa_open_account"]) {
        const spec = specs.find((entry: any) => entry.name === name);
        const output = JSON.parse(await spec.execute({ body: "x", post_id: "p" }, { agent: { id: "sess-unused" } }));
        expect(output.ok).toBe(false);
        expect(output.hint).toContain("先执行 /stoa");
      }
    } finally {
      host.dispose();
    }
  });

  test("a missing tools service or defineTool degrades to a readable error", async () => {
    const fake = createFakeContext({ tools: null });
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(async () => { throw new Error("no network"); }));
    const state = await host.toolsReady;
    expect(state.registered).toEqual([]);
    expect(state.error).toContain("ctx.tools");
    expect(host.command.registered).toBe(true);
    host.dispose();
  });

  test("stoa_post/stoa_reply hit this session's instance with the caller identity", async () => {
    const dir = createInstanceDir();
    const { baseUrl } = instanceRoutes({ dataDir: dir });
    const fakeFetch = createFakeFetch([
      ...instanceRoutes({ dataDir: dir }).routes,
      { match: /\/api\/posts$/, method: "POST", respond: () => jsonResponse(201, { ok: true, posts: [{ id: "post-9", author: "manager", body_md: "body" }] }) },
      { match: /\/api\/posts\/([^/]+)\/replies$/, method: "POST", respond: () => jsonResponse(201, { ok: true, posts: [{ id: "reply-1", author: "manager", parent_id: "post-9" }] }) },
      { match: /\/api\/read\?/, respond: () => jsonResponse(200, { ok: true, posts: [{ id: "post-9", author: "manager", body_md: "body" }] }) },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const agent = createAgent("sess-1");
      await fake.commands[0].handler({ agent, rawInput: "on" });
      const specs = toolsMod.buildToolSpecs(host.runtime);
      const post = JSON.parse(await specs.find((s: any) => s.name === "stoa_post").execute({ body: "hello", tags: ["result"] }, { agent }));
      expect(post.ok).toBe(true);
      expect(post.as).toBe("manager");
      expect(post.posts[0].id).toBe("post-9");
      const postCall = fakeFetch.calls.find((call) => /\/api\/posts$/.test(call.url));
      expect(postCall?.url.startsWith(baseUrl)).toBe(true);
      expect(postCall?.body).toEqual({ body: "hello", kind: "note", quote: null, media: [], tags: ["result"] });
      expect(postCall?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      // Manager identity is always declared: open mode needs it to keep the
      // manager's own posts out of the notification stream; auth mode ignores
      // the header and uses the bearer token (`src/server/auth.ts:109-146`).
      expect(postCall?.headers["x-report-account"]).toBe("manager");

      const reply = JSON.parse(await specs.find((s: any) => s.name === "stoa_reply").execute({ post_id: "post-9", body: "ack" }, { agent }));
      expect(reply.ok).toBe(true);
      expect(reply.parent).toBe("post-9");

      const read = JSON.parse(await specs.find((s: any) => s.name === "stoa_read").execute({ limit: 5 }, { agent }));
      expect(read.ok).toBe(true);
      expect(read.posts).toHaveLength(1);
    } finally {
      host.dispose();
    }
  });
});

// ── S5: SSE watcher ──────────────────────────────────────────────────────────

describe("SSE parser and injection (S5)", () => {
  test("parses frames across chunk boundaries and ignores comments", () => {
    const parser = watcherMod.createSseParser();
    expect(parser.push(": ping\n\n")).toEqual([]);
    const head = parser.push("event: hub\ndata: {\"seq\":1");
    expect(head).toEqual([]);
    const frames = parser.push(",\"type\":\"post.created\"}\nid: 1\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("hub");
    expect(JSON.parse(frames[0].data)).toEqual({ seq: 1, type: "post.created" });
    expect(watcherMod.parseSseBlock("event: hello\ndata: {\"hub\":2}")).toEqual({ event: "hello", id: null, data: "{\"hub\":2}" });
    expect(watcherMod.parseSseBlock("data: a\ndata: b")).toEqual({ event: "message", id: null, data: "a\nb" });
  });

  test("classifies the board's notification semantics", () => {
    expect(watcherMod.classifyEvent({ seq: 1, type: "post.created", actor: "lin", payload: { reply_to_account_id: "manager" } }, "manager").kind).toBe("reply");
    expect(watcherMod.classifyEvent({ seq: 2, type: "post.created", actor: "lin", payload: { parent_id: "p", reply_to_account_id: "other" } }, "manager").kind).toBe("post");
    expect(watcherMod.classifyEvent({ seq: 3, type: "post.created", actor: "lin", payload: { parent_id: "p" } }, "manager").kind).toBe("thread");
    expect(watcherMod.classifyEvent({ seq: 4, type: "post.created", actor: "lin", payload: { quoted_post_id: "q" } }, "manager").kind).toBe("quote");
    expect(watcherMod.classifyEvent({ seq: 5, type: "thread.invited", actor: "lin", payload: { post_id: "p" } }, "manager").kind).toBe("mention");
    expect(watcherMod.classifyEvent({ seq: 6, type: "thread.invited", actor: "lin", payload: { post_id: "p", via: "quote" } }, "manager").kind).toBe("quote");
    expect(watcherMod.classifyEvent({ seq: 7, type: "post.created", actor: "manager" }, "manager")).toBe(null);
    expect(watcherMod.classifyEvent({ seq: 8, type: "post.deleted", actor: "lin" }, "manager")).toBe(null);
    expect(watcherMod.classifyEvent({ seq: 9, type: "post.created", actor: "lin", post_deleted: true }, "manager")).toBe(null);
  });

  test("two frames merge into one injection; duplicate seq does not re-inject", async () => {
    const timers = createFakeTimers();
    const injected: Array<{ text: string; items: any[] }> = [];
    const board = {
      get: async () => ({ post: { body_md: "摘要正文 ".repeat(80) } }),
      post: async () => ({ ok: true, ticket: "ticket-1" }),
    };
    const frames = [
      hubFrame(11, { type: "post.created", actor: "林小满", post_id: "01M7ABC", payload: { reply_to_account_id: "manager" } }),
      hubFrame(12, { type: "thread.invited", actor: "小满", post_id: "01M7ABD", payload: { post_id: "01M7ABD" } }),
      hubFrame(12, { type: "thread.invited", actor: "小满", post_id: "01M7ABD", payload: { post_id: "01M7ABD" } }),
    ];
    const watcher = watcherMod.createWatcher({
      baseUrl: "http://127.0.0.1:13680",
      board,
      selfId: "manager",
      fetchImpl: async () => sseResponse([frames.join("")]),
      timers,
      log: createLogger(),
      inject: (text: string, items: any[]) => injected.push({ text, items }),
      excerpt: async (_item: any, postId: string) => `${postId} 的正文`.repeat(50),
    });
    watcher.start();
    for (let tick = 0; tick < 20 && injected.length === 0; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      timers.runAll();
    }
    expect(injected).toHaveLength(1);
    const batch = injected[0]!;
    expect(batch.items).toHaveLength(2);
    expect(batch.text).toContain("[Stoa · 2 条新消息]");
    expect(batch.text).toContain("[回复你] 林小满 #01M7ABC");
    expect(batch.text).toContain("[提到了你] 小满 #01M7ABD");
    expect(batch.text).toContain("需要回应时用 stoa_reply");
    expect(watcher.status().lastSeq).toBe(12);
    expect(watcher.status().events).toBe(2);

    // Replay of the same frames (a hub that redelivers) must not re-inject.
    watcher.acceptLine({ seq: 12, type: "thread.invited", actor: "小满", post_id: "01M7ABD", payload: {} });
    watcher.acceptLine({ seq: 13, type: "post.created", actor: "manager", post_id: "01M7ABE", payload: {} });
    timers.runAll();
    expect(injected).toHaveLength(1);
    expect(watcher.status().lastSeq).toBe(13);

    watcher.stop();
    watcher.acceptLine({ seq: 14, type: "post.created", actor: "林小满", post_id: "01M7ABF", payload: { reply_to_account_id: "manager" } });
    timers.runAll();
    expect(injected).toHaveLength(1);
  });

  test("first connect starts at the tip and resume asks for the cursor", async () => {
    const timers = createFakeTimers();
    const streamUrls: string[] = [];
    const board = { get: async () => ({ post: null }), post: async () => ({ ok: true, ticket: "ticket-1" }) };
    let first = true;
    const watcher = watcherMod.createWatcher({
      baseUrl: "http://127.0.0.1:13680",
      board,
      selfId: "manager",
      fetchImpl: async (url: string) => {
        streamUrls.push(String(url));
        if (first) {
          first = false;
          return sseResponse(
            [
              `event: hello\ndata: ${JSON.stringify({ hub: 2, as_of_seq: 41, since: null })}\n\n`,
              `event: hub\ndata: ${JSON.stringify({ seq: 42, type: "post.created", actor: "林小满", post_id: "p1", payload: { reply_to_account_id: "manager" } })}\nid: 42\n\n`,
            ],
            { eof: true },
          );
        }
        return sseResponse([`event: heartbeat\ndata: ${JSON.stringify({ as_of_seq: 42 })}\n\n`]);
      },
      timers,
      log: createLogger(),
      inject: () => undefined,
    });
    watcher.start();
    for (let tick = 0; tick < 40 && !streamUrls.some((url) => url.includes("since=42")); tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // First connect carries no cursor (the hub starts at the tip); the reconnect
    // after the stream ended resumes from the delivered watermark.
    expect(streamUrls[0]).not.toContain("since=");
    expect(streamUrls.some((url) => url.includes("since=42"))).toBe(true);
    expect(watcher.status().lastSeq).toBe(42);
    watcher.stop();
  });

  test("unreachable instance backs off without writing to stdout", async () => {
    const timers = createFakeTimers();
    const log = createLogger();
    const stdoutWrites: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
      stdoutWrites.push(String(chunk));
      return originalWrite(chunk, ...rest);
    };
    try {
      const watcher = watcherMod.createWatcher({
        baseUrl: "http://127.0.0.1:13680",
        board: { get: async () => ({}), post: async () => { throw new Error("connect ECONNREFUSED"); } },
        selfId: "manager",
        fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); },
        timers,
        log,
        inject: () => undefined,
      });
      watcher.start();
      for (let tick = 0; tick < 10; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(watcher.status().state).toBe("backoff");
      expect(log.lines.filter((line) => line.startsWith("warn"))).toHaveLength(1);
      expect(watcher.status().lastError).toContain("ECONNREFUSED");
      watcher.stop();
    } finally {
      (process.stdout as any).write = originalWrite;
    }
    expect(stdoutWrites.join("")).not.toContain("stoa");
  });
});

  test("stop() clears the armed backoff timer (no wake-up after dispose)", async () => {
    const timers: any = createFakeTimers();
    delete timers.sleep;
    const watcher = watcherMod.createWatcher({
      baseUrl: "http://127.0.0.1:13680",
      board: { get: async () => ({}), post: async () => { throw new Error("connect ECONNREFUSED"); } },
      selfId: "manager",
      fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); },
      timers,
      log: createLogger(),
      inject: () => undefined,
    });
    watcher.start();
    for (let tick = 0; tick < 10 && watcher.status().state !== "backoff"; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(watcher.status().state).toBe("backoff");
    expect(timers.pending()).toBe(1);
    watcher.stop();
    expect(timers.pending()).toBe(0);
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(watcher.status().state).toBe("stopped");
  });

  test("a throwing steer (disposed agent) is contained and the watcher keeps trying", async () => {
    const dir = createInstanceDir();
    const timers = createFakeTimers();
    const fakeFetch = createFakeFetch([
      ...instanceRoutes({ dataDir: dir }).routes,
      { match: /\/api\/posts\/p\d+$/, respond: () => jsonResponse(200, { ok: true, post: { id: "p1", body_md: "正文" } }) },
    ]);
    const fake = createFakeContext();
    const log = createLogger();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl, log, timers));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let attempts = 0;
    try {
      const agent = createAgent("sess-1", {
        steer() {
          attempts += 1;
          throw new Error("agent is disposed");
        },
      });
      await fake.commands[0].handler({ agent, rawInput: "on" });
      const entry = host.sessions.get("sess-1");
      entry.watcher.acceptLine({ seq: 1, type: "post.created", actor: "林", post_id: "p1", payload: { reply_to_account_id: "manager" } });
      timers.runAll();
      for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(attempts).toBe(1);
      expect(log.lines.some((line) => line.includes("injection skipped"))).toBe(true);
      expect(entry.watcher.status().state).not.toBe("stopped");

      // Still watching: the next batch attempts delivery again (no permanent loss).
      entry.watcher.acceptLine({ seq: 2, type: "post.created", actor: "林", post_id: "p2", payload: { reply_to_account_id: "manager" } });
      timers.runAll();
      for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(attempts).toBe(2);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      host.dispose();
    }
  });

  test("injection resolves the live agent first and the cached one only as fallback", async () => {
    const dir = createInstanceDir();
    const timers = createFakeTimers();
    const fakeFetch = createFakeFetch([
      ...instanceRoutes({ dataDir: dir }).routes,
      { match: /\/api\/posts\/p\d+$/, respond: () => jsonResponse(200, { ok: true, post: { id: "p1", body_md: "正文" } }) },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl, createLogger(), timers));
    try {
      let cachedAttempts = 0;
      const cached = createAgent("sess-1", {
        steer() {
          cachedAttempts += 1;
          throw new Error("stale cached agent");
        },
      });
      await fake.commands[0].handler({ agent: cached, rawInput: "on" });
      const live = createAgent("sess-1");
      fake.ctx.services.agents = { get: (id: string) => (id === "sess-1" ? live : undefined) };
      const entry = host.sessions.get("sess-1");
      entry.watcher.acceptLine({ seq: 1, type: "post.created", actor: "林", post_id: "p1", payload: { reply_to_account_id: "manager" } });
      timers.runAll();
      for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(live.steered).toHaveLength(1);
      expect(cachedAttempts).toBe(0);
    } finally {
      host.dispose();
    }
  });

  test("end-to-end wiring: a hub notification reaches the session agent as one steered stoa message", async () => {
    const dir = createInstanceDir();
    const timers = createFakeTimers();
    const fakeFetch = createFakeFetch([
      ...instanceRoutes({ dataDir: dir }).routes,
      { match: /\/api\/posts\/p9$/, respond: () => jsonResponse(200, { ok: true, post: { id: "p9", body_md: "林小满 说：你好\n\n第二段" } }) },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl, createLogger(), timers));
    try {
      const agent = createAgent("sess-1");
      await fake.commands[0].handler({ agent, rawInput: "on" });
      const entry = host.sessions.get("sess-1");
      entry.watcher.acceptLine({ seq: 101, type: "post.created", actor: "林小满", post_id: "p9", payload: { reply_to_account_id: "manager" } });
      expect(entry.watcher.status().events).toBe(1);
      // Let the excerpt fetch settle, then fire the 1.5s merge window.
      for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      timers.runAll();
      expect(agent.steered).toHaveLength(1);
      const message = agent.steered[0]!;
      expect(message.role).toBe("user");
      expect(message.source).toEqual({ kind: "stoa" });
      expect(message.content).toEqual([{ type: "text", text: expect.stringContaining("[Stoa · 回复你] 林小满 回复了你的帖子 #p9：") }]);
      expect(message.content[0]!.text).toContain("> 林小满 说：你好 第二段");
      // One notification batch → exactly one injected message, cursor advanced.
      expect(entry.watcher.status().lastSeq).toBe(101);
      expect(entry.watcher.status().batches).toBe(1);
      expect(entry.watcher.status().injected).toBe(1);
    } finally {
      host.dispose();
    }
  });

  test("dispose() lifts every registration the host made", async () => {
    const fake = createFakeContext();
    const lifted: string[] = [];
    fake.ctx.services.commands = { register: () => () => lifted.push("command") };
    fake.ctx.services.tools = { register: (definition: any) => { fake.tools.push(definition); return () => lifted.push(definition.name); } };
    const host = hostEntry.createStoaHost(fake.ctx, {
      ...hostOptions(async () => { throw new Error("offline"); }),
      defineTool: (spec: any) => spec,
    });
    await host.toolsReady;
    expect(host.tools.registered).toHaveLength(5);
    host.dispose();
    expect(lifted.filter((name) => name === "command")).toHaveLength(1);
    expect(lifted.filter((name) => name.startsWith("stoa_"))).toHaveLength(5);
  });

  test('/stoa off on a session that never enabled the mode is a plain no-op', async () => {
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(async () => { throw new Error("no network"); }));
    try {
      const result = await fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "off" });
      expect(result.kind).toBe("success");
      expect(result.text).toContain("本来就没有启用");
    } finally {
      host.dispose();
    }
  });

// ── lifecycle races and teardown (review r2) ─────────────────────────────────

describe("lifecycle races and teardown (review r2)", () => {
  test("dispose() during a pending mount leaves the session disabled with no watcher", async () => {
    const dir = createInstanceDir();
    let releaseMount = () => {};
    const mountGate = new Promise<void>((resolve) => {
      releaseMount = resolve;
    });
    const fakeFetch = createFakeFetch([
      {
        match: /\/api\/daemon\/services$/,
        method: "POST",
        respond: async () => {
          await mountGate;
          return jsonResponse(200, {
            ok: true,
            service: { id: "svc-1", name: "dsh-sess-1", dataDir: dir, url: "http://127.0.0.1:13680" },
            reused: false,
          });
        },
      },
      { match: /\/api\/stream\/ticket$/, respond: () => jsonResponse(200, { ok: true, ticket: "t" }) },
      { match: /\/api\/stream\?/, respond: () => sseResponse([`event: hello\ndata: ${JSON.stringify({ hub: 2, as_of_seq: 1 })}\n\n`]) },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const pending = fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "" });
      expect(await until(() => fakeFetch.count(/\/api\/daemon\/services$/, "POST") === 1)).toBe(true);
      const teardown = host.dispose();
      releaseMount();
      const result = await pending;
      await teardown;
      expect(result.kind).toBe("error");
      expect(result.text).toContain("已卸载");
      const entry = host.sessions.get("sess-1");
      expect(entry?.enabled).toBe(false);
      expect(entry?.watcher).toBe(null);
      // The publish barrier ran before the watcher could even fetch a ticket.
      expect(fakeFetch.count(/\/api\/stream\/ticket$/)).toBe(0);
      // Teardown is awaitable and idempotent.
      await expect(host.dispose()).resolves.toBeUndefined();
    } finally {
      releaseMount();
      await host.dispose();
    }
  });

  test("dispose() while defineTool is loading never registers the stoa_* tools", async () => {
    const registered: string[] = [];
    const lifted: string[] = [];
    let releaseTools = () => {};
    const toolsGate = new Promise<void>((resolve) => {
      releaseTools = resolve;
    });
    const fake = createFakeContext();
    fake.ctx.services.commands = { register: () => () => lifted.push("command") };
    fake.ctx.services.tools = {
      register: (definition: any) => {
        registered.push(definition.name);
        return () => lifted.push(definition.name);
      },
    };
    const host = hostEntry.createStoaHost(fake.ctx, {
      ...hostOptions(async () => {
        throw new Error("offline");
      }),
      loadDefineTool: async () => {
        await toolsGate;
        return (spec: any) => spec;
      },
    });
    const teardown = host.dispose();
    releaseTools();
    const state = await host.toolsReady;
    await teardown;
    expect(registered).toEqual([]);
    expect(state.registered).toEqual([]);
    expect(state.error).toContain("disposed");
    expect(lifted).toEqual(["command"]);
  });

  test("dispose() closes a KV unit that was still opening (no live handle left for reload)", async () => {
    let releaseOpen = () => {};
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let live = false;
    let closed = false;
    const storage = {
      backend: {
        names: () => ["json"],
        get: () => ({
          kv: {
            async open() {
              await openGate;
              live = true;
              return {
                async loadAll() {
                  return { tables: { sessions: {} } };
                },
                async putRecord() {},
                async close() {
                  live = false;
                  closed = true;
                },
              };
            },
          },
        }),
      },
    };
    const fake = createFakeContext();
    fake.ctx.services.storage = storage;
    const fakeFetch = createFakeFetch([{ match: /./, respond: () => jsonResponse(200, { ok: true }) }]);
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    const pending = fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const teardown = host.dispose();
    releaseOpen();
    const result = await pending;
    await teardown;
    expect(closed).toBe(true);
    expect(live).toBe(false);
    expect(result.kind).toBe("error");
    expect(result.text).toContain("已卸载");
    expect(fakeFetch.calls).toHaveLength(0);
  });

  test("/stoa off while /stoa is still mounting ends off: no watcher, instance stopped", async () => {
    const dir = createInstanceDir();
    let releaseMount = () => {};
    const mountGate = new Promise<void>((resolve) => {
      releaseMount = resolve;
    });
    const stopped: string[] = [];
    const fakeFetch = createFakeFetch([
      {
        match: /\/api\/daemon\/services$/,
        method: "POST",
        respond: async () => {
          await mountGate;
          return jsonResponse(200, {
            ok: true,
            service: { id: "svc-1", name: "dsh-sess-1", dataDir: dir, url: "http://127.0.0.1:13680" },
            reused: false,
          });
        },
      },
      {
        match: /\/api\/daemon\/services\/([^/]+)\/stop$/,
        method: "POST",
        respond: (call) => {
          stopped.push(call.url);
          return jsonResponse(200, { ok: true, service: { id: "svc-1", status: "stopped" } });
        },
      },
      { match: /\/api\/stream\/ticket$/, respond: () => jsonResponse(200, { ok: true, ticket: "t" }) },
      { match: /\/api\/stream\?/, respond: () => sseResponse([`event: hello\ndata: ${JSON.stringify({ hub: 2, as_of_seq: 1 })}\n\n`]) },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const agent = createAgent("sess-1");
      const onPromise = fake.commands[0].handler({ agent, rawInput: "" });
      expect(await until(() => fakeFetch.count(/\/api\/daemon\/services$/, "POST") === 1)).toBe(true);
      const offPromise = fake.commands[0].handler({ agent, rawInput: "off" });
      // Let off bump the enable generation and start awaiting the in-flight enable.
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseMount();
      const [onResult, offResult] = await Promise.all([onPromise, offPromise]);
      expect(onResult.kind).toBe("error");
      expect(onResult.text).toContain("取消");
      expect(offResult.kind).toBe("success");
      expect(offResult.text).toContain("已关闭");
      const entry = host.sessions.get("sess-1");
      expect(entry?.enabled).toBe(false);
      expect(entry?.watcher).toBe(null);
      expect(stopped).toEqual(["http://127.0.0.1:13679/api/daemon/services/svc-1/stop"]);
      // The cancelled enable never subscribed.
      expect(fakeFetch.count(/\/api\/stream\/ticket$/)).toBe(0);
    } finally {
      releaseMount();
      await host.dispose();
    }
  });

  test("/stoa arriving while /stoa off is stopping waits, then mounts a live instance", async () => {
    const dir = createInstanceDir();
    let releaseStop = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let healthy = true;
    let stopped = false;
    let mountCount = 0;
    const baseA = "http://127.0.0.1:13680";
    const baseB = "http://127.0.0.1:13682";
    const order: string[] = [];
    const fakeFetch = createFakeFetch([
      { match: /\/healthz$/, respond: () => (healthy ? jsonResponse(200, { ok: true }) : jsonResponse(503, { ok: false })) },
      {
        match: /\/api\/daemon\/services$/,
        method: "POST",
        respond: () => {
          mountCount += 1;
          healthy = true;
          order.push(`mount-${mountCount}`);
          return jsonResponse(200, {
            ok: true,
            service: { id: "svc-1", name: "dsh-sess-1", dataDir: dir, url: mountCount === 1 ? baseA : baseB },
            reused: false,
          });
        },
      },
      {
        match: /\/api\/daemon\/services\/([^/]+)\/stop$/,
        method: "POST",
        respond: async () => {
          await stopGate;
          healthy = false;
          stopped = true;
          order.push("stop");
          return jsonResponse(200, { ok: true, service: { id: "svc-1", status: "stopped" } });
        },
      },
      { match: /\/api\/stream\/ticket$/, respond: () => jsonResponse(200, { ok: true, ticket: "t" }) },
      { match: /\/api\/stream\?/, respond: () => sseResponse([`event: hello\ndata: ${JSON.stringify({ hub: 2, as_of_seq: 1 })}\n\n`]) },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const agent = createAgent("sess-1");
      await fake.commands[0].handler({ agent, rawInput: "on" });
      const offPromise = fake.commands[0].handler({ agent, rawInput: "off" });
      await until(() => fakeFetch.count(/\/api\/daemon\/services\/svc-1\/stop$/, "POST") === 1);
      const onPromise = fake.commands[0].handler({ agent, rawInput: "on" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseStop();
      const [offResult, onResult] = await Promise.all([offPromise, onPromise]);
      expect(offResult.kind).toBe("success");
      expect(onResult.kind).toBe("success");
      expect(stopped).toBe(true);
      expect(order).toEqual(["mount-1", "stop", "mount-2"]);
      const entry = host.sessions.get("sess-1");
      expect(entry?.enabled).toBe(true);
      expect(entry?.record?.baseUrl).toBe(baseB);
      expect(await until(() => entry?.watcher?.status().state === "live")).toBe(true);
    } finally {
      releaseStop();
      await host.dispose();
    }
  });

  test("/stoa observes the command invocation signal: a cancelled mount publishes nothing", async () => {
    const dir = createInstanceDir();
    let releaseMount = () => {};
    const mountGate = new Promise<void>((resolve) => {
      releaseMount = resolve;
    });
    const fakeFetch = createFakeFetch([
      {
        match: /\/api\/daemon\/services$/,
        method: "POST",
        respond: async () => {
          await mountGate;
          return jsonResponse(200, {
            ok: true,
            service: { id: "svc-1", name: "dsh-sess-1", dataDir: dir, url: "http://127.0.0.1:13680" },
            reused: false,
          });
        },
      },
      { match: /\/api\/stream\/ticket$/, respond: () => jsonResponse(200, { ok: true, ticket: "t" }) },
      { match: /\/api\/stream\?/, respond: () => sseResponse([`event: hello\ndata: ${JSON.stringify({ hub: 2, as_of_seq: 1 })}\n\n`]) },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const controller = new AbortController();
      const pending = fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "", signal: controller.signal });
      expect(await until(() => fakeFetch.count(/\/api\/daemon\/services$/, "POST") === 1)).toBe(true);
      controller.abort();
      releaseMount();
      const result = await pending;
      expect(result.kind).toBe("error");
      expect(result.text).toContain("已被取消");
      const entry = host.sessions.get("sess-1");
      expect(entry?.enabled).toBe(false);
      expect(entry?.watcher).toBe(null);
      expect(fakeFetch.count(/\/api\/stream\/ticket$/)).toBe(0);
    } finally {
      releaseMount();
      await host.dispose();
    }
  });

  test("/stoa off retries a daemon stop that failed the first time", async () => {
    const dir = createInstanceDir();
    let stopCalls = 0;
    const fakeFetch = createFakeFetch([
      ...instanceRoutes({ dataDir: dir }).routes,
      {
        match: /\/api\/daemon\/services\/([^/]+)\/stop$/,
        method: "POST",
        respond: () => {
          stopCalls += 1;
          return stopCalls === 1
            ? jsonResponse(500, { ok: false, error: "stop failed" })
            : jsonResponse(200, { ok: true, service: { id: "svc-1", status: "stopped" } });
        },
      },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const agent = createAgent("sess-1");
      await fake.commands[0].handler({ agent, rawInput: "on" });
      const firstOff = await fake.commands[0].handler({ agent, rawInput: "off" });
      expect(firstOff.kind).toBe("success");
      expect(firstOff.text).toContain("daemon 未确认停机");
      expect(firstOff.text).toContain("再次执行 /stoa off 会重试");
      expect(host.sessions.get("sess-1")?.stopPending).toBe(true);

      const secondOff = await fake.commands[0].handler({ agent, rawInput: "off" });
      expect(secondOff.kind).toBe("success");
      expect(secondOff.text).toContain("已关闭");
      expect(secondOff.text).toContain("本次为补偿停机");
      expect(host.sessions.get("sess-1")?.stopPending).toBe(false);
      expect(stopCalls).toBe(2);
    } finally {
      await host.dispose();
    }
  });

  test("a re-mounted instance invalidates cached subagent board clients (new baseUrl)", async () => {
    const dir = createInstanceDir({ manager: FAKE_TOKEN, helper: "helper-token-123456" });
    let mountCount = 0;
    let healthy = false;
    const baseA = "http://127.0.0.1:13680";
    const baseB = "http://127.0.0.1:13682";
    const fakeFetch = createFakeFetch([
      { match: /\/healthz$/, respond: () => (healthy ? jsonResponse(200, { ok: true }) : jsonResponse(503, { ok: false })) },
      {
        match: /\/api\/daemon\/services$/,
        method: "POST",
        respond: () => {
          mountCount += 1;
          healthy = true;
          return jsonResponse(200, {
            ok: true,
            service: { id: "svc-1", name: "dsh-sess-1", dataDir: dir, url: mountCount === 1 ? baseA : baseB },
            reused: false,
          });
        },
      },
      {
        match: /\/api\/daemon\/services\/([^/]+)\/stop$/,
        method: "POST",
        respond: () => {
          healthy = false;
          return jsonResponse(200, { ok: true, service: { id: "svc-1", status: "stopped" } });
        },
      },
      { match: /\/api\/accounts$/, method: "GET", respond: () => jsonResponse(200, { ok: true, accounts: [{ id: "helper", display: "helper" }] }) },
      { match: /\/api\/posts$/, method: "POST", respond: () => jsonResponse(201, { ok: true, posts: [{ id: "post-1", author: "helper", body_md: "hi" }] }) },
      { match: /\/api\/stream\/ticket$/, respond: () => jsonResponse(200, { ok: true, ticket: "t" }) },
      { match: /\/api\/stream\?/, respond: () => sseResponse([`event: hello\ndata: ${JSON.stringify({ hub: 2, as_of_seq: 1 })}\n\n`]) },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const agent = createAgent("sess-1");
      await fake.commands[0].handler({ agent, rawInput: "on" });
      fake.emit("subagent/start", { runId: "run-1", id: "child-1", parentSessionId: "sess-1" });
      const child = createAgent("child-1", {
        session: { ownEvents: () => [{ type: "user/message", data: { content: [{ type: "text", text: "任务 [[stoa:helper]]" }] } }] },
      });
      fake.ctx.services.agents = { get: (id: string) => (id === "child-1" ? child : undefined) };
      const specs = toolsMod.buildToolSpecs(host.runtime);
      const postTool = specs.find((spec: any) => spec.name === "stoa_post");
      expect(JSON.parse(await postTool.execute({ body: "first" }, { agent: child })).ok).toBe(true);

      await fake.commands[0].handler({ agent, rawInput: "off" });
      await fake.commands[0].handler({ agent, rawInput: "on" });
      expect(host.sessions.get("sess-1")?.record?.baseUrl).toBe(baseB);
      expect(JSON.parse(await postTool.execute({ body: "second" }, { agent: child })).ok).toBe(true);

      const posted = fakeFetch.calls.filter((call) => /\/api\/posts$/.test(call.url) && call.method === "POST").map((call) => call.url);
      expect(posted).toEqual([`${baseA}/api/posts`, `${baseB}/api/posts`]);
    } finally {
      await host.dispose();
    }
  });

  test("a KV open failure is retried once, then raised loudly instead of falling back to file", async () => {
    const home = mkdtempSync(join(tmpdir(), "stoa-host-home-"));
    let attempts = 0;
    const warnings: string[] = [];
    const storage = {
      backend: {
        names: () => ["json"],
        get: () => ({
          kv: {
            async open() {
              attempts += 1;
              throw new Error("kv backend down");
            },
          },
        }),
      },
    };
    const error = await session
      .createAssociationStore({ storage, env: { DSH_HOME: home }, onWarn: (message: string) => warnings.push(message), sleep: async () => {} })
      .then(
        () => null,
        (thrown: Error) => thrown,
      );
    expect(error?.message).toContain("关联存储");
    expect(error?.message).toContain("不回退到文件存储");
    expect(attempts).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("不回退到文件存储");
    expect(existsSync(join(home, "storages", "stoa-sessions.json"))).toBe(false);

    // No backend at all keeps the documented normal degradation to the file store.
    const fallback = await session.createAssociationStore({ storage: undefined, env: { DSH_HOME: home } });
    expect(fallback.kind).toBe("file");
    await fallback.close();
  });

  test("a broken storage KV fails /stoa loudly and never mounts a second source of instances", async () => {
    const home = mkdtempSync(join(tmpdir(), "stoa-host-home-"));
    let attempts = 0;
    const storage = {
      backend: {
        names: () => ["json"],
        get: () => ({
          kv: {
            async open() {
              attempts += 1;
              throw new Error("backing store unavailable");
            },
          },
        }),
      },
    };
    const dir = createInstanceDir();
    const fakeFetch = createFakeFetch(instanceRoutes({ dataDir: dir }).routes);
    const fake = createFakeContext();
    fake.ctx.services.storage = storage;
    const log = createLogger();
    const host = hostEntry.createStoaHost(fake.ctx, {
      ...hostOptions(fakeFetch.impl, log),
      env: { ...ENV, DSH_HOME: home },
    });
    try {
      const agent = createAgent("sess-1");
      const first = await fake.commands[0].handler({ agent, rawInput: "" });
      const second = await fake.commands[0].handler({ agent, rawInput: "" });
      expect(first.kind).toBe("error");
      expect(first.text).toContain("关联存储");
      expect(second.kind).toBe("error");
      expect(fakeFetch.count(/\/api\/daemon\/services$/, "POST")).toBe(0);
      expect(attempts).toBe(4);
      expect(log.lines.some((line) => line.includes("不回退到文件存储"))).toBe(true);
      expect(existsSync(join(home, "storages", "stoa-sessions.json"))).toBe(false);
    } finally {
      await host.dispose();
    }
  });
  test("a missing createUserMessage fails with an honest 'not enabled' message", async () => {
    const dir = createInstanceDir();
    const fakeFetch = createFakeFetch(instanceRoutes({ dataDir: dir }).routes);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, {
      env: { ...ENV, DSH_HOME: mkdtempSync(join(tmpdir(), "stoa-host-home-")) },
      fetchImpl: fakeFetch.impl,
      timers: createFakeTimers(),
      log: createLogger(),
      // Deliberately no createUserMessage/defineTool: the lazy dsh imports fail
      // in this composition, which is exactly the degraded path under test.
    });
    try {
      const result = await fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "" });
      expect(result.kind).toBe("error");
      expect(result.text).toContain("会话模式未启用");
      expect(result.text).not.toContain("工具仍可用");
      expect(host.sessions.get("sess-1")?.enabled).toBe(false);
      expect(host.sessions.get("sess-1")?.watcher).toBe(null);
    } finally {
      await host.dispose();
    }
  });
});

// ── review r3 regressions ────────────────────────────────────────────────────

describe("review r3 regressions", () => {
  test("dispose() during a storage-backed first mount keeps the association (reload mounts once)", async () => {
    const dir = createInstanceDir();
    const fakeStorage = createFakeStorage();
    let releaseMount = () => {};
    const mountGate = new Promise<void>((resolve) => {
      releaseMount = resolve;
    });
    let mountCount = 0;
    const ports = ["http://127.0.0.1:13680", "http://127.0.0.1:13682"];
    const fakeFetch = createFakeFetch([
      {
        match: /\/api\/daemon\/services$/,
        method: "POST",
        respond: async () => {
          await mountGate;
          mountCount += 1;
          return jsonResponse(200, {
            ok: true,
            service: { id: `svc-${mountCount}`, name: "dsh-sess-1", dataDir: dir, url: ports[Math.min(mountCount - 1, ports.length - 1)] },
            reused: false,
          });
        },
      },
      { match: /\/healthz$/, respond: () => (mountCount > 0 ? jsonResponse(200, { ok: true }) : jsonResponse(503, { ok: false })) },
      { match: /\/api\/stream\/ticket$/, respond: () => jsonResponse(200, { ok: true, ticket: "t" }) },
      { match: /\/api\/stream\?/, respond: () => sseResponse([`event: hello\ndata: ${JSON.stringify({ hub: 2, as_of_seq: 1 })}\n\n`]) },
    ]);
    const firstCtx = createFakeContext();
    firstCtx.ctx.services.storage = fakeStorage.storage;
    const firstHost = hostEntry.createStoaHost(firstCtx.ctx, hostOptions(fakeFetch.impl));
    const pending = firstCtx.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "" });
    expect(await until(() => fakeFetch.count(/\/api\/daemon\/services$/, "POST") === 1)).toBe(true);

    // dispose lands while the mount is still in flight, then the mount resolves.
    const teardown = firstHost.dispose();
    releaseMount();
    const first = await pending;
    await teardown;

    // Readable disposed message — the backend's raw English must not leak.
    expect(first.kind).toBe("error");
    expect(first.text).toContain("已卸载");
    expect(first.text).not.toContain("is closed");
    // The association was written while the KV unit was still open…
    expect(fakeStorage.rows["stoa/session/sess-1"]).toMatchObject({ serviceId: "svc-1", baseUrl: ports[0] });
    // …and the unit is released afterwards (a reload can open it again).
    expect(fakeStorage.isOpen()).toBe(false);

    // Reload over the same storage: reuse the association, never mount twice.
    const secondCtx = createFakeContext();
    secondCtx.ctx.services.storage = fakeStorage.storage;
    const secondHost = hostEntry.createStoaHost(secondCtx.ctx, hostOptions(fakeFetch.impl));
    try {
      const reload = await secondCtx.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "" });
      expect(reload.kind).toBe("success");
      expect(secondHost.sessions.get("sess-1")?.record?.serviceId).toBe("svc-1");
      expect(mountCount).toBe(1);
      expect(fakeFetch.count(/\/api\/daemon\/services$/, "POST")).toBe(1);
    } finally {
      await secondHost.dispose();
    }
  });

  test("dispose() stays bounded while an enable is stuck on the daemon mount", async () => {
    const dir = createInstanceDir();
    const fakeStorage = createFakeStorage();
    let releaseMount = () => {};
    const mountGate = new Promise<void>((resolve) => {
      releaseMount = resolve;
    });
    const fakeFetch = createFakeFetch([
      {
        match: /\/api\/daemon\/services$/,
        method: "POST",
        respond: async () => {
          await mountGate;
          return jsonResponse(200, {
            ok: true,
            service: { id: "svc-1", name: "dsh-sess-1", dataDir: dir, url: "http://127.0.0.1:13680" },
            reused: false,
          });
        },
      },
      { match: /\/api\/stream\/ticket$/, respond: () => jsonResponse(200, { ok: true, ticket: "t" }) },
      { match: /\/api\/stream\?/, respond: () => sseResponse([`event: hello\ndata: ${JSON.stringify({ hub: 2, as_of_seq: 1 })}\n\n`]) },
    ]);
    const timers = createFakeTimers();
    const fake = createFakeContext();
    fake.ctx.services.storage = fakeStorage.storage;
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl, createLogger(), timers));
    try {
      const pending = fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "" });
      expect(await until(() => fakeFetch.count(/\/api\/daemon\/services$/, "POST") === 1)).toBe(true);
      expect(fakeStorage.isOpen()).toBe(true);

      const teardown = host.dispose();
      // Let dispose reach its first await boundary so the bounded wait timer
      // exists, then advance only the hosts' own timers: the bound expires
      // while the mount never lands, so unload completes without the daemon.
      await new Promise((resolve) => setTimeout(resolve, 0));
      timers.runAll();
      await teardown;
      expect(fakeStorage.isOpen()).toBe(false);

      // A mount that lands after the bound is abandoned: the enable can never
      // publish a watcher and reports the readable disposed message.
      releaseMount();
      const result = await pending;
      expect(result.kind).toBe("error");
      expect(result.text).toContain("已卸载");
      expect(result.text).not.toContain("closed");
      expect(host.sessions.get("sess-1")?.enabled).toBe(false);
      expect(host.sessions.get("sess-1")?.watcher).toBe(null);
      expect(fakeFetch.count(/\/api\/stream\/ticket$/)).toBe(0);
    } finally {
      releaseMount();
      await host.dispose();
    }
  });

  test("a throwing storage backend registry is reported, never read as 'no backend'", async () => {
    const home = mkdtempSync(join(tmpdir(), "stoa-host-home-"));
    const warnings: string[] = [];

    // names() throwing: a registry that cannot enumerate is broken storage.
    const namesBroken = {
      backend: {
        names() {
          throw new Error("registry corrupted");
        },
        get: () => ({ kv: { async open() { throw new Error("must not be called"); } } }),
      },
    };
    const namesError = await session
      .createAssociationStore({ storage: namesBroken, env: { DSH_HOME: home }, onWarn: (message: string) => warnings.push(message) })
      .then(
        () => null,
        (thrown: Error) => thrown,
      );
    expect(namesError?.message).toContain("关联存储");
    expect(namesError?.message).toContain("不回退到文件存储");
    expect(namesError?.message).toContain("registry corrupted");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("不回退到文件存储");
    expect(existsSync(join(home, "storages", "stoa-sessions.json"))).toBe(false);

    // get() throwing for a listed backend: same family, still no file fallback.
    const getBroken = {
      backend: {
        names: () => ["json"],
        get() {
          throw new Error("backend get failed");
        },
      },
    };
    const getError = await session
      .createAssociationStore({ storage: getBroken, env: { DSH_HOME: home }, onWarn: () => {} })
      .then(
        () => null,
        (thrown: Error) => thrown,
      );
    expect(getError?.message).toContain("backend get failed");
    expect(getError?.message).toContain("不回退到文件存储");
    expect(existsSync(join(home, "storages", "stoa-sessions.json"))).toBe(false);
  });

  test("/stoa off treats a missing daemon registration (404) as stopped and stops retrying", async () => {
    const dir = createInstanceDir();
    let stopCalls = 0;
    const fakeFetch = createFakeFetch([
      ...instanceRoutes({ dataDir: dir }).routes,
      {
        match: /\/api\/daemon\/services\/([^/]+)\/stop$/,
        method: "POST",
        respond: () => {
          stopCalls += 1;
          return jsonResponse(404, { ok: false, code: "NOT_FOUND", error: "no service with id svc-1" });
        },
      },
    ]);
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      const agent = createAgent("sess-1");
      await fake.commands[0].handler({ agent, rawInput: "on" });
      const off = await fake.commands[0].handler({ agent, rawInput: "off" });
      expect(off.kind).toBe("success");
      expect(off.text).toContain("登记已不存在");
      expect(off.text).toContain("视为已停");
      expect(off.text).not.toContain("再次执行 /stoa off 会重试");
      expect(host.sessions.get("sess-1")?.stopPending).toBe(false);

      // Converged: the next off is a plain no-op, no repeated warning.
      const second = await fake.commands[0].handler({ agent, rawInput: "off" });
      expect(second.kind).toBe("success");
      expect(second.text).toContain("本来就没有启用");
      expect(stopCalls).toBe(1);
    } finally {
      await host.dispose();
    }
  });

  test("subagent/end forgets the child's account mapping and cached board client", async () => {
    const dir = createInstanceDir({ manager: FAKE_TOKEN, helper: "helper-token-123456" });
    const fakeFetch = createFakeFetch(
      instanceRoutes({
        dataDir: dir,
        extra: [
          { match: /\/api\/accounts$/, method: "GET", respond: () => jsonResponse(200, { ok: true, accounts: [{ id: "helper", display: "helper" }] }) },
          { match: /\/api\/posts$/, method: "POST", respond: () => jsonResponse(201, { ok: true, posts: [{ id: "post-1", author: "helper", body_md: "hi" }] }) },
        ],
      }).routes,
    );
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(fakeFetch.impl));
    try {
      await fake.commands[0].handler({ agent: createAgent("sess-1"), rawInput: "on" });
      fake.emit("subagent/start", { runId: "run-1", id: "child-1", parentSessionId: "sess-1" });
      const child = createAgent("child-1", {
        session: { ownEvents: () => [{ type: "user/message", data: { content: [{ type: "text", text: "任务 [[stoa:helper]]" }] } }] },
      });
      fake.ctx.services.agents = { get: (id: string) => (id === "child-1" ? child : undefined) };
      const specs = toolsMod.buildToolSpecs(host.runtime);
      const postTool = specs.find((spec: any) => spec.name === "stoa_post");
      expect(JSON.parse(await postTool.execute({ body: "hi" }, { agent: child })).ok).toBe(true);

      const owner = host.sessions.get("sess-1");
      expect(owner?.accounts.has("child-1")).toBe(true);
      expect(host.clients.size).toBe(1);

      fake.emit("subagent/end", { runId: "run-1", id: "child-1", parentSessionId: "sess-1" });
      expect(host.children.has("child-1")).toBe(false);
      expect(owner?.accounts.has("child-1")).toBe(false);
      expect(host.clients.size).toBe(0);
    } finally {
      await host.dispose();
    }
  });
});

// ── injection text ───────────────────────────────────────────────────────────

describe("injection text", () => {
  const item = (extra: Record<string, unknown> = {}) => ({
    seq: 1,
    kind: "reply",
    label: "回复你",
    phrase: "回复了你的帖子",
    actor: "林小满",
    postId: "01M7ABC",
    excerpt: null,
    ...extra,
  });

  test("single event carries the source label, the post id and a ≤280-char excerpt", () => {
    const text = watcherMod.buildInjectionText([item({ excerpt: "x".repeat(400) })]);
    expect(text.startsWith("[Stoa · 回复你] 林小满 回复了你的帖子 #01M7ABC：")).toBe(true);
    const excerptLine = text.split("\n")[1];
    expect(excerptLine.startsWith("> ")).toBe(true);
    expect(excerptLine.length - 2).toBeLessThanOrEqual(280);
    expect(excerptLine.endsWith("…")).toBe(true);
    expect(text.endsWith("需要回应时用 stoa_reply（post_id 见上）；不需要就继续手头工作。")).toBe(true);
  });

  test("excerpts collapse whitespace and are dropped when absent", () => {
    const collapsed = watcherMod.truncateSummary("a\n\n  b\tc", 280);
    expect(collapsed).toBe("a b c");
    expect(watcherMod.truncateSummary("", 280)).toBe("");
    const text = watcherMod.buildInjectionText([item()]);
    expect(text).not.toContain("> ");
    expect(text).toContain("#01M7ABC");
  });

  test("multiple events merge into one labelled list", () => {
    const text = watcherMod.buildInjectionText([item(), item({ label: "提到了你", phrase: "提到了你", actor: "小满", postId: "01M7ABD", excerpt: "hello" })]);
    expect(text.split("\n")[0]).toBe("[Stoa · 2 条新消息]");
    expect(text).toContain("- [回复你] 林小满 #01M7ABC");
    expect(text).toContain("- [提到了你] 小满 #01M7ABD：hello");
    expect(text.split("\n").at(-1)).toContain("stoa_reply");
  });
});

// ── S2 integration: pickName through the real pool ───────────────────────────

describe("pickName integration", () => {
  test("bare given → surname+given → numeric suffix, all ids slug-safe", () => {
    const random = () => 0;
    const first = namesMod.pickName({ takenIds: [], takenDisplays: [], random });
    expect(first.id).toMatch(ID_RE);
    expect(first.id).not.toContain("-");
    expect(first.display.length).toBeGreaterThan(0);

    const second = namesMod.pickName({ takenIds: [first.id], takenDisplays: [first.display], random });
    expect(second.id).toMatch(ID_RE);
    expect(second.id).toContain("-");
    expect(second.id).not.toBe(first.id);
    expect(second.display).not.toBe(first.display);

    const third = namesMod.pickName({
      takenIds: [first.id, second.id],
      takenDisplays: [first.display, second.display],
      random,
    });
    expect(third.id).toMatch(ID_RE);
    expect(third.id).toMatch(/-\d+$/);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);

    // A seeded random is reproducible across calls.
    const seeded = () => 0.5;
    expect(namesMod.pickName({ random: seeded })).toEqual(namesMod.pickName({ random: seeded }));
  });

  test("the shipped pool is large enough for the naming ladder", () => {
    const pool = JSON.parse(readFileSync(join(root, "data", "names.json"), "utf8"));
    expect(pool.given.length).toBeGreaterThanOrEqual(256);
    expect(pool.surnames.length).toBeGreaterThanOrEqual(128);
    for (const entry of pool.given.slice(0, 20)) expect(entry.py).toMatch(ID_RE);
  });
});

// ── plugin entry ─────────────────────────────────────────────────────────────

describe("plugin entry (index.js)", () => {
  test("declares the dsh inject contract (commands + tools) without storage", () => {
    // dsh activates service-declared plugins only after every injected service
    // is ACTIVE; without this export /stoa and the stoa_* tools never register.
    expect(Array.isArray(hostEntry.inject)).toBe(true);
    expect(hostEntry.inject).toContain("commands");
    expect(hostEntry.inject).toContain("tools");
    // storage is lazy (first /stoa) so a reload can re-open the KV unit.
    expect(hostEntry.inject).not.toContain("storage");
  });

  test("apply registers one effect that owns the session mode", () => {
    const fake = createFakeContext();
    hostEntry.apply(fake.ctx);
    expect(fake.effects).toEqual(["stoa: dsh session mode"]);
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0].name).toBe("stoa");
    expect(fake.handlers.get("subagent/start")).toHaveLength(1);
    expect(fake.handlers.get("subagent/end")).toHaveLength(1);
  });

  test("the runtime reports subagent bookkeeping and the state shapes tools rely on", async () => {
    const fake = createFakeContext();
    const host = hostEntry.createStoaHost(fake.ctx, hostOptions(async () => { throw new Error("offline"); }));
    try {
      expect(host.runtime.isSubagentsEnabled("sess-1")).toBe(true);
      await host.runtime.setSubagentsEnabled("sess-1", false);
      expect(host.runtime.isSubagentsEnabled("sess-1")).toBe(false);
      fake.emit("subagent/start", { id: "child-9", parentSessionId: "sess-1", runId: "r9" });
      expect(host.children.get("child-9")?.parentSessionId).toBe("sess-1");
      expect(host.runtime.describeSession("child-9").subagents.runs).toBe(1);
      fake.emit("subagent/end", { id: "child-9", parentSessionId: "sess-1", runId: "r9" });
      expect(host.children.size).toBe(0);
      const statusText = await host.runtime.statusText("sess-1");
      expect(statusText).toContain("未启用");
    } finally {
      host.dispose();
    }
  });
});

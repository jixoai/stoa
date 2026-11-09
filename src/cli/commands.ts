import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { ReportError, fail } from "../core/errors.ts";
import { accountTokenEnvKey, legacyAccountTokenEnvKey, maskSecret } from "../core/auth.ts";
import { envKeys, envValue, loadEnvFiles, resolveEnvFiles, type LoadedEnv } from "../core/env.ts";
import { capabilities, VERSION } from "../core/protocol.ts";
import { validateWriteOp, MAX_ARTICLE_BYTES } from "../core/validation.ts";
import {
  discoverServer,
  readLock,
  readServerInfo,
  resolveDataDir,
} from "../server/discovery.ts";
import { initDataDir, describeAuthProvision } from "../server/init.ts";
import { serverStatus, startServer, type ServeStatus } from "../server/serve.ts";
import { garbageCollect } from "../server/gc.ts";
import { runExport, setPendingExportFlag } from "../server/export.ts";
import type { PostKind, SuggestedAccount, TrendingTag, WriteOp } from "../core/types.ts";
import {
  flagInt,
  flagList,
  flagValue,
  hasFlag,
  requireFlag,
  type ParsedArgs,
} from "./args.ts";
import { ApiClient, CliError, fetchAuthMode } from "./client.ts";
import { emit, emitError, emitHuman, formatTime, postLine, summarizePost, writeLineSync } from "./output.ts";

export interface CliContext {
  args: ParsedArgs;
  cwd: string;
  dataDir: string;
  envFiles: string[];
  env: LoadedEnv;
  human: boolean;
}

function context(args: ParsedArgs, dataDir: string, cwd: string): CliContext {
  const explicit =
    flagValue(args, "env-files") ?? envValue(process.env, envKeys("ENV_FILES")) ?? null;
  const envFiles =
    explicit !== null
      ? explicit
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => resolve(cwd, p))
      : resolveEnvFiles({ dataDir, cwd });
  return {
    args,
    cwd,
    dataDir,
    envFiles,
    env: loadEnvFiles(envFiles),
    human: hasFlag(args, "human"),
  };
}

function resolveToken(env: LoadedEnv, account: string): string | null {
  return (
    envValue(env.values, {
      primary: accountTokenEnvKey(account),
      legacy: legacyAccountTokenEnvKey(account),
    }) ??
    envValue(env.values, envKeys("ACCOUNT_TOKEN")) ??
    null
  );
}

function resolveAccount(
  ctx: CliContext,
  opts: { required?: boolean; defaultOwner?: boolean } = {},
): string {
  const explicit =
    flagValue(ctx.args, "as") ?? envValue(process.env, envKeys("ACCOUNT")) ?? null;
  if (explicit && explicit.trim()) return explicit.trim();
  if (opts.defaultOwner) return "owner";
  fail(
    "BAD_REQUEST",
    "--as <account> is required (no implicit default). Accounts: owner and manager exist after init; " +
      "list agent accounts with `accounts ls`. In auth mode pass the account's env file: " +
      "--env-files <data-dir>/accounts/<account>.env",
  );
}

async function makeClient(
  ctx: CliContext,
  account: string,
): Promise<{ client: ApiClient; url: string; authMode: "open" | "auth" }> {
  const info = await discoverServer(ctx.dataDir);
  const status = await fetchAuthMode(info.url);
  const token = resolveToken(ctx.env, account);
  if (status.mode === "auth" && !token) {
    fail(
      "UNAUTHORIZED",
      `authentication is ON but no account token for "${account}" was found in the loaded env files. ` +
        `Pass --env-files ${join(ctx.dataDir, "accounts", `${account}.env`)} (each account token lives in its own 0600 file).`,
    );
  }
  return {
    client: new ApiClient({ baseUrl: info.url, account, token }),
    url: info.url,
    authMode: status.mode,
  };
}

async function readStdinAll(): Promise<string> {
  return Bun.stdin.text();
}

async function uploadAttachments(
  client: ApiClient,
  cwd: string,
  paths: string[],
): Promise<string[]> {
  const hashes: string[] = [];
  for (const raw of paths) {
    const path = resolve(cwd, raw);
    if (!existsSync(path)) fail("BAD_REQUEST", `attachment not found: ${path}`);
    const stat = statSync(path);
    if (stat.size > 10 * 1024 * 1024) fail("BAD_REQUEST", `attachment too large: ${path}`);
    const bytes = new Uint8Array(readFileSync(path));
    const uploaded = await client.uploadMedia(bytes, basename(path));
    hashes.push(uploaded.hash);
  }
  return hashes;
}

function outputCommit(ctx: CliContext, result: Record<string, unknown>, label: string): void {
  const posts = Array.isArray(result.posts) ? (result.posts as never[]) : [];
  if (ctx.human) {
    // 载体标注（report-longform D13）：全 note 时逐字沿用旧输出，article 追加 `(article)`。
    const kinds = new Set(
      posts.map((post) => (post as { kind?: string }).kind ?? "note"),
    );
    const kindSuffix = kinds.size === 1 && kinds.has("note") ? "" : ` (${[...kinds].join(",")})`;
    emitHuman(`${label}${kindSuffix}: batch ${result.batch_id} (${posts.length} post(s))${result.idempotent ? " [idempotent replay]" : ""}`);
    for (const post of posts) {
      emitHuman(`  - ${(post as { id?: string }).id} seq=${(post as { seq?: number }).seq}`);
    }
    return;
  }
  emit({
    ok: true,
    batch_id: result.batch_id,
    idempotent: Boolean(result.idempotent),
    posts: posts.map((p) => summarizePost(p as never)),
  });
}

// ── commands ─────────────────────────────────────────────────────────────────
async function cmdInit(ctx: CliContext): Promise<number> {
  const result = initDataDir({
    dataDir: ctx.dataDir,
    cwd: ctx.cwd,
    envFiles: ctx.envFiles,
  });
  if (ctx.human) {
    emitHuman(`initialized report at ${result.data_dir}`);
    emitHuman(`database: ${result.database}`);
    emitHuman(`pointer : ${result.pointer}`);
    for (const account of result.accounts) {
      emitHuman(`account : ${account.id} (${account.role}) -> ${account.env_file}`);
    }
    emitHuman(describeAuthProvision(result).trimEnd());
    if (result.auth.provisioned_value) {
      emitHuman(`STOA_AUTH=${result.auth.provisioned_value}`);
      emitHuman("(this value is shown once; store it in your secrets manager)");
    }
  } else {
    emit({ ok: true, ...result });
  }
  return 0;
}

/** `--idle-timeout` is expressed in whole seconds; null = use the 30-min default. */
function idleTimeoutMsFromArgs(args: ParsedArgs): number | undefined {
  const sec = flagInt(args, "idle-timeout");
  if (sec === null) return undefined;
  if (sec < 0) fail("BAD_REQUEST", "--idle-timeout must be a non-negative integer of seconds");
  return sec * 1000;
}

async function cmdServe(ctx: CliContext): Promise<number> {
  const args = ctx.args;
  if (hasFlag(args, "stop")) return stopServer(ctx);
  if (hasFlag(args, "status")) return statusCommand(ctx);
  if (hasFlag(args, "daemon")) return startDaemon(ctx);

  const port = flagInt(args, "port");
  const host = flagValue(args, "host") ?? "127.0.0.1";
  const running = await startServer({
    dataDir: ctx.dataDir,
    port,
    host,
    envFiles: ctx.envFiles,
    expose: hasFlag(args, "expose"),
    allowOpenExpose: hasFlag(args, "allow-open-expose"),
    processEnv: process.env,
    idleTimeoutMs: idleTimeoutMsFromArgs(args),
  });
  process.stdout.write(`REPORT_URL=${running.url}\n`);
  process.stderr.write(`${running.banner}\n`);
  const shutdown = async (signal: string) => {
    process.stderr.write(`[report] received ${signal}, shutting down\n`);
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  // Idle-timeout shutdown resolves this; the process then exits normally.
  await running.closed;
  return 0;
}

function daemonArgs(ctx: CliContext): string[] {
  const args = ctx.args;
  const out: string[] = ["serve", "--data-dir", ctx.dataDir];
  const port = flagInt(args, "port");
  if (port !== null) out.push("--port", String(port));
  const host = flagValue(args, "host");
  if (host) out.push("--host", host);
  const idleTimeoutMs = idleTimeoutMsFromArgs(args);
  if (idleTimeoutMs !== undefined) out.push("--idle-timeout", String(idleTimeoutMs / 1000));
  if (ctx.envFiles.length) out.push("--env-files", ctx.envFiles.join(","));
  if (hasFlag(args, "expose")) out.push("--expose");
  if (hasFlag(args, "allow-open-expose")) out.push("--allow-open-expose");
  return out;
}

async function startDaemon(ctx: CliContext): Promise<number> {
  const current = await serverStatus(ctx.dataDir);
  if (current.running) {
    fail("CONFLICT", `report service already running at ${current.url} (pid ${current.pid})`);
  }
  const script = resolve(process.argv[1] ?? "");
  if (!script || !existsSync(script)) fail("INTERNAL", "cannot locate CLI entry for daemon spawn");
  const logPath = join(ctx.dataDir, "serve.log");
  const fd = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [script, ...daemonArgs(ctx)], {
    cwd: ctx.cwd,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.unref();
  closeSync(fd);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = await serverStatus(ctx.dataDir);
    if (status.running) {
      if (ctx.human) emitHuman(`report daemon running at ${status.url} (pid ${status.pid})`);
      else emit({ ok: true, ...status, running: true, log: logPath });
      return 0;
    }
    if (Date.now() >= deadline) {
      let tail = "";
      try {
        tail = readFileSync(logPath, "utf8").split("\n").slice(-12).join("\n");
      } catch {
        tail = "(no log)";
      }
      fail("UNAVAILABLE", `daemon failed to start within 10s; log tail:\n${tail}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopServer(ctx: CliContext): Promise<number> {
  const status = await serverStatus(ctx.dataDir);
  if (!status.running) {
    cleanupStaleServerFiles(ctx.dataDir);
    if (ctx.human) emitHuman("report service is not running");
    else emit({ ok: true, running: false, stopped: false, stale: status.stale ?? false });
    return 0;
  }
  const pid = status.pid!;
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    fail("UNAVAILABLE", `cannot signal pid ${pid}: ${(err as Error).message}`);
  }
  const gracefulDeadline = Date.now() + 5000;
  while (Date.now() < gracefulDeadline) {
    const now = await serverStatus(ctx.dataDir);
    if (!now.running) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  let forced = false;
  if ((await serverStatus(ctx.dataDir)).running) {
    try {
      process.kill(pid, "SIGKILL");
      forced = true;
    } catch {
      // already gone
    }
  }
  const hardDeadline = Date.now() + 2000;
  while (Date.now() < hardDeadline) {
    if (!(await serverStatus(ctx.dataDir)).running) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  cleanupStaleServerFiles(ctx.dataDir);
  if (ctx.human) emitHuman(`stopped report service (pid ${pid})${forced ? " [SIGKILL]" : ""}`);
  else emit({ ok: true, running: false, stopped: true, pid, forced });
  return 0;
}

function cleanupStaleServerFiles(dataDir: string): void {
  const info = readServerInfo(dataDir);
  if (info) {
    const lock = readLock(dataDir);
    const pid = info.pid;
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) {
      try {
        unlinkSync(join(dataDir, "server.json"));
      } catch {
        // ignore
      }
      if (!lock || lock.pid === pid) {
        try {
          unlinkSync(join(dataDir, "serve.lock"));
        } catch {
          // ignore
        }
      }
    }
  }
}

function formatLeaseLine(status: ServeStatus): string {
  if (!status.running) return status.stale ? "(stale)" : "(none)";
  if (status.lease === null || status.lease === undefined) return "disabled";
  const remaining = status.lease.lease_remaining_ms;
  if (remaining === null) return "disabled";
  return `${remaining} ms remaining (idle timeout ${status.idle_timeout_ms ?? status.lease.idle_timeout_ms} ms, in-flight ${status.lease.in_flight})`;
}

async function statusCommand(ctx: CliContext): Promise<number> {
  const all = hasFlag(ctx.args, "all");
  const status = await serverStatus(ctx.dataDir);
  let live: unknown = null;
  if (status.running && status.url) {
    const account = flagValue(ctx.args, "as") ?? envValue(ctx.env.values, envKeys("ACCOUNT")) ?? "owner";
    const token = resolveToken(ctx.env, account);
    try {
      const client = new ApiClient({ baseUrl: status.url, account, token });
      live = await client.get("/api/status");
    } catch (err) {
      live = { error: (err as Error).message };
    }
  }
  if (all) {
    const instance = {
      ...status,
      lease_remaining_ms: status.lease_remaining_ms ?? null,
      idle_timeout_ms: status.idle_timeout_ms ?? null,
    };
    if (ctx.human) {
      emitHuman(`data dir: ${ctx.dataDir}`);
      emitHuman(
        `state   : ${status.running ? "running" : status.stale ? "stale" : "not running"}`,
      );
      if (status.pid !== undefined) emitHuman(`pid     : ${status.pid}`);
      if (status.url) emitHuman(`url     : ${status.url}`);
      emitHuman(`lease   : ${formatLeaseLine(status)}`);
      return 0;
    }
    emit({ ok: true, data_dir: ctx.dataDir, instances: [instance], live });
    return 0;
  }
  if (ctx.human) {
    emitHuman(`running : ${status.running}`);
    if (status.running) {
      emitHuman(`url     : ${status.url}`);
      emitHuman(`pid     : ${status.pid}`);
      emitHuman(`lease   : ${formatLeaseLine(status)}`);
      emitHuman(`data dir: ${ctx.dataDir}`);
    } else if (status.stale) {
      emitHuman(`stale server.json (pid ${status.pid}); run serve to restart`);
    }
    if (live && typeof live === "object") {
      const l = live as {
        counts?: Record<string, number>;
        drafts?: Array<{ id: string; author: string; items: number }>;
        auth?: { mode: string };
      };
      if (l.auth) emitHuman(`auth    : ${l.auth.mode}`);
      if (l.counts) emitHuman(`counts  : ${JSON.stringify(l.counts)}`);
      if (l.drafts && l.drafts.length) {
        emitHuman(`open drafts: ${l.drafts.map((d) => `${d.author}/${d.id}(${d.items})`).join(", ")}`);
      }
    }
    return 0;
  }
  emit({ ok: true, running: status.running, server: { ...status, dataDir: ctx.dataDir }, live });
  return 0;
}

async function cmdAuthStatus(ctx: CliContext): Promise<number> {
  const authValue = envValue(ctx.env.values, envKeys("AUTH")) ?? "";
  const localMode = authValue ? "auth" : "open";
  let serverView: unknown = null;
  const status = await serverStatus(ctx.dataDir).catch(() => null);
  if (status?.running && status.url) {
    try {
      serverView = await fetchAuthMode(status.url);
    } catch {
      serverView = null;
    }
  }
  const value = authValue;
  const payload = {
    ok: true,
    mode: localMode,
    auth_enabled: localMode === "auth",
    auth_value_masked: maskSecret(value),
    env_files_loaded: ctx.env.loaded,
    env_files_missing: ctx.env.missing,
    access_token_ttl_ms: 7 * 24 * 60 * 60 * 1000,
    account_token_note:
      "changing STOA_AUTH (legacy FDE2E_REPORT_AUTH) revokes access tokens only; account tokens rotate via `accounts rotate <id>|--all`",
    server: serverView,
  };
  if (ctx.human) {
    emitHuman(`mode    : ${localMode === "auth" ? "ON (STOA_AUTH set)" : "OFF (open mode)"}`);
    emitHuman(`value   : ${maskSecret(value)}`);
    emitHuman(`env     : ${ctx.env.loaded.join(", ") || "(none)"}`);
    if (serverView) emitHuman(`server  : ${(serverView as { mode: string }).mode}`);
    emitHuman("note    : account tokens are separate and rotate only via accounts rotate");
    return 0;
  }
  emit(payload);
  return 0;
}

async function cmdOpen(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const { client, url, authMode } = await makeClient(ctx, account);
  void client;
  if (ctx.human) {
    emitHuman(url);
    emitHuman(authMode === "auth" ? "authentication is ON: log in with the auth password (STOA_AUTH)" : "open mode");
    return 0;
  }
  emit({ ok: true, url, as: account, auth_mode: authMode });
  return 0;
}

async function cmdWho(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { defaultOwner: true });
  const { client } = await makeClient(ctx, account);
  const res = await client.get<{
    accounts: Array<{
      id: string;
      role: string;
      display: string;
      profile: string;
      online: boolean;
      last_seen: number | null;
    }>;
  }>("/api/who");
  if (ctx.human) {
    for (const a of res.accounts) {
      emitHuman(
        `${a.online ? "*" : " "} @${a.id} [${a.role}] ${a.display}` +
          (a.profile ? ` — ${a.profile}` : "") +
          (a.online ? "" : a.last_seen ? ` (last seen ${formatTime(a.last_seen)})` : " (offline)"),
      );
    }
    return 0;
  }
  emit({ ok: true, accounts: res.accounts });
  return 0;
}

async function cmdAccounts(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const { client } = await makeClient(ctx, account);
  const sub = ctx.args.positionals[0];
  if (sub === "create") {
    const id = ctx.args.positionals[1];
    if (!id) fail("BAD_REQUEST", "accounts create <id> is required");
    const role = flagValue(ctx.args, "role") ?? "agent";
    if (role !== "agent") fail("BAD_REQUEST", "only --role agent is allowed (owner/manager are fixed)");
    const res = await client.post<{
      account: Record<string, unknown>;
      env_file: string;
    }>("/api/accounts", {
      id,
      display: flagValue(ctx.args, "display") ?? undefined,
      profile: flagValue(ctx.args, "profile") ?? undefined,
    });
    if (ctx.human) {
      emitHuman(`created @${id} -> ${res.env_file} (0600; hand this file to that account only)`);
      return 0;
    }
    emit({ ok: true, account: res.account, env_file: res.env_file });
    return 0;
  }
  if (sub === "ls" || sub === undefined) {
    const res = await client.get<{ accounts: Array<Record<string, unknown>> }>("/api/accounts");
    if (ctx.human) {
      for (const a of res.accounts) {
        emitHuman(
          `@${a.id} [${a.role}] ${a.display}` + (a.disabled === 2 ? " (tombstone)" : ""),
        );
      }
      return 0;
    }
    emit({ ok: true, accounts: res.accounts });
    return 0;
  }
  if (sub === "rotate") {
    const id = ctx.args.positionals[1];
    if (hasFlag(ctx.args, "all")) {
      const list = await client.get<{ accounts: Array<{ id: string }> }>("/api/accounts");
      // rotate the caller last: rotating it first would 401 the rest of the loop
      const ordered = [
        ...list.accounts.filter((a) => a.id !== account),
        ...list.accounts.filter((a) => a.id === account),
      ];
      const rotated: Array<{ id: string; env_file: string }> = [];
      for (const a of ordered) {
        const res = await client.post<{ env_file: string }>(`/api/accounts/${a.id}/rotate`);
        rotated.push({ id: a.id, env_file: res.env_file });
      }
      if (ctx.human) {
        for (const r of rotated) emitHuman(`rotated @${r.id} -> ${r.env_file}`);
        return 0;
      }
      emit({ ok: true, rotated });
      return 0;
    }
    if (!id) fail("BAD_REQUEST", "accounts rotate <id> or --all is required");
    const res = await client.post<{ env_file: string; account: Record<string, unknown> }>(
      `/api/accounts/${id}/rotate`,
    );
    if (ctx.human) {
      emitHuman(`rotated @${id} -> ${res.env_file}`);
      return 0;
    }
    emit({ ok: true, id, env_file: res.env_file, account: res.account });
    return 0;
  }
  if (sub === "rm") {
    const id = ctx.args.positionals[1];
    if (!id) fail("BAD_REQUEST", "accounts rm <id> is required");
    await client.delete(`/api/accounts/${id}`);
    if (ctx.human) emitHuman(`removed @${id} (tombstone; id can never be reused)`);
    else emit({ ok: true, removed: id, tombstone: true });
    return 0;
  }
  fail("BAD_REQUEST", `unknown accounts subcommand "${sub}" (create|ls|rotate|rm)`);
}

/**
 * `--file <path>`（report-longform D13/§6.1）：UTF-8 读文件；相对 `ctx.cwd` 解析。
 * 文件 >2 MiB 一律拒绝（与 article 字节护栏同口径，防误读大文件）。
 */
function bodyFromFile(ctx: CliContext, path: string): string {
  const full = resolve(ctx.cwd, path);
  if (!existsSync(full)) fail("BAD_REQUEST", `body: file not found: ${path}`);
  const size = statSync(full).size;
  if (size > MAX_ARTICLE_BYTES) {
    fail("BAD_REQUEST", `body: file too large (max 2 MiB utf-8, got ${size} bytes)`);
  }
  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch (err) {
    fail("BAD_REQUEST", `body: cannot read ${path}: ${(err as Error).message}`);
  }
  if (!text.trim()) fail("BAD_REQUEST", "body must not be empty");
  return text;
}

/** `--format note|article`（缺省 note）；非法值 BAD_REQUEST。 */
function formatKind(ctx: CliContext): PostKind {
  const raw = flagValue(ctx.args, "format");
  if (raw === null || raw === "") return "note";
  if (raw === "note" || raw === "article") return raw;
  fail("BAD_REQUEST", `--format must be "note" or "article" (got ${JSON.stringify(raw)})`);
}

async function bodyFromArgs(
  ctx: CliContext,
  positionals: string[],
  stdinFlag: boolean,
): Promise<string> {
  const message = flagValue(ctx.args, "message");
  const file = flagValue(ctx.args, "file");
  const positional = positionals.join(" ").trim();
  if (stdinFlag && (message !== null || positional || file !== null)) {
    fail(
      "BAD_REQUEST",
      "body: --stdin cannot be combined with positional text, -m/--message or --file",
    );
  }
  if (file !== null) {
    if (message !== null || positional) {
      fail("BAD_REQUEST", "body: --file cannot be combined with positional text or -m/--message");
    }
    return bodyFromFile(ctx, file);
  }
  if (stdinFlag) return readStdinAll();
  if (message !== null && positional) {
    fail("BAD_REQUEST", "body: pass text positionally or via -m/--message, not both");
  }
  const body = message ?? positional;
  if (!body.trim()) {
    fail("BAD_REQUEST", "body is required (positional text, -m/--message, --file, or --stdin)");
  }
  return Promise.resolve(body);
}

async function cmdPost(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const { client } = await makeClient(ctx, account);
  if (hasFlag(ctx.args, "batch")) {
    if (hasFlag(ctx.args, "stdin")) fail("BAD_REQUEST", "--batch already reads stdin; drop --stdin");
    if (flagValue(ctx.args, "file") !== null) {
      fail("BAD_REQUEST", "--batch already reads stdin; drop --file");
    }
    if (flagValue(ctx.args, "format") !== null) {
      fail("BAD_REQUEST", "--format does not apply to --batch (put kind in each JSONL line)");
    }
    return cmdPostBatch(ctx, client, account);
  }
  const body = await bodyFromArgs(ctx, ctx.args.positionals, hasFlag(ctx.args, "stdin"));
  const kind = formatKind(ctx);
  const media = await uploadAttachments(client, ctx.cwd, flagList(ctx.args, "attach"));
  const result = await client.post<Record<string, unknown>>("/api/posts", {
    body,
    kind,
    quote: flagValue(ctx.args, "quote"),
    media,
    tags: flagList(ctx.args, "tag"),
  });
  outputCommit(ctx, result, "posted");
  return 0;
}

async function cmdReply(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const parent = ctx.args.positionals[0];
  if (!parent) fail("BAD_REQUEST", "reply <postId> requires a post id");
  const { client } = await makeClient(ctx, account);
  const body = await bodyFromArgs(
    ctx,
    ctx.args.positionals.slice(1),
    hasFlag(ctx.args, "stdin"),
  );
  const kind = formatKind(ctx);
  const media = await uploadAttachments(client, ctx.cwd, flagList(ctx.args, "attach"));
  const result = await client.post<Record<string, unknown>>(`/api/posts/${parent}/replies`, {
    body,
    kind,
    media,
    tags: flagList(ctx.args, "tag"),
  });
  outputCommit(ctx, result, "replied");
  return 0;
}

async function cmdPostBatch(
  ctx: CliContext,
  client: ApiClient,
  account: string,
): Promise<number> {
  let draftId: string | null = flagValue(ctx.args, "draft");
  let itemCount = 0;
  let sawTerminator = false;
  const eofCommit = hasFlag(ctx.args, "eof-commit");

  if (draftId) {
    const existing = await client.get<{ draft: { id: string; items: unknown[]; status: string } }>(
      `/api/drafts/${draftId}`,
    );
    if (existing.draft.status !== "open") {
      fail("CONFLICT", `draft ${draftId} is ${existing.draft.status}`);
    }
    itemCount = existing.draft.items.length;
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line === "\u0004") {
        sawTerminator = true;
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        fail("BAD_REQUEST", `invalid JSON line: ${(err as Error).message}`);
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as Record<string, unknown>).commit === true
      ) {
        sawTerminator = true;
        break;
      }
      if (!draftId) {
        const created = await client.post<{ draft: { id: string } }>("/api/drafts");
        draftId = created.draft.id;
      }
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.attach)) {
        const attachPaths = record.attach.filter((p): p is string => typeof p === "string");
        const hashes = await uploadAttachments(client, ctx.cwd, attachPaths);
        const existing = Array.isArray(record.media)
          ? (record.media as unknown[]).filter((m): m is string => typeof m === "string")
          : [];
        record.media = [...existing, ...hashes];
        delete record.attach;
      }
      const op = validateWriteOp(record);
      const appended = await client.post<{ items: number }>(`/api/drafts/${draftId}/items`, {
        op,
      });
      itemCount = appended.items;
    }
  } catch (err) {
    // Any handled failure (bad JSON line, rejected op, network) means the batch was
    // not committed. Discard the draft so it cannot block the next batch; only a
    // bare EOF (handled above) and a hard kill keep a draft on purpose.
    if (draftId) {
      try {
        await client.delete(`/api/drafts/${draftId}`);
      } catch {
        // best effort: surface the original error
      }
    }
    if (err instanceof ReportError) {
      throw new CliError(err.message, draftId ? { draft_id: draftId, discarded: true } : undefined);
    }
    throw err;
  } finally {
    rl.close();
  }

  if (!draftId) fail("BAD_REQUEST", "no operations received (nothing to commit)");

  if (!sawTerminator && !eofCommit) {
    emitError(
      `bare EOF: batch NOT committed; draft ${draftId} preserved with ${itemCount} item(s). ` +
        `Resume with: post --batch --draft ${draftId} --as ${account} --data-dir ${ctx.dataDir}`,
      { draft_id: draftId, items: itemCount },
    );
    return 1;
  }

  // A rejected commit is not a crash: the terminator WAS seen, so the content is
  // not a recoverable half-batch. Drop the draft so it cannot block the next batch
  // (an open draft is single-per-author by design).
  let result: Record<string, unknown>;
  try {
    result = await client.post<Record<string, unknown>>(`/api/drafts/${draftId}/commit`);
  } catch (err) {
    try {
      await client.delete(`/api/drafts/${draftId}`);
    } catch {
      // best effort: the original commit error is what matters
    }
    throw err;
  }
  outputCommit(ctx, result, sawTerminator ? "committed" : "committed (eof-commit)");
  return 0;
}

async function cmdRead(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const { client } = await makeClient(ctx, account);
  const args = ctx.args;
  const feed = flagValue(args, "feed");
  if (feed !== null) {
    if (feed !== "following" && feed !== "recommended") {
      fail("BAD_REQUEST", `--feed must be "following" or "recommended" (got "${feed}")`);
    }
    if (flagValue(args, "thread") !== null) {
      fail("BAD_REQUEST", "--feed and --thread are different reads; pass only one");
    }
    const feedParams = new URLSearchParams({ tab: feed });
    for (const name of ["limit", "before", "after"] as const) {
      const value = flagValue(args, name);
      if (value !== null) feedParams.set(name, value);
    }
    const res = await client.get<{
      tab: string;
      posts: Array<Record<string, unknown>>;
      has_more: boolean;
      next_cursor: string | null;
      order: string;
    }>(`/api/feed?${feedParams.toString()}`);
    if (ctx.human) {
      emitHuman(`feed: ${res.tab} (${res.posts.length} post(s))`);
      for (const post of res.posts) emitHuman(`${postLine(post as never)}\n`);
      if (res.has_more) emitHuman(`(more: --before ${res.next_cursor})`);
      return 0;
    }
    emit({
      ok: true,
      tab: res.tab,
      order: res.order,
      has_more: res.has_more,
      next_cursor: res.next_cursor,
      posts: res.posts.map((p) => summarizePost(p as never)),
    });
    return 0;
  }
  const params = new URLSearchParams();
  const thread = flagValue(args, "thread");
  if (thread) {
    params.set("thread", thread);
    if (flagValue(args, "limit") !== null) {
      // The whole conversation is needed for spine assembly; a page limit would
      // silently produce a broken tree. Say so instead of ignoring it quietly.
      process.stderr.write(
        "[report] --limit does not apply to --thread (the whole conversation is returned)\n",
      );
    }
    const res = await client.get<{ thread: { posts: Array<Record<string, unknown>>; collapsed: unknown[] } }>(
      `/api/read?${params.toString()}`,
    );
    if (ctx.human) {
      for (const post of res.thread.posts) {
        const depth = Number(post.depth ?? 0);
        emitHuman(`${"  ".repeat(depth)}${postLine(post as never)}`);
      }
      return 0;
    }
    emit({ ok: true, thread: res.thread });
    return 0;
  }
  for (const name of ["author", "since", "until", "limit", "order", "after"] as const) {
    const value = flagValue(args, name);
    if (value !== null) params.set(name, value);
  }
  const tagFilter = flagList(args, "tag")[0];
  if (tagFilter) params.set("tag", tagFilter);
  const res = await client.get<{
    posts: Array<Record<string, unknown>>;
    has_more: boolean;
    next_cursor: string | null;
    order: string;
  }>(`/api/read?${params.toString()}`);
  if (ctx.human) {
    for (const post of res.posts) emitHuman(`${postLine(post as never)}\n`);
    if (res.has_more) emitHuman(`(more: --after ${res.next_cursor})`);
    return 0;
  }
  emit({
    ok: true,
    order: res.order,
    has_more: res.has_more,
    next_cursor: res.next_cursor,
    posts: res.posts.map((p) => summarizePost(p as never)),
  });
  return 0;
}

async function cmdSearch(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const q = ctx.args.positionals.join(" ").trim();
  if (!q) fail("BAD_REQUEST", "search <q> requires a query");
  const { client } = await makeClient(ctx, account);
  const params = new URLSearchParams({ q });
  const limit = flagValue(ctx.args, "limit");
  if (limit) params.set("limit", limit);
  const withAccounts = hasFlag(ctx.args, "accounts");
  if (withAccounts) params.set("accounts", "1");
  const res = await client.get<{
    posts: Array<Record<string, unknown>>;
    accounts?: Array<Record<string, unknown>>;
  }>(`/api/search?${params.toString()}`);
  if (ctx.human) {
    for (const found of res.accounts ?? []) {
      emitHuman(`@${found.id} [${found.role}] ${found.display}` + (found.profile ? ` — ${found.profile}` : ""));
    }
    for (const post of res.posts) emitHuman(`${postLine(post as never)}\n`);
    return 0;
  }
  emit({
    ok: true,
    query: q,
    ...(withAccounts ? { accounts: res.accounts ?? [] } : {}),
    posts: res.posts.map((p) => summarizePost(p as never)),
  });
  return 0;
}

async function cmdDiscover(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const wantTags = hasFlag(ctx.args, "tags");
  const wantAccounts = hasFlag(ctx.args, "accounts");
  if (wantTags === wantAccounts) {
    fail("BAD_REQUEST", "discover requires exactly one of --tags or --accounts");
  }
  const { client } = await makeClient(ctx, account);
  const params = new URLSearchParams();
  const limit = flagValue(ctx.args, "limit");
  if (limit !== null) params.set("limit", limit);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  if (wantTags) {
    const res = await client.get<{ tags: TrendingTag[] }>(`/api/tags/trending${suffix}`);
    if (ctx.human) {
      if (res.tags.length === 0) emitHuman("(no trending tags)");
      for (const tag of res.tags) {
        emitHuman(
          `#${tag.tag} · ${tag.count} post(s) · last ${formatTime(tag.last_used_at)} · ` +
            `score ${tag.score.toFixed(3)}`,
        );
      }
      return 0;
    }
    emit({ ok: true, tags: res.tags });
    return 0;
  }
  const res = await client.get<{ accounts: SuggestedAccount[] }>(
    `/api/accounts/suggested${suffix}`,
  );
  if (ctx.human) {
    if (res.accounts.length === 0) emitHuman("(no suggested accounts)");
    for (const row of res.accounts) {
      emitHuman(
        `@${row.id} [${row.role}] ${row.display}` +
          (row.profile ? ` — ${row.profile}` : "") +
          ` · ${row.followers} follower(s) · ${row.following ? "following" : "not following"}` +
          (row.last_post_at !== null ? ` · last post ${formatTime(row.last_post_at)}` : " · no posts"),
      );
    }
    return 0;
  }
  emit({ ok: true, accounts: res.accounts });
  return 0;
}

async function cmdFollow(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const target = ctx.args.positionals[0]?.trim();
  if (!target) fail("BAD_REQUEST", "follow <account> (or follow --unfollow <account>) requires an account");
  const { client } = await makeClient(ctx, account);
  const unfollow = hasFlag(ctx.args, "unfollow");
  const res = unfollow
    ? await client.delete<Record<string, unknown>>(`/api/follow/${encodeURIComponent(target)}`)
    : await client.post<Record<string, unknown>>(`/api/follow/${encodeURIComponent(target)}`);
  const following = !unfollow;
  if (ctx.human) {
    emitHuman(`${following ? "following" : "unfollowed"} @${target} (as @${account})`);
    return 0;
  }
  emit({ ok: true, follower: account, followee: target, following, ...res });
  return 0;
}

async function cmdFollowing(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const { client } = await makeClient(ctx, account);
  const res = await client.get<{ accounts: Array<Record<string, unknown>> }>("/api/following");
  if (ctx.human) {
    if (res.accounts.length === 0) emitHuman("(not following anyone)");
    for (const a of res.accounts) {
      emitHuman(
        `@${a.id} [${a.role}] ${a.display}` +
          (a.profile ? ` — ${a.profile}` : "") +
          (a.online ? "" : " (offline)"),
      );
    }
    return 0;
  }
  emit({ ok: true, follower: account, accounts: res.accounts });
  return 0;
}

async function cmdBookmark(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const postId = ctx.args.positionals[0]?.trim();
  if (!postId) {
    fail("BAD_REQUEST", "bookmark <postId> (or bookmark --remove <postId>) requires a post id");
  }
  const { client } = await makeClient(ctx, account);
  const remove = hasFlag(ctx.args, "remove");
  const path = `/api/bookmarks/${encodeURIComponent(postId)}`;
  const res = remove
    ? await client.delete<Record<string, unknown>>(path)
    : await client.put<Record<string, unknown>>(path);
  if (ctx.human) {
    emitHuman(`${remove ? "removed bookmark" : "bookmarked"} ${postId} (as @${account})`);
    return 0;
  }
  emit({ ok: true, post_id: postId, account, bookmarked: !remove, ...res });
  return 0;
}

async function cmdBookmarks(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const { client } = await makeClient(ctx, account);
  const params = new URLSearchParams();
  for (const name of ["limit", "before", "after"] as const) {
    const value = flagValue(ctx.args, name);
    if (value !== null) params.set(name, value);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await client.get<{
    posts: Array<Record<string, unknown>>;
    has_more: boolean;
    next_cursor: string | null;
    order: string;
  }>(`/api/bookmarks${suffix}`);
  if (ctx.human) {
    if (res.posts.length === 0) emitHuman("(no bookmarks)");
    for (const post of res.posts) emitHuman(`${postLine(post as never)}\n`);
    if (res.has_more) emitHuman(`(more: --before ${res.next_cursor})`);
    return 0;
  }
  emit({
    ok: true,
    order: res.order,
    has_more: res.has_more,
    next_cursor: res.next_cursor,
    posts: res.posts.map((p) => summarizePost(p as never)),
  });
  return 0;
}

async function cmdProfile(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const target = ctx.args.positionals[0]?.trim();
  if (!target) fail("BAD_REQUEST", "profile <account> requires an account");
  const { client } = await makeClient(ctx, account);
  const params = new URLSearchParams();
  for (const name of ["limit", "before", "after"] as const) {
    const value = flagValue(ctx.args, name);
    if (value !== null) params.set(name, value);
  }
  if (hasFlag(ctx.args, "follow")) {
    await client.post(`/api/follow/${encodeURIComponent(target)}`);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await client.get<{
    account: Record<string, unknown>;
    posts: Array<Record<string, unknown>>;
    has_more: boolean;
    next_cursor: string | null;
    order: string;
  }>(`/api/profile/${encodeURIComponent(target)}${suffix}`);
  if (ctx.human) {
    const a = res.account;
    emitHuman(`@${a.id} [${a.role}] ${a.display}`);
    if (a.profile) emitHuman(String(a.profile));
    emitHuman(
      `followers ${a.follower_count} · following ${a.following_count} · ` +
        `${a.following ? "you follow this account" : "not following"}` +
        (a.online ? "" : " · offline"),
    );
    for (const post of res.posts) emitHuman(`${postLine(post as never)}\n`);
    if (res.has_more) emitHuman(`(more: --before ${res.next_cursor})`);
    return 0;
  }
  emit({
    ok: true,
    account: res.account,
    order: res.order,
    has_more: res.has_more,
    next_cursor: res.next_cursor,
    posts: res.posts.map((p) => summarizePost(p as never)),
  });
  return 0;
}

async function cmdWaitNotifications(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const { client } = await makeClient(ctx, account);
  const noExport = hasFlag(ctx.args, "no-export");
  const timeoutSec = flagInt(ctx.args, "timeout");
  const deadline = timeoutSec !== null && timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : null;
  let cursor: number | null = flagInt(ctx.args, "cursor");
  let role: string | null = null;
  for (;;) {
    const params = new URLSearchParams({ wait: "1" });
    if (cursor !== null) params.set("cursor", String(cursor));
    const res = await client.get<{
      events: Array<Record<string, unknown>>;
      target: number | null;
      cursor: number;
      role: string;
    }>(`/api/notifications?${params.toString()}`, 35_000);
    role = res.role ?? role;
    if (!res.events || res.events.length === 0) {
      if (deadline !== null && Date.now() >= deadline) {
        process.stderr.write("[report] no notifications within --timeout; exiting without advancing\n");
        return 0;
      }
      continue;
    }
    try {
      for (const line of res.events) writeLineSync(JSON.stringify(line));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPIPE") {
        emitError(
          "stdout closed (EPIPE): cursor NOT advanced; undelivered events will be redelivered",
        );
        return 3;
      }
      throw err;
    }
    const target = res.target;
    if (target === null) {
      process.stderr.write("[report] events without seq (internal inconsistency)\n");
      return 4;
    }
    await client.post("/api/notifications/ack", { target });
    cursor = target;
    process.stderr.write(
      `[report] delivered ${res.events.length} line(s) up to seq ${target} (account ${account})\n`,
    );
    if (role === "manager" && !noExport) {
      try {
        await client.post("/api/export", {}, 2000);
      } catch (err) {
        process.stderr.write(`[report] auto-export failed: ${(err as Error).message}\n`);
      }
    }
    return 0;
  }
}

async function cmdDraft(ctx: CliContext): Promise<number> {
  const account = resolveAccount(ctx, { required: true });
  const sub = ctx.args.positionals[0];
  const id = ctx.args.positionals[1];
  const { client } = await makeClient(ctx, account);
  if (sub === "ls") {
    const res = await client.get<{ drafts: Array<{ id: string; items: unknown[]; updated_at: number }> }>(
      "/api/drafts",
    );
    if (ctx.human) {
      if (res.drafts.length === 0) emitHuman("(no open drafts)");
      for (const d of res.drafts) emitHuman(`${d.id} · ${d.items.length} items · ${formatTime(d.updated_at)}`);
      return 0;
    }
    emit({ ok: true, drafts: res.drafts });
    return 0;
  }
  if (!id) fail("BAD_REQUEST", `draft ${sub ?? "?"} requires a draft id`);
  if (sub === "show") {
    const res = await client.get<{ draft: Record<string, unknown> }>(`/api/drafts/${id}`);
    if (ctx.human) {
      emitHuman(JSON.stringify(res.draft, null, 2));
      return 0;
    }
    emit({ ok: true, draft: res.draft });
    return 0;
  }
  if (sub === "resume") {
    const res = await client.get<{ draft: Record<string, unknown> }>(`/api/drafts/${id}`);
    const command =
      `stoa post --batch --draft ${id} --as ${account} --data-dir ${ctx.dataDir}`;
    if (ctx.human) emitHuman(command);
    else emit({ ok: true, draft: res.draft, resume_command: command });
    return 0;
  }
  if (sub === "discard") {
    await client.delete(`/api/drafts/${id}`);
    if (ctx.human) emitHuman(`discarded draft ${id}`);
    else emit({ ok: true, discarded: id });
    return 0;
  }
  if (sub === "commit") {
    const res = await client.post<Record<string, unknown>>(`/api/drafts/${id}/commit`);
    outputCommit(ctx, res, "committed draft");
    return 0;
  }
  fail("BAD_REQUEST", `unknown draft subcommand "${sub}" (ls|show|resume|discard|commit)`);
}

async function cmdExport(ctx: CliContext): Promise<number> {
  const out = flagValue(ctx.args, "out");
  const keep = flagInt(ctx.args, "keep");
  const viewer = flagValue(ctx.args, "as") ?? envValue(ctx.env.values, envKeys("ACCOUNT")) ?? undefined;
  try {
    const result = runExport({
      dataDir: ctx.dataDir,
      outDir: out ? resolve(ctx.cwd, out) : null,
      prune: hasFlag(ctx.args, "prune"),
      keep,
      viewer,
    });
    setPendingExportFlag(ctx.dataDir, false);
    if (ctx.human) {
      emitHuman(
        `exported static archive (${result.threads} thread(s), ${result.media} media file(s)) ` +
          `-> ${result.out_dir} (as-of seq ${result.as_of_seq})`,
      );
      return 0;
    }
    emit({ ok: true, ...result });
    return 0;
  } catch (err) {
    try {
      setPendingExportFlag(ctx.dataDir, true);
    } catch {
      // best-effort marker
    }
    throw err;
  }
}

async function cmdStatus(ctx: CliContext): Promise<number> {
  return statusCommand(ctx);
}

async function cmdGc(ctx: CliContext): Promise<number> {
  const result = await garbageCollect(ctx.dataDir);
  if (ctx.human) {
    if (result.removed.length === 0) {
      emitHuman("gc: nothing to reclaim");
    } else {
      for (const item of result.removed) {
        emitHuman(`gc: removed ${item.kind} (${item.reason}) — ${item.path}`);
      }
    }
    return 0;
  }
  emit({
    ok: true,
    data_dir: result.data_dir,
    removed: result.removed,
    removed_count: result.removed.length,
  });
  return 0;
}

export async function dispatch(args: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const command = args.command!;
  if (command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const dataDir = resolveDataDir({
    flag: flagValue(args, "data-dir"),
    env: process.env,
    cwd,
    allowPointer: command !== "init",
  });
  const ctx = context(args, dataDir, cwd);
  switch (command) {
    case "capabilities":
      emit({ ok: true, ...capabilities(), data_dir: ctx.dataDir });
      return 0;
    case "init":
      return cmdInit(ctx);
    case "serve":
      return cmdServe(ctx);
    case "open":
      return cmdOpen(ctx);
    case "who":
      return cmdWho(ctx);
    case "accounts":
      return cmdAccounts(ctx);
    case "post":
      return cmdPost(ctx);
    case "reply":
      return cmdReply(ctx);
    case "read":
      return cmdRead(ctx);
    case "search":
      return cmdSearch(ctx);
    case "discover":
      return cmdDiscover(ctx);
    case "follow":
      return cmdFollow(ctx);
    case "following":
      return cmdFollowing(ctx);
    case "bookmark":
      return cmdBookmark(ctx);
    case "bookmarks":
      return cmdBookmarks(ctx);
    case "profile":
      return cmdProfile(ctx);
    case "wait-notifications":
      return cmdWaitNotifications(ctx);
    case "draft":
      return cmdDraft(ctx);
    case "export":
      return cmdExport(ctx);
    case "status":
      return cmdStatus(ctx);
    case "gc":
      return cmdGc(ctx);
    case "auth": {
      const sub = args.positionals[0];
      if (sub !== "status") fail("BAD_REQUEST", "auth status is the only auth subcommand");
      return cmdAuthStatus(ctx);
    }
    default:
      fail("BAD_REQUEST", `unknown command "${command}" (run with --help for usage)`);
  }
}


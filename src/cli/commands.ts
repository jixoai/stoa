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
import { assertPortInRange, portIsListening } from "../server/ports.ts";
import { garbageCollect } from "../server/gc.ts";
import { runExport, setPendingExportFlag } from "../server/export.ts";
import { daemonRequest, probeDaemon } from "../daemon/client.ts";
import { openDaemonLogFd, daemonEntryFromProcess, runDaemon } from "../daemon/run.ts";
import {
  DAEMON_DEFAULT_PORT,
  DAEMON_PORT_ENV,
  daemonLogPath,
  daemonPortCandidates,
  readDaemonInfo,
  readServices,
  removeDaemonInfo,
  resolveDaemonStateDir,
  sameDataDir,
  tailFile,
  type DaemonInfo,
  type ServiceRecord,
} from "../daemon/state.ts";
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
import { endpointOfInfo, type InstanceEndpoint } from "../server/instance-client.ts";
import { emit, emitError, emitHuman, formatTime, postLine, summarizePost, writeLineSync } from "./output.ts";
import { loadToken, resolveMcpConfig, type McpConfig } from "../mcp/config.ts";
import { runMcpServer } from "../mcp/server.ts";

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
  // UDS 优先（daemon 托管实例不占 TCP）；standalone 回落 TCP origin。
  const endpoint = endpointOfInfo(info);
  const status = await fetchAuthMode(info.url, endpoint);
  const token = resolveToken(ctx.env, account);
  if (status.mode === "auth" && !token) {
    fail(
      "UNAUTHORIZED",
      `authentication is ON but no account token for "${account}" was found in the loaded env files. ` +
        `Pass --env-files ${join(ctx.dataDir, "accounts", `${account}.env`)} (each account token lives in its own 0600 file).`,
    );
  }
  return {
    client: new ApiClient({ baseUrl: info.url, account, token, endpoint }),
    url: info.url,
    authMode: status.mode,
  };
}

/** 只读命令里支持直连模式的命令（`--base-url` / STOA_BASE_URL 存在时不需要 data-dir 指针）。 */
const DIRECT_MODE_COMMANDS = new Set(["read", "status", "wait-notifications"]);

/**
 * 直连模式判定的第一层（data-dir 解析失败时也要能判定）：`--base-url` 显式给值，
 * 或进程 env / 显式 env 文件里有 `STOA_BASE_URL` / `REPORT_CHANNEL_BASE_URL`。
 */
function baseUrlRequested(args: ParsedArgs, cwd: string): boolean {
  const flagBaseUrl = flagValue(args, "base-url");
  if (flagBaseUrl !== null && flagBaseUrl.trim() !== "") return true;
  if (envBaseUrl(process.env)) return true;
  const explicit =
    flagValue(args, "env-files") ?? envValue(process.env, envKeys("ENV_FILES")) ?? null;
  // 与 context() 的 env 文件选择保持一致：显式列表优先，否则只看 cwd/.env.personal
  // （dataDir/.env 需要 data-dir，解析失败时无从得知）。
  const paths =
    explicit !== null
      ? explicit
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => resolve(cwd, p))
      : [resolve(cwd, ".env.personal")].filter((p) => existsSync(p));
  return paths.length > 0 && Boolean(envBaseUrl(loadEnvFiles(paths).values));
}

/** 直连模式的 baseUrl 环境层（与 `stoa mcp` 同一双前缀口径）。 */
function envBaseUrl(env: Record<string, string | undefined>): string {
  const stoa = (env.STOA_BASE_URL ?? "").trim();
  if (stoa) return stoa;
  return (env.REPORT_CHANNEL_BASE_URL ?? "").trim();
}

/** CLI 上下文里的完整 env 视图：env 文件覆盖进程 env（与 LiveEnv 一致）。 */
function mergedEnv(ctx: CliContext): Record<string, string | undefined> {
  return { ...process.env, ...ctx.env.values };
}

/**
 * 直连配置（B2 修复）：显式 `--base-url` 或 `STOA_BASE_URL`/`REPORT_CHANNEL_BASE_URL`
 * 存在时，用与 `stoa mcp` 相同的 `resolveMcpConfig` 构造配置，不依赖 data-dir 指针；
 * 否则返回 null，保持原指针发现语义（向后兼容）。
 */
function directMcpConfig(ctx: CliContext): McpConfig | null {
  const flagBaseUrl = flagValue(ctx.args, "base-url");
  const env = mergedEnv(ctx);
  const explicitFlag = flagBaseUrl !== null && flagBaseUrl.trim() !== "";
  if (!explicitFlag && !envBaseUrl(env)) return null;
  return resolveMcpConfig({
    flags: {
      baseUrl: flagBaseUrl,
      token: flagValue(ctx.args, "token"),
      account: flagValue(ctx.args, "account"),
      dataDir: flagValue(ctx.args, "data-dir") !== null ? ctx.dataDir : null,
      publicUrl: flagValue(ctx.args, "public-url"),
      config: flagValue(ctx.args, "config"),
    },
    env,
  });
}

interface CommandClient {
  client: ApiClient;
  url: string;
  account: string;
  authMode: "open" | "auth";
  direct: boolean;
}

/**
 * 只读命令的客户端解析：直连模式优先（`--as` > 配置账号；token 走 mcp 的
 * `loadToken` 层序），否则回落 data-dir 指针发现 + 账号必填的旧语义。
 */
async function commandClient(
  ctx: CliContext,
  opts: { required?: boolean; defaultOwner?: boolean } = {},
): Promise<CommandClient> {
  const direct = directMcpConfig(ctx);
  if (direct) {
    const account = flagValue(ctx.args, "as")?.trim() || direct.account;
    const cfg = { ...direct, account };
    const token = loadToken(cfg, mergedEnv(ctx));
    return {
      client: new ApiClient({ baseUrl: cfg.baseUrl, account, token }),
      url: cfg.baseUrl,
      account,
      authMode: token ? "auth" : "open",
      direct: true,
    };
  }
  const account = resolveAccount(ctx, opts);
  const made = await makeClient(ctx, account);
  return { ...made, account, direct: false };
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
  // 兼容旧 `--daemon`：detach 单个 standalone 实例（不进 daemon、不进登记）。
  if (hasFlag(args, "daemon")) return startDaemon(ctx);
  // `--standalone`（旧默认行为：前台占用终端）或 `--unix`（daemon 托管的 UDS 实例，
  // 由 daemon 以子进程拉起并持有生命周期）：两者都是前台 serve 语义。
  if (hasFlag(args, "standalone") || flagValue(args, "unix") !== null) return serveStandalone(ctx);
  // 默认：挂到 daemon（stoa-daemon design §3）——起 daemon（按需）→ 挂载 → 打印两链接 → 释放终端。
  return serveViaDaemon(ctx);
}

/** 前台 serve（`--standalone`）：占用终端直到 Ctrl-C；stdout 首行 `REPORT_URL=`。 */
async function serveStandalone(ctx: CliContext): Promise<number> {
  const args = ctx.args;
  const port = flagInt(args, "port");
  const host = flagValue(args, "host") ?? "127.0.0.1";
  // `--unix`（daemon 托管）：UDS 监听，不占 TCP；`--url` 是 daemon 注入的逻辑 URL。
  const unix = flagValue(args, "unix");
  const running = await startServer({
    dataDir: ctx.dataDir,
    port,
    host,
    unix,
    logicalUrl: flagValue(args, "url"),
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

// ── daemon（stoa-daemon design §1/§3） ───────────────────────────────────────

function daemonStateDirFromArgs(args: ParsedArgs, cwd: string): string {
  return resolveDaemonStateDir({ flag: flagValue(args, "state-dir"), env: process.env, cwd });
}

/** 显式 daemon 端口（`--daemon-port` > `STOA_DAEMON_PORT`）；null = 自动择优。 */
function daemonPortFromArgs(args: ParsedArgs): number | null {
  const fromFlag = flagInt(args, "daemon-port");
  if (fromFlag !== null) return fromFlag;
  const raw = (process.env[DAEMON_PORT_ENV] ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    fail("BAD_REQUEST", `${DAEMON_PORT_ENV} must be an integer (got ${raw})`);
  }
  return value;
}

/**
 * 确保 daemon 在跑（幂等）：已有健康 daemon 直接复用；没有则 detached 拉起并等
 * `/healthz` 就绪。候选端口：显式给值只用它；否则 13679→13670 向下找空位
 * （同机多会话各持一个 daemon 时不会互抢）。
 */
async function ensureDaemon(opts: {
  stateDir: string;
  port: number | null;
  cwd: string;
}): Promise<DaemonInfo> {
  const existing = readDaemonInfo(opts.stateDir);
  if (existing) {
    const health = await probeDaemon(existing.url, 600);
    if (health && health.stateDir === opts.stateDir) return existing;
    removeDaemonInfo(opts.stateDir); // stale（进程已死/端口已被别人接管）
  }
  const entry = daemonEntryFromProcess();
  let lastDetail = "no candidate port";
  for (const port of daemonPortCandidates(opts.port)) {
    const occupied = await probeDaemon(`http://127.0.0.1:${port}`, 500);
    if (occupied) {
      lastDetail = `port ${port} already hosts a stoa daemon (state ${occupied.stateDir})`;
      if (opts.port !== null) fail("CONFLICT", lastDetail);
      continue;
    }
    // 非 stoa 监听者：Bun 对本机已占用端口不抛错（会静默共享），必须显式探测后跳过。
    if (await portIsListening("127.0.0.1", port)) {
      lastDetail = `port ${port} is already in use by another process`;
      if (opts.port !== null) fail("CONFLICT", lastDetail);
      continue;
    }
    const fd = openDaemonLogFd(opts.stateDir);
    const child = spawn(
      entry.bin,
      [...entry.args, "daemon", "run", "--port", String(port), "--state-dir", opts.stateDir],
      { cwd: opts.cwd, detached: true, stdio: ["ignore", fd, fd], env: process.env },
    );
    child.unref();
    closeSync(fd);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const info = readDaemonInfo(opts.stateDir);
      if (info) {
        const health = await probeDaemon(info.url, 600);
        if (health && health.stateDir === opts.stateDir) return info;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        lastDetail = `daemon exited during startup (code ${child.exitCode ?? "null"}):\n${tailFile(daemonLogPath(opts.stateDir))}`;
        break; // 退出内层等待；外层 for 继续尝试下一个候选端口
      }
      if (Date.now() > deadline) {
        lastDetail = `daemon did not become healthy within 10s:\n${tailFile(daemonLogPath(opts.stateDir))}`;
        try {
          if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
        } catch {
          // already gone
        }
        break; // 同上
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  fail("UNAVAILABLE", `cannot start stoa daemon: ${lastDetail}`);
}

/** `stoa serve`（默认）：daemon 模式——挂载本 dataDir 的服务并立即释放终端。 */
async function serveViaDaemon(ctx: CliContext): Promise<number> {
  const args = ctx.args;
  const stateDir = daemonStateDirFromArgs(args, ctx.cwd);
  const port = flagInt(args, "port");
  if (port !== null) assertPortInRange(port);
  const daemon = await ensureDaemon({
    stateDir,
    port: daemonPortFromArgs(args),
    cwd: ctx.cwd,
  });
  const idleTimeoutMs = idleTimeoutMsFromArgs(args);
  const out = await daemonRequest<{
    ok: true;
    service: ServiceRecord;
    reused: boolean;
    adopted: boolean;
    warnings?: string[];
  }>(daemon.url, "/api/daemon/services", {
    method: "POST",
    body: {
      dataDir: ctx.dataDir,
      port,
      name: flagValue(args, "name"),
      envFiles: ctx.envFiles.length > 0 ? ctx.envFiles : null,
      host: flagValue(args, "host"),
      idleTimeoutMs: idleTimeoutMs ?? null,
      expose: hasFlag(args, "expose") || null,
      allowOpenExpose: hasFlag(args, "allow-open-expose") || null,
    },
  });
  const service = out.service;
  const note = out.adopted ? " (adopted an already-running instance)" : out.reused ? " (already mounted)" : "";
  process.stderr.write(`[stoa] service ${service.url} mounted in daemon ${daemon.url}${note}\n`);
  for (const warning of out.warnings ?? []) process.stderr.write(`[stoa] ${warning}\n`);
  if (ctx.human) {
    emitHuman(`service : ${service.url}`);
    emitHuman(`daemon  : ${daemon.url}`);
    emitHuman(`data dir: ${service.dataDir}`);
    if (service.log) emitHuman(`log     : ${service.log}`);
  } else {
    emit({
      ok: true,
      detached: true,
      service: {
        id: service.id,
        name: service.name,
        slug: service.slug,
        hostnames: service.hostnames,
        data_dir: service.dataDir,
        // daemon 托管实例不占 TCP：port=null，I/O 通道是 socket，浏览器通道是 url。
        port: service.port,
        socket: service.socket ?? null,
        pid: service.pid,
        url: service.url,
        status: service.status,
        auth_account: service.authAccount ?? null,
        log: service.log,
      },
      daemon: {
        url: daemon.url,
        state_dir: daemon.stateDir,
        pid: daemon.pid,
        version: daemon.version,
      },
      service_url: service.url,
      daemon_url: daemon.url,
      warnings: out.warnings ?? [],
    });
  }
  return 0;
}

/** `stoa daemon start|stop|status|run`（不需要 data-dir；state-dir 决定“哪一个 daemon”）。 */
async function cmdDaemon(args: ParsedArgs, cwd: string): Promise<number> {
  const sub = args.positionals[0] ?? "status";
  const human = hasFlag(args, "human");
  const stateDir = daemonStateDirFromArgs(args, cwd);

  if (sub === "run") {
    // daemon 自身没有 data-dir/服务端口语义：`--port`（或 `--daemon-port`/env）就是 daemon 端口。
    const port = flagInt(args, "port") ?? daemonPortFromArgs(args) ?? DAEMON_DEFAULT_PORT;
    return runDaemon({ stateDir, port, host: flagValue(args, "host") ?? undefined, cwd });
  }

  if (sub === "start") {
    const info = await ensureDaemon({ stateDir, port: daemonPortFromArgs(args), cwd });
    if (human) {
      emitHuman(`stoa daemon running at ${info.url} (pid ${info.pid})`);
      emitHuman(`state   : ${info.stateDir}`);
      emitHuman(`console : ${info.url}`);
    } else {
      emit({ ok: true, running: true, ...info });
    }
    return 0;
  }

  if (sub === "status") {
    const info = readDaemonInfo(stateDir);
    const health = info ? await probeDaemon(info.url, 800) : null;
    let services: ServiceRecord[] = readServices(stateDir);
    if (health && info) {
      try {
        services = (await daemonRequest<{ services: ServiceRecord[] }>(info.url, "/api/daemon/services")).services;
      } catch {
        // 列表拉取失败时保留文件快照
      }
    }
    if (human) {
      emitHuman(
        health && info
          ? `stoa daemon running at ${info.url} (pid ${info.pid})`
          : "stoa daemon is not running",
      );
      emitHuman(`state   : ${stateDir}`);
      for (const service of services) {
        emitHuman(
          `  ${service.status === "running" ? "●" : "○"} ${service.name} [${service.status}] ${service.url ?? service.dataDir}`,
        );
      }
      return 0;
    }
    emit({
      ok: true,
      running: Boolean(health),
      state_dir: stateDir,
      daemon: info,
      stale: Boolean(info && !health),
      services,
    });
    return 0;
  }

  if (sub === "stop") {
    const info = readDaemonInfo(stateDir);
    if (!info) {
      if (human) emitHuman("stoa daemon is not running");
      else emit({ ok: true, running: false, stopped: false, state_dir: stateDir });
      return 0;
    }
    let apiStopped = false;
    try {
      await daemonRequest(info.url, "/api/daemon/shutdown", { method: "POST", timeoutMs: 5000 });
      apiStopped = true;
    } catch {
      // daemon 面不可达：直接走信号兜底
    }
    const waitGone = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!(await probeDaemon(info.url, 400))) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return !(await probeDaemon(info.url, 400));
    };
    let gone = await waitGone(20_000);
    let forced = false;
    if (!gone) {
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {
        // already gone
      }
      gone = await waitGone(8000);
    }
    if (!gone) {
      forced = true;
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    // 兜底清扫：daemon 被强杀时，其挂载的服务可能还活着（登记为准）。
    const leftovers = readServices(stateDir).filter((service) => service.status === "running");
    for (const service of leftovers) {
      if (service.pid === null) continue;
      try {
        process.kill(service.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    removeDaemonInfo(stateDir);
    if (human) {
      emitHuman(`stopped stoa daemon (pid ${info.pid})${forced ? " [SIGKILL]" : ""}`);
      if (leftovers.length > 0) emitHuman(`signaled ${leftovers.length} mounted service(s) to stop`);
    } else {
      emit({
        ok: true,
        running: false,
        stopped: true,
        pid: info.pid,
        via_api: apiStopped,
        forced,
        signaled_services: leftovers.length,
        state_dir: stateDir,
      });
    }
    return 0;
  }

  fail("BAD_REQUEST", `unknown daemon subcommand "${sub}" (expected start|stop|status|run)`);
}

/**
 * `serve --stop` 的 daemon 感知：该 dataDir 正被本机默认 state-dir 的 daemon 挂载时，
 * 走 daemon 的 stop（服务与登记一起收口）；否则返回 null 回落本地停机路径。
 */
async function stopViaDaemon(ctx: CliContext): Promise<ServiceRecord | null> {
  // daemon 自己的 stop 子进程必须走本地停机（否则会回调正在等待它的 daemon → 重入死锁）。
  if (process.env.STOA_DAEMON_STOP_DIRECT === "1") return null;
  try {
    const stateDir = daemonStateDirFromArgs(ctx.args, ctx.cwd);
    const info = readDaemonInfo(stateDir);
    if (!info) return null;
    const health = await probeDaemon(info.url, 500);
    if (!health || health.stateDir !== stateDir) return null;
    const list = (
      await daemonRequest<{ services: ServiceRecord[] }>(info.url, "/api/daemon/services")
    ).services;
    // 任何登记（running 或已被探测降级但进程仍在）都交给 daemon 收口——stop 是幂等的。
    const record = list.find((service) => sameDataDir(service.dataDir, ctx.dataDir));
    if (!record) return null;
    const out = await daemonRequest<{ service: ServiceRecord }>(
      info.url,
      `/api/daemon/services/${record.id}/stop`,
      { method: "POST", timeoutMs: 30_000 },
    );
    return out.service;
  } catch {
    return null; // daemon 面任何问题都不阻断本地停机
  }
}

function daemonArgs(ctx: CliContext): string[] {
  const args = ctx.args;
  // `--standalone` 关键：detach 出来的子进程必须显式脱离 daemon 默认路径，否则递归。
  const out: string[] = ["serve", "--standalone", "--data-dir", ctx.dataDir];
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
  // daemon 挂载的服务：走 daemon 的 stop（服务与登记一起收口，避免登记悬挂）。
  const viaDaemon = await stopViaDaemon(ctx);
  if (viaDaemon) {
    if (ctx.human) emitHuman(`stopped report service (pid ${viaDaemon.pid}) [via daemon]`);
    else {
      emit({
        ok: true,
        running: false,
        stopped: true,
        pid: viaDaemon.pid,
        via_daemon: true,
        service: {
          id: viaDaemon.id,
          name: viaDaemon.name,
          data_dir: viaDaemon.dataDir,
          status: viaDaemon.status,
        },
      });
    }
    return 0;
  }
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
  const direct = directMcpConfig(ctx);
  if (direct) return directStatusCommand(ctx, direct);
  const all = hasFlag(ctx.args, "all");
  const status = await serverStatus(ctx.dataDir);
  let live: unknown = null;
  if (status.running && status.url) {
    const account = flagValue(ctx.args, "as") ?? envValue(ctx.env.values, envKeys("ACCOUNT")) ?? "owner";
    const token = resolveToken(ctx.env, account);
    const endpoint: InstanceEndpoint = {
      unix: status.unix ?? null,
      url: status.url,
      port: status.port ?? null,
    };
    try {
      const client = new ApiClient({ baseUrl: status.url, account, token, endpoint });
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

/**
 * `status` 直连模式（B2）：配置来自 `--base-url`/STOA_BASE_URL/`stoa mcp` 同源解析，
 * 不再读 data-dir 指针；`--as` 覆盖账号，`--token`/accounts env 文件提供凭据。
 */
async function directStatusCommand(ctx: CliContext, cfg: McpConfig): Promise<number> {
  const all = hasFlag(ctx.args, "all");
  const account = flagValue(ctx.args, "as")?.trim() || cfg.account;
  const effective = { ...cfg, account };
  const token = loadToken(effective, mergedEnv(ctx));
  const client = new ApiClient({ baseUrl: effective.baseUrl, account, token });
  let live: unknown;
  let reachable = true;
  try {
    live = await client.get("/api/status");
  } catch (err) {
    reachable = false;
    live = { error: (err as Error).message };
  }
  const instance = {
    mode: "direct",
    running: reachable,
    url: effective.baseUrl,
    account,
    data_dir: effective.dataDir || null,
    config_path: effective.path,
  };
  if (ctx.human) {
    emitHuman("mode    : direct (--base-url / STOA_BASE_URL / report-channel config)");
    emitHuman(`url     : ${effective.baseUrl}`);
    emitHuman(`account : @${account}`);
    emitHuman(`config  : ${effective.path}`);
    if (effective.dataDir) emitHuman(`data dir: ${effective.dataDir}`);
    if (!reachable) {
      emitHuman(`live    : ${String((live as { error?: unknown }).error ?? "unreachable")}`);
      return 0;
    }
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
    return 0;
  }
  if (all) {
    emit({
      ok: true,
      mode: "direct",
      data_dir: effective.dataDir || null,
      instances: [instance],
      live,
    });
    return 0;
  }
  emit({ ok: true, mode: "direct", running: reachable, server: instance, live });
  return 0;
}

async function cmdAuthStatus(ctx: CliContext): Promise<number> {
  const authValue = envValue(ctx.env.values, envKeys("AUTH")) ?? "";
  const localMode = authValue ? "auth" : "open";
  let serverView: unknown = null;
  const status = await serverStatus(ctx.dataDir).catch(() => null);
  if (status?.running && status.url) {
    try {
      serverView = await fetchAuthMode(status.url, {
        unix: status.unix ?? null,
        url: status.url,
        port: status.port ?? null,
      });
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
  const { client } = await commandClient(ctx, { required: true });
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
  const { client, account } = await commandClient(ctx, { required: true });
  const noExport = hasFlag(ctx.args, "no-export");
  const timeoutSec = flagInt(ctx.args, "timeout");
  const deadline = timeoutSec !== null && timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : null;
  let cursor: number | null = flagInt(ctx.args, "cursor");
  let role: string | null = null;
  for (;;) {
    const params = new URLSearchParams({ wait: "1" });
    if (cursor !== null) params.set("cursor", String(cursor));
    // 有界语义（评审 P2-1）：请求超时收敛到剩余预算（+0.5s 余量），不再被服务端 25s
    // 长轮询拖住；超时视为本轮无事件，到期限则退出 0 且不推进游标。
    const requestTimeoutMs =
      deadline === null ? 35_000 : Math.max(1_000, Math.min(35_000, deadline - Date.now() + 500));
    let res: {
      events: Array<Record<string, unknown>>;
      target: number | null;
      cursor: number;
      role: string;
    };
    try {
      res = await client.get(`/api/notifications?${params.toString()}`, requestTimeoutMs);
    } catch (err) {
      if (
        deadline !== null &&
        Date.now() >= deadline &&
        (err as CliError)?.detail?.timeout === true
      ) {
        process.stderr.write("[report] no notifications within --timeout; exiting without advancing\n");
        return 0;
      }
      throw err;
    }
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

/**
 * `stoa mcp`（stoa-adapters design §2）：stdio MCP server。
 * 配置自含（flags > STOA_* > 兼容旧前缀 > 配置文件 > 默认），
 * 不依赖 data-dir 指针发现；stdout 只跑 JSON-RPC，凭据绝不打印。
 *
 * P2-11：`--env-files` 走与其它 CLI 命令相同的 env 文件加载（显式列表 > STOA_ENV_FILES >
 * cwd/.env.personal + <dataDir>/.env），env 文件值覆盖进程 env；`--as` 为服务级账号覆盖
 * （最高优先，高于 FORCE_ACCOUNT 与配置账号）。
 */
async function cmdMcp(args: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const flags = {
    baseUrl: flagValue(args, "base-url"),
    token: flagValue(args, "token"),
    account: flagValue(args, "account"),
    dataDir: flagValue(args, "data-dir"),
    publicUrl: flagValue(args, "public-url"),
    config: flagValue(args, "config"),
  };
  // 第一遍只用进程 env 定位 dataDir（决定默认 env 文件路径），第二遍用 env 文件覆盖后的
  // 完整 env 解析最终配置（与 CLI 其它命令的「env 文件覆盖进程 env」一致）。
  const first = resolveMcpConfig({ flags, env: process.env });
  const explicitEnvFiles =
    flagValue(args, "env-files") ?? envValue(process.env, envKeys("ENV_FILES")) ?? null;
  const envFiles =
    explicitEnvFiles !== null
      ? explicitEnvFiles
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => resolve(cwd, p))
      : resolveEnvFiles({ dataDir: first.dataDir, cwd });
  const env = { ...process.env, ...loadEnvFiles(envFiles).values };
  const cfg = resolveMcpConfig({ flags, env });
  const as = flagValue(args, "as")?.trim();
  const effective = as ? { ...cfg, account: as, accountOverride: as } : cfg;
  return runMcpServer(effective, { env });
}

export async function dispatch(args: ParsedArgs): Promise<number> {
  const cwd = process.cwd();
  const command = args.command!;
  if (command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  // `stoa mcp` 是长驻 stdio 服务：配置自含（flags/env/配置文件），不经过
  // 通用的 --data-dir 指针发现（否则无指针目录里根本起不来）。
  if (command === "mcp") return cmdMcp(args);
  // `stoa daemon` 同理：daemon 的状态由 --state-dir/默认状态目录决定，不需要 data-dir。
  if (command === "daemon") return cmdDaemon(args, cwd);
  // 直连模式（B2）：read/status/wait-notifications 允许完全没有 data-dir 指针——
  // 只要显式 base-url/env 文件里有板地址，就跳过「data-dir 解析失败」直接走直连配置。
  let dataDir: string;
  try {
    dataDir = resolveDataDir({
      flag: flagValue(args, "data-dir"),
      env: process.env,
      cwd,
      allowPointer: command !== "init",
    });
  } catch (err) {
    if (
      !DIRECT_MODE_COMMANDS.has(command) ||
      !(err instanceof ReportError) ||
      !baseUrlRequested(args, cwd)
    ) {
      throw err;
    }
    dataDir = "";
  }
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


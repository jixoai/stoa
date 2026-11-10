/**
 * daemon HTTP 面（stoa-daemon design §1/§2/§4）：
 *   GET    /healthz                      — daemon 健康（含服务计数；stateDir 用于归属判定）
 *   GET    /api/daemon/info              — daemon 自身信息
 *   GET    /api/daemon/services          — 服务列表（读取时惰性失活校正）
 *   POST   /api/daemon/services          — 挂载（dataDir 可省略：auto/temp 会话自动建目录并初始化；
 *                                          幂等：同 dataDir 已在跑则直接复用/收编）
 *   PATCH  /api/daemon/services/:id      — 更新登记（publicUrl（隧道域名）/name）
 *   GET    /api/daemon/services/:id/secret — 读取访问口令＋口令链接（no-store；仅回环面）
 *   PUT    /api/daemon/services/:id/secret — 设置/重新生成口令（必要时重启服务生效）
 *   POST   /api/daemon/services/:id/stop — 停服务（`serve --stop` 语义）并更新登记（临时会话删目录）
 *   DELETE /api/daemon/services/:id      — 移除登记（须已停；临时会话删目录）
 *   POST   /api/daemon/pick-directory    — 原生目录选择器（宿主侧弹窗）
 *   POST   /api/daemon/shutdown          — 停全部服务并退出 daemon
 *   GET    /*                            — daemon-webui（dist/index.html 注入 window.__STOA_DAEMON__）
 *
 * 只绑回环、无鉴权（本机开发面）。响应统一 `{ok:true,...}` / `{ok:false,code,error}`。
 * 子服务一律以 `stoa serve --standalone` 拉起（默认 `--idle-timeout 0`：daemon 持有生命周期，
 * 服务不按空闲自尽），登记 pid 用 server.json 里服务自报的 pid。
 */
import { closeSync, chmodSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { Hono, type Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { PORT_MAX, PORT_MIN } from "../core/protocol.ts";
import { probeHealth, probeHealthBody, readServerInfo } from "../server/discovery.ts";
import { initDataDir } from "../server/init.ts";
import { isPortInWorkerRange } from "../server/ports.ts";
import { pickDirectory, pickerSupported } from "./picker.ts";
import {
  findAuthKey,
  generateAuthKey,
  keyLink,
  resolveSessionDataDir,
  setAuthKey,
  validateAuthKey,
  type SessionLocation,
} from "./sessions.ts";
import type { DaemonHealth } from "./client.ts";
import {
  findServiceByDataDir,
  newServiceId,
  readDaemonInfo,
  readServices,
  removeService,
  serviceLogPath,
  tailFile,
  upsertService,
  writeServices,
  type ServiceRecord,
} from "./state.ts";

export interface DaemonEntry {
  /** 解释器（bun 的 process.execPath）与 CLI 脚本（process.argv[1]）。 */
  bin: string;
  args: string[];
}

export interface DaemonContext {
  stateDir: string;
  version: string;
  startedAt: number;
  entry: DaemonEntry;
  uiDir: string | null;
  log: (line: string) => void;
  /** 由 runDaemon 提供：停全部服务 → 移除 daemon.json → 关服 → 退出。 */
  shutdown: () => Promise<void>;
}

export interface MountRequest {
  /** 省略则按 location 自动建会话目录（stoa-session-ux design §1）。 */
  dataDir?: string | null;
  location?: SessionLocation | null;
  /** 新会话的访问口令（留空自动生成；已有口令的目录沿用原口令）。 */
  key?: string | null;
  port?: number | null;
  name?: string | null;
  envFiles?: string[] | null;
  host?: string | null;
  idleTimeoutMs?: number | null;
  expose?: boolean | null;
  allowOpenExpose?: boolean | null;
  /** 公网入口（隧道域名）：口令链接优先用它。 */
  publicUrl?: string | null;
}

export interface MountOutcome {
  service: ServiceRecord;
  /** true = 直接复用/收编既有实例（没有拉起新进程）。 */
  reused: boolean;
  /** true = 收编一个 daemon 外启动的实例（server.json 存活）。 */
  adopted: boolean;
  /** 非阻断提示（如「已存在口令，已沿用」）。 */
  warnings: string[];
}

/** HTTP 层错误（handler 转成 JSON 响应）。 */
class HttpFail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

async function serviceHealthy(record: Pick<ServiceRecord, "dataDir">): Promise<boolean> {
  const info = readServerInfo(record.dataDir);
  return info !== null && (await probeHealth(info, 600));
}

/** 读取时校正：登记为 running 但服务实际已死（被 `serve --stop`/SIGKILL 掉）→ 降级 stopped。 */
async function reconcileServices(ctx: DaemonContext): Promise<ServiceRecord[]> {
  const list = readServices(ctx.stateDir);
  let changed = false;
  for (const record of list) {
    if (record.status !== "running") continue;
    if (!(await serviceHealthy(record))) {
      record.status = "stopped";
      record.stoppedAt = Date.now();
      changed = true;
    }
  }
  if (changed) writeServices(ctx.stateDir, list);
  return list;
}

function buildServeArgs(ctx: DaemonContext, req: MountRequest, dataDir: string): string[] {
  const args = [...ctx.entry.args, "serve", "--standalone", "--data-dir", dataDir];
  if (req.port != null) args.push("--port", String(req.port));
  if (req.host) args.push("--host", req.host);
  // daemon 持有生命周期：默认不设空闲自尽（请求可显式覆盖）。
  args.push("--idle-timeout", String(Math.round((req.idleTimeoutMs ?? 0) / 1000)));
  if (req.envFiles?.length) args.push("--env-files", req.envFiles.join(","));
  if (req.expose) args.push("--expose");
  if (req.allowOpenExpose) args.push("--allow-open-expose");
  return args;
}

/** 会话目录初始化＋访问口令（新目录/开放模式目录自动上口令；既有口令沿用并提示）。 */
function prepareSession(opts: {
  dataDir: string;
  created: boolean;
  location: SessionLocation;
  envFiles: string[] | null;
  key: string | null;
}): { envFiles: string[] | null; secretFile: string | null; warnings: string[] } {
  const warnings: string[] = [];
  const envFile = join(opts.dataDir, ".env");
  const hadEnvFile = existsSync(envFile);
  if (!existsSync(join(opts.dataDir, "report.sqlite"))) {
    initDataDir({ dataDir: opts.dataDir, cwd: opts.dataDir, envFiles: [envFile] });
  }
  const envFiles = opts.location === "path" ? opts.envFiles : [envFile];
  const found = findAuthKey([...(envFiles ?? []), envFile]);
  const provided = (opts.key ?? "").trim();
  if (provided) {
    // 显式口令＝用户意图：直接写入（覆盖原口令），并提示后果。
    const key = validateAuthKey(provided);
    setAuthKey(envFile, key);
    if (found && found.key !== key) warnings.push("已按你的输入重设访问口令（旧口令与已登录会话已失效）");
    else if (!found) warnings.push("已为该目录开启认证（访问口令为你设置的值）");
    return { envFiles, secretFile: envFile, warnings };
  }
  if (found) return { envFiles, secretFile: found.file, warnings };
  setAuthKey(envFile, generateAuthKey());
  if (hadEnvFile) warnings.push("该目录原本是开放模式；已生成访问口令并开启认证");
  return { envFiles, secretFile: envFile, warnings };
}

async function mountService(ctx: DaemonContext, req: MountRequest): Promise<MountOutcome> {
  if (req.location != null && !["auto", "temp", "path"].includes(req.location)) {
    throw new HttpFail(400, "BAD_REQUEST", `unknown location: ${String(req.location)}`);
  }
  const location: SessionLocation = req.location ?? ((req.dataDir ?? "").trim() ? "path" : "auto");
  if (location === "path" && !(req.dataDir ?? "").trim()) {
    throw new HttpFail(400, "BAD_REQUEST", 'dataDir is required when location is "path"');
  }
  if (req.port != null && !isPortInWorkerRange(req.port)) {
    throw new HttpFail(
      400,
      "BAD_REQUEST",
      `port ${req.port} is outside the worker range ${PORT_MIN}-${PORT_MAX}`,
    );
  }
  const resolved = resolveSessionDataDir({
    dataDir: req.dataDir,
    location,
    name: req.name,
  });
  const { dataDir, ephemeral, created } = resolved;
  const cleanupEphemeral = (): void => {
    if (!ephemeral) return;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };

  const list = readServices(ctx.stateDir);
  const existing = findServiceByDataDir(list, dataDir);
  if (existing && existing.status === "running" && (await serviceHealthy(existing))) {
    return { service: existing, reused: true, adopted: false, warnings: [] };
  }
  // 收编：daemon 外（或上一个 daemon 死后遗留）已经在跑的实例，统一进登记表管理。
  const info = readServerInfo(dataDir);
  if (info && (await probeHealth(info, 800))) {
    const secret = findAuthKey([join(dataDir, ".env")]);
    const record: ServiceRecord = {
      id: existing?.id ?? newServiceId(),
      name: (req.name ?? "").trim() || existing?.name || basename(dataDir),
      dataDir,
      port: info.port,
      pid: info.pid,
      url: info.url,
      log: existing?.log ?? null,
      startedAt: info.startedAt ?? Date.now(),
      status: "running",
      envFiles: existing?.envFiles ?? null,
      ephemeral: existing?.ephemeral ?? false,
      publicUrl: (req.publicUrl ?? "").trim() || existing?.publicUrl || null,
      secretFile: secret?.file ?? existing?.secretFile ?? null,
      location: existing?.location ?? "path",
    };
    upsertService(ctx.stateDir, record);
    ctx.log(`adopted running service ${record.id} (${record.url}) for ${dataDir}`);
    return { service: record, reused: true, adopted: true, warnings: [] };
  }

  let prepared: { envFiles: string[] | null; secretFile: string | null; warnings: string[] };
  try {
    prepared = prepareSession({
      dataDir,
      created,
      location,
      envFiles: req.envFiles ?? null,
      key: req.key ?? null,
    });
  } catch (err) {
    cleanupEphemeral();
    if (err instanceof HttpFail) throw err;
    throw new HttpFail(
      400,
      "SESSION_INIT_FAILED",
      `cannot prepare session ${dataDir}: ${(err as Error).message}`,
    );
  }

  const id = existing?.id ?? newServiceId();
  const logPath = serviceLogPath(ctx.stateDir, id);
  const fd = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  const args = buildServeArgs(ctx, { ...req, envFiles: prepared.envFiles }, dataDir);
  const child = spawn(ctx.entry.bin, args, {
    cwd: dataDir,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, STOA_DAEMON_CHILD: "1" },
  });
  child.unref();
  closeSync(fd);
  ctx.log(`spawned service ${id} pid=${child.pid ?? "?"} (${args.slice(2).join(" ")})`);

  const deadline = Date.now() + 15_000;
  let lastProbe = "not started";
  for (;;) {
    const started = readServerInfo(dataDir);
    if (started) {
      const body = await probeHealthBody(started, 800);
      // 诊断用：带上期望的 dataDir/pid——共享端口/脏 server.json 时能一眼定位。
      lastProbe = body
        ? "ok"
        : `mismatch: want dataDir=${started.dataDir} serverPid=${started.pid} childPid=${child.pid ?? "?"} url=${started.url}`;
    }
    if (started && (await probeHealth(started, 800))) {
      const record: ServiceRecord = {
        id,
        name: (req.name ?? "").trim() || existing?.name || basename(dataDir),
        dataDir,
        port: started.port,
        pid: started.pid,
        url: started.url,
        log: logPath,
        startedAt: started.startedAt ?? Date.now(),
        status: "running",
        envFiles: prepared.envFiles,
        ephemeral,
        publicUrl: (req.publicUrl ?? "").trim() || existing?.publicUrl || null,
        secretFile: prepared.secretFile,
        location,
      };
      upsertService(ctx.stateDir, record);
      return { service: record, reused: false, adopted: false, warnings: prepared.warnings };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      cleanupEphemeral();
      throw new HttpFail(
        502,
        "SERVICE_EXIT",
        `service exited during startup (code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "null"}):\n${tailFile(logPath)}`,
      );
    }
    if (Date.now() > deadline) {
      try {
        if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      cleanupEphemeral();
      throw new HttpFail(
        504,
        "TIMEOUT",
        `service did not become healthy within 15s (last probe: ${lastProbe}):\n${tailFile(logPath)}`,
      );
    }
    await sleep(150);
  }
}

/** 停服务：先走 CLI 的 `serve --stop`（清理 server.json/lock 的正规路径），再按登记 pid 兜底强杀。 */
async function stopService(ctx: DaemonContext, record: ServiceRecord): Promise<ServiceRecord> {
  const current = findServiceByDataDir(readServices(ctx.stateDir), record.dataDir) ?? record;
  // 状态可能被并发探测误降级（stop 仍要以真实进程为准）：只要登记 pid 活着或服务健康就执行停机。
  const needsStop =
    current.status === "running" ||
    (current.pid !== null && pidAlive(current.pid)) ||
    (await serviceHealthy(current));
  if (needsStop) {
    const args = [...ctx.entry.args, "serve", "--stop", "--data-dir", current.dataDir];
    const proc = spawn(ctx.entry.bin, args, {
      cwd: current.dataDir,
      stdio: ["ignore", "ignore", "ignore"],
      // 关键：子进程走「本地停机」路径。否则它会检测到自己被 daemon 挂载 → 回调本 daemon 的
      // stop 端点 → 与正在等待它的本调用互相等待（重入死锁，实测表现为 shutdown 悬挂）。
      env: { ...process.env, STOA_DAEMON_STOP_DIRECT: "1", STOA_DAEMON_CHILD: "1" },
    });
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
      proc.once("error", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    if (current.pid && pidAlive(current.pid)) {
      try {
        process.kill(current.pid, "SIGTERM");
      } catch {
        // already gone
      }
      if (!(await waitExit(current.pid, 3000))) {
        try {
          process.kill(current.pid, "SIGKILL");
        } catch {
          // already gone
        }
        await waitExit(current.pid, 2000);
      }
    }
    if (await serviceHealthy(current)) {
      throw new HttpFail(500, "STOP_FAILED", `service at ${current.dataDir} is still healthy after stop`);
    }
  }
  current.status = "stopped";
  current.stoppedAt = Date.now();
  if (current.ephemeral) {
    // 临时会话：停止即删（目录是我们建的，删除安全）。
    try {
      rmSync(current.dataDir, { recursive: true, force: true });
      ctx.log(`removed ephemeral session ${current.dataDir}`);
    } catch (err) {
      ctx.log(`remove ephemeral session failed: ${(err as Error).message}`);
    }
    removeService(ctx.stateDir, current.id);
    return current;
  }
  upsertService(ctx.stateDir, current);
  return current;
}

/** 停掉全部 running 服务（daemon 退出路径）；单个失败不阻断其余。 */
export async function shutdownAll(ctx: DaemonContext): Promise<ServiceRecord[]> {
  const list = await reconcileServices(ctx);
  const stopped: ServiceRecord[] = [];
  for (const record of list) {
    if (record.status !== "running") continue;
    try {
      stopped.push(await stopService(ctx, record));
      ctx.log(`stopped service ${record.id} (${record.url})`);
    } catch (err) {
      ctx.log(`stop service ${record.id} failed: ${(err as Error).message}`);
    }
  }
  return stopped;
}

function uniquePaths(files: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const raw of files) {
    const file = (raw ?? "").trim();
    if (file && !out.includes(file)) out.push(file);
  }
  return out;
}

/** 服务的认证模式（以服务自身 `/api/auth/status` 为准；不可达返回 null）。 */
async function serviceAuthMode(record: ServiceRecord): Promise<"auth" | "open" | null> {
  const base = (record.url ?? "").replace(/\/+$/, "");
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/auth/status`, {
      signal: AbortSignal.timeout(1200),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { mode?: unknown };
    if (body.mode === "auth") return "auth";
    if (body.mode === "open") return "open";
    return null;
  } catch {
    return null;
  }
}

async function tryLogin(record: ServiceRecord, key: string): Promise<boolean> {
  const base = (record.url ?? "").replace(/\/+$/, "");
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: key }),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function secretFiles(record: ServiceRecord): string[] {
  return uniquePaths([record.secretFile, ...(record.envFiles ?? []), join(record.dataDir, ".env")]);
}

interface SecretView {
  mode: "auth" | "open" | "unknown";
  key: string | null;
  key_link: string | null;
  source: string | null;
}

async function readServiceSecret(record: ServiceRecord): Promise<SecretView> {
  const found = findAuthKey(secretFiles(record));
  const liveMode = await serviceAuthMode(record);
  const mode: SecretView["mode"] = liveMode ?? (found ? "auth" : "open");
  const key = found?.key ?? null;
  return {
    mode,
    key,
    key_link: key ? keyLink(record, key) : null,
    source: found?.file ?? (mode === "auth" ? "external-env" : null),
  };
}

async function waitForLogin(record: ServiceRecord, key: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryLogin(record, key)) return true;
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

async function writeServiceSecret(
  ctx: DaemonContext,
  record: ServiceRecord,
  body: { key?: unknown; generate?: unknown },
): Promise<{ service: ServiceRecord; key: string; restarted: boolean; applied: boolean }> {
  let key: string;
  try {
    key = body.generate === true ? generateAuthKey() : validateAuthKey(String(body.key ?? ""));
  } catch (err) {
    throw new HttpFail(400, "BAD_KEY", (err as Error).message);
  }
  const found = findAuthKey(secretFiles(record));
  const target = found?.file ?? record.secretFile ?? join(record.dataDir, ".env");
  try {
    setAuthKey(target, key);
  } catch (err) {
    throw new HttpFail(500, "SECRET_WRITE", `cannot write ${target}: ${(err as Error).message}`);
  }
  let current: ServiceRecord = { ...record, secretFile: target };
  upsertService(ctx.stateDir, current);
  // daemon 拉起的服务 env 文件固定，LiveEnv TTL≈1s：写后短暂等待即可用新口令登录。
  let applied = record.status !== "running" ? true : await waitForLogin(current, key, 2_000);
  let restarted = false;
  if (!applied && record.status === "running" && !record.ephemeral) {
    ctx.log(`secret change not live on ${current.id}; restarting service`);
    try {
      await stopService(ctx, current);
      const outcome = await mountService(ctx, {
        dataDir: current.dataDir,
        port: current.port,
        name: current.name,
        envFiles: current.envFiles ?? null,
        publicUrl: current.publicUrl ?? null,
      });
      current = outcome.service;
      restarted = true;
      applied = await waitForLogin(current, key, 5_000);
    } catch (err) {
      ctx.log(`restart after secret change failed: ${(err as Error).message}`);
    }
  }
  return { service: current, key, restarted, applied };
}

function uiResponse(ctx: DaemonContext, pathname: string): Response {
  if (!ctx.uiDir || !existsSync(join(ctx.uiDir, "index.html"))) {
    return new Response(
      `daemon UI build not found (${ctx.uiDir ?? "no ui dir"}); run: bun run build\n`,
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const root = resolve(ctx.uiDir);
  const rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..")) return new Response("bad path\n", { status: 400 });
  const target = join(root, rel);
  if (rel === "/index.html") {
    const html = readFileSync(target, "utf8");
    const boot = JSON.stringify({
      version: ctx.version,
      stateDir: ctx.stateDir,
      pid: process.pid,
      startedAt: ctx.startedAt,
    }).replace(/</g, "\\u003c");
    const injected = html.includes("</head>")
      ? html.replace("</head>", `<script>window.__STOA_DAEMON__=${boot};</script></head>`)
      : `<script>window.__STOA_DAEMON__=${boot};</script>${html}`;
    return new Response(injected, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  }
  if (existsSync(target)) {
    return new Response(Bun.file(target), {
      headers: rel.startsWith("/assets/")
        ? { "cache-control": "public, max-age=31536000, immutable" }
        : { "cache-control": "no-cache" },
    });
  }
  // hash 路由回退：未知路径回首页（注入版）
  return uiResponse(ctx, "/index.html");
}

export function createDaemonApp(ctx: DaemonContext): Hono {
  const app = new Hono();
  // 串行化登记读改写（挂载/停止/shutdown 可能并发进入）。
  let queue: Promise<unknown> = Promise.resolve();
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const corsHeaders = (origin: string | undefined): Record<string, string> => ({
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  });

  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(c.req.header("origin")) });
    }
    await next();
    for (const [key, value] of Object.entries(corsHeaders(c.req.header("origin")))) {
      c.res.headers.set(key, value);
    }
  });

  const respondJson = (c: Context, body: unknown, status = 200): Response =>
    c.newResponse(JSON.stringify(body), status as StatusCode, {
      "content-type": "application/json; charset=utf-8",
    });

  const handle = async (c: Context, fn: () => Promise<unknown> | unknown): Promise<Response> => {
    try {
      const body = await fn();
      return respondJson(c, typeof body === "object" && body !== null ? body : { value: body });
    } catch (err) {
      if (err instanceof HttpFail) {
        return respondJson(c, { ok: false, code: err.code, error: err.message }, err.status);
      }
      return respondJson(c, { ok: false, code: "INTERNAL", error: (err as Error).message }, 500);
    }
  };

  app.get("/healthz", async (c) => {
    const info = readDaemonInfo(ctx.stateDir);
    const list = readServices(ctx.stateDir);
    const running = list.filter((item) => item.status === "running").length;
    const body: DaemonHealth = {
      ok: true,
      daemon: true,
      pid: process.pid,
      port: info?.port ?? 0,
      url: info?.url ?? "",
      stateDir: ctx.stateDir,
      version: ctx.version,
      startedAt: ctx.startedAt,
      services: { total: list.length, running },
    };
    return c.json(body);
  });

  app.get("/api/daemon/info", (c) =>
    handle(c, async () => {
      const services = await reconcileServices(ctx);
      return {
        ok: true,
        daemon: {
          pid: process.pid,
          stateDir: ctx.stateDir,
          version: ctx.version,
          startedAt: ctx.startedAt,
        },
        services: { total: services.length, running: services.filter((s) => s.status === "running").length },
        capabilities: { pickDirectory: pickerSupported() },
      };
    }),
  );

  app.get("/api/daemon/services", (c) =>
    handle(c, async () => ({ ok: true, services: await withLock(() => reconcileServices(ctx)) })),
  );

  app.post("/api/daemon/services", async (c) => {
    let raw: unknown = null;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: false, code: "BAD_REQUEST", error: "invalid JSON body" }, 400);
    }
    if (typeof raw !== "object" || raw === null) {
      return c.json({ ok: false, code: "BAD_REQUEST", error: "body must be a JSON object" }, 400);
    }
    return handle(c, () => withLock(() => mountService(ctx, raw as MountRequest)));
  });

  app.post("/api/daemon/services/:id/stop", (c) =>
    handle(c, () =>
      withLock(async () => {
        const id = c.req.param("id");
        const record = readServices(ctx.stateDir).find((item) => item.id === id);
        if (!record) throw new HttpFail(404, "NOT_FOUND", `no service with id ${id}`);
        const service = await stopService(ctx, record);
        return { ok: true, service };
      }),
    ),
  );

  app.delete("/api/daemon/services/:id", (c) =>
    handle(c, () =>
      withLock(async () => {
        const id = c.req.param("id");
        const list = readServices(ctx.stateDir);
        const record = list.find((item) => item.id === id);
        if (!record) throw new HttpFail(404, "NOT_FOUND", `no service with id ${id}`);
        if (record.status === "running" && (await serviceHealthy(record))) {
          throw new HttpFail(409, "CONFLICT", `service ${id} is still running; stop it first`);
        }
        writeServices(
          ctx.stateDir,
          list.filter((item) => item.id !== id),
        );
        if (record.ephemeral) {
          try {
            rmSync(record.dataDir, { recursive: true, force: true });
          } catch {
            // best effort
          }
        }
        return { ok: true, removed: id };
      }),
    ),
  );

  app.patch("/api/daemon/services/:id", (c) =>
    handle(c, () =>
      withLock(async () => {
        const id = c.req.param("id");
        let raw: unknown = null;
        try {
          raw = await c.req.json();
        } catch {
          throw new HttpFail(400, "BAD_REQUEST", "invalid JSON body");
        }
        const body = (typeof raw === "object" && raw !== null ? raw : {}) as {
          publicUrl?: unknown;
          name?: unknown;
        };
        const record = readServices(ctx.stateDir).find((item) => item.id === id);
        if (!record) throw new HttpFail(404, "NOT_FOUND", `no service with id ${id}`);
        if (body.publicUrl !== undefined) {
          const text = typeof body.publicUrl === "string" ? body.publicUrl.trim() : "";
          if (text && !/^https?:\/\//i.test(text)) {
            throw new HttpFail(400, "BAD_REQUEST", "publicUrl must be an http(s) URL");
          }
          record.publicUrl = text ? text.replace(/\/+$/, "") : null;
        }
        if (body.name !== undefined) {
          const name = String(body.name ?? "").trim();
          if (name) record.name = name;
        }
        upsertService(ctx.stateDir, record);
        return { ok: true, service: record };
      }),
    ),
  );

  app.get("/api/daemon/services/:id/secret", (c) =>
    handle(c, () =>
      withLock(async () => {
        const record = readServices(ctx.stateDir).find((item) => item.id === c.req.param("id"));
        if (!record) throw new HttpFail(404, "NOT_FOUND", `no service with id ${c.req.param("id")}`);
        c.header("cache-control", "no-store");
        const view = await readServiceSecret(record);
        return { ok: true, ...view };
      }),
    ),
  );

  app.put("/api/daemon/services/:id/secret", (c) =>
    handle(c, () =>
      withLock(async () => {
        const record = readServices(ctx.stateDir).find((item) => item.id === c.req.param("id"));
        if (!record) throw new HttpFail(404, "NOT_FOUND", `no service with id ${c.req.param("id")}`);
        let raw: unknown = null;
        try {
          raw = await c.req.json();
        } catch {
          throw new HttpFail(400, "BAD_REQUEST", "invalid JSON body");
        }
        const body = (typeof raw === "object" && raw !== null ? raw : {}) as {
          key?: unknown;
          generate?: unknown;
        };
        const out = await writeServiceSecret(ctx, record, body);
        c.header("cache-control", "no-store");
        return {
          ok: true,
          mode: "auth",
          key: out.key,
          key_link: keyLink(out.service, out.key),
          restarted: out.restarted,
          applied: out.applied,
          service: out.service,
        };
      }),
    ),
  );

  app.post("/api/daemon/pick-directory", (c) =>
    handle(c, async () => {
      const out = await pickDirectory();
      return { ok: out.ok, path: out.path ?? null, ...(out.error ? { error: out.error } : {}) };
    }),
  );

  app.post("/api/daemon/shutdown", (c) => {
    const running = readServices(ctx.stateDir).filter((item) => item.status === "running").length;
    ctx.log("shutdown requested via API");
    setTimeout(() => {
      void ctx.shutdown();
    }, 50);
    return c.json({ ok: true, shutting_down: true, services: running });
  });

  app.all("*", (c) => {
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    if (pathname.startsWith("/api/")) {
      return c.json({ ok: false, code: "NOT_FOUND", error: `unknown daemon API: ${pathname}` }, 404);
    }
    return uiResponse(ctx, pathname);
  });

  return app;
}

/** daemon 进程的 UI 目录默认值（源码/包内同构：repo 根 dist/）。 */
export function defaultDaemonUiDir(): string {
  return join(import.meta.dir, "..", "..", "dist");
}

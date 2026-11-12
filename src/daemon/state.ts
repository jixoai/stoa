/**
 * stoa daemon 状态目录与登记（stoa-daemon design §1/§2）。
 *
 * 默认状态目录 `~/.local/state/stoa/daemon/`（`--state-dir` / `STOA_DAEMON_STATE_DIR` 覆盖）：
 *   daemon.json   — {pid, port, url, stateDir, version, startedAt}（daemon 自身）
 *   services.json — [{id, name, dataDir, port, pid, url, log, startedAt, status, stoppedAt?}]
 *   logs/         — daemon.log 与各挂载服务 <id>.log（0600；都是子进程原始输出，凭据绝不主动写入）
 *
 * 所有文件 0600 原子写（tmp+rename），与 server.json 同一纪律。
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { normalizeHostname, serviceSlug } from "./slug.ts";

export const DAEMON_DEFAULT_PORT = 13679;
/**
 * 自动择优端口带（同一台机器多会话各起一个 daemon 时向下取；13679 优先）。
 * 显式 `--port`/`STOA_DAEMON_PORT` 时只用该端口。
 */
export const DAEMON_PORT_BAND: readonly [number, number] = [13670, 13679];
export const DAEMON_STATE_DIR_ENV = "STOA_DAEMON_STATE_DIR";
export const DAEMON_PORT_ENV = "STOA_DAEMON_PORT";

export interface DaemonInfo {
  pid: number;
  port: number;
  url: string;
  stateDir: string;
  version: string;
  startedAt: number;
}

export type ServiceStatus = "running" | "stopped";

/** 代理注入实例凭据时使用的默认实例账号（P1 只落 schema 与默认值，P2 实现注入）。 */
export const DEFAULT_AUTH_ACCOUNT = "owner";

export interface ServiceRecord {
  id: string;
  name: string;
  /**
   * URL 路径段（daemon-unified-port design §2）：`/i/<slug>/` 与 `x-stoa-service` 注入值。
   * 生成器见 `slug.ts`（不复用会话目录的 slugify）。
   */
  slug: string;
  /** Host 模式的实例主机名（RFC1123，跨实例唯一，大小写不敏感）。 */
  hostnames: string[];
  dataDir: string;
  /** daemon 托管实例不占 TCP：`null`；收编的 standalone 实例保留真实端口。 */
  port: number | null;
  pid: number | null;
  /** 逻辑 URL：daemon 基址 + `/i/<slug>/`；收编实例为它的 TCP origin。 */
  url: string | null;
  /** UDS 监听路径（daemon 托管实例）；收编的 TCP 实例为 null。 */
  socket?: string | null;
  /** 代理注入凭据时使用的实例账号（P1 仅 schema 与默认值）。 */
  authAccount?: string;
  /** 子进程 stdout/stderr 日志路径（adopt 来的外部实例没有日志）。 */
  log: string | null;
  startedAt: number;
  status: ServiceStatus;
  stoppedAt?: number;
  /** 挂载时显式传给子服务的 env 文件（口令读写定位用；adopt 实例为空）。 */
  envFiles?: string[] | null;
  /** 临时会话：停止/移除登记时整目录删除（stoa-session-ux design §1）。 */
  ephemeral?: boolean;
  /** 公网入口（隧道域名）：口令链接优先用它；由 PATCH 写入。 */
  publicUrl?: string | null;
  /** 口令所在的 env 文件（首次发现/写入后记录）。 */
  secretFile?: string | null;
  /** 会话位置（stoa-session-ux）：auto=~/.stoa/sessions / temp=临时 / path=自定义。 */
  location?: "auto" | "temp" | "path";
}

export function defaultDaemonStateDir(home = process.env.HOME ?? homedir()): string {
  return join(home, ".local", "state", "stoa", "daemon");
}

export function resolveDaemonStateDir(
  opts: {
    flag?: string | null;
    env?: Record<string, string | undefined>;
    cwd?: string;
    home?: string;
  } = {},
): string {
  const cwd = opts.cwd ?? process.cwd();
  const flag = (opts.flag ?? "").trim();
  if (flag) return resolve(cwd, flag);
  const env = opts.env ?? process.env;
  const fromEnv = (env[DAEMON_STATE_DIR_ENV] ?? "").trim();
  if (fromEnv) return resolve(cwd, fromEnv);
  return defaultDaemonStateDir(opts.home);
}

export function daemonInfoPath(stateDir: string): string {
  return join(stateDir, "daemon.json");
}

export function servicesPath(stateDir: string): string {
  return join(stateDir, "services.json");
}

export function daemonLogsDir(stateDir: string): string {
  return join(stateDir, "logs");
}

export function daemonLogPath(stateDir: string): string {
  return join(daemonLogsDir(stateDir), "daemon.log");
}

export function serviceLogPath(stateDir: string, id: string): string {
  return join(daemonLogsDir(stateDir), `${id}.log`);
}

function ensureDir(dir: string, mode: number): void {
  mkdirSync(dir, { recursive: true, mode });
  chmodSync(dir, mode);
}

/** 建好状态目录与 logs/（0700）——CLI 起 daemon 前先调用，随后可以直接 open log。 */
export function ensureDaemonDirs(stateDir: string): void {
  ensureDir(resolve(stateDir), 0o700);
  ensureDir(daemonLogsDir(stateDir), 0o700);
}

export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 0600 原子写（tmp+rename；父目录 0700）：daemon 状态文件的统一纪律。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(dirname(path), 0o700);
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function isDaemonInfo(value: unknown): value is DaemonInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Partial<DaemonInfo>;
  return (
    typeof info.pid === "number" &&
    typeof info.port === "number" &&
    typeof info.url === "string" &&
    typeof info.stateDir === "string" &&
    typeof info.version === "string" &&
    typeof info.startedAt === "number"
  );
}

export function readDaemonInfo(stateDir: string): DaemonInfo | null {
  const value = readJsonFile<unknown>(daemonInfoPath(stateDir));
  return isDaemonInfo(value) ? value : null;
}

export function writeDaemonInfo(stateDir: string, info: DaemonInfo): void {
  writeJsonAtomic(daemonInfoPath(stateDir), info);
}

export function removeDaemonInfo(stateDir: string): void {
  rmSync(daemonInfoPath(stateDir), { force: true });
}

function isServiceRecord(value: unknown): value is ServiceRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ServiceRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.dataDir === "string" &&
    typeof record.status === "string" &&
    (record.status === "running" || record.status === "stopped")
  );
}

/**
 * 读登记表并做**向后兼容归一化**（daemon-unified-port design §2/契约迁移）：
 *   - 旧记录没有 `slug` → 按 name 现场生成（表内去重），下次写入即固化；
 *   - `hostnames` 缺失 → `[]`；`port` 缺失/非法 → `null`（UDS 实例的合法形态）；
 *   - `authAccount` 缺失 → `owner`。
 */
export function readServices(stateDir: string): ServiceRecord[] {
  const value = readJsonFile<unknown>(servicesPath(stateDir));
  if (!Array.isArray(value)) return [];
  const list = value.filter(isServiceRecord);
  const usedSlugs = new Set<string>();
  for (const record of list) {
    if (typeof record.slug === "string" && record.slug) usedSlugs.add(record.slug.toLowerCase());
  }
  for (const record of list) {
    if (typeof record.name !== "string" || !record.name) record.name = record.id;
    if (typeof record.slug !== "string" || !record.slug) {
      record.slug = serviceSlug(record.name, usedSlugs);
      usedSlugs.add(record.slug);
    }
    record.hostnames = Array.isArray(record.hostnames)
      ? record.hostnames
          .filter((host): host is string => typeof host === "string")
          .map((host) => normalizeHostname(host))
          .filter(Boolean)
      : [];
    if (typeof record.port !== "number") record.port = null;
    if (typeof record.authAccount !== "string" || !record.authAccount) {
      record.authAccount = DEFAULT_AUTH_ACCOUNT;
    }
  }
  return list;
}

export function writeServices(stateDir: string, list: ServiceRecord[]): void {
  writeJsonAtomic(servicesPath(stateDir), list);
}

/** 按 id 覆盖写入一条登记（同 dataDir 的旧登记会被替换成同一 id 的新记录）。 */
export function upsertService(stateDir: string, record: ServiceRecord): void {
  const list = readServices(stateDir);
  const index = list.findIndex((item) => item.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);
  writeServices(stateDir, list);
}

export function removeService(stateDir: string, id: string): boolean {
  const list = readServices(stateDir);
  const next = list.filter((item) => item.id !== id);
  if (next.length === list.length) return false;
  writeServices(stateDir, next);
  return true;
}

/** dataDir 归一化比较（相对路径/尾斜杠/软链一律按 resolve 后文本比对）。 */
export function sameDataDir(a: string, b: string): boolean {
  const norm = (value: string): string => {
    try {
      return resolve(value).replace(/\/+$/, "");
    } catch {
      return value.replace(/\/+$/, "");
    }
  };
  return norm(a) === norm(b);
}

export function findServiceByDataDir(list: ServiceRecord[], dataDir: string): ServiceRecord | null {
  return list.find((item) => sameDataDir(item.dataDir, dataDir)) ?? null;
}

/** 按 id 或 slug 找登记（`/i/<idOrSlug>` 两种写法都认；大小写不敏感）。 */
export function findServiceByIdOrSlug(list: ServiceRecord[], idOrSlug: string): ServiceRecord | null {
  const needle = String(idOrSlug ?? "").trim().toLowerCase();
  if (!needle) return null;
  return (
    list.find((item) => item.id.toLowerCase() === needle) ??
    list.find((item) => item.slug.toLowerCase() === needle) ??
    null
  );
}

/** 某个 hostname 的归属（Host 模式路由用；大小写不敏感）。 */
export function findServiceByHostname(list: ServiceRecord[], hostname: string): ServiceRecord | null {
  const needle = normalizeHostname(hostname);
  if (!needle) return null;
  return list.find((item) => item.hostnames.some((host) => normalizeHostname(host) === needle)) ?? null;
}

/** 所有实例已占用的 hostname（跨实例唯一性校验输入）。 */
export function allHostnames(list: ServiceRecord[]): string[] {
  return list.flatMap((item) => item.hostnames);
}

export function newServiceId(): string {
  return `svc-${crypto.randomUUID().slice(0, 8)}`;
}

/** daemon 自己的日志（daemon.log）：追加一行带时间戳的记录。 */
export function appendDaemonLog(stateDir: string, line: string): void {
  try {
    ensureDaemonDirs(stateDir);
    const fd = openSync(daemonLogPath(stateDir), "a", 0o600);
    try {
      writeSync(fd, `[${new Date().toISOString()}] ${line}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // 日志永远不能拖垮 daemon 本体
  }
}

/** 读文件尾部（错误回传用）；不存在/读失败返回 "(no log)"。 */
export function tailFile(path: string, maxBytes = 2000): string {
  try {
    if (!existsSync(path)) return "(no log)";
    const text = readFileSync(path, "utf8");
    return text.length > maxBytes ? text.slice(-maxBytes) : text;
  } catch {
    return "(no log)";
  }
}

/** daemon 端口校验：整数、非特权段；默认 13679，显式给值必须合法。 */
export function assertDaemonPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`daemon port must be an integer in 1024-65535 (got ${port})`);
  }
  return port;
}

/** 候选端口：显式给值只用它；否则 band 内从高到低（13679 优先）。 */
export function daemonPortCandidates(requested: number | null): number[] {
  if (requested !== null) return [assertDaemonPort(requested)];
  const out: number[] = [];
  for (let port = DAEMON_PORT_BAND[1]; port >= DAEMON_PORT_BAND[0]; port--) out.push(port);
  return out;
}

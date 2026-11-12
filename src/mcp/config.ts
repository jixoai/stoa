/**
 * `stoa mcp` 配置与凭据解析（stoa-adapters P1-3，design §2）。
 *
 * 来源＝现 ZCode 插件 `plugins/report-channel/scripts/lib/config.mjs` 的 TS 移植，
 * 解析顺序（先到先得，空值＝未设）：
 *   1. CLI flags：`--base-url` / `--token` / `--account` / `--data-dir`
 *      （附加两枚同层 flag：`--public-url` / `--config`，覆盖旧 env 的全能力）
 *   2. 新前缀环境变量：`STOA_BASE_URL` / `STOA_TOKEN` / `STOA_ACCOUNT` / `STOA_DATA_DIR`
 *      （附加键同层：`STOA_PUBLIC_URL` / `STOA_CONFIG`）
 *   3. 兼容旧前缀：`REPORT_CHANNEL_BASE_URL` / `REPORT_CHANNEL_ACCOUNT` /
 *      `REPORT_CHANNEL_DATA_DIR` / `REPORT_CHANNEL_PUBLIC_URL` / `REPORT_CHANNEL_CONFIG`，
 *      以及 `FDE2E_REPORT_TOKEN_<ACCOUNT>`（新式 `STOA_TOKEN_<ACCOUNT>` 同层优先）。
 *      **收窄口径**：`FDE2E_REPORT_*` 只兼容 per-account token 这一个键；baseUrl /
 *      account / dataDir / publicUrl / config 只读 `REPORT_CHANNEL_*` 旧前缀。
 *   4. accounts env 文件：配置文件 `tokenFile` 字段 → `<dataDir>/accounts/<account>.env`
 *   5. 配置文件 `~/.config/stoa/report-channel.json`（主路径）
 *   6. 兼容旧配置文件 `~/.config/fde2e/report-channel.json`（按文件存在性回退）
 *   7. 默认 `http://127.0.0.1:13689`
 *
 * 凭据（token）绝不打印、绝不进入 MCP 输出：`describeConfig` 只报 `present`/`absent`。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { accountTokenEnvKey, legacyAccountTokenEnvKey } from "../core/auth.ts";
import { parseEnv } from "../core/env.ts";
import { readDaemonInfo, readServices, resolveDaemonStateDir } from "../daemon/state.ts";

export const DEFAULT_BASE_URL = "http://127.0.0.1:13689";
/** 无 daemon 记录时的逻辑入口回退（standalone 调试兼容；不是机器通道）。 */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:13679";
/** 公示板公网入口默认值（旧插件同值；`postUrl` 用它拼 canonical 链接）。 */
export const DEFAULT_PUBLIC_URL = "https://report.worker.fde2e.com";
export const DEFAULT_ACCOUNT = "manager";

/** 旧插件的账号强制覆盖键（`cfgFor`：`as` > FORCE_ACCOUNT > 配置账号），双前缀读取。 */
export const FORCE_ACCOUNT_ENV_KEYS = ["STOA_FORCE_ACCOUNT", "REPORT_CHANNEL_FORCE_ACCOUNT"] as const;

export function configPathCandidates(home = homedir()): { primary: string; legacy: string } {
  return {
    primary: join(home, ".config", "stoa", "report-channel.json"),
    legacy: join(home, ".config", "fde2e", "report-channel.json"),
  };
}

/** CLI flags（`stoa mcp --base-url/--token/--account/--data-dir [--public-url/--config]`）。 */
export interface McpConfigFlags {
  baseUrl?: string | null;
  token?: string | null;
  account?: string | null;
  dataDir?: string | null;
  publicUrl?: string | null;
  config?: string | null;
}

export interface McpConfig {
  /** 生效的配置文件路径：显式指定（--config/STOA_CONFIG/REPORT_CHANNEL_CONFIG）或
   *  第一个存在的候选；全部缺失时为主路径（供 describeConfig 展示「读的是哪份」）。 */
  path: string;
  /**
   * 机器通道（I/O）：daemon 托管实例的 Unix socket（`instanceFetch` 直连，不经 daemon 会话）。
   * 空串＝未发现 daemon 通道（standalone/TCP 或直连 `--base-url`）。
   */
  socket: string;
  /**
   * 链接通道（浏览器可达）：`?ep=` 深链/面板链接用它，daemon 托管时为
   * `http://<daemon>/i/<slug>/`；未发现 daemon 时等于 `baseUrl`。
   */
  logicalUrl: string;
  /**
   * 兼容/展示字段：显式 `--base-url`/`STOA_BASE_URL`/配置文件值，或默认 `13689`。
   * **注意**：`--base-url http://127.0.0.1:13679/i/<slug>` 是 cookie 通道，
   * 机器消费者（MCP）用它必定 401——只有明确要模拟浏览器时才手动指定。
   */
  baseUrl: string;
  dataDir: string;
  account: string;
  publicUrl: string;
  /** 配置文件 `tokenFile` 字段指向的 0600 env 文件（存在时参与 token 查找）。 */
  tokenFile: string;
  /** CLI `--token` 显式直给（最高优先；绝不能进入 describeConfig/日志）。 */
  explicitToken: string;
  /** CLI `--as`（`stoa mcp --as`）：服务级账号覆盖，高于 FORCE_ACCOUNT 与配置账号。 */
  accountOverride?: string;
}

interface ConfigFileValues {
  baseUrl?: unknown;
  dataDir?: unknown;
  account?: unknown;
  publicUrl?: unknown;
  tokenFile?: unknown;
}

/** 首个非空字符串（空串＝未设，与全仓 env 读取约定一致）。 */
export function firstOf(values: ReadonlyArray<unknown>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

function readConfigFile(path: string): ConfigFileValues {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as ConfigFileValues;
  } catch {
    return {};
  }
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export interface ResolveMcpConfigOptions {
  flags?: McpConfigFlags;
  env?: Record<string, string | undefined>;
  /** 家目录覆盖（测试/沙箱；默认 `os.homedir()`，即 `$HOME`）。 */
  home?: string;
}

export function resolveMcpConfig(opts: ResolveMcpConfigOptions = {}): McpConfig {
  const flags = opts.flags ?? {};
  const env = opts.env ?? process.env;
  const candidatesPaths = configPathCandidates(opts.home ?? homedir());
  const explicitConfig = firstOf([
    flags.config,
    env.STOA_CONFIG,
    env.REPORT_CHANNEL_CONFIG,
  ]);
  const candidates = explicitConfig
    ? [resolve(explicitConfig)]
    : [candidatesPaths.primary, candidatesPaths.legacy];
  const files = candidates.map(readConfigFile);
  const fileValue = (key: keyof ConfigFileValues): string =>
    firstOf(files.map((file) => file[key]));

  const explicitBaseUrl = stripTrailingSlashes(
    firstOf([flags.baseUrl, env.STOA_BASE_URL, env.REPORT_CHANNEL_BASE_URL, fileValue("baseUrl")]),
  );
  // 无显式 baseUrl 时优先发现本机 daemon 的机器通道（UDS）：MCP 在 Node 上跑，
  // cookie 通道（/i/<slug>/）没有会话必 401，因此默认就是 socket。
  const channel = explicitBaseUrl ? null : discoverDaemonChannel(opts, env);
  const baseUrl = explicitBaseUrl || channel?.logicalUrl || DEFAULT_BASE_URL;
  const logicalUrl = explicitBaseUrl || channel?.logicalUrl || baseUrl;
  const socket = channel?.socket ?? "";
  const account =
    firstOf([
      flags.account,
      env.STOA_ACCOUNT,
      env.REPORT_CHANNEL_ACCOUNT,
      fileValue("account"),
    ]) || DEFAULT_ACCOUNT;
  const dataDir = firstOf([
    flags.dataDir,
    env.STOA_DATA_DIR,
    env.REPORT_CHANNEL_DATA_DIR,
    fileValue("dataDir"),
  ]);
  const publicUrl =
    stripTrailingSlashes(
      firstOf([
        flags.publicUrl,
        env.STOA_PUBLIC_URL,
        env.REPORT_CHANNEL_PUBLIC_URL,
        fileValue("publicUrl"),
      ]),
    ) || DEFAULT_PUBLIC_URL;
  const tokenFile = fileValue("tokenFile");

  return {
    path: candidates.find((path) => existsSync(path)) ?? candidates[0]!,
    socket,
    logicalUrl,
    baseUrl,
    dataDir,
    account,
    publicUrl,
    tokenFile,
    explicitToken: firstOf([flags.token]),
    accountOverride: "",
  };
}

export interface DaemonChannel {
  socket: string;
  logicalUrl: string;
  serviceId: string;
  slug: string;
  daemonUrl: string;
}

/**
 * 本机 daemon 的默认机器通道：读 `daemon.json` → 首个 **running** 且带 `socket` 的服务。
 * 只读文件（与面板的 daemon 入口同一发现口径），不健康探测、不联网。
 */
export function discoverDaemonChannel(
  opts: ResolveMcpConfigOptions = {},
  env: Record<string, string | undefined> = opts.env ?? process.env,
): DaemonChannel | null {
  let stateDir: string;
  try {
    stateDir = resolveDaemonStateDir({
      env,
      home: opts.home ?? homedir(),
      cwd: process.cwd(),
    });
  } catch {
    return null;
  }
  const info = readDaemonInfo(stateDir);
  if (!info) return null;
  const running = readServices(stateDir).find(
    (service) => service.status === "running" && typeof service.socket === "string" && service.socket,
  );
  if (!running?.socket) return null;
  const daemonUrl = (info.url || DEFAULT_DAEMON_URL).replace(/\/+$/, "");
  return {
    socket: running.socket,
    logicalUrl: `${daemonUrl}/i/${running.slug}/`,
    serviceId: running.id,
    slug: running.slug,
    daemonUrl,
  };
}

/** 当前账号的 token 环境键对（新前缀主、旧前缀兼容；与 core/auth.ts 同一命名法）。 */
export function tokenEnvKeys(account: string): { primary: string; legacy: string } {
  return {
    primary: accountTokenEnvKey(account),
    legacy: legacyAccountTokenEnvKey(account),
  };
}

/**
 * 返回 token 或 null（null = 开放模式或未配置；不抛错、不打印）。
 * 层内次序（逐字继承旧插件 `loadToken`，并在其前补新前缀层）：
 *   --token > `STOA_TOKEN` > `STOA_TOKEN_<ACCOUNT>` > `FDE2E_REPORT_TOKEN_<ACCOUNT>`
 *   > tokenFile > `<dataDir>/accounts/<account>.env`
 */
export function loadToken(
  cfg: McpConfig,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (cfg.explicitToken) return cfg.explicitToken;
  const flat = firstOf([env.STOA_TOKEN]);
  if (flat) return flat;
  const keys = tokenEnvKeys(cfg.account);
  const fromEnv = firstOf([env[keys.primary], env[keys.legacy]]);
  if (fromEnv) return fromEnv;
  const files = [
    cfg.tokenFile,
    cfg.dataDir ? join(cfg.dataDir, "accounts", `${cfg.account}.env`) : "",
  ].filter(Boolean);
  for (const file of files) {
    if (!existsSync(file)) continue;
    const values = parseEnv(readFileSync(file, "utf8"));
    const found = firstOf([values[keys.primary], values[keys.legacy]]);
    if (found) return found;
  }
  return null;
}

/** `board_status` 的 `config` 字段：绝不回显 token 本体。 */
export function describeConfig(
  cfg: McpConfig,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  return {
    baseUrl: cfg.baseUrl,
    logicalUrl: cfg.logicalUrl || cfg.baseUrl,
    socket: cfg.socket || null,
    dataDir: cfg.dataDir || null,
    account: cfg.account,
    publicUrl: cfg.publicUrl,
    configPath: cfg.path,
    token: loadToken(cfg, env) ? "present" : "absent",
  };
}

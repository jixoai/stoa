/**
 * Stoa ZCode 适配器：配置、凭据与 state 路径解析（无第三方依赖）。
 *
 * 主线：本适配器让任何 ZCode 会话都能对 Stoa 公示板说话——汇报成果、读 Owner 回话。
 * 配置来源（前者优先；空值一律视为未设，纯空白同空）：
 *   1. 环境变量：STOA_BASE_URL / STOA_DATA_DIR / STOA_ACCOUNT / STOA_PUBLIC_URL / STOA_CONFIG
 *      （兼容旧前缀 REPORT_CHANNEL_*；token 见 loadToken）
 *   2. 配置文件：~/.config/stoa/report-channel.json 与旧路径
 *      ~/.config/fde2e/report-channel.json **按 key 合并**（stoa 主 + fde2e 旧，先到先得；
 *      与核心 src/mcp/config.ts 的 fileValue 同语义——两份都在也不会互相遮蔽整份配置）
 * 凭据：只从「该账号自己的 0600 env 文件」读取（accounts/<account>.env，STOA_TOKEN_<ACCOUNT>
 * 优先、旧 FDE2E_REPORT_TOKEN_<ACCOUNT> 兼容），或同名环境变量（含 flat STOA_TOKEN）；
 * 绝不写日志、不回显。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 新主用配置路径；不存在时回退旧前缀路径（stoa-adapters 迁移）。 */
export const CONFIG_PATH = join(homedir(), ".config", "stoa", "report-channel.json");
export const LEGACY_CONFIG_PATH = join(homedir(), ".config", "fde2e", "report-channel.json");
/** state 目录：新主用 + 旧回退（按文件存在性判断，见 resolveStatePath）。 */
export const STATE_DIR = join(homedir(), ".local", "state", "stoa", "report-channel");
export const LEGACY_STATE_DIR = join(homedir(), ".local", "state", "fde2e", "report-channel");

/** 空值＝未设（纯空白同空，与核心 `firstOf` 一致）：按序取第一个非空字符串。 */
export function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** 环境变量双读：STOA_* 优先、REPORT_CHANNEL_* 兼容（空值视为未设）。 */
function envValue(suffix) {
  return firstNonEmpty(process.env[`STOA_${suffix}`], process.env[`REPORT_CHANNEL_${suffix}`]);
}

/** 读取一份配置；非法/缺失一律当空对象（绝不抛错）。 */
function readConfigFile(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/** 显式 STOA_CONFIG/REPORT_CHANNEL_CONFIG；否则 [新路径, 旧路径]（按 key 合并，先到先得）。 */
function configCandidates() {
  const explicit = envValue("CONFIG");
  if (explicit) return [explicit];
  return [CONFIG_PATH, LEGACY_CONFIG_PATH];
}

/**
 * state 文件路径解析（stoa-adapters 迁移）：新目录主用、旧目录按文件回退——
 * 新目录同名文件存在 → 用新；否则旧目录同名文件存在 → 用旧（沿用旧游标，不迁移不重写）；
 * 都不存在 → 新目录（新建）。
 */
export function resolveStatePath(fileName) {
  const next = join(STATE_DIR, fileName);
  if (existsSync(next)) return next;
  const legacy = join(LEGACY_STATE_DIR, fileName);
  if (existsSync(legacy)) return legacy;
  return next;
}

/** 当前会话标识（ZCode/Claude 系环境变量，首个非空）用于派生会话级 state 文件名。 */
export function sessionId() {
  return (
    firstNonEmpty(
      process.env.ZCODE_SESSION_ID,
      process.env.CLAUDE_SESSION_ID,
      process.env.CLAUDE_CODE_SESSION_ID,
    ) ?? ""
  );
}

/**
 * 会话级 state 文件名：`<hash(baseUrl|account)>[-<hash(session)>].json`
 * （与 watch.mjs 默认路径、state-path.mjs 输出一致；stop-wait.mjs 复用同一游标）。
 */
export function sessionStateFileName(cfg) {
  const baseKey = createHash("sha1").update(`${cfg.baseUrl}|${cfg.account}`).digest("hex").slice(0, 16);
  const id = sessionId();
  const suffix = id ? `-${createHash("sha1").update(id).digest("hex").slice(0, 12)}` : "";
  return `${baseKey}${suffix}.json`;
}

export function loadConfig() {
  const candidates = configCandidates();
  const files = candidates.map(readConfigFile);
  // 按 key 合并（新主 + 旧回退，先到先得）——与核心 src/mcp/config.ts 的 fileValue 一致；
  // 不是「整份二选一」：新配置只写部分键时，其余键仍能从旧配置补齐。
  const fileValue = (key) => firstNonEmpty(...files.map((file) => file[key]));
  return {
    path: candidates.find((path) => existsSync(path)) ?? candidates[0],
    baseUrl: (envValue("BASE_URL") || fileValue("baseUrl") || "http://127.0.0.1:13689").replace(/\/+$/, ""),
    dataDir: envValue("DATA_DIR") || fileValue("dataDir") || "",
    account: envValue("ACCOUNT") || fileValue("account") || "manager",
    publicUrl: (envValue("PUBLIC_URL") || fileValue("publicUrl") || "https://report.worker.fde2e.com").replace(/\/+$/, ""),
    tokenFile: fileValue("tokenFile") || "",
  };
}

/** 新主用 per-account token 键：STOA_TOKEN_<ACCOUNT>（与核心 src/core/auth.ts 同款）。 */
export function accountTokenEnvKey(account) {
  return `STOA_TOKEN_${account.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** 旧 per-account token 键：FDE2E_REPORT_TOKEN_<ACCOUNT>（兼容读取）。 */
export function tokenEnvKey(account) {
  return `FDE2E_REPORT_TOKEN_${account.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** 在 env 文件文本里按键名取非空值（支持 `export K=V`、引号；键序优先）。 */
function readKeyFromEnvText(text, keys) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const raw = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    if (raw && !values.has(match[1])) values.set(match[1], raw);
  }
  for (const key of keys) {
    const value = values.get(key);
    if (value) return value;
  }
  return null;
}

/** 返回 token 或 null（null = 开放模式或未配置；不抛错、不打印）。
 *  层内次序与核心 src/mcp/config.ts 的 loadToken 一致：
 *  `STOA_TOKEN`（flat）> `STOA_TOKEN_<ACCOUNT>` > `FDE2E_REPORT_TOKEN_<ACCOUNT>`
 *  > tokenFile > `<dataDir>/accounts/<account>.env`。 */
export function loadToken(cfg) {
  const flat = firstNonEmpty(process.env.STOA_TOKEN);
  if (flat) return flat;
  const keys = [accountTokenEnvKey(cfg.account), tokenEnvKey(cfg.account)];
  const fromEnv = firstNonEmpty(process.env[keys[0]], process.env[keys[1]]);
  if (fromEnv) return fromEnv;
  const files = [cfg.tokenFile, cfg.dataDir ? join(cfg.dataDir, "accounts", `${cfg.account}.env`) : ""].filter(Boolean);
  for (const file of files) {
    if (!existsSync(file)) continue;
    const token = readKeyFromEnvText(readFileSync(file, "utf8"), keys);
    if (token) return token;
  }
  return null;
}

export function describeConfig(cfg) {
  return {
    baseUrl: cfg.baseUrl,
    dataDir: cfg.dataDir || null,
    account: cfg.account,
    publicUrl: cfg.publicUrl,
    configPath: cfg.path,
    token: loadToken(cfg) ? "present" : "absent",
  };
}

export async function api(cfg, path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const token = loadToken(cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        // 与核心 ApiClient 同款：open 模式下身份就由这个头声明（缺了会被当成 owner）。
        "x-report-account": cfg.account,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const message = json?.error || json?.message || text.slice(0, 200) || `HTTP ${res.status}`;
      const error = new Error(`${path} → ${res.status}: ${message}`);
      error.status = res.status;
      error.payload = json;
      throw error;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 帖子 canonical 链接（report-longform D13/§6.2）：article → `#/a/<id>`，
 * note（含旧数据缺 kind）→ `#/p/<id>`。
 */
export function postUrl(cfg, postId, kind = "note") {
  const path = kind === "article" ? "a" : "p";
  return `${cfg.publicUrl}/?ep=${encodeURIComponent(cfg.baseUrl)}#/${path}/${encodeURIComponent(postId)}`;
}

export function summarizePost(cfg, post) {
  const kind = post.kind === "article" ? "article" : "note";
  return {
    id: post.id,
    author: post.author,
    kind,
    created_at: post.created_at,
    tags: post.tags ?? [],
    body_md: post.body_md ?? post.body ?? "",
    parent_id: post.parent_id ?? null,
    url: postUrl(cfg, post.id, kind),
  };
}

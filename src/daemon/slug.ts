/**
 * 服务命名（daemon-unified-port design §2，P1）。
 *
 * 两个独立命名面：
 *   - `slug`：URL 路径段 `/i/<slug>/`、`x-stoa-service` 注入值与逻辑链接的稳定标识。
 *     形如 `[a-z0-9][a-z0-9-]{1,31}`（2–32 字符）。**不复用** `sessions.ts` 的 `slugify`——
 *     那个面向目录名，会产出 1 字符与尾随 `-`，不适合当路径段。
 *   - `hostnames[]`：Host 模式的实例自定义主机名（RFC 1123，跨实例唯一，大小写不敏感）。
 *
 * 这里只做纯计算/校验（无 I/O），便于单测覆盖边界：1 字符、尾随 `-`、保留字、冲突后缀。
 */

/** 路径前缀已占用的保留字：slug 撞上必须顺延后缀（`api-2` …）。 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "assets",
  "login",
  "logout",
  "shell",
  "i",
  "preview",
  "healthz",
  "favicon.ico",
]);

export const SLUG_MIN_LENGTH = 2;
export const SLUG_MAX_LENGTH = 32;

/** 名字 → slug 基串：小写、非 `[a-z0-9]` 折 `-`、压缩、去首尾 `-`、不足 2 字符补 `x`。 */
export function slugBase(name: string | null | undefined, fallback = "board"): string {
  const raw = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!raw) return fallback;
  if (raw.length < SLUG_MIN_LENGTH) return `${raw}x`;
  return raw.length > SLUG_MAX_LENGTH ? truncateSlug(raw, SLUG_MAX_LENGTH) : raw;
}

function truncateSlug(value: string, max: number): string {
  return value.slice(0, Math.max(SLUG_MIN_LENGTH, max)).replace(/-+$/g, "");
}

/**
 * 生成唯一 slug：基串冲突或撞保留字时依次尝试 `-2`、`-3`…（截断保留后缀空间）。
 * `taken` 大小写不敏感（slug 全小写，妥协作防御）。
 */
export function serviceSlug(name: string | null | undefined, taken: Iterable<string> = []): string {
  const used = new Set<string>();
  for (const value of taken) used.add(String(value).toLowerCase());
  const base = slugBase(name);
  for (let n = 1; n < 10_000; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = `${truncateSlug(base, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    if (candidate.length < SLUG_MIN_LENGTH) continue;
    if (RESERVED_SLUGS.has(candidate) || used.has(candidate)) continue;
    return candidate;
  }
  throw new Error(`cannot allocate a unique slug for ${JSON.stringify(name)}`);
}

/** slug 形状校验（已就位的记录/外部输入用）。 */
export function isValidSlug(value: string): boolean {
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(value)) return false;
  return !value.endsWith("-") && !value.includes("--");
}

/**
 * 「回环机器 host」集合（daemon-unified-port design §4.1 的机器通道豁免口径）：
 * 公网流量经本机 frpc 落地时 peer 恒为 127.0.0.1，所以**只看 peer 不够**，必须 Host 也命中
 * 回环集合。`stoa.localhost` 与自定义实例 hostname 属于浏览器面，**不在**此集合。
 * P1 只暴露集合本身；路由门（P2/S3-3）用它做 `/api/daemon/*` 与 `/preview/*` 的豁免判定。
 */
export const LOOPBACK_MACHINE_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1", "[::1]"];

/** daemon 自身 host 集合里永远存在的名字（实例不得占用；含浏览器面的 `stoa.localhost`）。 */
export const BASE_DAEMON_HOSTS: readonly string[] = [...LOOPBACK_MACHINE_HOSTS, "stoa.localhost"];

const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** 归一化主机名：小写、去首尾空白、去尾部点；空串返回 ""。 */
export function normalizeHostname(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
}

/**
 * RFC 1123 主机名校验：1–253 字符、点分 label（每段 1–63、`[a-z0-9-]`、不以 `-` 开头/结尾），
 * 不含端口/路径/通配/下划线/空格。
 */
export function isValidHostname(value: string | null | undefined): boolean {
  const host = normalizeHostname(value);
  if (!host || host.length > 253) return false;
  if (/[:/\\*_\s]/.test(host)) return false;
  return host.split(".").every((label) => HOST_LABEL_RE.test(label));
}

export interface HostnameValidationOptions {
  /** daemon 自己占用的 host（`BASE_DAEMON_HOSTS` ∪ daemon `--host`）。 */
  daemonHosts?: Iterable<string>;
  /** 其它实例已占用的 host（校验时排除实例自己的现值）。 */
  takenByOthers?: Iterable<string>;
}

/**
 * 校验并归一化一组自定义主机名；任何一条不合法都抛带可读原因的 `Error`。
 * 结果去重（大小写不敏感）、保持输入顺序。
 */
export function validateHostnames(
  input: ReadonlyArray<string | null | undefined> | string | null | undefined,
  opts: HostnameValidationOptions = {},
): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[\s,]+/)
      : [];
  const daemonHosts = new Set<string>(BASE_DAEMON_HOSTS.map(normalizeHostname));
  for (const host of opts.daemonHosts ?? []) daemonHosts.add(normalizeHostname(host));
  const taken = new Set<string>();
  for (const host of opts.takenByOthers ?? []) taken.add(normalizeHostname(host));

  const out: string[] = [];
  for (const entry of raw) {
    const host = normalizeHostname(entry);
    if (!host) continue;
    if (!isValidHostname(host)) {
      throw new Error(
        `invalid hostname ${JSON.stringify(host)}: use RFC 1123 labels (a-z, 0-9, "-", dots; ` +
          `no port/path/wildcard)`,
      );
    }
    if (daemonHosts.has(host)) {
      throw new Error(`hostname ${host} is the daemon's own host and cannot be assigned to an instance`);
    }
    if (taken.has(host)) {
      throw new Error(`hostname ${host} is already assigned to another instance`);
    }
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/** 主进程内共享的「把 Host 头归一化」工具（小写、去端口、去尾点）。 */
export function hostHeaderName(rawHost: string | null | undefined): string {
  const raw = String(rawHost ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end >= 0) return raw.slice(0, end + 1);
    return raw;
  }
  const colon = raw.indexOf(":");
  const host = colon >= 0 ? raw.slice(0, colon) : raw;
  return host.replace(/\.+$/, "");
}

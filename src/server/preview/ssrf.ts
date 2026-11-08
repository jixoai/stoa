/**
 * SSRF 防护（design §7，清单不放松）。
 *
 * 纯函数地址分类 + URL 预检 + DNS 全答案校验；连接侧 IP pinning 由 fetch.ts
 * 用已校验地址作为 `lookup` 结果，Host/SNI 保持原主机名（证书仍按原主机名校验）。
 */
import { resolve4, resolve6 } from "node:dns/promises";
import type { PreviewErrorCode } from "../../core/plugins/types.ts";

export class PreviewPolicyError extends Error {
  readonly code: PreviewErrorCode;
  constructor(code: PreviewErrorCode, message: string) {
    super(message);
    this.name = "PreviewPolicyError";
    this.code = code;
  }
}

const DEFAULT_ALLOWED_PORTS = [80, 443] as const;
/** 管理/数据库/RPC 端口：默认与追加配置都永远拒绝。 */
const ALWAYS_BLOCKED_PORTS = new Set([
  22, 23, 25, 53, 110, 143, 445, 3306, 5432, 6379, 9200, 11211,
]);

export interface UrlPolicyOptions {
  /** 默认 80/443（可配置追加 8080/8443）。 */
  allowedPorts?: readonly number[];
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function v4BlockedRanges(): Array<[number, number]> {
  const range = (base: string, bits: number): [number, number] => {
    const int = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return [int & mask, mask];
  };
  return [
    range("0.0.0.0", 8),
    range("10.0.0.0", 8),
    range("100.64.0.0", 10),
    range("127.0.0.0", 8),
    range("169.254.0.0", 16),
    range("172.16.0.0", 12),
    range("192.0.0.0", 24),
    range("192.0.2.0", 24),
    range("192.168.0.0", 16),
    range("198.18.0.0", 15),
    range("198.51.100.0", 24),
    range("203.0.113.0", 24),
    range("224.0.0.0", 4),
    range("240.0.0.0", 4),
    range("255.255.255.255", 32),
  ];
}
const V4_BLOCKS = v4BlockedRanges();

export function isBlockedIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  return V4_BLOCKS.some(([base, mask]) => (value & mask) === base);
}

/** 压缩 IPv6 → 128bit（返回 null = 非法）。 */
export function parseIPv6(raw: string): bigint | null {
  let text = raw.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (text.includes("%")) return null;
  if (text.includes(".")) {
    const idx = text.lastIndexOf(":");
    if (idx < 0) return null;
    const parts = text.slice(idx + 1).split(".");
    if (parts.length !== 4) return null;
    const nums = parts.map((part) => Number(part));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text =
      text.slice(0, idx + 1) +
      (((nums[0]! << 8) | nums[1]!) >>> 0).toString(16) +
      ":" +
      (((nums[2]! << 8) | nums[3]!) >>> 0).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;
  const groups = [
    ...head,
    ...new Array(8 - head.length - tail.length).fill("0"),
    ...tail,
  ];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

function v6(base: string): bigint {
  return parseIPv6(base)!;
}

const V6_BLOCKED: Array<[bigint, number]> = [
  [v6("::"), 128],
  [v6("::1"), 128],
  [v6("100::"), 64],
  [v6("2001:db8::"), 32],
  [v6("2001:0000::"), 32],
  [v6("fc00::"), 7],
  [v6("fe80::"), 10],
  [v6("ff00::"), 8],
];

function inV6Range(value: bigint, base: bigint, bits: number): boolean {
  if (bits === 0) return true;
  const shift = 128n - BigInt(bits);
  return value >> shift === base >> shift;
}

function embeddedV4(value: bigint, shift: bigint): string {
  const v = Number((value >> shift) & 0xffffffffn);
  return [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join(".");
}

/** 地址分类：所有 IPv4/IPv6 答案逐一检查（任一命中即拒绝整个 host）。 */
export function isBlockedIp(ip: string): boolean {
  if (ip.includes(":")) {
    const value = parseIPv6(ip);
    if (value === null) return true;
    // IPv4-mapped ::ffff:0:0/96 —— 解内嵌 v4 再分类。
    if (inV6Range(value, v6("::ffff:0:0"), 96)) {
      return isBlockedIPv4(embeddedV4(value, 0n));
    }
    // NAT64 64:ff9b::/96。
    if (inV6Range(value, v6("64:ff9b::"), 96)) {
      return isBlockedIPv4(embeddedV4(value, 0n));
    }
    // 6to4 2002::/16。
    if (inV6Range(value, v6("2002::"), 16)) {
      return isBlockedIPv4(embeddedV4(value, 80n));
    }
    return V6_BLOCKED.some(([base, bits]) => inV6Range(value, base, bits));
  }
  return isBlockedIPv4(ip);
}

const IPV4_LITERAL_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 十进制/八进制/十六进制 IPv4 字面量归一化（URL 构造器多数已归一化，这里兜底）。 */
export function normalizeIpLiteral(hostname: string): string | null {
  const text = hostname.trim();
  if (IPV4_LITERAL_RE.test(text)) return text;
  let numeric: bigint | null = null;
  if (/^\d+$/.test(text)) numeric = BigInt(text);
  else if (/^0x[0-9a-f]+$/i.test(text)) numeric = BigInt(parseInt(text.slice(2), 16));
  else if (/^0[0-7]+$/.test(text)) numeric = BigInt(parseInt(text.slice(1), 8));
  if (numeric === null || numeric > 0xffffffffn) return null;
  const v = Number(numeric);
  return [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join(".");
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * URL 预检（每跳重跑）：仅 http/https；拒绝 userinfo、空 host、单标签 host、
 * `.local/.internal/.home.arpa/.lan`、含 `%`/控制字符的 host、超长 host；
 * 端口默认 80/443（可追加），管理端口永远拒绝。
 */
export function validatePreviewUrl(raw: string, opts: UrlPolicyOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PreviewPolicyError("blocked_scheme", "invalid url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PreviewPolicyError("blocked_scheme", "only http/https");
  }
  if (url.username || url.password) {
    throw new PreviewPolicyError("blocked_scheme", "userinfo is not allowed");
  }
  const hostname = stripBrackets(url.hostname);
  if (!hostname) throw new PreviewPolicyError("blocked_scheme", "empty host");
  if (hostname.includes("%") || /[\u0000-\u001f\u007f]/.test(hostname)) {
    throw new PreviewPolicyError("blocked_scheme", "control/zone id in host");
  }
  if (hostname.length > 253) throw new PreviewPolicyError("blocked_scheme", "host too long");
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new PreviewPolicyError("blocked_private", "localhost is not previewable");
  }
  for (const suffix of [".local", ".internal", ".home.arpa", ".lan"]) {
    if (lower === suffix.slice(1) || lower.endsWith(suffix)) {
      throw new PreviewPolicyError("blocked_private", "internal hostname");
    }
  }
  const literal = normalizeIpLiteral(lower);
  const isIpv6 = lower.includes(":");
  if (!literal && !isIpv6 && !lower.includes(".")) {
    // 单标签 host（intranet 短名）一律拒绝。
    throw new PreviewPolicyError("blocked_private", "single-label hostname");
  }
  // IP 字面量先分类（私网/回环/元数据不受端口白名单顺序影响，报 blocked_private）。
  if (literal && isBlockedIPv4(literal)) {
    throw new PreviewPolicyError("blocked_private", "private ip literal");
  }
  if (isIpv6 && isBlockedIp(lower)) {
    throw new PreviewPolicyError("blocked_private", "private ip literal");
  }
  const allowed = [...DEFAULT_ALLOWED_PORTS, ...(opts.allowedPorts ?? [])];
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (ALWAYS_BLOCKED_PORTS.has(port)) {
    throw new PreviewPolicyError("blocked_port", "management/database port");
  }
  if (!allowed.includes(port)) {
    throw new PreviewPolicyError("blocked_port", "port not allowed");
  }
  return url;
}

export interface ResolvedTarget {
  hostname: string;
  /** 已校验的 pinned 地址。 */
  address: string;
  family: 4 | 6;
}

export type LookupFn = (hostname: string) => Promise<string[]>;

/** 默认 DNS：并行 A/AAAA；任一答案命中私网即拒绝整个 host。 */
export const defaultLookup: LookupFn = async (hostname) => {
  const answers: string[] = [];
  const [v4, v6] = await Promise.all([
    resolve4(hostname).catch(() => [] as string[]),
    resolve6(hostname).catch(() => [] as string[]),
  ]);
  answers.push(...v4, ...v6);
  return answers;
};

/**
 * 解析 + 全答案校验 + IP pin（一次解析，连接侧不再二次解析）。
 * IP 字面量直接分类，不走 DNS。
 */
export async function resolvePinnedTarget(
  hostname: string,
  opts: { lookup?: LookupFn } = {},
): Promise<ResolvedTarget> {
  const bare = stripBrackets(hostname);
  const literalV4 = normalizeIpLiteral(bare);
  if (literalV4) {
    if (isBlockedIPv4(literalV4)) {
      throw new PreviewPolicyError("blocked_private", "private ip literal");
    }
    return { hostname: bare, address: literalV4, family: 4 };
  }
  if (bare.includes(":")) {
    if (isBlockedIp(bare)) {
      throw new PreviewPolicyError("blocked_private", "private ip literal");
    }
    return { hostname: bare, address: bare, family: 6 };
  }
  let addresses: string[];
  try {
    addresses = await (opts.lookup ?? defaultLookup)(bare);
  } catch {
    throw new PreviewPolicyError("network", "dns resolution failed");
  }
  if (addresses.length === 0) {
    throw new PreviewPolicyError("network", "no dns answer");
  }
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new PreviewPolicyError("blocked_private", "dns answer is private");
    }
  }
  const address = addresses[0]!;
  return { hostname: bare, address, family: address.includes(":") ? 6 : 4 };
}

/** 回环主机判定（IPv4 loopback / localhost / IPv6 ::1）。 */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const lower = host.toLowerCase();
  return lower === "localhost" || lower === "::1" || lower.startsWith("127.");
}

/**
 * 测试放行精确 origin（N13：仅回环 origin；非回环条目一律丢弃）。
 * serve.ts 另保证仅「回环监听 + 未曝光」时才启用。
 */
export function parseTestAllowOrigins(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",").map((entry) => entry.trim())) {
    if (!/^https?:\/\/[^/]+$/.test(part)) continue;
    try {
      const url = new URL(part);
      if (!isLoopbackHostname(url.hostname)) continue;
      out.push(url.origin);
    } catch {
      // invalid origin: skip
    }
  }
  return out;
}

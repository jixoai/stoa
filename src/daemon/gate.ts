/**
 * daemon 路由门与豁免（daemon-unified-port design §4.1，S3-3）。
 *
 * 纯判定（无 I/O）：router 在**所有**路由（daemon app 与 `/i/` 反代）之前调用它，
 * 这样「未登录能不能看到实例」不依赖 daemon app 或实例自身的实现。
 *
 * 豁免清单（任何来源）：
 *   - `GET/HEAD /healthz`（daemon 自身）
 *   - `/login`、`/api/daemon/auth/…`
 *   - 静态资产 `/assets/…`、`/favicon…`
 *   - `/i/<slug>/healthz`（dsh probe / 适配器身份守卫 / 监控依赖它）
 *   - Host 模式的 `/healthz`（该 Host 命中实例 hostnames 时）
 *
 * **机器通道豁免**（loopback peer 且 Host ∈ 回环 host 集合）：
 *   - `/api/daemon/…`（CLI `daemon status|stop`、挂载/停止、`…/secret`）
 *   - `/preview/…`（本机静态预览直开）
 * 为什么必须带 Host 条件：本项目公网流量经本机 frpc 落地，peer 恒为 `127.0.0.1`——
 * 只看 peer 会把 `/api/daemon/services/:id/secret`（返回实例口令）与 `/preview/…`
 * 在隧道下变成无认证可读。回环 host 集合**不含** `stoa.localhost` 与自定义实例 hostname
 * （它们是浏览器面，必须走登录门）。
 *
 * 未登录响应：页面 302 `/login?next=<path>`；API（`/api/…` 与 `/i/…/api/…`）→ 401 JSON。
 */
import { hostHeaderName, LOOPBACK_MACHINE_HOSTS } from "./slug.ts";

export type DaemonGateDecision =
  | { action: "allow" }
  | { action: "login"; location: string }
  | { action: "unauthorized" }
  | { action: "forbidden" };

export interface DaemonGateInput {
  method: string;
  /** `URL.pathname`（已解码前的原样；判定只用前缀/精确段）。 */
  pathname: string;
  /** `URL.search`（含 `?`；为空串）。仅用于拼 `next`。 */
  search?: string;
  /** 归一化 Host（见 `hostHeaderName`）。 */
  host: string;
  /** 连接对端地址（Bun `server.requestIP(req)?.address`；未知时 null）。 */
  peerAddress: string | null;
  /** 请求是否带有效 daemon 会话 cookie。 */
  authenticated: boolean;
  /** Host 是否命中某实例 `hostnames[]`（Host 模式的 `/healthz` 豁免靠它）。 */
  hostRoutesToInstance?: boolean;
}

const INSTANCE_HEALTHZ_RE = /^\/i\/[^/]+\/healthz\/?$/;
const API_PATH_RE = /^\/(?:api|i\/[^/]+\/api)(?:\/|$)/;

/** 允许的方法（健康检查是只读探测）。 */
function isGetOrHead(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

/** loopback 对端（IPv4/IPv6 与 IPv4-mapped 形态）。 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  const value = String(address ?? "").trim().toLowerCase();
  if (!value) return false;
  if (value === "::1" || value === "127.0.0.1") return true;
  if (value === "::ffff:127.0.0.1") return true;
  return value.startsWith("127.");
}

/** Host 是否属于「机器通道」回环集合（不含 `stoa.localhost` 与实例 hostname）。 */
export function isLoopbackMachineHost(host: string | null | undefined): boolean {
  const name = hostHeaderName(host);
  if (!name) return false;
  return LOOPBACK_MACHINE_HOSTS.includes(name);
}

/** 机器通道路径（`/api/daemon/*` 与 `/preview/*`）。 */
export function isMachineChannelPath(pathname: string): boolean {
  return (
    pathname === "/preview" ||
    pathname.startsWith("/preview/") ||
    pathname.startsWith("/api/daemon/")
  );
}

/** 是否 API 面（未登录回 401 而不是 302 的判据）。 */
export function isApiPath(pathname: string): boolean {
  return API_PATH_RE.test(pathname);
}

/** 页面 302 的登录地址（`next` 保留 path+query，登录后回跳原页面）。 */
export function loginLocationFor(pathname: string, search = ""): string {
  return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
}

/** 判断一次请求是否放行；未放行给出 302 还是 401。 */
export function decideDaemonGate(input: DaemonGateInput): DaemonGateDecision {
  if (input.authenticated) return { action: "allow" };
  const pathname = input.pathname || "/";
  const readOnly = isGetOrHead(input.method);

  // 1. daemon 自身健康检查。
  if (readOnly && pathname === "/healthz") return { action: "allow" };
  // 2. 登录页与登录 API；**首启 setup 只允许本机回环面**（daemon 先被隧道暴露时，
  //    窗口内谁都能抢先建号，随后用注入的 owner 凭据读全部实例）。
  if (pathname === "/login" || pathname.startsWith("/login/")) return { action: "allow" };
  if (pathname === "/api/daemon/auth/setup") {
    return isLoopbackAddress(input.peerAddress) && isLoopbackMachineHost(input.host)
      ? { action: "allow" }
      : { action: "forbidden" };
  }
  if (pathname.startsWith("/api/daemon/auth/")) return { action: "allow" };
  // 3. daemon SPA 静态资产（登录页自身要能加载）。
  if (pathname.startsWith("/assets/") || pathname.startsWith("/favicon")) {
    return { action: "allow" };
  }
  // 4. 实例健康检查（任何来源；含 Host 模式）。
  if (readOnly && INSTANCE_HEALTHZ_RE.test(pathname)) return { action: "allow" };
  if (readOnly && input.hostRoutesToInstance && pathname === "/healthz") {
    return { action: "allow" };
  }
  // 5. 机器通道：loopback peer **且** loopback Host（公网 Host 一律走登录门）。
  if (
    isMachineChannelPath(pathname) &&
    isLoopbackAddress(input.peerAddress) &&
    isLoopbackMachineHost(input.host)
  ) {
    return { action: "allow" };
  }

  if (isApiPath(pathname)) return { action: "unauthorized" };
  return { action: "login", location: loginLocationFor(pathname, input.search ?? "") };
}

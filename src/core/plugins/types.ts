/**
 * 插件契约（report-link-preview design §2.2 / §3.3）。
 *
 * 这一层是**运行时无关**的纯类型：
 * - `PreviewLink` 是帖子的持久化字段（`post_previews` 表 → `PostView.previews`）；
 * - `PreviewProvider` 是编译期静态注册的预览插件接口（禁止动态加载）；
 * - `PreviewTransport` 是插件唯一允许的出站通道（SSRF/限额由服务端实现负责）。
 *
 * 任何 provider SHALL NOT 自己发网络请求，只能经 `ctx.transport`；这样 SSRF 清单、
 * 体积/超时/限流、不执行 JS 的约束都收敛在一处（design §2.2 / §7）。
 */

/** 预览卡状态机（design §3.4）。 */
export type PreviewStatus = "pending" | "partial" | "ready" | "failed";

/** MIME 大类分流（design §6.3）。 */
export type PreviewKind = "page" | "image" | "video" | "audio" | "document" | "unknown";

/** 失败码（固定集合；文案由客户端映射，服务端不吐内部细节）。 */
export type PreviewErrorCode =
  | "blocked_scheme"
  | "blocked_private"
  | "blocked_port"
  | "blocked_size"
  | "too_many_redirects"
  | "timeout"
  | "http_error"
  | "unsupported"
  | "network"
  | "parse_error"
  | "crop_failed";

export type PreviewCoverKind = "og" | "favicon" | "crop" | null;

export interface PreviewCover {
  url: string;
  w: number | null;
  h: number | null;
  kind: PreviewCoverKind;
}

/**
 * 帖子自带的持久化预览字段（0..3，第一条为主卡）。
 * 字段可被异步 worker 多阶段多次覆盖（design §0 D5）。
 */
export interface PreviewLink {
  url: string;
  final_url: string | null;
  /** markdown 链接文字；裸 URL 为 null。 */
  label: string | null;
  kind: PreviewKind;
  mime: string | null;
  title: string | null;
  description: string | null;
  site_name: string | null;
  cover: PreviewCover | null;
  status: PreviewStatus;
  /** 最近完成/进入的阶段。 */
  phase: string;
  /** `["kind","mime","title","description","site_name","cover"]` 的子集。 */
  fields_ready: string[];
  cache_key: string;
  attempts: number;
  updated_at: number;
  error_code: PreviewErrorCode | null;
}

export type PluginCapability =
  | "url-extract"
  | "preview-resolve"
  | "cover-crop"
  | "viewer-open";

export interface PluginDependency {
  id: string;
  optional: boolean;
}

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  /** 插件版本（进 cacheKey）。 */
  version: string;
  /** 抓取/元数据规则版本（进 cacheKey）。 */
  rulesVersion: number;
  kind: "preview";
  capabilities: readonly PluginCapability[];
  requires?: readonly PluginDependency[];
  defaultEnabled: boolean;
}

/** 依赖在 `GET /api/plugins` 里的运行态（P1：file-viewer 未安装 → missing）。 */
export type PluginDependencyStatus = "enabled" | "disabled" | "missing";

export interface PluginDependencyView extends PluginDependency {
  status: PluginDependencyStatus;
}

export interface PluginWorkerSummary {
  queued: number;
  running: number;
  ready: number;
  partial: number;
  failed: number;
}

export interface PluginView {
  id: string;
  name: string;
  description: string;
  version: string;
  rules_version: number;
  kind: "preview";
  capabilities: readonly PluginCapability[];
  enabled: boolean;
  default_enabled: boolean;
  requires: PluginDependencyView[];
  viewer_base: string | null;
  worker?: PluginWorkerSummary;
  limits: { previews_per_post: number; url_max_chars: number };
}

/** 写入/扫描时从正文抽出的链接（已规范化、去重、限 3 条）。 */
export interface ExtractedLink {
  /** canonical URL */
  url: string;
  /** 0..2；0 = 主卡 */
  position: number;
  label: string | null;
}

export type PreviewPhase = "meta" | "cover" | "probe" | "crop" | "title";

/** 单阶段可写字段（只覆盖该阶段拥有的列）。 */
export interface PhaseFields {
  kind?: PreviewKind;
  mime?: string | null;
  final_url?: string | null;
  title?: string | null;
  description?: string | null;
  site_name?: string | null;
  cover?: PreviewCover | null;
}

export interface PhaseResult {
  phase: PreviewPhase;
  fields: PhaseFields;
  /** null/缺省 = 成功。错误只影响状态机，字段仍按阶段写入。 */
  errorCode?: PreviewErrorCode | null;
}

// ── transport（provider 唯一允许的出站通道）─────────────────────────────────

export interface PreviewFetchRequest {
  url: string;
  method: "HEAD" | "GET";
  /** `bytes=0-511` 之类的探测 Range（仅 GET）。 */
  range?: string | null;
  /** 响应体读取上限（字节）；HEAD 忽略。 */
  maxBytes?: number;
  signal?: AbortSignal;
  /** 绝对截止时间（epoch ms）。 */
  deadlineAt?: number;
}

export interface PreviewFetchResponse {
  /** 最终 URL（重定向后）。 */
  final_url: string;
  status: number;
  /** 小写头名；不包含 Set-Cookie（transport 负责剔除）。 */
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface PreviewTransport {
  /** HEAD（405/501/网络错误/缺 content-type 时由实现回退 GET）。 */
  head(url: string, ctx: TransportContext): Promise<PreviewFetchResponse>;
  /** GET 页面正文（有界）。 */
  page(url: string, ctx: TransportContext): Promise<PreviewFetchResponse>;
  /** GET 媒体前 512B（忽略 Range 最多 64KiB）。 */
  probe(url: string, ctx: TransportContext): Promise<PreviewFetchResponse>;
}

export interface TransportContext {
  signal?: AbortSignal;
  deadlineAt?: number;
}

/** 抓取策略（transport 的实现细节从 provider 角度看是只读常量）。 */
export interface PreviewPolicy {
  allowed_ports: readonly number[];
  max_page_bytes: number;
  max_media_bytes: number;
}

export interface ResolveContext {
  signal: AbortSignal;
  /** 本 job 的绝对截止时间（epoch ms）。 */
  deadlineAt: number;
  transport: PreviewTransport;
  policy: PreviewPolicy;
  /** 同一 job 多阶段共享（页面 meta/cover 不重复抓同一 URL）。 */
  cache: Map<string, unknown>;
}

export interface PreviewProvider {
  manifest: PluginManifest;
  extractUrls(bodyMd: string): ExtractedLink[];
  buildCacheKey(input: {
    canonicalUrl: string;
    bodyHash: string;
    pluginId: string;
    pluginVersion: string;
    rulesVersion: number;
  }): string;
  phases(link: ExtractedLink): readonly PreviewPhase[];
  resolvePhase(
    link: ExtractedLink,
    phase: PreviewPhase,
    ctx: ResolveContext,
  ): Promise<PhaseResult>;
}

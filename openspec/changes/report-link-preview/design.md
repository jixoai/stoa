# Design: report-link-preview（内置插件 link-preview + 通用链接预览）

> 目标：后端在落库时识别帖子里的 `http/https` 链接，按其 MIME 分流抓取元数据，读路径以
> `PostView.previews[]` 返回；前端在帖下渲染预览卡，点击新窗口打开，图片/视频/文档可交给
> fileviewer。**插件化是硬约束**：核心只依赖 provider 接口，`link-preview` 是内置插件，设置页
> 可开关；`fileviewer` 通过适配器接入，未启用/未注册即回退原链接。
>
> 本文件可直接施工。所有“必须”项在 tasks.md 有对应判据，验收见 §10。

---

## 0. 决策摘要

| # | 决策 | 理由 | 被否方案 |
|---|------|------|----------|
| D1 | 插件=**编译期静态注册**（manifest 数组 + provider map），开关只控制调用 | 无供应链/远程代码风险；“插件化”不等于插件市场 | 运行时 `import(url)`/扫描目录 |
| D2 | 开关存 **SQLite `meta`**（`plugins.<id>.enabled`） | 已有 `getMeta/setMeta`（`db.ts:229-241`），随库备份/迁移，事务一致 | `<dataDir>/settings.json`（双写/权限/迁移） |
| D3 | URL 在 **写入事务内**抽取并落 `post_links` | 读路径零解析；与帖子同生共死；规则变更可回填 | 每次读取时解析 markdown |
| D4 | 预览元数据按 **规范化 URL 全局缓存**（`link_previews`），帖子只存关联 | 同 URL 多帖共享一次抓取；TTL/退避集中管理 | 每帖一份副本 |
| D5 | 预览**内嵌** `PostView.previews[]`；另有 `GET /api/previews?post=<id>` 补拉 | 列表/线程零 N+1；无任意 URL 参数 → 不是开放代理 | `GET /api/previews?url=`（SSRF oracle） |
| D6 | 抓取用自建 `node:http(s)`，**DNS 解析后 IP pinning** + 原始 Host/SNI | 彻底防 DNS rebinding（fetch 无法钉 IP） | 全局 `fetch` |
| D7 | MIME = `Content-Type` + 魔数嗅探 + 扩展名；分 `page/image/video/audio/document/unknown` | HEAD 常撒谎；魔数最可信 | 只看扩展名/只看 header |
| D8 | 网页元数据优先级 OG → Twitter Card → `<title>`/meta → 首段/favicon | 与 X/主流 unfurl 一致 | 只抓 `<title>` |
| D9 | 成功 TTL 24h；失败指数退避；过期 stale-while-revalidate；失败降级普通链接 | 阅读永不阻塞；失败可自愈 | 同步抓取/永不重试 |
| D10 | 封面**只存外链 URL**，P1 不下载进媒体库 | 版权/存储/失效/SSRF 面最小 | P1 落地封面缓存 |
| D11 | fileviewer 由 **`file-viewer` 插件适配器**提供；`link-preview` 只声明可选依赖 | 核心零硬绑定；关插件即回退 | 在卡片里硬编码 fileviewer URL |
| D12 | 静态归档**不显示预览**（快照剥离 `previews`），裸 URL 仍可点 | 静态模式无后端，不能抓取；不伪造数据 | 快照里带预览 |
| D13 | 不新增运行时依赖：自写有界 HTML 元数据扫描器 | 控制供应链；需求只需 meta/title/首段 | P1 引入 DOM 解析器 |
| D14 | 设置入口复用账号抽屉/菜单，新增 `SettingsSheet`（官方 Sheet/Switch/Card） | 与现有 IA 一致；不新增一级导航 | 新增 `/settings` 路由页 |

---

## 1. 现状与接入点（path:line）

### 1.1 写入与读投影

- `commitOps` 在单事务内插 post/reply、分配 seq、写事件：
  `src/server/store.ts:652-657`（签名）、`:733-747`（根帖 INSERT）、`:782-797`（回复 INSERT）、
  `:837-840`（提交后 `hydratePosts`）。
- `PostView` 当前字段：`src/core/types.ts:156-162`（`author_account/media/reply_count/quoted/
  quoted_visible`）；新增 `previews?: LinkPreview[]` 是加性、可选字段。
- 所有读路径共用 `hydratePosts`：`src/server/store.ts:994`（定义）、`:1099-1133`（逐帖拼装）；
  timeline/feed/profile/thread/search/bookmarks/read 都经它，故预览只需在此接一次。
- 删除是软删：`src/server/store.ts:1541-1551`；本 change 在同一事务追加 `post_links` 清理。
- 正文上限 200k 字符：`src/core/validation.ts:6`；媒体白名单/上限 `:7-9`、`:14-28`。

### 1.2 markdown 语法树可直接复用

- `parseMarkdown` 输出 block（heading/list/quote/code/table/hr/paragraph）：
  `src/core/markdown.ts:123-222`；fenced code 在 `:143-155`。
- `parseInline` 输出 text/code/strong/em/link/image：`:37-114`；图片 `:58-72`、链接 `:73-90`。
- **抽取必须走这棵树**：否则无法可靠排除代码块/行内代码/图片；裸 URL 只出现在 `text` token。

### 1.3 渲染与帖子卡片

- markdown link 已 `target=_blank rel="noreferrer noopener"`：
  `src/ui/components/Markdown.tsx:149-163`；图片 `:164-165`；**裸 URL 不会自动链接**
  （`renderText` 只处理 @/#，`:91-128`）。
- 帖子卡片正文→媒体→引用→标签：`src/ui/components/PostCard.tsx:243-271`；自接线程分支
  `:171-180`。预览卡插入 `QuoteCard` 之后、`TagChips` 之前。
- 本仓现有查看器是 lightbox，只管本仓媒体：`MediaGrid.tsx:176-225`、`ImageViewer.tsx:1-15`。

### 1.4 fileviewer（Owner 所指的 tool）

- URL 契约（死契约）：`/?url=<encodeURIComponent(绝对URL)>` 必填，`&name=` 可选，
  `&decoder=` 可选；仅 http/https；`frameless/size/background` 为无壳模式
  ——`fde2e-tools-v0/apps/file-viewer/src/lib/viewer-url.ts:1-14`、`:89-110`。
- 14 解码器清单与 WebMCP 元数据：`fde2e-tools-v0/packages/shared/src/registry.ts:177-233`
  （image/video/audio/pdf/markdown/json/csv/html/docx/xlsx/pptx/zip/text/svg）。
- 既有部署基址：`https://file-viewer.tool.fde2e.com`
  （`fde2e-omni-v1/apps/web/src/lib/fileViewer.ts:17-19`、
  `fde2e-omni-v1/apps/server/src/uploads.ts:176`）；`fileviewer.fde2e.com` 为兼容别名。
- 它是纯前端站：解码在浏览器本地，文件字节不落站点服务器；但跨域文档/文本解码受目标站
  CORS 限制（见 §9.4）。

### 1.5 设置面 / 能力 / 静态模式

- 移动账号抽屉：`src/ui/components/AccountSheet.tsx:109-143`；桌面账号 Dropdown：
  `src/ui/components/Nav.tsx:126-154`。当前没有设置页。
- 路由/能力单源：`src/core/protocol.ts:39-77`（`API_ROUTES`）；`scripts/check.mjs:32-44`
  要求每个路由在 `src/server/http.ts` 中是字面量。
- status：`src/server/http.ts:713-737`。
- 静态快照：`src/ui/lib/static-api.ts:50-70`；导出映射 `src/server/export.ts:158-162`
  用 `...post` 展开，故**必须显式剥离 previews**；静态横幅 `AppShell.tsx:61-79`。
- SQLite：`meta` 表 `src/server/db.ts:58-61`；`getMeta/setMeta` `:229-241`；
  `SCHEMA_VERSION = 4` `:49`。

---

## 2. 插件机制（最小可用，显式注册）

### 2.1 目录结构

```
src/core/plugins/
  types.ts                 # PluginManifest / PluginDependency / PluginView / 能力枚举（共享、纯类型）
  builtin.ts               # BUILTIN_PLUGINS = [LINK_PREVIEW]；显式 import，无动态加载
src/core/link-extract.ts   # 纯函数：markdown → ExtractedLink[]（无网络、无 node API）
src/server/preview/
  registry.ts              # PREVIEW_PROVIDERS: Map<id, PreviewProvider>（显式 map）
  service.ts               # 队列/并发/缓存/TTL/退避/预算/禁用中断
  ssrf.ts                  # URL 校验/地址分类/DNS pinning
  fetch.ts                 # PreviewTransport（HEAD/GET/Range/redirect/timeout）
  html.ts                  # 有界 HTML 元数据扫描（OG/Twitter/title/meta/首段）
  link-preview/provider.ts # link-preview 的 manifest + extractUrls + resolvePreview
src/ui/lib/viewer-adapters.ts   # ViewerAdapter 注册表（P1 为空；P2 注册 file-viewer）
src/ui/state/plugins.tsx        # PluginsProvider / usePlugins
src/ui/components/
  SettingsSheet.tsx
  LinkPreviews.tsx
  LinkPreviewCard.tsx
```

**禁止**：`import(url)`、`readdirSync` 扫描插件目录、远程 registry、`<script src>`、
插件里 `eval`/`new Function`。启用/禁用只改变“是否调用已编译进来的 provider”。

### 2.2 接口（可直接抄）

```ts
// src/core/plugins/types.ts
export type PluginKind = "preview";
export type PluginCapability = "url-extract" | "preview-resolve" | "viewer-open";

export interface PluginDependency {
  id: string;
  optional: boolean;
}

export interface PluginManifest {
  id: string;                 // "link-preview"
  name: string;               // "链接预览"
  description: string;
  version: string;            // "1.0.0"
  kind: PluginKind;
  capabilities: readonly PluginCapability[];
  requires?: readonly PluginDependency[];
  defaultEnabled: boolean;
}

export interface ExtractedLink {
  url: string;                // 规范化后的 URL（唯一键）
  raw: string;                // 用户原文里的形态（不落库，仅调试）
  position: number;           // 帖子内顺序 0..2
  label: string | null;       // markdown 链接文字；裸 URL 为 null
}

export interface PreviewRecord {
  status: "ok" | "failed";
  kind: PreviewKind;
  mime: string | null;
  title: string | null;
  description: string | null;
  site_name: string | null;
  cover_url: string | null;
  cover_kind: "og" | "favicon" | null;
  cover_w: number | null;
  cover_h: number | null;
  final_url: string | null;
  error_code: PreviewErrorCode | null;
}

export interface PreviewProvider {
  manifest: PluginManifest;
  extractUrls(bodyMd: string): ExtractedLink[];
  resolvePreview(link: ExtractedLink, ctx: ResolveContext): Promise<PreviewRecord>;
}
```

`ResolveContext` 只暴露 `{ signal, deadlineAt, transport, policy }`；provider 不能自己发请求，
也不能读全局 fetch（便于单测与 SSRF 收口）。

```ts
// src/server/preview/registry.ts
import { LINK_PREVIEW } from "./link-preview/provider.ts";

const PROVIDERS: ReadonlyMap<string, PreviewProvider> = new Map([
  [LINK_PREVIEW.manifest.id, LINK_PREVIEW],
]);

export function getPreviewProvider(id: string): PreviewProvider | null {
  return PROVIDERS.get(id) ?? null;
}
```

`link-preview` 的 manifest：

```ts
export const LINK_PREVIEW: PreviewProvider = {
  manifest: {
    id: "link-preview",
    name: "链接预览",
    description: "识别帖子里的链接并抓取标题/描述/封面，在帖下显示预览卡片。",
    version: "1.0.0",
    kind: "preview",
    capabilities: ["url-extract", "preview-resolve"],
    requires: [{ id: "file-viewer", optional: true }],
    defaultEnabled: true,
  },
  extractUrls,
  resolvePreview,
};
```

`file-viewer` 在 P2 才成为内置插件（manifest + 客户端适配器）；P1 的 `requires` 状态为
`missing`，UI 提示“未安装：点击卡片将直接打开原链接”。

### 2.3 启用状态与存储

- 键：`plugins.<id>.enabled`（`"1"|"0"`）、`plugins.<id>.updated_at`、`plugins.<id>.updated_by`。
- 未写入时取 manifest `defaultEnabled`（`link-preview` 默认 **开**）。
- `Store.pluginEnabled(id)` / `Store.setPluginEnabled(id, enabled, actor)` 用现成
  `getMeta/setMeta`（`db.ts:229-241`）。
- 为什么不用 `<dataDir>/settings.json`：需要与帖子/缓存同库事务、随备份迁移、避免 0600
  权限与并发写；现有 `meta` 已是 `pending-export` 的既有用法（`store.ts:1930-1936`）。
- 开关是**实例级全局**，不是 per-account/per-post；设置页只有 owner/manager 可改。

### 2.4 调用规则

```text
写路径 commitOps:
  if pluginEnabled("link-preview"):
      try: links = provider.extractUrls(body)
      catch: log(host-less); links = []          // 预览失败绝不阻断发帖
      INSERT post_links(post_id, position, url, url_hash, label)
  else: 不抽、不写
读路径 hydratePosts:
  if !pluginEnabled: 不 join、不返回 previews
  else: 批量 LEFT JOIN link_previews；未命中 → 合成 {status:"pending"}
抓取:
  only when enabled；service 每次任务开始/每跳重定向再检查一次 enabled，关闭即 abort
```

- 关闭插件：写入不抽 URL、读不到 previews、`PreviewService.abortAll()` 中断在飞请求；
  已存在的 `post_links`/`link_previews` 行保留（重新启用可立即复用缓存）。提交后的
  `service.enqueue()` 是 fire-and-forget，必须自带 `.catch()`，SHALL NOT 影响发帖响应。
- 重新启用：后台 `backfillPostLinks()` 为缺失 `post_links` 的历史帖补索引（纯本地、分批、
  不抓网）；预览仍按阅读/补拉触发，不做全量抓取。
- 进程启动：若启用，跑一次 `backfillPostLinks()`（`LEFT JOIN post_links WHERE ... IS NULL
  LIMIT 100` 循环）；不预抓任何 URL。

Store / 服务接线（`src/server/store.ts` / `src/server/serve.ts`）：

```ts
// Store 新增方法（全部同步、无网络）
pluginEnabled(id: string): boolean;
setPluginEnabled(id: string, enabled: boolean, actor: string): void;
indexPostLinks(postId: string, bodyMd: string): number;   // 幂等；返回写入条数
postLinks(postId: string): Array<{ url: string; urlHash: string; label: string | null; position: number }>;
previewsForPosts(postIds: string[]): Map<string, LinkPreview[]>; // 批量 LEFT JOIN + pending 合成
deletePostLinks(postId: string): void;

// PreviewService（src/server/preview/service.ts）
enqueue(postId: string): void;                 // fire-and-forget（内部 catch）
warm(postId: string): Promise<LinkPreview[]>;  // 缺索引先 indexPostLinks，再触发缺失/过期抓取
abortAll(): void;

// serve.ts 接线
const previews = new PreviewService({ store, provider: getPreviewProvider("link-preview"),
  transport: createTransport(policy), policy, clock: Date.now });
createApp({ ...deps, previews });
```

### 2.5 设置页

- 入口：桌面账号 Dropdown 增「设置」；移动账号抽屉增「设置」。
- `SettingsSheet`（官方 `Sheet`）内容：
  - 插件列表：`Card`（官方）行，含名称、id、版本、描述、`Badge`（启用/停用）、`Switch`。
  - `link-preview` 行下显示依赖提示：`file-viewer` 已启用 / 未启用（回退新窗口）/ 未安装。
  - 隐私 `Alert`：启用后服务器会出站抓取帖子中的链接（仅 http/https、拒绝内网），目标站点
    可见本机服务器 IP；不执行脚本、不落 Cookie。
  - 权限：`role !== owner && role !== manager` 时 Switch disabled，文案“仅 owner/manager 可修改”。
  - 静态归档：整块替换为“静态归档不支持插件管理”，不发请求。
  - 错误：`Alert` + 重试按钮；加载中 `Skeleton`。
- 官方组件来源：`switch` 从 `https://ui.shadcn.com/r/styles/base-nova/switch.json` 取回，
  按收编纪律逐字保留（仅 import 别名/图标机械适配，文件头注出处）。

---

## 3. URL 识别

### 3.1 抽取算法（纯函数）

```ts
function extractUrls(bodyMd: string): ExtractedLink[] {
  const blocks = parseMarkdown(bodyMd);
  const out: ExtractedLink[] = [];
  const seen = new Set<string>();
  const push = (raw: string, label: string | null) => {
    if (out.length >= MAX_LINKS_PER_POST) return;
    const url = canonicalizeUrl(raw);          // §3.3
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, raw, position: out.length, label: truncate(label, 200) });
  };
  walkBlocks(blocks, {
    code: () => {},                            // fenced code 跳过
    inline: (tokens) => walkInline(tokens, {
      code: () => {},                          // 行内 code 跳过
      image: () => {},                         // 图片不是预览目标
      link: (href, children) => push(href, flattenText(children)),
      text: (text) => scanBareUrls(text).forEach((u) => push(u, null)),
    }),
  });
  return out;
}
```

常量：`MAX_LINKS_PER_POST = 3`、`MAX_URL_CHARS = 2048`、`MAX_LABEL_CHARS = 200`、
`MAX_SCAN_CHARS = 200_000`、`MAX_CANDIDATES = 64`。`scanBareUrls(text)` 返回
`Array<{ index: number; length: number; url: string }>` 以便 UI 复用同一套匹配/裁剪规则。

规则：

| 场景 | 处理 | 理由 |
|------|------|------|
| ` ``` ` fenced code / 行内 `` ` `` | 完全跳过 | 代码里的 URL 不是内容 |
| `![alt](src)` 图片 | 跳过 | 已有媒体渲染 |
| `[text](https://…)` | 接受，label=text | 用户显式链接 |
| 裸 `https://…` / `http://…` | 接受，label=null | X 行为 |
| `<https://…>` autolink | 接受 | parseMarkdown 会当 text，正则取到内部 URL |
| `mailto:` / `ftp:` / `javascript:` | 丢弃 | 仅 http/https |
| 同 URL 不同 `#fragment`/utm | 去重 | 规范化 |
| 第 4 个及以后 | 丢弃 | 每帖上限 3 |
| URL > 2048 字符 | 丢弃（不截断） | 截断会改变目标；超长视为异常 |
| 候选扫描量 | 最多 200k 字符 / 64 个候选 | 防病理输入 |
| 尾部标点 `.,;:!?)]}>` 与中文 `。，、；：！？` | 裁剪；括号成对时保留 | 避免把句子标点吃进 URL |

`scanBareUrls` 正则：`/https?:\/\/[^\s<>"'`]+/gi`，再做尾标点裁剪与括号平衡。

### 3.2 规范化（canonical URL）

```ts
function canonicalizeUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (raw.length > 2048) return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  if ((u.protocol === "http:" && u.port === "80") ||
      (u.protocol === "https:" && u.port === "443")) u.port = "";
  for (const key of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ["fbclid","gclid","yclid","mc_cid","mc_eid","igshid"].includes(key)) {
      u.searchParams.delete(key);
    }
  }
  return u.href;   // 保留其它 query 原序（签名 URL 不能排序）
}
```

- 规范化只用于**去重/缓存键**；展示与打开用 `final_url ?? url`。
- `url_hash = sha256(canonicalUrl)`（64 hex），作为 `link_previews` 主键；日志只打 host，
  不打完整 URL（query 可能含 token）。

### 3.3 写入时 vs 读取时（取舍）

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| 写入时抽取（选中） | 读路径零解析；与帖同事务；规则稳定；可回填 | 规则变更需回填；插件关闭期间不抽 | D3 |
| 读取时抽取 | 规则即时生效 | 每页每帖重复解析；读路径有副作用；无法在提交时启动抓取 | 否 |
| 延迟到首次预览请求 | 写路径最轻 | 首次读仍要解析；`post_links` 空窗期无法判断“有没有链接” | 否 |

回填：启用插件或启动时，`SELECT p.id, p.body_md FROM posts p LEFT JOIN post_links pl ON
pl.post_id = p.id WHERE p.deleted_at IS NULL AND pl.post_id IS NULL LIMIT 100` 循环，事务内
按 §3.1 写入；直到 0 行。纯本地，无网络。

---

## 4. 抓取管线

### 4.1 流程

```text
link (canonical)
  → URL 预检（§5.1）
  → DNS 解析 + 地址校验 + IP pin（§5.2/5.3）
  → HEAD（3s）── 2xx/3xx ──→ 读 content-type/length
  │                 └─ 405/501/网络错误 → GET
  → 重定向（最多 5 跳，逐跳重新预检+DNS+pin）
  → MIME 判定（§4.3）
      page     → GET 正文（≤512KiB）→ HTML 元数据（§4.4）
      image    → Range 0-511 魔数确认 → ok（cover=final_url）
      video    → Range 0-511 魔数确认 → ok（无 poster）
      audio    → Range 0-511 魔数确认 → ok
      document → Range 0-511 确认 PDF/ZIP/文本 → ok（title=文件名）
      unknown  → ok(kind=unknown，title 回退 hostname)；仍可跳转
  → upsert link_previews
```

### 4.2 请求约束

- HEAD 超时 3s；GET 总截止 8s；socket idle 3s；总跳数 5。HEAD 返回 405/501、网络错误或
  缺少 `content-type` 时回退 GET（HEAD 不可作为类型判定的唯一依据）。
- `Accept-Encoding: identity`（拒绝压缩体，防解压炸弹；响应仍带 `content-encoding` 非 identity
  时判 `unsupported`）。
- UA：`fde2e-report-link-preview/1.0 (+https://report.worker.fde2e.com)`。
- 不发 `Cookie`/`Authorization`/`Referer`/`X-Forwarded-*`；不保存 `Set-Cookie`。
- 页面正文上限 512 KiB；`Content-Length > 2 MiB` 的 page 直接 `blocked_size`（不读）。
- 媒体只读前 512 字节（`Range`；服务器忽略 Range 时读满 64 KiB 即中止）。
- 不跟随 `<meta http-equiv=refresh>`、不解析 CSS `url()`、不请求页面内 `<img>/<script>`。
- 代理环境变量一律忽略（直连），避免被 `HTTP_PROXY` 导向内网。

### 4.3 MIME 判定

优先级：**魔数 > `Content-Type` > URL 扩展名**。魔数命中时以魔数为准（header 常撒谎）。

| 魔数/类型 | kind | mime |
|-----------|------|------|
| PNG `89 50 4E 47` / JPEG `FF D8 FF` / GIF `GIF8` / WebP `RIFF….WEBP` / AVIF `ftypavif` / SVG 文本 `<svg` | image | image/* |
| MP4 `ftyp`@4 / WebM `1A 45 DF A3` / MOV `ftypqt` / Ogg `OggS` | video（Ogg 音频按 `audio/ogg` 细分） | video/* |
| MP3 `ID3`/`FF FB`、WAV `RIFF….WAVE`、FLAC `fLaC`、M4A `ftypM4A` | audio | audio/* |
| PDF `%PDF-`；ZIP `PK\x03\x04`（docx/xlsx/pptx 按扩展名细分） | document | application/pdf、officedocument… |
| HTML `<!doctype html`/`<html`/`<head`/`<body`（大小写不敏感，前 512B） | page | text/html |
| `text/plain`/`text/markdown`/`application/json` | document | 原 mime（标题取首行） |
| 其它 | unknown | header 原值或 null |

- `Content-Type` 缺失时用魔数；魔数也未命中 → `unknown`（仍可展示域名 + 跳转）。
- `image/svg+xml` 作为封面时要额外校验（见 §4.4）；作为链接目标时 kind=image，但 UI 封面
  用 `<img>` 直出 SVG 有脚本风险 → **封面不使用 SVG**，只显示文件图标。
- 页面声明 `og:type=video.*` 仍归 `page`（它是网页），不强行当视频文件。

### 4.4 网页元数据提取（优先级）

1. **Open Graph**：`og:title`、`og:description`、`og:site_name`、`og:image`、
   `og:image:width`、`og:image:height`、`og:type`。
2. **Twitter Card**：`twitter:title`、`twitter:description`、`twitter:image`。
3. **HTML 基础**：`<title>`、`<meta name="description">`、`<link rel="canonical">`。
4. **正文摘要**：`<article>`/`<main>` 内第一个 ≥40 字的 `<p>`（剥 script/style/标签、压缩空白），
   截 400 字；没有则用 meta description。
5. **封面回退**：`og:image` → `twitter:image` → `<link rel="image_src">` →
   `<link rel="icon">`/`/favicon.ico`（`cover_kind="favicon"`，UI 只当小图标，不当大图）。
6. **站点名回退**：`og:site_name` → hostname（去 `www.`）。
7. **标题回退**：og/twitter/title → markdown label → URL 末段文件名 → hostname。

限制：

- 标题 ≤200 字、描述 ≤400 字、站点名 ≤100 字；HTML 实体解码（`&amp;` 等）后再截断。
- 封面 URL 必须是绝对 `http/https`，≤2048 字符；拒绝 `data:`/`javascript:`/相对地址；
  相对地址按 `<base href>`（若有，且为 http/https）或 `final_url` 解析。
- **封面不渲染 SVG**（`image/svg+xml` 或 URL 以 `.svg` 结尾 → 丢弃封面，保留 favicon 逻辑）。
- `og:image:width/height` 仅在 1..8192 的整数时采用，供前端预留比例。
- 不存 HTML 原文；只存上述有界字段（隐私 + 存储）。
- 解析器是自写的有界标签扫描器：一次遍历，识别 `<meta>`/`<title>`/`<link>`/`<p>`，
  属性支持单双引号与任意顺序；`<script>/<style>/<noscript>` 内容整段跳过；输入上限 512 KiB。

### 4.5 字符集

- `Content-Type` 的 `charset=` 优先；否则扫描前 1024 字节的 `<meta charset>` /
  `<meta http-equiv=content-type content="…charset=…">`；否则 UTF-8。
- 用 `TextDecoder(charset)`；不支持的 label → UTF-8；非法序列用替换字符（不抛错）。
- 解码后再截断（按字符，不按字节）。

### 4.6 失败分类（`PreviewErrorCode`）

| code | 触发 | 用户文案 |
|------|------|----------|
| `blocked_scheme` | 非 http/https | 出于安全原因已跳过预览 |
| `blocked_private` | 私网/回环/链路本地/元数据/保留地址 | 同上（不暴露具体 IP） |
| `blocked_port` | 端口不在允许集 | 同上 |
| `blocked_size` | 声明/实际超过上限 | 内容过大，未预览 |
| `too_many_redirects` | >5 跳 | 预览暂不可用 |
| `timeout` | 总截止/空闲超时 | 预览超时 |
| `http_error` | 最终非 2xx | 站点返回错误 |
| `unsupported` | 压缩体/未知类型 | 不支持预览的类型 |
| `network` | DNS/连接/TLS 失败 | 预览暂不可用 |
| `parse_error` | HTML 解析异常 | 预览暂不可用 |

失败一律保留 `post_links`，UI 显示紧凑链接行，点击仍可打开。

### 4.7 并发、限流与预算

- 全局并发 3；每域名并发 1；队列上限 200（满则丢弃最旧的新任务，保留已缓存）。
- 每域名令牌桶 1 req/s、突发 2；收到 429/503 该域名冷却 60s。
- 每账号每小时最多触发 60 次抓取（`GET /api/previews?post=` 计一次预算/URL）；全局 500/小时。
- 单飞：`inFlight: Map<url_hash, Promise>`；同 URL 并发请求复用同一任务。
- 禁用插件：`abortAll()` + 清队列 + 清令牌桶。
- 进程退出：`AbortController.abort()`，等待 ≤1s，不让定时器阻止退出（`unref()`）。

---

## 5. SSRF 防护（不可妥协）

### 5.1 入口校验（每一跳都重跑）

1. 仅 `http:`/`https:`；拒绝其它 scheme。
2. 拒绝带 `username/password` 的 URL；拒绝空 host、host >253 字符、单标签 host（无 `.`，
   包括 `localhost` 及其子域）、`.local/.internal/.home.arpa/.lan` 后缀、含 `%`（IPv6 zone
   id）或控制字符的 host。
3. 端口：默认只允许 `80/443`；可选 `PREVIEW_ALLOWED_PORTS`（仅 owner 配置）追加 `8080/8443`；
   永远拒绝 `22/23/25/53/110/143/445/3306/5432/6379/9200/11211` 等管理端口。
4. IP 字面量（含十进制/八进制/十六进制写法 `http://2130706433/`、`0x7f.1`、`127.1`）
   SHALL 先归一化为标准 IP 再走地址分类；不能归一化的数字型 host SHALL 拒绝；普通域名
   SHALL 走 DNS 解析 + 答案校验。
5. URL 总长 ≤2048；query 长度不设额外限制（已由长度覆盖）。

### 5.2 地址分类（DNS 解析后，对**所有** A/AAAA 答案校验）

IPv4 拒绝：

| CIDR | 说明 |
|------|------|
| `0.0.0.0/8` | 本网络 |
| `10.0.0.0/8` | 私网 |
| `100.64.0.0/10` | CGNAT |
| `127.0.0.0/8` | 回环 |
| `169.254.0.0/16` | 链路本地（含 `169.254.169.254` 元数据） |
| `172.16.0.0/12` | 私网 |
| `192.0.0.0/24`、`192.0.2.0/24` | IETF/文档 |
| `192.168.0.0/16` | 私网 |
| `198.18.0.0/15` | 基准测试 |
| `198.51.100.0/24`、`203.0.113.0/24` | 文档 |
| `224.0.0.0/4` | 组播 |
| `240.0.0.0/4`、`255.255.255.255/32` | 保留/广播 |

IPv6 拒绝：

| CIDR | 说明 |
|------|------|
| `::/128`、`::1/128` | 未指定/回环 |
| `::ffff:0:0/96` | IPv4-mapped（取出内嵌 v4 再按上表校验） |
| `64:ff9b::/96` | NAT64（取出内嵌 v4 再校验） |
| `100::/64` | 丢弃前缀 |
| `2001:db8::/32` | 文档 |
| `2001:0000::/32` | Teredo |
| `2002::/16` | 6to4（取出内嵌 v4 再校验） |
| `fc00::/7` | ULA |
| `fe80::/10` | 链路本地 |
| `ff00::/8` | 组播 |

- 任一答案命中拒绝 → **整个 host 拒绝**（不因“另一个 A 记录是公网”而放行）。
- 无解析结果 → `network`。
- 地址分类用纯函数 `classifyAddress(ip): "public" | "blocked"`，单测覆盖上表。

### 5.3 连接与重定向（防 rebinding）

```ts
const targets = await dns.promises.lookup(host, { all: true, verbatim: true });
for (const t of targets) if (classifyAddress(t.address) !== "public") throw blocked;
const pinned = targets[0];                 // 本次请求固定该 IP
// TLS: host=pinned.address, servername=host, checkServerIdentity 仍验证 host
// HTTP: host=pinned.address，header Host: host
```

- **不再让系统二次解析**：连接目标是已校验 IP；`Host`/SNI 用原主机名，证书校验仍按原主机名。
  host 是 IP 字面量时不设置 SNI，证书按 IP SAN 校验（仍使用该 IP 连接）。
- 重定向：`redirect: manual`；每跳重新执行 §5.1/5.2/5.3；拒绝 `https→http` 降级；
  `Location` 相对地址按当前 URL 解析；`Location` 缺失/非法 → `http_error`。
- 不跟随 `Refresh` 头、不执行 JS、不解析 HTML 内跳转。
- 连接/读取都用 `AbortSignal`，总截止 8s；DNS 也计入截止。

### 5.4 响应与资源限制

- 页面 512 KiB 上限；`Content-Length > 2 MiB` 直接 `blocked_size`；流式读到上限+1 即 abort。
- 媒体嗅探最多 64 KiB；`Range` 请求不影响目标语义。
- 不接受 `Content-Encoding` 非 `identity`（防 gzip/br 炸弹）。
- 不解析、不存储 `Set-Cookie`；不把响应头回传给客户端（除白名单字段）。
- 不把响应当作 HTML 注入任何页面；元数据全部作为文本渲染（React 默认转义）。

### 5.5 隐私与日志

- 只存元数据（标题/描述/站点名/封面 URL/尺寸/最终 URL/错误码），不存 HTML 原文、不存响应头。
- 日志只记录 `host` + `error_code` + 耗时；**不记录完整 URL**（query 可能含 token）。
- 设置页明示：启用后服务器会出站抓取，目标站点可见服务器 IP；关闭插件即零出站。
- 封面在客户端直接加载，目标站点可见阅读者 IP；用 `referrerPolicy="no-referrer"` +
  `loading="lazy"` 降低泄露；P2 可选受限代理缓存。

### 5.6 测试放行（QA 专用，默认关闭）

- 环境变量 `FDE2E_REPORT_PREVIEW_TEST_ALLOW_ORIGINS`：逗号分隔的**精确 origin**白名单
  （如 `http://127.0.0.1:13698`），只放行该 origin，不放行整个私网。
- 仅当服务绑定回环且未 `--expose` 时生效；非回环/曝光启动时若设置该变量 → **拒绝启动**
  （与 open mode 同级的 fail-closed）。
- `/healthz` 暴露 `preview_policy: "default" | "test-allowlist"`，QA 断言生产板为 `default`。
- 单测通过注入 `policy` 直接放行夹具 origin，不依赖环境变量。

---

## 6. 存储与缓存

### 6.1 Schema（`SCHEMA_VERSION = 5`，加性）

```sql
CREATE TABLE IF NOT EXISTS post_links (
  post_id  TEXT NOT NULL,
  position INTEGER NOT NULL,
  url      TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  label    TEXT,
  PRIMARY KEY (post_id, position)
);
CREATE INDEX IF NOT EXISTS idx_post_links_hash ON post_links(url_hash);

CREATE TABLE IF NOT EXISTS link_previews (
  url_hash      TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  status        TEXT NOT NULL,              -- 'ok' | 'failed'
  kind          TEXT NOT NULL,              -- page|image|video|audio|document|unknown
  mime          TEXT,
  title         TEXT,
  description   TEXT,
  site_name     TEXT,
  cover_url     TEXT,
  cover_kind    TEXT,                       -- 'og' | 'favicon' | NULL
  cover_w       INTEGER,
  cover_h       INTEGER,
  final_url     TEXT,
  error_code    TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  fetched_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_previews_expires ON link_previews(expires_at);
```

- `post_links` 与帖子同事务写入；`softDelete` 同事务删除该帖关联。
- `link_previews` 全局共享；不挂 `post_id`（同 URL 多帖复用）。
- 不建 FK：帖子是软删；避免 `ON DELETE` 语义与旧库迁移复杂度。
- 旧库启动自动建表（`CREATE TABLE IF NOT EXISTS`），无 ALTER；`SCHEMA_VERSION` 仅用于记录。

### 6.2 读模型

```sql
SELECT pl.post_id, pl.position, pl.url AS link_url, pl.label, lp.*
FROM post_links pl
LEFT JOIN link_previews lp ON lp.url_hash = pl.url_hash
WHERE pl.post_id IN (?, ?, …)
ORDER BY pl.post_id ASC, pl.position ASC
```

- `lp.url_hash IS NULL` → 合成 `{status:"pending", kind:"unknown", url: link_url}`。
- `deleted_at !== null` → 不返回 previews（body 也为空）。
- 插件禁用 → 不执行上述查询，`previews` 字段缺省。
- 每页最多 20 帖 × 3 链接 = 60 行，单次批量查询。

### 6.3 TTL / 刷新 / 退避

- 成功：`expires_at = fetched_at + 24h`。
- 失败：`attempt_count += 1`；退避序列固定为 `[5m, 15m, 1h, 6h, 24h]`，取
  `BACKOFF[min(attempt_count - 1, 4)]`（第 5 次及以后都 24h）。
- 读路径：
  - `expires_at > now` → 直接返回缓存；
  - 过期 → **先返回旧值**（`status` 不变），后台单飞刷新；刷新失败保留旧值并更新退避。
  - 无行 → `pending`；`GET /api/previews?post=` 触发抓取。
- 失败重试只在 `GET /api/previews?post=` 或提交时触发；不在读路径无限重试。
- 缓存键是 `url_hash`（规范化），不同 utm/fragment 命中同一行。

### 6.4 清理

- 帖子删除：`DELETE FROM post_links WHERE post_id = ?`（同 `softDelete` 事务）。
- 预览 GC：`DELETE FROM link_previews WHERE fetched_at < now - 7d AND url_hash NOT IN
  (SELECT DISTINCT url_hash FROM post_links)`；启动一次 + 每 6h（`unref()`）。
- 手动：`gc` 命令可选追加 `--previews`（P2）；P1 不暴露 CLI。
- 导出：不导出预览；`export.ts` 显式剥离（见 §7.4）。

### 6.5 静态模式

- 静态归档没有后端：快照不含 `previews`，`StaticReportClient` 的 `previews()` 返回
  `{enabled:false, previews:[]}` 或抛 `READ_ONLY`（不发网络请求）。
- UI 在 `staticMode` 下不渲染 `LinkPreviews`；裸 URL 由 §8.6 的自动链接保证可点。
- 这是**显式降级**：静态归档不伪造预览、不尝试抓取（浏览器直接打开归档时也无法抓取）。

---

## 7. API 与数据结构

### 7.1 类型（`src/core/types.ts` 追加）

```ts
export type PreviewKind = "page" | "image" | "video" | "audio" | "document" | "unknown";
export type PreviewStatus = "pending" | "ok" | "failed";
export type PreviewErrorCode =
  | "blocked_scheme" | "blocked_private" | "blocked_port" | "blocked_size"
  | "too_many_redirects" | "timeout" | "http_error" | "unsupported"
  | "network" | "parse_error";

export interface LinkPreview {
  url: string;                 // canonical
  final_url: string | null;    // 重定向后的最终地址（已校验）
  domain: string;              // hostname 去 www.
  label: string | null;        // markdown 链接文字（裸 URL 为 null）
  status: PreviewStatus;
  kind: PreviewKind;
  mime: string | null;
  title: string | null;
  description: string | null;
  site_name: string | null;
  cover_url: string | null;
  cover_kind: "og" | "favicon" | null;
  cover_w: number | null;
  cover_h: number | null;
  error_code: PreviewErrorCode | null;
  fetched_at: number | null;
}

export interface PostView extends Post {
  // …既有字段…
  /** 仅链接帖、插件启用且未删除时出现；最多 3 条。 */
  previews?: LinkPreview[];
}
```

```ts
export interface PluginView {
  id: string;
  name: string;
  description: string;
  version: string;
  kind: "preview";
  capabilities: string[];
  enabled: boolean;
  default_enabled: boolean;
  requires: Array<{
    id: string;
    optional: boolean;
    status: "enabled" | "disabled" | "missing";
  }>;
  viewer_base: string | null;   // fileviewer 基址（P2 适配器用）
  limits: { previews_per_post: number; url_max_chars: number };
}
```

### 7.2 端点（都要求认证；CORS 沿用既有 allowlist）

> 施工注意：`PATCH` 不在现有 CORS `Access-Control-Allow-Methods`（`http.ts:40` 只有
> GET/POST/PUT/DELETE/OPTIONS），必须补上 `PATCH`，否则公网壳跨域预检失败。

| 方法/路径 | 权限 | 语义 |
|-----------|------|------|
| `GET /api/plugins` | 任意登录账号 | 返回 `{ok, plugins:[PluginView]}`；静态模式不可用（无后端） |
| `PATCH /api/plugins/:id` | owner/manager | `{enabled:boolean}` → `{ok, plugin:PluginView}`；未知 id 404 |
| `GET /api/previews?post=<id>` | 帖子可见者 | `{ok, enabled, post_id, previews:[LinkPreview], retry_after_ms}`；若该帖尚无 `post_links`，先本地补写索引；对缺失/过期行**触发**抓取；不可见/未知 404；**不接受 url 参数** |

`GET /api/previews` 的 `retry_after_ms`：仍有 pending 时为 1500，否则 null。客户端最多尝试
3 次（0ms/1500ms/9000ms），覆盖 8s 抓取截止。
`PATCH` 幂等：重复设置同值返回 200；写 `updated_by/updated_at`。

示例：

```json
GET /api/plugins
{
  "ok": true,
  "plugins": [{
    "id": "link-preview", "name": "链接预览", "version": "1.0.0",
    "description": "识别帖子里的链接并抓取标题/描述/封面，在帖下显示预览卡片。",
    "kind": "preview", "capabilities": ["url-extract", "preview-resolve"],
    "enabled": true, "default_enabled": true,
    "requires": [{ "id": "file-viewer", "optional": true, "status": "missing" }],
    "viewer_base": "https://file-viewer.tool.fde2e.com",
    "limits": { "previews_per_post": 3, "url_max_chars": 2048 }
  }]
}
```

```json
GET /api/previews?post=01M6VJXQNEAB…
{
  "ok": true, "enabled": true, "post_id": "01M6VJXQNEAB…",
  "previews": [{
    "url": "https://example.com/a", "final_url": "https://example.com/a",
    "domain": "example.com", "label": null, "status": "ok", "kind": "page",
    "mime": "text/html",
    "title": "Example Domain", "description": "This domain is for use in illustrative examples…",
    "site_name": "Example", "cover_url": "https://example.com/og.png",
    "cover_kind": "og", "cover_w": 1200, "cover_h": 630,
    "error_code": null, "fetched_at": 1794075291542
  }],
  "retry_after_ms": null
}
```

### 7.3 为什么内嵌 + 补拉，而不是 `?url=`

| 方案 | 结论 |
|------|------|
| `GET /api/previews?url=<任意>` | **否**：任何登录账号可把它当开放代理/内网探测器（即使有 SSRF 防护，仍是 oracle），且每帖 N+1、无批量 |
| 读路径内嵌 `PostView.previews[]`（选中） | 列表/线程/搜索/收藏/成员页一次请求拿到；只有链接帖多几 KB；无 N+1 |
| 纯懒加载（前端逐 URL 请求） | 首屏瀑布、卡片抖动、请求数放大；否 |
| 分页/批量 | 不需要：每帖 ≤3、按帖返回；端点只按 `post` 取，无分页语义 |

### 7.4 静态导出

- `SnapshotPost` 改为 `Omit<PostView, "media" | "quoted" | "previews">`；
  `snapshotPosts` 映射显式 `const { previews: _drop, ...base } = post;`。
- `StaticReportClient`：`plugins()` 返回 `{ok:true, plugins:[]}` 或抛 `READ_ONLY`；
  `previews()` 返回 `{enabled:false, previews:[]}`。二者都**不得**发网络请求。
- `test/export-static.test.ts` 断言快照 JSON 无 `previews` 键。

---

## 8. UI

### 8.1 组件树与数据流

```text
App
  ConnectionProvider
    PluginsProvider            // 新：GET /api/plugins，静态模式 enabled=false
      HomeFeedsProvider / BookmarksProvider / NotificationsProvider
        AppShell
          SettingsSheetProvider  // 新：单实例 + openSettings/closeSettings
            SettingsSheet
          PostCard
            Markdown
            MediaGrid
            QuoteCard
            LinkPreviews         // 新：posts[].previews → 卡片列表
              LinkPreviewCard
            TagChips
```

- `LinkPreviews` 只读 props 的 `post.previews`；若存在 `pending` 且非静态、插件启用，
  调 `client.previews(post.id)`，合并后若仍 pending 在 1500ms/9000ms 再试，之后停止。
- 插件刚启用、历史帖尚未回填 `post_links` 时，`post.previews` 可能缺省；`LinkPreviews`
  SHALL 在“插件启用且正文匹配到 http(s)”时也渲染一张 pending 骨架并调用补拉端点；
  补拉端点负责补写该帖的链接索引，返回空则骨架消失。
- 任何失败不抛到页面；卡片降级为紧凑链接行。
- `PluginsProvider` 在 connection ready 后加载；切后端/登录态变化重建；PATCH 乐观更新。
- `SettingsSheet` 只挂一份（`AppShell` 内），`Nav` 与 `AccountSheet` 通过
  `useSettingsSheet().open()` 打开，避免两个实例状态不同步。

### 8.2 卡片形态（官方 `Card` 为底）

```text
┌──────────────────────────────────────────────┐
│ ┌────────┐  example.com            [图标]     │
│ │ 封面   │  Example Domain                     │
│ │ 80/112 │  This domain is for use in …       │
│ └────────┘  [原文 ↗]                          │
└──────────────────────────────────────────────┘
```

- 容器：官方 `Card size="sm"`；`overflow-hidden`、`ring-1 ring-foreground/10`。
- 封面：80×80（<640px）/112×112（sm+）固定方形，`object-cover`，圆角 `rounded-lg`；
  `cover_w/h` 仅入库备用（P2 可做宽图形态），P1 不据此改变行高，保证 pending→ok 不抖动。
  仅渲染 `https:` 封面（本地 http 例外）；`onError` 隐藏图片并回退类型图标，不留破图。
- 右侧：第一行域名（`text-xs text-muted-foreground`）+ 类型图标（lucide 单色：
  `GlobeIcon/ImageIcon/VideoIcon/MusicIcon/FileTextIcon/LinkIcon`）；标题 2 行截断
  （`font-medium`）；描述 2 行截断（`text-sm text-muted-foreground`）。
- 最多 3 张，纵向 `gap-2`；移动端全宽，桌面同宽（跟随帖子列）。
- 状态：
  - `pending`：`Skeleton`，固定高 80/112px，`aria-busy="true"`；
  - `ok`：卡片；
  - `failed`：单行紧凑链接（`min-h-11`，`LinkIcon` + 域名 + “预览不可用”），可点；
  - 插件禁用/静态：不渲染。
- 交互：主区是 `<a href={final_url ?? url} target="_blank" rel="noopener noreferrer">`；
  `onClick` 若命中 viewer 适配器则 `preventDefault()` 并 `adapter.open()`；适配器未命中则
  浏览器原生新窗口。卡片右下/右上提供「原文 ↗」小链接（同样是 `_blank` + `noopener`），
  解决 fileviewer 跨域失败/适配器关闭的兜底。
- 无嵌套 `<a>`：主区 `<a>` 与「原文」`<a>` 是兄弟；卡片外层是 `<div>`。
- 无障碍：`aria-label={`${title ?? domain} 预览`}`；键盘可达；焦点环沿用主题 token。
- 布局稳定：`pending` 与 `ok` 高度一致（封面固定高）；从 pending→ok 只换内容不改变行高；
  `prefers-reduced-motion` 下不做高度/淡入动画；目标 CLS < 0.02。

### 8.3 打开行为

```ts
function openPreview(p: LinkPreview): void {
  const href = p.final_url ?? p.url;
  if (!/^https?:\/\//i.test(href)) return;
  const adapter = resolveViewerAdapter(p, { plugins });
  if (adapter?.open({ url: href, name: p.title })) return;
  window.open(href, "_blank", "noopener,noreferrer");
}
```

- 页面/未知/适配器关闭：新窗口原链接。
- 图片/视频/音频/文档且 `file-viewer` 启用：新窗口 fileviewer URL。
- `window.open` 被拦截时：toast 提示 + 「原文」链接仍可用（不静默失败）。
- 任何情况下 `rel="noopener noreferrer"`，不向目标站传 referrer。

### 8.4 设置面板

- `SettingsSheet`：官方 `Sheet side="bottom"`（移动）/ 同一组件桌面居中（业务样式），
  `data-testid="settings-sheet"`。
- 结构：
  1. 标题「设置」+ 说明「插件与预览行为」。
  2. 插件区：`Card` 列表；每行 `Switch`（官方 base-nova）：
     - 名称 / id / 版本 / `Badge`（启用/停用）；
     - 描述；
     - 依赖提示（file-viewer 状态）；
     - agent 只读时 `Switch disabled` + 文案。
  3. 隐私 `Alert`（出站抓取说明）。
  4. 错误 `Alert` + 重试；加载 `Skeleton`。
- 入口（两者都只调用 `useSettingsSheet().open()`，不各自挂 Sheet）：
  - 桌面 `Nav.tsx` 账号 Dropdown 增加 `SettingsIcon 设置`（`data-testid="account-menu-settings"`）；
  - 移动 `AccountSheet` 增加同项（`data-testid="account-menu-settings"`）。
- 打开设置时 SHALL 调 `plugins.refresh()`（拿到其他端刚改过的最新状态），失败保留缓存并提示。
- 多端同步：P1 以刷新/重新打开为准；P2 可接 event-hub 的 `plugin.updated`（可选，不阻塞）。
- 静态归档：显示只读说明，不请求 `/api/plugins`。

### 8.5 移动端/桌面尺寸

- 卡片跟随帖子列宽；<640px 封面 80px、标题/描述各 2 行；≥640px 封面 112px。
- 390×844 与 1280×900 两档验收；无横向溢出；与 `MediaGrid`/`QuoteCard` 的圆角、间距一致。

### 8.6 裸 URL 自动链接（共享降级能力）

- `Markdown.tsx` 的 `renderText` 在 @/# 匹配之外增加裸 URL 匹配；仅 `http/https`；
  输出 `<a target="_blank" rel="noopener noreferrer">`；代码块/行内 code/已有 link token 不处理。
  **正则与尾标点裁剪复用 `core/link-extract.ts` 的 `scanBareUrls`**（同一实现，避免两套规则漂移）。
- 目的：插件关闭或静态归档时“只保留纯链接”仍可点；不改变 markdown 解析器。
- 与预览卡并存：裸 URL 仍显示为文字链接，预览卡在下方；不重复渲染卡片（卡片由
  `post.previews` 驱动）。

---

## 9. fileviewer 适配器

### 9.1 接口（客户端）

> 需求里的 `openViewer` 适配器＝这里的 `ViewerAdapter`：服务端 provider 只管
> `extractUrls`/`resolvePreview`，客户端适配器只管“怎么打开”。

```ts
// src/ui/lib/viewer-adapters.ts
export interface ViewerAdapter {
  id: string;                    // "file-viewer"
  pluginId: string;              // "file-viewer"
  label: string;                 // "文件预览器"
  canOpen(input: { kind: PreviewKind; mime: string | null }): boolean;
  buildUrl(input: { url: string; name?: string | null }): string;
  open(input: { url: string; name?: string | null }): boolean; // false = 调用方回退
}

export function resolveViewerAdapter(
  preview: LinkPreview,
  deps: { plugins: PluginState; base: string | null },
): ViewerAdapter | null;
```

- P1：`VIEWER_ADAPTERS = []` → 永远回退新窗口。
- P2：`VIEWER_ADAPTERS = [fileViewerAdapter]`；`fileViewerAdapter` 是内置 `file-viewer` 插件的
  客户端实现，`pluginId="file-viewer"`；只有该插件 `enabled` 时才被解析。
- 适配器注册表是**显式数组**，不从网络/目录加载。

### 9.2 URL 构造

```ts
const base = sanitizeBase(plugin.viewer_base);   // 必须 https origin（本地 http 例外）
const parts = [`url=${encodeURIComponent(url)}`];
if (name) parts.push(`name=${encodeURIComponent(name)}`);
const decoder = decoderFor(kind, mime);          // image|video|audio|pdf|markdown|json|…|null
if (decoder) parts.push(`decoder=${encodeURIComponent(decoder)}`);
return `${base}/?${parts.join("&")}`;
```

- **不要用 `URLSearchParams.toString()`** 拼 `url`：它把空格编码成 `+`，与 fileviewer 的
  `encodeURIComponent` 契约不完全一致；统一用 `encodeURIComponent` 并以 `&` 连接。
- 契约对齐 `viewer-url.ts:1-14`：`/?url=<encodeURIComponent(绝对URL)>`，name 可选，
  decoder 可选；只传 http/https 绝对 URL。
- `decoder` 映射：image→`image`、video→`video`、audio→`audio`、pdf→`pdf`、
  markdown→`markdown`、json→`json`、csv→`csv`、html→`html`、docx/xlsx/pptx→同名、
  text→`text`；`unknown`/`page` 不传（站点自动判定）。
- 基址来源：`GET /api/plugins` 的 `viewer_base`（服务端 env `FDE2E_FILEVIEWER_BASE`，缺省
  `https://file-viewer.tool.fde2e.com`）；客户端不硬编码，便于 alpha 切换。
- 基址校验：`new URL` 后必须 `https:`（或 `http://localhost|127.0.0.1`），否则禁用适配器。

### 9.3 依赖声明与降级

- `link-preview` manifest：`requires: [{ id: "file-viewer", optional: true }]`。
- `GET /api/plugins` 计算每个依赖的 `status`：
  - `enabled`：插件存在且启用；
  - `disabled`：插件存在但关闭；
  - `missing`：无该插件（P1 状态）。
- UI 解析适配器时同时检查：适配器注册表有该 id + 对应插件 `enabled`。
- 未满足 → 点击走 `window.open(原链接)`；设置页显示
  “查看器：file-viewer 未启用/未安装，点击卡片将直接打开原链接”。
- 为什么不在 `link-preview` 里 `import` fileviewer：那会把“预览提供者”与“查看器”绑死，
  无法单独关闭/替换；适配器注册表让 P3 可加 `browser-viewer` 等替代实现。

### 9.4 已知限制

- fileviewer 是**浏览器端**解码：文档/文本/JSON 等需要 `fetch` 目标 URL，跨域无 CORS 会失败；
  图片/视频/PDF 多数可直接加载。卡片始终提供「原文 ↗」兜底，设置页不承诺所有站点可内嵌。
- fileviewer 不接收本仓认证头；只能打开公开可访问的 URL（帖子里的外链本来就是公开的）。
- 不把 fileviewer 的 `frameless/size` 用于普通点击（那是截图面）；只传 `url/name/decoder`。

---

## 10. 验收方案

### 10.1 本地夹具 HTTP 服务（`scripts/qa/link-preview-fixture.mjs`）

`Bun.serve({ hostname: "127.0.0.1", port: 0 })`，打印 JSON `{url, port}`；路由：

| 路由 | 响应 | 期望 |
|------|------|------|
| `/og-full` | HTML，完整 og:title/description/image/site_name + 1200×630 | `ok/page`，字段齐全 |
| `/og-no-cover` | HTML，只有 og:title/description | `ok/page`，cover null |
| `/twitter` | 只有 twitter:title/description/image | 回退 Twitter |
| `/plain` | `<title>` + meta description | 回退基础 HTML |
| `/article` | 无 meta，`<article><p>` 长文 | description=首段（≤400） |
| `/img.png` | 1×1 PNG，`image/png` | `ok/image`，cover=自身 |
| `/video.mp4` | `ftyp` 头，`video/mp4` | `ok/video` |
| `/audio.mp3` | `ID3` 头 | `ok/audio` |
| `/doc.pdf` | `%PDF-1.4` | `ok/document` |
| `/doc.docx` | ZIP 魔数 + 扩展名 | `ok/document` |
| `/unknown.bin` | `application/octet-stream` 随机字节 | `ok/unknown`，title 回退 hostname，可点 |
| `/404` | 404 | `failed/http_error` |
| `/slow` | 30s 不响应 | `failed/timeout` |
| `/redirect-private` | 302 → `http://127.0.0.1:<counterPort>/secret`（计数器服务，不在放行白名单） | `failed/blocked_private`，计数器 0 请求 |
| `/redirect-metadata` | 302 → `http://169.254.169.254/latest/meta-data/` | `failed/blocked_private` |
| `/redirect-loop` | 302 自循环 | `failed/too_many_redirects` |
| `/huge` | 5 MiB HTML | `failed/blocked_size` |
| `/gbk` | `charset=gbk` 中文标题 | 标题正确 |
| `/no-ct` | HTML 无 Content-Type | 嗅探为 page |
| `/meta-refresh` | meta refresh → 私网 | 不跟随，正常 page |
| `/cover.png` | PNG 封面 | `og:image` 可加载 |
| `/count` | 返回请求计数 | 插件关闭时计数 0 |

服务只绑定回环，不对外曝光；QA 脚本退出时 `server.stop()` 并打印 PID。
测试放行白名单只包含**夹具主服务的精确 origin**；重定向私网目标必须用另一个未放行的回环
端口（计数器服务），否则“重定向到私网被拒”会被白名单误放行、测试失去意义。

### 10.2 单测矩阵

`test/link-extract.test.ts`：

- 代码块/行内 code/图片链接 0 命中；markdown link + 裸 URL 命中；utm/fragment 去重；
- 每帖 3 条上限；第 4 条丢弃；URL >2048 丢弃；尾标点/中文标点裁剪；括号平衡；
- `$`/`%`/IDN/大小写 host 规范化；`mailto/ftp/javascript` 丢弃；空正文 0 条。

`test/link-preview-ssrf.test.ts`（全部拒绝，`error_code=blocked_private/scheme/port`）：

- IPv4/IPv6 CIDR 表逐项（§5.2）；`169.254.169.254`；`::ffff:127.0.0.1`；`64:ff9b::7f00:1`；
  `2002:7f00:1::`；`fe80::1`；`fc00::1`；`2001:db8::1`；
- 十进制/八进制/十六进制 IP、`127.1`、`localhost`、`foo.local`、单标签 host、userinfo；
- 端口 22/6379/3306 拒绝，80/443 放行；
- 重定向 302→私网拒绝；6 跳拒绝；https→http 拒绝；
- DNS 返回 [public, private] → 整 host 拒绝；DNS 只解析一次（注入 resolver 计数）。

`test/link-preview-service.test.ts`：

- 并发 3/域名 1/队列 200；单飞；TTL 24h；失败退避序列；stale-while-revalidate 先返旧值；
- 禁用 abort 在飞任务、队列清空；预算耗尽返回 pending；进程退出不悬挂。

`test/link-preview-html.test.ts`：

- OG 完整/缺字段/Twitter 回退/仅 title/GBK/无 content-type/首段/超长截断/SVG 封面拒绝/
  favicon 解析/相对封面 URL/实体解码；512KiB 输入 <20ms。

`test/link-preview-http.test.ts`：

- `GET /api/plugins` 字段；PATCH 权限（agent 403/owner 200）；未知 id 404；重复 PATCH 幂等；
- `GET /api/previews?post=` 不可见 404、插件禁用 `{enabled:false}`、无 url 参数（400 或忽略）；
- `PostView.previews` 只在链接帖出现；删除帖无 previews；
- 导出快照无 `previews`。

### 10.3 E2E（`scripts/qa/link-preview.mjs`，隔离后端 + 夹具）

| # | 场景 | 断言 |
|---|------|------|
| A1 | manager 发含 OG 链接的帖 | 帖下出现 1 张卡；标题/描述/域名/封面正确；`data-preview-status="ok"` |
| A2 | 点击卡片 | 新 page；URL=目标；`window.opener === null` |
| A3 | 发 4 个不同链接 | 只出 3 张卡；第 4 个不抓取（夹具 `/count` 计数=3） |
| A4 | 图片链接 | `kind=image`；封面=图片；点击 fileviewer（P2）或新窗口（P1） |
| A5 | 视频/PDF 链接 | kind 正确；图标正确；点击行为正确 |
| A6 | 未知站点/404 | 紧凑失败行；仍可点；不阻断正文 |
| A7 | 超时/超大体 | `failed/timeout|blocked_size`；正文首帧已可见（卡片后到） |
| A8 | 重定向到私网 | `failed/blocked_private`；夹具私网目标 0 请求 |
| A9 | 设置页关闭 link-preview | 卡片立即消失；新帖 0 抓取（`/count` 不增）；再开启后卡片回来 |
| A10 | agent 打开设置页 | Switch disabled；PATCH 403 提示 |
| A11 | file-viewer 关闭/未安装 | 点击走原链接；设置页依赖提示正确 |
| A12 | 静态导出 | `file://` 打开；0 张预览卡；裸 URL 可点；无网络错误 |
| A13 | 390×844 / 1280×900 | 无横向溢出；封面尺寸正确；CLS < 0.02 |
| A14 | 插件关闭后重新启用历史帖 | 打开旧帖后卡片 ≤5s 出现（补拉） |

证据：每步截图 + 关键网络（`/api/previews`、夹具请求）+ 断言日志；生产板 0 写入。

### 10.4 绿门

```bash
bun test
bun run check
bun run typecheck:ui
npx openspec validate report-link-preview --strict
```

---

## 11. 分期

| 阶段 | 范围 | 验收 | 可延后 |
|------|------|------|--------|
| **P1** | 插件 manifest/注册表/开关；schema v5；URL 抽取；SSRF 策略；HEAD/GET/MIME/OG；`post_links`/`link_previews`；`PostView.previews` + `GET /api/previews?post=`；设置页开关；预览卡 + 新窗口；静态剥离；裸 URL 自动链接；夹具/单测/E2E | §10 全矩阵；插件关闭 0 抓取；SSRF 全拒绝 | fileviewer 内嵌、封面代理、GC、event-hub 推送 |
| **P2** | `file-viewer` 插件适配器；图片/视频/音频/文档进 fileviewer；封面策略（https/SVG）；每域名限流细化；过期刷新观测/统计；`link_previews` GC；设置页统计/依赖提示 | A4/A5/A11；适配器 URL 正确；关闭回退；CORS 失败「原文」可用；GC 不误删 | oEmbed/站点规则 |
| **P3** | 站点专属 provider（YouTube/Vimeo/Bilibili/GitHub/oEmbed）；可选 HTML 解析器替换；robots 策略；封面受限代理；诊断页 | 站点规则逐站验收；解析器接口不变；robots 可配置 | 预览搜索索引、AI 摘要 |

**可延后项**：封面本地缓存、全文正文抽取、oEmbed、SVG 封面渲染、按域名黑白名单、插件市场。

---

## 12. 风险与回滚

| 风险 | 缓解 |
|------|------|
| SSRF 绕过（IPv6 mapped/NAT64/rebinding/重定向） | 纯函数地址分类 + 全答案校验 + IP pin + 逐跳重验；§10.2 矩阵 |
| `node:http(s)` 的 `lookup`/SNI 在 Bun 上行为差异 | P1-7 先做最小 spike：`host=ip, servername=host` 访问 `https://example.com` 与自签失败断言；不通过则改用 `tls.connect` 手写 HTTP/1.1（接口不变） |
| 抓取挂起/资源耗尽 | 总截止 8s + 流上限 + 并发 3/域名 1 + 队列 200 + abort |
| 目标站返回畸形 HTML/编码 | 有界扫描器 + charset 回退 + 解析异常→parse_error |
| Bun `TextDecoder` 对 gbk 等编码支持不确定 | P1-8 先做 encoding spike；不支持则按 UTF-8 回退并在验收报告登记，不阻塞 P1 |
| 预览结果写库与发帖争用 SQLite | 预览写入是短事务；沿用 WAL + `busy_timeout=5000`（`db.ts:21-24`），单批 upsert |
| 预览卡造成布局抖动 | pending 固定高 + 封面预留比例 + 无平滑高度动画 + CLS 断言 |
| 插件开关竞态（点击瞬间仍在飞） | 每次任务/每跳检查 enabled + abortAll；UI 以 `/api/plugins` 为准 |
| 缓存键碰撞/污染 | sha256(canonical)；规范化只去 fragment/tracking，不排序 query |
| 第三方封面泄露阅读者 IP | `no-referrer` + lazy；设置页告知；P2 可选代理 |
| 测试放行被误用于生产 | 仅回环+非曝光生效；曝光启动时设置即拒绝启动；`/healthz.preview_policy` 可审计 |
| 并行 change 冲突 | 按 §13 顺序 rebase；只做加性编辑 |

**回滚**：设置页一键关闭插件（立即停止抓取/隐藏卡片，无需部署）；代码回滚后新表无害
（`CREATE TABLE IF NOT EXISTS`，无 ALTER）；可保留或 `DROP TABLE post_links/link_previews`；
`PostView.previews` 是可选字段，旧客户端忽略。

---

## 13. 与并行 change 的合并顺序与冲突点

| 顺序 | change | 冲突文件 | 处理 |
|------|--------|----------|------|
| 0 | `report-notification-history-and-reply-submit`（当前工作树） | `types.ts` 末尾、`store.ts` `notificationHistory`、`http.ts` history 路由、`ThreadPage.tsx` | 先合；本 change 只在 `types.ts` 末尾追加、`store.ts` 的 `hydratePosts/softDelete` 加性修改 |
| 1 | `report-event-hub` | `store.ts` `softDelete`（加 `post.deleted`）、`App.tsx` Provider 树、`connection.tsx`、`http.ts` SSE | 先合；本 change 在最新 `softDelete` 事务里追加 `DELETE FROM post_links`；`App.tsx` 在 `EventHubProvider` 内加 `PluginsProvider` |
| 2 | `report-thread-timeline` | `PostCard.tsx`（平铺/导轨/自接链）、`ThreadPage.tsx` | 先合；本 change 只在两个分支的 `QuoteCard` 后插 `<LinkPreviews>`，不动缩进/导轨/ChainPosition |
| 3 | 本 change | `db.ts`（新表/版本号）、`protocol.ts`（路由）、`http.ts` 末尾、`api.ts`、`static-api.ts`、`export.ts`、`Markdown.tsx` | 最后 rebase；所有编辑加性；不修改通知/线程/事件语义 |

- 若 `report-thread-timeline` 在 `PostCard` 中把 `TagChips` 移到别处：以主干为准，把
  `<LinkPreviews>` 放在“正文/媒体/引用之后、标签之前”的同一逻辑位置，并同步更新本 design §1.3。
- 若 `report-event-hub` 的 `softDelete` 改成事务包装：把 `post_links` 删除放进同一事务，
  不要另开事务（避免删除帖仍有卡片）。
- P1 不依赖 event-hub；P2 的 `preview.updated` 是可选主题，event-hub 未合时不实现。

---

## 14. 决策记录（新增/变更）

| # | 决策 | 理由 | 被否 |
|---|------|------|------|
| D1 | 静态注册插件 | 无远程代码/供应链风险 | 动态加载 |
| D2 | meta 存开关 | 同库事务/备份/迁移 | settings.json |
| D3 | 写入时抽 URL | 读路径零解析、可回填 | 读时解析 |
| D4 | URL 级全局缓存 | 同 URL 一次抓取 | 每帖副本 |
| D5 | 内嵌 previews + post 补拉 | 无 N+1、无开放代理 | `?url=` |
| D6 | 自建 http(s) + IP pin | 防 DNS rebinding | 全局 fetch |
| D7 | 魔数优先 | header 不可信 | 只看 header |
| D8 | OG→Twitter→title→首段 | 主流优先级 | 只 title |
| D9 | TTL+退避+SWR | 不阻塞阅读、可自愈 | 同步抓取 |
| D10 | 封面只存外链 | 版权/存储/SSRF 最小 | 下载进媒体库 |
| D11 | fileviewer 走适配器 | 核心零硬绑定 | 卡片硬编码 |
| D12 | 静态无预览 | 无后端不能抓取 | 快照带预览 |
| D13 | P1 零新依赖 | 供应链最小 | 引入 DOM 解析器 |
| D14 | 设置复用抽屉/菜单 | IA 一致、改动小 | 新路由页 |
| D15 | 失败也保留紧凑链接 | 未知站点直接跳转（Owner 口径） | 隐藏失败链接 |
| D16 | 只按 post 提供补拉 | 防任意 URL oracle | 开放 URL 预览 |

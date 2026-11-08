# Design: report-link-preview（持久化预览字段 + 异步插件工作队列 + 实时推送）

> Owner 最终架构（2026-11-08）：
>
> 「底子必须是一次性注入/持久化字段：帖子自带 preview link 结构化字段，我们要做静态导出——
> 导出与静态壳不依赖任何运行时抓取。『走管道』＝走插件、异步工作：发帖立刻可见，插件后台处理；
> 处理可能分多次（先标题/描述、再封面；图片可能先出裁剪封面再出图片标题），每次更新都改那个
> 字段。每次修改都要推送：前端实时更新（可能 1 秒就 ready）——用事件推送，不是等刷新。
> cacheKey 在 preview link 里：基于插件元数据（id/版本）+ 帖子内容构造；换插件不立刻重算，而是
> 把 cacheKey 不匹配的帖子按时间倒序入队，后台慢慢补旧帖。图片封面是插件内处理过的 4:3 裁剪
> （重心检测），不是原图；这是 P2/P3 能力，但字段/多阶段模型现在就要容纳。」
>
> 本设计以该架构为准，替换上一版“读时派生”的语义。**持久化的是可被异步多次更新的结构化字段**，
> 不是“抓取一次即冻结”的最终快照；两者不矛盾：字段落库，但插件可以按阶段持续重写它并推送。

---

## 0. 决策摘要

| # | 决策 | 理由 | 被否方案 |
|---|------|------|----------|
| D1 | `PostView.previews: PreviewLink[]` 为**持久化字段**（0..3，第一条为主卡） | 静态导出/静态壳零运行时抓取；刷新/重启后仍在 | 读时从 URL 临时派生 |
| D2 | 存储用 **`post_previews` 表**（不是 `posts.previews_json`） | 每链接独立多阶段更新、按帖批量查询、按 `cache_key` 扫描、导出直接 join | 整块 JSON 重写/并发覆盖 |
| D3 | 写入路径只抽 URL + 建 **pending 行 + 持久化任务**，帖子立即返回 | 发帖不被抓取阻塞；任务可重启续跑 | 同步抓取后返回/发帖后丢内存队列 |
| D4 | 异步 worker **最新优先**（post created_at desc）+ SQLite 持久化 | 新帖先 ready；旧帖后台慢慢补；进程重启不丢任务 | FIFO/内存队列 |
| D5 | 多阶段写：每阶段写字段 + 插入 `post.updated` 事件（同事务） | 首阶段即可展示（标题/描述），封面/图片标题后续补 | 全部阶段完成后才写一次 |
| D6 | `post.updated` 只推送、**不进 `NOTIFICATION_TYPES`** | 通知/CLI/未读完全不受影响 | 复用通知事件 |
| D7 | `cache_key = sha256(plugin_id+plugin_version+rules_version+canonical_url+body_hash)` | 插件/规则/正文变化可精确失效；同帖同 URL 可去重 | 只按 URL/只按帖子 |
| D8 | 版本不匹配 → **按时间倒序入队**，不清库、不改已展示旧值 | 不制造部署瞬间出站风暴；旧卡片在新处理完成前保持旧值 | 版本升级清空 `post_previews` |
| D9 | 插件关闭 → 不抽/不入队/不抓取/卡片全部隐藏（新旧一致），字段保留 | 开关可逆；重开同版本直接恢复 | 关闭即删字段 |
| D10 | 静态导出**原样包含 previews**；静态 UI 只渲染 `ready/partial`，其余纯链接 | 归档离线可读；pending/failed 无运行时抓取可等 | 静态模式剥离/抓取 |
| D11 | 抓取仍走 HEAD→GET、魔数优先、OG 优先级、SSRF 清单不变 | 安全与质量基线不降 | 放宽 SSRF |
| D12 | URL 抽取在 `commitOps` 内纯本地完成；失败不阻断发帖 | 索引与正文同事务；预览永远不能成为发帖失败原因 | 异步抽取/读时解析 |
| D13 | 封面：P1 存外链 `og:image`；P2 图片插件阶段下载并做 **4:3 重心裁剪**，存本仓 media | Owner 指定；静态导出随 media 一起归档 | 直接展示原图 |
| D14 | 客户端新增 `post.updated` topic + `PostPreviewsProvider`，原地更新卡片 | 不整页刷新、不重排 feed；同一帖多阶段自然过渡 | 每次事件 refreshTimeline |
| D15 | `pending` 占位卡固定高（按 4:3 封面预留），`ready` 淡入 | 防 CLS；首帧帖子立即可见 | 空白/骨架整页 |
| D16 | fileviewer 由 `file-viewer` 插件适配器提供，`link-preview` 只声明可选依赖 | 核心零硬绑定；关闭回退原链接 | 卡片硬编码 viewer |
| D17 | worker 单实例锁（`meta`）+ 并发 3/域名 1 + 指数退避 | 多进程/多标签不抢任务；失败可自愈 | 无边界的后台 Promise |
| D18 | 任务表按 `(post_id,url_hash)` 去重；cacheKey 变化原地重置 job | 同 URL 不重复入队；版本升级可重跑 | 每次扫描重复插任务 |
| D19 | `plugin.updated` 控制帧（无 DB 事件）同步多端开关 | 关闭后其他标签页也立即隐藏 | 只改本地开关 |
| D20 | 导出路径只读，不触发抓取/入队 | 导出确定、可离线、无副作用 | 导出时补抓 |

---

## 1. 现状与接入点（path:line）

### 1.1 帖子写入与读投影

- `commitOps` 单事务插 post/reply、分配 seq、写事件：`src/server/store.ts:688-693`（签名）、
  `:786`（根帖 `post.created`）、`:839`（回复事件）、提交后 `hydratePosts`。
- `PostView` 当前字段：`src/core/types.ts:167-173`；新增 `previews` 为持久化数组字段。
- 所有读入口共用 `hydratePosts`：`src/server/store.ts:1030`（定义）、`:1135-1169`（逐帖拼装）；
  timeline/feed/profile/thread/search/bookmarks/read 都经它。
- 软删：`src/server/store.ts:1577-1601`；本 change 同事务删除该帖 `post_previews` 与
  `preview_jobs`，并继续写 `post.deleted`（event-hub 已实现）。
- 正文上限 200k：`src/core/validation.ts:6`；媒体白名单 `:14-28`。

### 1.2 markdown 语法树可复用

- `parseMarkdown`：`src/core/markdown.ts:123-222`（fenced code `:143-155`）；
  `parseInline`：`:37-114`（image `:58-72`、link `:73-90`）。URL 抽取必须复用该树。

### 1.3 渲染与帖子卡片

- markdown link 已 `target=_blank rel="noreferrer noopener"`：
  `src/ui/components/Markdown.tsx:149-163`；裸 URL 不会自动链接（`renderText` `:91-128`）。
- 帖子卡片顺序：正文→媒体→引用→标签 `src/ui/components/PostCard.tsx:246-265`；自接分支
  `:171-175`。预览区插在 `QuoteCard` 后、`TagChips` 前。
- 本仓查看器是 lightbox：`MediaGrid.tsx:176-225`、`ImageViewer.tsx:1-15`。

### 1.4 fileviewer

- URL 契约：`/?url=<encodeURIComponent(绝对URL)>&name=&decoder=`，仅 http/https
  ——`fde2e-tools-v0/apps/file-viewer/src/lib/viewer-url.ts:1-14`、`:89-110`。
- 14 解码器/registry：`fde2e-tools-v0/packages/shared/src/registry.ts:177-233`；基址
  `https://file-viewer.tool.fde2e.com`
  （`fde2e-omni-v1/apps/web/src/lib/fileViewer.ts:17-19`、
  `fde2e-omni-v1/apps/server/src/uploads.ts:176`）。
- 纯前端解码；跨域文档/文本受目标站 CORS 限制（§11.4）。

### 1.5 事件总线（已落地，作为推送基础）

- `EventType` 当前三种：`src/core/types.ts:72`；`NOTIFICATION_TYPES` 只有
  `post.created/thread.invited`：`:79`。
- `store.eventLines` 已按 viewer 可见性扫描全部事件：`src/server/store.ts:1707-1765`；
  `notificationLines` 委托并只取 `NOTIFICATION_TYPES`：`:1832-1853`；
  未读/历史也只读通知类型：`:1778`、`:1903`。
- 服务端 hub：`src/server/hub.ts`（`/api/stream?hub=2`，`event: hub` 帧）；
  路由接线 `src/server/http.ts:259-285`。
- 客户端 hub topic：`src/ui/state/hub/types.ts`（`HubTopic`/`HUB_DATA_TOPICS`）、
  `provider.tsx`（`useEventHub`）。新增 `post.updated` 只需扩 topic 与投影，不新开连接。

### 1.6 设置、能力、静态

- 设置面：移动 `AccountSheet.tsx:109-143`、桌面 `Nav.tsx:126-154`；无设置页。
- `API_ROUTES`：`src/core/protocol.ts:34-77`；`/api/status` `src/server/http.ts:843-866`；
  路由 lint `scripts/check.mjs:32-44`。
- 静态快照：`src/ui/lib/static-api.ts:50-70`；导出映射 `src/server/export.ts:158-162`
  （当前 `...post` 展开；本 change 让 previews 原样进入）；静态横幅 `AppShell.tsx:61-79`。
- SQLite：`meta`/`getMeta/setMeta` `src/server/db.ts:58-61`、`:229-241`；`SCHEMA_VERSION=4`
  `:49`；测试断言 `test/social.test.ts:157`。

---

## 2. 插件机制（静态注册，仍是硬约束）

### 2.1 目录结构

```
src/core/plugins/
  types.ts                 # PluginManifest / PluginDependency / PluginView / Preview 类型
  builtin.ts               # BUILTIN_PLUGINS = [LINK_PREVIEW]；显式 import，无动态加载
src/core/link-extract.ts   # markdown → ExtractedLink[]（纯函数，无网络）
src/server/preview/
  registry.ts              # PREVIEW_PROVIDERS: Map<id, PreviewProvider>
  queue.ts                 # preview_jobs 持久化队列（enqueue/claim/complete/fail）
  worker.ts                # 单实例锁、最新优先、并发/限流、多阶段推进
  service.ts               # 组合门面：enqueue/enqueueStale/abortAll/stats
  ssrf.ts                  # URL/地址校验、DNS pinning
  fetch.ts                 # HEAD/GET/Range/redirect/timeout
  html.ts                  # 有界 HTML 元数据扫描
  link-preview/provider.ts # manifest + extractUrls + buildCacheKey + phases + resolvePhase
src/ui/state/
  plugins.tsx              # PluginsProvider
  post-previews.tsx        # PostPreviewsProvider（post.updated 合并）
src/ui/components/
  SettingsSheet.tsx
  LinkPreviews.tsx
  LinkPreviewCard.tsx
```

**禁止**：`import(url)`、目录扫描、远程 registry、运行时下载代码、插件 `eval`。
启用/禁用只控制是否调用已编译进来的 provider 与 worker。

### 2.2 接口（含多阶段）

```ts
export interface PluginManifest {
  id: string;                 // "link-preview"
  name: string;
  description: string;
  version: string;            // 插件版本（进 cacheKey）
  rulesVersion: number;       // 抓取/元数据规则版本（进 cacheKey）
  kind: "preview";
  capabilities: readonly ("url-extract" | "preview-resolve" | "cover-crop" | "viewer-open")[];
  requires?: readonly { id: string; optional: boolean }[];
  defaultEnabled: boolean;
}

export interface ExtractedLink {
  url: string;                // canonical
  position: number;           // 0..2
  label: string | null;
}

export type PreviewPhase = "meta" | "cover" | "probe" | "crop" | "title";

export interface PhaseResult {
  phase: PreviewPhase;
  fields: Partial<{
    kind: PreviewKind; mime: string | null; final_url: string | null;
    title: string | null; description: string | null; site_name: string | null;
    cover: { url: string; w: number | null; h: number | null; kind: "og" | "favicon" | "crop" | null } | null;
  }>;
  /** 阶段错误；null/缺省=成功。错误只影响状态机，字段仍按阶段写入 */
  errorCode?: PreviewErrorCode | null;
}

export interface PreviewProvider {
  manifest: PluginManifest;
  extractUrls(bodyMd: string): ExtractedLink[];
  buildCacheKey(input: {
    canonicalUrl: string; bodyHash: string;
    pluginId: string; pluginVersion: string; rulesVersion: number;
  }): string;                       // sha256 hex
  phases(link: ExtractedLink): readonly PreviewPhase[];
  resolvePhase(link: ExtractedLink, phase: PreviewPhase, ctx: ResolveContext):
    Promise<PhaseResult>;
}
```

- P1 页面 phases=`["meta","cover"]`；图片 phases=`["probe"]`（P2 扩展为 `["probe","crop"]`，
  再可加 `"title"`）；视频/音频/文档 phases=`["probe"]`。新增阶段不改 schema/API/UI。
- `resolvePhase` 只负责该阶段；worker 负责状态机、写库、事件、重试。
- 所有阶段共享 `ctx: {signal, deadlineAt, transport, policy, cache: Map<string,unknown>}`；
  provider 不能自己发请求；同一 job 的页面 `meta`/`cover` 阶段 SHALL 复用 `ctx.cache` 的
  HEAD/GET 结果，避免同一 URL 抓两遍。

### 2.3 启用状态

- `meta` 键：`plugins.<id>.enabled`、`.updated_at`、`.updated_by`；缺省取 manifest
  `defaultEnabled`（`link-preview` 默认开）。
- `Store.pluginEnabled(id)` / `setPluginEnabled(id, enabled, actor)`；API `PATCH` 仅
  owner/manager 可改。
- 关闭：worker 停止 claim、不入队、不抓取、`abortAll()`；**所有帖子（新旧）卡片隐藏**
  （UI `PluginsProvider` + `plugin.updated` 控制帧）；`post_previews`/`preview_jobs` 保留。
- 打开：扫描“缺 previews / cacheKey 不匹配”的帖子按时间倒序入队（§13）；同版本已有
  `post_previews` 的帖子不会被重抓；`status='failed'` 的 job SHALL 重置为 queued 继续重试。

### 2.4 设置页

- 入口：桌面账号 Dropdown / 移动账号抽屉新增「设置」；`SettingsSheetProvider` 在
  `AppShell` 只挂一份 Sheet。
- 内容：官方 `Card`/`Switch`/`Badge`/`Alert`；插件名/id/version/rulesVersion、启用开关、
  worker 状态（queued/running、最近事件）、隐私说明（出站抓取、4:3 裁图为 P2）、
  依赖提示（file-viewer 已启用/未启用/未安装）。
- 静态归档：只读说明，不发 `/api/plugins` 请求。
- P2 增加：手动“重建预览队列” `POST /api/previews/backfill`（owner/manager）与进度。

---

## 3. 持久化数据模型

### 3.1 `post_previews`（帖子自带字段）

```sql
CREATE TABLE IF NOT EXISTS post_previews (
  post_id      TEXT NOT NULL,
  position     INTEGER NOT NULL,          -- 0..2；0=主卡
  url          TEXT NOT NULL,             -- canonical
  url_hash     TEXT NOT NULL,
  label        TEXT,                       -- markdown 链接文字（裸 URL 为 NULL）
  cache_key    TEXT NOT NULL,             -- §13
  kind         TEXT NOT NULL DEFAULT 'unknown',
  mime         TEXT,
  title        TEXT,
  description  TEXT,
  site_name    TEXT,
  final_url    TEXT,
  cover_url    TEXT,
  cover_w      INTEGER,
  cover_h      INTEGER,
  cover_kind   TEXT,                       -- 'og' | 'favicon' | 'crop' | NULL
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|partial|ready|failed
  phase        TEXT NOT NULL DEFAULT 'queued',
  fields_ready TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  attempts     INTEGER NOT NULL DEFAULT 0,
  error_code   TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (post_id, position)
);
CREATE INDEX IF NOT EXISTS idx_post_previews_cache ON post_previews(cache_key);
CREATE INDEX IF NOT EXISTS idx_post_previews_status ON post_previews(status, updated_at);
```

- 选表不选 `posts.previews_json`：每链接独立多阶段更新，不需要整块 JSON 重写；按帖批量
  join、按 `cache_key` 扫描、静态导出都更直接。
- `PostView.previews` 由该表批量读取，按 `position` 升序；无链接帖为空数组。
- **插件关闭时服务端仍返回已持久化 previews**（字段是帖子数据）；是否展示由客户端
  `PluginsProvider`/静态 `preview_enabled` 决定。这样重开同版本可立即恢复、静态导出也不丢字段。
- 软删同事务 `DELETE FROM post_previews WHERE post_id = ?`。

### 3.2 `preview_jobs`（持久化任务队列）

```sql
CREATE TABLE IF NOT EXISTS preview_jobs (
  post_id         TEXT NOT NULL,
  url_hash        TEXT NOT NULL,
  cache_key       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued', -- queued|running|failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_run_at     INTEGER NOT NULL,
  enqueued_at     INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  phase           TEXT,
  post_created_at INTEGER NOT NULL,       -- 最新优先排序
  last_error      TEXT,
  PRIMARY KEY (post_id, url_hash)
);
CREATE INDEX IF NOT EXISTS idx_preview_jobs_ready
  ON preview_jobs(status, next_run_at, post_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_preview_jobs_post ON preview_jobs(post_id);
```

- 去重键 `(post_id,url_hash)`；同帖同 URL 不重复入队。
- `cache_key` 变化时原地更新 job（重置 `status=queued/attempts=0/next_run_at=now`）；
  running 中的旧任务在每阶段前重读 job，发现 key 变化即停止，让新任务跑。
- 完成即删除 job；可重试失败置 `status='queued'` + 退避 `next_run_at`；达到最大次数
  （5 次）置 `status='failed'` 保留，等待下一次版本扫描/手动回填再复活。

### 3.3 `PreviewLink` 契约

```ts
export type PreviewStatus = "pending" | "partial" | "ready" | "failed";
export type PreviewKind = "page" | "image" | "video" | "audio" | "document" | "unknown";
export type PreviewErrorCode =
  | "blocked_scheme" | "blocked_private" | "blocked_port" | "blocked_size"
  | "too_many_redirects" | "timeout" | "http_error" | "unsupported"
  | "network" | "parse_error" | "crop_failed";

export interface PreviewLink {
  url: string;
  final_url: string | null;
  label: string | null;          // markdown 链接文字；裸 URL 为 null
  kind: PreviewKind;
  mime: string | null;
  title: string | null;
  description: string | null;
  site_name: string | null;
  cover: { url: string; w: number | null; h: number | null; kind: "og" | "favicon" | "crop" | null } | null;
  status: PreviewStatus;
  phase: string;                 // 最近完成阶段
  fields_ready: string[];        // ["kind","mime","title","description","site_name","cover"]
  cache_key: string;
  attempts: number;
  updated_at: number;
  error_code: PreviewErrorCode | null;
}

export interface PostView extends Post {
  // …既有字段…
  /** 持久化字段，0..3；第一条为主卡。无链接帖为 []。 */
  previews: PreviewLink[];
}
```

- 数组顺序即主卡顺序（`position` 0 为第一条）；UI 最多渲染 3 张。
- `status` 语义：`pending`=无字段；`partial`=已有阶段字段但未完成；`ready`=provider
  声明的全部阶段完成；`failed`=首次处理失败且无可用字段。**重处理失败不把旧字段改 failed**
  （§13.3）。

### 3.4 状态机

```text
pending ──meta/probe 成功──> partial ──cover/crop 成功──> ready
   │                              └──某阶段失败且无可用字段──> failed
   └──各阶段失败且无字段──> failed（保留 error_code/attempts）

重处理（cacheKey 变化）：
  ready/partial 旧值保持不变
    └──phase 成功──> 覆盖对应字段 + status 仍为 partial/ready
    └──phase 失败──> 保留旧值，job 失败重试；不把卡片降级
```

- 每个阶段写入只覆盖该阶段拥有的字段，`fields_ready` 取并集，`phase` 更新，`updated_at`。
- 新帖首次处理失败 → `status=failed`，UI 显示普通链接；后续 job 重试成功可转 ready。

---

## 4. 写入路径（发帖立即返回）

`commitOps` 的 post/reply 分支，在**同一事务**内：

```text
if pluginEnabled("link-preview"):
  links = provider.extractUrls(body)          # 纯本地；失败 log 且 links=[]
  bodyHash = sha256(body)
  for link in links (0..2):
    cacheKey = provider.buildCacheKey({canonicalUrl: link.url, bodyHash,
                  pluginId, pluginVersion, rulesVersion})
    upsert post_previews(post_id, position, url, url_hash, label, cache_key,
                         status='pending', phase='queued', fields_ready='[]',
                         attempts=0, updated_at=now)
    upsert preview_jobs(post_id, url_hash, cache_key, status='queued',
                        attempts=0, next_run_at=now, enqueued_at=now,
                        post_created_at=post.created_at)
```

- **不抓取**、不等待 worker；帖子事务提交后 HTTP 立即返回（<200ms 目标）。
- `hydratePosts` 在提交响应里读 `post_previews`，返回 `previews: pending`，前端立即渲染占位卡。
- 抽取失败/超长/病理输入：跳过该帖链接，帖子照常提交；`post_previews`/jobs 0 行。
- 插件关闭：不抽、不建行、不入队。
- 回复同样处理；引用帖不生成预览。
- `bodyHash`/`cache_key` 在写入时算定；帖子不可变，后续编辑（未来）改变 body 时重新入队。

---

## 5. 异步 worker（持久化、最新优先、多阶段）

### 5.1 单实例与调度

- 启动时 `preview_jobs` 已持久化；worker 在 `serve` ready 后启动（或由 env 关闭）。
- 单实例锁：`meta` 键 `preview.worker.lock` = JSON `{pid,instanceId,startedAt}`；
  每轮心跳更新；>30s 未更新视为陈旧可接管；进程退出清除。
- 选择任务：
  ```sql
  SELECT j.* FROM preview_jobs j
  WHERE j.status='queued' AND j.next_run_at <= ?
  ORDER BY j.post_created_at DESC, j.enqueued_at ASC
  LIMIT ?
  ```
  最新帖先处理（Owner 要求）。
- 全局并发 3；每域名并发 1；队列天然由表限制；worker 每 200ms 轮询一次（单进程内），
  不做内存队列。
- 关闭/退出：`AbortController.abort()`，任务回 `queued`（保留 attempts），不丢。

### 5.2 多阶段推进

`Store.applyPreviewPhase(input: { postId, urlHash, cacheKey, phase, fields, fieldsReady,
status, errorCode, attempts }): PreviewLink[]` 是唯一写入口：单事务更新
`post_previews` + 插 `post.updated`，返回该帖最新数组。

```text
claim job (status=running, attempts+1)
UPDATE post_previews SET cache_key = job.cache_key
  WHERE post_id=? AND url_hash=?          -- 只换 key，不动旧字段/旧 status
re-read job.cache_key; if != post_previews.cache_key -> requeue/stop
for phase of provider.phases(link):
  check plugin enabled + job.cache_key unchanged
  check post still exists && deleted_at IS NULL; else delete job and stop
  result = provider.resolvePhase(link, phase, ctx)
  store.applyPreviewPhase({               -- 单事务
    postId, urlHash, cacheKey: job.cache_key, phase,
    fields: result.fields, fieldsReady: union, status: computed, errorCode
  })
  -- 内部: UPDATE post_previews SET 阶段字段/phase/fields_ready/status/attempts/updated_at
  --       INSERT events(type='post.updated', actor=post.author, post_id, root_id,
  --                    payload={post_id, previews: latestPostPreviews, phase, status})
  --       事务提交后 store.notifyChange()（hub 50ms 合并唤醒）
if all phases done: DELETE preview_jobs row
```

- **每个阶段一次事件**；同一事务写字段+事件，hub 的 `store.onChange` 50ms 合并后推送。
- 同一 job 的多个阶段共享 `ctx.cache`：页面 `meta` 阶段抓取的 HEAD/HTML 由 `cover` 阶段
  复用，不重复请求同一 URL；图片 `probe` 的尺寸/类型可由 `crop` 复用。
- 事件 payload 带该帖**最新完整 previews 数组**（≤3），客户端直接覆盖；不带正文。
- 阶段之间可被新 cacheKey 打断；旧阶段已写字段保留（旧值或新值，均为可展示数据）。
- 重处理在 claim 时先换 `cache_key`（不动旧字段），因此扫描不会重复入队；若任务最终失败，
  旧字段仍可展示，job 继续退避重试。
- provider 抛错按该阶段失败处理：新帖无可用字段 → `post_previews.status=failed`；重处理
  → 保留旧 `status/fields`，只记 `error_code`/attempts 并退避。
- 失败退避：5m→15m→1h→6h→24h（`attempts` 对应）；可重试失败回 `queued`，第 5 次后
  `job.status=failed`；429/503 域名冷却 60s。
- 图片 4:3 裁剪（P2）：`probe` 阶段先写 kind/mime/尺寸；`crop` 阶段下载有界图片、重心裁剪
  4:3、存入 `media`（内容寻址），写
  `cover={url:"/api/media/<hash>",w,h,kind:"crop"}`；`title` 阶段可再补图片标题。
  字段/阶段模型 P1 已容纳，P2 只加 provider 阶段实现。
- worker 不执行 JS、不把 HTML 注入任何响应；所有写入都是文本字段。

### 5.3 重启/崩溃

- 任务在表中，重启后继续；`status='running'` 的残留任务在启动时重置为 `queued`
  （attempts 保留，`next_run_at=now+小抖动`）。
- 阶段写入与事件同事务；崩溃只会重做该阶段，`post_previews` 不出现半事件/半字段。
- 事件可能重复（同一阶段重做）——客户端按 `seq` 与 `updated_at` 幂等覆盖，重复事件无副作用。

---

## 6. 抓取管线

### 6.1 流程

```text
link (canonical)
  → URL 预检（§7.1）→ DNS 解析 + 地址校验 + IP pin（§7.2/7.3）
  → HEAD（3s）→ 2xx/3xx 读 content-type/length；405/501/缺 header → GET
  → 重定向（≤5 跳，逐跳重验）
  → MIME 判定（§6.3）
      page     → GET 正文（≤512KiB）→ HTML 元数据（§6.4）→ phase meta；再 phase cover
      image    → Range 0-511 确认 → phase probe（P2 再加 crop）
      video    → Range 确认 → phase probe
      audio    → Range 确认 → phase probe
      document → Range 确认 PDF/ZIP/文本 → phase probe
      unknown  → kind=unknown + hostname 标题
```

### 6.2 请求约束

- HEAD 3s；GET 总截止 8s；socket idle 3s；跳数 5；HEAD 405/501/网络错误/缺 `content-type`
  回退 GET。
- `Accept-Encoding: identity`；UA `fde2e-report-link-preview/1.0`；不发 Cookie/
  Authorization/Referer/`X-Forwarded-*`；不保存 `Set-Cookie`。
- 页面 512 KiB；`Content-Length > 2 MiB` 直接 `blocked_size`；媒体只读前 512B（忽略 Range
  最多 64KiB）；忽略 `HTTP_PROXY` 等代理环境变量。
- 不跟随 `<meta http-equiv=refresh>`、不执行 JS/CSS、不请求页面内子资源。

### 6.3 MIME

魔数 > `Content-Type` > 扩展名；分 `page/image/video/audio/document/unknown`。魔数覆盖
PNG/JPEG/GIF/WebP/AVIF/SVG、MP4/WebM/MOV/Ogg、MP3/WAV/FLAC/M4A、PDF/ZIP、HTML。
SVG 不作为封面渲染（P2 裁剪也不接受 SVG）。文本类文档首行标题、前 400 字描述；
PDF/ZIP/Office 文件名回退标题。

### 6.4 元数据优先级

OG（title/description/site_name/image/image:width/image:height/type）→ Twitter Card →
`<title>`/meta description/canonical → `article/main` 首段（≥40 字，≤400 字）→ favicon
（`cover.kind=favicon` 小图标，不作为大图）。标题 ≤200、描述 ≤400、站点名 ≤100；HTML
实体解码后截断；封面绝对 http/https、≤2048、相对按 `<base href>`/final_url 解析；不存
HTML 原文/响应头/Cookie。

### 6.5 字符集/失败

charset：Content-Type → `<meta charset>` → UTF-8；非法序列替换；截断按字符。失败码与文案
沿用 `blocked_scheme/blocked_private/blocked_port/blocked_size/too_many_redirects/timeout/
http_error/unsupported/network/parse_error`；失败首轮 → `failed`，UI 普通链接；
重处理失败保留旧字段（§13.3）。

### 6.6 并发/限流

全局 3、每域名 1；每域名令牌桶 1 req/s（突发 2）；429/503 冷却 60s；每账号每小时最多入队
60 次、全局 500 次（入队时计）；单飞：同 `(post_id,url_hash)` 一个 job。

---

## 7. SSRF 防护（清单不变）

### 7.1 入口校验（每跳重跑）

仅 `http/https`；拒绝 userinfo、空 host、单标签 host、`.local/.internal/.home.arpa/.lan`、
含 `%`（IPv6 zone id）/控制字符的 host、超长 host。端口默认 `80/443`（可配置追加
`8080/8443`）；22/23/25/53/110/143/445/3306/5432/6379/9200/11211 永远拒绝。
IP 字面量（十进制/八进制/十六进制）先归一化为标准 IP 再分类；普通域名走 DNS。

### 7.2 地址分类（所有 A/AAAA 答案）

IPv4 拒绝：`0.0.0.0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`（含
`169.254.169.254`）、`172.16/12`、`192.0.0/24`、`192.0.2/24`、`192.168/16`、`198.18/15`、
`198.51.100/24`、`203.0.113/24`、`224/4`、`240/4`、`255.255.255.255/32`。
IPv6 拒绝：`::/128`、`::1/128`、`::ffff:0:0/96`（解内嵌 v4）、`64:ff9b::/96`（NAT64）、
`100::/64`、`2001:db8::/32`、`2001:0000::/32`、`2002::/16`（6to4）、`fc00::/7`、
`fe80::/10`、`ff00::/8`。任一答案命中 → 整个 host 拒绝；无解析 → network。

### 7.3 连接与重定向

DNS 解析后 IP pinning；`Host`/SNI 保持原主机名（IP 字面量不设 SNI，按 IP SAN 校验证书）；
不让系统二次解析。每跳重定向重跑 §7.1/7.2/7.3；拒绝 `https→http`；最多 5 跳。不执行 JS、
不发 Cookie/Authorization/Referer、不接受非 identity 编码、不跟随 meta refresh。

### 7.4 资源与隐私

页面 512KiB/声明 2MiB；媒体嗅探 64KiB；并发 3/域名 1；队列/预算见 §6.6。日志只记 host+
错误码，不记完整 URL；只存元数据/裁剪封面，不存 HTML/响应头/Cookie。设置页明示出站抓取会
暴露服务器 IP；封面客户端加载用 `no-referrer` + lazy（P2 裁剪件存本仓 media 后不再暴露）。

### 7.5 测试放行

`FDE2E_REPORT_PREVIEW_TEST_ALLOW_ORIGINS` 精确 origin 白名单；仅回环且未 `--expose` 生效；
曝光启动设置即拒绝启动；`/healthz.preview_policy` 可审计。QA 用第二个未放行回环端口测
重定向私网拒绝。

---

## 8. 事件与实时推送

### 8.1 事件类型

- `EventType` 增加 `"post.updated"`（`src/core/types.ts:72`）。
- **`NOTIFICATION_TYPES` 保持 `["post.created","thread.invited"]` 不变**（`:79`）：
  `notificationLines`（`store.ts:1832-1853`）、history（`:1892-1907`）、unread 只读通知类型，
  CLI `wait-notifications` 不受影响。
- `post.updated` 存 `events` 表，`eventLines`（`store.ts:1707`）自然按可见性推送；payload：
  ```json
  { "post_id": "...", "root_id": "...", "phase": "cover", "status": "ready",
    "previews": [ { "url": "...", "title": "...", "cover": {...}, ... } ] }
  ```
  `previews` 是该帖最新完整数组（≤3）；不带正文。
- 每个阶段一次事件；actor=post.author；不改变 feed 排序、不生成通知、不计未读。

### 8.2 客户端

- `HubTopic` 增加 `"post.updated"`；`HubDispatch` 增加对应 variant；
  `HUB_DATA_TOPICS` 增加（`src/ui/state/hub/types.ts`）。
- 新增 `PostPreviewsProvider`（`src/ui/state/post-previews.tsx`）：
  `apply(postId, previews, updatedAt)` 按 `position/url` 逐条比较 `updated_at` 合并（较新
  覆盖较旧，较旧的其它链接保留），`usePostPreviews(post)` 返回合并结果；这样 3 条链接
  并发更新不会互相回退。
- `useEventHub(["post.updated"], handler)` 把事件投给 provider；页面/feed/thread **不刷新**、
  不重取列表、不重排；`LinkPreviews` 订阅后原地更新卡片。
- `usePostPreviews(post)` SHALL 把 REST 的 `post.previews` 与事件 store 按每条
  `(position/url, updated_at)` 取较新者合并；feed 刷新返回整帖时也不回退到旧事件。
- `post.updated` 事件可能重复（阶段重做）：以 `updated_at`/`seq` 较新者为准，旧事件丢弃。
- `plugin.updated` 控制帧（hub 控制帧，无 DB 事件，P1）：`PATCH` 后广播
  `{plugin_id,enabled,version}`；客户端 `PluginsProvider` 更新并立即隐藏/恢复卡片。
  漏帧时重连/打开设置会重新 `GET /api/plugins`。

### 8.3 pending→ready 时序

- 发帖响应返回 `previews: pending`；卡片立即占位。
- worker 阶段 1（meta/probe）→ `partial` 事件，标题/描述/类型出现；
- 阶段 2（cover/crop）→ `ready` 事件，封面淡入；
- 目标：常规站点 1s 内 ready；慢站/失败按退避，卡片保持占位/普通链接。
- 记录每个帖 `pending→partial→ready` 的时间与事件数用于验收（A2）。

---

## 9. API 与数据结构

### 9.1 端点

| 方法/路径 | 权限 | 语义 |
|-----------|------|------|
| `GET /api/plugins` | 任意登录账号 | `{ok, plugins:[PluginView]}`；含 version/rulesVersion/enabled/worker 摘要 |
| `PATCH /api/plugins/:id` | owner/manager | `{enabled:boolean}` → `{ok, plugin}`；未知 id 404；广播 `plugin.updated` |
| `POST /api/previews/backfill`（P2） | owner/manager | 触发 cacheKey 不匹配扫描/入队；返回 202 + worker 摘要；不并发 |
| `GET /api/status` | 登录账号 | 增 `preview_worker`：queued/running/ready/partial/failed 计数、最近错误 |

- **不再提供 `GET /api/previews?post=`**：previews 是 `PostView` 持久化字段，读取不再触发抓取；
  实时更新走 `post.updated`。P2 的 backfill 仅运维手动。
- `PostView.previews` 在所有读接口返回（timeline/feed/profile/thread/search/bookmarks/read）；
  静态导出原样包含。
- `PluginView`：
  ```ts
  {
    id; name; description; version; rules_version; kind; capabilities;
    enabled; default_enabled;
    requires: [{id, optional, status}];
    viewer_base: string | null;
    worker?: { queued: number; running: number; ready: number; partial: number; failed: number };
    limits: { previews_per_post: 3; url_max_chars: 2048 };
  }
  ```

### 9.2 存储/导出契约

- 帖子视图从 `post_previews` 批量读取（每页 ≤20 帖 × 3）；`previews` 永远存在（可能 `[]`）；
  插件关闭不改变返回字段，只改变 UI 展示。
- 导出快照 `SnapshotPost` 直接带 `previews`（含 pending/partial/ready/failed 原样）；
  快照顶层 SHALL 带 `preview_enabled`（导出时插件开关），静态 UI 据此决定是否渲染卡片；
  导出只读 DB，**不触发 worker/入队/抓取**。
- 静态 UI：`preview_enabled !== false` 时只把 `ready/partial` 渲染为卡片；`pending/failed`
  渲染为纯链接（静态没有 worker，pending 永远不会变，不能留永久骨架）；导出时插件关闭
  （`preview_enabled=false`）则全部按纯链接渲染。
- `capabilities.features` 增 `preview_fields:true`、`preview_events:true`；
  `API_ROUTES` 增插件路由（+ P2 backfill）。
- CORS `Access-Control-Allow-Methods` 补 `PATCH`（`http.ts:40` 当前无 PATCH）。

---

## 10. UI

### 10.1 组件树

```text
App
  ConnectionProvider
    EventHubProvider
      PluginsProvider
        PostPreviewsProvider        // post.updated → 按 postId 覆盖
          HomeFeedsProvider / Bookmarks / Notifications
            AppShell
              SettingsSheetProvider / SettingsSheet
              PostCard
                Markdown
                MediaGrid
                QuoteCard
                LinkPreviews        // usePostPreviews(post)
                  LinkPreviewCard
                TagChips
```

- `LinkPreviews` 读 `usePostPreviews(post)`：优先 event store，回退 `post.previews`；
  静态模式以快照 `preview_enabled` 为准（不是 `/api/plugins`），只渲染 `ready/partial`；
  在线模式插件关闭时不渲染卡片；`failed` 始终纯链接。
- `post.updated` 只更新该帖卡片；feed/thread 列表节点、滚动位置、排序均不变。

### 10.2 卡片形态（官方 Card）

- 容器：官方 `Card size="sm"`，最多 3 张，第一条主卡。
- 封面：卡片 SHALL 始终有 **4:3 媒体区**（宽跟随卡片）；`cover` 存在时 `object-cover` 展示
  （P2 图片为插件裁剪件，P1 页面可为外链）；无 cover 时用类型图标底纹占位；`pending` 在
  同一区域显示 Skeleton。这样 pending→partial→ready 高度一致、无 CLS。
- 封面加载：外链 `https` 直接 `<img referrerPolicy="no-referrer" loading="lazy">`；本地
  `/api/media/<hash>` SHALL 走现有 `useMediaUrl` blob 通道（认证模式 `<img>` 不能带
  Authorization），静态壳按 hash 走 `staticMediaUrl` 的相对路径；加载失败回退类型图标底纹。
- P2 图片封面是插件 4:3 重心裁剪件（`/api/media/<hash>`，`cover.kind="crop"`），导出随
  `media/` 一起复制；P1 页面 cover 可为外链（静态离线省略，见 §12）。
- 文案：域名 + 单色 lucide 图标；标题 2 行（`title ?? label ?? domain`）；描述 2 行；
  「原文 ↗」小链接。
- 状态：
  - `pending`：4:3 Skeleton（域名 + 占位），预留高度防 CLS；`aria-busy`；
  - `partial`：4:3 已有封面或图标底纹 + 已有字段；后续事件淡入；
  - `ready`：4:3 封面/图标底纹 + 完整字段；
  - `failed`：紧凑链接行（域名 + 「预览不可用」），可点；
  - 插件关闭：不渲染。
- 点击主区：`<a target="_blank" rel="noopener noreferrer">`；命中 viewer 适配器则
  `preventDefault` + `adapter.open()`；否则原生新窗口；`window.open` 被拦截给 toast。
- 无嵌套 `<a>`；「原文」与主区是兄弟。
- 淡入 160ms；`prefers-reduced-motion` 关闭；目标 CLS < 0.02。
- 移动/桌面：宽度跟随帖子列；4:3 封面自然适配；390×844 与 1280×900 无横向溢出。

### 10.3 裸 URL 兜底

- `Markdown.tsx` 的 `renderText` 增加裸 `http/https` 自动链接（复用
  `core/link-extract.ts` 的 `scanBareUrls`）；插件关闭/静态/失败卡时普通链接仍可点。
- 预览卡与正文链接并存；不重复渲染卡片（卡片由 `previews` 驱动）。

### 10.4 设置

- `SettingsSheet`：插件列表、Switch、worker 状态、隐私 Alert、依赖提示；agent 只读；
  静态只读；PATCH 乐观更新 + 失败回滚。
- 打开设置时 `plugins.refresh()`；`plugin.updated` 控制帧更新其他端。

---

## 11. fileviewer 适配器

### 11.1 接口（客户端）

> 需求里的 `openViewer` 适配器＝这里 `ViewerAdapter`；服务端 provider 只管抓取/阶段。

```ts
interface ViewerAdapter {
  id: string; pluginId: string; label: string;
  canOpen(input: { kind: PreviewKind; mime: string | null }): boolean;
  buildUrl(input: { url: string; name?: string | null }): string;
  open(input: { url: string; name?: string | null }): boolean; // false=回退
}
```

- P1 `VIEWER_ADAPTERS=[]`（永远新窗口原链接）；P2 注册 `file-viewer` 适配器。
- `link-preview.manifest.requires = [{id:"file-viewer", optional:true}]`；`GET /api/plugins`
  返回 `enabled/disabled/missing`；设置页显示“未启用：将直接新窗口打开”。
- `fileviewer` URL：`<viewer_base>/?url=${encodeURIComponent(url)}&name=...&decoder=...`；
  基址来自 `/api/plugins.viewer_base`（`FDE2E_FILEVIEWER_BASE`，缺省
  `https://file-viewer.tool.fde2e.com`）；契约对齐 `viewer-url.ts:1-14`；不要用
  `URLSearchParams`（空格会变 `+`）。
- decoder：image/video/audio/pdf/markdown/json/csv/html/docx/xlsx/pptx/text；page/unknown
  不传。仅 http/https；基址必须 https（本地 http 例外）。
- 关闭/未安装 → 原链接；跨域文档 CORS 失败 → 「原文」兜底。
- 图片 4:3 裁剪件是 `/api/media/<hash>`（同源），fileviewer 可直接加载；P2 再评估是否需要
  viewer 解码器提示。

---

## 12. 静态导出

- `export` 读取 `post_previews` 并把 `previews` 放进快照（`SnapshotPost` 不再 omit），顶层写
  `preview_enabled`（当前插件开关）；导出路径只读（`export.ts:247`），不启动 worker、
  不 enqueue、不抓取。
- `StaticReportClient` 原样返回 `previews` 与 `preview_enabled`，不发任何网络请求；旧归档
  没有 `previews` 字段时默认 `[]`，没有 `preview_enabled` 时按 true 兼容（无 previews 时不显示）。
- 只读导出遇到尚未迁移的旧库（无 `post_previews` 表）：Store SHALL 视为 `previews=[]`/
  `preview_enabled=false`，SHALL NOT 因缺表失败；正常 `serve` 启动会先 migrate 建表。
- 静态 UI：`preview_enabled !== false` 且 `ready/partial` 时渲染同款卡片；`pending/failed`
  纯链接；导出时关闭插件则全部纯链接；封面裁剪件属于媒体，随 `media/` 一起导出（P2）。
  P1 的页面 `cover` 是外链，静态壳 SHALL 只渲染同源 `/api/media/` 或本归档 `media/` 的封面；
  外链封面在离线归档中省略（文字卡），避免“离线依赖外网”；P2 的裁剪/代理缓存把封面本地化
  后随归档可见。
- `test/export-static` 断言：快照含 previews、媒体含裁剪封面（P2）、静态模式 0 fetch。

---

## 13. 启停、cacheKey 与失效

### 13.1 cacheKey

```ts
cache_key = sha256(
  plugin_id + "\0" + plugin_version + "\0" + rules_version + "\0" +
  canonical_url + "\0" + sha256(body_md)
) // hex
```

- 写入时算定；存 `post_previews.cache_key` 与 `preview_jobs.cache_key`。
- 插件 id/version、rulesVersion、canonical URL、正文任一变化 → key 变；任务去重键仍是
  `(post_id,url_hash)`，key 变则原地重置 job；worker claim 时先把新 key 写到
  `post_previews.cache_key`（不动旧字段/旧 status），避免扫描重复入队。
- `rulesVersion` 覆盖元数据提取、封面规则、P2 4:3 重心裁剪参数；改裁剪算法也必须 bump。
- 已展示的旧字段不因 key 变而清空；worker 逐阶段覆盖，完成前保持旧值。

### 13.2 扫描与入队

- 触发：启动、插件启用、插件版本/rulesVersion 变化、P2 手动 backfill。
- 扫描顺序：**post created_at DESC**（新帖先处理），再 `enqueued_at`。
- 两类候选：
  1. `post_previews` 行存在但 `cache_key != currentKey`（用当前插件元数据+body hash 重算）；
  2. 帖子有链接但无 `post_previews` 行（插件关闭期间发布/从未索引）。
- 对候选：确保 `post_previews` 行存在（无则按 link 插入 pending+字段空，含 label/cache_key），
  `upsert preview_jobs` 去重；不修改已展示字段。
- 扫描分批（100）+ 250ms 间隔 + 单实例锁；不并发扫描；运行中重复触发返回同一任务。
- 手动 backfill（P2）SHALL 同时把 `preview_jobs.status='failed'` 的候选重置为 queued。
- 插件关闭：扫描/入队全部停止；已有 job 标记暂停或保留 queued 不执行；打开后继续。

### 13.3 失效语义

| 事件 | 旧帖 | 新帖 | 已展示字段 | 抓取 |
|------|------|------|------------|------|
| 关闭插件 | 卡片隐藏 | 卡片隐藏 | 保留 | 0 |
| 同版本重开 | 直接恢复 | 直接恢复 | 保留 | 0（已有 key 命中） |
| 插件版本/rules 升级 | 入队（旧值保留） | 入队 | 旧值直到新阶段覆盖 | 按需 |
| 抽取规则变化 | 重新抽 URL（新 key） | 同 | 旧值直到新阶段 | 按需 |
| 管理员清空（P2） | 全部 pending | 同 | 清空 | 按需 |

- 重处理失败：保留旧 `status/fields`（卡片不降级），job 退避重试；新帖首次失败才 failed。
- 不全局清 `post_previews`；不因版本升级回写正文；不删除旧行（GC 只删无引用/超期）。

### 13.4 清理

- 软删帖子：同事务删除 `post_previews` 与 `preview_jobs`。
- 封面裁剪件（P2）：随 media ref_count/GC；`post_previews` 的本地封面 URL 计入导出/GC。
- 无引用的旧 `post_previews` 行随帖子删除；不存在“全局 URL 缓存”表。

---

## 14. 验收

### 14.1 夹具服务（`scripts/qa/link-preview-fixture.mjs`）

`Bun.serve` 回环随机端口；路由：`/og-full`（完整 OG）、`/og-no-cover`、`/twitter`、
`/plain`、`/article`、`/img.png`、`/img-large.png`（P2 裁剪）、`/video.mp4`、`/audio.mp3`、
`/doc.pdf`、`/doc.docx`、`/unknown.bin`、`/404`、`/slow`（30s）、`/redirect-private`（302 到
第二个未放行回环端口 `/secret`）、`/redirect-metadata`、`/redirect-loop`、`/huge`（5MiB）、
`/gbk`、`/no-ct`、`/meta-refresh`、`/count`。测试放行只含夹具主 origin；重定向目标用
未放行的第二端口，确保“重定向私网拒绝”不被白名单误放行。

### 14.2 单测

- 抽取/规范化/上限；SSRF 地址矩阵（§7.2 全项、IPv4-mapped/NAT64/6to4、混合答案、
  十进制 IP、userinfo、端口、重定向、DNS pin 一次解析）。
- 抓取：HEAD→GET、重定向、timeout、超大体、charset、OG/Twitter/首段/SVG 封面拒绝。
- 存储/worker：pending→partial→ready 状态机；每阶段事件；重处理失败保留旧值；任务去重；
  最新优先（created_at desc）；重启续跑；单实例锁；cacheKey 变化重置 job。
- 事件：`post.updated` 入库、`eventLines` 可见、`notificationLines`/history/unread/CLI
  不含、客户端 topic 分发、重复事件幂等。

### 14.3 E2E

| # | 场景 | 断言 |
|---|------|------|
| A1 | 发含链接帖 | HTTP 返回 <200ms；帖子/正文立即可见；首帧 `pending` 占位（4:3 预留，无 CLS） |
| A2 | 阶段推进 | 无刷新：pending→partial→ready；记录每阶段时间/事件数；标题先于封面；卡片原地更新、feed 不重排 |
| A3 | 静态导出 | 快照含 `previews`；`file://` 打开显示同样 ready/partial 卡片；0 网络请求；pending/failed 为纯链接 |
| A4 | 插件升版本 | 旧帖+新帖都入队，按 created_at desc（新帖先处理）；旧卡片在新阶段覆盖前保持旧值 |
| A5 | 关闭/重开 | 关闭：新旧帖卡片隐藏、夹具计数不增；同版本重开：恢复、无新抓取；异版本：入队 |
| A6 | 图片 4:3（P2） | `cover` 为 `/api/media/<hash>`，w/h 符合 4:3；静态导出含该媒体 |
| A7 | SSRF | 私网/元数据/十进制 IP/映射 IPv6 全部 failed/blocked；夹具目标 0 请求 |
| A8 | 重定向私网 | failed/blocked_private；第二端口计数器 0 |
| A9 | 404/超时/超大体 | failed/http_error/timeout/blocked_size；正文首帧已可见；卡片降级普通链接 |
| A10 | 每帖 4 链接 | 仅 3 条 job/卡片；第 4 条 0 请求 |
| A11 | 点击 | 新窗口目标 URL、`window.opener=null`；fileviewer 启用时 URL 契约正确；禁用回退 |
| A12 | 通知/CLI 隔离 | `post.updated` 不进通知/未读/CLI；feed 不因事件刷新 |
| A13 | 重启续跑 | kill worker/进程后重启，未完成任务继续；不重复卡片/不丢任务 |
| A14 | 旧帖首次查看 | 插件开启后旧帖入队并出现卡片；正文未改写 |
| A15 | 事件风暴 | 3 链接 × 多阶段事件只更新对应卡片；无整页请求、无滚动跳动 |
| A16 | 390×844/1280×900 | 无横向溢出；pending/ready 高度差 ≤2px；CLS < 0.02 |

证据：每步截图 + 网络（夹具计数、`post.updated` 帧）+ 时间戳/事件数；生产板 0 写入。

### 14.4 绿门

`bun test`、`bun run check`、`bun run typecheck:ui`、
`npx openspec validate report-link-preview --strict`。

---

## 15. 分期

| 阶段 | 范围 | 验收 | 可延后 |
|------|------|------|--------|
| **P1** | `post_previews`/`preview_jobs` schema v5；写入建 pending+job；异步 worker（最新优先/多阶段/重启/锁）；`post.updated` 事件 + client topic + 原地更新；SSRF/抓取/MIME/OG；插件开关/扫描/cacheKey；导出包含 previews；卡片 pending/partial/ready/failed + 4:3 占位；设置页；裸 URL 兜底 | A1-A5、A7-A16（图片裁剪除外） | 图片 4:3 裁剪、cover 本地缓存、P2 手动 backfill |
| **P2** | 图片 `crop`/`title` 阶段：有界下载、重心 4:3 裁剪切图存 media；封面 media/导出/GC；`POST /api/previews/backfill` + 设置进度；file-viewer 适配器；封面代理评估 | A6、A11；裁剪件 4:3；静态导出含媒体；手动回填不并发 | 站点专属 provider、oEmbed |
| **P3** | YouTube/Vimeo/Bilibili/GitHub/oEmbed provider；HTML 解析器替换（接口不变）；robots 策略；封面代理；诊断页 | 站点规则逐站；解析器契约不变；robots 可配置 | AI 摘要/搜索索引 |

**可延后**：图片标题、封面代理、oEmbed、站点规则、插件市场。

---

## 16. 风险与回滚

| 风险 | 缓解 |
|------|------|
| SSRF 绕过 | §7 纯函数地址分类 + 全答案校验 + IP pin + 逐跳重验；单测矩阵 |
| `node:http(s)` 在 Bun 的 SNI/证书行为 | P1 先 spike `host=ip, servername=host`；不通过改 `tls.connect` 手写 HTTP/1.1，接口不变 |
| worker 拖慢实例 | 单实例锁、并发 3、每域名 1、批处理、200ms 轮询；SQLite 短事务 |
| 版本升级风暴 | cacheKey 扫描按时间倒序入队、后台慢慢补；不清库；预算/限流 |
| 旧卡片闪空 | enqueue 不改字段；重处理失败保留旧值；只有新帖首次失败才 failed |
| 事件重复/乱序 | `updated_at`/`seq` 幂等覆盖；每阶段同事务写字段+事件 |
| 静态导出半套 | 导出只读、无 worker/enqueue；previews/media 同批写；`test/export-static` |
| 裁剪图内存炸弹（P2） | 下载大小/像素上限、解码前校验、SVG 拒绝、单并发、超时 |
| 并行 change 冲突 | §17 顺序 rebase；加性编辑 |
| 测试放行误用 | 仅回环+非曝光；曝光启动拒绝；`/healthz.preview_policy` |

**回滚**：设置页关闭插件（立即停 worker/隐藏卡片，字段保留）；代码回滚后新表无害
（`CREATE TABLE IF NOT EXISTS`）；可保留或 `DROP TABLE post_previews/preview_jobs`；
`PostView.previews` 为新增字段，旧客户端忽略；`post.updated` 事件旧客户端不识别（hub 数据
topic 过滤），不影响通知。

---

## 17. 与并行 change 的合并顺序与冲突点

建议顺序：`report-notification-history-and-reply-submit`（已完成）→ `report-event-hub`
（已落地）→ `report-thread-timeline`（PostCard 结构）→ 本 change。

- **event-hub（必须先合）**：`post.updated` 依赖 `eventLines`/hub topic；本 change 只做
  `EventType` 加一项、`NOTIFICATION_TYPES` 不动、`HubTopic`/`HubDispatch`/`HUB_DATA_TOPICS`
  加一项。`plugin.updated` 是控制帧，改 `hub.ts` 的 `broadcast*` 与客户端控制帧处理。
- **thread-timeline**：`PostCard` 两个分支的 `QuoteCard` 后插 `<LinkPreviews>`；不动
  平铺/导轨/ChainPosition。
- **notification-history**：已完成；本 change 不碰通知读路径；`post.updated` 必须保持
  `NOTIFICATION_TYPES` 之外。
- 冲突面：`types.ts`、`store.ts`（`hydratePosts`/`softDelete`/`eventLines` 类型）、
  `http.ts`（路由/status）、`db.ts`（新表/版本号）、`App.tsx`（Provider 树）、
  `PostCard.tsx`、`api.ts`/`static-api.ts`、`export.ts`、`hub` 客户端 types。
- 所有编辑加性；`softDelete` 的 `post_previews`/`preview_jobs` 删除放在 event-hub 的同一
  事务里；`App.tsx` 在 `EventHubProvider` 内加 `PluginsProvider`/`PostPreviewsProvider`。

---

## 18. 决策记录

| # | 决策 | 理由 | 被否 |
|---|------|------|------|
| D1 | 持久化 `PostView.previews` | 静态导出/刷新/重启一致 | 读时派生 |
| D2 | `post_previews` 表 | 逐链接多阶段更新/查询/导出 | `posts.previews_json` |
| D3 | 写入仅 pending+job | 发帖立即返回 | 同步抓取 |
| D4 | 最新优先持久化 worker | 新帖先 ready，旧帖后台补 | FIFO/内存 |
| D5 | 每阶段字段+事件 | 1s 内可见、逐步完善 | 全部阶段后写一次 |
| D6 | `post.updated` 非通知 | CLI/未读零影响 | 复用通知 |
| D7 | cacheKey 五元组 | 精确失效/去重 | 只 URL |
| D8 | 版本不匹配倒序入队 | 无风暴、旧值保留 | 清库 |
| D9 | 关闭隐藏、字段保留 | 开关可逆 | 删除字段 |
| D10 | 静态导出含 previews | 离线可读 | 剥离/抓取 |
| D11 | 4:3 裁剪 P2、字段先留 | Owner 指定、模型先行 | 展示原图 |
| D12 | 事件原地更新 | 不整页刷新、不重排 | 每次刷新 feed |
| D13 | fileviewer 适配器 | 零硬绑定 | 硬编码 URL |
| D14 | 静态只渲染 ready/partial | 无 worker，pending 永不完成 | 静态骨架 |
| D15 | 重处理失败保留旧值 | 不让旧卡片降级 | 一律 failed |

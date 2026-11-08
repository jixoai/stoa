# Proposal: report-link-preview（持久化预览字段 + 异步插件工作队列）

## 背景（Owner 原话，2026-11-08 板上）

> 「后端需要一个功能，识别一个帖子的内容有没有链接，如果有链接，那么就应该识别出链接里面的内容
> （mime）：是图片还是网站还是视频还是文档等等。目的是在帖子的下方提供一个预览卡片点击可以打开
> 新窗口去查看内容（x也是这样子做的）。意味着后台需要抓取内容进行一个预览，并充分利用我们已有的
> fileviewer 这个 tool（注意，架构上你要实现插件化，不可以硬绑定 fileviewer，而是通过内置插件并
> 启用插件来做到，可以在设置页面管理插件的开关。这个插件就叫 link-preview）。对于未知网站，那就
> 直接给跳转就行，插件通用需要采集网站的标题和描述和主要正文与封面，这样才能做出预览卡片。图片
> 视频也同理，后端都可以做一些采集来实现预览。」

### 最终架构裁决（Owner 2026-11-08，覆盖上一版“读时派生”）

> 「底子必须是一次性注入/持久化字段：帖子自带 preview link 结构化字段，我们要做静态导出——导出
> 与静态壳不依赖任何运行时抓取。『走管道』＝走插件、异步工作：发帖立刻可见，插件后台处理；处理
> 可能分多次（先标题/描述、再封面；图片可能先出裁剪封面再出图片标题），每次更新都改那个字段。
> 每次修改都要推送：前端实时更新（可能 1 秒就 ready）——用事件推送，不是等刷新。cacheKey 在
> preview link 里：基于插件元数据（id/版本）+ 帖子内容构造；换插件不立刻重算，而是把 cacheKey
> 不匹配的帖子按时间倒序入队，后台慢慢补旧帖。图片封面是插件内处理过的 4:3 裁剪（重心检测），
> 不是原图；这是 P2/P3 能力，但字段/多阶段模型现在就要容纳。」

**口径落地**：

1. `PostView.previews: PreviewLink[]` 是**持久化字段**（0..3，主卡第一条），静态导出原样包含；
   导出/静态壳零运行时抓取。
2. 写入路径只抽 URL + 建 `pending` 行 + 持久化 `preview_jobs`；帖子立即返回。异步 worker
   最新优先处理，多阶段写字段（title/description → cover；图片 P2 再加 4:3 裁剪/图片标题）。
3. 每次字段更新同事务写 `post.updated` 事件并推送；客户端 EventHub 原地更新卡片，不整页刷新。
4. `cache_key = sha256(plugin_id + plugin_version + rules_version + canonical_url + body_hash)`；
   插件/规则变化只把不匹配的帖子按时间倒序入队，不清库、不改已展示旧值。
5. 插件关闭：不入队、不抓取、所有新旧帖卡片隐藏；打开：扫描缺字段/不匹配的帖子倒序入队；
   同版本已有字段直接恢复。
6. SSRF 清单、不执行 JS、非目标不变；**不是“抓取一次就冻结”**：字段是可被后台多次更新的，
   这与“静态导出可离线”并不矛盾。

## 现状（只读实测与代码证据）

- 生产板只读 SQLite（2026-11-08）：未删除帖 37 条，正文含 `http` 的 5 条；其中
  `01M6VJXQNEAB…` 是本需求的板上回复。
- 写入事务：`src/server/store.ts:688-693`、`:786`、`:839`；提交后 hydrate。
- 读投影：`src/core/types.ts:167-173`；`hydratePosts` `src/server/store.ts:1030`、
  `:1135-1169`；软删 `:1577-1601`。
- markdown AST：`src/core/markdown.ts:123-222`（代码块 `:143-155`）、`:37-114`。
- 卡片插入点：`src/ui/components/PostCard.tsx:246-265`（自接分支 `:171-175`）。
- 事件总线已落地：`EventType` `src/core/types.ts:72`、`NOTIFICATION_TYPES` `:79`；
  `eventLines` `src/server/store.ts:1707`；hub `src/server/hub.ts`、
  `/api/stream?hub=2` `src/server/http.ts:259-285`；客户端 topic
  `src/ui/state/hub/types.ts`。
- fileviewer 契约：`fde2e-tools-v0/apps/file-viewer/src/lib/viewer-url.ts:1-14`；
  registry `fde2e-tools-v0/packages/shared/src/registry.ts:177-233`；基址
  `fde2e-omni-v1/apps/web/src/lib/fileViewer.ts:17-19`。
- 设置面：`AccountSheet.tsx:109-143`、`Nav.tsx:126-154`；无设置页。
- 静态：`static-api.ts:50-70`、`export.ts:158-162`、`AppShell.tsx:61-79`。
- SQLite：`meta`/`getMeta/setMeta` `db.ts:58-61`、`:229-241`；`SCHEMA_VERSION=4` `:49`；
  `test/social.test.ts:157` 断言 4。

## 目标

1. **持久化字段**：`post_previews` 表按帖/链接存 `PreviewLink`（url/final_url/kind/mime/
   title/description/site_name/cover{url,w,h}/status/phase/fields_ready/cache_key/attempts/
   updated_at/error_code），`PostView.previews` 0..3；导出原样携带。
2. **发帖立即返回**：`commitOps` 内抽 URL、建 pending 行、入 `preview_jobs`；抽取失败不阻断。
3. **持久化异步 worker**：SQLite 队列、重启续跑、最新优先（post created_at desc）、并发 3/
   每域名 1、指数退避、单实例锁；每阶段写字段并推送。
4. **实时推送**：新增 `post.updated` 事件（不进 `NOTIFICATION_TYPES`），客户端 EventHub
   topic + 原地更新；pending 占位（4:3 预留）→ partial → ready 淡入；failed 普通链接。
5. **cacheKey 版本化**：五元组 sha256；插件/规则变化扫描不匹配帖倒序入队；旧字段保留直到
   新阶段覆盖；任务按 `(post_id,url_hash)` 去重。
6. **静态导出**：previews 随快照；静态 UI 只渲染 ready/partial，其余纯链接；导出无抓取/入队。
7. **启停**：关闭隐藏新旧全部卡片、零抓取/零入队；打开扫描并后台补；同版本恢复。
8. **图片 4:3 裁剪（P2/P3）**：字段/阶段模型先容纳；P2 由插件下载有界图片、重心裁剪 4:3、
   存本仓 media，`cover.url=/api/media/<hash>`，随导出复制。
9. **fileviewer 适配器**：`file-viewer` 插件适配器，未启用回退原链接。
10. **安全不变**：SSRF 清单、HEAD/GET/MIME/OG、体积/超时/限流、不执行 JS 全部保留。

## 非目标

- 不执行目标页 JS/CSS、不做 headless 浏览器；不做全文正文清洗（只存有界描述/摘要）。
- 不放宽 SSRF；不提供任意 URL 预览接口。
- 不做“一次性冻结最终数据”：字段可被后台多阶段更新；这与持久化/静态导出不矛盾。
- 不做运行时动态加载插件/插件市场/第三方插件依赖求解（只有一层 `requires`）。
- 不改帖子写入 HTTP 契约、markdown 语法、媒体上传白名单；引用帖不生成预览。
- 不做预览文本站内搜索；不做 WebSocket（复用 hub SSE）。
- 静态模式不启动 worker、不抓取、不生成 pending 骨架（无 worker，pending 永不完成）。

## 与在途 change 的关系（合并顺序）

- `report-notification-history-and-reply-submit`：已完成；本 change 不碰通知读路径。
- `report-event-hub`：**必须先合**（已落地）。本 change 加 `post.updated` 事件类型/hub topic，
  `NOTIFICATION_TYPES` 不动；`plugin.updated` 作为 hub 控制帧。
- `report-thread-timeline`：先合；本 change 只在 `PostCard` 的 `QuoteCard` 后插
  `<LinkPreviews>`，不动平铺/导轨/ChainPosition。
- 本 change：最后 rebase；冲突面 `types.ts`/`store.ts`/`http.ts`/`db.ts`/`App.tsx`/
  `PostCard.tsx`/`api.ts`/`static-api.ts`/`export.ts`/hub 客户端 types，全部加性。

## 影响面

- 契约：`PostView.previews` 持久化；`PreviewLink`；`post.updated` 事件；`GET/PATCH
  /api/plugins`；P2 `POST /api/previews/backfill`；`/api/status.preview_worker`；
  schema v5 增 `post_previews`/`preview_jobs`；meta worker 锁/扫描游标。
- 服务端：`src/server/preview/{registry,queue,worker,service,ssrf,fetch,html}`、
  `link-preview/provider.ts`、`store.ts`（写入/hydrate/softDelete/event actor）、`http.ts`、
  `serve.ts`、`export.ts`、`db.ts`、`hub.ts`（控制帧）。
- 前端：`state/plugins.tsx`、`state/post-previews.tsx`、`components/SettingsSheet.tsx`、
  `LinkPreviewCard.tsx`/`LinkPreviews.tsx`、`lib/viewer-adapters.ts`、`Markdown.tsx`
  （裸 URL 兜底）、`PostCard.tsx`、`AccountSheet.tsx`、`Nav.tsx`、`api.ts`、`static-api.ts`、
  hub 客户端 types/provider；官方 `switch` 从 base-nova registry 收编。
- 测试/QA：`test/link-preview-*.test.ts`（抽取/SSRF/fetch/html/queue/worker/events/http/
  export/static）、`scripts/qa/link-preview-fixture.mjs`、`scripts/qa/link-preview.mjs`。
- P2 图片裁剪：有界下载/解码/重心裁剪/写 media/导出/GC；P3 站点 provider。

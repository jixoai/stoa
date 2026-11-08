# Tasks: report-link-preview（持久化字段 + 异步插件工作队列）

> 依赖顺序（硬）：先 `report-notification-history-and-reply-submit`（已完成）与
> `report-event-hub`（已落地），再合 `report-thread-timeline`（PostCard 结构）后 rebase 本
> change。`src/` 在依赖合入前不改；本 change 当前只交付设计 + 规格。每项判据不满足不得勾选。

## P1. 持久化模型与写入路径

- [x] P1-1. `src/core/plugins/types.ts` + `builtin.ts`：`PluginManifest`（id/version/
  rulesVersion/kind/capabilities/requires/defaultEnabled）、`PreviewLink`、`PreviewPhase`、
  `PhaseResult`、`PreviewProvider`（extractUrls/buildCacheKey/phases/resolvePhase）；
  `BUILTIN_PLUGINS=[LINK_PREVIEW]`；显式 import，禁止 `readdir`/`import(url)`。
  - 判据：`rg "import\\(|readdir|fetch\\(" src/core/plugins` 0 命中；manifest 单测字段完整；
    `link-preview.requires` 含 `{id:"file-viewer",optional:true}`；phases 对 page/image/
    video/document 的返回值固定。
- [x] P1-2. `src/server/db.ts`：`SCHEMA_VERSION=5`；新增 `post_previews`、`preview_jobs`
  两表与索引（design §3.1/3.2 逐字）；meta worker 锁/扫描键；不 ALTER 旧表。
  - 判据：旧 dataDir 启动自动建表；重复 migrate 幂等；`test/social.test.ts` 的
    `schema_version` 断言同步 4→5；`PRAGMA table_info` 与 design 一致。
- [x] P1-3. `src/core/link-extract.ts`：导出 `EXTRACT_VERSION`；基于 `parseMarkdown` 抽
  `http/https` URL（跳过代码块/行内 code/图片；接受 markdown link + 裸 URL）；规范化
  （scheme/host 小写、去 fragment/默认端口/utm_* 等、保留 query 原序）；去重、每帖上限 3、
  URL>2048 丢弃、label≤200。
  - 判据：`test/link-extract.test.ts` 覆盖规则表；代码块/图片 0 命中；同 URL utm/fragment
    只留一条；第 4 条丢弃；抽取 <5ms（200k 正文基准）；规则变更必须 bump `EXTRACT_VERSION`。
- [x] P1-4. `src/server/store.ts` `commitOps`：插件启用时抽 URL、算 `bodyHash` 与
  `cache_key`，同事务 upsert `post_previews(status=pending,phase=queued,fields_ready=[])`
  与 `preview_jobs(status=queued,next_run_at=now,post_created_at)`；帖子立即返回；抽取失败
  只记日志不阻断；`hydratePosts` 批量读 `post_previews` 产出 `PostView.previews`；`softDelete`
  同事务删 `post_previews`/`preview_jobs`。
  - 判据：发帖响应 <200ms（无网络）；首帧 `previews[0].status=pending`；无链接帖 `previews=[]`；
    抽取病理输入仍提交；删除后两表 0 行；20 帖 hydrate 批量 SQL 计数断言。
- [x] P1-5. `src/server/preview/queue.ts`：`enqueue(postId, urlHash, cacheKey, postCreatedAt)`/
  `claimNext(limit)`/`complete`/`fail`；按 `(post_id,url_hash)` 去重；cacheKey 变化原地重置
  job 并清 attempts/next_run_at；claim 按 `post_created_at DESC, enqueued_at ASC`。
  - 判据：同帖同 URL 重复 enqueue 只 1 行；新帖先被 claim；cacheKey 变化重置；claim 原子
    （事务/条件更新）；并发 claim 不重复。
- [x] P1-6. `src/server/preview/worker.ts`：单实例锁（meta `preview.worker.lock`，心跳/
  陈旧接管/退出清除）；全局并发 3、每域名 1；多阶段推进（每阶段事务写字段+插
  `post.updated` 事件）；状态 pending→partial→ready/failed；重启把 `running` 重置 queued；
  失败 5m→15m→1h→6h→24h 退避；禁用/退出 abort。
  - 判据：`test/link-preview-worker.test.ts` 覆盖阶段顺序、每阶段一条事件、重启续跑、
    单实例、最新优先、失败退避、重处理失败保留旧值、cacheKey 变化中断重排。
- [x] P1-7. `post.updated` 事件：`EventType` 增加（`types.ts:72`），`NOTIFICATION_TYPES`
  保持 `post.created/thread.invited`（`:79`）；worker 写字段同事务
  `insertEvent("post.updated", post.author, post_id, root_id, payload={post_id,previews,...})`；
  `eventLines` 自然推送；通知/history/unread/CLI 过滤不含。
  - 判据：`test/event-hub.test.ts`/`test/notifications.test.ts` 断言 `post.updated` 可见于
    hub、不可见于 peek/history/未读/CLI；payload 含最新 previews；通知类型集合未变。
- [x] P1-8. `src/server/preview/ssrf.ts`：design §7 的 URL/地址分类/DNS pin/端口策略。
  - 判据：`test/link-preview-ssrf.test.ts` 地址矩阵全拒绝（含 IPv4-mapped/NAT64/6to4、
    十进制 IP、userinfo、端口、混合答案、重定向私网、DNS pin 一次解析）。
- [x] P1-9. `src/server/preview/fetch.ts`：HEAD→GET/Range/逐跳重定向/超时/体积/UA/无敏感头/
    identity 编码/忽略代理。
  - 判据：`test/link-preview-fetch.test.ts` 覆盖 HEAD 405→GET、302 链、302 私网拒绝、6 跳、
    超时、超大体、慢流中止；请求头断言。
- [x] P1-10. `src/server/preview/html.ts`：OG→Twitter→title/meta→首段→favicon；charset；
    文本上限；SVG 封面拒绝；`og:image:width/height`。
  - 判据：`test/link-preview-html.test.ts` 覆盖 OG 完整/缺封面/Twitter/仅 title/GBK/无 CT/
    首段/SVG 拒绝/超长截断；512KiB <20ms。
- [x] P1-11. `src/server/preview/service.ts`：cacheKey 扫描（plugin/rules 变化、启动、启用）；
  对 `post_previews` 重算当前 key，不匹配或缺行 → 倒序 enqueue；旧字段不动；`abortAll`；
  worker stats。
  - 判据：`test/link-preview-invalidate.test.ts` 覆盖版本升级倒序入队、旧值保持、同版本
    0 入队、任务去重、插件关闭 0 入队/0 抓取。

## P1. 抓取、API 与导出

- [x] P1-12. HTTP：`GET /api/plugins`（所有登录账号，含 version/rulesVersion/worker）、
  `PATCH /api/plugins/:id`（owner/manager，广播 `plugin.updated` 控制帧）、
  `/api/status.preview_worker`；`API_ROUTES` 增路由；CORS `Allow-Methods` 补 `PATCH`；
  `capabilities.features` 增 `preview_fields/preview_events`。
  - 判据：`scripts/check.mjs` 路由 lint；`test/link-preview-http.test.ts` 覆盖 401/403/404/
    幂等 PATCH/agent 只读/跨域 PATCH/worker 摘要；无任意 URL 预览端点。
- [x] P1-13. `src/server/export.ts` + `static-api.ts`：快照原样包含 `previews`（含
  pending/partial/ready/failed）与顶层 `preview_enabled`；导出只读、不启动 worker/不入队/
  不抓取；静态客户端透传 previews/enabled，旧归档缺字段默认 `[]`/true。
  - 判据：`test/export-static.test.ts` 断言快照 previews 完整、`preview_enabled` 正确、
    导出期间 0 网络/0 job；静态模式 0 fetch；只读导出碰到无 `post_previews` 的旧库不失败
    （previews=[]）。
- [ ] P1-14. `src/ui/lib/api.ts`：`PreviewLink`/`PluginView` 类型与 `plugins()`/`setPlugin()`/
  `status()`；`static-api.ts` 对应 override（静态无 plugin API，previews 透传）。
  - 判据：`bun run typecheck:ui`；静态模式 0 网络（fetch mock）。
- [ ] P1-15. `src/ui/state/plugins.tsx`：`PluginsProvider` 在 ready 后拉 `/api/plugins`；
  暴露 `enabled(id)/refresh/setEnabled`；PATCH 乐观更新+回滚；监听 `plugin.updated` 控制帧；
  静态模式不做请求，`LinkPreviews` 以快照 `preview_enabled` 为准而非 `enabled`。
  - 判据：单测 ready/断线/静态/回滚/控制帧；切后端重建；关闭后卡片隐藏；静态 ready/partial
    仍显示。
- [ ] P1-16. 客户端事件：`src/ui/state/hub/types.ts` 增 `post.updated` topic/variant/
  `HUB_DATA_TOPICS`；新增 `src/ui/state/post-previews.tsx`（`apply(postId,previews,
  updatedAt)` 幂等覆盖 + `usePostPreviews(post)`）；EventHub handler 投递；重复/乱序事件
  按 `updated_at` 丢弃旧值。
  - 判据：单测 topic 分发、同帖多阶段覆盖、重复事件幂等、旧事件不覆盖新值；feed/thread
    不触发列表重取（fetch mock 计数）。

## P1. UI 与设置

- [ ] P1-17. 官方 `carousel` + `Card` 收编（base-nova registry；`embla-carousel-react` 为
  registry 声明依赖）：`LinkPreviews.tsx` 用官方 `Carousel/CarouselContent/CarouselItem/
  CarouselPrevious/CarouselNext` 承载 0..3 张 `LinkPreviewCard`（**一页一张、平权、无主卡**，
  顺序＝正文出现顺序）；`pending` 固定 4:3 占位（域名+Skeleton，预留高度）、`partial` 已有
  字段+封面占位、`ready` 完整卡淡入、`failed` 紧凑链接；封面 `aspect-[4/3] object-cover`，
  `cover` 缺失时文字卡；`data-testid`/`data-preview-status`/`data-preview-phase`；本地
  `/api/media/<hash>` 封面走 `useMediaUrl` blob、静态走 `staticMediaUrl`，外链 `no-referrer`+
  lazy，onError 回退图标；点击新窗口 `noopener noreferrer`；`prefers-reduced-motion` 无动画；
  单条退化单卡（无箭头/无指示点）；`post.updated` 按 canonicalUrl 保持当前页不重置。
  - 判据：Playwright 断言 3 链接 = 3 页；拖拽/箭头/指示点/←→ 键盘切换；阶段更新不跳页；
    pending→ready 高度差 ≤2px；点击新页 `window.opener=null`；failed 仍可点；390/1280
    无溢出；CLS<0.02；reduced-motion 瞬切。
- [ ] P1-18. `PostCard.tsx` 两个分支在 `QuoteCard` 后、`TagChips` 前插 `<LinkPreviews>`；
  仅插件启用（且非静态失败态）渲染；事件更新不重排列表、不重置轮播页。
  - 判据：feed/线程/搜索/收藏/成员页五处出现；多阶段事件只改对应 slide；滚动位置不变。
- [ ] P1-19. 官方 `switch` 收编（base-nova registry）＋ `SettingsSheet`：插件开关、版本/
  rulesVersion、worker 状态、隐私 Alert、依赖提示、agent 只读、静态只读、错误重试；
  `SettingsSheetProvider` 在 AppShell 单实例；Nav/AccountSheet 入口。
  - 判据：两入口同实例；owner/manager 可切、agent 403/disabled；静态不发 `/api/plugins`；
    组件来源可对表 registry。
- [ ] P1-20. `Markdown.tsx` 裸 URL 自动链接（复用 `scanBareUrls`，仅 http/https，尾标点
  裁剪）；插件关闭/静态/失败卡仍可点。
  - 判据：裸 URL 变链接、代码块不变、括号 URL 不误伤；`rg` 无第二份正则。

## P1. 验收

- [x] P1-21. 单测/集成：`bun test`、`bun run check`、`bun run typecheck:ui`；新增
  `test/link-preview-{extract,ssrf,fetch,html,queue,worker,event,http,export}.test.ts` 全绿。
  - 判据：strict 无 `any`；无 console error；`post.updated` 不影响通知/CLI/未读。
- [ ] P1-22. 夹具/E2E `scripts/qa/link-preview-fixture.mjs` + `scripts/qa/link-preview.mjs`
  （隔离 `qa-serve` + playwright-core）覆盖 design §14.3 A1–A16（A6 P2）：
  - 判据：发帖 <200ms + pending；pending→partial→ready 时间/事件数；静态导出含 previews 且
    0 请求；升版本倒序入队且旧值保持；关闭/重开；SSRF/重定向/404/超时/超大体；4 链接取 3；
    点击/fileviewer 回退；通知隔离；重启续跑；旧帖首次；事件风暴；两视口 CLS。
    失败截图+响应状态留档；结束 kill 夹具与 qa-serve 并列 PID；生产板 13689 0 写入。

## P2. 图片裁剪、查看器与运维

- [ ] P2-1. 图片 `crop` 阶段：有界下载（≤5MiB/像素/超时）、拒绝 SVG/解码炸弹、重心检测
  4:3 裁剪、`saveMedia` 内容寻址、写 `cover={url:"/api/media/<hash>",w,h}`；`title` 阶段可选
  图片标题；`post.updated` 照阶段推送。
  - 判据：A6；cover 4:3；静态导出含裁剪媒体；失败 `crop_failed` 保留 probe 字段；下载不
    绕过 SSRF/体积限制。
- [ ] P2-2. `file-viewer` 插件适配器：`canOpen/buildUrl/open`；viewer_base 来自 `/api/plugins`
  （env 覆盖，https/本地 http）；URL 用 `encodeURIComponent`；未启用/未安装回退原链接；
  设置页依赖状态。
  - 判据：A11；图片/视频/PDF 进 viewer URL 正确；禁用回退；跨域失败「原文」可用。
- [ ] P2-3. 手动回填/运维：`POST /api/previews/backfill`（owner/manager，202，运行中同任务）；
  设置页「重建预览队列」+ worker 进度/计数；不并发扫描。
  - 判据：旧帖入队补齐；重复触发同任务；agent 403；静态无按钮。
- [ ] P2-4. 清理/导出：软删清理 `post_previews`/`preview_jobs`；裁剪媒体随 media GC/
  ref_count；导出 media 集合包含 cover；无引用行清理。
  - 判据：删除帖后 0 行、媒体可回收；导出 cover 可离线加载；GC 不误删在用封面。
- [ ] P2-5. 封面策略：仅 https（本地 http 例外）/拒绝 SVG；可选受限代理缓存（复用 SSRF/
  体积/配额）；robots 策略评估（P3）。
  - 判据：https 壳不加载 http 封面；代理不能访问私网；配额满不阻断卡片。

- [ ] P2-6. **claim-time 预算（防滥用 follow-up，本轮不阻塞）**：延迟任务被 claim 时再扣
  一次当前窗口预算；不足则继续顺延到下一窗口（把「下一窗口批量放行」改为逐窗限流）。
  与 R3 的「入队即写行+job」并存，不改数据模型；覆盖延迟任务连续跨窗口不足的回归。
  - 判据：60 个名额用尽后 claim 返回 0 且任务保留；下窗口按预算逐步放行；无永久饥饿。


## P3. 站点规则与收口

- [ ] P3-1. 站点专属 provider（YouTube/Vimeo/Bilibili/GitHub/oEmbed），按 host 精确匹配，
  未命中回通用；每 provider 独立阶段/超时/失败降级。
- [ ] P3-2. 若自写 HTML 扫描器准确率不足，替换 `node-html-parser`（MIT），保持
  `parseHtmlMeta` 接口/字段/事件契约不变。
- [ ] P3-3. 规格/文档/归档：回填实测数字（发帖返回、pending→ready P50/P95、事件数、
  静态导出大小、worker 吞吐），更新 `report-link-preview`/`report-surface`/
  `report-static-mode`/`report-protocol`，`npx openspec validate report-link-preview --strict`，
  归档 change。

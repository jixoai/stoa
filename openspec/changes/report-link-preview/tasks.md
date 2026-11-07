# Tasks: report-link-preview（插件化帖子链接预览）

> 依赖顺序（硬）：**先合 `report-notification-history-and-reply-submit`**，再合
> `report-thread-timeline`（PostCard 结构）与 `report-event-hub`（softDelete 事件/App Provider
> 树）之后 rebase 本 change 的实现。`src/` 在依赖合入前不改；本 change 当前只交付设计 + 规格。
> 每项判据不满足不得勾选。

## P1. 插件骨架与链接索引

- [ ] P1-1. `src/core/plugins/types.ts` + `src/core/plugins/builtin.ts`：`PluginManifest`
  （`id/name/description/version/kind/capabilities/requires/defaultEnabled`）与
  `BUILTIN_PLUGINS = [LINK_PREVIEW_PLUGIN]`；显式静态 import，禁止 `readdir`/`import(url)`。
  - 判据：`rg "import\\(|readdir|fetch\\(" src/core/plugins` 0 命中；manifest 单测字段完整；
    `link-preview` 的 `requires` 含 `{id:"file-viewer", optional:true}`。
- [ ] P1-2. `src/server/db.ts`：`SCHEMA_VERSION = 5`；新增 `post_links`、`link_previews`
  两表与索引（design §6.1 的 SQL 逐字）；不 ALTER 旧表。
  - 判据：旧 dataDir 启动自动建表；`bun test test/store.test.ts` 全绿；重复 migrate 幂等；
    `test/social.test.ts` 的 `schema_version` 断言同步 4→5；`PRAGMA table_info` 字段与
    design 一致。
- [ ] P1-3. `src/core/link-extract.ts`：基于 `parseMarkdown` 的 URL 抽取（跳过代码块、行内
  code、图片；接受 markdown link href 与纯文本裸 URL；保留 anchor label）；规范化
  （scheme/host 小写、去 fragment、去 utm_*/fbclid/gclid、去默认端口、保留其它 query 原序）；
  去重、每帖上限 3、URL >2048 字符忽略、label ≤200 字符。
  - 判据：`test/link-extract.test.ts` 覆盖 12 条规则表（design §3.2）；同一 URL 不同
    utm/fragment 只留一条；代码块/行内 code/图片链接 0 命中；`MAX_BODY_CHARS=200000`
    正文抽取 <5ms（基准记录）。
- [ ] P1-4. `src/server/store.ts`：`commitOps` 的 post/reply 分支在同一事务内写
  `post_links`（仅插件启用时）；`hydratePosts` 批量左连接 `link_previews` 产出
  `PostView.previews`（未命中合成 `pending`，仅链接帖才有该字段）；`softDelete` 同事务
  `DELETE FROM post_links WHERE post_id = ?`。
  - 判据：`test/store.test.ts`/`test/social.test.ts` 全绿；帖子删除后 `post_links` 0 行；
    无链接帖的 JSON 不含 `previews` 键；`hydratePosts` 对 20 帖只发 2 条批量 SQL（计数断言）。
- [ ] P1-5. 插件开关：`Store.pluginEnabled(id)`/`setPluginEnabled(id, enabled, actor)` 读写
  meta（`plugins.<id>.enabled/updated_at/updated_by`，缺省取 manifest `defaultEnabled`）；
  禁用时 `commitOps` 不抽 URL、`hydratePosts` 不返回 previews；启用时后台
  `backfillPostLinks()` 为缺行的历史帖补索引（不抓网）。
  - 判据：`test/store.test.ts` 覆盖默认值/开关/重启用回填；禁用后新帖 `post_links` 0 行，
    启用后回填补齐；开关值重启后保持。
- [ ] P1-6. `src/server/preview/ssrf.ts`：纯策略模块（`assertFetchableUrl`、
  `classifyAddress`、`resolveAndPin`、`PortPolicy`），design §5 的 CIDR 表逐条实现。
  - 判据：`test/link-preview-ssrf.test.ts` 地址矩阵（design §10.2）全拒绝；公网地址放行；
    URL 解析失败/非 http(s)/带 userinfo/超长 host 均拒绝；策略函数无网络副作用（注入 resolver）。
- [ ] P1-7. `src/server/preview/fetch.ts`：`PreviewTransport` 接口 + 默认实现
  （`node:http`/`node:https`，DNS 解析后 IP pinning，`Host`/SNI 保真，忽略代理环境变量）；
  HEAD→GET 回退、`Range: bytes=0-511` 嗅探、逐跳重定向（≤5）、8s 总超时、512KiB 正文上限、
  `Accept-Encoding: identity`、固定 UA、无 Cookie/Referer/Authorization。
  - 判据：注入 fake transport 的单测覆盖 HEAD 405→GET、302→302→200、302→私网拒绝、
    6 次重定向拒绝、超时、超大体、慢速流中止；请求头断言无敏感头；DNS 只解析一次并连接该 IP。
- [ ] P1-8. `src/server/preview/html.ts`：有界 HTML 元数据扫描（≤512KiB，剥 script/style）：
  OG → Twitter Card → `<title>`/meta description → 正文首段（`article/main` 内首个 ≥40 字
  `<p>`，≤400 字）→ favicon；`og:image:width/height` 可选；charset 从 header → meta → UTF-8。
  - 判据：`test/link-preview-html.test.ts` 覆盖 OG 完整/缺封面/Twitter 回退/仅 title/GBK/
    无 content-type/SVG 封面拒绝/超长文本截断；解析 512KiB 输入 <20ms（基准记录）。
- [ ] P1-9. `src/server/preview/service.ts`：`enqueuePost(postId)`/`warm(postId)`/
  `resolve(urlHash)`；单飞去重、全局并发 3、每域名并发 1、队列上限 200、每账号每小时 60 次
  抓取预算、全局每小时 500；成功 TTL 24h、失败 5m→15m→1h→6h→24h 退避；过期
  stale-while-revalidate（先返旧值再后台刷新）；禁用时 `abortAll()`。
  - 判据：`test/link-preview-service.test.ts` 覆盖并发上限、单飞、退避序列、过期刷新不阻塞
    读取、禁用中断在飞任务、预算耗尽返回 pending；无未捕获 Promise rejection。
- [ ] P1-10. HTTP 契约：`GET /api/plugins`（全部登录账号）、`PATCH /api/plugins/:id`
  （owner/manager，`{enabled:boolean}`）、`GET /api/previews?post=<id>`（可见性校验，未知/
  不可见 404，不提供 url 参数）；`API_ROUTES` 增三条；CORS
  `Access-Control-Allow-Methods` 补 `PATCH`；`capabilities.features` 增
  `plugins:true, link_preview:true`；`/api/status` 增 `plugins:[{id,enabled}]`。
  - 判据：`scripts/check.mjs` 路由 lint 通过；`test/link-preview-http.test.ts` 覆盖
    401/403/404/幂等 PATCH/插件禁用 `{enabled:false,previews:[]}`；agent 只能读不能改；
    跨域预检允许 PATCH（`Access-Control-Allow-Methods` 含 PATCH）；对无索引的历史帖，
    `GET /api/previews?post=` 先补写 `post_links` 再返回 pending。
- [ ] P1-11. `src/server/export.ts`：快照映射显式剥离 `previews`（`SnapshotPost` 的
  `Omit<PostView, "media" | "quoted" | "previews">`）；`StaticReportClient` 不返回预览、
  `/api/plugins`/`/api/previews` 抛 `READ_ONLY` 或返回 disabled。
  - 判据：`test/export-static.test.ts` 断言快照 JSON 无 `previews` 键；静态壳不出现
    `[data-testid="link-preview-card"]`。

## P1. 前端卡片与设置

- [ ] P1-12. `src/ui/lib/api.ts`：`LinkPreview`/`PluginView` 类型、`plugins()`/`setPlugin()`/
  `previews(postId)` 方法；`static-api.ts` 对应 override（静态模式返回禁用态）。
  - 判据：`bun run typecheck:ui` 通过；静态模式这三条方法 0 网络请求（fetch mock 断言）。
- [ ] P1-13. `src/ui/state/plugins.tsx`：`PluginsProvider` 在 connection ready 后拉
  `/api/plugins`，暴露 `{plugins, enabled(id), refresh, setEnabled}`；静态模式 `enabled` 恒
  false；PATCH 乐观更新 + 失败回滚 + toast。
  - 判据：Provider 单测覆盖 ready/断线/静态/回滚；切后端重新拉取；PATCH 失败恢复旧值。
- [ ] P1-14. 官方 `switch` 组件收编（base-nova registry JSON 取回，逐字保留，仅 import
  别名/图标机械适配，文件头注出处）＋ `SettingsSheet.tsx`：`SettingsSheetProvider` 在
  `AppShell` 只挂一份 Sheet，`Nav`/`AccountSheet` 通过 `useSettingsSheet().open()` 打开；
  插件列表（名称/描述/版本/状态/Switch）、隐私说明（出站抓取与目标站可见服务器 IP）、
  agent 只读提示、错误 Alert 重试。入口：桌面 `Nav.tsx` 账号 DropdownMenu 增「设置」，
  移动端 `AccountSheet` 增「设置」。
  - 判据：桌面/移动两入口都打开同一个 Sheet 实例；owner/manager 可切，agent 开关 disabled
    且有说明；静态归档显示「静态归档不支持插件管理」；组件来源 diff 可对表 registry。
- [ ] P1-15. `src/ui/lib/viewer-adapters.ts`（P1 空注册表 + `resolveViewerAdapter` 返回
  null）与 `LinkPreviewCard.tsx`/`LinkPreviews.tsx`：官方 `Card` 形态；
  `page/image/video/audio/document/unknown` 六种图标与布局；封面 80×80（<640px）/
  112×112（sm+）固定方形；`pending` 固定高骨架；`failed` 紧凑链接行；
  `data-testid`/`data-preview-kind`/`data-preview-status`；`referrerPolicy="no-referrer"` +
  `loading="lazy"`；点击主区新窗口（`noopener,noreferrer`），另给「原文」小链接兜底。
  - 判据：Playwright 断言标题/描述/域名/封面；点击产生新 page 且 URL 正确、`window.opener`
    为 null；失败态仍可点；`prefers-reduced-motion` 下无高度动画；封面 403/404 时回退图标。
- [ ] P1-16. `PostCard.tsx` 两个分支在 `QuoteCard` 后、`TagChips` 前插入 `<LinkPreviews>`；
  当 `post.previews?.length` 或（插件启用且正文匹配 `http(s)`）且非静态时渲染；待补拉的
  pending 最多自动尝试 3 次（0ms/1500ms/9000ms），之后保持失败态，不轮询。
  - 判据：feed/线程/搜索/收藏/成员页五处均出现卡片；正文首帧不被预览阻塞（LCP 断言或
    首帧无卡片时正文已可见）；无布局抖动（CLS < 0.02，或前后卡片矩形差 ≤2px）。
- [ ] P1-17. `Markdown.tsx` 裸 URL 自动链接（仅 http/https，排除已有 link/image token，
  尾部标点平衡裁剪），复用 `core/link-extract.ts` 的 `scanBareUrls`（同一实现，禁止另写
  第二套正则），`target=_blank rel="noopener noreferrer"`；插件关闭/静态模式仍可点。
  - 判据：`test/core.test.ts` 或新增 UI 测试覆盖「裸 URL 变链接」「代码块不变」「
  `https://en.wikipedia.org/wiki/Foo_(bar)` 括号不误伤」；静态归档裸 URL 可点；
    `rg` 不出现第二份裸 URL 正则。

## P1. 验收

- [ ] P1-18. 夹具服务 `scripts/qa/link-preview-fixture.mjs`（`Bun.serve`，OS 分配端口，
  路由见 design §10.1）；隔离后端 `qa-serve.mjs`；`scripts/qa/link-preview.mjs` 用
  playwright-core 覆盖 design §10.3 的 A1–A14。
  - 判据：全部 PASS；失败时截图 + 响应状态留档；脚本退出时 kill 夹具与 qa-serve 并打印 PID；
    生产板 13689 0 写入（脚本拒绝指向生产 dataDir）。
- [ ] P1-19. 单测/集成绿门：`bun test`、`bun run check`、`bun run typecheck:ui`；新增测试文件
  全部通过；`bun test test/link-preview-*` 覆盖 design §10.2 全矩阵。
  - 判据：全绿；无 `any` 新增（`tsc --noEmit` strict）；无 console error。

## P2. 查看器与体验

- [ ] P2-1. `file-viewer` 内置插件（manifest + `src/ui/lib/viewer-adapters.ts` 适配器）：
  `canOpen(kind,mime)`、`buildUrl({url,name,decoder})`、`open()`；基址从
  `GET /api/plugins` 的 `viewer_base` 取（env `FDE2E_FILEVIEWER_BASE`，缺省
  `https://file-viewer.tool.fde2e.com`）；`link-preview` 的 `requires` 状态在设置页显示
  「已启用/未启用：将直接新窗口打开」。
  - 判据：图片/视频/PDF 点击进入 fileviewer URL（`?url=` 编码正确）；禁用 `file-viewer` 或
    未注册适配器时回退原链接；fileviewer 跨域解码失败时「原文」仍可用；基址非法（非 https）
    时拒绝并使用回退。
- [ ] P2-2. 封面与网络策略收口：封面只允许 https（页面 http 时允许 http）否则不显示；
  可选 `GET /api/previews/cover?hash=` 受限代理缓存（仅 image/*、复用 SSRF 策略、磁盘配额），
  默认关；`robots.txt` 读取策略评估（P3 决定）。
  - 判据：http 封面在 https 壳不渲染（无 mixed content 警告）；代理端点不能访问私网；
    配额满时淘汰最旧且不阻断卡片。
- [ ] P2-3. 体验补强：`preview.updated`/`plugin.updated` 经 event-hub 推送（若已合入）替代
  1.5s 重试与多端开关不同步；TTL 过期后台刷新进度不影响阅读；设置页显示插件统计（上次抓取/
  缓存命中/失败数）。
  - 判据：event-hub 存在时 pending→ok ≤2s、他端开关 ≤2s 生效；不存在时保持 P1 三次尝试与
    刷新语义；统计数字与服务端一致。
- [ ] P2-4. GC：`link_previews` 无引用且 `fetched_at < now-7d` 清理；启动/每 6h 一次，
  `unref()` timer；设置页/`/api/status` 可见缓存行数。
  - 判据：删除全部引用帖后 7 天内不误删，过期后被清；GC 不影响在飞任务。

## P3. 站点规则与收口

- [ ] P3-1. 站点专属 provider（YouTube/Vimeo/Bilibili/GitHub 仓库/oEmbed），按 host 精确匹配，
  未命中回通用管线；每个 provider 有独立超时与失败降级。
- [ ] P3-2. 若 P1 的自写 HTML 扫描器在真实站点准确率不足，替换为 `node-html-parser`（MIT）
  实现同一 `parseHtmlMeta` 接口；不得改变存储/API/UI 契约。
- [ ] P3-3. 规格/文档/归档：回填实测数字（抽 URL 耗时、抓取 P50/P95、缓存命中率），
  更新 `report-link-preview`/`report-surface`/`report-static-mode`，
  `npx openspec validate report-link-preview --strict`，归档 change。

# Proposal: report-link-preview（帖子链接预览，插件化）

## 背景（Owner 原话，2026-11-08 板上）

> 「后端需要一个功能，识别一个帖子的内容有没有链接，如果有链接，那么就应该识别出链接里面的内容
> （mime）：是图片还是网站还是视频还是文档等等。目的是在帖子的下方提供一个预览卡片点击可以打开
> 新窗口去查看内容（x也是这样子做的）。意味着后台需要抓取内容进行一个预览，并充分利用我们已有的
> fileviewer 这个 tool（注意，架构上你要实现插件化，不可以硬绑定 fileviewer，而是通过内置插件并
> 启用插件来做到，可以在设置页面管理插件的开关。这个插件就叫 link-preview）。对于未知网站，那就
> 直接给跳转就行，插件通用需要采集网站的标题和描述和主要正文与封面，这样才能做出预览卡片。图片
> 视频也同理，后端都可以做一些采集来实现预览。」

板上已确认的口径（manager 回帖，作为本 change 的施工口径）：

1. **落库时抽取**：发帖/回复提交时抽取正文中的 `http/https` URL，逐个建 preview 任务；未知站点
   只保留跳转，不臆造预览。
2. **插件 `link-preview`**：内置、可在设置页开关；核心只依赖 provider 接口，`fileviewer` 通过
   适配器接入，**不硬绑定**——关掉插件即退化为普通链接。
3. **采集**：HEAD/GET 判定 MIME → 图片/视频/文档/网页分流；网页采标题、描述、主要正文（有界
   摘要）与封面（OG 优先，回退 meta/title）；带超时、体积上限、缓存与失败降级。
4. **安全**：服务端抓取必须防 SSRF（仅 http/https、拒绝私网/回环/链路本地/元数据地址、逐跳
   校验重定向、限制响应体与时间、限流），只采文本与元数据、不执行脚本。
5. **UI**：帖下预览卡（封面/标题/描述/域名），点击新窗口打开；图片/视频/文档交给 fileviewer 的
   既有能力（未启用时回退新窗口打开原链接）。

## 现状（只读实测与代码证据）

- **生产板确有需求**：只读 SQLite 实测（2026-11-08），未删除帖 37 条，正文含 `http` 的 5 条；
  其中 `01M6VJXQNEAB…` 就是本条需求的板上回复。正文以 markdown 存储
  （`src/server/store.ts:733-747`、`:802-809`），写入在单事务 `commitOps` 内
  （`src/server/store.ts:652-657`）。
- **PostView 是唯一读投影**：`src/core/types.ts:156-162`；所有列表/线程/搜索/收藏都经
  `hydratePosts` 产出（`src/server/store.ts:1099-1133`）。当前没有 URL/预览字段。
- **markdown 解析器已有可复用的语法树**：`parseMarkdown` 输出 block/`InlineToken`
  （`src/core/markdown.ts:123-222`；代码块 `:143-155`；inline code/link/image
  `:37-114`）。抽取 URL 时必须复用该语法树才能可靠排除代码块/行内代码/图片。
- **正文渲染只处理 markdown 链接**：`src/ui/components/Markdown.tsx:149-163` 给链接加
  `target=_blank rel="noreferrer noopener"`；**裸 URL 在纯文本里不会自动变成链接**
  （`renderText` 只处理 @ 提及与 #tag，`:91-128`）。
- **帖子卡片插入点明确**：正文、媒体、引用、标签依次是
  `PostCard.tsx:243-271`（自接线程分支在 `:171-180`）；目前没有预览区。
- **本仓的“查看器”是客户端 lightbox**：`MediaGrid` → `ImageViewer`
  （`src/ui/components/MediaGrid.tsx:176-225`、`ImageViewer.tsx:1-15`），只管本仓上传的
  `MediaRef`，不能打开任意外链。
- **Owner 说的 fileviewer 是独立工具站**：URL 契约
  `/?url=<encodeURIComponent(绝对URL)>&name=&decoder=`（14 解码器）
  见 `fde2e-tools-v0/apps/file-viewer/src/lib/viewer-url.ts:1-14` 与
  `fde2e-tools-v0/packages/shared/src/registry.ts:177-233`；既有部署基址
  `https://file-viewer.tool.fde2e.com`（`fde2e-omni-v1/apps/web/src/lib/fileViewer.ts:17-19`、
  `fde2e-omni-v1/apps/server/src/uploads.ts:176`）。本仓从未接线，必须通过适配器而非硬编码。
- **设置面只有账号抽屉/账号菜单**：移动端 `AccountSheet.tsx:109-143`，桌面
  `Nav.tsx:126-154`；没有设置页，也没有任何插件机制。
- **能力/状态契约**：`API_ROUTES` 单源 `src/core/protocol.ts:39-77`；
  `/api/status` `src/server/http.ts:713-737`；`scripts/check.mjs:32-44` 会校验每个路由在
  `http.ts` 里是字面量。
- **静态归档是完全独立的只读实现**：快照类型 `src/ui/lib/static-api.ts:50-70`，
  导出快照 `src/server/export.ts:158-162`，静态横幅 `AppShell.tsx:61-79`。静态模式没有后端，
  因此不能抓取、也不能显示真实预览。
- **存储有现成的 meta 键值表**：`src/server/db.ts:58-61`、`getMeta/setMeta`
  `:229-241`，`SCHEMA_VERSION = 4`（`:49`）。插件开关与缓存都可复用 SQLite，不需要新配置文件。

## 目标

1. **插件化但最小**：一个编译期静态注册的插件注册表（manifest + provider map），首发只含
   `link-preview`；启用状态持久化、可在设置页开关；**禁止**任何运行时动态加载代码。
2. **后端识别链接**：写入事务内用 markdown 语法树抽取 `http/https` URL（排除代码块、行内代码、
   图片），规范化去重、每帖上限、超长忽略；落 `post_links` 关联表。
3. **通用抓取管线**：HEAD→GET 回退、MIME 判定（图片/视频/音频/文档/网页）、重定向上限、超时、
   响应体上限、字符集处理；网页按 OG → Twitter Card → `<title>`/meta description → 正文首段/
   favicon 的优先级采标题、描述、封面。
4. **安全不可妥协**：完整 SSRF 防护（见 design §5），逐跳校验重定向、DNS 解析后 IP pinning、
   端口限制、并发/每域名限流、固定 UA、不执行 JS、不落敏感头。
5. **预览可缓存可刷新**：`link_previews` 按规范化 URL 全局缓存；成功 TTL 24h、失败指数退避、
   过期 stale-while-revalidate；帖子删除清理关联；静态模式无预览。
6. **读契约简单**：预览随 `PostView.previews[]` 返回（只有链接帖才有字段），另提供
   `GET /api/previews?post=<id>` 做 pending 补拉；**不提供任意 URL 查询**，避免开放代理与
   SSRF oracle。
7. **UI 卡片**：官方 shadcn `Card` 形态，封面/标题/描述/域名/类型图标；加载/失败/禁用三态；
   点击主区新窗口打开（`noopener noreferrer`）；图片/视频/文档经 fileviewer 适配器打开；
   不阻塞正文、异步补位不抖。
8. **fileviewer 适配器**：`link-preview` 声明可选依赖 `file-viewer`，核心不 import 适配器；
   适配器未注册/未启用时点击直接新窗口打开原链接；设置页给出依赖提示。
9. **静态模式降级**：导出快照不含预览；静态壳只保留纯链接（裸 URL 也要可点）。
10. **可验收**：本地夹具 HTTP 服务覆盖 OG/图片/视频/PDF/404/超时/重定向私网/超大体/多链接上限；
    UI 断言卡片与点击行为；插件关闭时夹具服务 0 请求。

## 非目标

- 不引入 headless 浏览器、不执行目标页 JS、不渲染 CSS；不做全文抓取/正文清洗引擎，只存有界摘要。
- 不提供 `GET /api/previews?url=` 之类的任意 URL 预览接口（只接受帖子 id，URL 必须来自
  `post_links`）。
- 不做运行时插件下载/热加载/第三方插件市场；不做插件间依赖求解器（只有一层 `requires`）。
- 不把第三方封面/图片下载进本仓媒体库（P1 只存外链 URL；P2 可评估受限代理缓存）。
- 不改帖子写入 HTTP 契约、不改 markdown 语法、不改媒体上传白名单。
- 不为引用帖（`QuotedView`）生成预览；不做 oEmbed/站点专属规则（P3）。
- 不做预览文本的站内搜索索引；不做 WebSocket；不改通知/事件语义（P2 可选接 event-hub）。
- 不自动抓取帖子历史全量预览：启用插件只回填 URL 索引，预览仍按阅读/客户端补拉触发。

## 与在途 change 的关系（合并顺序）

- `report-notification-history-and-reply-submit`：当前工作树已有实现（`types.ts` 末尾新增
  history 类型、`store.ts` 的 `notificationHistory`、`http.ts` 的 history 路由、
  `ThreadPage.tsx` 的 `markPostRead`）。本 change 是加性改动，不触碰通知代码；**实现前先合它**。
- `report-thread-timeline`：会重写 `PostCard.tsx` 的平铺/导轨/自接链结构。本 change 只要求在
  两个分支的 `QuoteCard` 之后、`TagChips` 之前插入 `<LinkPreviews>`；**实现排它之后**，不要
  在它之前改 PostCard 结构。
- `report-event-hub`：会重构 `connection.tsx`/`App.tsx`/feed/通知与 `store.softDelete`（新增
  `post.deleted`）。本 change 的 `PluginsProvider` 只消费 `useConnection()`，Provider 树在
  `App.tsx` 加一层；`softDelete` 的清理行与 event-hub 的事件插入同事务，**event-hub 先合，
  本 change 在其最新 `softDelete` 上追加 `DELETE FROM post_links`**。P1 不依赖 event-hub；
  P2 的 `preview.updated` 推送是可选适配器。
- 冲突面集中在 `src/core/types.ts`（末尾追加）、`src/server/store.ts`（`hydratePosts`/
  `softDelete`）、`src/server/http.ts`（末尾追加路由）、`src/server/db.ts`（新表 + 版本号）、
  `src/ui/components/PostCard.tsx`、`src/ui/App.tsx`。全部是加性编辑，按上述顺序 rebase。

## 影响面

- 契约：新增 `GET /api/plugins`、`PATCH /api/plugins/:id`、`GET /api/previews?post=`；
  `PostView.previews?: LinkPreview[]`；capabilities 增 `features.plugins/link_preview`；
  schema v5 增 `post_links`、`link_previews`；meta 增 `plugins.*`。
- 服务端：`src/server/preview/*`（provider、fetch、html、service、ssrf）、`db.ts`、`store.ts`、
  `http.ts`、`serve.ts`、`export.ts`（剥离 previews）。
- 前端：`src/ui/state/plugins.tsx`、`src/ui/components/SettingsSheet.tsx`、
  `LinkPreviewCard.tsx`/`LinkPreviews.tsx`、`src/ui/lib/viewer-adapters.ts`、`Markdown.tsx`
  （裸 URL 自动链接）、`PostCard.tsx`、`AccountSheet.tsx`、`Nav.tsx`、`api.ts`、`static-api.ts`；
  官方 `switch` 组件从 base-nova registry 收编。
- 测试/文档：`test/link-extract.test.ts`、`test/link-preview-ssrf.test.ts`、
  `test/link-preview-service.test.ts`、`test/link-preview-http.test.ts`；
  `scripts/qa/link-preview-fixture.mjs`、`scripts/qa/link-preview.mjs`；本 change 的规格与设计。
- 不新增运行时依赖（P1 的 HTML 元数据提取用自写有界扫描器；若真实站点质量不足，P3 再评估
  `node-html-parser`，接口不变）。

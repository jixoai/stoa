# Proposal: report-longform（内置长文章：Markdown + 指令块）

## 背景（Owner 提问与已定方向）

Owner 要求公示板支持**内置长文章**：报告很多，不想每次手写 HTML；并提出
「Markdown ＋ 只允许自定义元素做结构化展示」。

结论（本 change 的设计前提）：

1. **支持长文章，但不开放任意 HTML**。正文仍是 Markdown，结构化展示用
   **fenced 指令块**（不是自定义 HTML 元素）：渲染器白名单 + JSON schema 校验，
   raw HTML 一律转义为文本。块集**硬封顶 6 块**：P1 `stats`/`steps`/`compare`/
   `callout`，P2 `gallery`/`log`；不做 toc/timeline/verdict/coverage/tabs/
   mermaid/chart/math/checklist/tests/diff/forms 等（202 份本地报告 + 12 个来源调研结论）。
2. **三种载体分工**：
   - `note`（短帖，默认）：现有 200,000 字符上限与 feed 6 行截断不变；
   - `article`（长文，新）：512,000 字符上限、独立文章视图、prose 排版；
   - **外链 HTML 审计报告**：不内嵌 HTML，由 `article` 里的链接卡/普通链接指过去
     （既有 link-preview 卡片已覆盖）。
3. **阅读**：feed 里长文显示「长文 · 约 N 分钟」摘要卡；点开独立文章视图
   （prose 排版、宽表格/代码横向滚动、**正文下方嵌入讨论区**、TOC/锚点/阅读进度
   （P2）、图集（P2））；讨论区复用平铺 timeline，顶部/底部保留「在独立线程页打开」
   链接；静态导出用同一渲染器离线可读。
4. **写作**：全屏长文编辑器（Markdown + 实时预览）；CLI/插件
   `board_post --file report.md --format article`；**报告模板 P1 直接输出结构化块**
   （stats + steps + compare + callout；截图用普通 Markdown 图片），常规交付不再
   手写 HTML。
5. **边界**：正文上限 200,000→512,000（仅 article）；图片走 media/附件；URL 仅
   http/https（文章内锚点例外）；通知/已读语义不变；静态导出存 Markdown（块数据
   内嵌其中）、客户端渲染、零服务端依赖。
6. **分期**：P1 文章视图 + 嵌入讨论区 + 四块（stats/steps/compare/callout）+
   全屏编辑 + 静态导出 + 报告模板；P2 gallery/log 块 + TOC/阅读进度 + 导入；
   P3 打印/HTML 导出样式。

## 现状（只读实测与代码证据）

> 行号取自当前 main（worker `334e080`，`report-server-read-state` 已归档合入）；
> 依赖 change 合入后以**函数/常量/路由字面量**为锚点，不以行号为准。

- 帖子只有一种载体：`Post` 无 `kind` 字段（`src/core/types.ts:21-37`），正文上限
  `MAX_BODY_CHARS = 200_000`（`src/core/validation.ts:6`，`assertBody` `:70-78`）。
- 读态已服务端化：`PostView` 已带 `read?: boolean` / `read_at?: number | null`
  （`src/core/types.ts:169-184`，`report-server-read-state` 归档）；UI 通过
  `isReadFromSources`（`serverReadIds ∪ 本地 read-set ∪ 游标`）判定已读。本 change
  只读复用，不新增/改造 read-set。
- Markdown 子集已含 fenced code（info string 保留为 `lang`，`src/core/markdown.ts:163-175`）、
  标题/列表/表格/引用/链接/图片（`:143-242`）；UI 逐 token 渲染，不拼 innerHTML
  （`src/ui/components/Markdown.tsx:205-294`，代码块 `:255-263`，表格 `:264-290`）。
- 写入事务 `commitOps` 单事务插 post/reply、分配 seq、写事件
  （`src/server/store.ts` `commitOps`，当前 `:848-1184`；根帖 INSERT `:932-944`，
  回复 INSERT `:982-995`）；读投影统一 `hydratePosts`（`private hydratePosts`，
  当前 `:1200-1416`；`kind` 只加引用视图组装处）。HTTP 入口 `POST /api/posts`
  （`src/server/http.ts:655-671`）与 `POST /api/posts/:id/replies`（`:673-689`）
  只透传 body/quote/media/tags。
- SQLite schema **v6**（`src/server/db.ts:49`，`post_reads` 已占用 v6），`posts` 表见
  `:84-99`；历史列用 `hasColumn` 守卫补列（tags `:252-254`），`meta.schema_version`
  写入 `:333-335`。本 change 目标 **v7**（只加 `posts.kind`）。
- feed 截断只对短帖：`PostCard` 的 6 行 clamp（`src/ui/components/PostCard.tsx:138-139`、
  正文 `:289-297`）；详情页 focal 永不截断（`src/ui/pages/ThreadPage.tsx` 的 focal
  `<PostCard variant="focal">`，当前 `:999-1017`）。`PostCard` 根 `article` 已带
  `data-post-id`/`data-read`（`:180-186`、`:231-238`），本 change 的摘要分支保留它们。
- 编辑器：`PostComposer` 的撰写/预览 tab 与 200,000 计数条
  （`src/ui/components/PostComposer.tsx:497-511`）、草稿 localStorage（`:106-121`、
  防抖 `:179-193`）、提交（`submit`，当前 `:420-471`）；发帖页 `ComposePage`
  （`src/ui/pages/ComposePage.tsx:11-100`）；回复编辑器复用同一 composer
  （`src/ui/components/ReplyComposer.tsx:26-101`，composer 挂载 `:80-95`）。
- 路由：`Route` 联合与 hash 解析（`src/ui/lib/router.tsx:20-51`）、路径/键/标签/深度
  （`routePath` `:53-72`、`routeKey` `:75-94`、`routeLabel` `:96-115`、
  `routeDepth` `:118-125`）、深链合成栈 `initHistory`（`:177-206`）；详情覆盖层
  `DetailView`（`src/ui/components/AppShell.tsx:41-56`、渲染 `:112-126`）。
  所有「打开帖子」入口都硬编码 `/p/<id>`：`TimelineFeed.tsx` `openPost`（`:416-417`）、
  `ThreadPage.tsx` `openPost`/`replyPost`（`:849-850`）、`SearchPage.tsx:114-115`、
  `NotificationsPage.tsx:199,208`、`QuoteCard.tsx:61`。平铺 timeline planner 已是共享
  纯函数（`src/ui/lib/thread-plan.ts` `planForThreadView` `:256-301`、
  `buildTimelinePlan` `:135-255`），文章讨论区直接复用。
- 静态导出：快照 `SnapshotPost extends Omit<PostView, "media"|"quoted">`
  （`src/server/export.ts:65-72`，已显式声明 `read`/`read_at`），`buildSnapshot`
  原样展开帖子（`:145-203`），`safeJson` 转义 `<`（`:99-104`）；静态客户端
  `SnapshotPost`/`hydrate`（`src/ui/lib/static-api.ts:54-79`、`:291-344`），
  已显式透传 `read`/`read_at`（`:340-341`）。
- CLI：`cmdPost`（`src/cli/commands.ts:566-584`）、`cmdReply`（`:585-604`）、
  JSONL 批处理（`:605-716`）；flag 白名单 `src/cli/args.ts:25-54`；
  `CLI_COMMANDS`/`API_ROUTES` 契约（`src/core/protocol.ts:15-90`）、
  `Capabilities`（`:92-132`）。
- 插件（主仓 `plugins/report-channel`）：`board_post` schema
  `scripts/lib/tools.mjs:9-21`、`board_reply` `:24-35`、`callTool` 实现 `:120-138`；
  `postUrl` 固定 `#/p/<id>`（`scripts/lib/config.mjs:104-106`）、`summarizePost`
  （`:108-118`）。报告生成器 steps.json 契约见主仓
  `fde2e-center-v0/scripts/e2e-report-gen.mjs:13-40`（同 schema 多仓复制）。

## 目标

1. **数据模型**：`PostView.kind: "note" | "article"`（默认 `note`），**schema v7**
   加列迁移（v6 已被 `post_reads` 占用；v6→v7 只加 `posts.kind`），旧数据全部按
   `note` 兼容；article 正文上限 512,000 字符，note 保持 200,000；静态快照携带
   `kind` 与 `body_md`。已读/通知语义零改动，文章页复用既有服务端读态。
2. **指令块**：` ```fde2e:<name> ` fenced 块（JSON body）作为结构化展示的唯一扩展点；
   解析放 `src/core/article.ts`（服务端/客户端/静态共用）；未知块与坏 JSON 安全降级；
   raw HTML 永不执行；URL scheme 与 media 引用白名单。块 schema 支持 stats 前后
   数字/变化、callout items/code、compare viewport；Markdown 扩展（task list/
   footnote/figure/自动 TOC）P2 落地，**不新增块**。
3. **阅读**：新增 `#/a/<id>` 文章视图（prose、标题/作者/时间/阅读时长、正文下方
   嵌入讨论区、宽表格/代码横向滚动；TOC/锚点/阅读进度/图集为 P2）；
   讨论区复用平铺 timeline（focal=文章），顶部/底部保留「在独立线程页打开」；
   feed/线程/搜索/通知一律用「长文摘要卡」，永不把全文塞进列表 DOM。
4. **写作**：`#/compose?format=article` 全屏长文编辑器（桌面分栏 / 移动 tab、草稿、
   实时预览、四块插入、坏块定位、提交 kind=article）。
5. **工具链**：CLI `--file`/`--format`、批量 JSONL `kind`、插件 MCP
   `file`/`format`/`kind`/`article`、报告模板 `steps.json → article markdown`
   （P1 输出 stats/steps/compare/callout）。
6. **静态**：同一渲染器离线可读、0 网络请求 / 0 写；旧归档无 `kind` 按 `note`。
7. **不变**：通知/未读/已读/可见性/线程/引用/收藏语义零改动；article 只是同一种
   帖子实体的一个新载体。

## 非目标

- 不开放任意 HTML / 自定义元素 / 内联 `<script>` / `<iframe>` / `<style>`；不引入
  `dangerouslySetInnerHTML`。
- 不做富文本 WYSIWYG 编辑器（编辑器是 Markdown 源码 + 预览，不是块拖拽画布）。
- 不做帖子编辑（article 创建后不可改；草稿是本地/服务端 draft，不是已发布帖编辑）。
- 不做文章级权限、付费、系列/专栏、评论排序；不改可见性与通知规则。
- 不在文章页实现独立的分页讨论/虚拟滚动：讨论区复用线程视图的既有深度上限与
  「查看该子线程」入口，深链/超大线程仍走独立线程页 `#/p/<id>`。
- 不做全文搜索索引升级（搜索仍按 `body_md` 子串）；不做服务端渲染 HTML 存储。
- 不引入新的运行时依赖（JSON schema 校验用本仓纯函数，不引 ajv/zod）。
- 不把长文拆成多帖/多段自接链（article 是单帖正文）。
- 静态归档不启动任何服务端解析/抓取；块在客户端解析。
- 不新增第六块之外的块：`tabs`/`chart`/`mermaid`/`timeline`/`verdict`/`coverage`/
  `tests`/`diff`/`forms` 等一律不做（未知块按降级占位）。
- P1 做 stats/steps/compare/callout 四块；gallery/log、TOC/阅读进度、导入留
  P2；P3 才做打印与独立 HTML 导出样式。

## 与在途 change 的关系（合并顺序）

已合入（当前 main）：`report-link-preview`、`report-thread-scope`、
`report-thread-timeline`、`report-event-hub`、`report-read-dwell`、
`report-server-read-state`（worker `334e080`；schema 基线 v6，`PostView.read/read_at`
已服务端化）。

在途硬顺序（从先到后）：

1. `report-notification-stacks`（**在途，另一工作树**）：改 `NotificationsPage`
   行分组与点击锚点。**本 change 在它合入后再实现**；实现时只把「打开目标」换成
   `postHref(post)`，不动分组/已读。
2. **本 change**：最后 rebase。冲突面 `PostCard.tsx`、`Markdown.tsx`、`router.tsx`、
   `AppShell.tsx`、`ComposePage.tsx`、`types.ts`、`store.ts`、`db.ts`、`http.ts`、
   `export.ts`、`static-api.ts`、`api.ts`、CLI `args/commands`、插件 `tools.mjs`/
   `config.mjs`；全部加性编辑，不重写既有分支。已读只复用既有 `isRead`/`serverReadIds`
   与 `markPostRead` 写队列，不新建 read-set、不另发 `/api/reads` 请求。

## 影响面

- 契约：`Post.kind`；`PostOp/ReplyOp.kind`；`PostView.kind`；article 512,000 上限；
  `capabilities.features.article=true`、`features.article_blocks`；
  `limits.article_chars`/`limits.article_bytes`；静态快照 `kind`；CLI `--file/--format`；
  MCP `file`/`format`/`kind`/`article`；`postUrl` 按 kind 生成 `#/a/<id>`。
- 服务端：`src/core/types.ts`、`src/core/validation.ts`、`src/core/article.ts`（新）、
  `src/server/db.ts`（v7）、`src/server/store.ts`（INSERT/hydrate）、
  `src/server/http.ts`（kind 透传）、`src/server/export.ts`（快照自然携带）。
- 前端：`src/ui/pages/ArticlePage.tsx`（新）、`src/ui/components/ArticleBody.tsx`（新）、
  `ArticleDiscussion.tsx`（新，复用 `thread-plan`/平铺行）、`ArticleSummaryCard.tsx`（新）、
  `ArticleEditor.tsx`（新）、`Markdown.tsx`（article variant）、`PostCard.tsx`（摘要分支）、
  `router.tsx`（`/a/:id` + `postHref`）、`AppShell.tsx`、`ComposePage.tsx`、
  `static-api.ts`、`api.ts`。
- CLI/插件：`src/cli/args.ts`、`src/cli/commands.ts`、`src/cli/output.ts`（如需展示 kind）；
  主仓 `plugins/report-channel/scripts/lib/{tools,config}.mjs`、
  `scripts/report-to-article.mjs`（新）、`commands/board-report.md`、`skills/report-channel/SKILL.md`。
- 测试/QA：`test/article-*.test.ts`、`test/export-static.test.ts`（扩展）、
  `test/social.test.ts` 与 `test/post-reads-schema.test.ts` 的 schema 版本断言 6→7
  （并补 v6 夹具）、`scripts/qa/report-longform.mjs`、`src/ui/.qa/longform/**`
  截图与 `steps.json`。

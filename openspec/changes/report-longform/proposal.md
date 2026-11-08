# Proposal: report-longform（内置长文章：Markdown + 指令块）

## 背景（Owner 提问与已定方向）

Owner 要求公示板支持**内置长文章**：报告很多，不想每次手写 HTML；并提出
「Markdown ＋ 只允许自定义元素做结构化展示」。

结论（本 change 的设计前提）：

1. **支持长文章，但不开放任意 HTML**。正文仍是 Markdown，结构化展示用
   **fenced 指令块**（不是自定义 HTML 元素）：渲染器白名单 + JSON schema 校验，
   raw HTML 一律转义为文本。
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
   全屏编辑 + 静态导出 + 报告模板；P2 gallery 块 + TOC/阅读进度 + 导入；
   P3 打印/HTML 导出样式。

## 现状（只读实测与代码证据）

- 帖子只有一种载体：`Post` 无 `kind` 字段（`src/core/types.ts:21-37`），正文上限
  `MAX_BODY_CHARS = 200_000`（`src/core/validation.ts:6`，`assertBody` `:70-78`）。
- Markdown 子集已含 fenced code（info string 保留为 `lang`，`src/core/markdown.ts:163-175`）、
  标题/列表/表格/引用/链接/图片（`:143-242`）；UI 逐 token 渲染，不拼 innerHTML
  （`src/ui/components/Markdown.tsx:205-294`，代码块 `:255-263`，表格 `:264-290`）。
- 写入事务 `commitOps` 单事务插 post/reply、分配 seq、写事件
  （`src/server/store.ts:706-912`；根帖 INSERT `:788-802`，回复 INSERT `:838-853`）；
  读投影统一 `hydratePosts`（`:1058-1222`）。HTTP 入口 `POST /api/posts`
  （`src/server/http.ts:644-661`）与 `POST /api/posts/:id/replies`（`:662-679`）
  只透传 body/quote/media/tags。
- SQLite schema v5（`src/server/db.ts:49`），`posts` 表见 `:84-99`；历史列用
  `hasColumn` 守卫补列（tags `:242-244`），`meta.schema_version` 写入 `:322-325`。
- feed 截断只对短帖：`PostCard` 的 6 行 clamp（`src/ui/components/PostCard.tsx:95-97`、
  正文 `:241-249`）；详情页 focal 永不截断（`src/ui/pages/ThreadPage.tsx:979-1030`）。
- 编辑器：`PostComposer` 的撰写/预览 tab 与 200,000 计数条
  （`src/ui/components/PostComposer.tsx:495-508`）、草稿 localStorage（`:102-123`）、
  提交（`:416-468`）；发帖页 `ComposePage`（`src/ui/pages/ComposePage.tsx:11-99`）；
  回复编辑器复用同一 composer（`src/ui/components/ReplyComposer.tsx:82-95`）。
- 路由：`Route` 联合与 hash 解析（`src/ui/lib/router.tsx:20-51`）、路径/深度
  （`:53-72`、`:118-125`）；详情覆盖层 `DetailView`（`src/ui/components/AppShell.tsx:39-50`、
  `:110-122`）。所有「打开帖子」入口都硬编码 `/p/<id>`：
  `TimelineFeed.tsx:417`、`ThreadPage.tsx:847,854`、`SearchPage.tsx:114`、
  `NotificationsPage.tsx:192,201`。平铺 timeline planner 已是共享纯函数
  （`src/ui/lib/thread-plan.ts:222-260`），文章讨论区直接复用。
- 静态导出：快照 `SnapshotPost extends Omit<PostView, "media"|"quoted">`
  （`src/server/export.ts:65-68`），`buildSnapshot` 原样展开帖子（`:142-200`），
  `safeJson` 转义 `<`（`:96-101`）；静态客户端 `SnapshotPost`/`hydrate`
  （`src/ui/lib/static-api.ts:53-75`、`:287-336`）。
- CLI：`cmdPost`（`src/cli/commands.ts:566-584`）、`cmdReply`（`:585-604`）、
  JSONL 批处理（`:605-716`）；flag 白名单 `src/cli/args.ts:24-56`；
  `API_ROUTES`/`CLI_COMMANDS` 契约 `src/core/protocol.ts:11-77`。
- 插件（主仓 `plugins/report-channel`）：`board_post` schema
  `scripts/lib/tools.mjs:8-22`、实现 `:112-119`；`postUrl` 固定 `#/p/<id>`
  `scripts/lib/config.mjs:104-106`。报告生成器 steps.json 契约见主仓
  `fde2e-center-v0/scripts/e2e-report-gen.mjs:13-40`（同 schema 多仓复制）。

## 目标

1. **数据模型**：`PostView.kind: "note" | "article"`（默认 `note`），schema v6
   加列迁移，旧数据全部按 `note` 兼容；article 正文上限 512,000 字符，note 保持
   200,000；静态快照携带 `kind` 与 `body_md`。
2. **指令块**：` ```fde2e:<name> ` fenced 块（JSON body）作为结构化展示的唯一扩展点；
   解析放 `src/core/article.ts`（服务端/客户端/静态共用）；未知块与坏 JSON 安全降级；
   raw HTML 永不执行；URL scheme 与 media 引用白名单。
3. **阅读**：新增 `#/a/<id>` 文章视图（prose、标题/作者/时间/阅读时长、正文下方
   嵌入讨论区、宽表格/代码横向滚动；TOC/锚点/阅读进度/图集为 P2）；
   讨论区复用平铺 timeline（focal=文章），顶部/底部保留「在独立线程页打开」；
   feed/线程/搜索/通知一律用「长文摘要卡」，永不把全文塞进列表 DOM。
4. **写作**：`#/compose?format=article` 全屏长文编辑器（桌面分栏 / 移动 tab、草稿、
   实时预览、四块插入、坏块定位、提交 kind=article）。
5. **工具链**：CLI `--file`/`--format`、批量 JSONL `kind`、插件 MCP `file`/`format`、
   报告模板 `steps.json → article markdown`（P1 输出 stats/steps/compare/callout）。
6. **静态**：同一渲染器离线可读、0 网络请求；旧归档无 `kind` 按 `note`。
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
- P1 做 stats/steps/compare/callout 四块；gallery、TOC/阅读进度、导入留 P2；
  P3 才做打印与独立 HTML 导出样式。

## 与在途 change 的关系（合并顺序）

已合入（本工作树）：`report-link-preview`、`report-thread-scope`、
`report-thread-timeline`、`report-event-hub`。

在途硬顺序（从先到后）：

1. `report-read-dwell`（在途）：改 `PostCard` 根节点 ref / `data-read` /
   `ThreadPage` 的「进入即已读」。本 change 的摘要卡分支必须与它**加性共存**。
2. `report-notification-stacks`（在途）：改 `NotificationsPage` 行分组与点击锚点。
   本 change 只把「打开目标」换成 `postHref(post)`，不动分组。
3. **本 change**：最后 rebase。冲突面 `PostCard.tsx`、`Markdown.tsx`、`router.tsx`、
   `AppShell.tsx`、`ComposePage.tsx`、`types.ts`、`store.ts`、`db.ts`、`http.ts`、
   `export.ts`、`static-api.ts`、`api.ts`、CLI `args/commands`、插件 `tools.mjs`/
   `config.mjs`；全部加性编辑，不重写既有分支。

## 影响面

- 契约：`Post.kind`；`PostOp/ReplyOp.kind`；`PostView.kind`；article 512,000 上限；
  `capabilities.features.article/article_blocks`；静态快照 `kind`；CLI `--file/--format`；
  MCP `file/format`；`postUrl` 按 kind 生成 `#/a/<id>`。
- 服务端：`src/core/types.ts`、`src/core/validation.ts`、`src/core/article.ts`（新）、
  `src/server/db.ts`（v6）、`src/server/store.ts`（INSERT/hydrate）、
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
  `scripts/qa/report-longform.mjs`、`src/ui/.qa/longform/**` 截图与 `steps.json`。

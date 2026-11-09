# Tasks: report-longform（Markdown 长文章 + 白名单指令块）

> 依赖顺序（硬）：`report-link-preview`、`report-thread-scope`、
> `report-thread-timeline`、`report-event-hub`、`report-read-dwell`、
> `report-server-read-state` 已合入（worker `334e080`；schema 基线 **v6**）。
> 本 change 目标 schema **v7**（只加 `posts.kind`）。`report-notification-stacks`
> 已合入（worker `f3d9489` 基线）；本 change 已在它之上实现。
> 每项判据不满足不得勾选。

## P1. 数据模型与解析

- [x] P1-1. `src/core/types.ts`：`PostKind = "note" | "article"`；`Post.kind`；
  `QuotedView.kind`；`PostOp.kind?`/`ReplyOp.kind?`。
  - 判据：`tsc --noEmit` 通过；`kind` 缺省语义在类型/运行时都是 `note`；
    `rg "kind" src/core/types.ts` 覆盖 Post/QuotedView/PostOp/ReplyOp 四处。
  - 证据：`tsc --noEmit -p tsconfig.json` 与 `-p src/ui/tsconfig.json` 均通过；
    `rg -n kind src/core/types.ts` → L33（Post）/L136（PostOp）/L147（ReplyOp）/
    L162（QuotedView）；运行时缺省：`toPost` 的 `postKindOf` 与 `normalizeKind`
    把空/未知归一 `note`（`src/server/store.ts:193`、`src/core/validation.ts:78`）。
- [x] P1-2. `src/core/validation.ts`：`MAX_ARTICLE_CHARS = 512_000`、
  `MAX_ARTICLE_BYTES = 2 * 1024 * 1024`；`normalizeKind`；`assertBody(body, kind)`；
  `validateWriteOp` 归一化 `kind`。
  - 判据：note 200,000 过/200,001 拒；article 512,000 过/512,001 拒；
    article UTF-8 >2MiB 拒；未知 kind `BAD_REQUEST`；错误文案含上限；
    既有 note 调用（不传 kind）行为逐字不变。
  - 证据：`test/article-http.test.ts`（512,000 过 / 512,001 拒文案含 "512,000" /
    `文×800,000`（>2MiB）拒文案含 "2 MiB utf-8" / note 200,000 过、200,001 拒文案
    含 "200000" / 未知 kind 400 文案含 "invalid kind"）；未传 kind 的 note 路径
    由既有 `test/social.test.ts`、`test/http.test.ts`、`test/cli.test.ts` 全绿覆盖
    （531 tests / 0 fail）。
- [x] P1-3. `src/server/db.ts`：`SCHEMA_VERSION = 7`（v6 已被 `post_reads`
  占用）；`posts` 建表含 `kind TEXT NOT NULL DEFAULT 'note'`；旧库（v5/v6）
  `hasColumn` 守卫 `ALTER TABLE posts ADD COLUMN kind ...`；重复 migrate 幂等。
  - 判据：v5 夹具（无 `post_reads`/无 `kind`）与 v6 夹具（有 `post_reads`/无
    `kind`）启动后 `PRAGMA table_info(posts)` 含 `kind`、旧行 `note`、
    `meta.schema_version=7`；v6 夹具的 `post_reads` 行数/内容不变；连续两次
    `migrate()` 无错；`test/social.test.ts` 与 `test/post-reads-schema.test.ts`
    的版本断言同步 6→7（后者新增 v6 夹具用例）。
  - 证据：`src/server/db.ts:49` SCHEMA_VERSION=7、`:96` 建表列、`:260-262`
    hasColumn 守卫补列；`test/post-reads-schema.test.ts`：fresh→7 / 幂等 /
    v5 夹具补齐 / v6 夹具「只补 kind、post_reads 行内容不变（reads=1）」；
    `test/social.test.ts` 版本断言同步 7；QA A13 复验（v5/v6 夹具
    `{"v6":{"hasKind":true,"kind":"note","reads":1,"version":"7"},"v5":{"postReads":true,"kind":"note","version":"7"}}`）。
- [x] P1-4. `src/server/store.ts`：`commitOps` 根帖/回复 INSERT 写 `kind`；
  `PostRow`/`toPost` 自动带出；`hydratePosts` 引用视图补 `kind`；草稿/批处理
  序列化保留 `kind`。
  - 判据：`post`/`reply`/batch/draft commit 四种路径 `kind` 往返一致；
    引用卡 `QuotedView.kind` 正确；软删/可见性/seq/事件 0 变化；
    `test/social.test.ts`/`test/store.test.ts` 既有断言全绿。
  - 证据：`store.ts` 根帖 INSERT `:945`、回复 INSERT `:997`（带 `kind` 列）、
    `toPost` `:192`、引用视图 `:1369`（`kind: postKindOf(visibleQuoted.kind)`）；
    `test/article-http.test.ts` 覆盖 post/reply/batch 草稿 commit 三条往返；
    引用视图 kind 由 `test/article-static.test.ts`（quoted.kind）
    与 QA A8「引用长文卡＝标题/摘要 + `#/a/<id>`」实测；软删/可见性/seq/事件
    既有用例全绿（含 `test/post-reads-*`、`test/social.test.ts`）。
- [x] P1-5. `src/server/http.ts` + `src/core/protocol.ts`：`POST /api/posts`、
  `POST /api/posts/:id/replies` 透传 `kind`；`capabilities.features.article=true`、
  `features.article_blocks = ["stats","steps","compare","callout"]`（P1 四块；
  P2 追加 `gallery`/`log`）；`limits.article_chars=512_000`、
  `limits.article_bytes=2*1024*1024`（`limits.body_chars` 保持 200,000）。
  - 判据：HTTP 创建 article 返回 `kind=article`；缺省 `note`；未知 kind 400；
    `/api/capabilities` 返回 `features.article=true`、P1 四块与两项 limits；
    `scripts/check.mjs` 路由/命令 lint 通过（无新端点）。
  - 证据：`http.ts:678-685`（posts）与 `:698-705`（replies）透传 kind；
    `protocol.ts:180-190` capabilities；`test/article-http.test.ts`
    （缺省 note / article / 回复 article / 未知 kind 400 / capabilities 断言）；
    `bun run check` → `ok cli commands — 20 declared` + `check passed`（API_ROUTES
    未新增）。
- [x] P1-6. `src/core/article.ts`（新）：`parseArticle`/`articleSummary`；
  fenced `fde2e:<name>` 识别；JSON 解析；**P1 四块 schema**
  （stats/steps/compare/callout，design §3.2 最终版）；未知块/坏 JSON/schema
  错降级 + warning；标题/摘要/阅读时长/纯文本；H2/H3 slug（NFKC、CJK、冲突
  `-2/-3`）；`BlockIssue` 行号。
  - 判据：`test/article-parse.test.ts` 覆盖：普通 ```js 不变；stats 1..8/
    label40/value32/before-after32/unit12/hint80/tone/better；steps 1..20/
    title 必填/status done|failed|degraded|skipped|pending（未知→pending+
    warning）/expect1000/detail2000/command4KiB/output8KiB/media 本地；
    compare before/after 必填/label60/caption200/title120/note300/viewport40
    （两侧不一致 warning）；callout tone/body2000/items0..8×300/code4KiB；
    未知块降级（含行号）；坏 JSON；schema 类型错；未知 tone→info+warning；
    重复标题 slug；CJK 标题；无 H1 回退；首个 block 非 H1 时不抢标题；
    3/4 反引号 fence 与闭合长度；块起始行号；`articleSummary` 标题/摘要/
    minutes；200 块/16KiB 上限；截断/超限记 warning；解析 512KB <50ms；
    任何输入不抛异常。
  - 证据：`src/core/article.ts`（851 行）+ `test/article-parse.test.ts`
    39 用例逐条覆盖上述边界（fence 长度/闭合 run ≥ 开启 run、行号、
    200 块与 16KiB 降级、未知 status/tone 归一 + warning、CJK slug
    `中文-标题`、`# 大文档` 512KB 混合解析 2.72ms < 50ms、随机字节不抛异常）；
    `bun test test/article-parse.test.ts` 全绿。

## P1. 阅读

- [x] P1-7. `src/ui/lib/router.tsx` + `src/ui/components/AppShell.tsx`：新增
  `{ name:"article"; id }` 路由（`#/a/<id>`，depth 1）、`routePath`/`routeKey`/
  `routeLabel`/`routeDepth`；`postHref(post)`；`DetailView` 增加 `ArticlePage`。
  - 判据：深链 `/a/<id>` 有合成返回栈；`postHref(note)=/p/<id>`、
    `postHref(article)=/a/<id>`；既有路由（home/post/profile/tag/search/
    notifications/bookmarks/compose）键/深度不变。
  - 证据：`test/article-router.test.ts`（4 用例：article path/key/label/depth；
    既有路由键/深度冻结含 compose 旧键 `compose:<quote>` 逐字不变、article 形态
    `compose::article`；postHref/postHashHref 缺省 note）；`AppShell.tsx`
    DetailView `case "article"`；QA 深链 `/a/<note>` 回退实测
    （`#/p/<note>`）；QA 键盘流以冷启动进入文章页（合成返回栈语义由
    router 既有 `initHistory` 提供，未改动）。
- [x] P1-8. `src/ui/pages/ArticlePage.tsx` + `src/ui/components/ArticleBody.tsx`
  （新）：页头/返回/来源、唯一 H1、AuthorLine/时间/阅读时长/TagChips、
  `ArticleBody` 渲染 Markdown 节点、操作栏（回复/引用/收藏/复制）、
  顶部与底部「在独立线程页打开 · N 条回复」链接、删除/404/`/a/<note>` 回退；
  正文根容器带 `data-post-id`（供 read-dwell）。
  - 判据：A1；`/a/<note>` `replace` 到 `/p/<note>`；软删显示占位；
    静态模式写操作 `toastReadOnly`；DOM 中 `<h1>` 恰好 1 个；顶部/底部
    独立线程页链接都到 `#/p/<id>`；已读复用既有 `isRead`/`serverReadIds` 与
    `markPostRead` 写路径（不新建 read-set、不另建 observer、不直接发
    `/api/reads`）。
  - 证据：QA A1「文章内容层唯一 H1（`viewH1Count=1`/`scrollH1Count=1`/
    `bodyH1=0`）+ 标题/时间/约 N 分钟 + prose ≤68ch」；QA「顶部/底部
    『在独立线程页打开』→ `#/p/<id>`」（实测点击落 `#/p/<MAIN_ID>`）；
    QA「软删长文显示占位（不白屏、不误回退）」；QA「`/a/<note>` 回退到
    `/p/<note>`」（动态 + 静态各一）；软删占位 `data-testid="article-deleted"`
    （`ArticlePage.tsx` DeletedArticle）；静态写操作 toastReadOnly
    （`ArticlePage.tsx` reply/quote 分支 + QA A10 readonly banner）；
    已读复用：`useReadDwell` + `usePostReadFlag`，QA A9 断言
    `observers ≤ 1`、`marks/persists ≥ 1`、服务端 `post_reads` 命中。
- [x] P1-9. `src/ui/components/Markdown.tsx`：`variant?: "default" | "article"`、
  `headingIds?: string[]`；article prose 排版（17/28、H2/H3、表格/代码横向滚动、
  图片圆角、主题令牌）；默认 variant 逐字不变。
  - 判据：A1/A4；note/feed/线程快照与改动前一致（视觉回归）；
    `rg "#[0-9a-fA-F]{3,8}" src/ui/components/Markdown.tsx` 0 命中。
  - 证据：`MarkdownBlocks`/`Markdown` 增加 `variant`/`headingIds`（默认路径分支
    与原实现逐字相同，diff 只加分支）；`rg "#[0-9a-fA-F]{3,8}" Markdown.tsx`
    无命中（exit=1）；note 路径回归：QA A8「note 卡行为不变（走 post-body，
    无摘要卡）」+ 既有 `test/markdown-bare-url.test.tsx`、link-preview UI
    守卫测试全绿；article prose 实测：QA A1（17px/68ch）、A2（表格/代码
    横向滚动 `overflow-x: auto`）。
- [x] P1-10. `src/ui/components/ArticleSummaryCard.tsx`（新）+
  `src/ui/components/PostCard.tsx` + `src/ui/components/QuoteCard.tsx`：article
  分支渲染摘要卡（Badge「长文」、标题 2 行、摘要 2 行、约 N 分钟）；不再走
  `longBody`/clamp；自接分支同样；引用卡的正文/整卡链接按 `QuotedView.kind`
  切摘要与 `postHref(quoted)`；`TimelineFeed.tsx` `openPost`、`ThreadPage.tsx`
  `openPost`、`SearchPage.tsx:114-115`、`NotificationsPage.tsx` 通知行点击
  改用 `postHref(post)`；通知行的正文摘要对 article 用 `articleSummary` 的
  title/excerpt，不渲染全文 Markdown。
  - 判据：A8；feed/线程/搜索/收藏/成员页/通知六处摘要卡一致；引用 article 卡
    显示摘要并跳 `#/a/<id>`；DOM 不含 article 全文；note 卡片行为不变；
    `data-testid="article-summary"` 存在。
  - 证据：QA A8 系列：feed 长文卡＝摘要卡（Badge/标题/约 N 分钟、
    `paragraphs ≤ 6`、`pres=0`、无 `post-body`）；线程页 focal 摘要卡 +
    「阅读全文」；搜索页摘要卡；通知行 `notification-article-summary`；
    引用卡 `data-quote-kind="article"` + `href="#/a/<id>"`；成员页/收藏页
    摘要卡；note 卡行为不变。`postHref` 全量替换点由
    `rg postHref src/ui` 对表（TimelineFeed/ThreadPage/SearchPage/
    NotificationsPage/QuoteCard/ArticleEditor/ArticleDiscussion）。
- [x] P1-11. 文章内媒体：行内 `/api/media/<hash>` 图片走 `useMediaUrl`；
  article variant 点击图片打开 `ImageViewer`（单图）；静态模式相对路径；
  外链 https 图片 `no-referrer`+lazy；失败占位不报错。
  - 判据：A1/A10；单图查看器手势复用；静态归档图片可加载；外链失败显示占位。
  - 证据：`ArticleImage`（Markdown.tsx）包裹官方 Button → `viewer.open([ref])`；
  `src/ui/lib/article-media.tsx` 复用既有 `ImageViewer`；QA A2 实测
  `block-media` 点击后 `[data-testid="viewer-image"]` 出现（截图
  a2-1280-viewer.png）；QA A10 静态实测 `mediaImg.src` 以 `media/` 开头且
  `naturalWidth > 0`；外链图片 `referrerPolicy="no-referrer"` + `loading="lazy"`
  （MarkdownImage），失败给「图片不可用」占位（不抛错）。
- [x] P1-12. 无障碍/响应式：`<article>`/讨论区 `<section aria-label="讨论">`
  语义、标题层级、TOC 占位（P1 无 TOC 时不渲染空 nav）、390×844 与 1280×900
  无横向溢出、200% 字号、reduced-motion。
  - 判据：A14（TOC 项除外）；axe 无 critical；键盘可完成「打开文章→回复→
    讨论区回复行/子线程入口→返回」。
  - 证据：QA「A14 axe-core（WCAG 2.0/2.1 A+AA；文章页+编辑器）：0 critical」
    （axe-core 4.14 devDependency 真扫，critical=[]，serious 另记录）；
    QA「A14 无障碍 critical 子集」（可访问名/alt/唯一 h1/无重复 id/lang/
    aria-hidden 无聚焦元素/未渲染空 TOC nav）0 issues；QA「A14 键盘可完成
    『打开文章→回复→讨论区回复行→返回』」全链路键盘实测；QA「A14 390 全屏 +
    Tabs 无横向溢出」「A14 200% 字号无横向溢出」；讨论区 `<section
    aria-label="讨论">`、文章 `<article>`（QA a11y 子集断言）。
- [x] P1-13. `src/ui/pages/ComposePage.tsx` + `src/ui/components/ArticleEditor.tsx`
  （新）：`#/compose?format=article` 路由参数；整页编辑器；≥1024 左右分栏、
  <1024 官方 Tabs；`InputGroup` + `InputGroupTextarea`；草稿
  `report.draft.v1:article:root`；计数按 article 上限；**四块插入**
  （官方 DropdownMenu：stats/steps/compare/callout 模板）；提交
  `createPost({body, kind:"article"})`；成功 `navigate(/a/<id>)`。
  - 判据：A14；390 全屏 tabs、1280 分栏；草稿恢复/清除；双击只发一次；
    四块模板插入后预览可解析；静态模式只读；离开有未提交内容有确认。
  - 证据：QA「A14 1280 左右分栏 + 提交在 InputGroup + 计数按 512,000」；
  「A14 四块插入模板（stats）可解析 + 预览渲染」；「A14 草稿恢复（reload 后
  原文还在）与清空（清键）」；「A14 双击提交只发一次 POST /api/posts」
  （requests=1）；「A14 390 全屏 + 撰写/预览 Tabs，无横向溢出」；静态只读
  （ComposePage/ArticleEditor 静态分支 + QA A10 静态横幅）；离开确认
  （ArticleEditor LeaveGuard 合成条目 + Dialog `article-leave-confirm`）。
- [x] P1-14. 编辑器校验：`parseArticle` 防抖校验；错误面板每条列
  `line/block/fix`（一句话怎么修）；点击定位 textarea 行；`error` 禁止提交、
  `warning` 只提示；未知块/未知 status/tone/raw HTML 提示不阻止。
  - 判据：A14；坏 JSON/schema 错禁止提交并定位；错误面板含 line+block+fix；
    未知块可提交；未知 status 提示按 pending、未知 tone 提示按 info；raw HTML
    提示「不会被解释」；提交后服务端收到原文。
  - 证据：QA「A14 坏 JSON 禁止提交 + 错误面板 line/block/fix + 点击定位到行」
    （`第 3 行 · 块 #1`、`data-line=3`、`data-block=1`、fix 文案非空、
    `submit.disabled=true`、点击后 caret 落 ```` ```fde2e:stats ```` 行首）；
  warning 提示（未知块/未知 status→pending/未知 tone→info/截断）由
  `ArticleEditor` warningHint 文案映射 + `test/article-parse.test.ts` 的
  warning 语义断言；raw HTML 提示 `article-html-hint`；提交原文由
  QA「A2-模板」发帖往返（body 与 parseArticle 均 0 error）与 A12 插件
  file 提交实测。
- [x] P1-15. CLI：`src/cli/args.ts` 加 `file`/`format`（VALUE_FLAGS）；
  `src/cli/commands.ts` `cmdPost`/`cmdReply` 支持 `--file`/`--format`；
  batch JSONL `kind`；`USAGE` 更新；`outputCommit` 展示 kind。
  - 判据：A11；`--file` 与位置参数/`--stdin` 互斥；>2MiB 拒绝；
    `--format bogus` 报错；note 默认路径逐字不变；`bun test test/cli.test.ts`
    全绿并新增 article 用例。
  - 证据：`test/cli.test.ts`「CLI longform（report-longform A11/D13）」：
    post/reply `--file`+`--format article`、互斥（--file+位置参数/--stdin）、
    `--format bogus`、>2MiB 拒绝、batch JSONL kind、人类输出 `posted (article)`；
    QA A11 三条（post --file --format article → kind=article；--format bogus
    报错；人类输出 `posted (article)`）；note 默认路径由既有 cli 用例全绿覆盖
    （531 tests / 0 fail）。
- [x] P1-16. 插件（主仓）：`tools.mjs` `board_post`/`board_reply` 加
  `file`/`kind`/`format`/`article`（body 可选、body 与 file 恰好一个；
  `kind`/`format`/`article` 同义，缺省 note，冲突报错）；`callTool` 读文件、限 2MiB、
  传归一化后的 kind；`config.mjs` `postUrl` 按 kind、`summarizePost` 带 kind；
  `commands/board-report.md`/`skills/report-channel/SKILL.md` 增补。
  - 判据：A12；file+body 报错、两者都缺报错；`article:true` 与 `kind:"article"`
    都创建 article；`{kind:"note",article:true}` 报错且不发请求；article URL 为
    `#/a/<id>`；note 旧调用（只 body）行为不变；插件 README 工具表更新。
  - 证据（主仓 `plugins/report-channel/`，未在 workers 仓提交）：QA A12 实测
    `{file,format:"article"}`/`{file,kind:"article"}`/`{file,article:true}` 三者
    均 kind=article、URL 含 `#/a/`；`{kind:"note",article:true}` 报
    `conflicting kind/format/article`（发请求前抛错）；`file+body` 报
    "not both"；两者都缺报 "body or file is required"；`board_read` 返回值带
    kind；README 工具表与 0.4.0 版本段、`commands/board-report.md`、
    `skills/report-channel/SKILL.md` 均已增补长文流程。
- [x] P1-17. 报告模板：`plugins/report-channel/scripts/report-to-article.mjs`
  （新）：按 design §6.3 映射表把 steps.json 转 article Markdown，**P1 直接
  输出四块**——`fde2e:callout`（thesis）、`fde2e:stats`
  （summary/coverage 概览）、每节 `fde2e:steps`（expect/detail/command/
  output/media）、`imageBefore`+`image` 或 `sections[].compares[]` →
  `fde2e:compare`；`env`/`coverage` 用 Markdown 表格；截图进
  `steps[].media` 或普通 Markdown 图片；`logs` P1 回退 Markdown 代码块
  （P2 升级 log 块）；`--upload`/`--media-map`；确定性输出；代码 fence 动态
  长度。
  - 判据：A2（P1 四块）；同一 steps.json 两次输出 diff 为空；输出的块 JSON
    （stats/steps/callout，有 compares 时加 compare）均通过 `parseArticle`
    0 error；steps 的 degraded/skipped 不丢；env/coverage 是 Markdown 表格；
    坏块（人为改坏 JSON）在文章页降级不白屏；截图 `--upload` 后为
    `/api/media/<hash>` 且 article/静态归档可加载；compare before/after 两图
    并排可开 viewer；无 upload/map 时警告并输出普通链接；fence 注入测试；
    输出可被 `post --file --format article` 接受。
  - 证据（主仓文件；workers 侧 QA 实测）：QA「A2-模板」四条——
    ①同一 steps.json 两次 `--upload` 输出 diff 为空（bytes 一致）且
    `/api/media/<hash>` 引用 ≥3；②输出经 `parseArticle` 0 error，steps 状态
    含 degraded+skipped（4 步不丢），有 compare，fence 注入样本（command 内含
    ``` 与 `fde2e:callout` 字样）不破块；③env/coverage 为 Markdown 表格、
    logs 回退代码块；④无 `--upload/--media-map` 时 stderr 警告 + 输出普通
    链接（无 /api/media 引用）。⑤产出 article 发帖后文章页四块渲染
    （stats/steps/compare/callout 全在、steps=4、degraded=0、compare 并排
    2 侧、media `naturalWidth>0`）。坏块降级由 QA A3 实测（三处降级占位，
    其余正常）。此外收尾把本次交付报告 steps.json 用模板转成 `article.md`
    （`article-conversion.json`：ok、chars、media 引用数）。
- [x] P1-18. 静态：`src/ui/lib/static-api.ts` 加可选 `kind` 与 hydrate 默认
  note（含 quoted 回退分支补 `kind`）；`src/server/export.ts` 快照自然携带
  kind（既有 `read/read_at` 透传不改）；`ArticlePage`/摘要卡/四块/嵌入讨论区
  静态可用；`/a/<note>` 回退；0 网络 / 0 写。
  - 判据：A10；旧归档（无 kind）按 note；`file://` 打开 article 四块与讨论区
    正常、图片相对路径可用、请求数 0（含 `/api/reads*`）、localStorage 无
    `report.read*` 键、卡片无 `data-read`；静态写操作只读；
    `test/export-static.test.ts` 新增 kind/四块断言，旧断言不变。
  - 证据：`static-api.ts` hydrate 的 kind 兜底（含 quoted 手写快照分支）；
    `test/article-static.test.ts`（article kind / 旧归档默认 note / 引用视图
    kind 兜底 / 静态 thread 行 / 搜索命中，0 fetch）；`test/export-static.test.ts`
    新增两条（快照 kind+body_md 单一信源、**指令块媒体进快照 media 表**——
    后者为 QA 实证发现的缺口：块内 `/api/media/<hash>` 不在 post.media，
    导出需扫描正文补登，否则 file:// 图片永久加载不出）；QA A10 实测
    `blocks=7、degraded=3、discussionRows=2、readonly、dataRead=0、
    readKeys=[]、mediaCount≥1 且 img naturalWidth>0、src 相对路径、
    externalRequests=0`；QA「静态 /a/<note> 回退 /p/<note>」。
- [x] P1-19. 单测/绿门：`bun test`、`bun run check`、`bun run typecheck:ui`、
  `npx openspec validate report-longform --strict`；新增
  `test/article-{parse,http,export,ui}.test.ts` 或等价覆盖。
  - 判据：全绿；无 `any`；无 console error；`NOTIFICATION_TYPES` 未变；
    既有 note 用例 0 回归。
  - 证据：`bun test` → **531 pass / 0 fail**（54 文件）；`bun run check` →
    lints ok（cli 20 commands / 76 source files / 0 ui-lint 违例）；
    `bun run typecheck` 与 `bun run typecheck:ui` 均通过（根 tsconfig 为此新增
    `jsx`/`DOM.Iterable` 以纳入 `test/article-router.test.ts` 与 `router.tsx`
    的检查）；`npx openspec validate report-longform --strict` → valid；
    `bun run build` → 成功（dist 939KB/156KB）；
    `rg ": any|as any|any\[\]" 新增文件` → NO any；
    `git diff 90d0d4b..HEAD -- src/core/types.ts` 未触碰 `NOTIFICATION_TYPES`；
    QA 全流程 console.error/pageerror 0（收尾断言）。
- [x] P1-20. E2E/QA：`scripts/qa/report-longform.mjs` + 隔离后端 + Playwright
  覆盖 A1、A2（P1 四块）、A3、A4、A5、A6、A8、A9、A10、A11、A12、A13、
  A14；截图/请求记录落 `src/ui/.qa/longform/`（390/1280）。
  - 判据：全部 PASS（含 steps degraded/skipped、stats before→after/tone、
    callout items/code、compare viewport 不一致 warning 与 <860px 一次一张）；
    失败截图+响应状态留档；结束 kill 隔离服务并列 PID；生产板 0 写入；
    `steps.json` 可被 P1-17 模板转成 article 作为交付物。
  - 证据：QA 脚本最后一轮 **56/56 PASS / 0 FAIL**（44s；`results.json` 记录
    157 请求 + 157 响应 + 16 截图；隔离后端 port 13698 / pid 记录在案，
    finally `qa.stop()` 已回收）。覆盖：A5 上限×6、A8×8（feed/线程/搜索/
    通知/引用/成员页/收藏页）、A1×5（h1/讨论区/独立线程页入口/软删/回退）、
    A2×5（stats/steps/行内 MD/compare/窄屏）+ A2-模板×5、A3、A4×2、A9×3、
    A6×2（feed 首行 347ms/20 行/6 摘要/0 长任务；文章首屏 58ms）、
    A14×9（编辑器/axe/键盘流/子集）、A10×2、A11×3、A12、A13。
    判据对应：steps degraded/skipped ✅、stats before→after/tone ✅、
    callout items/code ✅、compare viewport 不一致 warning ✅ 与 <860px
    一次一张 ✅；失败即截图（`fail-NN.png`）+ 请求/响应留档；生产板零写入
    （qa-serve 拒绝生产 dataDir 与保留端口）；`steps.json` 已被 P1-17 模板
    转成 `article.md` 作为交付物（`article-conversion.json`）。截图/请求记录
    落 `src/ui/.qa/longform/`（默认 `--report-dir`），交付副本另置主仓
    `.agents/reports/manager/report-longform/`。
- [x] P1-21. 四块渲染件：stats/steps/compare/callout（design §3.2/§4.4）；
  官方 Card/Badge/Alert/Tabs 组合；`data-article-block` 标记；超限截断/警告；
  未知字段忽略；steps 五态 Badge、command/output pre 横向滚动、media 开
  viewer；stats `value` 与 `before→after`+unit/better 双形态、tone 与 PASS
  文字并存；compare ≥860 并排、<860 一次一张切换、viewport 不一致 warning、
  title 可访问名称、图片开 `ImageViewer`；callout items+code。
  - 判据：A2（P1 四块）；四块 390/1280 无溢出；组件来源可对表
    `src/ui/components/ui/*`；无硬编码 hex；schema 单测覆盖边界
    （0/超限/类型错）；坏块只降级该块；degraded/skipped 语义可见；
    compare 窄屏不出现上下两张巨图。
  - 证据：`ArticleBlocks.tsx` 全部走 `ui/card|badge|button|alert|tabs|skeleton`
    + lucide 单色图标；`data-article-block` 四块标记（QA 断言）；QA A2 实测：
    stats 4 列 + values `["95/95","1820 → 940ms"]` + delta `-48%` +
    `data-direction=better` + hint PASS；steps 五态 Badge
    `done,degraded,skipped,failed,pending`；`step-command` `overflow-x:auto`；
    media 点击开 viewer；compare ≥860 并排（`compare-grid`）+
    viewport 不一致 warning；<860 一次一张（`compare-switch` tabs、sides=1、
    无横向溢出）；callout body/items/code 齐；行内 MD（strong/code）实测；
    schema 边界（0/超限/类型错）见 `test/article-parse.test.ts`；
    坏块只降级该块（QA A3 count=3 且其余四块正常）；无硬编码 hex
    （`ui-lint 0 violations`）。
- [x] P1-22. 文章内嵌讨论区：`ArticleDiscussion`（新）复用 `client.thread` +
  `planForThreadView`（focal=article），只渲染 reply/subthread 行；从
  `ThreadPage` 抽出共享 `ThreadTimelineRows`（`TimelineRow` + PostCard
  reply/compact 变体、导轨、`回复给 @x`、删除占位、子线程入口）；
  顶部/底部「在独立线程页打开」；`ReplyComposer` 当前页回复；EventHub
  `post.created` 精确合并；article 根容器与回复卡共用既有 read-dwell 观察器与
  `markPostRead` 写路径（本地即时 + `report.readq` 异步批量写服务端
  `post_reads`），不新建 read-set、不直接发 `/api/reads`；静态模式只读展示
  既有回复、0 网络 / 0 写。
  - 判据：A1/A9/A10；讨论区与线程页的行度量/导轨/顺序一致（同一 planner）；
    大线程只出子线程入口；read-dwell 只注册一个 observer、已读只走既有队列；
    静态回复只读、无已读请求/存储；回复提交后新行并入、不整页刷新。
  - 证据：`ThreadTimelineRows.tsx` 抽取（ThreadPage 与 ArticleDiscussion 共用，
    几何常量单源）；`ArticleDiscussion` 用 `planForThreadView(thread, post.id)`
    过滤 reply/subthread 行；QA A1「嵌入讨论区（2 行 + rails=2 + 顶部/底部
    独立线程页入口）」；QA A9「read-dwell 复用既有观察器（observers ≤ 1）与
    写路径（服务端 post_reads 命中 owner 行）」；QA A10「讨论区只读 0 网络」；
    QA 键盘流「j 选中回复行 → Enter 打开 → 线程页返回」（本轮修复了被遮挡
    feed 抢占键盘导致的幽灵导航：`TimelineFeed` 用 `useSharedNamesActive`
    门控）；回复提交并入：`onPosted → load(false)` 重新取线程（不整页刷新，
    见 ArticlePage/ThreadPage 同形逻辑），EventHub `post.created`
    精确失效（`useEventHub` 订阅按 root_id/post_id 匹配）。

## P2. gallery/log、TOC/进度与导入

（本轮不做；下列保持不变）

- [ ] P2-1. `gallery` + `log` 块 schema 与渲染件（design §3.2/§4.4）：
  gallery WAI-ARIA carousel（方向键/「2 of 3」/焦点返回/静态横向滚动）；
  log 原生 `<details>/<summary>` + `<pre>`，默认收起、打印展开、浏览器搜索
  命中、`text` 纯文本不解析 MD、不内联脚本/样式；`data-article-block` 标记；
  超限截断/警告；未知字段忽略。
  - 判据：A2（gallery/log）；390/1280 无溢出；log 展开/收起不跳路由/
    滚动位置；gallery 键盘/计数/焦点返回正确；组件来源可对表
    `src/ui/components/ui/*`；无硬编码 hex；schema 单测覆盖边界
    （0/超限/类型错）。
- [ ] P2-2. TOC/锚点/阅读进度 + **Markdown 扩展（不做新块）**：自动 TOC 从
  Markdown headings 生成（不提供 toc 块）、slug 映射、`?s=<slug>` 深链、进度
  条 CSS 变量、active heading IntersectionObserver、reduced-motion 瞬切；
  `- [ ]`/`- [x]` task list、`[^1]` footnote、`![alt](src "caption")`
  figure/figcaption（parser/renderer 加性扩展）。
  - 判据：A7；重复标题 slug 正确；点击/深链标题不被吸顶头遮挡（±4px）；
    进度 0→1 单调；active 随滚动；一个 observer、无每帧 setState；task list
    只读 checkbox/aria-checked 正确；footnote 引用与文末定义对应、上限 50；
    figure caption 转义且不解析块级 MD；无 toc 块。
- [ ] P2-3. 编辑器 gallery/log 插入/图片/导入：官方 DropdownMenu 追加
  `gallery`/`log` 模板（四块已在 P1）；图片上传插入
  `![alt](/api/media/<hash>)`；拖拽 `.md` 导入（≤512k，确认覆盖）；
  复用 `useMediaUpload`。
  - 判据：gallery/log 插入可解析/预览；图片 hash 正确；导入不执行 HTML；
    大文件拒绝；390/1280 工具条不溢出。
- [ ] P2-4. 模板增强：`logs` → `fde2e:log`（P1 为 Markdown 代码块）；
  多图步骤（`steps[].images[]` 或 `sections[].gallery[]`）可输出
  `fde2e:gallery` 分组；四块输出已在 P1 固定（无独立开关）；旧 steps.json
  兼容。
  - 判据：log/gallery 输出通过 `parseArticle` 0 error；log 默认收起、
    gallery 媒体有效；同一输入确定性；旧 steps.json（无 compares/无
    gallery/logs）不报错。
- [ ] P2-5. 图集查看器：gallery 点击打开 `ImageViewer` 多图（左右滑动/计数/
  缩略条/键盘）；静态归档可用。
  - 判据：A2（gallery）/A10；多图手势与现有查看器一致；关闭不改路由/
    滚动位置。
- [ ] P2-6. P2 验收：A2（gallery/log）、A7 与 A1/A14 的 Markdown 扩展/TOC
  相关断言全绿；更新 `src/ui/.qa/longform/` 截图与 `steps.json`。
  - 判据：全部 PASS（含 log 原生 details 默认收起/打印展开/搜索命中、
    gallery WAI-ARIA、task list/footnote/figure、自动 TOC）；无回归
    （P1 用例仍绿）。

## P3. 打印与独立 HTML 导出

（本轮不做；下列保持不变）

- [ ] P3-1. 打印样式：`@media print` 隐藏导航/进度/操作栏/评论入口；
  正文全宽、图不截断、标题分页控制、黑白可读。
  - 判据：Chrome print preview 390/1280 无溢出/无交互件；链接 URL 可打印。
- [ ] P3-2. 单篇独立 HTML 导出：同一 `ArticleBody` 渲染 + 内联 CSS/媒体，
  供外链审计报告；`file://` 离线可读；不含编辑器/壳。
  - 判据：导出 HTML 0 网络；图片相对路径可用；与在线 article 视觉一致；
    不引入第二套渲染器。
- [ ] P3-3. 文档/归档：回填实测数字（512KB 解析/渲染耗时、feed 性能、静态
  体积），更新 `report-social`/`report-surface`/`report-composer`/
  `report-app-ui`/`report-static-mode`/`report-protocol`，
  `npx openspec validate report-longform --strict`，归档 change。

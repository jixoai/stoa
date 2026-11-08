# Design: report-longform（Markdown 长文章 + 白名单指令块）

> 一句话：**article 仍是同一种帖子实体**（`kind` 区分载体），正文仍是 Markdown；
> 结构化展示只走 **fenced 指令块**（` ```fde2e:<name> ` + JSON），解析在 core、
> 渲染在 React（逐 token，不拼 HTML）、静态导出复用同一渲染器。
> 不开放任意 HTML，不新增第二套内容存储。

---

## 0. 决策摘要

| # | 决策 | 理由 | 被否方案 |
|---|------|------|----------|
| D1 | `Post.kind: "note" \| "article"`，默认 `note`，创建后不可改 | article 只是同一种帖子实体的载体；线程/引用/可见性/通知零改动 | 新建 articles 表/独立内容类型 |
| D2 | note 上限 200,000 字符；article 上限 512,000 字符 | 与现有 `MAX_BODY_CHARS` 同口径（JS 字符串长度）；只放宽 article | 全帖统一放宽（短帖也失去保护） |
| D3 | schema v6：`posts.kind TEXT NOT NULL DEFAULT 'note'`，`hasColumn` 守卫补列 | 旧库零拷贝升级；旧数据自动 note | 重建表/数据迁移脚本 |
| D4 | 三载体：note / article / 外链 HTML 审计报告 | HTML 报告继续独立托管，article 内用链接卡指过去；不把 HTML 塞进正文 | 内嵌任意 HTML / iframe |
| D5 | 结构化展示＝fenced 指令块，info string 保留命名空间 `fde2e:<name>`，body 必须是 JSON 对象 | 普通代码块不受影响；可 schema 校验；跨端同一份解析 | 自定义 HTML 元素 / MDX / 富文本 JSON 文档 |
| D6 | raw HTML 一律当文本（React 文本节点 / SSG `escapeHtml`），全仓禁用 `dangerouslySetInnerHTML` | 安全底线；现有渲染器本来就是逐 token | 白名单 HTML 清洗器（仍需维护解析器） |
| D7 | 解析器放 `src/core/article.ts`，服务端/客户端/静态共用 | 单一实现；导出不需要预渲染 HTML | 服务端存 HTML / 两套解析 |
| D8 | 未知块、坏 JSON、schema 不匹配一律**安全降级**（可见占位 + 原文转义），永不抛异常 | 前向兼容；旧客户端/新块不会白屏 | 整篇拒绝渲染 |
| D9 | 文章阅读是独立路由 `#/a/<id>`：正文 + **正文下方嵌入讨论区**；`#/p/<id>` 仍保留为独立线程页 | 与 X/长文阅读一致、少一次跳转；深链/大线程仍有独立线程页；正文不在 ThreadPage 内联全文 | 只给「讨论 → 线程页」分离入口 / 在 ThreadPage 里内联全文 |
| D10 | `PostCard` 永不渲染 article 全文，只渲染摘要卡 | feed/线程/搜索/通知不因 512KB 正文卡死；滚动位置稳定 | 列表里渲染全文再截断 |
| D11 | 标题/TOC 锚点用确定性 slug（冲突加 `-2/-3`），H2/H3 入 TOC | 同一文档多端一致；重复标题不丢锚点 | 随机 id / 只取第一个标题 |
| D12 | 编辑器是独立全屏页 `#/compose?format=article`，桌面分栏/移动 tab | 复用现有 composer 纪律（草稿/计数/提交/只读） | 弹窗里塞长文编辑器 |
| D13 | CLI `--file`/`--format`；批量 JSONL `kind`；MCP `file`/`format` | 代理交付报告的主路径；与现有 CLI 风格一致 | 只支持 stdin / 只支持网页 |
| D14 | 报告模板 `steps.json → article markdown`，**P1 直接输出 stats/steps/compare/callout 四块**；gallery 与 TOC/进度 P2 | Owner 原话要求模板直接产出结构化报告；纯 Markdown 表格达不到目的 | P1 纯 Markdown、P2 再升级 |
| D15 | 静态快照只带 `kind` + `body_md`，块由客户端解析 | 快照不存 HTML/重复块数据；单一信源 | 导出预渲染 HTML / 另存 blocks 数组 |
| D16 | 通知/未读/已读/事件类型零改动 | article 发帖仍是 `post.created`；不新增通知语义 | 新增 `article.created` 事件 |
| D17 | 图片/图集复用 `media` + `useMediaUrl` + `ImageViewer` | 现有内容寻址、静态相对路径、查看器手势全部复用 | 新图片管线 |
| D18 | 性能预算：列表 20 帖含长文 <300ms；文章首屏 <300ms；长任务 <50ms | 长文不能拖垮列表；摘要卡隔离全文 | 无预算 |
| D19 | 无障碍：语义 `<article>/<nav>`、唯一 H1、TOC 键盘可达、reduced-motion 瞬切 | 交付级要求 | 只做视觉 |
| D20 | P1 载体/阅读/嵌入讨论区/四块（stats/steps/compare/callout）/编辑/静态/工具链；P2 gallery/TOC/进度/导入；P3 打印/HTML 导出 | Owner 拍板：P1 模板必须直接产结构化块；P1 先解决「不再手写 HTML」 | 一次做完 |

---

## 1. 现状与接入点（path:line）

### 1.1 帖子实体与写入

- `Post`：`src/core/types.ts:21-37`（无 `kind`）；`PostView`：`:169-177`；
  `ThreadNode extends PostView`：`:179-187`；`QuotedView`：`:139-148`（无 `kind`）。
- `PostOp`/`ReplyOp`/`WriteOp`：`src/core/types.ts:116-137`。
- 正文校验：`MAX_BODY_CHARS = 200_000`（`src/core/validation.ts:6`）、
  `assertBody`（`:70-78`）、`validateWriteOp`（`:136-169`）。
- 写入事务：`commitOps`（`src/server/store.ts:706-912`）；根帖 INSERT
  `:788-802`，回复 INSERT `:838-853`；`PostRow extends Omit<Post,"tags">`
  `:89-91`；`toPost` 原样展开行 `:180-183`。
- 读投影：`hydratePosts`（`src/server/store.ts:1058-1222`）；引用视图在
  `:1194-1210` 组装 `QuotedView`；软删 `:1791`；导出用
  `visiblePostsForExport` `:2279`。
- HTTP：`readJson`（`src/server/http.ts:94-105`）、`POST /api/posts`
  `:644-661`、`POST /api/posts/:id/replies` `:662-679`。

### 1.2 Markdown 与渲染

- `Block` 联合：`src/core/markdown.ts:15-22`；`escapeHtml` `:24-31`；
  `isSafeHref` `:33-35`；`parseInline` `:37-134`；`parseMarkdown`
  `:143-242`；fenced code 解析保留 info string 为 `lang` `:163-175`；
  `renderMarkdownHtml` `:267-300`（SSG/测试用）。
- UI 渲染：`Markdown` 组件 `src/ui/components/Markdown.tsx:297-314`；
  `renderBlock` `:205-294`；代码块 `:255-263`；表格（横向滚动）
  `:264-290`；图片 `MarkdownImage` `:11-35`（`/api/media/<id>` 走 blob）。
- feed 截断：`PostCard` 的 `longBody`/`clamped` `src/ui/components/PostCard.tsx:95-97`、
  正文 `:241-249`；自接分支 `:131-183`；操作栏 `:272-377`。
- 详情页 focal：`src/ui/pages/ThreadPage.tsx:979-1030`（`PostCard variant="focal"`，
  全文不截断）；打开帖子入口 `:854`。

### 1.3 编辑器

- `PostComposer`：草稿 localStorage `src/ui/components/PostComposer.tsx:102-123`；
  撰写/预览 tab 与 200,000 计数 `:495-508`；提交 `:416-468`；静态只读
  `:470-481`。
- 发帖页：`ComposePage` `src/ui/pages/ComposePage.tsx:11-99`；回复编辑器
  `ReplyComposer` `src/ui/components/ReplyComposer.tsx:38-46`、复用 composer
  `:82-95`。
- 输入区规范：官方 `InputGroup`（`report-app-ui` 既有 Requirement）。

### 1.4 路由与壳

- `Route` 联合/解析/路径/深度：`src/ui/lib/router.tsx:20-51`、`:53-72`、
  `:118-125`；详情覆盖层 `DetailView` `src/ui/components/AppShell.tsx:39-50`、
  渲染 `:110-122`。
- 所有「打开帖子」硬编码 `/p/<id>`：`TimelineFeed.tsx:417`、
  `ThreadPage.tsx:847,854`、`SearchPage.tsx:114`、`NotificationsPage.tsx:192,201`。
- 平铺 timeline planner 已是共享纯函数：`planForThreadView`
  `src/ui/lib/thread-plan.ts:222-260`（`buildTimelinePlan` `:100-215`）；
  ThreadPage 行渲染 `ThreadPage.tsx:904-1030`（`TimelineRow` `:82-152`）。
  文章内嵌讨论区复用同一 planner 与行渲染。

### 1.5 静态导出

- `SnapshotPost extends Omit<PostView,"media"|"quoted">`
  `src/server/export.ts:65-68`；`Snapshot` `:81-94`；`safeJson` 转义 `<`
  `:96-101`；`buildSnapshot` `:142-200`；`injectSnapshot` `:206-212`；
  `runExport` `:248-316`。
- 静态客户端：`SnapshotPost` `src/ui/lib/static-api.ts:53-75`；
  `ReportSnapshot` `:77-90`；`hydrate` `:287-336`；`installStaticApi`
  `:827-829`；`staticMediaUrl` `:765-771`。

### 1.6 CLI / 插件 / 报告模板

- CLI 入口 `src/cli/main.ts:1-53`；flag 白名单 `src/cli/args.ts:24-56`；
  `cmdPost` `src/cli/commands.ts:566-584`；`cmdReply` `:585-604`；
  JSONL 批处理 `:605-716`；`API_ROUTES`/`CLI_COMMANDS`
  `src/core/protocol.ts:11-77`；`Capabilities` `:79-100`。
- 插件（主仓）：`board_post` schema `plugins/report-channel/scripts/lib/tools.mjs:8-22`、
  实现 `:112-119`；`board_reply` `:24-36`；`api` `config.mjs:70-102`；
  `postUrl`/`summarizePost` `config.mjs:104-118`。
- steps.json 契约（既有 e2e-report-gen）：`fde2e-center-v0/scripts/e2e-report-gen.mjs:13-40`
  （`title/brand/subtitle/meta/thesis/env/sections[].{title,note,steps[]}`，
  step＝`id/intent/expect/command/reply/assertion/ok/image/imageMeta`）。

---

## 2. 数据模型

### 2.1 契约

```ts
export type PostKind = "note" | "article";

export interface Post {
  // …既有字段…
  /** 载体：短帖（默认）/ 长文。创建后不可改。 */
  kind: PostKind;
}

export interface PostView extends Post { /* …既有… */ }

export interface QuotedView {
  // …既有字段…
  /** 被引用帖的载体；引用卡据此显示摘要而不是全文。 */
  kind: PostKind;
}

export interface PostOp {
  op: "post";
  // …既有…
  /** 默认 note；article 允许 512,000 字符正文。 */
  kind?: PostKind;
}

export interface ReplyOp {
  op: "reply";
  // …既有…
  kind?: PostKind;
}
```

- `kind` 只允许 `"note" | "article"`；缺省 `note`；未知值 `BAD_REQUEST`。
- **article 可以是根帖或回复**：回复长文在时间线里同样显示摘要卡，点开进文章视图；
  不限制「只有根帖能长」。
- `kind` 创建后不可变（无编辑 API）；删除/软删语义不变。
- 引用：`QuotedView.kind` 由服务端 hydrate 时从被引用行带出；引用卡对 article
  显示标题 + 摘要 + 「长文」，不渲染全文（`QuoteCard` 现在用 line-clamp-3 渲染
  `body_md`，article 分支改为摘要）；整卡链接用 `postHref(quoted)`（article →
  `#/a/<id>`，note → `#/p/<id>`）。

### 2.2 上限

| 载体 | 字符上限 | 说明 |
|------|----------|------|
| `note` | 200,000（`MAX_BODY_CHARS` 不变） | 现有行为，短帖防滥用 |
| `article` | 512,000（`MAX_ARTICLE_CHARS`） | 产品口径「512KB」；与现有计数同口径（JS 字符串长度/UTF-16 码元） |

- 追加**字节护栏**：article 正文 UTF-8 字节数 > **2 MiB**（`MAX_ARTICLE_BYTES`）时
  同样 `BAD_REQUEST`（防 512k 四字节字符/JSON 转义放大内存）。用
  `new TextEncoder().encode(body).length`（core 跨端可用）。
- `assertBody(body, kind = "note")` 扩展签名；`validateWriteOp` 与 HTTP 入口都传
  `kind`。错误文案：`body too long (max 512,000 chars for article)` /
  `body too large (max 2 MiB utf-8 for article)`。
- 编辑器计数条按当前 kind 显示上限；note 仍显示 200,000。

### 2.3 schema v6 迁移

```sql
-- 新库：posts 建表语句直接包含
kind TEXT NOT NULL DEFAULT 'note'

-- 旧库（hasColumn 守卫，幂等）
ALTER TABLE posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'note';
```

- `SCHEMA_VERSION = 6`（`src/server/db.ts:49`）；`hasColumn` 已有
  （`:51-54`）；补列放在 tags 补列同一段（`:242-244` 之后）。
- 不建索引：所有读路径按 `id/parent_id/root_id/created_at` 取，`kind` 只参与
  渲染分支；不新增 `WHERE kind` 查询。
- 不写 CHECK 约束：SQLite `ALTER TABLE ADD COLUMN` 的约束能力有限，且 `kind`
  由 core 校验；DB 层只保证默认值。
- 迁移幂等：重复 `migrate()` 不重复 ALTER；`meta.schema_version` 更新
  （`:322-325`）。
- 旧数据：全部自动 `note`；`SELECT *` 行带 `kind='note'`，`toPost` 原样展开。

### 2.4 写入与读投影

- `commitOps` 根帖 INSERT（`store.ts:788-802`）与回复 INSERT（`:838-853`）
  增加 `kind` 列；值来自 `op.kind ?? "note"`（`validateWriteOp` 已归一化）。
- `PostRow`（`:89-91`）随 `Post` 自动获得 `kind`；`toPost`（`:180-183`）无需改。
- `hydratePosts`（`:1058-1222`）无需改：`PostView` 由 `...post` 带出 `kind`；
  引用视图组装处（`:1194-1210`）补 `kind: visibleQuoted.kind`。
- 草稿：`items_json` 直接序列化 `WriteOp`，`kind` 随 op 保存/恢复
  （`src/core/drafts.ts:16-23` 只是 JSON parse/serialize）。
- 批量 JSONL：每行 `"kind":"article"` 生效；`validateWriteOp` 归一化；无 kind
  默认 note。
- 软删（`store.ts:1791`）：无改动（正文置空逻辑已在 hydrate 里按 `deleted_at`）。
- 事件：article 发帖仍写 `post.created`；不新增事件类型，`NOTIFICATION_TYPES`
  不变（`src/core/types.ts:81`）。

### 2.5 静态快照

- `SnapshotPost` 是 `Omit<PostView,...>`，`kind` 自动进入快照；`buildSnapshot`
  的 `...post` 展开（`export.ts:161-165`）无需改。
- `static-api.ts` 的 `SnapshotPost` 加可选 `kind?: PostKind`；`hydrate` 默认
  `kind: post.kind === "article" ? "article" : "note"`（旧归档缺字段 → note）；
  手写快照的 quoted 回退分支同样补 `kind`。
- 快照**不存**预渲染 HTML、不存 blocks 数组：块就在 `body_md` 的 fenced 内容里，
  客户端用同一 `parseArticle` 解析（单一信源，见 D15）。

---

## 3. 指令块语法与安全

### 3.1 语法

````markdown
```fde2e:stats
{
  "items": [
    { "label": "断言", "value": "95/95", "hint": "PASS" },
    { "label": "耗时", "value": "3m12s" }
  ]
}
```
````

- **命名空间**：fenced code 的 info string 必须精确匹配
  `^fde2e:([a-z][a-z0-9-]{0,31})$` 才是指令块。` ```js ` / ` ```json ` /
  ` ```text ` 等普通代码块行为不变。
- **body 必须是单个 JSON 对象**（`{...}`），不允许数组/标量/尾随文本；
  前后空白允许。JSON 用 `JSON.parse`（不执行、不 eval）。
- **fence 长度**：支持 3 个及以上反引号；闭合 run 长度 SHALL ≥ 开启 run（3 反引号
  的旧行为不变，4 反引号块可安全包含 ``` 示例）。指令块推荐用 4 反引号，
  避免 JSON 字符串里的代码示例提前闭合。
- **位置**：指令块只能出现在文档顶层（现有 `parseMarkdown` 本来就不嵌套块）；
  带前导空格的 fence 不被识别为指令块（按现有 markdown 规则作为普通段落文本）。
- **数量/体积**：每篇 article 最多 200 个指令块；单块 JSON ≤16 KiB；整篇仍受
  512,000 字符上限约束。
- **未知命名空间**：` ```fde2e:unknown ` 或未知 `name` → 降级块（见 3.4），
  不当作代码执行、不丢失内容。
- **普通 fenced code 含 `fde2e:` 字样**：只有 info string 精确匹配才升级；
  正文里的 `` `fde2e:stats` `` 行内代码不受影响。
- **嵌套**：块 JSON 内不再包含 fenced 内容；`gallery`/`compare` 的媒体用
  `/api/media/<hash>` 引用，不内嵌 base64。

### 3.2 块 schema（白名单）

所有块共享：未知字段忽略（前向兼容）；字符串字段按字符截断；数组超限截断并记
`warning`；类型不符记 `error`。**P1 交付 `stats`/`steps`/`compare`/`callout`
四块的 schema 与渲染**（报告模板必需）；`gallery` 与 TOC/阅读进度仍按 P2：

| name | 阶段 | 字段 | 约束 |
|------|------|------|------|
| `stats` | P1 | `items: [{ label, value, hint? }]` | 1..8 项；label ≤40、value ≤32、hint ≤80 |
| `steps` | P1 | `steps: [{ title, status?, detail? }]` | 1..50 项；title ≤120；status ∈ `done/active/pending/failed`（缺省 `pending`）；detail ≤500（行内 markdown） |
| `compare` | P1 | `before: MediaSide`、`after: MediaSide`、`title?`、`note?` | 两侧必填；`MediaSide = { media, label?, caption? }`；media 必须 `/api/media/<64hex>`；label/caption ≤200 |
| `callout` | P1 | `tone?`、`title?`、`body` | tone ∈ `info/warn/success/danger`（缺省 `info`）；title ≤80；body ≤2000（行内 markdown） |
| `gallery` | P2 | `items: [{ media, alt?, caption? }]` | 1..12 项；media 同上；alt/caption ≤200 |

- `MediaSide.media` 与 `gallery.items[].media` **只接受**
  `/api/media/[a-f0-9]{64}`；不接受外链、相对路径、`data:`、`javascript:`。
- `steps.detail`/`callout.body` 只走 `parseInline`（粗体/斜体/行内代码/链接），
  不解析块级 Markdown，避免块内再嵌套块。
- 新增块只加 schema 分支，不改语法/路由/静态快照；旧客户端把新块当未知块降级。

### 3.3 解析 API（core）

```ts
// src/core/article.ts —— 纯函数，服务端/客户端/静态共用
export type BlockIssue = {
  severity: "error" | "warning";
  /** 块在文档中的序号（1-based，用于编辑器定位） */
  block: number;
  /** 块起始行（1-based） */
  line: number;
  message: string;
};

export type ArticleNode =
  | { kind: "markdown"; block: Block }
  | {
      kind: "directive";
      name: string;
      raw: string;          // 块 body 原文（转义后展示）
      data: unknown | null; // 校验通过后的结构化值；失败为 null
      issues: BlockIssue[];
      line: number;
    };

export interface ArticleHeading {
  level: 2 | 3;
  text: string;   // 纯文本
  id: string;     // slug，已去重
  /** 在 markdown heading 序列中的序号（0-based） */
  index: number;
}

export interface ArticleStats {
  title: string;
  excerpt: string;
  minutes: number;
  chars: number;
  headings: number;
  directives: number;
}

export interface ArticleDoc {
  nodes: ArticleNode[];
  headings: ArticleHeading[]; // 只收 H2/H3
  stats: ArticleStats;
  issues: BlockIssue[];
}

export function parseArticle(markdown: string): ArticleDoc;
export function articleSummary(markdown: string): ArticleStats;
```

- 实现：先 `parseMarkdown(markdown)`；再顺序扫描 `Block[]`：
  - `code` 且 `lang` 匹配 `^fde2e:` → 解析 JSON + schema → `directive` 节点；
  - 其它 block 原样 → `markdown` 节点。
  - 为错误定位，`parseMarkdown` 的 code block MAY 增加可选 `line`（fence 起始行，
    1-based；note 渲染忽略该字段）。
- **标题**：仅当**第一个非空 block 是 H1** 时用其纯文本；否则取第一段纯文本前
  60 字；仍为空 → `"长文"`。作为标题的 H1 在 `ArticleBody` 中跳过（页面标题块
  已渲染）；其余位置的 H1 一律降级为 h2 视觉。
- **摘要**：标题之后第一个非空段落的纯文本前 140 字（超出加 `…`）；无段落时取
  第一个非标题 block 的纯文本。
- **阅读时长**：`chars`＝所有文本/行内代码/代码块字符数（不含 fenced 指令块的
  JSON 原文）；`minutes = clamp(ceil(chars / 400), 1, 99)`。
- **纯文本**：`InlineToken` 递归拼接 text/code；`strong/em/link` 取 children；
  `image` 取 alt。避免用正则剥 Markdown（会误伤 CJK/标点）。

### 3.4 降级与安全

| 情况 | 行为 |
|------|------|
| 未知 `fde2e:<name>` | 渲染官方 `Card` 占位：Badge「不支持的区块」+ 块名 + `<pre>` 原文（转义）；`data-article-block="unknown"` |
| JSON 解析失败 | 同上，文案「区块内容不是合法 JSON」+ 行号 |
| schema 不匹配 | 同上，列出首条错误；编辑器把该块标红并禁止提交 |
| 块超限（数量/体积） | 超出部分按未知块降级并记 `warning` |
| raw HTML | 全部按文本渲染：React 文本节点；SSG `escapeHtml`。`<script>`/`<iframe>`/`<style>`/事件属性永不进入 DOM |
| `javascript:`/`data:`/`vbscript:`/`file:` URL | `isSafeArticleHref` 拒绝，保留原文文本 |
| 外链图片 | 只允许 `https?:`；`referrerPolicy="no-referrer"` + `loading="lazy"`；静态离线可能加载失败（占位，不报错） |
| 块内 media | 只允许 `/api/media/<64hex>`；不存在时 `useMediaUrl` 给占位 |

- **URL 规则**（article）：
  - 行内链接：`https?:` 或 `#anchor`；其余一律文本。
  - 行内图片：`https?:` 或 `/api/media/<64hex>`；其余文本。
  - 指令块 media：仅 `/api/media/<64hex>`。
  - 外链统一 `target="_blank" rel="noreferrer noopener"`；页内锚点不新开。
- **article 行内过滤**：`parseInline` 保持现有 note 行为不变；article 渲染前对
  `InlineToken` 做 scheme 过滤（link 仅 `https?:`/`#`，image 仅 `https?:`/
  `/api/media/<64hex>`），不合格 token 还原为文本。指令块内的 `detail`/`body`
  走同一过滤后的 `parseInline`。
- **禁用**：`dangerouslySetInnerHTML`、`innerHTML`、`eval`、`new Function`、
  远程脚本/iframe、`<style>` 注入。渲染器只输出 React 元素。
- **快照注入**：`safeJson` 已转义 `<`/U+2028/U+2029（`export.ts:96-101`），
  `</script>` 不会截断内联 JSON；article 正文同样受益。
- **服务端不解析块**：`assertBody` 只校验长度/类型；块 schema 是渲染契约。
  服务端不执行、不存储 HTML，写路径保持 <200ms。

### 3.5 锚点算法

1. 取 heading 的纯文本（同 3.3 的纯文本函数）。
2. `normalize("NFKC")` → `toLowerCase()`。
3. 把空白与标点（非 `[a-z0-9\u4e00-\u9fff-]`）替换为 `-`，合并连续 `-`，
   去首尾 `-`，截断 64 个码点。
4. 空串 → `section`。
5. 去重：第一次用原 slug；之后 `slug-2`、`slug-3`…（按文档顺序）。
6. 只给 H2/H3 分配 id；H1 是标题，不参与 TOC。
7. `ArticleHeading.index` 是该 heading 在**全部 heading block（H1–H6）**中的
   0-based 顺序；渲染与 TOC 共用该映射。`Markdown` article variant 对每个
   heading block 递增计数，仅当原始 level 为 2/3 时取 `headingIds[index]`，
   保证重复标题与 H1 降级后仍然一致。

---

## 4. 阅读（article view）

### 4.1 路由

- `Route` 增加 `{ name: "article"; id: string }`（`router.tsx:20-28`）。
- `parseHash`：`segments[0] === "a" && segments[1]` → article（在 `p` 分支旁）。
- `routePath`：`/a/<encodeURIComponent(id)>`；`routeKey`：`article:<id>`；
  `routeLabel`：`长文`；`routeDepth`：1（详情层）。
- 深链：既有 `initHistory` 的「根 → 子页」合成栈自动适用（`router.tsx:177-206`）。
- `AppShell.DetailView` 增加 `case "article": return <ArticlePage />`。
- `postHref(post)`：`post.kind === "article" ? /a/<id> : /p/<id>`；所有「打开帖子」
  入口改用它（`TimelineFeed.tsx:417`、`ThreadPage.tsx:847,854`、
  `SearchPage.tsx:114`、`NotificationsPage.tsx:192,201`、`QuoteCard.tsx` 的整卡
  链接）。卡片上的回复入口仍用 `/p/<id>?reply=1`（讨论页）；文章页自身的回复
  用当前页 `ReplyComposer`（§4.2）。

### 4.2 页面结构

```text
ArticlePage
  <div h-full flex-col>
    <ArticleHeader>            // 返回 + 来源 + 顶部「在独立线程页打开」；sticky
      <ProgressBar />          // P2：2px，role=progressbar，CSS 变量更新
    </ArticleHeader>
    <div data-testid="article-scroll" overflow-y-auto>
      <div max-w-[68ch] mx-auto px-4 data-post-id={post.id}>
        <header>
          Badge 长文 · H1 标题
          <AuthorLine/> · 时间 · 约 N 分钟 · TagChips
        </header>
        <ArticleBody doc />     // prose + P1 四块
        <footer>
          reply / quote / bookmark / copy
          「在独立线程页打开 · N 条回复」→ #/p/<id>
        </footer>
      </div>
      <ArticleDiscussion post={post} thread={thread}/>  // 正文下方嵌入
        header: 「讨论 · N 条回复」 + 「在独立线程页打开」
        reply-open → ReplyComposer（复用）
        <ThreadTimelineRows rows={replyRows}/>          // 复用平铺 timeline
      <ArticleToc />           // P2：xl 右侧 sticky；移动端 Sheet
    </div>
  </div>
```

- **标题**：`doc.stats.title` 渲染为唯一 `<h1>`；正文里的 H1 不再重复（若首个
  block 是 H1，`ArticleBody` 跳过它；H1 在文中段仍按 h2 级视觉渲染，避免多 H1）。
- **作者/时间/标签**：复用 `AuthorLine`/`TagChips`/`fullTime`；阅读时长来自
  `articleSummary`。
- **操作**：回复 SHALL 在当前页打开 `ReplyComposer`（复用现有 Dialog/提交纪律，
  不跳页）；引用 → `#/compose?quote=<id>`；收藏复用 `useBookmarks`；复制链接复用
  `copyText(postLink(id))`；静态模式写操作给 `toastReadOnly`。
- **嵌入讨论区（P1）**：
  - `ArticlePage` 用 `client.thread(post.id)` 取线程（与 ThreadPage 同接口），
    `planForThreadView(view, post.id)` 生成平铺计划；讨论区只渲染
    `role === "reply"` 的行与 `subthread` 入口（article 本体已在上方，不重复
    focal/ancestor 行）。
  - **复用平铺 timeline**：把 ThreadPage 的行渲染（`TimelineRow` + `PostCard`
    reply/compact 变体 + 导轨/「回复给 @x」/删除占位/子线程入口）抽成共享
    `ThreadTimelineRows`；ArticleDiscussion 与 ThreadPage 共用，禁止第二套度量。
  - 顶部与底部各有一个「在独立线程页打开」链接到 `#/p/<id>`；深链/大线程/查看
    完整祖先仍走独立线程页。article 本身是回复时，讨论区上方显示「查看上文」
    链接到 `#/p/<id>`。
  - 实时：沿用线程页的 EventHub `post.created` 精确失效/合并逻辑（不新开连接、
    不整页刷新）；新回复按既有线程页规则并入。
  - **read-dwell 共存**：article 根容器带 `data-post-id`（及 read-dwell 的
    `data-read`），回复行是普通 `PostCard`；共用 read-dwell 的全局观察器/注册
    入口，禁止另建第二个 observer。静态归档不启用观察器。
  - 静态：`StaticReportClient.thread` 从快照返回既有回复；讨论区只读展示，
    `ReplyComposer` 显示只读提示，0 网络请求。
- **删除/不可见**：软删显示「此帖已删除」占位；404/不可见显示错误 Alert +
  返回；`/a/<noteId>` 自动 `replace` 到 `/p/<noteId>`（不留死路由）。
- **长文在 `/p/<id>`**：ThreadPage 的 focal 仍用 `PostCard`，article 分支渲染
  摘要卡 + 「阅读全文」按钮；不渲染全文（D10）。

### 4.3 摘要卡（feed / 线程 / 搜索 / 收藏 / 通知）

- `ArticleSummaryCard`（组合官方 `Card`/`Badge`/`Button`，文件头注明官方件来源）：
  - 第一行：`Badge`「长文」+ 标题（最多 2 行，`line-clamp-2`）；
  - 摘要：`doc.stats.excerpt` 最多 2 行；
  - 元信息：`约 N 分钟 · M 个章节`（可选）；
  - 整卡可点（沿用 `PostCard` 的 `onOpen`/`postHref`）；右下「阅读全文」文字按钮。
- `PostCard` 分支：`post.kind === "article"` 时，正文槽位渲染
  `<ArticleSummaryCard post={post}/>`，**不再**执行 `longBody`/`clamp` 逻辑；
  媒体/引用/预览/标签/操作栏保持原顺序。
- 自接分支（`PostCard.tsx:131-183`）同样用摘要卡（article 回复可能出现在自接链）。
- 摘要卡只解析一次：`useMemo(() => articleSummary(post.body_md), [post.body_md])`；
  同帖多卡共享 `articleSummary` 的纯函数结果（可按 body 哈希做小 LRU，P2 可选）。
- 通知行：`NotificationsPage` 的标题/摘要若取 `body_md`，对 article 用
  `articleSummary().title/excerpt`；点击走 `postHref`。

### 4.4 prose 与组件收编

- `Markdown` 增加 `variant?: "default" | "article"` 与 `headingIds?: string[]`；
  `ArticleBody` SHALL 复用 `parseArticle` 已得到的 `Block[]`（`Markdown` 增可选
  `blocks` 或拆出 `MarkdownBlocks`），SHALL NOT 对同一正文二次 `parseMarkdown`。
  - article：正文 17/28、H2 24/32、H3 20/28、段间距 1em、列表/引用/表格/代码
    与现有 token 一致但更宽松；表格外层 `overflow-x-auto`；代码块
    `overflow-x-auto`；图片 `max-w-full` + 圆角；链接用 `text-link`。
  - **H1 降级**：article variant 把正文中的 H1 一律渲染为 `<h2>` 视觉（页面唯一
    `<h1>` 由 `ArticlePage` 的标题块提供），避免多 H1/标题层级跳级；H2/H3 保持。
  - 颜色/间距全部主题令牌（`text-foreground`/`text-muted-foreground`/
    `border-border`/`bg-muted`），禁硬编码 hex。
- 指令块渲染：**P1 四块**（stats/steps/compare/callout）＋ **P2 gallery**：
  - `stats`（P1）：官方 `Card` 网格（2 列移动 / 4 列桌面）；
  - `steps`（P1）：有序列表 + 官方 `Badge` 状态（done/active/pending/failed）；
  - `compare`（P1）：两张官方 `Card` 并排（移动堆叠），before/after 标签 +
    caption；两侧图片走 media/viewer；
  - `callout`（P1）：官方 `Alert` + `AlertTitle`/`AlertDescription`，tone 只换
    lucide 单色图标与 `data-tone`；
  - `gallery`（P2）：官方 `Carousel`（既有收编件）或网格 + 点击 `ImageViewer`；
    与 link-preview 的 Carousel 用法一致（一页一张/指示点/键盘）。
- 图片：P1 行内 Markdown 图片与 `compare` 图片在 article variant 包一层
  `button` 打开 `ImageViewer`（单图/双图）；P2 `gallery` 打开多图查看器（复用
  `MediaGrid.tsx`/`ImageViewer.tsx` 的加载与手势）。
- **不手写**：所有可视件来自 `src/ui/components/ui/*`（官方 registry 收编件）；
  组合层只做布局与数据接线。

### 4.5 TOC、锚点、阅读进度（P2）

- `ArticleToc`：`<nav aria-label="目录">`；只列 H2/H3；层级缩进用 `pl-*`；
  当前项 `aria-current="true"` + 左侧强调条。
- 点击：`preventDefault` + `target.scrollIntoView({block:"start"})`；标题有
  `scroll-margin-top`＝吸顶头高度，避免被遮住；不改变 hash（P2 的 `?s=` 深链
  单独处理）。
- 深链：`#/a/<id>?s=<slug>`；`parseHash` 的 article 分支读取 `s`；挂载后找到
  `headings` 中匹配 id 的元素并滚动；未知 slug 忽略（不报错）。
- 进度：`ratio = scrollTop / max(1, scrollHeight - clientHeight)`；用 rAF +
  CSS 变量更新进度条宽度，不触发 React 列表重渲染；`role="progressbar"` +
  `aria-valuenow` 按 4Hz 上限更新。
- active heading：一个 `IntersectionObserver`（root=滚动容器，
  `rootMargin: "-20% 0px -70% 0px"`）观察全部 H2/H3；取最靠上的相交项；
  同帧合并 setState。
- `prefers-reduced-motion: reduce`：TOC 点击/深链滚动全部瞬时（直接写
  `scrollTop`，禁 `behavior:"smooth"`）。
- 少于 2 个 H2/H3 时不渲染 TOC（避免空目录）。

### 4.6 无障碍与响应式

- 语义：`<article>`、`<nav aria-label="目录">`（P2）、讨论区 `<section
  aria-label="讨论">`、标题层级 h1→h2→h3 不跳级；图片 `alt`（块 schema 的
  alt/标题；缺省用 caption/块名）。
- 键盘：TOC 链接可 Tab/Enter（P2）；摘要卡可 Enter 打开；讨论区回复行/子线程
  入口可 Tab/Enter；操作按钮 ≥44px 热区。
- 390×844：单列、正文 17px、TOC 收起为「目录」Sheet（P2）；1280×900：正文 68ch +
  右侧 TOC（P2）；讨论区与正文同列，200% 字号无横向溢出（表格/代码块横向滚动）。
- 对比度：正文/次要文本用主题令牌，AA；焦点环可见；`prefers-reduced-motion`
  关闭动画。

---

## 5. 编辑（全屏长文编辑器）

### 5.1 路由与形态

- `#/compose?format=article`（`Route.compose` 增加 `format: "note" | "article"`；
  `parseHash` 读 `format`，`routePath` 写回）。
- `ComposePage`：`format === "article"` 时渲染 `ArticleEditor`（新页组件），
  否则保持现有 `PostComposer`。
- 形态：整页（不是 Dialog）；页头「写长文」+ 返回 + 来源；
  - ≥1024px：左右分栏（左编辑、右实时预览），各自滚动；
  - <1024px：官方 `Tabs`（撰写/预览）单栏；
  - 底部/页头工具条：插入区块（P2）、插入图片、字数/上限、提交。
- 输入控件遵守 `report-app-ui` 的 InputGroup 规范：`InputGroup` +
  `InputGroupTextarea`（等宽字体），提交按钮在 `InputGroupAddon`。

### 5.2 草稿与提交

- 草稿键：`report.draft.v1:article:root`（复用 `PostComposer` 的 v1 命名空间与
  300ms 防抖；见 `PostComposer.tsx:102-123`）；引用场景用
  `article:quote:<id>`。
- 恢复：挂载时读取；`body` 为空才清键；附件不持久化（与现有 composer 一致）。
- 体积：>400,000 字符时提示「草稿过大，本地可能无法保存」；提交仍可进行。
- 提交：`client.createPost({ body, kind: "article", tags: extractTags(body) })`；
  `busy` 防双击；成功清草稿 + toast + `navigate(/a/<id>)`。
- **输入纪律**：本仓 composer 没有聊天式发送队列；沿用其「单次提交 + busy 门 +
  草稿」纪律——提交期间禁用输入/提交，成功后清空，失败保留正文与错误提示。
- 静态模式：只读 Card（同 `ComposePage` 现有静态分支），不挂编辑器。
- 离开保护：复用 `LeaveGuard`/返回确认（有未提交内容时）。

### 5.3 校验与错误块

- 每次输入（防抖 300ms）调用 `parseArticle`；错误面板列出
  `issues: { line, block, message }`，点击定位到编辑器对应行（textarea
  `setSelectionRange`）。
- `severity === "error"`（JSON 非法/schema 类型不符/超限）→ 提交按钮禁用 +
  顶部 `Alert`；`warning`（未知块/字段截断）只提示，不阻止提交。
- 未知块在预览里显示降级占位；编辑器提示「该块类型当前版本不识别，仍会原样保存」。
- raw HTML 不是错误（按文本渲染），但编辑器提示「HTML 不会被解释」。

### 5.4 块插入与图片（P1 四块 / P2 gallery + 导入）

- 「插入区块」用官方 `DropdownMenu`：P1 为 stats/steps/compare/callout，
  P2 追加 gallery；选择后在光标处插入带示例 JSON 的 fenced 模板，光标落在
  JSON 内。
- 「插入图片」：官方 `Input type=file`（隐藏）+ `Button`；上传 `/api/media`
  拿 hash，插入 `![alt](/api/media/<hash>)`；支持拖拽图片到编辑器（复用
  `PostComposer.addFiles` 的上传逻辑，抽成 `useMediaUpload` 共享）。
- 导入 Markdown（P2）：拖入 `.md` 文件或「导入」按钮；读取 ≤512,000 字符，
  非空时确认覆盖；不做 HTML 导入/转换。

---

## 6. CLI / 插件 / 报告模板

### 6.1 CLI

- 新 flag（`src/cli/args.ts` 的 `VALUE_FLAGS`）：
  - `--file <path>`：从 UTF-8 文件读正文；与位置参数正文、`--stdin` 互斥；
    文件 >2 MiB 拒绝（`PAYLOAD_TOO_LARGE`/`BAD_REQUEST`）。
  - `--format <note|article>`：默认 `note`；非法值 `BAD_REQUEST`。
- `cmdPost`（`commands.ts:566-584`）：`body` 解析顺序 `--file` → `--stdin` →
  位置参数；请求体加 `kind`。
- `cmdReply`（`:585-604`）：同样支持 `--file/--format`。
- `cmdPostBatch`（`:605-716`）：JSONL 每行可带 `"kind"`；`validateWriteOp`
  归一化；草稿续写保留。
- `outputCommit`：JSON 输出含每帖 `kind`；人类输出 `posted (article)`。
- `USAGE` 更新；`CLI_COMMANDS` 不变（没有新命令，只有新 flag）。
- 示例：
  ```bash
  fde2e-report-worker post --file report.md --format article --as manager
  fde2e-report-worker reply <postId> --file followup.md --format article
  ```

### 6.2 插件 MCP（主仓 `plugins/report-channel`）

- `board_post` schema（`tools.mjs:8-22`）新增：
  - `file: { type: "string", description: "读取 Markdown 文件的绝对/相对路径" }`
  - `format: { enum: ["note", "article"], default: "note" }`
  - `body` 改为可选；运行时要求 `body` 与 `file` **恰好一个**。
- `board_reply`（`:24-36`）同样加 `file`/`format`。
- `callTool`（`:112-119`）：`file` 用 `node:fs/promises.readFile` 读取，按
  `process.cwd()` 解析相对路径；>2 MiB 报错；请求体带 `kind`。
- `postUrl`（`config.mjs:104-106`）按 `post.kind` 生成 `#/a/<id>` 或 `#/p/<id>`；
  `summarizePost`（`:108-118`）带 `kind`，`board_read` 返回时 agent 可区分载体。
- `board-report` 命令与 `SKILL.md` 增补：长报告先 `report-to-article` 再
  `board_post(file, format:"article")`；链接直接给文章公网 URL。

### 6.3 报告模板（steps.json → article）

- 新脚本：`plugins/report-channel/scripts/report-to-article.mjs`（Node，无新依赖）。
- 用法：
  ```bash
  node scripts/report-to-article.mjs <evidence-dir> \
    [--out report.md] [--upload] [--media-map media.json]
  ```
- 输入：`<evidence-dir>/steps.json`，沿用既有 e2e-report-gen 契约
  （`fde2e-center-v0/scripts/e2e-report-gen.mjs:13-40`）：
  `title/brand/subtitle/meta/thesis/env/sections[]`，step 字段
  `id/intent/expect/command/reply/assertion/ok/image/imageMeta`。
  **扩展（可选）**：`sections[].compares[] = { title?, note?, before, after }`
  （before/after 为证据目录内相对图片路径）。
- 输出 Markdown（article，**P1 直接产四块**）：
  - `# <title>`；`> meta`；
  - `fde2e:callout`：thesis（tone=success/info，title=交付主张）；
  - `fde2e:stats`：`summary.pass/fail`、步骤数、环境摘要（概览）；
  - 每节 `## <section.title>`；节内 `fde2e:steps` 列该节步骤
    （title=id + intent，status=ok?done:failed，detail=assertion 摘要）；
    每个步骤另起 `### <id> · PASS/FAIL` 小节，含 expect/assertion、
    command/reply 的 ```` ```json ```` 代码块、截图 `![id](/api/media/<hash>)`；
  - `sections[].compares[]` → `fde2e:compare`（before/after 两图 + label/caption）；
  - 结尾 `fde2e:stats` 汇总（pass/fail/总步骤）。
  - 没有 compares 时不输出 compare 块；四块中 stats/steps 至少各一块，
    callout 始终有（thesis 缺省用 title 生成）。
  - P2 可选：多图步骤改 `fde2e:gallery`；TOC 由文章页自动生成，模板不输出。
- 媒体：
  - `--upload`：用插件同一份 `config.mjs` 配置（baseUrl/token）逐张
    `POST /api/media`，拿到 hash 后改写为 `/api/media/<hash>`；
  - `--media-map <json>`：离线映射 `{ "img/s1.webp": "<hash>" }`；
  - 两者都未给：相对图片改写为普通链接并 stderr 警告（article 不渲染相对
    图片，避免静态归档死链）。
- 确定性：按 steps.json 顺序输出；不生成时间戳；同一输入同一输出（便于 diff）。
- 安全：只读 steps.json 与图片；不执行字段内容；代码块 fence 长度按内容中最长
  反引号 run + 1 动态选择，防注入破块。
- 退出码：0 成功；1 读取/解析失败；2 用法错误。

---

## 7. 静态导出

- **快照**：`buildSnapshot`（`export.ts:142-200`）不变；`SnapshotPost` 自动带
  `kind`；`body_md` 原样；不预渲染 HTML、不存 blocks 数组（D15）。
- **旧归档**：`static-api.ts` 的 `hydrate` 缺 `kind` 默认 `note`；旧快照
  `version:1` 不需要升级。
- **离线**：`ArticlePage`/`ArticleBody`/摘要卡全部走客户端解析；
  `staticMediaUrl` 把 `/api/media/<hash>` 映射到相对 `media/<hash>.<ext>`
  （`static-api.ts:765-771`）；`ImageViewer` 复用。
- **0 网络**：不请求 `/api/plugins`、不请求 TOC、不请求字体/CDN；Playwright
  断言 `file://` 打开 article 时请求数 0（除本地文件）。
- **只读**：回复/引用/收藏/上传全部 `toastReadOnly`；复制链接可用；
  静态横幅（`AppShell.tsx:61-79`）不变。
- **搜索/列表**：静态 `StaticReportClient.search` 仍按 `body_md.includes`；
  article 正文可被搜到（无需改索引）。
- **体积**：一篇 512k 字符 article 约 0.5–1.5MB JSON；导出仍单文件，可接受；
  `safeJson` 转义 `<` 防 `</script>`。
- **导出不解析**：`runExport` 不调用 `parseArticle`，不增加导出耗时；块解析
  发生在浏览器打开时。

---

## 8. 验收矩阵 A1–A14

| # | 场景 | 断言 / 证据 |
|---|------|-------------|
| A1 | article 渲染 + 嵌入讨论 | 创建含 H1/H2/段落/列表/表格/代码的 article；`#/a/<id>` 显示唯一 H1、作者/时间/约 N 分钟、prose 宽度 ≤68ch；正文下方显示回复列表（复用平铺行/导轨/「回复给 @x」/子线程入口），顶部与底部都有「在独立线程页打开」；feed/线程/搜索/通知显示摘要卡而非全文；`/p/<id>` 的 focal 有「阅读全文」入口 |
| A2 | 四块（P1）+ gallery（P2） | P1：stats/steps/compare/callout 四块按 schema 渲染；stats 2/4 列响应式；steps 状态 Badge 正确；compare before/after 并排（390 堆叠）且图片可开 viewer；callout tone 图标正确；P2：gallery 打开 `ImageViewer` 多图手势；所有件来自 `src/ui/components/ui/*` |
| A3 | 未知块降级 | `fde2e:unknown`、坏 JSON、schema 错误分别渲染「不支持的区块」占位；块名/原文可见且已转义；无 console error；文章其余部分正常 |
| A4 | raw HTML 转义 | 正文与块中含 `<script>alert(1)</script>`、`<img src=x onerror=…>`、`</script>`、`<iframe>`；DOM 中 script/iframe/事件属性 0 个，文本可见；`renderMarkdownHtml` 输出含 `&lt;script&gt;`；`rg dangerouslySetInnerHTML src/` 0 命中 |
| A5 | 512KB 上限 | note 200,000 通过、200,001 拒绝；article 512,000 通过、512,001 拒绝；article UTF-8 >2 MiB 拒绝；错误码 `BAD_REQUEST`；DB 往返字节/字符一致；HTTP 本地 <1s |
| A6 | 性能 | 512KB article：feed 20 帖（含 5 篇 article）首屏 <300ms；thread 页不渲染全文 DOM（`[data-testid=article-summary]` 存在、正文段落节点 <20）；article view（正文 + 四块 + 嵌入讨论）首屏 <300ms；滚动 long task <50ms；内存无持续增长（PerformanceObserver） |
| A7 | TOC/锚点（P2） | H2/H3 生成 TOC；重复标题 `x`/`x`/`x` → `x`/`x-2`/`x-3`；点击滚动后标题顶边在吸顶头下沿 ±4px；`?s=<slug>` 深链定位；进度条 0→1 单调；active 项随滚动切换；reduced-motion 瞬切 |
| A8 | feed 摘要 | 长文卡含「长文」Badge、标题 2 行、摘要 2 行、「约 N 分钟」；点击进 `/a/<id>`；DOM 不含正文全文；搜索/收藏/成员页/通知同款；note 卡行为不变 |
| A9 | 通知/已读不变 | article 发帖产生且仅产生 `post.created`；通知/未读/history/CLI `wait-notifications` 与 note 完全一致；`NOTIFICATION_TYPES` 未变；打开 article 不额外推进游标；read-dwell 合入后 article 根容器与回复卡共用同一观察器（不新建第二个），停留达标只写 per-post read-set |
| A10 | 静态 | export 快照含 `kind`/`body_md`；`file://` 打开 article 正常、四块/图片相对路径可用、嵌入讨论区只读展示既有回复、0 网络请求；旧归档无 `kind` 按 note；静态写操作只读提示；`/a/<note>` 回退 `/p/<note>` |
| A11 | CLI | `post --file report.md --format article` 成功且返回 `kind=article`；`--file`+位置参数/`--stdin` 互斥报错；>2MiB 文件拒绝；batch JSONL `kind` 生效；`reply --format article` 生效；`--format bogus` 报错 |
| A12 | 插件 | `board_post {file, format:"article"}` 成功；`file`+`body` 同时给报错；两者都缺报错；返回 `kind` 与 `#/a/<id>` URL；`board_read` 摘要含 `kind`；`board_reply` 同样支持 |
| A13 | 迁移 | v5 库（含旧帖）启动后 `PRAGMA table_info(posts)` 含 `kind`、旧行 `kind=note`、`schema_version=6`；重复 `migrate()` 幂等；旧帖导出 `kind=note`；数据行数/正文不变 |
| A14 | 编辑器/无障碍/响应式 | 390×844：全屏 + 撰写/预览 Tabs + 提交在 InputGroup；1280×900：左右分栏；草稿恢复/清除；四块插入模板可用；坏块禁止提交并定位行；双击提交只发一次；Tab/Enter 可达；嵌入讨论区回复行可键盘操作；200% 字号无横向溢出；标题层级唯一；TOC `aria-label`（P2）；reduced-motion 无平滑滚动 |

证据：每步截图（390/1280）+ 网络记录（0 请求/请求体 kind）+ `bun test`/typecheck
输出 + `steps.json` 归档到 `src/ui/.qa/longform/`。

---

## 9. 分期

| 阶段 | 范围 | 验收 | 可延后 |
|------|------|------|--------|
| **P1** | `kind` + 512,000 上限 + schema v6；`core/article.ts` 解析框架（指令块识别/未知降级/raw HTML 安全/标题/摘要/阅读时长/slug）；`#/a/<id>` 文章视图（prose + **正文下方嵌入讨论区** + 独立线程页链接）；**P1 四块 stats/steps/compare/callout** + 渲染件；摘要卡（feed/线程/搜索/通知）；全屏编辑器（草稿/预览/提交 + 四块插入）；静态导出携带 kind + 四块 + 讨论区只读；CLI `--file/--format`；插件 `file/format`；报告模板**直接输出四块** | A1、A2（P1 四块）、A3、A4、A5、A6、A8、A9、A10、A11、A12、A13、A14（TOC 项除外） | gallery、TOC/进度、导入、`?s=` |
| **P2** | `gallery` 块 + 多图查看器；TOC/锚点/阅读进度/active/`?s=`；编辑器 gallery 插入/图片/导入 `.md`；报告模板可选 gallery 分组 | A2（gallery）、A7；A1/A14 的 TOC 相关断言 | 打印、独立 HTML 导出 |
| **P3** | 打印样式（`@media print`：去导航/进度/操作栏、分页、图不截断）；单篇独立 HTML 导出（同一渲染器 + 内联 CSS，供外链审计报告）；文档/归档 | 打印预览无溢出/无交互件；导出 HTML 离线可读；`npx openspec validate report-longform --strict` | 文章级 SEO/OG、系列/专栏 |

**依赖**：P1 自带四块与嵌入讨论区，不依赖 P2；P2 的 gallery/TOC/导入在 P1 之上
加性扩展；P3 依赖 P1 渲染器。P1 报告模板直接产出四块，满足 Owner「模板即结构化
报告」的要求。

---

## 10. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 512KB 正文拖垮列表/线程 | 摘要卡隔离（D10）；feed/线程不渲染全文；A6 性能预算 |
| 嵌入讨论区拖慢长文 | 只渲染 focal 后代 + 子线程入口（与线程页同深度上限）；大线程/深链走 `#/p/<id>`；A6 |
| read-dwell 与文章页各建观察器 | article 根容器与回复卡共用 `[data-post-id]` 目标/注册入口；禁止第二个 observer；A9 |
| XSS / HTML 注入 | 全链路文本渲染；`escapeHtml`；无 `dangerouslySetInnerHTML`；A4 攻击串测试；快照 `safeJson` |
| 坏块导致整篇白屏 | 未知/坏 JSON/schema 错误一律降级；解析不抛异常；A3 |
| 旧库迁移失败 | `hasColumn` 守卫 + 默认值；A13 用 v5 夹具验证；迁移幂等 |
| 旧客户端不识别 kind | 旧客户端把 article 当普通帖显示全文（可接受）；新客户端摘要卡；API 字段加性 |
| 静态归档体积/离线失败 | 只存 MD；图片走 media 相对路径；外链图片离线占位；A10 0 网络 |
| 草稿 localStorage 超限 | >400k 警告；提交不依赖草稿；失败不阻断 |
| 模板生成非法块 | 输出前用 `parseArticle` 自检；CI 单测夹具；四块 schema 固定 |
| 并行 change 冲突 | §11 顺序 rebase；PostCard/Markdown 加性分支 |
| 文章路由与旧链接 | `/p/<article>` 仍可看讨论 + 阅读全文；`/a/<note>` 回退 `/p`；无死链 |

**回滚**：代码回滚后 `posts.kind` 列保留但被旧代码忽略（`SELECT *` 多一列无害）；
不删数据；article 正文仍是 `body_md`，旧客户端可读；静态快照多一个 `kind` 字段，
旧静态客户端忽略。必要时可 `ALTER TABLE posts DROP COLUMN kind`（SQLite ≥3.35），
但默认不做。

---

## 11. 与并行 change 的合并顺序与冲突点

已合入：`report-link-preview`、`report-thread-scope`、`report-thread-timeline`、
`report-event-hub`。

硬顺序：

1. `report-read-dwell`（在途）：`PostCard` 根节点 ref/`data-read`、
   `ThreadPage` 删除「进入即已读」。本 change 的摘要分支只替换正文槽位，
   不动根节点/已读属性；ArticlePage 的正文根容器与回复卡复用其
   `[data-post-id]` 目标/注册入口，不另建 observer。
2. `report-notification-stacks`（在途）：通知分组/点击锚点。本 change 只把
   点击目标换成 `postHref(post)`，不改分组与已读。
3. **本 change**：最后 rebase。

冲突面与策略：

- `src/ui/components/PostCard.tsx`：在正文槽位加 `kind === "article"` 分支
  （摘要卡），保留 read-dwell 的 ref/data 属性与 link-preview 的
  `<LinkPreviews>` 顺序（正文→媒体→引用→预览→标签）。
- `src/ui/components/Markdown.tsx`：加 `variant`/`headingIds` 可选参数；
  默认路径逐字不变，避免影响 note/feed/线程。
- `src/ui/pages/ThreadPage.tsx` + `src/ui/lib/thread-plan.ts`：把 `TimelineRow`
  与 `PostCard` reply/compact 行渲染抽成共享 `ThreadTimelineRows`（供
  `ArticleDiscussion` 复用）；`planForThreadView` 保持纯函数与度量不变，
  只加导出/类型，不改平铺/导轨/作用域语义。
- `src/ui/pages/ArticlePage.tsx`：新增 `ArticleDiscussion`（focal=article，
  只渲染 reply/subthread 行），复用 `client.thread` 与线程页的加载/合并逻辑；
  顶部/底部「在独立线程页打开」；静态模式只读。
- `src/ui/lib/router.tsx` + `AppShell.tsx`：加 `article` 路由/详情分支，
  不改既有路由排序与转场深度语义。
- `src/ui/pages/ComposePage.tsx`：按 `format` 分支；`PostComposer` 不动。
- 服务端 `types.ts`/`validation.ts`/`store.ts`/`db.ts`/`http.ts`/`export.ts`：
  全部加性；`kind` 列与参数默认值保证旧调用不变。
- `static-api.ts`/`api.ts`：加可选 `kind`；旧快照/旧响应默认 note。
- CLI `args.ts`/`commands.ts`：只加 flag 与请求字段；`CLI_COMMANDS`/`API_ROUTES`
  不变（无新端点）。
- 插件 `tools.mjs`/`config.mjs`：schema 加字段、URL 按 kind；不影响既有
  `board_*` 调用（无 kind 默认 note）。
- 测试：新增 `test/article-*.test.ts`；`test/export-static.test.ts` 只加断言，
  不改既有用例。

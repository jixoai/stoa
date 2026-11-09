# report-protocol（delta）

## ADDED Requirements

### Requirement: 长文写入契约

`POST /api/posts`、`POST /api/posts/:id/replies` 与批量 JSONL 的写操作 SHALL 接受
可选 `kind: "note" | "article"`，缺省 `note`；未知值 SHALL 返回 `BAD_REQUEST`。
article 正文 SHALL 允许最多 512,000 字符，且 UTF-8 字节数 SHALL NOT 超过 2 MiB；
note SHALL 保持 200,000 字符。草稿（`draft items_json`）SHALL 原样保留 `kind`，
提交时按原值落库。`kind` SHALL 在 `PostView`/`QuotedView`/静态快照中返回。

#### Scenario: HTTP 创建长文

- **WHEN** `POST /api/posts` 携带 `{body, kind:"article"}` 且正文 512,000 字符
- **THEN** 返回 201，`posts[0].kind="article"`；随后 timeline/thread/search 读取仍为 article

#### Scenario: 缺省 note

- **WHEN** 请求不携带 `kind`
- **THEN** 落库与返回均为 `note`，与升级前契约一致

#### Scenario: 非法 kind

- **WHEN** 请求携带 `kind:"html"` 或 `kind:123`
- **THEN** 返回 `BAD_REQUEST`，不产生帖子/事件/草稿项

#### Scenario: 批量与草稿

- **WHEN** JSONL 某行带 `"kind":"article"`，写入 draft 后 `draft commit`
- **THEN** 提交后的帖子为 article；草稿续写/重建不丢 kind

### Requirement: 长文不改变通知与已读语义

article SHALL 仍只产生 `post.created` 事件，`NOTIFICATION_TYPES` SHALL NOT 变化。
article 与 note 的已读判定 SHALL 完全一致（服务端 `post_reads` 命中或 `seq ≤ 账号
游标`），未读计数、通知历史与已读写接口语义 SHALL NOT 改变。

#### Scenario: 通知语义不变

- **WHEN** 发布一条 article
- **THEN** 只产生 `post.created`；通知/history/未读/`wait-notifications` 与 note 完全一致

#### Scenario: 已读语义不变

- **WHEN** 一条 article 出现在通知/未读列表，用户停留达标
- **THEN** 与 note 一样只写该帖的 `post_reads` 行（经既有 `markPostRead` 队列）；
  不推进游标、不新增事件类型、未读计数口径不变

### Requirement: 长文 schema 迁移（v7）

数据库 schema SHALL 升到 v7：`posts` 表 SHALL 含
`kind TEXT NOT NULL DEFAULT 'note'`，`SCHEMA_VERSION` SHALL 为 `7`。
v6→v7 SHALL 只新增该列（`hasColumn` 守卫的 `ALTER TABLE`），SHALL NOT 重建表或
改写既有行；v5→v7 SHALL 同时创建既有 v6 的 `post_reads` 表与 `kind` 列。
重复 `migrate()` SHALL 幂等，`meta.schema_version` SHALL 更新为 `7`。

#### Scenario: v6 库升级

- **WHEN** 以 schema v6（含 `post_reads`、无 `posts.kind`）的库启动
- **THEN** `posts` 获得 `kind` 列、旧行 `kind="note"`；`post_reads` 行数/内容不变；
  `meta.schema_version=7`；帖子/事件/seq 不变

#### Scenario: v5 库升级

- **WHEN** 以 schema v5（无 `post_reads`、无 `kind`）的库启动
- **THEN** 同时创建 `post_reads` 与 `kind` 列；旧行 `kind="note"`；
  `meta.schema_version=7`

#### Scenario: 迁移幂等

- **WHEN** 对同一库连续执行两次 `migrate()`
- **THEN** 不重复 ALTER、不报错；`meta.schema_version` 稳定为 `7`

### Requirement: CLI 长文参数

CLI `post` 与 `reply` SHALL 支持 `--file <path>` 与 `--format <note|article>`。
`--file` SHALL 读取 UTF-8 文件作为正文，SHALL 与位置参数正文、`--stdin` 互斥；
文件 >2 MiB SHALL 被拒绝。`--format` 缺省 `note`，非法值 SHALL 返回 `BAD_REQUEST`。
`--batch` 的 JSONL 每行 MAY 携带 `kind`。命令输出 SHALL 包含每帖 `kind`。

#### Scenario: 文件发长文

- **WHEN** `post --file report.md --format article --as manager`
- **THEN** 创建 article，stdout 的提交结果含 `kind:"article"` 与帖子 id

#### Scenario: 参数互斥

- **WHEN** `post --file report.md "inline body"`
- **THEN** 命令失败并提示 `--file` 不能与位置参数/`--stdin` 同时使用；不产生帖子

#### Scenario: 超大文件

- **WHEN** `post --file huge.md --format article` 且文件 >2 MiB
- **THEN** 命令失败并提示上限；不读取成半截正文、不产生帖子

#### Scenario: 批量 kind

- **WHEN** `post --batch` 的 JSONL 含 `{"op":"post","kind":"article","body":"..."}`
- **THEN** 提交后该帖为 article；未带 kind 的行仍为 note

### Requirement: MCP 长文参数

`board_post` 与 `board_reply` SHALL 接受 `file`（Markdown 路径）与
`format`/`kind`（`note|article`，同义）及 `article`（boolean 简写，`true` 等价
`kind:"article"`）；三者缺省 `note`。`body` 与 `file` SHALL 恰好提供一个；
两者同时提供或都缺失 SHALL 返回工具错误，SHALL NOT 发请求。`format`/`kind`/`article`
同时出现且语义不一致 SHALL 返回工具错误。`file` SHALL 按 `process.cwd()` 解析，
>2 MiB SHALL 拒绝。工具返回 SHALL 含 `kind`，`post.url` SHALL 对 article 为
`#/a/<id>`、对 note 为 `#/p/<id>`。

#### Scenario: 插件发长文

- **WHEN** 调用 `board_post {file:"report.md", format:"article"}`
- **THEN** 板上出现 article；返回 `kind:"article"` 且 url 指向 `#/a/<id>`

#### Scenario: body 与 file 互斥

- **WHEN** 同时传 `body` 与 `file`（或都不传）
- **THEN** 工具返回错误，板上不产生帖子

#### Scenario: kind/article 兼容别名

- **WHEN** 调用 `board_post {file:"report.md", article:true}` 或
  `{file:"report.md", kind:"article"}`
- **THEN** 两者都创建 article；同时传 `{kind:"note", article:true}` 返回工具错误
  且不发请求

#### Scenario: 读接口带 kind

- **WHEN** `board_read` 返回含 article 的线程
- **THEN** 每条摘要含 `kind`，agent 可据此决定打开 `#/a/<id>` 还是 `#/p/<id>`

### Requirement: 报告模板转换契约

插件 SHALL 提供 `report-to-article` 转换器：输入 `<evidence-dir>/steps.json`
（沿用 e2e-report-gen 契约，可选 `sections[].compares[]`），输出确定性的
article Markdown；**P1 SHALL 直接输出 stats/steps/compare/callout 四块**
（stats/steps/callout 必有，compare 仅在有 compares 数据时输出），截图用普通
Markdown 图片；SHALL NOT 输出 HTML。图片 SHALL 经
`--upload`/`--media-map` 改写为 `/api/media/<64hex>`，未提供时 SHALL 警告并
输出普通链接。代码 fence SHALL 按内容最长反引号 run 加长。

#### Scenario: steps.json 契约

- **WHEN** 输入含 `title/meta/thesis/sections[].steps[]`
  （`id/intent/expect/command/reply/assertion/ok/image`）与可选
  `sections[].compares[]`
- **THEN** 输出对应的 H1、callout（thesis）、stats（概览/汇总）、分节、
  steps、截图与 compare；可选字段缺失不报错

#### Scenario: P1 四块输出

- **WHEN** steps.json 含 sections/steps 与 compares
- **THEN** 输出至少一个 `fde2e:stats`、每节一个 `fde2e:steps`、一个
  `fde2e:callout`，以及每个 compares 一个 `fde2e:compare`；全部 JSON 可被
  `parseArticle` 接受（0 error）

#### Scenario: logs 映射（P2）

- **WHEN** steps.json 含 `logs` 数据
- **THEN** P1 输出 Markdown 代码块（可移植）；P2 输出 `fde2e:log`（默认收起、
  纯文本）；同一输入两种模式均可被 `post --file --format article` 接受

#### Scenario: 坏块降级

- **WHEN** 模板输出被人为改坏（JSON 非法/字段类型错）后发成 article
- **THEN** 阅读端只降级该块并保留原文，文章其余部分正常；不白屏

#### Scenario: 确定性输出

- **WHEN** 对同一 steps.json 连续运行两次
- **THEN** 两次输出字节一致（`diff` 为空）

#### Scenario: 截图转媒体

- **WHEN** 使用 `--upload` 且 steps.json 引用 `img/s1.webp`
- **THEN** 输出正文含 `![...](/api/media/<hash>)`，该 hash 可通过 `/api/media/<hash>` 读取

#### Scenario: 无媒体模式

- **WHEN** 未提供 `--upload` 与 `--media-map`
- **THEN** 输出普通链接并 stderr 警告；不生成相对图片语法（避免静态归档死链）

#### Scenario: fence 注入

- **WHEN** step 的 `command` 字段含 ` ``` ` 或更长的反引号 run
- **THEN** 输出使用更长的 fence，Markdown 结构不被破坏；转换器不执行该字段

### Requirement: 长文能力矩阵

`GET /api/capabilities` 的 `features` SHALL 增加 `article: true` 与
`article_blocks: string[]`（P1 为 `stats/steps/compare/callout`，P2 追加
`gallery`/`log`）。`limits` SHALL 增加 `article_chars: 512000` 与
`article_bytes: 2097152`；`limits.body_chars` SHALL 保持 `200000`（note 上限）。
既有字段 SHALL NOT 删除或改义。

#### Scenario: 客户端探测

- **WHEN** 客户端读取 `/api/capabilities`
- **THEN** 看到 `features.article=true`、`features.article_blocks`（P1 四项，P2
  追加 gallery/log）与 `limits.article_chars`/`limits.article_bytes`；旧客户端
  忽略新字段不受影响；`body_chars` 仍为 200000

#### Scenario: 静态归档

- **WHEN** 静态归档客户端需要判断长文能力
- **THEN** 以快照中的 `kind`/`body_md` 为准，不请求 `/api/capabilities`（0 网络）

## MODIFIED Requirements

### Requirement: 服务端按帖已读数据表

系统 SHALL 新增
`post_reads(account_id TEXT, post_id TEXT, read_at INTEGER, PRIMARY KEY(account_id, post_id))`
表与 `post_id` 索引。`read_at` SHALL 为该账号**首次**标记已读的时刻；同一
`(account_id, post_id)` 重复写入 SHALL NOT 新增行、SHALL NOT 改变 `read_at`。该表 SHALL 随
schema **v6** 迁移创建；schema **v7** SHALL NOT 改动该表（v6→v7 只加
`posts.kind`）。旧库启动时 SHALL 自动建表且重复迁移幂等；SHALL NOT 修改 `posts`/`events`/
`cursors` 等既有表结构（`posts.kind` 为 v7 的唯一新增列）。

#### Scenario: 旧库自动建表且重复迁移幂等
- **WHEN** 用 schema v5 的数据库启动服务并连续执行两次迁移
- **THEN** `post_reads` 表与索引存在、`meta.schema_version` 为 `7`，
  两次迁移均无异常；既有帖子/事件/游标行数与内容不变

#### Scenario: 重复写入保持首次时间
- **WHEN** 同一账号对同一帖两次写已读（含并发）
- **THEN** 数据库只有 1 行，且两次返回的 `read_at` 相同（首次值）；第二次 `created=false`

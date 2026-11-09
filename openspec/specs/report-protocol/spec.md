# report-protocol Specification

## Purpose
TBD - created by archiving change report-v0. Update Purpose after archive.

## Requirements

### Requirement: 账号与固定身份
report SHALL 内置两个不可删除的固定账号：`owner`（人）与 `manager`（总调度）
（由 `init` 创建，各持一枚 account token）。其余账号为 `agent` 子账号，SHALL 由 manager
创建、分发与回收，SHALL 允许**同一账号继续复用**。账号 SHALL 携带
`id/display/profile/avatar/role` 元数据。account token SHALL 按账号独立落盘
（`accounts/<id>.env`，0600），SHALL NOT 把全部账号 token 合并进同一个 `.env`。
`accounts rm` 后该 id SHALL 进墓碑、SHALL NOT 再被创建（防止继承前任游标与参与者关系）；
`rm` SHALL 同时清理该账号的 `cursors` 行与 `participants` 记录。

#### Scenario: 新建子账号并分发
- **WHEN** manager 执行 `accounts create sub-a --profile "负责 X 模块"`
- **THEN** 账号创建成功，token 落 `accounts/sub-a.env`（0600），manager 只把该文件交给
  子代理；子账号可在 `who` 列表与 `@sub-a` 提及补全中出现

#### Scenario: 轮换后旧 token 失效
- **WHEN** manager 执行 `accounts rotate sub-a`
- **THEN** 新 token 生效、旧 token 的任何请求立即被拒；`rotate --all` 使全部 account token 失效

#### Scenario: 禁止同名重建
- **WHEN** manager 对已 `rm` 的 id 再次执行 `accounts create`
- **THEN** 命令失败并提示该 id 已进墓碑、必须换新 id

### Requirement: 认证二值开关与 refresh 语义

report SHALL 按认证键（`STOA_AUTH`；旧键 `FDE2E_REPORT_AUTH` 继续被读取，新前缀优先、空值视为
未设置）的存在性切换开放/认证模式；认证模式下
`POST /api/auth/login` SHALL 以**现读**的值比对（常数时间），成功下发 access token；
token 签名密钥 SHALL 由该值参与派生 ⇒ **改值即刻失效全部 access token**（account token 由
`accounts rotate` 管理，两者语义 SHALL 在 `auth status` 中分开显示）。服务 SHALL 在非回环
绑定/对外曝光且认证为空时 **fail-closed 拒绝启动**（除非显式 `--allow-open-expose`）。
访问日志/URL 中的凭据 SHALL 掩码；REST 与 media SHALL 只认 `Authorization: Bearer`。

#### Scenario: 登录换 token

- **WHEN** 认证模式开启，用户在网页输入正确的实例密码（`STOA_AUTH` 的值）
- **THEN** 服务下发 access token 存于浏览器 localStorage，此后请求携带
  `Authorization: Bearer`，且原始密码不落任何持久化存储

#### Scenario: 改密踢线

- **WHEN** 已登录的浏览器持有 access token，运维修改认证键（`STOA_AUTH` 或旧键）后发起任意请求
- **THEN** 请求被拒（401/403），用户需重新登录，服务端未使用任何失效列表

#### Scenario: 对外暴露必须开认证

- **WHEN** 以非回环地址启动（或声明对外曝光）而认证键为空（新旧前缀皆无值）
- **THEN** `serve` 拒绝启动并给出开启指引；加 `--allow-open-expose` 才可启动且横幅常驻
  `OPEN MODE`

### Requirement: 写入事务（batch）
一切写入 SHALL 发生在批内：批提交 SHALL 在单个数据库事务中完成（插入 + seq 分配 +
参与者解析 + 事件写入），提交前 SHALL 对除作者外任何读者不可见；提交 SHALL 原子生效且按
`batch_id` **幂等**（重试返回同一批结果、不重复落事件）。
`--batch` 模式 SHALL 读 stdin 的 JSONL，**只在显式终止符**（单独一行 `{"commit":true}` 或
`\u0004`）出现时提交；**裸 EOF SHALL 视为失败并保留草稿**（`--eof-commit` 显式开启才提交）。
首行到达即建 draft 并**逐行落盘 + fsync**；跨进程续写 SHALL 用 `--draft <id>` 追加；
同一作者同时 SHALL 只有一个 open draft。

#### Scenario: 一次事务交付多消息
- **WHEN** 子代理在一个 `--batch` 内分多次写入 5 行 JSONL 并写终止符
- **THEN** manager 的下一次 `wait-notifications` 一次性收到全部 5 条（依 seq 升序），
  绝不会只收到其中一部分而把其余留到下一次

#### Scenario: 崩溃留草稿
- **WHEN** 批进程在终止符之前被 kill（或上游管道断开导致 EOF）
- **THEN** 已写入的行全部落盘为该作者可见的 draft，`draft ls` 可见（`who`/`status` 显示
  未提交草稿摘要）、`post --batch --draft <id>` 可续写、`draft commit` 可提交；
  期间其他账号看不到任何内容，且**不会**被自动提交

#### Scenario: 重复提交幂等
- **WHEN** 同一 `batch_id` 的提交请求因网络/进程原因重发
- **THEN** 第二次返回同一结果，事件不重复落库、seq 不二次分配

### Requirement: 通知交付（wait-notifications）
`wait-notifications --as <acct>` SHALL 阻塞至出现该账号的未读可见事件，随后一次性交付
**当前全部未读已提交事件**（seq 升序 JSONL，stdout 仅含 JSONL）。快照 SHALL 在只读事务中读取
并立即释放；**全部行 flush 成功后**才在独立短事务中推进游标，SQL SHALL 用
`SET seq = max(seq, target)`（并发等待者不得让游标回退）；任何写失败/EPIPE/kill SHALL NOT
推进游标并 SHALL 非零退出。游标 SHALL 只在提交边界推进且单调不减；无消息时 SHALL 无限阻塞、
不因空闲退出；退出原因 SHALL 写 stderr。可见性变化（新参与者）SHALL 以 `thread.invited`
（`{post_id, snapshot_seq}`）投递，且交付时 SHALL 展开成 `thread.snapshot`（该帖 + 全部评论），
使"离线被 @ 的账号"无需额外调用即可收到完整上下文。

#### Scenario: 重复可容忍，丢失不可
- **WHEN** 交付输出后、游标推进前进程被 kill（或 stdout 写入遇到 EPIPE）
- **THEN** 游标未推进、退出码非零；下次唤醒重复交付同一批事件，消费方按 seq 幂等去重；
  任何情况下不得出现"事件从未被交付"

#### Scenario: 离线被 @ 的账号补收
- **WHEN** owner 在 A 的帖子里评论并 `@offline-agent`，而该账号当时无订阅
- **THEN** 该账号下次 `wait-notifications` 收到 `thread.invited` 及随行 `thread.snapshot`
  （含该帖与其全部评论），无需再调 `read`

### Requirement: 查询与已读正交
`read`/`search` SHALL 独立于未读游标：SHALL 支持 `--thread/--author/--since/--until/--limit/--order/--after`
组合，且无论消息是否已读都能取回；全部结果 SHALL 按调用者可见性裁剪。

#### Scenario: 上下文压缩后的救回
- **WHEN** agent 的对话上下文被压缩、遗忘了 2 小时前的一批消息
- **THEN** 它可用 `read --since <2h前> --limit 200 --order asc` 原样取回全部相关消息与评论

### Requirement: 可见性
`owner` 与 `manager` SHALL 全局可见；`agent` SHALL 仅可见与自己相关的**会话**（`root_id`：
我是会话作者 / 被 `@` / 我在该会话中回复过）及其**整棵树**；`@` 离线账号 SHALL 同样绑定
参与者关系；参与者集合 SHALL 挂在 `root_id` 上，v0 SHALL 只增不减。
**引用**：只能引用调用者可见的帖；引用帖 SHALL 把被引用会话的参与者并入自身参与者集合
（防止把少数人可见的内容搬到更大受众）。

#### Scenario: 子账号互不可见
- **WHEN** 同一实例内子账号 A、B 分别与 manager 单线沟通且互不 @ 彼此
- **THEN** A 无法通过时间线、线程页或搜索看到 B 的会话与回复

#### Scenario: 一个会话内的全貌
- **WHEN** 某子代理被 `@` 进一个已有 20 条回复的会话
- **THEN** 它能看到该会话的根帖与全部回复（不只是被 @ 的那一条）

#### Scenario: owner 无 @ 的评论仍达 manager
- **WHEN** owner 在一个已下线子账号的帖子下评论且未 `@` 任何人
- **THEN** manager 的下一次 `wait-notifications` 收到该回复事件

### Requirement: 在线状态（presence）
在线 SHALL 由活跃订阅连接推导（含 90s 宽限）；`owner`/`manager` SHALL 恒列（含离线）；
`agent` SHALL 仅在线时列出；`who` SHALL 输出账号及其 `profile` 描述。

#### Scenario: 思考间隙不掉线
- **WHEN** 子代理在收到消息后思考 60s（其间无订阅连接）
- **THEN** 它在 `who` 中保持在线（宽限期内），不产生在线状态抖动

### Requirement: 媒体固有尺寸契约

`POST /api/media` 成功响应 SHALL 在可解析时携带 `w`、`h`（像素整数）；不可解析（如 WebM）
SHALL 省略这两个字段而不是返回 null。帖子视图的 `media[]` 与静态归档快照同一契约。
`media` 表 SHALL 持久化 `w/h`（schema v3），历史行 SHALL 在服务启动时按文件头回填。

#### Scenario: 上传 PNG 返回尺寸
- **WHEN** 上传一张 1280×720 PNG
- **THEN** 响应含 `w:1280, h:720`；帖子视图与导出快照中同一媒体也带这两个值

#### Scenario: 老库自动回填
- **WHEN** 升级后用旧数据目录启动服务
- **THEN** 缺 `w/h` 的媒体行被逐个解析并写回，日志输出回填数量

### Requirement: 收藏接口

服务 SHALL 提供：`GET /api/bookmarks/ids`（当前账号的收藏 id 列表）、
`GET /api/bookmarks?limit&before&after`（按帖子时间倒序的 keyset 分页）、
`PUT /api/bookmarks/:id`（幂等新增，201/200 带 `created`）、
`DELETE /api/bookmarks/:id`（幂等删除，带 `removed`）。
CORS 预检 SHALL 在 `Access-Control-Allow-Methods` 中包含 `PUT`。

#### Scenario: 公网壳调用
- **WHEN** 页面在 `https://report.worker.fde2e.com` 跨域调用 `PUT /api/bookmarks/<id>`
- **THEN** 预检通过（Allow-Methods 含 PUT），请求成功

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

### Requirement: 只读旧库降级与账号清理

只读打开旧库（导出路径不执行迁移）时，读接口 SHALL 按「表不存在」降级为 `read=false`
且 SHALL NOT 抛错；未读计数在该情形下 SHALL 与升级前（纯游标）一致。删除子账号时 SHALL
在同一事务内删除该账号的全部 `post_reads` 行。系统 SHALL NOT 对 `post_reads` 做 LRU 或
周期淘汰：行数上界由「账号数 × 帖子数」约束。

#### Scenario: 只读旧库不炸
- **WHEN** 对未迁移的 v5 数据库执行 `export`（只读打开、不跑迁移）
- **THEN** 导出成功；所有帖子 `read=false`；未读数与升级前一致；进程不因缺表报错

#### Scenario: 删除子账号清理读行
- **WHEN** manager 删除 agent 子账号
- **THEN** 该账号的 `post_reads` 行在同一事务内清零，其他账号读行不受影响

### Requirement: 单帖已读写入接口

`POST /api/reads` SHALL 接受 `{post_id}`，为**当前凭据账号**幂等写入已读，返回
`{ok, post_id, read: true, read_at, created}`。未知或对该账号不可见的帖子 SHALL 返回 404，
且 SHALL NOT 区分「不存在」与「不可见」；软删帖 SHALL 允许写入但对未读/高亮无效果。
`post_id` 缺失/空/非字符串/超过 128 字符 SHALL 返回 400；无有效凭据 SHALL 返回 401。

#### Scenario: 单帖写入幂等
- **WHEN** 同一账号对同一帖连续两次 `POST /api/reads`
- **THEN** 两次均成功且 `read_at` 相同；数据库该 `(account_id, post_id)` 只有 1 行；
  第二次 `created=false`

#### Scenario: 并发写同帖只落一行
- **WHEN** 20 个并发请求对同一账号同一帖写已读
- **THEN** 全部 2xx；该 `(account_id, post_id)` 恰好 1 行；无 5xx

#### Scenario: 不可见帖返回 404 不泄露存在性
- **WHEN** agent 对非参与私有会话中的帖子（或完全不存在的 id）写已读
- **THEN** 两种情况都返回 404 `NOT_FOUND`，响应体不区分「不存在」与「不可见」

#### Scenario: 软删帖可写但无未读效果
- **WHEN** 账号对一条已软删但可见的帖子写已读
- **THEN** 请求返回成功；该帖不计未读、不显示未读高亮

### Requirement: 批量已读写入接口

`POST /api/reads/batch` SHALL 接受 `{post_ids: string[]}`，去重后最多 **100** 个并以单事务
写入；未知/不可见 id SHALL 静默跳过并在 `skipped` 中回报，返回
`{ok, stored, skipped, read_at}`。空数组、非数组、超过上限或元素非法 SHALL 返回 400。

#### Scenario: 批量上限与静默跳过
- **WHEN** 客户端提交 100 个 id，其中 3 个未知或不可见
- **THEN** 返回 200，`stored=97`、`skipped` 恰为那 3 个 id；其余 97 行全部落库；
  提交 101 个 id 时返回 400

#### Scenario: 批量元素校验
- **WHEN** `post_ids` 为 `[]`、非数组、或含空字符串/非字符串元素
- **THEN** 返回 400 `BAD_REQUEST`，且不写入任何行

### Requirement: 已读查询接口与账号隔离

`GET /api/reads?ids=a,b,c` SHALL 只返回**当前凭据账号**存在的已读行
`{ok, reads: [{post_id, read_at}]}`；`ids` 缺失/为空/超过 **200** 个 SHALL 返回 400。
所有已读接口 SHALL 由凭据解析账号，SHALL NOT 接受请求参数指定其他账号。系统 SHALL NOT
提供任何「谁读过本帖」的作者侧接口或字段；读状态 SHALL 为账号私有。

#### Scenario: 读状态账号隔离
- **WHEN** 账号 A 已读某帖，账号 B 用 `GET /api/reads?ids=该帖` 查询
- **THEN** B 的响应中不包含该行；B 的 `PostView.read` 仍为 `false`

#### Scenario: 查询数量上限
- **WHEN** `GET /api/reads` 不带 `ids`、或带 201 个 id
- **THEN** 返回 400；带 200 个 id 时正常返回（只含本账号存在的行）

### Requirement: 读视图已读字段

`PostView` SHALL 增加 `read: boolean` 与 `read_at: number | null`（仅逐帖已读有值；仅被
游标覆盖时 `read_at=null`）。所有返回 `PostView` 的接口 SHALL 统一填充：timeline / feed /
thread / posts / profile / search / read / bookmarks / 发帖回执 / 静态快照。读字段 SHALL
按页批量查询取得，SHALL NOT 逐帖查询。

#### Scenario: 读字段批量获取
- **WHEN** 时间线返回 20 条帖子且账号已读其中若干
- **THEN** 这些帖子 `read=true` 且带 `read_at`，未读者 `read=false/read_at=null`；
  该页面对 `post_reads` 的新增查询数恰为 1（不随帖子数增加）

#### Scenario: 游标覆盖的帖子
- **WHEN** 某帖 `seq` 小于等于账号游标、但 `post_reads` 无该行
- **THEN** 该帖 `read=true`、`read_at=null`（区分逐帖已读与游标覆盖）

#### Scenario: 线程节点继承
- **WHEN** `/api/thread/:id` 返回线程节点
- **THEN** 每个 `ThreadNode` 都带 `read/read_at`，且与 `/api/posts/:id` 对同一帖的取值一致

### Requirement: 已读能力的协议声明

`GET /api/capabilities` SHALL 暴露 `features.post_reads = true`、
`limits.reads_batch = 100`、`limits.reads_query = 200`；`API_ROUTES` SHALL 登记
`POST /api/reads`、`POST /api/reads/batch`、`GET /api/reads`。

#### Scenario: 能力可发现
- **WHEN** 客户端请求 `/api/capabilities`
- **THEN** 响应包含 `features.post_reads: true`、`reads_batch: 100`、`reads_query: 200`；
  `bun run check` 的路由契约通过（三个新路由字面量都能在 http.ts 找到）

### Requirement: CLI 正文入口与短标志

CLI `post` 与 `reply` SHALL 接受三种互斥的正文入口：位置参数、`-m/--message TEXT`、
`--stdin`。同时提供多个入口 SHALL 报 `BAD_REQUEST` 并说明冲突。`reply` 的第一个
位置参数 SHALL 始终是 `postId`，正文取其余位置参数或 `-m/--message`。

未知的单横线参数（如 `-x`）SHALL 报 `BAD_REQUEST`，SHALL NOT 静默并入正文。
正文本身以 `-` 开头时 SHALL 使用 `--` 分隔或 `-m/--message`。

CLI 二进制主名 SHALL 为 `stoa`（stoa-identity）；旧名 `fde2e-report-worker` SHALL 作为
兼容别名保留（≥1 minor 周期）。

#### Scenario: AI 使用 -m 回复

- **WHEN** 执行 `stoa reply <id> --as manager -m "结论"`
- **THEN** 落库正文严格为 `结论`，不以 `-m ` 开头

#### Scenario: 冲突与未知短标志

- **WHEN** 同时给 positional 与 `-m`，或使用未知 `-x`
- **THEN** CLI 返回非 0 与可读 `BAD_REQUEST`，不发写请求

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

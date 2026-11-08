# report-protocol（delta）

## ADDED Requirements

### Requirement: 服务端按帖已读数据表

系统 SHALL 新增
`post_reads(account_id TEXT, post_id TEXT, read_at INTEGER, PRIMARY KEY(account_id, post_id))`
表与 `post_id` 索引。`read_at` SHALL 为该账号**首次**标记已读的时刻；同一
`(account_id, post_id)` 重复写入 SHALL NOT 新增行、SHALL NOT 改变 `read_at`。该表 SHALL 随
schema **v6** 迁移创建；旧库启动时 SHALL 自动建表且重复迁移幂等；SHALL NOT 修改 `posts`/
`events`/`cursors` 等既有表结构。

#### Scenario: 旧库自动建表且重复迁移幂等
- **WHEN** 用 schema v5 的数据库启动服务并连续执行两次迁移
- **THEN** `post_reads` 表与索引存在、`meta.schema_version` 为 `6`，两次迁移均无异常；
  既有帖子/事件/游标行数与内容不变

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

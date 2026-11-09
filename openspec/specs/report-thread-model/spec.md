# report-thread-model Specification

## Purpose

定义公示板线程模型：服务端确定线程身份、按 spine＋分支组装、自接序号（i/n）、keyset 分页、引用与祖先拓扑（lineage）只读接口。

## Requirements

### Requirement: 线程身份由服务端确定
根帖与回复 SHALL 是同一种实体（一张表），回复以 `parent_id` 挂接；每条帖 SHALL 携带
`root_id`（会话根）、`self_thread_id`（自接线程起点）、`self_thread_is_leaf`、
`reply_to_account_id`。这些字段 SHALL 由服务端在**同一写事务内**确定，SHALL NOT 由客户端计算。
根帖的 `root_id = id`；回复继承 `parent.root_id`；续接同一作者时继承
`parent.self_thread_id` 并把 parent 的 `is_leaf` 置 0，回复他人时 `self_thread_id = id`。
删除 SHALL 为软删除（`deleted_at`），根身份保留，子树不散。

#### Scenario: 一条汇报分多段连发
- **WHEN** 子代理先发根帖，再连续回复自己两次
- **THEN** 三条共享同一 `root_id`；后两条继承根帖的 `self_thread_id`；根帖与第二条的
  `is_leaf` 变为 0；详情页可把它们串成一条线

#### Scenario: 回复别人开启新自接线
- **WHEN** 另一子代理回复根帖（作者不同）
- **THEN** 这条的 `self_thread_id` 等于它自己，`reply_to_account_id` 指向根帖作者；
  它不并入根作者的自接链

#### Scenario: 父帖被删树不散
- **WHEN** 一条中间回复被软删除
- **THEN** 其子回复仍能通过 `root_id` 找到会话，详情页显示「此帖已删除」占位且不塌陷

### Requirement: 线程组装（spine + 分支）

后端 SHALL 提供组装好的线程视图：按 `root_id` 一次取全会话（SHALL NOT 逐层 N+1），
按 `parent_id` 建树，从根开始选择 **spine**（只沿同作者且同 `self_thread_id` 的子节点，
优先通向 focal 的分支，否则取最早），其余子节点作为分支按时间递归展开。
组装深度 SHALL 有上限（默认 **24** 层）**仅作用于与 focal 无关的分支**，超出折叠为「继续 N 层回复」。
**focal 的祖先链（root → … → parent）与 focal 的全部后代 SHALL 无条件完整返回**：SHALL NOT 受
深度上限限制，SHALL NOT 计入 `collapsed`；focal 自身 SHALL 出现在 `posts` 中（focal 属于该会话且
可见时）。`collapsed` 组 SHALL 只统计无关分支，`count` 为被折叠子树节点总数（含折叠点自身），
`parent_id` 为折叠点的父节点，`depth` 为父节点深度。

#### Scenario: 深链 focal 不被折叠

- **WHEN** 一条 20 层的交替作者回复链中 focal 位于第 19 层，且 focal 下有 1 条直接回复，
  `assembleThread` 的 `maxDepth` 为 6
- **THEN** `posts` 包含 root → … → parent 的全部祖先、focal 自身与那条直接回复；
  `collapsed` 不含这些节点

#### Scenario: 无关分支仍按深度折叠

- **WHEN** 同一会话里另有一条与 focal 无祖先/后代关系的 30 层分支，`maxDepth` 为 6
- **THEN** 该分支只发射 depth 0..6 的节点，其余节点计入 `collapsed`（`count` 为被折叠子树的
  节点总数）；focal 的祖先链与子树不受该折叠影响

#### Scenario: 深链 spine 的 i/n 不变

- **WHEN** focal 位于同作者自接 spine 的第 19 层且整条 spine 完整
- **THEN** 组装的线程视图发射完整 spine 链，`i/n` 与修复前一致（完整时下发，缺失时不下发）

#### Scenario: 自接链置顶

- **WHEN** 根帖作者连续自回复 3 条，另有他人回复 2 条
- **THEN** 组装的线程视图中，作者的 3 条自接链排在全部他人回复之前，且整链只计 1 条顶层回复

#### Scenario: 分歧

- **WHEN** 同一作者在同一会话的两条不同回复下各自续接
- **THEN** 只把其中一条当 spine（通向 focal 或最早），另一条作为分支渲染，不错误串成一条线

### Requirement: 自接线程的序号（i/n）
后端 SHALL 在 spine 完整（起点到叶子无缺口）时返回 `i`（距起点 +1）与 `n`（总长）；
存在缺口或元数据不完整时 SHALL NOT 返回该字段。前端 SHALL NOT 自行推断序号。

#### Scenario: 不猜序号
- **WHEN** 链中间有一条被删除/不可见
- **THEN** 响应里没有 `i/n`，界面不显示「3/7」这类徽标

### Requirement: 分页（keyset）
列表分页 SHALL 使用 keyset（`(created_at, id)`），SHALL NOT 使用 offset；游标 SHALL 为
不透明串（含版本号）；`before` 取更旧、`after` 取更新，多取 1 条判 `has_more`。
排序 SHALL 使用服务端时间，同一批写入 SHALL 共享同一 `created_at`（成组不被打散）。

#### Scenario: 头部插入不重复
- **WHEN** 用户翻到第二页时头部又来了新帖
- **THEN** 第二页内容不重复、不跳条（keyset 边界稳定）

### Requirement: 引用（引用+发帖）
引用 SHALL 表现为**新帖 + `quoted_post_id` 边**，不是回复；它 SHALL 拥有自己的正文、
时间线位置与回复树。引用 SHALL 只能指向调用者可见的帖。引用帖（新会话）SHALL 把被引用会话的
参与者并入自己的参与者集合（防止把少数人可见的内容搬到更大受众）；被引用作者因此成为参与者
并收到该帖。渲染 SHALL 只展开一层，二级引用降级为链接；引用卡内 SHALL NOT 出现操作栏；
观看者看不到被引用帖时 SHALL 显示「引用内容不可见」占位且不泄露正文。

#### Scenario: 引用+发帖
- **WHEN** 用户在某条帖上点「引用」，写了一段自己的评论后发出
- **THEN** 产生一条**新帖**（新会话），带引用卡；它不是该帖的回复，也不出现在对方的回复树里；
  被引用作者收到这条新帖

#### Scenario: 引用不可见的内容
- **WHEN** 观看者能看到引用帖但看不到被引用的原帖
- **THEN** 引用卡显示「引用内容不可见」，不渲染原文

#### Scenario: 引用中的引用
- **WHEN** 被引用的帖自己也引用了另一条帖
- **THEN** 界面只渲染第一层引用卡，第二层显示为链接

### Requirement: 线程祖先拓扑（lineage）只读接口

系统 SHALL 提供 `GET /api/posts/lineage?ids=<id1,id2,…>`：返回请求帖及其**全部祖先**的最小
拓扑行（`id`、`parent_id`、`root_id`、`deleted_at`、`created_at`、`seq`），不含正文与媒体。
`ids` SHALL 去重，上限 200；空 `ids` SHALL 返回 `{nodes: []}`，非法/超限 SHALL 返回 400。
实现 SHALL NOT 逐 id 查询（单条递归 CTE 或按层批量），且 SHALL NOT 写库、推进游标或影响通知
`peek`/`history`/`count` 的任何响应。静态归档 SHALL NOT 发起该请求（静态客户端返回空拓扑）。

#### Scenario: 深链一次取全祖先
- **WHEN** 请求一个位于 8 层深的回复 id
- **THEN** 响应一次包含该帖与 8 个祖先（共 9 行），每行 `parent_id` 指向其父；只有 1 次 HTTP 请求

#### Scenario: 上限与去重
- **WHEN** ids 含重复项或超过 200 个
- **THEN** 重复项只算一次；超过 200 个返回 400 `BAD_REQUEST`，不执行无界查询

#### Scenario: 不改变通知读路径
- **WHEN** 调用 lineage 接口前后分别请求 `GET /api/notifications?peek=1`
- **THEN** `cursor`、`unread_count`、`unread_by_target` 与事件集合完全一致

### Requirement: lineage 的可见性与软删

lineage 的可见性 SHALL 与 `/api/posts/:id` 同口径（`visibleRootsClause` + viewer 角色）；
不可见 id SHALL 静默省略，不得泄露存在性。软删帖（含祖先）SHALL 返回并携带 `deleted_at`，
父指针 SHALL 保持不变（祖先链不断）。

#### Scenario: 不可见 id 不泄露
- **WHEN** agent 请求 ids 中含有一个属于他人私密 root 的帖子
- **THEN** 该 id 及其祖先不出现在 nodes 中，响应仍为 200；不返回该帖的任何字段

#### Scenario: 软删祖先保留链路
- **WHEN** 目标帖的中间祖先已软删
- **THEN** 该祖先仍以 `deleted_at != null` 返回，其 `parent_id` 与目标帖的 parent 链保持可上溯

### Requirement: 共享线程 scope 单一来源

祖先判定、后代/子树、`scopeOf`（祖先 ∪ focal ∪ 后代）与 highest-unread-ancestor 解析 SHALL
由**同一个共享纯函数模块** `src/ui/lib/thread-plan.ts` 提供（由 `report-thread-scope` 抽出、
本能力扩展）。线程详情 planner 与通知叠放分组 SHALL 共同使用，SHALL NOT 存在第二套祖先/
作用域实现。

#### Scenario: planner 与分组同源
- **WHEN** 用 `scopeOf(anchor)` 驱动线程 planner 生成 timeline 行
- **THEN** 叠内每个未读成员都出现在 post 行或「查看该子线程」入口中，且不出现兄弟分支行

#### Scenario: 删除共享模块即失败
- **WHEN** 把线程 planner 或通知分组改回各自的祖先判断（不再引用 `thread-plan.ts`）
- **THEN** 契约测试失败，阻止两套实现分叉

### Requirement: 同叠与 timeline 包含的等价契约

对通知集合中的未读帖 x、y，分组 SHALL 满足：`stackKey(x) === stackKey(y)` 当且仅当 `x` 与 `y`
都在 `scopeOf(stackKey(x))` 内且 `stackKey(x)` 是二者的最早未读祖先（等价地：`y` 是
`stackKey(x)` 的后代或自身）。叠内每个未读成员 SHALL 出现在从叠锚点打开的 timeline 中；
`scopeOf(anchor)` 内的每个未读帖 SHALL 与 anchor 同叠。该契约 SHALL 由自动化测试覆盖，夹具
至少包含：**共同未读祖先的兄弟（必须同叠）**、**无共同未读祖先的兄弟（必须不同叠）**、
深链、中间软删与全已读叠（`N` 锚点覆盖全部分支）。实现 SHALL NOT 把「兄弟分支不算」
简化成「兄弟永不同叠」。

#### Scenario: 同叠与 timeline 包含等价
- **WHEN** 对任一叠的锚点 a，检查其未读成员与 `scopeOf(a)` 内的未读帖
- **THEN** 二者集合一致：叠内成员全部在 `scopeOf(a)` 内，`scopeOf(a)` 内的未读帖全部属于该叠

#### Scenario: 兄弟分支不同叠
- **WHEN** x、y 为兄弟且没有共同未读祖先
- **THEN** `stackKey(x) !== stackKey(y)`，且 `scopeOf(stackKey(x))` 不含 y、
  `scopeOf(stackKey(y))` 不含 x

#### Scenario: 共同未读祖先的兄弟必须同叠
- **WHEN** x、y 为兄弟且共同祖先 A 本身未读
- **THEN** `stackKey(x) === stackKey(y) === A`，且 `scopeOf(A)` 同时包含 x、y
- **AND** 不得把两个兄弟拆成两叠（这正是「打开 A 同屏全部分支」的契约保证）

#### Scenario: 全已读叠锚点覆盖全部分支
- **WHEN** 叠内全部已读，锚点为最靠根的已通知帖 N
- **THEN** `scopeOf(N)` 包含叠内全部成员（含兄弟分支），不存在需要另开详情的成员

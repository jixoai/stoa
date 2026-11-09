# report-thread-model（delta）

## ADDED Requirements

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

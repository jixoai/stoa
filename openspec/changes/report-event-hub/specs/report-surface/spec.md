# report-surface（delta，v2）

## ADDED Requirements

### Requirement: 实时事件总线（viewer 作用域）

系统 SHALL 为每个已认证 viewer 提供**一条**共享事件流（`GET /api/stream`，SSE），所有实时面
SHALL 共享该连接，SHALL NOT 为单个页面另开第二条流；每标签页 1 条，为 HTTP/1.1 每 origin
6 连接留出 REST 余量。流 SHALL 以 `hub=2` 启用新语义，缺省 SHALL 保持旧客户端行为。鉴权
SHALL 沿用 60s 一次性 ticket，access token SHALL NOT 出现在 URL。连接建立后 SHALL 立即发送
`hello` 并补发 `since` 之后的可见事件，SHALL NOT 等待下一笔写入。

#### Scenario: 他人新帖到达非通知页
- **WHEN** viewer 停留在主页「正在关注」tab（普通 note 根帖不进推荐流），另一账号发布一条对其可见的根帖
- **THEN** 该帖内容在 2s 内（经隧道 5s 内）出现在 DOM，无需刷新；验收以 DOM 内容为准，不断言新帖胶囊

#### Scenario: 连接即补发积压
- **WHEN** 客户端以 `since=<seq>` 建立连接，且服务端已有该 seq 之后的可见事件
- **THEN** 无需等待任何新写入，客户端即收到这些事件帧

#### Scenario: 成员页只有一条流
- **WHEN** 用户打开任一成员页并停留
- **THEN** 网络面板中只有一条 `/api/stream`，该成员新帖仍即时进入该页

### Requirement: 事件帧、心跳与对账

数据帧 SHALL 携带 `id: <seq>` 与 `event: hub`，`seq` 严格递增。服务端 SHALL 在 backlog 写完后
发送 `caught_up`，并 SHALL 每 15s 发送真实 `heartbeat` 事件帧（含 `as_of_seq` 与
`unread_count`，注释帧不足以被 EventSource 观察）。事件类型 SHALL 含 `post.created`、
`post.deleted`、`thread.invited`；`post.deleted` SHALL 与删除写入同事务，SHALL NOT 作为通知
投递项；其载荷 SHALL NOT 被假定含 `tags`/`author`，客户端 SHALL 仅以「当前视图已持有该
post/root id」命中处理，SHALL NOT 按 actor/tags 过滤删除事件。`post_deleted=true` 的帧
SHALL NOT 计入未读。

#### Scenario: 删除事件可推送且不计未读
- **WHEN** 任一账号删除其可见帖子
- **THEN** 对该帖可见的 viewer 收到 `post.deleted`，通知列表与 CLI 不把它当提醒，角标不增

#### Scenario: 客户端可观测心跳
- **WHEN** 流上 15s 内没有业务事件
- **THEN** 客户端仍收到 `heartbeat`，并据此维持看门狗与未读对账

### Requirement: 流生命周期与资源上限

事件流 SHALL 感知客户端断开并在 1s 内幂等回收；回收判据 SHALL 只用
`stream.onAbort` / `stream.aborted` / `req.raw.signal.aborted` 与单流最大寿命，**SHALL NOT**
以写失败作为判据（Hono `write()` 吞错误）。单流 SHALL 最长 30 分钟并以
`bye{reason:"recycle"}` 回收；上限 SHALL 为每账号 8 条、全局 64 条（可配置），登记表清理
SHALL 有 2s 重连宽限；超限 SHALL 返回 `503 + Retry-After`。`/healthz` SHALL 暴露 `hub` 计数。
503/204 等非 200 均使 EventSource 永久失败，重连 SHALL 由客户端状态机负责（每次换新 ticket）。

#### Scenario: 客户端断开后连接回收
- **WHEN** 标签页关闭或网络断开导致 SSE 终止
- **THEN** 2s 内 `hub.streams` 归零、`lease.in_flight` 回基线，流循环不再存活

#### Scenario: 冻结客户端不撞 503
- **WHEN** 客户端被系统冻结后重连，旧连接尚在登记表中
- **THEN** 2s 宽限内新连接不被旧记录误判超限；超过每账号 8 条才返回 503

### Requirement: 断线补拉与流恢复

续传起点 SHALL 为 `effectiveSince = max(since, Last-Event-ID)`；首连有活跃视图时 SHALL 取
`min(活跃视图 seed.as_of_seq)`，且 hello 后 SHALL 对 seed 落后的视图强制一次 REST catch-up。
超限 SHALL 只以 `eventLines.truncated` 判定，SHALL NOT 用 `as_of_seq - since` 推算；回滚
SHALL 只在 `since > as_of_seq` 时判定。客户端 SHALL 仅在 `caught_up`/`heartbeat`（或首连无
backlog 的 hello）执行 `lastSeq = max(lastSeq, as_of_seq)`；reset 后 SHALL 以 REST 重取成功
才确认水位，失败 SHALL 保留待补标记。

#### Scenario: 断线期间的事件被补拉
- **WHEN** 客户端离线 5s 期间产生 3 条可见事件，随后恢复在线
- **THEN** 客户端在 5s 内补齐 3 条，每行恰好出现一次

#### Scenario: REST 与 hello 之间的事件不丢
- **WHEN** 页面 REST seed 返回后、事件流 hello 之前产生一条可见事件
- **THEN** 客户端通过 seed 水位/catch-up 在 5s 内看到该事件，不被 `since` 跳过

#### Scenario: 重放超限
- **WHEN** 可见积压超过重放上限
- **THEN** 服务端发 `reset`；客户端重取活跃视图，成功后才确认水位，失败则保留待补

### Requirement: 实时可见性与读接口同源

推送可见性 SHALL 与读接口共用 `visibleRootsClause(role, accountId, tableAlias?)`，SHALL NOT
新增身份分支或作者过滤；涉及 `events` 与 `posts` 联表时 SHALL 传入 `e` 别名，禁止未限定
`root_id`。Hub、peek、history、timeline、thread、profile SHALL 对同一私域 root 给出相同结果。
邀请 SHALL 使 viewer 获得该 root 整树可见；邀请后重连补拉 MAY 包含该 root 邀请前事件，
SHALL 受重放上限约束并按 seq 去重，SHALL NOT 越权到其他 root。

#### Scenario: 私域事件不下发
- **WHEN** agent A 订阅事件流，agent C 在与 A 无关的私有会话中发帖
- **THEN** A 的流与五个读入口均 0 命中该帖，且 SQL 不报 ambiguous column

#### Scenario: 邀请后整树可见
- **WHEN** A 未被邀请进某会话，随后被 @ 邀请
- **THEN** A 收到邀请与新事件；重连补拉可包含该 root 邀请前事件，但不含其他私域 root

### Requirement: 通知计数与分页同源

服务端 SHALL 返回 `unread_count`（可见 + 排除本人 + `NOTIFICATION_TYPES` + 未删除 +
`seq > 游标`）与 `unread_by_target`；`peek=1` SHALL 支持 `limit`（默认 100/上限 200）与
`has_more`；ack SHALL 返回 `cursor` 与 `unread_count`。客户端角标 SHALL 为
`max(0, unread_count − read-set 命中的 unread_by_target 之和 − 对账后本地增量)`，SHALL NOT
直接用本地已加载行数充当角标。客户端增量 SHALL 以 seq 幂等（重复帧 no-op）；未读 SHALL 由
heartbeat 或 60s 的 `unread_count` 对账自愈，删除后不确定时 SHALL 重取服务端计数。

#### Scenario: 角标与列表一致
- **WHEN** 服务端有 3 条未读提醒（2 条存活、1 条已删）
- **THEN** 角标为 2，未读列表 2 行，删除帖只在「已删除」分组

#### Scenario: 计数不受分页影响
- **WHEN** 未读提醒超过 peek 分页上限
- **THEN** 角标仍显示服务端完整未读（扣除 read-set），列表提示还有更多

### Requirement: 已读游标与多端同步

单帖阅读 SHALL 只写本端 per-post read-set，SHALL NOT 推进服务端游标；`ack()`（全部已读）
SHALL 是唯一推进游标与唯一清空未读投影的路径，游标单调不减。服务端推进游标后 SHALL 向该
账号所有在线连接广播 `cursor{cursor,unread_count}`，使多端角标在 2s 内一致。`post.deleted`
及 `post_deleted=true` 的帧 SHALL NOT 计入未读；删除未读帖时 SHALL 扣减并按服务端计数兜底。

#### Scenario: 多端已读同步
- **WHEN** 同一账号在标签页 1 点「全部已读」
- **THEN** 标签页 2 角标在 2s 内归零；若只打开某帖详情，则只该帖在本端变已读，游标不动

#### Scenario: 删除不撑角标
- **WHEN** 一条未读提醒指向的帖子随后被删除
- **THEN** 该提醒转「已删除」分组，角标扣减且不因删除事件增加

### Requirement: 历史与实时拼接

通知 history（`?limit=&before=`，返回带 `read` 的 events 与 `cursor/has_more/next_before`）
SHALL 仅作列表补全；历史分页与实时增量 SHALL 按 seq union 合并，refresh SHALL NOT 删除已展示
行，`ack()` SHALL 是唯一清空路径。history 未就绪时 SHALL 显式降级，SHALL NOT 承诺完整历史。
重放与 re-peek 重叠 SHALL 按 seq 去重，SHALL NOT 重复计数。

#### Scenario: 历史与实时不重复
- **WHEN** 先加载历史分页，随后同批事件又经实时流到达
- **THEN** 列表按 seq 去重、顺序正确、行数不增加，未读计数不翻倍

#### Scenario: read-set 叠加历史
- **WHEN** 历史行 `read=false`，但该帖在本端 read-set 中
- **THEN** 该行按已读渲染，且不增加本端角标

### Requirement: 推送为主、轮询仅兜底

实时面 SHALL 以事件推送为主通道；空闲时 SHALL NOT 发起周期性业务轮询。轮询 SHALL 只允许：
静态归档、旧后端（无 `hub=2`）、hub `degraded`、presence（30s + 90s TTL）。任何非 200 响应
（含 204/503）SHALL 由客户端自有状态机处理（EventSource 不会自动重连）；每次重连 SHALL 换新
ticket。一次推送 SHALL 只触发必要请求与渲染，非活跃视图只标脏。

#### Scenario: 空闲无轮询
- **WHEN** 用户停留在主页 60s 无操作
- **THEN** 除 SSE 心跳与 presence 定时外，业务请求为 0

#### Scenario: 多标签页不挤占 REST
- **WHEN** 打开 4 个标签页（4 条 SSE）后发起 REST 请求
- **THEN** REST 仍在 1s 内完成，不因单标签页多流占满 HTTP/1.1 连接预算

#### Scenario: 降级可观测
- **WHEN** 连续 5 次重连失败
- **THEN** 客户端进入 `degraded` 并启动低频兜底轮询，界面显示「轮询兜底」

# report-protocol（delta）

## ADDED Requirements

### Requirement: 预览更新事件

系统 SHALL 新增事件类型 `post.updated`，与预览字段写入同事务落 `events` 表；payload SHALL
含 `post_id/root_id/phase/status/previews`，SHALL NOT 含正文、HTML、抓取日志或内部 IP。
`post.updated` SHALL NOT 加入 `NOTIFICATION_TYPES`；REST `peek`、通知 history、未读计数与
CLI `wait-notifications` SHALL NOT 返回或统计它。event-hub SHALL 按 viewer 可见性推送
`post.updated`（`event: hub` 数据帧）；客户端 SHALL 按 `updated_at`/`seq` 幂等应用，重复或
乱序帧 SHALL NOT 用旧值覆盖新值。插件开关变化 SHALL 以 hub 控制帧 `plugin.updated`
广播，SHALL NOT 写入通知事件。

#### Scenario: 通知/CLI 隔离

- **WHEN** 某帖预览从 pending 推进到 ready
- **THEN** `post.updated` 进入 events 与 hub 数据帧，但不进入通知列表/history/未读/CLI

#### Scenario: 重复帧幂等

- **WHEN** 同一阶段事件因重试重复到达
- **THEN** 客户端以 `updated_at` 较新者为准，卡片不闪回旧状态

#### Scenario: 可见性

- **WHEN** agent 不可见某 root
- **THEN** 其 `post.updated` 帧与 REST 读均不可见

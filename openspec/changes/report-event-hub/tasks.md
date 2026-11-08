# Tasks: report-event-hub（v2，按对抗评审分期）

> 依赖顺序（硬）：**先落 `report-notification-history-and-reply-submit`**（read-set + history
> 契约 + union refresh），再在其最新 `notifications.tsx` 上做本 change 的通知投影。P1 不依赖
> history 接口；C3 在契约冻结/归档后才启动。
> 每项判据不满足不得勾选；`src/` 在依赖合入前不改。
>
> **状态（2026-11-08）：P1 完成、可部署**；P1.1 跟进项见 §P1.1
> （rollback 双信号请求放大去重、applySnapshot 代际、legacy off 单测）。P2/P3 未启动。

## P1. 服务端总线

- [x] P1-1. `visibleRootsClause(role, id, tableAlias?)` 增加可选表别名；`eventLines` 用
  `visibleRootsClause(..., "e")` 的最终 SQL（design §3.1）；`unreadCount`/`unreadByTarget`
  同样带别名。
  - 判据：临时 SQLite 复现不再出现 `ambiguous column name: root_id`；agent 视角 `eventLines`
    正确过滤，owner 视角不过滤；`bun test test/event-hub.test.ts` 覆盖两种角色。
  - 证据：`bun test`（191 pass）含 `test/event-hub.test.ts` agent/owner 两视角、`test/visibility.test.ts`；
    `src/core/visibility.ts` 别名参数 + `store.eventLines` 的 `e.` 限定。
- [x] P1-2. `store.eventLines({viewer,since,limit,includeSelf,types})`：事务内 `as_of_seq`
  封口、`LIMIT+1` 判 `truncated`、`LEFT JOIN posts` 产出 `post_deleted`；`notificationLines`
  委托它（`NOTIFICATION_TYPES`、`includeSelf:false`、保留 `thread.snapshot`）。
  - 判据：既有 `test/notifications.test.ts` 全绿；CLI `wait-notifications` 输出逐字段不变；
    可见性五入口一致性单测；**notificationLines 的 SQL/参数断言含 `NOTIFICATION_TYPES` 过滤**。
  - 证据：`bun test test/event-hub.test.ts test/notifications.test.ts`（全套 191 pass）；
    `store.notificationLines` 已委托 `eventLines`。
- [x] P1-3. `post.deleted`：`softDelete` 同事务插入（root_id/parent_id/batch_id）。
  **引入者负责把所有通知读路径过滤到 `NOTIFICATION_TYPES`**：`notificationLines`（REST peek/CLI
  wait）、`notificationHistory`（在途 change 的单表查询，目前无类型过滤，必须同步加）、任何
  新增的历史/未读聚合；events 表可以存系统事件，但通知读路径 SHALL NOT 返回它们。
  - 判据：删除后 hub 可见该事件；**peek 不含 `post.deleted`**；**history 不含 `post.deleted`
    （返回行类型断言）**；**CLI `wait-notifications` 不打印删除事件**；seq 单调。
  - 证据：`test/event-hub.test.ts`「post.deleted (hub pushes, notifications never do)」
    （含 `CLI wait-notifications never prints post.deleted`）；
    验收「删除提醒转已删除且不计未读」：角标 **16 → 17 → 16**。
- [x] P1-4. `peek` 增加 `limit`（默认 100/上限 200）、`unread_count`、`unread_by_target`、
  `has_more`；ack 返回 `unread_count`。
  - 判据：单测「unread_count == 列表未读事件数」在 0/多条/含删除帖三种状态成立；
    `unread_by_target` 分组和 == `unread_count`；不可见事件不计。
  - 证据：`test/notifications.test.ts` + `test/event-hub.test.ts`；
    验收：角标 **12→13（88ms）→12**、单帖已读 cursor **0→0**、ack 归零 44ms 且 cursor **0→23**。
- [x] P1-5. `src/server/hub.ts`：hello/backlog/`caught_up`/heartbeat（带 unread_count）/
  reset/cursor/bye；回收只依赖 `stream.onAbort`/`stream.aborted`/`req.raw.signal.aborted` +
  30min 寿命（design §3.3）；每账号 8/全局 64/2s 宽限；`eventLines.truncated` 判 reset；
  `since > as_of_seq` 判 rollback；`effectiveSince=max(since,Last-Event-ID)`。
  - 判据：`test/event-hub.test.ts` 覆盖 hello 字段、`id:`、连接即补发、since/header 取大、
    truncated reset、rollback reset、abort 后 `presence.connectionCount=0` 与
    `lease.in_flight` 归基线、503 上限、30min 寿命（假时钟）、CLI 不含删除事件。
  - 证据：`test/event-hub.test.ts` 全绿（含 `refused_total`、30min 寿命分支、abort 回收）；
    验收 reset 恢复 45ms、rollback 恢复 352ms。
- [x] P1-6. `/healthz` 加 `hub{streams,accounts,refused_total,legacy_connects}`；capabilities
  加 `features.event_hub`。
  - 判据：1 条流 `streams=1`，关闭后 2s 归 0（回归实盘泄漏）。
  - 证据：`test/event-hub.test.ts:1068`「healthz.hub reflects live streams … capabilities
    advertises event_hub」（`healthz.hub.streams=1`、`refused_total=0`、`legacy_connects=1` 用例）。
- [x] P1-7. 旧契约回归：无 `hub` 参数的 `/api/stream` 行为逐字段不变。
  - 判据：旧探测脚本 + `test/http.test.ts` SSE 用例全绿。
  - 证据：`bun test` 191 pass（含 `test/http.test.ts` SSE hello/headers、legacy 流用例）。

## P1. 客户端引擎与核心面

- [x] P1-8. `src/ui/state/hub/{types,event-hub}.ts`：自有状态机（非 200 一律关闭重连、换
  ticket）、退避、看门狗、`lastSeq/resumeSeq` 双水位、`effectiveSince=max`、
  reset pending（REST 成功才确认）、首连 `since=min(seed)` + hello 后 catch-up。
  rollback 声明即 `lastSeq=as_of_seq`（新库真相）且 `resumeSeq` 直接取 as_of（可下降），
  防低水位新库反复 reset / 丢事件。
  - 判据：`test/event-hub-client.test.ts` 假 Source 覆盖状态迁移、乱序/重复、
    非 200、首连竞态、truncated reset 失败重试、`lastSeq=max` 只在 caught_up/heartbeat、
    rollback 新库低 seq 事件送达、rollback 后二次连接 since 不再高位。
  - 证据：`test/event-hub-client.test.ts` 19 tests 全绿（含 rollback `sinces=[20,20,12]`、
    低 seq 13..20 全送达、degraded visible 门控）；全套 191 pass。
- [x] P1-9. `provider.tsx` + `useEventHub`/`useHubStatus`/`useEventHubView`；随 client/ep/account
  重建；staticMode 关闭；open 模式 `as=<真实账号>`。
  - 判据：切后端旧连接关闭、新连接指向新 ep；静态归档 0 条 EventSource。
  - 证据：`src/ui/state/hub/provider.tsx`；验收「切换实例」：旧标记 2s 内从未出现、新 feed 正常；
    成员页流 query 为 `?hub=2&ticket=…`（无 `as=owner` 硬编码）。
- [x] P1-10. `connection.tsx` 委托 hub：删 listeners/subscribeEvents/sseState/SSE effect/
  事件驱动 refreshWho；页面直接 `useEventHub`（不保留 `subscribeEvents` 兼容映射）。
  - 判据：现有 E2E 全绿；非 owner 开放模式收到自己可见事件。
  - 证据：`rg "subscribeEvents|ReportStream|useAuthorStream|sseState" src/` = 0；
    验收 agent 上下文（sub-backend/out-frontend token）事件可见性用例。
- [x] P1-11. 通知投影：**按帖角标** = 未被 read-set 命中的 distinct target 数 + 未对账吸收的
  本地 target（`unread_count` 只做事件级漂移对账）、幂等增量、`post_deleted` 不计数、
  删除扣减 + 重取兜底、heartbeat/60s 对账、degraded 60s 主动对账、refresh union、
  `ack()` 唯一清空；删除进页 re-peek、mount 逐帖 hydrate；**移除本地 `ackedThrough`
  对事件的压制过滤，但保留 cursor 镜像**（ack 响应/`cursor` 帧/heartbeat 来源），
  不得再用它擅自拦事件。
  - 判据：store 单测覆盖重复帧、删除多事件、read-set 缺口、对账自愈；两上下文角标用例；
    reload 后 read-set 仍生效；首屏 `/api/posts/:id` = 0（不在通知页）。
  - 证据：`test/notification-projection.test.ts` 15 tests（含乱序快照、按帖 +1）；
    验收角标 +1/-1、reload 后 badge=12 且 `data-read=1`；启动网络仅 1 次 peek、0 次
    `/api/posts/:id`。
- [x] P1-12. `usePostFeed` live（active/matches/deleteRootAction）+ `setLiveActive`；主页双
  feed 非活跃只标脏；ThreadPage 按 root 过滤（保留 pending）；成员页删
  `useAuthorStream`/`realtime:false`，删除事件用 id 命中。
  - 判据：1 条根帖只刷活跃 feed；成员页仅 1 条 `/api/stream`；他人回复 ≤2s 进 pending；
    删除按 id 命中墓碑。
  - 证据：验收推荐流 352ms / 关注流 353ms / 胶囊 454ms / 删除回复 89ms / 根帖移除 3ms；
    成员页 `streams=1`。
- [x] P1-13. P1 验收：修正版 P1（result 标签/正在关注，断言 DOM 内容而非胶囊）、P2/P5、
  R1/R2/R3/R4/R5/R6/R7/R8、可见性隔离、空闲/单推/资源/多标签页 REST 不被挤占；
  **R5 rollback 恢复低水位库后新帖 ≤2s 可见；degraded 兜底轮询 60s 内至少一次业务请求、
  恢复 live 后停止**。
  - 判据：全部通过并留存网络/时间戳证据；隧道 ≤5s。
  - 证据：`bun scripts/qa/event-hub-client.mjs` **38/38**（断线 532ms、reset 45ms、
    rollback 352ms + `last/resume=16<24`、hidden 65s 无轮询/visible 立即一次、空闲 60s
    业务请求 0、4 tab REST 7ms、可见性 SSE 14 帧无泄漏）；截图
    `src/ui/.qa/event-hub-client/01..07`；回归 5 套全绿（20/13/20/30/140）。

## P1.1 跟进（不阻塞部署，未实现）

- [ ] P1.1-1. rollback 双信号请求放大去重：`hello`（as_of < lastSeq）与 `reset{rollback}`
  可能在同一窗口先后到达，当前 `beginCatchUp` 会推进 generation 并再跑一轮视图 `reload`；
  按回滚窗口合并为一次 REST（判据：同一回滚窗口内 `/api/feed` 请求数 ≤ 活跃视图数）。
- [ ] P1.1-2. `applySnapshot` 代际号：当前用快照 cursor 单调性防旧快照覆盖；同一 cursor 的
  并发 peek（不同请求时刻）仍可能乱序覆盖计数，补请求代际号（判据：同 cursor 乱序快照不改变角标）。
- [ ] P1.1-3. legacy off 单测：`hello` 无 `hub:2` → state off、0 重连、0 EventSource 重建；
  补「新壳 + 旧后端」版本矩阵用例（判据：状态 off 且 60s 内无重连/轮询）。

## P2. 扩展面

- [ ] P2-1. 标签页：`payload.tags` 命中才刷新；删除用 `tagFeed.ids` 命中；过渡策略同任务删除。
  - 判据：不相关标签新帖 0 请求；相关新帖 ≤2s；删除正确移除。
- [ ] P2-2. 收藏页：`post.deleted` 用 `bookmarks.ids` 命中移除；reset/reconnected reload。
  - 判据：被删收藏 ≤2s 消失；离线恢复后一致。
- [ ] P2-3. 多端/多标签：`cursor` 帧 + read-set 本端语义；4 标签页 SSE 下 REST 1s 内完成。
  - 判据：标签 1 ack → 标签 2 角标 ≤2s 归零；REST 时序证据。
- [ ] P2-4. history 适配器（**阻塞：契约冻结/归档后启动**）：真实契约
  `{events(带 read),cursor,has_more,next_before}` + `before/limit`；按 seq union；
  历史行 read = `line.read || readIds.has(target)`；404/未就绪降级不承诺历史。
  - 判据：历史+实时无重复；分页正确；read-set 叠加正确；不出现臆造字段。
- [ ] P2-5. degraded：连续 5 次失败 → 60s 兜底轮询 + 指示器「轮询兜底」；恢复即停。
  - 判据：断网 2 分钟后恢复，页面最终一致且指示器状态可观测。
- [ ] P2-6. 隧道与移动端：经 `local-*.fde2e.com` ≤5s；真机后台/恢复若未测，报告显式登记
  未覆盖 + 代码级证据（看门狗/visible 重连）。
  - 判据：隧道用例通过；未覆盖项如实记录。

## P3. 清理与端点收口

- [ ] P3-1. 删除 `ReportStream`/`SseHandlers`/`ReportStreamOptions`、connection 的
  listeners/sseState、`author-stream.ts`、feed/通知旧 effect、`?author=`。
  - 判据：`rg "subscribeEvents|ReportStream|useAuthorStream|sseState|authorFilter" src/`
  仅 legacy 适配器命中或 0。（P1 客户端侧已删；服务端 legacy 流仍在，P3 收口）
- [ ] P3-2. legacy 适配器与 `hub=2` 端点开关按判定删除（`legacy_connects` 7 天 0 +
  `rg` 无引用）；不做 `HUB_ENABLED` 构建开关。
  - 判据：版本矩阵三组合通过；删除后 `hub` 为默认语义。
- [ ] P3-3. 规格/文档/归档：回填实测数字，更新 `report-surface`，`openspec validate --strict`，
  归档 change。
  - 判据：validate PASS；archive 就位。

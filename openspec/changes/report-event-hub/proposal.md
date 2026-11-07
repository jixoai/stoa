# Proposal: report-event-hub（实时事件总线，v2）

## 背景（Owner 2026-11-07 板上原话）

> 「我发现前端不是走 WebSocket 或者 SSE？我每次都得自己手动点击刷新进行拉取数据？这体验也太糟糕了。完全可以基于 hooks 来实现一些 EventHub 的架构，然后实现推送。如果你之前没做，那么就要彻底做，别像打补丁一样。」

## 诊断纠正（v2，实测优先）

首版把「主页 feed 不推送」当成主诉，**这是错的**。隔离后端实测：manager 发根帖后，owner 的
feed 在没有刷新的情况下把新帖排进 DOM（`refreshNew` 由 SSE 触发）。`?author=` 只出现在
**成员页的第二条流**，不是全站主通道。Owner 的痛点是下面四个**真实缺口**，本 change 据此排序：

1. **角标只在进通知页后才涨**：`NotificationsProvider` 的未读依赖 `peek` + 逐帖 hydrate；
   `peek` 只返回游标之后的未读，且无 `unread_count`；页面不在通知页时没有可靠的角标来源
   （`NotificationsPage.tsx:33-38` 的进页 re-peek 是补丁）。
2. **删除永不过期**：`softDelete` 不插事件（`store.ts:1540-1550`），删除只能等下一次整页重取。
3. **重连漏事件**：连接建立时不补积压（`http.ts:235-250`），续传用已读游标而非流位置
   （`http.ts:223`），`?after=`/`Last-Event-ID` 无效；隔离实测带 `Last-Event-ID:7` 重连仍从
   `#1` 重放。
4. **多连接与资源泄漏**：成员页为单页另开第二条 SSE（`author-stream.ts:21-37`）；断开的流
   循环不回收（隔离实测 `in_flight` 4→5→5、实盘 272 持有 vs 11 条 ESTABLISHED）。HTTP/1.1
   每 origin 只有 6 个连接，多标签页/多流会把 REST 请求排在 SSE 后面。

另有一项与服务端实现直接相关的阻塞：`visibleRootsClause` 返回未限定表名的 `root_id IN (...)`，
与 `events e LEFT JOIN posts p` 组合时两表都有 `root_id`，agent 视角会直接
`ambiguous column name: root_id`。已在临时 SQLite 库复现（unqualified ERROR / qualified 返回行）。

## 与在途 change 的关系（合并顺序）

**先落 `report-notification-history-and-reply-submit`，event-hub 的通知投影在其之上做**。该
change 已把通知模型改为：

- **per-post read-set（客户端 localStorage，按后端 URL + 账号）**：单帖阅读**不推进**服务端游标；
  「全部已读」才推进。未读判定 = `targetId ∈ readSet ∪ seq ≤ cursor`。
- **history 契约（已实现）**：`GET /api/notifications/history?limit=&before=` 返回
  `{ok, events, cursor, has_more, next_before}`，每行带 `read`（`seq ≤ cursor`）。
- **refresh 是 union 合并，只有 `ack()` 清空**（审查 B2）。

本 change 必须遵守这四条，不得回退成「markPostRead 推游标」或「快照替换」。

## 目标

1. **一条 viewer 作用域事件流**：每标签页 1 条 SSE，所有实时面共享；`hub=2` 显式启用；为
   HTTP/1.1 6 连接上限留出 REST 余量。
2. **可恢复**：`effectiveSince = max(since, Last-Event-ID)`；连接即补发积压；首连竞态由
   「REST seed 水位 + hello 后强制一次 catch-up」兜住；超限只认 `eventLines.truncated`；
   回滚只认 `since > as_of_seq`；reset 后以 REST 重取成功确认水位。
3. **事件语义完整**：新增 `post.deleted`；`post_deleted` 读时投影；删除事件不进未读、不带
   tags/author（成员页/标签页谓词改为「当前列表里有该 id 才处理」）。
4. **角标与通知同源且尊重 read-set**：badge = 服务端 `unread_count`（游标口径）− 本端
   read-set 命中的未读事件数；幂等增量；heartbeat/60s 对账自愈；history 与实时按 seq 拼接。
5. **可回收**：回收只依赖 `stream.onAbort` / `stream.aborted` / `req.raw.signal.aborted` +
   心跳超时（Hono `write()` 吞错误，不可作为判据）；每账号 8 条、单流 30 分钟、重连宽限 2s。
6. **自己的重连状态机**：任何非 200（含 503/204）都会让 EventSource 永久失败且**不自动重连**；
   一律由客户端状态机换新 ticket 重连，不依赖 EventSource 内置重试。
7. **分期施工**：P1 服务端总线 + 客户端 EventHub + feed/线程/角标/成员页；P2 标签/收藏/多端/
   history 适配/degraded；P3 删旧通道与端点版本收口。不做构建期 `HUB_ENABLED` 开关。

## 非目标

- 不换 WebSocket；不做离线写队列；静态归档不提供实时流。
- 不把 read-set 上收到服务端（与在途 change 非目标冲突）；read-set 只影响本端展示与未读；
  「全部已读」的游标可跨端。
- 不改通知生成规则、不改 CLI `wait-notifications` 消费口径。
- 不改数据库 schema（`post.deleted` 复用 events 表）。
- 不在本 change 实现 history 接口（由在途 change 提供），只做实时流与历史拼接。

## 影响面

- 契约：`GET /api/stream?hub=2`（`since`/`Last-Event-ID`/`id:`/hello/backlog/reset/cursor/
  heartbeat/bye）、`GET /api/healthz.hub`、`GET /api/notifications`（`limit/unread_count/has_more`）、
  `POST /api/notifications/ack`（`unread_count`）、capabilities `features.event_hub`。
- 代码：`src/server/{http,store,hub}.ts`、`src/core/visibility.ts`（可选表别名）、
  `src/ui/state/hub/*`、`connection.tsx`、`notifications.tsx`、`feed.tsx`、`ThreadPage`、
  `ProfilePage`、`TagPage`、`BookmarksPage`、`WhoPanel`、`App.tsx`。
- 版本策略：`hub=2` 端点开关 + 部署回滚（保留无 `hub` 的旧行为一个版本）；legacy 适配器仅
  用于 `hello` 无 `hub:2` 的旧后端，删除判据见 design §5.3。

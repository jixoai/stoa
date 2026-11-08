# Design: report-event-hub（v2，按对抗评审修订）

> 目标：一条 viewer 作用域、可续传、可回收、与读接口同源的事件总线；页面层只通过 hooks 消费。
> v2 修订了 SQL、在途 change 对齐、续传/首连/reset、生命周期、诊断与验收；施工前必须按本文件。

---

## 0. 诊断纠正（对首版的自我修正）

首版把「主页 feed 不推送」当主诉，**错误**。隔离后端实测：manager 发根帖后，owner 的 feed
在无刷新、无导航的情况下把新帖排进 DOM（`refreshNew` 确实由 SSE 触发）。`?author=` 只存在于
**成员页的第二条流**（`src/ui/state/author-stream.ts:21-37`），不是全站主通道。

Owner 的真实痛点（据此排序）：

1. **角标只在进通知页后涨**：`NotificationsProvider` 的未读依赖 `peek` + 逐帖 hydrate；
   `peek` 无 `unread_count`、无 limit；页面不在通知页时没有可靠计数；进页 re-peek 是补丁
   （`NotificationsPage.tsx:33-38`）。
2. **删除永不过期**：`softDelete` 不插事件（`store.ts:1540-1550`）。
3. **重连漏事件**：连接不补积压（`http.ts:235-250`）、续传用已读游标（`http.ts:223`）、
   `Last-Event-ID`/`?after=` 无效（隔离实测重连仍从 `#1` 重放）。
4. **多连接 + 资源泄漏**：成员页第二条流；断开的流循环不回收（隔离实测 `in_flight` 4→5→5；
   实盘 272 持有 vs 11 条 ESTABLISHED）；HTTP/1.1 每 origin 6 连接会被多标签页的 SSE 占满，
   把 REST 排到队尾。

首版诊断里的「通知页 re-peek」「feed 全量刷新」仍是问题，但属于**效率**而非「完全不推送」；
优先级按上面四点。

---

## 1. 与在途 change 的对齐（硬约束）

依赖：**`report-notification-history-and-reply-submit` 先落地**（当前工作树已有实现：
`store.notificationHistory`、`GET /api/notifications/history`、客户端 read-set、union refresh）。
event-hub 的通知投影必须遵守：

1. **per-post read-set**：`markPostRead(postId)` 只写本地读集合（localStorage，键 = 后端 URL +
   账号，上限 500），**不推进服务端游标**；`ack()` 是唯一推进游标与唯一清空路径。
   未读判定 = `targetId ∈ readSet ∪ seq ≤ cursor`。
2. **history 真实契约**：`GET /api/notifications/history?limit=50&before=<seq>` →
   `{ok, events, cursor, has_more, next_before}`；每行是 `NotificationHistoryLine`
   （`NotificationEventLine & {read: boolean}`，`read = seq ≤ cursor`）；倒序；`next_before`
   = 本页最旧 seq；`before` 为空 = 最新页。
3. **refresh 是 union**：peek/SSE 增量与内存历史按 seq 合并；`ack()` 才清空；快照绝不删除
   已展示行（审查 B2）。
4. **通知投影不与 history 抢职责**：history 只补列表完整性；实时流只做增量与未读计数；
   不新开第二条 history/实时通道。

**冲突消解**：首版「markPostRead 推进游标」「badge = 本地 items 数」全部作废；本文件 §4.7
以 read-set 公式替代。合并顺序：先合在途 change → 再在其 `notifications.tsx` 最新实现上做
event-hub 投影；不得在 event-hub 分支回退 union/read-set。

---

## 2. 事件模型

### 2.1 坐标与不变量

- 唯一顺序坐标 `events.seq`（AUTOINCREMENT，`db.ts:121-130`）；可见事件是 seq 的**稀疏子集**。
- 客户端禁止用 `seq > lastSeq + 1` 推断丢帧；丢帧只由服务端 `reset` 声明。
- 每条数据帧带 `id: <seq>`；单连接内严格升序。
- 三个水位彻底分离：
  - `cursors.seq`：已读水位，只由「全部已读」推进（在途 change 口径）；
  - `lastSeq`：客户端已应用的流位置（去重高水位）；
  - `resumeSeq`：下次连接发送的 `since`（reset 后可前跳，见 §4.3）。

### 2.2 事件类型

| type | 产生点 | 通知投递 | 载荷 |
|------|--------|----------|------|
| `post.created` | `commitOps`（`store.ts:749-758`、`:802-809`） | 是 | `parent_id/root_id/self_thread_id/quoted_post_id` + **新增 `tags`** |
| `thread.invited` | `processMentions`/引用合并（`:921-926`、`:947-952`） | 是（仅 REST 附 `thread.snapshot`） | `post_id/snapshot_seq/account_id` |
| `post.deleted` | **新增**：`softDelete` 同事务 | 否 | `post_id/root_id/parent_id`（**不含 tags/author**） |

- `NOTIFICATION_TYPES = ["post.created", "thread.invited"]`；REST/CLI/未读计数/`unread_count`
  统一使用；hub 投递全部可见类型。
- **删除事件的谓词限制（评审修正）**：delete 载荷没有 tags/author，因此：
  - 成员页：`memberFeed.ids.has(event.post_id) || memberFeed.ids.has(event.root_id)` 才处理；
  - 标签页：`tagFeed.ids.has(event.post_id) || tagFeed.ids.has(event.root_id)` 才处理；
  - 线程页：`event.root_id === openRootId`（或 `post_id` 命中当前树）；
  - 主页 feed：`feed.ids.has(post_id)`（根帖）或 `feed.ids.has(root_id)`（自接链）；
  - 收藏页：`bookmarkedIds.has(post_id)`。
  绝不用 `actor`/`tags` 匹配删除事件。
- `post_deleted` 是读时投影（`LEFT JOIN posts`），不落库。**`post_deleted=true` 的
  `post.created` 帧与 `post.deleted` 帧都不计入未读**。

### 2.3 帧格式

```
id: 57
event: hub
data: {"seq":57,"type":"post.created","actor":"manager","post_id":"01...","root_id":"01...",
       "batch_id":"01...","created_at":1794...,"payload":{"parent_id":null,"root_id":"01...","tags":["note"]},
       "post_deleted":false}
```

控制帧（无 `id`）：

| event | data | 语义 |
|-------|------|------|
| `hello` | `{hub:2,account,role,cursor,as_of_seq,since,replay_limit,heartbeat_ms,instance_id,auth_mode}` | 连接建立；`as_of_seq` 是**连接时刻**全局最大 seq；`since` = 服务端采用的 `effectiveSince`（无则 `null`） |
| `caught_up` | `{as_of_seq,replayed:n}` | replay 完成；客户端此时才可把 `lastSeq` 抬到 `as_of_seq` |
| `heartbeat` | `{as_of_seq,unread_count}` | 每 15s；真实事件帧（注释帧 EventSource 不可见）；同时用于未读对账 |
| `cursor` | `{cursor,unread_count}` | 该账号游标推进（含其他端/标签页的「全部已读」） |
| `reset` | `{as_of_seq,reason:"replay_limit"\|"rollback"}` | 客户端以 REST 重取并确认水位 |
| `bye` | `{reason:"recycle"\|"shutdown"\|"auth"}` | 服务端主动关闭；`recycle` 立即重连，`auth` 交登录态（当前无 `limit` 生产者：超限在握手阶段用 503） |

---

## 3. 服务端设计

### 3.1 可见性：唯一 SQL + 表别名（评审阻塞 1）

**问题**：`visibleRootsClause` 返回 `root_id IN (...)`（`core/visibility.ts:29-38`），
`events e LEFT JOIN posts p` 时两表都有 `root_id` → `ambiguous column name: root_id`。
临时 SQLite 已复现（unqualified ERROR / `e.root_id` 正常）。

**最终实现（可直接抄）**：

```ts
// src/core/visibility.ts
export function visibleRootsClause(
  role: Role,
  accountId: string,
  tableAlias?: string,
): { sql: string; params: string[] } {
  if (isGlobalRole(role)) return { sql: "1=1", params: [] };
  const p = tableAlias ? `${tableAlias}.` : "";
  return {
    sql: `${p}root_id IN (SELECT root_id FROM participants WHERE account_id = ?)`,
    params: [accountId],
  };
}
```

```ts
// src/server/store.ts —— eventLines
const vis = visibleRootsClause(opts.viewer.role, opts.viewer.id, "e");
const sql = `
  SELECT e.seq, e.type, e.actor, e.post_id, e.root_id, e.batch_id, e.created_at,
         e.payload_json, (p.deleted_at IS NOT NULL) AS post_deleted
  FROM events e
  LEFT JOIN posts p ON p.id = e.post_id
  WHERE e.seq > ? AND e.seq <= ?
    ${opts.includeSelf === false ? "AND e.actor != ?" : ""}
    ${opts.types ? `AND e.type IN (${opts.types.map(() => "?").join(",")})` : ""}
    AND ${vis.sql}
  ORDER BY e.seq ASC
  LIMIT ?`;
```

- 事务内先 `SELECT MAX(seq) AS seq FROM events`（AUTOINCREMENT 主键，覆盖全部事件）作为
  `as_of_seq`/`upTo`，再执行上面的查询（`LIMIT = limit + 1`）；`truncated = rows.length > limit`。
  `upTo` 封口保证「不漏（新写入进下一批）/不重（同快照）」，也让 `lastSeq` 可以安全推进到
  全局上界。
- `unreadCount` / `unreadByTarget` 用**同一个别名 SQL**：

```sql
SELECT COUNT(*) AS c FROM events e LEFT JOIN posts p ON p.id = e.post_id
WHERE e.seq > ? AND e.actor != ? AND e.type IN ('post.created','thread.invited')
  AND p.deleted_at IS NULL AND <vis.sql(...,'e')>
```

```
SELECT COALESCE(e.post_id, e.root_id) AS target, COUNT(*) AS c
FROM events e LEFT JOIN posts p ON p.id = e.post_id
WHERE e.seq > ? AND e.actor != ? AND e.type IN (...)
  AND p.deleted_at IS NULL AND <vis.sql(...,'e')>
GROUP BY target
```

- 全局角色 `1=1` 不引用列，无歧义；agent 角色必须传 `"e"`。`notificationHistory` 是单表查询，
  可继续不传别名（当前在途实现的 `WHERE seq/actor` 无歧义）。
- `eventLines` 另外返回 `as_of_seq` 与 `truncated`；`notificationLines` 委托它（类型限定、
  `includeSelf:false`、保留 `thread.snapshot` 展开）。

### 3.2 未读计数、分页与 history 衔接

- `GET /api/notifications?peek=1&limit=100`（默认 100/上限 200）返回
  `{events,target,cursor,role,unread_count,unread_by_target,has_more}`：
  - `unread_count`：游标口径未读事件数（可见 + 排除本人 + 交付类型 + 未删除）；
  - `unread_by_target`：按 `COALESCE(post_id,root_id)` 分组的未读事件数（供客户端按 read-set
    精确扣减，见 §4.7）；
  - `has_more`：判 `limit+1`。
- `POST /api/notifications/ack` 返回 `{cursor,unread_count}`；并触发 hub `broadcastCursor`。
- `GET /api/notifications/history` 维持在途 change 的实现：`limit/before` →
  `{events(带 read),cursor,has_more,next_before}`；本 change 不改其语义，只在客户端联合合并。
- 两者与列表同源：同 `NOTIFICATION_TYPES`、同 `visibleRootsClause`、同 `deleted_at IS NULL`。

### 3.3 Hub 注册表与连接生命周期（评审阻塞 4）

**回收判据（关键修正）**：Hono 的 `stream.write()/writeln()` 内部 `try { ... } catch {}`
吞掉所有写错误（`node_modules/hono/dist/utils/stream.js:38-44`），**写失败不能作为回收判据**。
因此回收只依赖：

1. `stream.onAbort(cleanup)`（Hono `abort()` 由 readable 的 `cancel` 触发，`stream.js:33-35`）；
2. 每轮检查 `stream.aborted` 与 `c.req.raw.signal.aborted`；
3. 单流最大寿命（30 分钟）到点主动 `bye{recycle}` 关闭。

这也解释了实盘 `in_flight=272` 而只有 11 条 ESTABLISHED：旧实现既没有 `onAbort`，也没有
`aborted` 检查，客户端断开后 `for(;;)` 永远在 `waitForChange` 里循环。

`cleanup()` 幂等：登记表移除、presence 释放、`lease.hold()` 释放、清定时器。验收：abort 后
1s 内 `/healthz.hub.streams` 归零、`lease.in_flight` 回基线。

**限制**：每账号 `maxPerAccount=8`、全局 `maxStreams=64`（env 可调）；单流 `maxStreamMs=30min`；
登记表清理有 2s 重连宽限（已 abort 的连接不计入上限，避免 tick 间隙误报 503）。超限
`503 + Retry-After: 5`（**任何非 200 都会让 EventSource 永久失败**，见 §3.5；客户端自有状态机
会换新 ticket 重连）。`/healthz.hub` 暴露 `streams/accounts/refused_total/legacy_connects`。

**唤醒与循环**：hub 只注册一次 `store.onChange()`，50ms 合并后 `wake()` 所有连接；每个连接被
唤醒后各跑一次 `eventLines`（可见性 SQL 仍是唯一真相）。循环顺序：

```
hello → (since? replay + caught_up) → loop:
  await nextWake(heartbeatMs)
  if aborted → cleanup
  校验账号（心跳周期）
  if dirty: eventLines(since=resumeSeq/lastSeq) → 逐帧 writeSSE
            truncated/rollback → reset（**reset 后不写 caught_up**）
  write heartbeat {as_of_seq, unread_count}   // 必须在 backlog/批次之后写
  if age >= maxStreamMs → bye{recycle} + close
finally: cleanup
```

- **reset 分支不发送 `caught_up`**：reset 表示「这里有一个客户端必须用 REST 补的空洞」，服务端
  不再宣称已追上；客户端只能靠 `pendingCatchUp` 的 REST 成功来确认水位。

**心跳未读的对账**：`unread_count` 用同一 SQL 计算，按账号做 5s TTL 缓存，避免每 15s×8 连接
重复聚合。heartbeat 是客户端未读的自愈通道（§4.7）。

**背压**：逐帧 `await writeSSE`，不建队列；写错误吞掉没关系，客户端看门狗/abort 会收拾；
单批最多 `replayLimit` 帧，超出下一轮。

### 3.4 HTTP 契约与续传语义（评审阻塞 3）

| 参数 | 说明 |
|------|------|
| `ticket` | auth 模式一次性 60s 票据；access token 永不进 URL |
| `as` | 仅 open 模式，必须是真实账号（修 `api.ts:634` 的 `owner` 硬编码） |
| `hub=2` | 新语义开关；缺省 = 旧行为 |
| `since=<seq>` | 续传起点（排他）；缺省 = 从 `as_of_seq` 起 |
| `author` | legacy only；`hub=2` 下忽略，P3 删除 |

**续传起点**：

```
effectiveSince = max( sinceParam ?? -∞ , Last-Event-ID ?? -∞ )   // 两者都有时取大
if effectiveSince === -∞: start = as_of_seq（不重放）
```

取 max 而不是「since 无脑优先」：EventSource 自动重连带 `Last-Event-ID`，手动重连带 `since`；
两者可能不一致，取大保证不回退、不重复吞历史。

**首连竞态**：客户端在连接前可能已用 REST 拿了页面 seed（`as_of_seq = S`），而事件在
`REST 返回 → hello` 之间产生。两条一起用：

1. 有活跃视图时连接参数 `since = min(活跃视图 seed.as_of_seq)`（无活跃视图则不带 `since`）；
2. **每次 hello 后**对「seed.as_of_seq < hello.as_of_seq」的活跃视图强制执行一次 REST
   catch-up（防 1 仍漏掉的窗口）；验收专门覆盖该窗口。

**超限/回滚（修正）**：

- **只用 `eventLines.truncated`**（可见条数 `limit+1`）判超限；**禁止**用
  `as_of_seq - since > replayLimit`（可见子集稀疏，会把正常重连误判成 reset）。
- `since > as_of_seq` 才判回滚（`reset{rollback}`）。
- `truncated` → `reset{replay_limit}`，服务端把连接水位前跳到 `as_of_seq`，客户端按 §4.3
  处理（先标 pending，REST 成功后确认）。

**水位协议**：`hello.as_of_seq` 只用于比较（回滚）与首连；**客户端不得在 hello 时直接把
`lastSeq` 抬到 `as_of_seq`（会吞掉随后补发的 backlog）**。推进规则（`advanceWatermark`）：

```ts
function advanceWatermark(asOf: number): void {
  if (pendingCatchUp === null) {
    lastSeq = Math.max(lastSeq, asOf);
  } else {
    // 有空洞待补：心跳/补发帧不得越过 pending 上界，否则会“假装追上”
    lastSeq = Math.min(Math.max(lastSeq, asOf), pendingCatchUp.asOfSeq);
  }
}
// if hello.since === null（首连无 backlog）: advanceWatermark(hello.as_of_seq)
// on caught_up:  advanceWatermark(as_of_seq)   // reset 后服务端不发 caught_up
// on heartbeat:  advanceWatermark(as_of_seq)
```

- **`caught_up`/`heartbeat` 抬水位仅当 `pendingCatchUp === null`**；有 pending 时上限取
  `pendingCatchUp.asOfSeq`，任何心跳都不得越过空洞。
- 服务端保证 `caught_up`/`heartbeat` 在 backlog/批次写完之后才写；reset 分支不写 `caught_up`。
- `pendingCatchUp` 只由「活跃视图 REST 重取全部成功」清除，清除后才允许 `lastSeq` 抬到
  `pending.asOfSeq`（见 §4.3）。

**邀请补历史（评审冲突消解，选「spec 承认允许」）**：不做 `e.seq >= invite_seq_for_root`
下界。理由：可见性模型本来就是「进入 participants 即见整棵树」（`report-social` 的
`thread.snapshot` 已把邀请前的整棵线程交给客户）；邀请后重连补拉包含该 root 的邀请前事件，
与「整树可见」一致，不构成越权；重放受 `replay_limit` 约束且按 seq 去重。若未来要求严格
「邀请前静默」，再加 `participants.joined_seq` 列与下界（不在本 change）。

### 3.5 EventSource 语义（修正）

任何非 200 响应（含 204 与 503）都会让 EventSource **fail the connection 且不再自动重连**；
只有网络错误/连接中断才会按浏览器策略重试。因此：

- 认证失败仍用 204（既有契约），但客户端**不依赖** EventSource 去区分；由 `POST /api/stream/ticket`
  的 401 决定登录态；
- 503 限流同样让 EventSource 死掉，重连由客户端状态机负责（换 ticket、退避）；
- `Retry-After` 只供自有状态机参考，不是 EventSource 的行为；
- 所有重连路径统一走「关闭旧 source → 取新 ticket → 新建 EventSource」。

---

## 4. 客户端设计

### 4.1 模块

```
src/ui/state/hub/
  types.ts              # HubEvent/HubState/TOPICS/控制帧
  event-hub.ts          # 零 React、零组件；EventSource 工厂注入（可单测）
  provider.tsx          # EventHubProvider + useEventHub + useHubStatus + useEventHubView
  notification-projection.ts # 通知投影（按帖角标 + read-set + union）
```
（legacy-adapter 不在 P1：`hello` 无 `hub:2` 时直接 off，去留见 §5.3。）

### 4.2 状态机

```
idle → connecting → (hello hub:2) → live
        │ error/close/non-200 → reconnecting（自有退避 1/2/4/8s）
        │ n≥5 → degraded{reconnect_failed}：对活跃视图每 60s 兜底 catch-up
        │ reset 未确认 → degraded{catching_up}：REST 重取中（不是轮询）
        └ online/visible/pageshow → connecting（取消定时器；online 立即重连）
bye{recycle} → connecting（不退避）
bye{auth} → off + 交登录态
hello 无 hub:2（旧后端）→ off（P1 不做 legacy 适配器/兜底轮询）
staticMode/stop → off
```

- 退避 `min(30s, 1s*2^attempt)+jitter`；`hello` 清零；不依赖 EventSource 内置重试。
- 看门狗：`2.5×heartbeatMs` 无任何帧 → `source.close()` + 重连（下限 1s）。
- `degraded{reconnect_failed}` 只在 `document.visibilityState==="visible"` 时对活跃视图
  每 60s 兜底 catch-up（`status.degradedPolling=true`）；hidden 时暂停（清定时器），
  visible 恢复时立即补一次并重建定时器；`degraded{catching_up}` 不发轮询。
- 每次重连必须重新取 ticket（一次性），禁止复用 URL。

### 4.3 顺序、去重、首连与 reset（评审阻塞 3）

- Hub 维护 `lastSeq`（已应用高水位）与 `resumeSeq`（下次 `since`）。
- 数据帧 `seq <= lastSeq` 丢弃；不推断稀疏 gap。
- 连接参数：`since = 活跃视图最小 seed.as_of_seq`；无活跃视图则用 `resumeSeq`。
  **pendingCatchUp 未清时只认 `resumeSeq`**——残留的视图旧 seed 不得把 since 顶回高位。
- `hello`：记录 `as_of_seq`/`cursor`；若 `as_of_seq < lastSeq` → 视为 rollback；
  首连且 `hello.since===null` 时走 `advanceWatermark(hello.as_of_seq)`。
- `caught_up` / `heartbeat`：走 `advanceWatermark(as_of_seq)`；`pendingCatchUp !== null` 时
  水位上限被钳在 `pendingCatchUp.asOfSeq`，不会越过空洞。
- `reset{as_of_seq, reason}`：
  1. `resumeSeq = as_of_seq`（直接赋值：可前跳，rollback 时可下降；防止用旧 since 反复
     触发 reset）；
  2. `pendingCatchUp = {asOfSeq, reason, scopes: 活跃视图集合}`；
     - `replay_limit`：`lastSeq` **保持不变**；
     - `rollback`（换库/恢复旧库）：**`lastSeq = as_of_seq`**（新库是唯一真相）。旧水位会让
       新库 `seq ≤ 旧 lastSeq` 的事件在去重处被静默丢弃（review B2）；
  3. 对活跃视图执行 REST 重取；**全部成功后才** `lastSeq=max(lastSeq,as_of_seq)` 并清 pending；
     失败保留 pending（保留空洞标记），按退避重试，绝不在失败时假装水位已确认；
  4. 分发 `stream.reset` 供非视图 store（通知投影）重取。
- `stream.reconnected`（非首次 hello）：同样对活跃视图做一次 250ms 防抖 catch-up。

### 4.4 Topic

| topic | 来源 |
|-------|------|
| `post.created` / `post.deleted` / `thread.invited` | 数据帧 `type` |
| `notification.created` | 派生：`(type==="post.created" \| type==="thread.invited") && actor!==me`，且 `post_deleted !== true` |
| `cursor.acked` | `cursor` 控制帧 |
| `stream.reset` | `reset` 控制帧 |
| `stream.reconnected` | 非首次 `hello` 成功 |
| `stream.state` | 状态机变更 |
| `*` | 全部数据帧（迁移期兼容层） |

### 4.5 Hooks 门面：`useEventHub`

选 `useEventHub(topics, handler)`，不选 `useLiveQuery`：同一实体被多视图共享（N 份订阅/N 次取数）、
失效策略是领域知识（feed pending/线程 pending/read-set 投影）、顺序与去重必须单点。页面消费
store，不直接消费裸事件。`useHubStatus()` 提供状态给指示器。

### 4.6 失效矩阵（含删除谓词修正）

| 事件 | 主页 feed | 线程 | 成员页 | 标签页 | 收藏 | 通知 |
|------|-----------|------|--------|--------|------|------|
| `post.created` 根帖 | 活跃 tab `refreshNew()`；非活跃标脏 | root 匹配 → 静默 reload | actor=该成员 → refreshNew | `payload.tags` 含 tag → refreshNew | 忽略 | actor≠me 且 `post_deleted!==true` → 插入/计数 |
| `post.created` 回复 | 忽略 | root 匹配 → pending | 忽略 | 忽略 | 忽略 | actor≠me → 插入/计数 |
| `post.deleted` | `feed.ids` 命中 post/root → 移除/墓碑 | `root_id` 匹配 → reload | **`memberFeed.ids` 命中 id** → refreshNew | **`tagFeed.ids` 命中 id** → refreshNew | `bookmarks.ids` 命中 → 移除 | 标记 deleted；扣减；`post_deleted=true` 不计数 |
| `thread.invited` | 忽略 | root 匹配 → reload | 忽略 | 忽略 | 忽略 | 插入 |
| `cursor.acked` | — | — | — | — | — | cursor+unread_count 以服务端为准 |
| `stream.reset` | 强制 refreshNew | 强制 reload | 强制 refreshNew | 强制 refreshNew | reload | 重新 peek |
| `stream.reconnected` | 活跃 refreshNew | 静默 reload | refreshNew | refreshNew | reload | peek |

- `usePostFeed` 增加 `live:{active,matches,onEvent}` 与 `setActive`；主页两个 feed 常驻，
  非活跃只标脏（一条推送最多刷一个活跃 feed）。
- 表中 `*.ids` = 当前已渲染 `posts ∪ pending`（含顶部胶囊队列）；不在集合内的 id 一律忽略，
  避免为看不见的帖子发请求。
- 成员页删除 `useAuthorStream`/`realtime:false`，改 hub 过滤（actor=该成员）；删除事件用 id 命中。
- 标签页不相关的新帖不触发请求；`payload.tags` 上线前允许「根帖即刷新」一次性过渡，并在同任务删除。

### 4.7 通知投影（read-set + 幂等增量 + 对账）

**语义基线（在途 change）**：单帖已读只写本地 read-set；`ack()` 唯一推游标、唯一清空；refresh
union。

**状态**：`bySeq: Map<seq, {event, deleted}>`（列表页另持 history 页），`cursor`，
`serverUnread`，`unreadByTarget: Map<target, count>`（来自最近一次 peek/heartbeat 对账），
`readIds`（localStorage）。

**badge 公式（按帖口径，评审 B3 定稿）**：

```
badge = max(0, |{ target ∈ unreadByTarget : target ∉ readIds }|
              + |{ target ∈ localTargets : target ∉ readIds ∧ target ∉ unreadByTarget }|)
```

- 为什么不是按事件：一次 @ 提醒同时产生 `post.created` + `thread.invited` 两条事件、同一
  target；UI 只展示一行、角标只应 +1。服务端 `unread_count` 是**事件数**（实测一次 @ = 2），
  直接当角标会翻倍，也与 `report-notification-history-and-read` 的按帖语义冲突。
- `unreadByTarget`（每个 target 的未读事件数）来自 `peek`；角标取 distinct target 数，
  因此 read-set 命中即使不在已加载列表里也能精确扣减，且与分页无关。
- `unread_count` 仍用于**事件级漂移对账**（`serverUnreadEvents + localEventDelta` 与
  heartbeat 比对）；不一致才排一次 `peek&limit=1`。
- `localTargets` 仅收录「快照之后新到、尚未被下一次对账吸收」的 target；对账后清空。

**幂等增量规则**（只在 bySeq 新增 seq 时动作）：

1. `notification.created`：若 `bySeq.has(seq)` → no-op；若 `post_deleted===true` → 插入但
   **不计**未读；否则插入；target 不在 `unreadByTarget` 时加入 `localTargets`（同帖第二条
   事件不再 +1），`localEventDelta += 1`（仅对账用）。
2. `post.deleted`：`bySeq` 中该 target 的未读事件逐条标记 deleted（每 seq 一次），
   已 deleted 的不重复扣；从 `unreadByTarget`/`localTargets` 移除该 target；仅对**本地计数过**
   的 seq 扣 `localEventDelta`（避免与快照重复扣）。该帖是否还有未加载事件本地不可知 →
   排一次 `peek&limit=1` 以服务端为准。`post.deleted` 自身永不计数。
3. `cursor.acked`：`cursor=服务器值`；`unread_count===0` 时清空 target 投影，否则排对账。
4. 对账：heartbeat 带 `unread_count`，每 60s（或 visible 恢复）做漂移检测；不一致才
   `peek&limit=1` 刷新 `unread_count+unread_by_target`；对账后 `localEventDelta=0`、
   `localTargets` 清空。这是删除/竞态的自愈通道。
5. `ack()` 响应 `{cursor,unread_count}`：两者直接落地，清空未读投影（唯一清空路径）。
6. `stream.reset/reconnected`：`peek` 一次，union 合并（保留本地新行），不删除历史。
7. `degraded{reconnect_failed}`：每 60s 主动 `peek&limit=1` 对账（与 hub 活跃视图兜底轮询
   同步，review B4）。

**read-set 交互**：`markPostRead(postId)` 只更新 readIds 并持久化；badge 依据公式自动下降；
不清列表、不推游标、不影响其他帖子。history 行 `read` 标记 = `line.read || readIds.has(targetId)`。

**已知产品后果（与在途 change 共同承担，不在本 change 单独修）**：read-set 上限 500 按加入
顺序淘汰；被淘汰的已读帖若仍有未读事件，其 target 重新计入角标 → **角标回涨**。
这是「本地 read-set + 服务端游标」两 change 共同的产品语义，不引入服务端 per-post 表就无法
根治；缓解是提高上限/按账号持久化（在途 change 的取舍），验收需知悉该行为。

**history 适配器（真实契约，P2 才启动）**：

```ts
const page = await client.notificationHistory({ before, limit });
// {events: NotificationHistoryLine[], cursor, has_more, next_before}
// merge by seq; 不引入 items/next_cursor 之类臆造字段
```

C3 在 `report-notification-history-and-reply-submit` 的 history 契约冻结/归档后才启动；
P1 的角标与实时投影不依赖 history。

**移除**：mount 时逐帖 hydrate（改为 peek + 懒 hydrate；角标不再依赖 hydrate）、
`NotificationsPage` 进页 re-peek、`sseState==="open"→refresh`；**移除本地 `ackedThrough`
对事件的压制过滤，但保留 cursor 镜像**（`ack()` 响应、`cursor` 帧、heartbeat 都是它的来源；
它是「已读水位」的显示/对账值，不得再被用来擅自拦事件）。

### 4.8 Connection 层

保留 ep/auth/login/who/accounts/staticMode。删除 `listeners`/`subscribeEvents`/`sseState`/
ReportStream effect/事件驱动 `refreshWho`。`EventHubProvider` 随 client/ep/account 重建；
open 模式 `as=<真实账号>`。

### 4.9 静态模式

hub `off`，无 EventSource；角标来自快照；WhoPanel 显示「静态归档（无实时流）」。

---

## 5. 迁移路径（P1/P2/P3，按评审分期）

### 5.1 阶段

**P1（可上线的最小闭环）**
1. 服务端：`visibleRootsClause` 别名 + `eventLines`、`post.deleted`、`peek unread_count/
   unread_by_target+limit`、ack `unread_count`、`hub.ts`（hello/backlog/caught_up/heartbeat/
   reset/cursor/bye、abort、上限 8/64、30min、2s 宽限）、healthz 计数、capabilities。
2. 客户端：`event-hub.ts`/provider（自有状态机、max(since,Last-Event-ID)、首连竞态、
   lastSeq 规则、reset pending）、connection 委托、通知投影（read-set 公式 + 对账）、feed
   精确谓词、Thread、成员页单流。
3. 验收：§7 的 P1 子集 + 服务端单测 + 旧行为回归。

**P2（扩展面）**
- 标签页/收藏页精确失效；多标签页/多端 `cursor` 同步验收；history 适配器（契约冻结后）；
  degraded 兜底轮询与指示器；隧道/移动后台验收。

**P3（收口）**
- 删除 `ReportStream`/`subscribeEvents`/`author-stream`/旧 effects/`?author=`；legacy 适配器
  按判据删除；`hub=2` 端点版本收口（见 §5.3）；规格归档。

### 5.2 每阶段验收

| 阶段 | 验收 |
|------|------|
| P1 | 服务端单测全绿；旧壳（无 hub）行为逐字段不变；两上下文角标/feed/线程/成员页事件级用例 |
| P2 | 标签/收藏/多端/历史拼接/degraded；隧道 ≤5s；移动后台行为（或显式登记未覆盖） |
| P3 | `rg` 旧通道 0 命中；版本矩阵三组合；validate/archive |

### 5.3 兜底与删除判据

| 兜底 | 理由 | 删除判据 |
|------|------|----------|
| legacy 适配器（hello 无 hub:2） | **P1 不实现**：旧后端 → 实时层 off（明确无推送）；是否补适配器是 P3 决策 | 若 P3 实现：后端升版后删除；`legacy_connects` 连续 7 天为 0 且 `rg` 无引用 |
| `hub=2` 端点开关 | 升级窗口旧壳不受 `post.deleted` 影响 | legacy 删除时一并删除；默认切 v2 |
| 30s presence 轮询 | presence 非事件源 | 未来有 `presence.changed` 再删；否则保留登记 |
| degraded 60s 兜底轮询 | 移动端/代理阻断 SSE；`{reconnect_failed}` 时对活跃视图每 60s catch-up（`status.degradedPolling`） | 不删除；只允许在 degraded/static 存在 |
| visibilitychange catch-up | 后台节流 | 保留（断线兜底） |

**不做构建期 `HUB_ENABLED` 开关**；回滚 = 端点版本（不带 `hub`）+ 部署回滚，避免长期双轨。

### 5.4 删除清单

- `src/ui/lib/api.ts`：`ReportStream`/`SseHandlers`/`ReportStreamOptions`（`SseState` 迁 hub）。
- `connection.tsx`：listeners/subscribeEvents/sseState/SSE effect/事件驱动 refreshWho。
- `state/author-stream.ts` 整文件；ProfilePage 的第二条流。
- `notifications.tsx`：mount 全量 hydrate、sseState 刷新、本地压制；`NotificationsPage` 进页 re-peek。
- `feed.tsx`：`subscribeEvents`/`sseState` 两个 effect。
- `http.ts`：旧 SSE 循环与 `?author=`（P3）。
- `store.ts`：`notificationLines` 内联 SQL 改委托。

---

## 6. 一致性

1. 可见性：hub/peek/history/timeline/thread/profile 共用 `visibleRootsClause`（带别名）；
   五个入口对同一私域 root 的命中集合一致。
2. 未读：`unread_count`/`unread_by_target` 与列表同 SQL 规则；客户端 badge = **未被 read-set
   命中的 distinct target 数**（+ 未对账吸收的本地 target），`unread_count` 只做事件级漂移
   对账，heartbeat/60s 自愈。**「同源」= 同一 read-set/cursor 投影，不要求角标等于已加载
   行数**；角标 MAY 大于当前已加载列表（分页/未 hydrate 场景），列表用「还有 N 条」补齐。
3. 跨端：「全部已读」游标由服务端广播 `cursor`；read-set 按在途 change 只影响本端。
4. history + 实时：`bySeq` 以 seq 去重；`ack()` 唯一清空；refresh union。
5. 事件只表达「发生了什么」；正文/权限/计数以 REST 重取为准。

---

## 7. 验收（按评审修正）

### 7.1 事件级（Playwright，两上下文）

- **P1（修正）**：A=manager 发**带 `result` 标签**的根帖（或 B 切到「正在关注」tab；manager
  普通 `note` 根帖不会进 owner 推荐流）。断言 **B 的 DOM 出现该帖内容**（≤2s；隧道 ≤5s）。
  **不得断言胶囊存在**——顶部会自动吸收 pending，胶囊可能为 null（必 flake）。
- P2 线程页回复 → pending 胶囊或回复内容出现（按视口位置二选一断言）。
- P3 删除 → feed/线程/收藏中按 id 消失或墓碑；通知行转「已删除」。
- P4 成员页：只有 1 条 `/api/stream`；该成员新帖进 DOM；其他成员发帖不触发该页请求。
  （P1 已验「1 条共享流 + 无 `author=`」；标签/收藏页的实时失效属 P2。）
- P5 角标：A 回复 B → B 角标 +1 ≤2s（不在通知页）；打开该帖（read-set）→ 角标 −1；
  reload 后 read-set 仍在；`ack()` 后归零。
- P6 多端：标签页 1 `ack()` → 标签页 2 角标 ≤2s 归零（`cursor` 帧）。
- P7 历史 + 实时：history 分页 + 新事件 union，seq 无重复、顺序正确；replay 与 re-peek
  重叠不重复计数。

### 7.2 断线/首连/恢复

- R1 离线 5s 期间 3 条事件 → 恢复后 5s 内补齐，每行一次。
- R2 双重重连：旧/新 socket 重叠不重复渲染。
- R3 **首连竞态**：REST seed 返回后、hello 之前产生 1 条可见事件 → B 最终可见（≤5s），
  不因 `since` 跳过。
- R4 truncated：制造超过 replayLimit 的可见事件 → `reset`；REST 成功后水位确认；失败时
  保留 pending 并重试，不假装已追上。
- R5 rollback：`since > as_of_seq`（换库/恢复）→ reset + 重取。
- R6 服务重启（同 dataDir）→ since 续传；无重复。
- R7 看门狗：断开 60s（无帧）→ 客户端主动重连。
- R8 **CLI 不收到 `post.deleted`**：`wait-notifications` 输出不含系统事件。

### 7.3 可见性

- agent-a 订阅；agent-c 私域发帖 → hub 字节流与五个读入口均 0 命中。
- 邀请后：收到 `thread.invited` 与新事件；**允许**重连补拉包含该 root 邀请前事件（§3.4，
  spec 已承认），按 seq 去重且不越权到其他 root。

### 7.4 性能与资源

- 空闲 60s：除 SSE 心跳与 presence（who/accounts 30s）外，业务请求 0。
- 一次推送：仅活跃 feed 1 次请求；不在通知页时 0 次帖子正文请求。
- 启动：仅 1 次 peek；无逐帖 hydrate（除非在通知页）。
- **多标签页不挤占 REST**：开 4 个标签页（4 条 SSE）后，REST 请求仍能在 1s 内完成
  （HTTP/1.1 6 连接预算；浏览器侧断言，必要时看 `performance` 资源时序）。
- 资源：上下文关闭后 2s 内 `hub.streams=0`、`in_flight` 回基线；第 9 条流 503；服务端
  不因写失败泄漏（abort 回收）。
- 隧道：经 `local-*.fde2e.com` 推送 ≤5s。

### 7.5 兼容/静态/未覆盖

- 旧壳 + 新后端：无 `hub` 行为逐字段不变；`post.deleted` 不改旧通知。
- 新壳 + 旧后端（`hello` 无 `hub:2`）：P1 **实时层 off**（无 EventSource、无兜底轮询），
  不假装实时；legacy 适配器是否实现是 P3 决策（§5.3）。
- 静态归档：无 EventSource、无实时指示。
- **移动端后台冻结**：若本轮不实测真机，验收报告显式登记「未覆盖」并给出看门狗/visible
  重连的代码级证据；不得默认声称已验证。

---

## 8. 风险

| 风险 | 缓解 |
|------|------|
| SQL 歧义 | `visibleRootsClause` 别名参数；单测覆盖 agent 视角（临时库已复现，最终 SQL 见 §3.1） |
| Hono 写错误被吞 | 回收只依赖 onAbort/aborted/signal + 30min 寿命；客户端看门狗 |
| EventSource 非 200 永久失败 | 自有状态机；每次重连换 ticket；不依赖内置重试 |
| 多标签页连接挤占 REST | 1 tab = 1 stream；4 标签页验收；上限 8 |
| 移动后台冻结 | 真实 heartbeat + 2.5×看门狗 + visible 重连；未实测则登记未覆盖 |
| 代理缓冲 SSE | `X-Accel-Buffering: no`/`no-transform`；隧道 ≤5s 验收 |
| owner 可见全部 → 读放大 | 50ms 合并、逐帧写、replay 上限、payload 只带引用、unread 计数 5s 缓存 |
| 服务恢复/回滚 | `since > as_of_seq` 判 rollback；rollback 声明即 `lastSeq=as_of`（新库真相），`replay_limit` 保持旧水位等 REST 确认 |
| read-set 与 server count 漂移 | `unread_by_target` distinct target 角标 + heartbeat/60s 漂移对账 + 删除后重取兜底 |
| 并行 change 冲突 | 先合在途 change；只扩展既有 handler 响应；history 仅适配器 |
| 邀请重放 | spec 承认整树可见；replay 有界 + seq 去重；未来要严格静默再加 `joined_seq` |

**回滚**：端点版本（不带 `hub=2` 走旧行为）+ 部署回滚；无 schema 迁移；`post.deleted` 的
`NOTIFICATION_TYPES` 过滤独立成 commit，回滚旧客户端也不受影响。

---

## 9. 决策记录（v2 变更）

| # | 决策 | 理由 | 被否 |
|---|------|------|------|
| D1 | SSE | 单向/文本/低频；ticket 复用 | WS |
| D2 | 流位置 ≠ 已读游标 | 语义不同 | 游标续传 |
| D3 | `effectiveSince=max(since,Last-Event-ID)` | 两条通道取大，不回退不吞历史 | since 无脑优先 |
| D4 | 超限只认 `truncated` | 稀疏可见子集不能按 `as_of_seq-since` 判 | 差值判超限 |
| D5 | 首连 `since=min(seed)` + hello 后强制 catch-up | 覆盖 REST→hello 窗口 | 只靠 since |
| D6 | reset 后 REST 成功才确认水位 | 失败不能假装追上 | reset 即抬 lastSeq |
| D7 | `lastSeq=max` 只在 `caught_up`/heartbeat（首连除外），且 `pendingCatchUp` 未清时钳在待补上界；reset 后无 `caught_up` | hello 直接抬会吞 backlog；心跳越过空洞会假装追上 | hello 立即抬/心跳无条件抬 |
| D8 | 回收只认 abort/aborted/signal/寿命 | Hono `write` 吞错误 | 写失败判死 |
| D9 | 上限 8 / 30min / 2s 宽限 | 多标签页 + 冻结客户端 | 4/10min（易撞 503） |
| D10 | 通知 badge = server unread − read-set 命中 | 与在途 change 对齐；不推游标 | 本地 items 数 |
| D11 | 删除事件谓词 = 当前列表 id 命中 | delete 无 tags/author | actor/tags 匹配 |
| D12 | 邀请允许整树重放 | 可见性模型=参与即全树；snapshot 已给全树 | 加 joined_seq（留未来） |
| D13 | 不做 `HUB_ENABLED` 构建开关 | 避免长期双轨；端点版本可回滚 | 构建期双轨 |
| D14 | rollback 声明即 `lastSeq = as_of_seq`；`resumeSeq` 直接取 reset as_of（可下降） | 换库后新 seq 可能低于旧水位；不降会丢事件并反复 reset（review B1/B2） | 继续 keep lastSeq / max(resumeSeq) |
| D15 | 角标按 distinct target（按帖），`unread_count` 只做事件级对账 | 一次 @ = 2 事件 1 行；与在途 change 的按帖语义一致（review B3） | 原始 unread_count 当角标 |
| D16 | `degraded{reconnect_failed}` 对活跃视图每 60s catch-up；`{catching_up}` 不算轮询 | 文案「轮询兜底」必须真实（review B4） | 只显示指示不轮询 |

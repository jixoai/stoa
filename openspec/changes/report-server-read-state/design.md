# Design: report-server-read-state（服务端按帖已读）

## 0. 决策摘要

| # | 决策 | 依据 |
|---|------|------|
| D1 | 已读判定 = `post_reads` 命中 **OR** `post.seq <= 账号 cursor` | 保留既有 ack/「全部已读」语义；旧游标不丢；逐帖粒度不吞未读 |
| D2 | `read_at` 记**首次**已读时刻（`ON CONFLICT DO NOTHING`） | 严格幂等（A11）；重复停留不刷新历史 |
| D3 | `PostView` 增 `read`/`read_at`；`hydratePosts` 每 400 id 一条查询 | 无 N+1（A10）；复用既有 `chunks()`（`store.ts:211-215`） |
| D4 | 未读 = 通知目标集合 − `post_reads`，**仍叠加** `seq > cursor` 上界 | 兼容 ack 与 CLI；同帖多事件计数口径不变 |
| D5 | `history.read` = `post_reads 命中 OR seq <= cursor` | 旧库/旧游标行为不变；新行为天然跨设备 |
| D6 | 本地 read-set 降级为**乐观缓存**；服务端为权威；ready 对账时丢弃「服务端没有且不在重试队列」的本地条目 | Owner「服务端为准」 |
| D7 | 写路径：本地即时 → 异步 `POST /api/reads` → 失败入 localStorage 队列（≤500）→ `online`/`visible`/ready 批量补（每片 100） | 离线可用（A3/A4）；不做轮询 |
| D8 | 静态模式零写入、零已读请求 | 既有 `report-static-mode` 要求 |
| D9 | 「全部已读」= 当前通知目标批量写 `post_reads` **＋** 保留 `POST /api/notifications/ack` | Owner 要求保留 cursor 兼容（A7） |
| D10 | 软删帖允许写、但对未读/高亮无效果；未知/不可见帖 404（batch 静默 skip） | 软删边界（A12）；不泄露不可见帖存在性 |
| D11 | `post_reads` **账号私有**：只有本人 token 能读自己的行；不提供任何作者侧「谁看过」 | 安全；Owner 未要求已读回执 |
| D12 | schema v6 只新增表；旧库只读打开（export 不跑迁移）时按表是否存在降级为 `read=false` | A9；`previewTablesAvailable()` 先例（`store.ts:1232-1240`） |
| D13 | capability `features.post_reads`；limits `reads_batch=100`、`reads_query=200` | 协议可发现；客户端按上限分片 |
| D14 | 服务端不 LRU 淘汰；本地缓存仍 2000 条仅为 localStorage 体积预算 | 行数上界＝账号×帖数；本地体积预算不变 |

## 1. 现状与接入点（path:line）

> 行号取自 2026-11-09 工作树（`report-thread-nesting` 已合入）。依赖 change 合入后以
> **函数名/常量/路由字面量**为锚点，不以行号为准。

| 用途 | 位置 | 现状 |
|------|------|------|
| schema 版本 | `src/server/db.ts:49` | `SCHEMA_VERSION = 5` |
| 建表/迁移 | `src/server/db.ts:56-237`（主 DDL）、`:239-320`（additive ALTER）、`:322-325`（meta 版本） | 全 `CREATE TABLE IF NOT EXISTS` + PRAGMA 守卫，幂等 |
| 游标表 | `src/server/db.ts:136-140` | `cursors(account_id, seq, updated_at)` |
| 游标读写 | `src/server/store.ts:581-601` | `getCursor` / `advanceCursor`（`max(seq, target)` 单调） |
| 账号删除清理 | `src/server/store.ts:448-466` | 事务内删 `cursors`/`participants`；新表须同处清理 |
| PostView 水合 | `src/server/store.ts:1058-1222` | accounts/媒体/回复数/引用/预览全部批量；返回对象 `:1211-1220` |
| 预览字段批量读先例 | `src/server/store.ts:1163-1184` + `previewTablesAvailable` `:1232-1240` | 旧库缺表时整段跳过，不阻断读取 |
| 单帖视图 | `src/server/store.ts:1224-1229` | `getPostView` → `hydratePosts([row])` |
| 列表读路径 | `src/server/store.ts:1422,1478,1526,1658,1710,1784,1896` | timeline/feed/profile/thread/search/read/bookmarks 均走 `hydratePosts` |
| 导出读路径 | `src/server/store.ts:2279-2286`（`visiblePostsForExport`）；`src/server/export.ts:65,148,161-164` | `SnapshotPost = Omit<PostView,…>`，新字段自动进快照 |
| 未读谓词 | `src/server/store.ts:1990-2007`（`unreadClause`） | `seq > cursor AND actor != me AND type IN (…) AND p.deleted_at IS NULL AND 可见性` |
| 未读计数 | `src/server/store.ts:2009-2020` | 事件数 |
| 按 target 未读 | `src/server/store.ts:2022-2040` | `GROUP BY COALESCE(e.post_id,e.root_id)` |
| 通知历史 | `src/server/store.ts:2110-2168` | `read: event.seq <= cursor`（`:2158`） |
| peek/history/ack 路由 | `src/server/http.ts:779-833`、`:836-853`、`:855-868`；`/api/cursor` `:870-873` | `unread_count`/`unread_by_target` 直接来自 store |
| 身份/解析辅助 | `src/server/http.ts:72-86`（identity）、`:94-105`（readJson）、`:107-113`（optionalInt） | 新路由复用 |
| 路由契约表 | `src/core/protocol.ts:34-76`（`API_ROUTES`）、`:83-103`（features）、`:104-111`（limits） | `scripts/check.mjs:34-44` 逐一核对 http.ts 字面量 |
| 本地 read-set | `src/ui/state/read-set-store.ts:12-15,39-41,73-229` | 2000 上限 LRU、250ms debounce、per-id 订阅 |
| Provider 读态 | `src/ui/state/notifications.tsx:206-221`（store 初始化）、`:240-255`（账号切换）、`:520-528`（`markPostRead`）、`:530-536`（`isRead`）、`:575`（角标）、`:581-589`（per-id API） | 本地读集合为唯一权威 |
| 通知投影 | `src/ui/state/hub/notification-projection.ts:20-28,155-175` | 角标 = 不同 target 数 − 本地 readIds |
| 停留引擎 | `src/ui/state/read-dwell.ts:509-527`（`markRead` → `markPostRead` `:518`） | 回调不变，只换 Provider 侧写路径 |
| Provider 接线 | `src/ui/components/ReadDwellProvider.tsx:52-71` | `markPostRead`/`isPostRead` 走 ref |
| PostCard 读态 | `src/ui/components/PostCard.tsx:93-120`（`usePostReadFlag`、observe）、`:181,233`（`data-read`） | 本地 read-set OR 游标 |
| 通知页点击 | `src/ui/pages/NotificationsPage.tsx:185-201` | 点击即 `markPostRead`；历史行已有服务端 `read` |
| 客户端 API | `src/ui/lib/api.ts:492-540`（notifications/history/ack） | 需加 reads 三方法 |
| 静态客户端 | `src/ui/lib/static-api.ts:314-335`（显式字段映射）、`:750-761`（通知空实现）、`:817-819`（ack READ_ONLY） | 新字段需显式透传，写方法抛 `READ_ONLY`（`:227`） |
| 事件 hub 未读缓存 | `src/server/hub.ts:498-510` | `unread_count` 5s TTL；已读写不广播（见 §7.4） |
| 既有规格 | `openspec/specs/report-social/spec.md:96-222`、`report-surface/spec.md:596-604`、`report-static-mode/spec.md:51-…` | 本 change 需 MODIFIED/ADDED |

## 2. 精确语义

### 2.1 已读（read）

对账号 `a` 与帖子 `p`：

```
read(a, p) := EXISTS(SELECT 1 FROM post_reads r WHERE r.account_id = a AND r.post_id = p)
              OR p.seq <= cursor(a)
```

- `read_at` 仅在 `post_reads` 命中时有值；**只靠游标覆盖**的帖子 `read=true`、
  `read_at=null`（区分「逐帖读过」与「被『全部已读』覆盖」）。
- 已读是**单调**的：一旦 `read=true` 不会回到未读（服务端无删除接口；本地缓存可丢，但
  下一次 `PostView.read` / `GET /api/reads` 会恢复）。
- 同一帖后续新事件（`thread.invited`、未来通知类型）**不会**让该帖重新未读——这就是
  「按帖」语义，与 read-dwell 既有口径一致（`report-social` 规格「该帖的全部通知事件一并
  视为已读」）。
- 自己的帖子：停留引擎本来就跳过（`read-dwell.ts:223-236`）；API 允许写（幂等、无害）。

### 2.2 未读（unread）

```
unread_event(a, e) := e.seq > cursor(a)
                      AND e.actor != a
                      AND e.type IN ('post.created','thread.invited')
                      AND post(e.post_id) 未软删
                      AND e.root_id 对 a 可见
                      AND NOT EXISTS(post_reads(a, e.post_id))
```

- `e.post_id IS NULL` 的协议事件（当前不存在，`post_id` 总是有值）：退化为只按游标判定，
  不参与 `post_reads` 扣减（避免把 `root_id` 误当帖子 id）。
- `unread_count` = 满足条件的**事件数**（与现有口径一致：一次 @ 可能产生 2 条事件）。
- `unread_by_target` = 按 `COALESCE(e.post_id, e.root_id)` 分组的**事件数**；
  `post_reads` 命中的 target 整体不出现。
- UI 角标 = `unread_by_target` 的 key 数（不同 target），再减去「本地乐观已读」;
  服务端 target 已排除已读，所以跨设备角标天然一致。

### 2.3 通知历史

```
history.read(e) := read(a, 目标帖) 即 (post_reads 命中 OR e.seq <= cursor(a))
```

- 软删帖仍有历史行（`read` 依旧按上面计算），但不计未读（`p.deleted_at IS NULL` 过滤）。
- `cursor` / `has_more` / `next_before` 契约不变，`read` 只是变得更精确。

## 3. 数据模型与迁移

### 3.1 DDL（schema v6）

```sql
-- v6: 服务端按帖已读（report-server-read-state design §3.1）。
CREATE TABLE IF NOT EXISTS post_reads (
  account_id TEXT NOT NULL,
  post_id    TEXT NOT NULL,
  read_at    INTEGER NOT NULL,
  PRIMARY KEY (account_id, post_id)
);
-- 删帖/清理/统计按 post_id 反查（不参与读路径的覆盖判断）。
CREATE INDEX IF NOT EXISTS idx_post_reads_post ON post_reads(post_id);
```

- 主键 `(account_id, post_id)` 同时服务两类查询：
  ① `WHERE account_id = ? AND post_id IN (…)`（hydrate，覆盖索引）；
  ② `NOT EXISTS (… WHERE account_id = e.account) AND post_id = e.post_id`（未读谓词，索引探针）。
- **不建外键**：与既有表一致（`accounts`/`posts` 等均无 FK），软删帖保留读行，
  账号删除由 `removeAccount` 显式清理。

### 3.2 迁移

- `src/server/db.ts:49` `SCHEMA_VERSION` 5 → **6**；DDL 加入 `migrate()` 主 `db.exec`
  （`:57-237`），`CREATE TABLE IF NOT EXISTS` + `IF NOT EXISTS` 索引 ⇒ 旧库首次启动自动建表，
  重复 `migrate()` 幂等（A9）。
- **不新增 ALTER**：本次只有新表，没有给旧表加列；`hasColumn` 守卫无需改动。
- `meta.schema_version` 由既有 `INSERT … ON CONFLICT`（`db.ts:322-325`）自动更新。
- 迁移顺序：先建表 → 再跑既有 follow/媒体/预览补丁 → 最后写 meta；新表不依赖后续补丁。

### 3.3 旧库只读打开（export 路径）

- `export` 走 `openDatabase({ readonly: true })`（`export.ts:252`），**不执行 migrate**。
  因此 v5 库没有 `post_reads`。
- `store.readTablesAvailable()`（缓存一次，仿 `previewTablesAvailable()`
  `store.ts:1232-1240`）：查 `sqlite_master`；缺表 ⇒ `hydratePosts` 把 `read` 全部置
  `false`、`read_at=null`，未读谓词退化为纯游标（与升级前完全一致），**不得抛错**。
- 迁移后的库（v6）与在线库行为一致。

### 3.4 清理与增长

- `removeAccount`（`store.ts:448-466`）事务内追加
  `DELETE FROM post_reads WHERE account_id = ?`。
- 不做 LRU/定时清理：行数上界 = 账号数 × 帖子数；`read_at` 只增不改（D2）。
- 帖子物理删除目前不存在（只有软删）；若未来引入 purge，按 `idx_post_reads_post` 清理。

## 4. API 契约

所有接口沿用既有鉴权：`identity(c, deps)`（`http.ts:72-86`）解析 token / open-mode
`X-Report-Account`；账号来自凭据，**不接受请求参数指定别的账号**。

### 4.1 `POST /api/reads`

```
请求  { "post_id": "<id>" }
201（新建）/ 200（已存在）
响应  { "ok": true, "post_id": "<id>", "read": true, "read_at": 1762..., "created": true|false }
错误  400 BAD_REQUEST（body 非对象 / post_id 缺失或非字符串或空 / 长度 >128）
      401 UNAUTHORIZED（无有效凭据）
      404 NOT_FOUND（帖子不存在，或该账号看不到其 root —— 与收藏同口径，不泄露存在性）
```

- 任何活动账号（owner/manager/agent）均可写自己的读行。
- 幂等：`INSERT … ON CONFLICT(account_id, post_id) DO NOTHING`；`created=false` 时返回**首次**
  `read_at`（D2）。重复请求不改任何状态（A11）。
- 软删帖：允许写（返回 200/201，`read=true`）；未读与高亮不受影响（见 §2.2/§11）。
- 无额外广播：写接口只改本账号数据，不推进 cursor、不发事件（见 §7.4 的 5s 说明）。

### 4.2 `POST /api/reads/batch`

```
请求  { "post_ids": ["id1", "id2", ...] }
200   { "ok": true, "stored": 2, "skipped": ["invisible-or-unknown"], "read_at": 1762... }
错误  400（非数组 / 空数组 / >100 / 任一元素非字符串或空或 >128）
```

- 去重后最多 100 个；超限 400（客户端必须分片，见 §5.4）。
- 单事务：一条 `SELECT id, root_id, deleted_at FROM posts WHERE id IN (…)` + 非全局角色
  对 distinct root 的一次 `participants` 查询 + 批量 upsert。
- 未知/不可见 id **不报错**，进 `skipped`（离线队列可能含已删帖；不能因一条坏 id 卡死整队）。
- 软删帖按 `stored` 处理（写入无害）。
- `read_at` 为本次事务统一时刻（同一批的已读时间一致，便于对账）。

### 4.3 `GET /api/reads?ids=a,b,c`

```
200 { "ok": true, "reads": [ { "post_id": "a", "read_at": 1762... }, ... ] }
400（ids 缺失 / 空 / >200 / 含空段）
```

- 只返回**本账号**存在的行（其余省略）；不校验帖子可见性（读行本身就是该账号私有历史；
  不可见的旧读行不必泄露帖子内容——只返回 post_id 与时间，且调用者本就持有这些 id）。
- 用途：登录/ready 对账、`GET /api/cursor` 之外的调试；客户端每次最多 200。

### 4.4 PostView 读字段

`PostView`（`src/core/types.ts:169-177`）新增：

```ts
/** 该账号是否已读该帖（post_reads 命中 或 seq ≤ 账号游标） */
read: boolean;
/** 逐帖已读时间；仅游标覆盖时为 null */
read_at: number | null;
```

- 所有返回 `PostView` 的路径统一由 `hydratePosts` 填充：`/api/timeline`、`/api/feed`、
  `/api/thread/:id`、`/api/posts/:id`、`/api/profile/:account`、`/api/search`、`/api/read`、
  `/api/bookmarks`、`POST /api/posts`（commit 回执）、`export` 快照。
- `ThreadNode extends PostView` 自动继承。
- `QuotedView`（引用块）不新增 read（引用不是独立阅读单元，保持轻量）。

### 4.5 Capabilities / 路由表

```ts
features.post_reads: true,
limits.reads_batch: 100,
limits.reads_query: 200,
```

- `PROTOCOL_VERSION` 保持 1：纯增字段，旧客户端忽略即可；不破坏 `check.mjs` 契约。
- `API_ROUTES` 追加
  `POST /api/reads`、`POST /api/reads/batch`、`GET /api/reads`；
  同时补齐既有多处漏登记（`GET /api/notifications/history`、`GET /api/bookmarks/ids`、
  `GET /api/bookmarks`、`PUT /api/bookmarks/:id`、`DELETE /api/bookmarks/:id`）——
  `check.mjs:34-44` 只做「协议 → http」单向核对，补登记让门禁恢复意义（不新增端点）。

### 4.6 错误码汇总

| 场景 | 码 |
|------|----|
| 无凭据 / 无效 token | 401 `UNAUTHORIZED` |
| body 非对象 / 字段类型错 / 超上限 | 400 `BAD_REQUEST` |
| 未知或不可见帖（单帖） | 404 `NOT_FOUND` |
| 未知/不可见帖（batch 内） | 200 + `skipped` |
| 只读/模拟客户端（static） | 403 `READ_ONLY`（客户端侧抛，不发网络） |

## 5. 客户端设计

### 5.1 状态分层

| 层 | 位置 | 角色 |
|----|------|------|
| 服务端 `post_reads` | SQLite | **权威**（跨设备/隐私窗口） |
| `PostView.read` | 每次读接口响应 | 服务端权威的即时投影；渲染直接用 |
| `serverReadIds` | Provider 内存（≤2000，通知 hydration/history 采纳） | 非 PostView 行（通知行）的已读判断 |
| 本地 read-set | localStorage（≤2000） | **乐观缓存**：停留瞬间的即时 UI + 离线可用 |
| 重试队列 | localStorage `report.readq.v1:<base>:<account>`（≤500） | 未确认写入的待补项 |

### 5.2 写路径（read-dwell 已合入，改其 Provider 侧）

```text
ReadDwellEngine.markRead (read-dwell.ts:509-527)
  → NotificationsProvider.markPostRead(postId)          // 唯一写入口不变
      1. readStore.mark(postId)  → changed ? 立即 setReadIds（UI 变已读）
      2. readSync.enqueue(postId) → 250ms 合并后 flush
      3. flush: POST /api/reads/batch（≤100/片，含队列历史与本次）
         ├─ 2xx：从队列删除；无需回写 PostView（下次读接口带 read=true）
         └─ 失败/离线：留在队列（持久化），等 online / visible / ready 重试
```

- `read-dwell.ts` 与 `ReadDwellProvider.tsx` **不改判定逻辑**；只把 `markPostRead` 的
  Provider 实现从「只写 store」扩成「store + enqueue + flush」。
- 通知行点击（`NotificationsPage.tsx:191,200`）同样走 `markPostRead` ⇒ 自动获得
  服务端写入（行为不变：点击仍是已读入口之一）。
- 同一帖重复停留：`readStore.mark` 返回 `changed=false` 时不重复 enqueue（幂等）。

### 5.3 服务端对账（登录/ready）

Provider 在 `client/account` 就绪、以及账号切换（`notifications.tsx:240-255`）后：

1. `flush()` 队列（先把本机待写项送上去）；
2. 取 `localReadIds ∪ queueIds`（≤2000）→ 按 200 分片 `GET /api/reads?ids=…`；
3. `serverReadIds = 服务端返回的 post_id 集合`；
4. **服务端为准**：本地 read-set 中「服务端没有、且不在队列」的 id **删除**；
   在队列中的 id 保留（等 flush；成功后即成为服务端状态）；
5. 同步更新 `readIds` state / `notifyAll()`（通知所有 per-id 订阅者）。

- 空集合/静态模式：跳过所有请求。
- 失败：不阻塞 UI（下一次 ready/online 再试）；不删除本地缓存（失败不等于服务端为空）。

### 5.4 重试队列（纯逻辑模块 `src/ui/state/read-sync.ts`）

```ts
interface ReadQueueEntry { post_id: string; queued_at: number }
class ServerReadQueue {
  enqueue(postId: string): void                 // 去重、FIFO、超 500 丢最旧
  pending(): string[]                            // 快照（flush 用）
  ack(postIds: string[]): void                   // 成功后删除
  flush(): Promise<void>                         // 分片 POST /api/reads/batch
  // 注入 storage/timers/fetchLike，便于单测
}
```

- 持久化：250ms trailing debounce；`pagehide`/`visibilitychange→hidden` 同步 flush 到
  localStorage（与 read-set 同节奏）。
- 触发：`enqueue` 后 250ms 合并一次；`window.online`；`visibilitychange→visible`；
  Provider ready；`ack()` 之后。**不做定时轮询**。
- 上限：500 条；超出丢最旧（旧读行可由服务端 `GET /api/reads` 对账恢复——但队列项是
  「服务端还没有」的，丢最旧意味着该帖可能保持未读；500 已远大于一次离线会话的合理停留数）。
- 失败退避：`2s → 5s → 15s → 60s` 后停止自动重试，等下一个事件触发（避免耗电/耗流量）。

### 5.5 渲染

- `PostCard`：`const read = post.read === true || usePostReadFlag(post.id, post.seq)`。
  - 服务端已读 ⇒ 首帧就是已读（跨设备/隐私窗口正确，无「先高亮再淡出」闪烁）。
  - 本地乐观已读 ⇒ 停留瞬间仍走既有 1.2s 淡出动画（`report-surface` 规格不变）。
- `NotificationsProvider.isRead(targetId, seq)`：
  `serverReadIds.has(targetId) || readIds.has(targetId) || seq <= cursor`。
- `NotificationsPage` 历史行：`item.read` 由 `groupNotificationEvents` 的 `isRead` 得出；
  history 响应里 `read=true` 的行在 hydrate 前先采纳进 `serverReadIds`（避免首帧误高亮）。
- 角标：`projection.badge(readIds)`（`notification-projection.ts:155-166`）语义不变；
  `serverTargets` 已由服务端扣掉已读，`readIds` 只负责本端乐观扣减。

### 5.6 多标签页

- 两个标签页写同一帖 → 服务端 upsert 幂等（A11）。
- 两个标签页的本地缓存可能短暂不同步：下一次 peek/heartbeat（≤60s）或 ready 对账收敛；
  P2 可用 `storage` 事件即时同步（非本 change 必需）。

## 6. 「全部已读」

`NotificationsProvider.ack()`（现状 `notifications.tsx:491-513`）改为：

1. 收集目标 = `union(projection.serverTargets.keys(), projection.localTargets,
   [...projection.events] 的 target)`（同一帖去重）；
2. 目标按 100 分片 `POST /api/reads/batch`；失败项进重试队列，不阻断下一步；
3. `POST /api/notifications/ack {target}`（游标推进，**保留**）；响应照旧
   `applyCursor(cursor, unread_count)`；
4. `clearEvents()`；角标归零（游标 + post_reads 双保险）。

- 顺序：先 batch 后 ack。即使 batch 全失败，ack 仍让本账号旧事件全部已读（兼容语义），
  队列负责把逐帖已读补到服务端。
- 目标 >100 时分片；`target` 最大值仍用现有 `Math.max(cursor, asOfSeq, maxEventSeq)`。

## 7. 通知/角标语义与兼容

### 7.1 服务端返回值

| 字段 | 旧语义 | 新语义 |
|------|--------|--------|
| `unread_count` | 游标口径事件数 | 游标口径 ∩ 目标未被逐帖已读（§2.2） |
| `unread_by_target` | 各 target 事件数 | 同上；已读 target 不出现 |
| `history.events[].read` | `seq <= cursor` | `post_reads 命中 OR seq <= cursor` |
| `cursor` | 账号游标 | 不变（CLI/兼容保留） |

- 无 `post_reads` 行时两者与旧值完全一致 ⇒ 现有测试
  （`test/event-hub.test.ts:929-1036`）无需改期望。
- `hub` 心跳的 `unread_count` 走 `store.unreadCount()`（`hub.ts:498-510`），自动变为精确值。

### 7.2 客户端漂移检测

- `NotificationProjection.expectedUnreadEvents()` 仍是 `serverUnreadEvents + localEventDelta`
  （`notification-projection.ts:143-146`）；`serverUnreadEvents` 现在来自新的
  `unread_count`，两者仍同源，漂移检测逻辑不用改。
- 唯一新增漂移源：本端刚写完 `POST /api/reads`，服务端快照已扣、但本端乐观也扣 ⇒ 一致；
  若服务端快照未刷新（5s 缓存），本端乐观扣减仍显示正确，下一次对账收敛。

### 7.3 通知叠放（`report-notification-stacks`）联动

- 叠放的 `unreadByTarget`/`isRead` 数据源不变；本 change 只把「已读 target」从本地集合
  扩展到「服务端集合 ∪ 本地乐观」⇒ 叠自然收缩的语义不变。
- **规格冲突处理**：`report-notification-stacks` 的非目标写着「不新增服务端已读表、不把
  read-set 上收」；该非目标被 **Owner 2026-11-09 裁决取代**。本 change 合入时需在其
  proposal/design 的非目标处加一行注记（只改 open spec 文本，不改其实现）。

### 7.4 跨设备传播时延

- 已读写不推进 cursor、不发事件；其他设备通过下一次 peek/heartbeat（≤60s）或页面加载
  （`PostView.read` 即时）看到最新状态。
- 同账号多标签页/多设备打开同一页时，`unread_count` 的 hub 5s 缓存（`hub.ts:498-510`）
  可能短暂偏大；P1 接受 ≤5s 的角标滞后（页面加载路径不受影响），P2 可广播
  `read.ack` 控制帧（不新增事件表数据）。

## 8. 迁移与兼容清单

| 项 | 处理 |
|----|------|
| 旧游标数据 | 原样保留；`read` 仍含 `seq <= cursor`，不丢已读 |
| 无 `post_reads` 的旧库（export 只读） | `readTablesAvailable()` 探测 → `read=false`，不抛错 |
| 本地 read-set | 保留为缓存；上限 2000 只约束 localStorage（≥150KB 预算不变） |
| 旧本地 read-set 未上传 | 升级后服务端读行为空 ⇒ 已读帖可能重新高亮；P2-1 提供一次性上传（≤2000，分片 100），失败则下次登录重试；只看**当前账号**的 key |
| CLI | 不变：`wait-notifications` 仍按 cursor 交付；`read` 查询仍返回全部（含已读） |
| 静态导出 | 快照 `SnapshotPost` 多 `read/read_at` 字段（`SnapshotPost = Omit<PostView,…>`
  自动带上）；`StaticReportClient.hydrate` 显式透传；UI 静态模式不消费（`trackable=false`） |
| 快照版本 | `version: 1` 不变（增字段向后兼容；旧快照缺字段 → `read=false`） |
| 端口/部署 | 无变化（复用现有 HTTP 端口与数据目录） |

## 9. 安全

- **账号隔离**：所有读写都从凭据解析 account；`post_reads` 查询永远带
  `account_id = <身份>`，不存在 `?account=` 参数。
- **可见性**：单帖写 404（未知/不可见同码，不泄露存在性）；batch 静默 skip。
- **无已读回执**：不提供「谁读过本帖」的接口/字段；作者视角与今天完全一致。
- **输入上限**：`post_id` 长度 ≤128；batch ≤100；`ids` ≤200；避免超长 SQL/URL。
- **无日志泄露**：不打印 post_id 列表/读行内容（既有日志纪律）。
- 速率：单账号写入天然被 UI 节流（250ms 合并 + 队列去重）；P2 可加简单令牌桶。

## 10. 性能预算

| 场景 | 预算 | 断言方式 |
|------|------|----------|
| hydrate 一页 20 帖 | 新增 **1** 条查询（`chunks` 400 ⇒ 1 组） | 测试用计数包装 `db.query`（或 `PRAGMA` 计数器）断言差值 = 1 |
| hydrate 1000 帖（export/批量） | 新增 ≤3 条查询（1000/400 向上取整） | 同上 |
| 未读谓词 | 1 条 `COUNT` + 1 条 `GROUP BY`；`NOT EXISTS` 走主键探针 | 查询计划含 `USING PRIMARY KEY`（`EXPLAIN QUERY PLAN` 断言） |
| history 一页（≤100 行） | 新增 1 条 read 批量查询（不逐行） | 查询计数 |
| peek 心跳 | 既有 5s 缓存不变；`unreadCount` 复杂度 O(游标后事件数) | 1000 事件数据集 <50ms（宽松上限，CI 稳定） |
| ready 对账 | ≤ceil(2000/200)=10 个 GET，仅登录/切换账号一次 | 测试断言请求数 ≤10 且 ≤200 id/请求 |

## 11. 边界

| 边界 | 行为 |
|------|------|
| 软删帖写读 | 允许；未读/高亮/角标不受影响；历史行灰显不变 |
| 软删后又……（无恢复接口） | 不回滚读行 |
| 未知帖 / 不可见帖 | 单帖 404；batch `skipped` |
| 自己发的帖 | 允许写；停留引擎不注册（不变） |
| 后台标签页 | 停留不达标（既有 `visibilityState` 门）⇒ 不写 |
| 同一帖并发写 | 1 行；`read_at` = 首次（A11） |
| 队列满 500 | 丢最旧（可被服务端对账恢复的项除外；见 §5.4） |
| localStorage 不可用（隐私模式） | 缓存退化为内存；队列退化为内存；写仍走网络（若可用） |
| 静态归档 | 零写、零读同步请求、无高亮（既有 + 新增 §12 断言） |
| 账号删除 | 同事务删 `post_reads`（§3.4） |

## 12. 验收矩阵（A1–A12）

> E2E 一律跑隔离后端（`scripts/qa/qa-serve.mjs`），禁止写生产板 13689；
> 双上下文：Context A（正常）+ Context B（`browser.newContext()` 全新存储 = 模拟隐私窗口/另一设备）。

| # | 场景 | 判据（可执行断言） |
|---|------|-------------------|
| A1 | 跨设备一致 | A 停留读掉 3 帖 → 等队列 flush；B 登录 → `GET /api/notifications` 的 `unread_by_target` 不含 3 帖；B 的 feed 中这 3 帖 `[data-post-id][data-read="1"]`；角标与 A 相同 |
| A2 | 隐私窗口 | 全新 context（无 localStorage）登录同一账号 → 角标 = 服务端未读数（不是 30+）；已读帖无未读底色；`localStorage` 中无 `report.read.v1:*` 依赖也能正确渲染 |
| A3 | 离线重试 | `context.setOffline(true)` → 停留达标 → 本地立即 `data-read="1"`、队列 key 有 1 项；恢复 online → 队列清空、`GET /api/reads?ids=` 返回该帖；B 可见 |
| A4 | 批量 | 队列塞 250 个 id → flush 发出 3 个 `POST /api/reads/batch`（100/100/50）；无 400；服务端 250 行；单请求 body 的 `post_ids.length ≤100` |
| A5 | 通知角标 | 2 帖未读；读 A 达标 → 角标 −1（不是 0）；`unread_by_target` 键数 −1；B 设备角标同步 |
| A6 | 同帖多事件 | 同帖 2 条事件未读；读该帖 → 2 条通知都 `read=true`；角标只 −1；`unread_count` 减 2（事件数）但 target 数减 1 |
| A7 | 全部已读 | 5 帖未读 → 点「全部已读」→ 5 帖的 `GET /api/reads?ids=` 全命中；cursor 推进；历史 5 行仍在且 `read=true`；角标 0 |
| A8 | 静态不写 | `file://` 打开归档 → 0 个 `POST /api/reads*` / `GET /api/reads`；localStorage 无 `report.read*`；卡片无 `data-read`/无未读底色 |
| A9 | 迁移幂等 | 用 v5 fixture 连续 `migrate()` 两次 → 无异常、`schema_version=6`、`post_reads` 存在；`openDatabase(readonly)` 打开未迁移 v5 fixture → `getPostView().read === false`、`unreadCount` 与旧值一致、不抛错 |
| A10 | hydrate 无 N+1 | 20 帖页（timeline/feed/thread 各 1）新增查询数 = 1；1000 帖 export 新增 ≤3；`EXPLAIN QUERY PLAN` 断言 `post_reads` 使用主键索引 |
| A11 | 并发写幂等 | `Promise.all` 20 次 `POST /api/reads {post_id:P}` → 全 2xx；`SELECT COUNT(*) WHERE account_id='a' AND post_id='P'` = 1；所有响应 `read_at` 相同（除首个 `created=true`）；无 5xx |
| A12 | 软删边界 | 软删帖写读 2xx；`unread_by_target` 不含它；卡片无高亮；未知 id 单帖 404；batch 含未知 id → 200 + `skipped` 含该 id，其余照常写入 |

## 13. 测试策略

- **纯函数/Store（bun test）**：
  `test/post-reads-schema.test.ts`（迁移/旧库/清理）、`test/post-reads-store.test.ts`
  （upsert 幂等/可见性/batch/读行批量/hydrate 查询计数/unread/history）、
  `test/post-reads-http.test.ts`（鉴权/400/404/批量上限/capabilities）。
- **客户端纯逻辑**：`test/read-sync.test.ts`（队列去重/上限/分片/失败保留/退避/静态模式）、
  `test/read-state-ui.test.ts`（`isRead` 三源合并、对账丢弃规则）。
- **回归**：`test/event-hub.test.ts`（unread 不变）、`test/notifications.test.ts`
  （history/read）、`test/export-static.test.ts`（快照字段）、`test/http.test.ts`。
- **E2E**：`scripts/qa/read-state.mjs`（双上下文，A1–A12；产出 `steps.json` + PNG，
  按主仓 E2E 报告规范生成 `report.html`）。
- **门禁**：`bun test`、`bun run check`（tsc + 路由契约 + 安全 lint）、`bun run typecheck:ui`。

## 14. 合并顺序与冲突面

```text
report-link-preview ─┐
report-read-dwell ───┼─→ report-thread-scope/nesting ─→ report-notification-stacks ─→
report-event-hub ────┘                                                        report-server-read-state
```

- `report-read-dwell` **已归档合入** ⇒ 本 change 直接改其 Provider 写路径；其 spec/QA 的
  「不推进游标」「只写一次」「暂停/边界」断言全部保留。
- `report-notification-stacks` 必须先合：它对 `notifications.tsx`/`NotificationsPage.tsx`
  的改动最大；本 change 在其后 rebase，只做数据源替换（`readIds` → `readIds ∪ serverReadIds`）。
  其非目标「不新增服务端已读表」由本 change 的 Owner 裁决取代（§7.3）。
- `report-thread-nesting` 与本 change 无共享逻辑（只共享 `PostView` 字段，纯增）。
- `report-event-hub` 在途：本 change 不改 hub 事件/游标广播；若 event-hub 先合，注意
  `notification-projection.ts` 的 `serverTargets` 语义不变（本 change 不改其结构）。
- 冲突热点（按概率）：`notifications.tsx` > `NotificationsPage.tsx` > `store.ts` >
  `static-api.ts` > `protocol.ts`。

## 15. 已定决策（Manager 2026-11-09，Owner 授权自主决策）

1. **升级过渡**：旧本地 read-set **提为 P1**——首次登录一次性批量上传（`POST /api/reads/batch`，
   服务端 `DO NOTHING` 去重），避免升级当天「服务端为空 → 先在当前设备看到 30+ 未读」。
   由前端 P1-6 实现；未上传前本地缓存仍作为 UI 兜底。
2. **`read_at` 语义**：保留**首次**已读时间（`DO NOTHING`，严格幂等）；本 change 无「最近阅读」
   排序需求；未来若需要，另加 `last_read_at` 列，不改本列含义。
3. **`PostView.read` 类型**：服务端运行时恒返回；TS 暂为可选，待前端 P1-6 完成
   `static-api.ts` 透传后改为必填（前端任务内完成）。

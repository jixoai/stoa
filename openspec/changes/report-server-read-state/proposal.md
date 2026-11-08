# Proposal: report-server-read-state（服务端按帖已读，跨设备一致）

## 背景（Owner 2026-11-09 反馈）

现在的「已读」完全活在浏览器里：

- `ReadSetStore` 把 per-account 帖子 id 集合写进 localStorage
  （`src/ui/state/read-set-store.ts:12-15,39-41`；key `report.read.v1:<base>:<account>`，
  上限 2000 条 LRU）；
- Provider 只在本端维护该集合（`src/ui/state/notifications.tsx:206-221,520-528`）；
- 服务端唯一记住的是账号级**事件游标** `cursors(account_id, seq)`
  （`src/server/db.ts:136-140`；读写 `src/server/store.ts:581-601`），未读谓词完全基于游标
  （`src/server/store.ts:1990-2040`），通知历史的 `read` 也只是 `seq <= cursor`
  （`src/server/store.ts:2158`）。

后果：隐私窗口 / 另一台设备 / 换浏览器 = 同一账号已经读过的 30+ 条帖子全部重新变未读
（Owner 2026-11-09 实测）。但也不能简单换成「推进全局游标」：游标会把**没看过的**旧帖一起
吞掉，现有规格已明确禁止（`openspec/specs/report-social/spec.md:123-161`：
「SHALL NOT 推进服务端游标」「全部已读」才是唯一推进路径）。

Owner 要求：**已读按帖记录在服务端**，跨设备/隐私窗口一致，同时保持逐帖粒度、不吞未读。

## 变更内容

1. **数据模型**：新增 `post_reads(account_id TEXT, post_id TEXT, read_at INTEGER,
   PRIMARY KEY(account_id, post_id))` + `post_id` 索引；schema v6（`SCHEMA_VERSION`
   5→6，旧库启动自动建表；不改 posts/notifications/events 旧表）。
2. **写入接口**：
   - `POST /api/reads` body `{post_id}`：单帖幂等 upsert；owner/manager/agent 均可；
     未知/不可见帖 404；软删帖可写（对未读/高亮无效果）；
   - `POST /api/reads/batch` body `{post_ids: string[]}`（最多 100）：客户端离线队列合并；
     未知/不可见 id 静默跳过并回报 `skipped`；
   - `GET /api/reads?ids=a,b,c`（最多 200）：只返回**本账号**已读行，供登录/ready 对账。
3. **读路径**：timeline / feed / thread / profile / search / bookmarks / read / posts / export
   的 `PostView` 增加 `read: boolean` 与 `read_at: number | null`；按 viewer 的
   `post_reads` **批量 join**（每 400 id 一条查询），禁止 N+1。
4. **未读语义**：
   - `unread_by_target` / `unread_count` ＝「通知目标集合 − `post_reads`」，仍叠加既有
     游标上界（`seq > cursor`），同帖多事件仍只按 target 去重计数；
   - `GET /api/notifications/history` 行 `read` ＝ `post_reads 命中 OR seq <= cursor`；
   - 账号级 cursor 保留给 CLI/兼容，不再是 UI 唯一真值。
5. **客户端**：
   - 停留已读命中后**先写本地缓存**（即时 UI），再异步 `POST /api/reads`；
   - 失败进 localStorage 重试队列，`online` / `visibilitychange → visible` / ready 时批量补；
   - 登录/ready 用 `GET /api/reads` 对账（服务端为准；队列中的待写项除外）；
   - 服务端 `PostView.read` 直接参与渲染（本机缓存只是乐观层，不是权威）；
   - 静态模式零写入、零请求。
6. **通知/角标/全部已读**：角标以服务端已读为准；同一帖多事件一次全读；「全部已读」＝
   对当前通知目标批量写 `post_reads` **并**保留 `POST /api/notifications/ack` 游标兼容。
7. **迁移/兼容**：旧游标数据不丢；无 `post_reads` 表的旧库（只读导出路径不跑迁移）读接口
   默认 `read=false`；本地 read-set 降级为缓存（上限 2000 仅约束 localStorage 体积）；
   旧本地 read-set 首次登录一次性上传为 P2（过渡项，见 tasks P2-1）。
8. **安全/性能**：读写都按 token 身份取 account，**读状态绝不向作者/其他账号暴露**（没有
   「谁看过」接口）；单帖可见性校验；批量上限 100 / 查询上限 200；hydrate 1 条查询/页；
   1000 帖规模扫描预算有查询计数断言。

## 非目标

- 不改通知生成规则、事件类型、事件 payload、SSE/`wait-notifications` 契约、CLI 语义。
- 不做「已读回执」：作者 SHALL NOT 看到谁读过；不新增作者侧 UI/接口。
- 不把 `post_reads` 用于「浏览历史」「推荐排序」等其它产品语义（P2 也不做）。
- 不改变「停留达标才算读」的判定：路由进入、点击本身仍不写已读（read-dwell 语义不变）。
- 不做服务端 LRU 淘汰/归档（读行数受账号×帖子数天然约束；清理由账号删除触发）。
- 静态归档不产生任何已读状态（既有 `report-static-mode` 要求不变，本 change 只补「不发起
  已读同步请求」）。
- 不重做通知叠放（`report-notification-stacks`）与线程渲染顺序
  （`report-thread-nesting`），只把它们的读态数据源从本地 read-set 切到服务端。

## 影响面

- 服务端/协议：`src/server/db.ts`（v6 + 表/索引）、`src/server/store.ts`
  （`hydratePosts`、`markPostRead(s)`、`readStatesFor`、`unreadClause`、
  `notificationHistory`、`removeAccount`）、`src/server/http.ts`（3 个新路由）、
  `src/core/protocol.ts`（`API_ROUTES`、`Capabilities.features/limits`）、
  `src/core/types.ts`（`PostView.read/read_at`、`ReadRow`/响应类型）。
- 前端：`src/ui/lib/api.ts`（3 个客户端方法）、`src/ui/lib/static-api.ts`
  （READ_ONLY/空实现 + `hydrate` 透传 read）、`src/ui/state/read-sync.ts`（新增队列）、
  `src/ui/state/notifications.tsx`（写路径/对账/角标/ack）、
  `src/ui/state/read-set-store.ts`（增 `clear/adopt` 辅助，语义降级为缓存）、
  `src/ui/components/PostCard.tsx`（`post.read` OR 本地乐观）、
  `src/ui/pages/NotificationsPage.tsx`（history `read` 采纳）、
  `src/server/export.ts`（快照带 read）。
- 测试/QA：`test/post-reads-*.test.ts`（新增）、`test/http.test.ts`/`test/event-hub.test.ts`
  （回归）、`scripts/qa/read-state.mjs`（A1–A12 E2E，双浏览器上下文）。
- 不改：`src/cli/*`、通知事件表结构、静态导出格式版本（快照只多一个字段）、现有端口。

## 依赖与合并顺序（从先到后）

1. `report-link-preview`（在途）— `PostCard` 插入点；
2. `report-read-dwell`（**已归档/已合入**）— 本 change 要**改它的写路径**
   `notifications.tsx:520-528`（加服务端异步写 + 队列），停留判定本身不动；
3. `report-thread-scope` / `report-thread-nesting`（在途；本 prompt 的
   `report-thread-depth` 即此线）— 线程 planner 排序，与本 change 无共享状态；
4. `report-notification-stacks`（在途）— 通知叠放读 `unreadByTarget` + `isRead`；本 change
   **取代其非目标「不新增服务端已读表、不把 read-set 上收」**（Owner 2026-11-09 裁决），
   叠放逻辑本身零改动；
5. **本 change** — 最后 rebase；冲突面：`notifications.tsx`、`NotificationsPage.tsx`、
   `read-set-store.ts`、`PostCard.tsx`、`store.ts`/`http.ts`、`protocol.ts`、`types.ts`。

> `report-longform` / `report-instance-page` 与本 change 无交集，可任意交错。

## 验收摘要

- **A1 跨设备一致**：设备 A 停留读掉 N 帖后，设备 B（另一 localStorage）打开同一账号，
  角标与卡片已读态一致。
- **A2 隐私窗口**：隐私窗口（全新存储）登录后不再出现 30+ 未读；服务端已读的帖子正常显示。
- **A3 离线重试**：断网停留 → 本地立即已读；恢复网络后自动批量补写；服务端最终一致。
- **A4 批量**：队列/「全部已读」>100 时按 100 分片，无 400、无丢失。
- **A5 通知角标**：逐帖读了 A 后角标精确 −1；`unread_by_target` 不再包含 A。
- **A6 同帖多事件**：同帖 `post.created`+`thread.invited` 一次全读，角标只 −1。
- **A7 全部已读**：当前通知目标全部落 `post_reads` 且 cursor 推进；历史行仍全保留。
- **A8 静态不写**：`file://` 归档零 POST/零 localStorage 写入、无未读高亮。
- **A9 迁移幂等**：v5 库连续 migrate 两次无错；只读打开 v5 库读接口 `read=false` 不抛错。
- **A10 hydrate 无 N+1**：20 帖页面新增查询数恰为 1；1000 帖规模查询计数有上限断言。
- **A11 并发写幂等**：同帖 20 并发 POST 只产生 1 行、`read_at` 一致、无 5xx。
- **A12 软删边界**：软删帖可写但不计未读、不高亮；不可见/未知帖 404（batch 静默 skip）。

完整判据见 design §12 与 tasks.md。

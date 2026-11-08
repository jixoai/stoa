# Tasks: report-server-read-state（服务端按帖已读）

> **硬依赖顺序**：`report-link-preview` → `report-read-dwell`（已归档合入）→
> `report-thread-scope`/`report-thread-nesting` → `report-notification-stacks` → **本 change**。
> - `report-read-dwell` 已合入：本 change 只改其 Provider 写路径，**不改**停留判定/暂停/边界。
> - `report-notification-stacks` 未合入前，P1-9/P1-10 的 `notifications.tsx`/
>   `NotificationsPage.tsx` 接线阻塞（其非目标「不新增服务端已读表」由 Owner 2026-11-09
>   裁决取代，合入时同步修订其文本）。
> - 每项判据不满足不得勾选；测试用隔离数据目录，E2E 一律跑 `scripts/qa/qa-serve.mjs`，
>   **禁止**写生产板 13689。

## P0. 前置确认

- [ ] P0-1. 确认依赖就绪：`report-read-dwell` 在 `openspec/changes/archive/` 且
  `ThreadPage.tsx` 无「进入即已读」；`report-thread-nesting` 已合入；`report-notification-stacks`
  已合入或明确排在本 change 之前。
  - 判据：上述路径/文件存在性检查通过；`git log --oneline -5` 记录基线 commit。
  - 证据：archive 目录清单 + `rg "markPostRead\\(postId\\)" src/ui` 无路由级残留 + 基线 hash。

- [ ] P0-2. 复现基线：全新浏览器上下文登录同一账号，服务端已读为空 ⇒ 角标 ≥ 既有未读；
  用 `localStorage` 手工注入 3 条已读后刷新，角标不变（证明服务端未知情）。
  - 判据：脚本记录 before 数字（角标/`unread_by_target` 键数/localStorage key 长度）；
    「另一台设备/隐私窗口」场景 before 为未读。
  - 证据：`scripts/qa/read-state.mjs --before` 输出 + 截图。

- [ ] P0-3. Owner 拍板 design §15 两项（旧 read-set 上传是否 P1；`read_at` 首读 vs 最近读）。
  - 判据：决策写回 design §0/§15 与 tasks 勾选项；未决则 P1-13/P2-1 按推荐值（P1 上传、首读）执行并标注。
  - 证据：本文件与 design.md 的修订 diff。

## P1. 服务端（schema + store + API）

- [ ] P1-1. schema v6：`post_reads` 表 + `idx_post_reads_post`；`SCHEMA_VERSION` 5→6；
  `removeAccount` 事务内清理；`readTablesAvailable()` 探测（仿 `previewTablesAvailable`）。
  - 判据：`test/post-reads-schema.test.ts` 全绿，覆盖：
    ① 空目录 `migrate()` 后表/索引存在、`meta.schema_version='6'`；
    ② 连续 `migrate()` 两次无异常（幂等）；
    ③ 用 v5 DDL fixture 打开后 migrate → 自动建表，旧表数据不变；
    ④ v5 fixture **只读打开**（不 migrate）→ `readTablesAvailable()=false` 且
    `getPostView().read===false`、`unreadCount` 与旧口径一致、不抛错；
    ⑤ `removeAccount('agent')` 后该账号 `post_reads` 行数为 0，其他账号不受影响；
    ⑥ 既有 `test/social.test.ts:161` 的 `schema_version` 期望由 `"5"` 改为 `"6"`。
  - 证据：`bun test test/post-reads-schema.test.ts` + `SCHEMA_VERSION` 行号。

- [ ] P1-2. store 读态方法：`markPostRead(accountId, postId)`（单帖）、
  `markPostReads(accountId, postIds)`（批量、单事务、去重）、`readStatesFor(accountId, postIds)`
  （一条查询/400 组）；未知/不可见帖语义见 design §4.1/§4.2。
  - 判据：`test/post-reads-store.test.ts` 覆盖：
    ① 同帖两次写 → 1 行、`read_at` 相同、第二次 `created=false`；
    ② 未知帖 `markPostRead` 抛 `NOT_FOUND`；不可见帖（agent 非参与者）同样 404；
    ③ 软删帖可写且落行；
    ④ batch 100 个混合 id：可见写入、未知/不可见进 `skipped`、`stored + skipped = 输入去重数`；
    ⑤ `readStatesFor` 返回 Map 且 id 分组 400 边界正确（401 个 id 两条查询）。
  - 证据：`bun test test/post-reads-store.test.ts` + 用例名清单。

- [ ] P1-3. `hydratePosts` 批量读态：viewer 的 `post_reads` join（`chunks` 400，1 条/组）+
  `seq <= cursor` 兜底；`PostView` 增 `read/read_at`（`src/core/types.ts`）；
  旧库缺表时全 `false`；`export` 快照自动带字段。
  - 判据：`test/post-reads-hydrate.test.ts`：
    ① 20 帖 timeline：新增查询数恰 1（计数包装 `db.query`）；
    ② 1000 帖 `visiblePostsForExport`：新增查询 ≤3；
    ③ 软删帖 `read` 不影响其它字段（body 仍为空、previews 仍为 []）；
    ④ cursor 覆盖（`seq <= 10`）的帖子 `read=true, read_at=null`；
    ⑤ 无 `post_reads` 表的 v5 只读库：所有 `read=false`、不抛错；
    ⑥ `/api/thread` 的 `ThreadNode` 继承 `read/read_at`。
  - 证据：`bun test test/post-reads-hydrate.test.ts` + 查询计数断言输出。

- [ ] P1-4. 未读语义：`unreadClause` 加 `NOT EXISTS(post_reads(a, e.post_id))`；
  `unreadCount`/`unreadByTarget` 共用；`notificationHistory` 行 `read` 改为
  `post_reads 命中 OR seq <= cursor`（页内一次性批量 join，不逐行）。
  - 判据：`test/post-reads-unread.test.ts`：
    ① 无读行时与旧值完全一致（既有 `event-hub.test.ts` 期望不改）；
    ② 读 1 帖后 `unread_by_target` 不含它、`unread_count` 减该帖事件数；
    ③ 同帖 2 条事件读后 target 数 −1、事件数 −2；
    ④ 软删帖读行不影响（本就排除）；
    ⑤ history 一页 100 行新增查询数 = 1（计数断言）；
    ⑥ `cursor` 覆盖的事件 `read=true`（旧行为保留）。
  - 证据：`bun test test/post-reads-unread.test.ts test/event-hub.test.ts test/notifications.test.ts`。

- [ ] P1-5. HTTP 路由：`POST /api/reads`、`POST /api/reads/batch`、`GET /api/reads?ids=`；
  参数校验（长度/类型/上限）、鉴权、batch 事务；capabilities 增
  `features.post_reads`、`limits.reads_batch/reads_query`；`API_ROUTES` 登记（含补漏
  bookmarks/history 既有路由）。
  - 判据：`test/post-reads-http.test.ts` 覆盖：
    ① owner/manager/agent 三类身份都能写自己的读行；无凭据 401；
    ② `post_id` 缺失/空/非字符串/>128 → 400；未知/不可见 → 404；
    ③ batch 非数组/空/>100/元素非法 → 400；混合 batch → 200 + `skipped`；
    ④ `GET /api/reads` 无 ids/空/>200 → 400；只返回本账号行（换 token 查不到）；
    ⑤ `/api/capabilities` 含 `post_reads:true`、`reads_batch:100`、`reads_query:200`；
    ⑥ `bun run check` 的路由契约通过（`API_ROUTES` 字面量都能在 http.ts 找到）。
  - 证据：`bun test test/post-reads-http.test.ts` + `bun run check` 输出。

## P1. 客户端（乐观层 + 队列 + 对账）

- [ ] P1-6. `src/ui/lib/api.ts` 加 `markRead(postId)`、`markReads(postIds)`、`readStates(ids)`；
  `src/ui/lib/static-api.ts` 三个 override：写方法抛 `READ_ONLY`、`readStates` 返回空、
  `hydrate()` 显式透传 `read/read_at`。
  - 判据：`test/read-state-ui.test.ts`：
    ① static 客户端调用三个方法分别抛 `READ_ONLY`/返回空且 **零 fetch**（注入 fetch 桩计数=0）；
    ② static `hydrate` 重组的 PostView 带 `read/read_at`（缺省 false/null）。
  - 证据：`bun test test/read-state-ui.test.ts` + `rg "READ_ONLY" src/ui/lib/static-api.ts`。

- [ ] P1-7. 新增 `src/ui/state/read-sync.ts`：`ServerReadQueue` 纯逻辑（去重、FIFO 500、
  250ms 持久化 debounce、分片 100、`online`/`visible`/ready 触发、退避 2s/5s/15s/60s、
  静态模式 no-op）。
  - 判据：`test/read-sync.test.ts` 覆盖：
    ① 重复 enqueue 只 1 项；② 501 项丢最旧；③ 250 个 id flush → 3 个 batch 请求
    （100/100/50）；④ 首个请求 500 时失败项保留、后续项不丢；⑤ 退避序列与上限；
    ⑥ `static=true` 时 enqueue 不写 storage、flush 零请求；⑦ `ack` 只删成功项。
  - 证据：`bun test test/read-sync.test.ts` + 用例名清单。

- [ ] P1-8. Provider 接线：`markPostRead` = `readStore.mark` + `readSync.enqueue` + 防抖 flush；
  ready/账号切换执行「flush → GET /api/reads 分片对账 → 服务端为准丢弃本地孤立项」；
  `isRead`/`isPostRead` 增 `serverReadIds`；`serverReadIds` 从通知 hydration 的
  `PostView.read` 与 history `read` 采纳（上限 2000）。
  - 判据：`test/read-state-ui.test.ts` 覆盖：
    ① 对账：本地 {A,B}、服务端 {A}、队列空 → 本地剩 {A}；
    ② 本地 {A,B}、服务端 {A}、队列含 B → 本地保留 {A,B} 且 B 被 flush；
    ③ 对账请求 ≤10 个且每个 ids ≤200；
    ④ `isRead(A, seq)` 在 serverReadIds/本地/游标任一命中为 true；
    ⑤ 账号切换后 `serverReadIds` 清空重建（不串号）。
  - 证据：`bun test test/read-state-ui.test.ts` + `rg "serverReadIds" src/ui/state/notifications.tsx`。

- [ ] P1-9. `PostCard` 渲染：`read = post.read === true || usePostReadFlag(...)`；
  服务端已读首帧即已读（无闪烁），本地停留仍保留既有 1.2s 淡出；通知页
  `groupNotificationEvents` 的 `isRead` 使用三源合并；history 行 `read=true` 先采纳。
  - 判据：UI 单测/QA：
    ① 构造 `post.read=true`、本地空 → 首帧 `data-read="1"`、无 `report.read.v1` 写入；
    ② `post.read=false` + 停留达标 → 先 `data-read="1"`，随后 POST 成功；
    ③ `prefers-reduced-motion` 下仍立即切换（回归）。
  - 证据：`bun test test/read-dwell.test.ts test/read-state-ui.test.ts` + QA 截图。

- [ ] P1-10. `ack()`（全部已读）：收集当前通知目标 → 分片 batch 写 → 再
  `POST /api/notifications/ack`（保留 cursor）；batch 失败项进队列；目标 >100 分片。
  - 判据：`test/read-state-ui.test.ts` / QA：
    ① 5 帖未读 → 点击后 5 个 id 全在服务端（`GET /api/reads?ids=`）+ cursor 推进；
    ② 250 个目标 → 3 个 batch + 1 个 ack，无 400；
    ③ batch 全失败 → ack 仍执行、角标归零、队列保留目标；
    ④ 历史列表行数不变、全部 `read=true`。
  - 证据：单测 + `scripts/qa/read-state.mjs` A7。

- [ ] P1-11. E2E `scripts/qa/read-state.mjs`：双浏览器上下文（正常 + 全新存储 = 隐私窗口/
  另一设备），覆盖 design §12 A1–A12；产出 `steps.json` + PNG；按主仓规范生成
  `.agents/reports/report-worker/report-server-read-state/report.html`。
  - 判据：A1–A12 全 PASS；无写生产板（脚本断言 base 为 qa-serve 临时目录）；
    退出码 0；`results.json` 记录每项 PASS/FAIL 与关键数字。
  - 证据：`bun scripts/qa/read-state.mjs` 输出 + `results.json` 摘要 + 390/1280 截图。

- [ ] P1-12. 全量门禁与回归：`bun test`、`bun run check`、`bun run typecheck:ui`；
  重点回归 event-hub / notifications / export-static / read-dwell / thread-nesting /
  notification-stacks（若已合入）。
  - 判据：三条命令 exit 0；测试总数不减少；`test/event-hub.test.ts:929-1036` 旧期望零修改。
  - 证据：三条命令输出 + 测试计数 before/after。

- [ ] P1-13. **（若 Owner 选择 P1 上传）** 旧本地 read-set 一次性上传：登录/ready 时把当前
  账号 key 下 ≤2000 个 id 分片 `POST /api/reads/batch`，成功后写
  `report.read.uploaded.v1:<base>:<account>` 标记；失败下次重试；static 不执行。
  - 判据：`test/read-state-ui.test.ts`：
    ① 2000 id → 20 个 batch 请求（100/片）；② 标记存在时不重复上传；
    ③ 上传失败不写标记、下次 ready 重试；④ 只上传当前账号 key。
  - 证据：单测 + QA A2 的升级场景（预置 localStorage 后首次登录角标为 0）。

## P2. 可选与后续

- [ ] P2-1. 旧本地 read-set 上传（若 P1-13 未采纳，保留为后续过渡项）。
  - 判据：同 P1-13；上线后第二次启动零重复上传。
  - 证据：单测 + 灰度数据（上传请求数/账号）。

- [ ] P2-2. `read_events` 审计表（append-only：account_id/post_id/read_at/UC → source
  `dwell|click|ack|import`）；只用于诊断，不参与读判定。
  - 判据：写路径全部带 source；`GET /api/status` 可给出计数；对 `post_reads` 无影响（回归）。
  - 证据：迁移测试 + 状态输出。

- [ ] P2-3. 同账号实时已读广播：hub 控制帧 `read.ack {post_ids}`（非事件表），
  收到后让其他标签页立即采纳并失效 `unreadCache`（`hub.ts:497-510`）。
  - 判据：两标签页同账号，A 读完 → B ≤1s 内角标更新；无新增事件行；断线重连后不重复。
  - 证据：event-hub client 测试 + 双标签 E2E 截图。

- [ ] P2-4. CLI 只读查询：`report reads --ids/--limit` 输出本账号读行（JSON），
  不新增写命令（CLI 仍以 cursor 交付为主）。
  - 判据：`CLI_COMMANDS` 契约 lint 通过；CLI 测试覆盖输出与 400。
  - 证据：`bun test test/cli.test.ts` + 命令输出样例。

- [ ] P2-5. 清理与统计：purge 帖/账号时按 `idx_post_reads_post` 清理；`/api/status` 暴露
  `post_reads` 行数与最近写入时间（只读）。
  - 判据：清理幂等；status 字段类型稳定；无敏感信息。
  - 证据：单测 + status JSON 样例。

# Proposal: report-notification-stacks（通知按会话链叠放）

## 背景（Owner 2026-11-08 要求）

> 「通知按会话链叠放」：一条会话里同一分支的连续回复，不应在通知页铺成 N 行；
> 一个会话链只占一行，点开从**最早一条未读**开始读，读完自然收缩。

现状（path:line 证据见 design §1）：

- 通知页按**单个帖子**成行：`groupNotificationEvents` 只按 `post_id` 合并事件
  （`src/ui/state/notifications.tsx:128-160`），页面对每一帖渲染一行
  （`src/ui/pages/NotificationsPage.tsx:164-230`）。
- 一条 5 条回复的会话链 = 5 行通知；点任意一行只进那一帖，不建立「同一会话」的阅读顺序。
- 服务端通知读路径只返回事件与 `unread_by_target`（`src/server/store.ts:2003-2020,2090-2148`），
  **不返回祖先拓扑**；客户端当前也没有把帖子祖先链聚合成「会话」的纯函数。
- 线程详情正在由 `report-thread-scope` 收敛为「祖先 + focal + 后代」的作用域语义
  （本工作树尚未出现该 change；本提案按「抽到 `src/ui/lib/thread-plan.ts` 并共享」设计，
  见 §依赖顺序）。通知叠放必须与它使用**同一套**祖先/子树/`scopeOf` 定义，否则会出现
  「通知说是一叠，点开却看不到叠内成员」的语义分裂。

## 变更内容

1. **相关性定义**：同一 `root_id` 且两帖在祖先/后代关系上可比（同一 chain）才算同一条
   timeline；兄弟分支不算——按 `report-thread-scope` 语义，打开兄弟之一不会同屏显示另一个。
   只有共享同一个「叠锚点」才归为一叠。**例外（Owner 2026-11-08 修正）**：共同祖先本身未读时，
   打开该祖先会**同屏其全部后代分支**，因此其下兄弟共享该未读祖先锚点而**可以同叠**；
   「兄弟不算」仅指**无未读共同锚点**时不得自动合并，实现者禁止简化成「兄弟永不同叠」。
2. **分组键（highest unread ancestor）**：对每个通知目标帖 p，
   `anchor(p) = 自身与祖先中最早的未读帖`；若自身与祖先均无未读，退化为
   「自身与祖先中最靠根的已通知帖」；再退化为 p 自身。同 key 归为一叠。
3. **叠行**：一叠渲染为一行（层叠卡片视觉）；标题/摘要取**最新一条未读**；未读数 =
   叠内去重后的未读帖数；同帖多条通知（`post.created` + `thread.invited`）只算一个成员。
4. **点击锚点**：点击叠行打开 `#/p/<anchor>`，focal = 最早一条未读（不是最新）；线程页
   向上是已读上下文祖先，向下是后续未读后代。全已读的叠以最靠根的已通知帖为 focal
   （**上下文回看**语义，不做「跳最新」变体；要看最新向下滚），保证其 timeline 覆盖叠内全部分支。
5. **共享纯函数（单一事实源）**：祖先判定 / 子树 / `scopeOf` / `highestUnreadAncestor`
   由 `report-thread-scope` 抽到 `src/ui/lib/thread-plan.ts`，通知分组与线程 planner 共用；
   新增契约测试「被判同叠 ⇔ 从最早未读打开的 timeline 包含叠内全部未读成员」。
6. **读态联动**：不新增任何「叠已读」写路径。打开后由 `report-read-dwell` 的视窗停留
   逐条转已读，叠自然收缩；「全部已读」仍是唯一推进服务端游标的路径。
7. **只读拓扑接口**：新增 `GET /api/posts/lineage?ids=…`（输入帖 + 全部祖先的最小行），
   一次性给分组提供祖先链，避免 100 条通知产生 O(N×depth) 次单帖请求。通知/事件/CLI
   契约不变，不改数据库 schema。
8. **边界**：软删帖从叠成员与锚点候选中剔除，但其通知行作为**独立「此帖已删除」灰行**保留在
   历史（不可点/不可展开、不从 history 抹除、不计未读）；同帖多条通知去重；分页/历史通知在
   **合并后的集合**上分组（成员可跨页）；静态模式无通知不适用；多账号 read-set 与拓扑缓存
   隔离；叠内最新未读被删时回退到次新未读。

## 非目标

- 不重做通知生成规则、不新增通知类型、不改事件 payload、不改 `wait-notifications`/CLI。
- 不新增服务端已读表（真值表已由 `report-server-read-state` 交付 `post_reads`）；
  不重复实现读态写路径；不改「全部已读」与游标语义。
- 不做通知的虚拟滚动、全文搜索、按会话永久订阅/免打扰。
- 不新增浮层通知面板：复用现有 `#/notifications` 页作为「通知面板」。
- 不在静态归档里制造任何本地通知/叠状态（归档无事件流）。
- 不为「叠」单独实现已读逻辑（完全复用 read-dwell 与 server-read-state 的服务端读态投影 / 三源合并）。

## 与在途 change 的关系（合并顺序）

硬依赖顺序（从先到后）：

1. `report-link-preview`（在途）：`PostCard` 插入点；只影响通知行摘要引用的卡片，不影响
   本 change 的分组逻辑。先合，避免 `PostCard`/`notifications.tsx` 同一区域的重复 rebase。
2. `report-read-dwell`（已归档合入）：删除 `ThreadPage`「进入即已读」
   （`src/ui/pages/ThreadPage.tsx:589-596`）、提供视窗停留已读。本 change 的点击语义与
   「叠自然收缩」依赖它；本 change **不实现**任何已读写入。
3. `report-server-read-state`（已合入/归档中）：读态真值改由服务端 `post_reads` 持有
   （`PostView.read` 首帧、离线队列补写、三源合并）。本 change 只消费 read-dwell 的
   `isRead`/`serverReadIds` 投影，不新增读写路径，也不回退到浏览器本地 read-set 作为真值。
4. `report-thread-scope`（在途/待落）：抽出 `src/ui/lib/thread-plan.ts`（祖先/子树/`scopeOf`）
   并把线程详情收敛为 focal 作用域。本 change 只**扩展**该模块（`highestUnreadAncestor` /
   锚点解析）并共享；它未合入前本 change 的 P1-3/P1-4 不能开工。
5. **本 change**：最后 rebase。冲突面：`NotificationsPage.tsx`、`notifications.tsx`、
   `app.css`、`api.ts`、`store.ts`/`http.ts`（lineage 端点）、`src/core/types.ts`（只加类型）。

若 `report-thread-scope` 最终已提供等价的祖先读取接口（例如线程响应携带完整祖先链），本
change 优先复用并删除 lineage 端点的 P1 任务；否则按 design §4 新增该只读端点。

## 影响面

- 新增（规格落地后）：`src/ui/lib/notification-stacks.ts`（分组纯函数）、
  `test/notification-stacks.test.ts`、`scripts/qa/notification-stacks.mjs`。
- 修改：`src/ui/pages/NotificationsPage.tsx`（叠行渲染/展开/点击锚点/页脚计数）、
  `src/ui/state/notifications.tsx`（lineage 批量补拉与缓存、`unreadTargets` 暴露、
  删除事件更新拓扑）、`src/ui/lib/thread-plan.ts`（由 thread-scope 抽出后扩展）、
  `src/server/store.ts`（`postLineage`）、`src/server/http.ts`（`GET /api/posts/lineage`）、
  `src/ui/lib/api.ts`（客户端方法）、`src/ui/lib/static-api.ts`（静态空实现）、
  `src/core/types.ts`（lineage 行类型）、`src/ui/app.css`（叠层/展开动效令牌与规则）、
  `scripts/qa/notifications-read.mjs`（叠行兼容选择器）。
- 服务端/协议：只加一个**只读**端点；通知事件、history、peek、ack、CLI 全部不变；
  数据库 schema 不变；静态导出不变（静态模式不调用该端点）。

## 验收摘要

A1 同链三帖未读 → 一行叠、未读 3、摘要最新、点击进最早未读（390/1280）；A2 兄弟口径
（共同祖先未读 → 同叠并同屏两分支；共同祖先已读 → 两叠且互不同屏）；A3 未读+已读混叠；
A4 实时新增/合并；A5 删除回退 + 软删独立灰行；A6 跨页拼叠；A7 停留已读联动收缩（390/1280）；
A8 同帖双事件去重；A9 100 通知性能（O(n)、1 次 lineage 批请求、无长任务）；A10 静态/多账号/
与 thread-scope 的一致性契约；A11 全已读叠上下文回看（focal=最靠根已通知帖、全成员首屏可达）。
完整矩阵与判据见 design §12 与 tasks.md。

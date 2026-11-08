# Tasks: report-notification-stacks（通知按会话链叠放）

> **硬依赖顺序（从先到后）**：`report-link-preview` → `report-read-dwell` →
> `report-thread-scope` → **本 change**。
> - `report-read-dwell` 未合入前，叠行点击会临时沿用「进入即已读」；A7 不通过，
>   本 change 的 `markPostRead` 删除项不得提前动。
> - `report-thread-scope` 未合入前，`src/ui/lib/thread-plan.ts` 不存在，P1-3/P1-4 阻塞；
>   **禁止**在本 change 复制 planner 或另建平行模块。
> - 每项判据不满足不得勾选；QA 一律跑隔离后端（`scripts/qa/qa-serve.mjs`），禁止写生产板。
> - 本文件只登记规格；落地时按任务顺序提交。

## P0. 前置确认（依赖就绪检查）

- [ ] P0-1. 确认 `report-thread-scope` 已提供 `src/ui/lib/thread-plan.ts`，导出
  `buildThreadTopology` / `scopeOf` / `ancestorsOf` / `descendantsOf` / `isAncestor`
  （命名可对齐其实现；语义必须是「祖先 + focal + 后代」）。
  - 判据：`rg "export function (buildThreadTopology|scopeOf)" src/ui/lib/thread-plan.ts` 命中；
    `ThreadPage.tsx` 的 planner 已改用该模块。
  - 证据：文件路径 + 导出清单 + `ThreadPage` 引用点 path:line。
- [ ] P0-2. 确认 `report-read-dwell` 已删除 `ThreadPage` 的进入即已读 effect（`:589-596` 附近），
  并存在 `markPostRead` 的 dwell 写入路径。
  - 判据：`rg "markPostRead\\(postId\\)" src/ui` 无路由级残留；read-dwell QA 脚本存在。
  - 证据：read-dwell tasks P1-7 勾选 + 代码检索。
- [ ] P0-3. 若 `report-thread-scope` 已提供等价的祖先读取接口（线程响应携带完整祖先链或
  `/api/…/lineage`），记录其契约并**删除 P1-2 的服务端新增**，只做客户端适配。
  - 判据：design §4 的契约与现有接口字段一一对应；无重复端点。
  - 证据：接口文档/代码 path:line + 本 change design 回填。

## P1. 核心（分组纯函数 + 通知列表叠行 + 点击锚点）

- [ ] P1-1. 扩展 `src/ui/lib/thread-plan.ts`：加 `NotificationRelevance`、
  `resolveStackAnchors(topology, relevance)`、`highestUnreadAncestor(...)`；实现
  `U(p) ?? N(p) ?? p` 的父链记忆化 DP（O(V)），软删节点不参与候选但链路可穿过。
  - 判据：`test/notification-stacks.test.ts` 覆盖：
    ① 单链未读三帖 → 全部 anchor=根；
    ② 兄弟未读（共同祖先已读）→ 各自 anchor=self；
    ③ A 未读/B 已读/C 未读 → 三者 anchor=A；
    ④ 中间软删 → 链路不断、删除节点不当锚；
    ⑤ 拓扑缺失 → anchor=self 且不抛异常；
    ⑥ 100 节点 DP 一次线性通过（计数断言）。
  - 证据：`bun test test/notification-stacks.test.ts` 全绿 + 用例名清单。

- [ ] P1-2. 服务端只读 lineage：`store.postLineage({viewer, ids})` +
  `GET /api/posts/lineage?ids=…`（去重、上限 200、空数组、非法 400、可见性过滤、
  含软删祖先、单条递归 CTE 或分层批量；不写库/不推进游标）+ `ReportClient.postLineage()`
  + `LineageNode`/`LineageResponse` 类型 + `StaticReportClient` 空实现（不发网络）。
  - 判据：`test/lineage.test.ts`：
    ① 8 层链一次返回 9 个节点（含目标自身）；
    ② 不可见 root 的 id 静默省略（不泄露存在性）；
    ③ 重复 id 去重；200 上限；空 ids 返回 `{nodes:[]}`；超限/非法 400；
    ④ 软删祖先返回 `deleted_at` 且 parent 指针不变；
    ⑤ 端点不改变 `unread_count`/`history`/`peek` 响应（回归）。
  - 证据：`bun test test/lineage.test.ts test/notifications.test.ts` + 路由清单。

- [ ] P1-3. 分组纯函数 `src/ui/lib/notification-stacks.ts`：`NotificationMember` 按 target 去重、
  软删剔除、`buildNotificationStacks` 分组/排序/摘要/未读计数；无 target 事件独立成行；
  同一帖多事件只 1 成员（`post.created` 优先为代表）。
  - 判据：`test/notification-stacks.test.ts` 覆盖：
    ① 同链 3 成员 → 1 叠、size 3、unread 3、newestUnread=最新；
    ② 同帖 `post.created`+`thread.invited` → 1 成员、unread 1；
    ③ 软删最新未读 → 摘要回退次新、unread−1；
    ④ 软删帖不进成员、`standalone` 保留（供独立灰行）；
    ⑤ 无 target 事件 → 独立行；⑥ 叠按最新 seq 排序；
    ⑦ 共同祖先未读的兄弟 → 同叠（key=A）；共同祖先已读的兄弟 → 两叠；
    ⑧ 全已读叠 anchor=`N`（最靠根已通知帖）且 scope 覆盖全部分支。
  - 证据：`bun test test/notification-stacks.test.ts` 全绿。

- [ ] P1-4. 契约测试（design §11.3）：在合成树上断言「同叠 ⇔ 从最早未读打开的 timeline
  包含叠内全部**未读**成员」，并与 `buildTimelinePlan(scopeOf(anchor))` 交叉验证
  （每个未读成员出现在 post 行或 subthread 入口；不出现兄弟分支行）。
  - 判据：契约 1–6 全部断言；夹具包含：**共同未读祖先的兄弟（必须同叠）**、
    **共同祖先已读的兄弟（必须分叠）**、8 层深链、中间软删、缺父、全已读叠
    （`N` 锚点覆盖全部分支）。禁止实现成「兄弟永不同叠」。
  - 证据：`bun test test/notification-stacks.test.ts -t "contract"` 输出。

- [ ] P1-5. Provider 接入：`notifications.tsx` 增加
  `unreadTargets: ReadonlySet<string>`（`serverTargets ∪ localTargets − readIds`）、
  `notifiedTargets`（已加载事件 target ∪ unreadTargets）、`lineageOf(id)`、
  `ensureLineage(ids)`（150ms 合并、批内去重、失败降级）、`markLineageDeleted(postId)`；
  `post.deleted` 事件同步更新 lineage；账号/后端切换清空 lineage。
  - 判据：`test/notification-projection.test.ts` 相邻新增用例：
    ① 100 个目标一次 `ensureLineage` 只发 1 个请求（mock client 计数）；
    ② 已在缓存的目标不再请求；③ 账号切换后 `lineageOf` 为空且重新请求；
    ④ `post.deleted` 后节点 `deleted_at != null`；⑤ 静态模式 0 请求。
  - 证据：`bun test test/notification-projection.test.ts test/notification-stacks.test.ts`。

- [ ] P1-6. 通知页叠行：`NotificationsPage.tsx` 把 `visible.map(renderRow)` 改为
  `renderStack`；`size===1 && unreadCount<=1` 走现有行 DOM（D8，保 `notification-row`/
  `data-post-id`/`data-read`/`data-seq`/`data-event-count`）；`size≥2` 渲染层叠前卡 +
  `notification-stack` 容器 + 未读徽标 + 摘要（最新未读）+ 展开按钮/成员列表；
  `data-stack-key/size/unread/anchor-loaded`；页脚「还有 N 条未读」改按 target 计。
  - 判据：A1/A3/A8 的 DOM 断言通过；390 无横向滚动；展开/收起可键盘操作；
    单成员行 DOM 与改造前逐属性一致（快照对比）；软删行渲染 `notification-deleted-row`
    灰行、不可点/不可展开、无 `data-stack-key`/未读徽标。
  - 证据：`scripts/qa/notification-stacks.mjs` 的 A1/A3/A8 + 单成员快照 diff。

- [ ] P1-7. 点击锚点：叠行点击 `markSharedSubject(row, anchorId)` +
  `navigate('/p/'+anchorId)`；**删除**叠行/成员行的 `markPostRead` 调用（D11）；
  focal=最早未读，全已读=锚点；成员行点击导航该成员；嵌套 `a,button` 不触发叠导航。
  - 判据：A1 点击后 `location.hash` 为 `/p/<anchor>`（不是最新成员）；A7 依赖 read-dwell：
    停留后 read-set 变化、叠收缩；点击本身 0 次 `markPostRead`（mock 计数）；
    A11 全已读叠点击 focal=最靠根已通知帖且 `scopeOf(focal)` 覆盖叠内全部成员
    （首屏可达、无「跳最新」入口）；软删灰行点击/Enter 无导航。
  - 证据：QA A1/A7 + `markPostRead` 调用计数。

- [ ] P1-8. 分页与历史：确认 `history ∪ live` 合并后分组；「加载更早」只增成员不重复；
  锚点行未加载时 `anchor-loaded=0` 且点击仍去锚点；页脚 remainder 不重复计数。
  - 判据：A6 跨页用例：>50 条历史、叠跨两页；加载后仍一行、成员数增长、无重复
    `data-post-id`；remainder 公式断言。
  - 证据：`scripts/qa/notification-stacks.mjs` A6 + 网络/DOM 数据。

- [ ] P1-9. 兼容与回归：更新 `scripts/qa/notifications-read.mjs`（单成员叠保持原选择器；
  若种子进入多成员叠，按 `data-member-ids` 定位）；跑既有通知/事件/线程测试。
  - 判据：`bun scripts/qa/notifications-read.mjs` 全绿；`bun test test/notifications.test.ts
    test/event-hub.test.ts test/event-hub-client.test.ts` 全绿；无 console error。
  - 证据：脚本输出 + 测试汇总。

- [ ] P1-10. 静态/多账号边界：`staticMode` 不渲染叠、不请求 lineage、空态；账号 A/B
  read-set 与 lineage 隔离；切回 A 不丢已读。
  - 判据：A10 断言（`__reportNotificationStacks.enabled=false`、0 请求、空态）；
    切换账号后 `lineageOf` 清空、read-set key 不同。
  - 证据：QA A10 + localStorage 键值快照。

## P2. 实时增量、折叠动画、诊断

- [ ] P2-1. 实时增量：`notification.created` 到达 → live 合并 + `ensureLineage([target])` +
  纯函数重算；区分 `grow/new/reanchor/merge`；不重新拉 history；重复 seq noop；
  `post.deleted` → fallback/dissolve；`cursor.acked` → read-stack。
  - 判据：A4/A5 断言：新回复 unread+1、摘要更新；新祖先通知使两叠合并为一行、
    `data-stack-transition="merge"`；删除最新未读摘要回退；无 history 请求（网络计数）。
  - 证据：QA A4/A5 + `recomputes`/`lineageRequests` 诊断。

- [ ] P2-2. 折叠动画：展开/收起用 `grid-template-rows: 0fr ↔ 1fr`（180ms
  `var(--ios-ease-out)`）；`prefers-reduced-motion` 瞬时；展开不改变前卡高度、不引发滚动跳变；
  reanchor/merge 的行用 180ms 背景高亮过渡（`data-stack-transition`）。
  - 判据：展开前后前卡 `getBoundingClientRect()` 不变；reduced-motion 下
    `transition-duration: 0s`；键盘焦点在展开后保持在按钮/首个成员；390/1280 无 CLS。
  - 证据：QA 动效用例 + computed style + 两帧截图。

- [ ] P2-3. 诊断：`window.__reportNotificationStacks = { enabled, stacks, members,
  unreadTargets, lineageNodes, lineageRequests, lineageFailures, lastGroupMs, recomputes,
  merges, splits }`（只读快照，不参与业务）；生产构建无 console 噪音。
  - 判据：A9 可读 `lastGroupMs`/`lineageRequests`/`recomputes`；静态模式 `enabled=false`；
    数值与 DOM 计数一致（stacks=DOM 叠行数，members=展开成员总数）。
  - 证据：QA A9 + 生产构建 smoke。

- [ ] P2-4. 100 通知性能审计：10 root/100 通知/8 层深链夹具；长任务与重算预算；
  两视口 390/1280。
  - 判据：`lastGroupMs<50`；`lineageRequests ≤1/合并批`；无 >50ms longtask（归因分组）；
    滚动/展开 `recomputes` 不增；内存不随展开线性增长（topology 复用）。
  - 证据：`scripts/qa/notification-stacks.mjs` A9 的 performance JSON + longtask 列表。

- [ ] P2-5. 视觉与无障碍打磨：多作者 `AvatarGroup`（≤3 + count）；390 行内挤压审计；
  读屏 `aria-label="{N} 条未读"`；展开按钮 `aria-expanded/aria-controls`；空态/错误态；
  软删独立灰行与叠的视觉层级（Owner 定案：保留灰行、不可点/不可展开）。
  - 判据：390/1280 截图对比；axe/可访问性清单无新增 critical；键盘全路径可完成
    「打开叠 → 展开 → 打开成员」。
  - 证据：截图 before/after（按项目审计纪律）+ 可访问性检查表。

## P3. 收口

- [ ] P3-1. 回填实测数字（A1–A11）、回填 Owner 定案（Q1 软删独立灰行 / Q2 全已读上下文回看）、
  `npx openspec validate report-notification-stacks --strict` 通过、归档 change。
  - 判据：validate PASS（长文本 warning 可接受）；archive 就位；QA `results.json`/
    截图随报告留存。
  - 证据：validate 输出 + QA 结果 + 归档路径。

# Tasks: report-notification-stacks（通知按会话链叠放）

> **硬依赖顺序（从先到后）**：`report-link-preview` → `report-read-dwell` →
> `report-thread-scope` → **本 change**。
> - `report-read-dwell` 已合入；本 change 的 `markPostRead` 删除项已落地（D11）。
> - `report-thread-scope` 已合入：`src/ui/lib/thread-plan.ts` 存在（导出 `buildTimelinePlan` /
>   `planForThreadView` / `countAddedInScope`），本 change 在其上**扩展**拓扑/锚点纯函数，
>   未另建平行 planner。
> - 每项判据已实测；QA 一律跑隔离后端（`scripts/qa/qa-serve.mjs`），生产板 13689 零写入。
> - 实测汇总：`bun test` 487 pass / 0 fail（50 files / 10673 expect）；`bun run check` 通过；
>   `typecheck` + `typecheck:ui` 通过；`bun run build` 通过；
>   `scripts/qa/notifications-read.mjs` 16/16；`scripts/qa/notification-stacks.mjs` **65/65**
>   （A1–A11 全绿 + before/after 审计 + 覆盖表）。报告：
>   `.agents/reports/manager/report-notification-stacks/report.html`（results.json/steps.json/23 PNG）。

## P0. 前置确认（依赖就绪检查）

- [x] P0-1. 确认 `report-thread-scope` 已提供 `src/ui/lib/thread-plan.ts`，导出
  `buildThreadTopology` / `scopeOf` / `ancestorsOf` / `descendantsOf` / `isAncestor`
  （命名可对齐其实现；语义必须是「祖先 + focal + 后代」）。
  - 判据：`rg "export function (buildThreadTopology|scopeOf)" src/ui/lib/thread-plan.ts` 命中；
    `ThreadPage.tsx` 的 planner 已改用该模块。
  - 证据：`thread-plan.ts` 既有 `buildTimelinePlan`/`planForThreadView`/`countAddedInScope`
    （「祖先 + focal + 后代」语义已收敛，path:src/ui/lib/thread-plan.ts:136,256,311），
    `ThreadPage.tsx:42` 从 `@/lib/thread-plan` 导入；本 change 在同一模块**追加**
    `ThreadTopology`/`buildThreadTopology`/`scopeOf`/`resolveStackAnchors`/
    `highestUnreadAncestor`（thread-plan.ts 末尾段，全 change 无第二套祖先实现）。
- [x] P0-2. 确认 `report-read-dwell` 已删除 `ThreadPage` 的进入即已读 effect，并存在
  `markPostRead` 的 dwell 写入路径。
  - 判据：`rg "markPostRead\\(postId\\)" src/ui` 无路由级残留；read-dwell QA 脚本存在。
  - 证据：`rg "markPostRead" src/ui/pages/ThreadPage.tsx` 无命中（route 级已删）；
    `src/ui/state/read-dwell.ts` + `scripts/qa/read-dwell.mjs` 存在；
    `scripts/qa/notification-stacks.mjs` A1「点击本身 0 次 markPostRead（+250ms 采样）」PASS、
    A7「读由 dwell 触发」PASS（`__reportReadDwell.marks` 与 read-set 新增一致）。
- [x] P0-3. 若 `report-thread-scope` 已提供等价的祖先读取接口（线程响应携带完整祖先链或
  `/api/…/lineage`），记录其契约并**删除 P1-2 的服务端新增**，只做客户端适配。
  - 判据：design §4 的契约与现有接口字段一一对应；无重复端点。
  - 决策（实测核对）：`GET /api/thread/:id` 确实携带 focal 全祖先链（`assembleThread` 的
    mustEmit 把 focal 祖先链与子树全量发射），但它是**root 级全量水合**（正文/媒体/引用/
    预览，单 root 数百 KB 级）且**按 root 逐请求**——10 个 root 的通知页需要 10 次请求且响应
    含大量无关行，不满足 design §4「一张通知页 1 次批量、100 通知 O(n)」的判据。
    → **保留** design §4 的 lineage 端点（无等价替代），P1-2 按设计落地。

## P1. 核心（分组纯函数 + 通知列表叠行 + 点击锚点）

- [x] P1-1. 扩展 `src/ui/lib/thread-plan.ts`：加 `NotificationRelevance`、
  `resolveStackAnchors(topology, relevance)`、`highestUnreadAncestor(...)`；实现
  `U(p) ?? N(p) ?? p` 的父链记忆化 DP（O(V)），软删节点不参与候选但链路可穿过。
  - 判据：`test/notification-stacks.test.ts` 覆盖 ①–⑥。
  - 证据：`bun test test/notification-stacks.test.ts` → 29 pass / 0 fail；用例：
    ① 单链未读三帖 → 全部 anchor=根；② 兄弟未读（共同祖先已读）→ 各自 anchor=self；
    ③ A 未读/B 已读/C 未读 → 三者 anchor=A；④ 中间软删：链路不断、删除节点不当锚（含
    `isDeleted` 兜底 ④b）；⑤ 拓扑缺失 → anchor=self 且不抛异常；⑥ 100 节点链计数断言
    `unreadCalls ≤ 100 && notifiedCalls ≤ 100`（一次线性 DP）。
  - 实现注记（design §15 D14）：锚点取「最靠根」未读（父结果优先），而非 design §3.2 伪码
    字面迭代所得「最深」未读；③ 与 A1 判据（三帖未读同叠、focal=最早未读）据此通过。

- [x] P1-2. 服务端只读 lineage：`store.postLineage({viewer, ids})` +
  `GET /api/posts/lineage?ids=…`（去重、上限 200、空数组、非法 400、可见性过滤、
  含软删祖先、分层批量；不写库/不推进游标）+ `ReportClient.postLineage()`
  + `LineageNode`/`LineageResponse` 类型 + `StaticReportClient` 空实现（不发网络）。
  - 判据：`test/lineage.test.ts` ①–⑤。
  - 证据：`bun test test/lineage.test.ts` → 11 pass / 0 fail：① 8 层链一次返回 9 节点
    （输入序优先、parent 指针保持）；② 不可见 root 静默省略（store + HTTP 两层）；
    ③ 去重/空集/不存在 id 静默、201 个 → 400、恰 200 → 200；④ 软删祖先返回
    `deleted_at` 且 parent 不变；⑤ 80 目标/4 层 → 「FROM posts」查询 ≤6 次（分层批量，
    逐 id 会是 80 次）；回归：lineage 前后 `peek/unread_count/unread_by_target/history/
    cursor/events/maxSeq` 完全一致。路由清单：`src/core/protocol.ts` API_ROUTES 新增
    `GET /api/posts/lineage`（check.mjs「api routes — 50 routes wired」通过）。

- [x] P1-3. 分组纯函数 `src/ui/lib/notification-stacks.ts`：`NotificationMember` 按 target 去重、
  软删剔除、`buildNotificationStacks` 分组/排序/摘要/未读计数；无 target 事件独立成行；
  同一帖多事件只 1 成员（`post.created` 优先为代表）。
  - 判据：`test/notification-stacks.test.ts` ①–⑧ 全绿。
  - 证据：① 同链 3 成员 → 1 叠 size 3 / unread 3 / newestUnread=最新；② 同帖
    `post.created`+`thread.invited` → 1 成员、eventCount 2、unread 1；③ 软删最新未读 →
    成员剔除（standalone 保留）、摘要回退次新、unread−1；④ 软删帖不进成员/锚点；
    ⑤ 无 target 事件 → 独立行；⑥ 叠按最新 seq 排序、成员 seq 降序（双链夹具）；
    ⑦ 共同祖先未读的兄弟 → 同叠（key=A）；共同祖先已读的兄弟 → 两叠；⑧ 全已读叠
    anchor=`N` 且 `scopeOf(N)` 覆盖全部分支。

- [x] P1-4. 契约测试（design §11.3）：在合成树上断言「同叠 ⇔ 从最早未读打开的 timeline
  包含叠内全部**未读**成员」，并与 `buildTimelinePlan(scopeOf(anchor))` 交叉验证。
  - 判据：契约 1–6 全部断言；夹具包含共同未读祖先的兄弟（必须同叠）、共同祖先已读的兄弟
    （必须分叠）、8 层深链、中间软删、缺父、全已读叠（`N` 覆盖全部分支）；禁止「兄弟永不同叠」。
  - 证据：`bun test test/notification-stacks.test.ts -t contract` →
    「契约 1+2 / 3a / 3b / 3c(8 层深链) / 3d(中间软删) / 3e(缺父) / 4(planner 交叉验证:
    每个未读成员出现在 plan.rows、focal=最早未读) / 4b(点 B 的 plan 不含 D) / 5(N 锚点
    覆盖全部分支 + 无「跳最新」入口) / 6」共 10 项全绿；E2E 侧 A2 双向（两叠 vs 同叠）PASS。

- [x] P1-5. Provider 接入：`notifications.tsx` 增加 `unreadTargets`、`notifiedTargets`、
  `lineageOf(id)`、`ensureLineage(ids)`（150ms 合并、批内去重、失败降级）、
  `markLineageDeleted(postId)`；`post.deleted` 事件同步更新 lineage；账号/后端切换清空 lineage。
  - 判据：`test/notification-projection.test.ts` 相邻新增用例 ①–⑤。
  - 证据：`test/notification-projection.test.ts` → 21 pass / 0 fail：① 100 目标一次 ensure
    只发 1 个请求（批内 100 id）；①b 多次 ensure 合并 1 批且重复 id 只请求一次；② 已缓存
    目标不再请求（第二批只发未缓存 id）；失败不抛、failures 计数、下次 ensure 重试成功；
    ③ `clear()` 后缓存清空且**在途响应被丢弃**（不串号），新账号重新请求；④ `markDeleted`
    就地置 `deleted_at`、parent 不变、重复调用 no-op、未知节点 no-op；⑤ 静态模式
    （client() 为 null）0 请求；另加分片用例：250 目标 → 2 片（200+50）全入缓存。
    E2E：A9「337 个 unread target → 初次加载 lineageRequests=2（200+137 分片）」；
    A10「账号切换后 lineageNodes 重建」PASS。

- [x] P1-6. 通知页叠行：`visible.map(renderRow)` → `renderStack`；`size===1 && unreadCount<=1`
  走现有行 DOM（D8）；`size≥2` 渲染层叠前卡 + `notification-stack` + 未读徽标 + 摘要 +
  展开按钮/成员列表；`data-stack-key/size/unread/anchor-loaded`；页脚按 target 计。
  - 判据：A1/A3/A8 DOM 断言通过；390 无横向滚动；展开/收起可键盘操作；单成员行 DOM 与
    改造前逐属性一致（快照对比）；软删行渲染 `notification-deleted-row` 灰行、不可点/不可展开、
    无 `data-stack-key`/未读徽标。
  - 证据：A1（一行叠 key/size=3/unread=3、徽标 `3|3 条未读`、摘要来自最新未读 C、展开
    3 成员、前卡 top/height 不变 109/123、`aria-expanded/aria-controls` 契约、键盘 Enter 展开 +
    Tab 落成员行）；A3（unread=2/size=3、B 成员 data-read=1）；A8（1 成员 /
    `data-event-count=2` / 唯一 `data-post-id`）；A5（灰行 role/tabindex 为空、无 toggle、
    无未读徽标、无 `data-stack-key`/`data-post-id`）；A1 390 与 A9 390
    `scrollWidth<=clientWidth`。单成员行 DOM 兼容由 `scripts/qa/notifications-read.mjs`
    16/16 回归覆盖（同帖行 data-post-id/data-read/data-seq/data-event-count 语义不变）。

- [x] P1-7. 点击锚点：叠行点击 `markSharedSubject(row, anchorId)` + `navigate('/p/'+anchorId)`；
  **删除**叠行/成员行的 `markPostRead`（D11）；focal=最早未读，全已读=锚点；成员行点击导航
  该成员；嵌套 `a,button` 不触发叠导航。
  - 判据：A1 点击后 hash 为 `/p/<anchor>`（不是最新成员）；A7 停留后 read-set 变化、叠收缩；
    点击本身 0 次 `markPostRead`；A11 focal=最靠根已通知帖且 `scopeOf(focal)` 覆盖全部成员；
    软删灰行点击/Enter 无导航。
  - 证据：A1「点击进 #/p/<最早未读 R>」PASS；A1「点击本身 0 次 markPostRead（+250ms 采样
    read-set 无新增，早于 dwell 阈值 400ms）」PASS；A1/A7 dwell 读掉后 read-set 新增 ⊆
    timeline 行；A7 split（锚点下移）与 read-stack（unread=0）PASS；A11 hash=`#/p/<anchor>`、
    scope 覆盖 R/X/Y、`[data-testid*="latest"]` 计数 0；A5 灰行点击/Enter 无导航 PASS。

- [x] P1-8. 分页与历史：`history ∪ live` 合并后分组；「加载更早」只增成员不重复；锚点行未
  加载时 `anchor-loaded=0` 且点击仍去锚点；页脚 remainder 不重复计数。
  - 判据：A6 跨页用例：>50 条历史、叠跨两页；加载后仍一行、成员数增长、无重复 `data-post-id`；
    remainder 公式断言。
  - 证据：A6（夹具 150 前置填充 + X1 + 70 后置填充 + X2，避开设计窗口）：加载前
    `size=1 / anchor-loaded=0 / stack-key=stack:<X1>`（X2 行）；点「加载更早」后
    `size=2 / anchor-loaded=1 / memberIds=[X2,X1] / duplicateIds=false`；页脚
    `还差 = 角标(243) − 已加载未读 target(243) = 0`，页脚节点缺失与公式一致。

- [x] P1-9. 兼容与回归：更新 `scripts/qa/notifications-read.mjs`（单成员叠保持原选择器；
  若种子进入多成员叠，按 `data-member-ids`/`data-unread-member-ids` 定位）。
  - 判据：`bun scripts/qa/notifications-read.mjs` 全绿；`bun test test/notifications.test.ts
    test/event-hub.test.ts test/event-hub-client.test.ts` 全绿；无 console error。
  - 证据：`scripts/qa/notifications-read.mjs` → 16/16 PASS（含「点通知进入详情」「返回后
    角标 -1」「该行标为已读」；实现补丁：未读集合读单成员行 + 叠 `data-unread-member-ids`、
    叠内成员先展开再点、点击后等 dwell 读掉再返回）；`bun test` 全量 487 pass / 0 fail（含
    通知/事件/线程套件）；A1–A11 各用例「no page error」PASS。

- [x] P1-10. 静态/多账号边界：`staticMode` 不渲染叠、不请求 lineage、空态；账号 A/B
  read-set 与 lineage 隔离；切回 A 不丢已读。
  - 判据：A10 断言（`__reportNotificationStacks.enabled=false`、0 请求、空态）；切换账号后
    `lineageOf` 清空、read-set key 不同。
  - 证据：A10「静态归档：enabled=false、stacks/rows=0、empty≥1、0 lineage 请求」PASS；
    「账号切换：`report.read.v1:<base>:owner` ↔ `:manager` 各自分区、owner 键值字节不变
    （不被 manager 会话改写）、manager 键独立建立、两侧 lineageNodes≥1」PASS；
    「owner 已读不影响 manager 未读态」PASS；「切回 owner：该帖 data-read=1、read-set 键回
    owner」PASS。

## P2. 实时增量、折叠动画、诊断

- [x] P2-1. 实时增量：`notification.created` → live 合并 + `ensureLineage([target])` +
  纯函数重算；区分 `grow/new/reanchor/merge`；不重新拉 history；重复 seq noop；
  `post.deleted` → fallback/dissolve；`cursor.acked` → read-stack。
  - 判据：A4/A5 断言：新回复 unread+1、摘要更新；新祖先通知使两叠合并为一行、
    `data-stack-transition="merge"`；删除最新未读摘要回退；无 history 请求（网络计数）。
  - 证据：A4（lineage 首批 route abort → provisional 自锚 3 行 + `lineageFailed=1`；
    推送 E1 → size/unread 4、摘要更新、`transition=merge`（provisional→settled 合并）、
    `history` 请求数 1 → 1；推送 E2 → 一行 5 成员、`merges=9≥1`、仍 0 次 history 重拉、
    no page error）；A5（最新未读被删 → size/unread 2、摘要回退 M；单帖叠删空 → 叠行消失 +
    独立灰行；角标 −2）；`diffNotificationStacks` 单测覆盖 grow/new/merge/reanchor/splits。

- [x] P2-2. 折叠动画：展开/收起用 `grid-template-rows: 0fr ↔ 1fr`（180ms
  `var(--ios-ease-out)`）；`prefers-reduced-motion` 瞬时；展开不改变前卡高度、不引发滚动跳变；
  reanchor/merge 的行用 180ms 背景高亮过渡（`data-stack-transition`）。
  - 判据：展开前后前卡 `getBoundingClientRect()` 不变；reduced-motion 下
    `transition-duration: 0s`；键盘焦点在展开后保持在按钮/首个成员；390/1280 无 CLS。
  - 证据：A1「展开动效契约：computed transitionDuration=0.18s」PASS；「`prefers-reduced-motion:
    reduce` → 0s」PASS（`page.emulateMedia` 实测）；「展开不改前卡高度（top/height 不变
    109/123）」PASS；「键盘 Enter 展开 → Tab 落到首个成员行」PASS；
    `.notification-stack-flash`（180ms 主题令牌高亮）随 `data-stack-transition` 施加（A4
    观察 `transition=merge`）。

- [x] P2-3. 诊断：`window.__reportNotificationStacks = { enabled, stacks, members,
  unreadTargets, lineageNodes, lineageRequests, lineageFailures, lastGroupMs, recomputes,
  merges, splits }`（+ standalones，只读快照）；生产构建无 console 噪音。
  - 判据：A9 可读 `lastGroupMs`/`lineageRequests`/`recomputes`；静态模式 `enabled=false`；
    数值与 DOM 计数一致（stacks=DOM 叠行数 + 单成员行数，members=Σ data-stack-size）。
  - 证据：A1/A9「诊断数值与 DOM 计数一致」PASS（A9：stacks 80 = 16 叠 + 64 行、members 141）；
    A10 静态 `enabled=false` PASS；A1–A11 各用例 console error 过滤后为 0。

- [x] P2-4. 100 通知性能审计：10 root/100 通知/8 层深链夹具；长任务与重算预算；两视口。
  - 判据：`lastGroupMs<50`；`lineageRequests ≤1/合并批`；无 >50ms longtask（归因分组）；
    滚动/展开 `recomputes` 不增；内存不随展开线性增长（topology 复用）。
  - 证据：A9（10 root × 9 帖含 8 层深链 + 板内既有夹具）：`lastGroupMs=0.7`（含 337 目标/
    354 lineage 节点/141 成员）；初次加载 `lineageRequests=2`（200+137 分片，即 ≤1 批/200 片）；
    实时一批 4 帖 → `burstLineage=1`；`recomputes` 滚动/展开前后 5→5、resize 8→8；
    增量窗口 longtask 列表 `[]`（无 >50ms）；390 `scrollWidth<=clientWidth`。

- [x] P2-5. 视觉与无障碍打磨：多作者 `AvatarGroup`（≤3 + count）；390 行内挤压审计；
  读屏 `aria-label="{N} 条未读"`；展开按钮 `aria-expanded/aria-controls`；空态/错误态；
  软删独立灰行与叠的视觉层级。
  - 判据：390/1280 截图对比；axe/可访问性清单无新增 critical；键盘全路径可完成
    「打开叠 → 展开 → 打开成员」。
  - 证据：A1「徽标 `3|3 条未读`（aria-label）」PASS；`aria-expanded/aria-controls` 契约
    PASS；键盘路径 PASS；A1/A9/A6 390 无横滚 PASS；before/after 成对截图
    `audit-before-390-{list,unread}.png` ↔ `audit-after-390-{list,unread}.png`、
    `audit-before-1280-list.png` ↔ `audit-after-1280-list.png`（1280: 14 平铺行 → 4 叠 + 2 行）；
    多作者 `AvatarGroup` 仅在与 `AuthorAvatar` 同源（`components/ui/avatar.tsx` 官方件）时使用，
    单作者保持原头像；软删灰行不透明度 0.6、无徽标/无展开（A5）。

## P3. 收口

- [x] P3-1. 回填实测数字（A1–A11）、回填 Owner 定案（Q1 软删独立灰行 / Q2 全已读上下文回看）、
  `npx openspec validate report-notification-stacks --strict` 通过、归档 change。
  - 判据：validate PASS（长文本 warning 可接受）；archive 就位；QA `results.json`/
    截图随报告留存。
  - 证据：本文件实测数字 + Owner Q1/Q2 落点（A5 灰行不可点/不可展开；A11 focal=最靠根
    已通知帖、scope 覆盖全部成员、无「跳最新」）；`openspec validate --strict` 输出；
    归档路径 `openspec/changes/archive/2026-11-09-report-notification-stacks/`；
    报告 `.agents/reports/manager/report-notification-stacks/`（report.html + results.json +
    steps.json + 23 PNG，公网 `https://local-gaubee-report-notification-stacks.fde2e.com/`）。

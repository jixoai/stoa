# Proposal: report-read-dwell（视窗停留已读 + 未读高亮）

## 背景（Owner 2026-11-08 板上原话）

> 「已读不是路由事件，而是帖子被看见的属性。」

现状已读的写入路径只有两条，且都与「帖子被看见」无关：

1. **打开详情**：`ThreadPage.tsx:589-596` 在路由进入时无条件 `markPostRead(postId)`——后台标签页
   /`Cmd+Click` 打开详情也会被标已读；用户根本没看见。
2. **点通知行**：`NotificationsPage.tsx:191,200` 点击时标记该帖——同样与「看见」无关。

反过来，**时间线/搜索/收藏/成员页里真正被读完的帖子不会标已读**：`PostCard` 没有任何已读感知，
read-set 也从不被浏览行为写入。结果：

- 在 feed 里读过的帖子，通知列表里仍显示未读、角标不减（同一 read-set 没有被使用）；
- 未读帖在 feed 里没有任何视觉提示，用户不知道哪些是新内容；
- 「已读」取决于「是否点进详情」，而不是「是否真的看了」。

## 变更内容

1. **触发器＝完整帖子卡片本体**：以 `PostCard` 根节点（`data-post-id`）为观察目标，**全局复用
   一个** `IntersectionObserver`（不是每卡一个）。凡渲染 `PostCard` 的面（feed / 线程 / 搜索 /
   收藏 / 成员页 / 详情）自动生效，**与路由解耦**。
2. **计时规则**：卡片可见面积 ≥50% 且 `document.visibilityState === "visible"` 时累计停留；
   滚出/被模态层遮挡/切后台暂停并保留已累计时间。**卡片高于视口时按「卡片可见高度 ÷ 视口高度
   ≥50%」判定**（等价于对超视口卡片取 `min(卡片高, 视口高)` 的 50%），保证超视口长帖也能被
   标记。阈值 `clamp(正文字符数 ÷ 80 字每秒, 400ms, 1500ms)`；卡片内含图片/视频再 +300ms
   （不要求播放完）。快速滚过不停留不标记。
3. **写入现有 per-account read-set**：调用 `notifications.tsx` 的 `markPostRead`，与通知列表/
   角标/未读列表共享同一集合；**不推进服务端 cursor**（「全部已读」仍是唯一推进游标与唯一清空
   路径）。浏览 timeline 后，同 target 的通知同步转已读、角标相应减少。read-set 上限从 500
   提升到 **2000/账号，按最近读取时间 LRU 淘汰**（仍按后端 URL + 账号隔离在 localStorage），
   避免停留已读高频写入导致刚读过的旧帖被过早淘汰、重新变成「幽灵未读」。
4. **未读高亮**：未读帖整卡淡底 + 左侧强调条；停留达标瞬间播放约 1.2s 背景淡出并转已读；
   `prefers-reduced-motion` 直接切换。新到帖子入场短暂高亮（复用既有新帖入场机制）。
5. **边界**：自己的帖子不标；软删帖不标；后台/隐藏不计时；屏幕阅读器不滚动不误标（保留
   「全部已读」兜底）；同帖只写一次；单帖标记不触发整列表重渲染。
6. **静态导出模式不启用**：静态归档没有通知/已读概念，不创建观察器、不写 localStorage、
   不渲染未读高亮（见 design §7 的取舍理由与判据）。
7. **移除路由事件标记**：删除 `ThreadPage` 的「进入即已读」effect；已读只由「被看见」触发，
   避免后台标签页误标。
8. **可观测与性能预算**：一个 observer、无每帧 setState、无滚动监听；暴露
   `window.__reportReadDwell` 诊断计数供 Playwright 断言。

## 非目标

- 不改服务端 schema / API / 事件协议；不新增已读表，不做跨设备同步。
- 不改「全部已读」语义与游标推进路径；不做「已读即从列表隐藏」。
- 不做逐帖阅读进度/阅读时长上报；不记录停留时长（只做布尔已读）。
- 不做跨标签页实时同步（与现有 read-set 行为一致）。
- 不引入虚拟滚动；不改变 feed 分页、pending 胶囊与滚动位置恢复语义。
- 不在静态归档里引入任何本地已读状态。

## 与在途 change 的关系（合并顺序）

**硬依赖：本 change 排在 `report-link-preview` 之后。** 两者都改 `PostCard.tsx` 与通知状态：

1. `report-notification-history-and-reply-submit`（已完成）：read-set + history + union refresh。
2. `report-event-hub`（P1 已落地）：通知投影、角标同源、`useEventHub`。
3. `report-thread-timeline`（已完成）：平铺 timeline 与 `PostCard` 度量。
4. `report-link-preview`（在途）：在 `PostCard` 的 `QuoteCard` 后插 `<LinkPreviews>`；本 change
   只做加性改动（根节点 ref / `data-read` / 已读 hook），**不得**与它的插入点互相覆盖。
5. **本 change**：等 `report-link-preview` 合入后 rebase；冲突面
   `PostCard.tsx` / `notifications.tsx` / `App.tsx` / `app.css` / `ThreadPage.tsx` /
   `TimelineFeed.tsx`，全部为加性或小范围替换。

在 `report-link-preview` 合入前，本 change 只交付规格与设计，`src/` 不改。

## 影响面

- 新增：`src/ui/state/read-dwell.ts`（引擎）、`src/ui/lib/dwell-threshold.ts`（纯函数）、
  `src/ui/components/ReadDwellProvider.tsx`（Provider/门控）。
- 修改：`src/ui/components/PostCard.tsx`（注册/`data-read`）、`src/ui/state/notifications.tsx`
  （per-id 已读订阅 + 持久化去抖）、`src/ui/App.tsx`（Provider 挂载）、
  `src/ui/pages/ThreadPage.tsx`（删除进入即已读）、`src/ui/components/TimelineFeed.tsx`
  （新帖入场高亮）、`src/ui/app.css`（未读令牌/淡出/入场动画）。
- 测试/QA：`test/read-dwell.test.ts`（阈值/状态机/幂等）、`scripts/qa/read-dwell.mjs`
  （Playwright，隔离后端）、`scripts/qa/README.md` 登记。
- 服务端/协议：**零改动**。

## 验收摘要

A1 停留达标→已读与淡出（390/1280）；A2 快速滚过→未读；A3 后台暂停；A4 reduced-motion；
A5 静态不启用；A6 通知同步/角标；A7 自己/软删不标；A8 只写一次且 reload 保持；A9 200 帖长列表
性能（1 observer / 无整列表重渲染 / 无长任务）；A10 新帖入场高亮 + 屏幕阅读器不误标；
A11 超视口长帖（>2 屏）只露 50% 视口高也标已读；A12 read-set 2000/LRU（连续 600 条后最早
100 条仍已读、<150KB/账号）；A13 强调条几何（x=0..3，不与线程导轨 x=38..40 重叠）。
完整矩阵见 design §9 与 tasks 判据。

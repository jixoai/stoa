# Proposal: report-notification-history-and-reply-submit

## 背景

Owner 2026-11-07 在板上提两条，另有对抗审查（评分 6/10）的 3 个阻塞必须同批修复：

1. **通知列表要像主页一样始终可见**（对齐 X）：已读通知不该消失，未读只是**高亮**。
   现状 `GET /api/notifications?peek=1` 只投递游标之后的未读事件；网页端「全部」筛选只保留
   本次会话内存里的行，刷新/重载即丢，历史读过的通知完全看不到。
2. **回复按钮位置错误**：`ReplyComposer` 把「回复」提交按钮放在 topbar 右上，发帖箱却在
   `InputGroup` 的 block-end addon 里；两条输入路径形态不一致。
3. **审查阻塞 B1**：上一版「打开详情即已读」直接推进服务端全局游标（只增不减），点开较新的
   一条会把更旧的、没看过的帖子也永久标已读（N≥2 时角标 2→0，规格 Scenario 失败）；同帖多条
   事件也会一次清掉多行。
4. **审查阻塞 B2**：`refresh` 用 peek 快照整体替换内存行并丢弃已读行，刷新/切 tab/reload 后
   历史行消失。
5. **审查阻塞 B3**：390×844 下通知页标题被 `PageHeader actions` 里的筛选 Tabs 压住。

## 变更内容

1. **通知历史接口（不改 schema）**：新增 `GET /api/notifications/history?limit=50&before=<seq>`，
   返回该账号可见的最近通知事件（倒序，`read` 标记 = seq ≤ 该账号游标），带 `cursor` 与下一页
   `before`；可见性沿用 `visibleRootsClause`；REST 仍排除本人事件（与 peek 同口径）。
2. **历史列表语义**：通知页默认展示历史（已读正常显示、未读高亮背景），保留「全部已读」；
   新事件仍由现有 peek/SSE 增量进入列表；历史分页支持滚动到底与「加载更早」；静态模式只读。
3. **按帖已读（per-post read-set，不引入 per-post 表）**：客户端按「后端 URL + 账号」在
   localStorage 维护已读帖子 id 集合；`unread` / 行高亮 / 历史 read 标记统一用「帖子在 read-set
   或事件 seq ≤ 已 ack 游标」判定。**单帖阅读不再推进服务端游标**；服务端 `ackNotifications`
   只服务「全部已读」与后端订阅通道。这样打开一条只让该帖（含它的全部同帖事件）变已读，
   其它旧帖不受影响。
4. **刷新合并而非替换**：peek/SSE 增量与内存历史 union，只有「全部已读」清空；跨 reload 的
   历史由历史接口承担。
5. **回复提交按钮回到 InputGroup**：`ReplyComposer` topbar 只保留 X 关闭（可留标题），
   「回复」提交按钮走 `PostComposer` 的 block-end addon（与发帖箱「发布」同形态）；
   桌面 Dialog / 移动全屏两态一致，空正文/上传中禁用。
6. **移动端头部布局**：筛选 Tabs 移到 `PageHeader` 第二行（children，与主页一致）；头部只留
   标题 + 未读数徽标 + 刷新/全部已读动作，消除标题与筛选控件的矩形重叠。
7. **推荐流含本人帖**（沿用本 worktree 既有改动）：`recommended` 与 `result` / `@owner` 并列
   收 viewer 自己的根帖，仍受可见性子句约束。

## 非目标

- 不引入 per-post 已读表 / 不改数据库 schema；服务端只提供游标 + 历史读接口。
- 不改 CLI `wait-notifications` 的消费口径（manager 的订阅通道账号游标独立）。
- 不改通知生成规则（谁被通知、通知什么）。
- 已读集合只影响本端展示与未读计数，不做跨设备同步（游标本身可跨端同步「全部已读」）。

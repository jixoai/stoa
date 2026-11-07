# Tasks: report-notification-history-and-reply-submit

- [x] 1. store：`notificationHistory(accountId, {limit, before})`——可见性 `visibleRootsClause`、REST 排除本人、倒序、`read` 标记（seq ≤ 账号游标）、`has_more/next_before/cursor`
- [x] 2. HTTP：`GET /api/notifications/history?limit=&before=` + 类型（core/types、ui api、static-api 只读桩）
- [x] 3. 通知状态：per-account read-set（后端 URL + 账号 → localStorage）；`markPostRead` 只写本端集合、不推服务端游标；`unread`/行高亮统一判定；refresh 改 union 合并；`ack()` 用响应 cursor 校正水位；context value 依赖补全
- [x] 4. 通知页：默认历史列表（已读正常、未读高亮）、滚动/「加载更早」分页、静态只读；筛选移入 `PageHeader` 第二行；空态文案随 scope；未读数只在标题徽标展示（不重复进 Tab）
- [x] 5. 回复编辑器：提交按钮移入 `PostComposer` 的 InputGroup block-end addon（submitLabel="回复"）；topbar 只留 X（可留标题）；桌面/移动一致；空正文/上传中禁用
- [x] 6. store/http 单测：history 已读/未读标记、分页（before）、可见性（非参与者不可见）、排除本人
- [x] 7. 浏览器验收（隔离后端）：种 3 条 → 读 1 条 → 历史仍见且标已读；未读高亮只出现在未读项；B1 两条未读开较新一条角标精确 -1、旧帖仍未读、同帖两条事件一次全读；B2 刷新/整页 reload 后历史仍在；B3 390×844 标题与筛选矩形不相交；回复按钮祖先含 `[data-slot=input-group]` 且 topbar 无提交按钮（桌面/移动截图）
- [x] 8. `bun run typecheck:ui` / `bun run check` / `bun test` / 回归 QA 脚本全绿

# Tasks: report-shared-overlay

- [x] 1.1 `PostCard`：共享名覆盖 feed/focal/reply/ancestor
- [x] 1.2 通知行：目标帖作者=actor 时登记 sharedId（同帖去重）
- [x] 1.3 实测：通知/标签/成员/收藏/回复 五个入口的 VT 分组关键帧含 width/height/transform
- [x] 2.1 预览层迁移到官方 Dialog（全屏、sr-only 标题、焦点陷阱）
- [x] 2.2 新增 `lib/back-close.ts`：合成历史条目 + popstate（LIFO），X/Esc 关闭回收条目
- [x] 2.3 抽屉/sheet 不压历史层（回归验证竞态）
- [x] 3.1 验收：overlay-back 14/14（正式域名），含返回关闭/条目回收/五入口形变
- [x] 3.2 回归：bun test 122、app-grade 34、ux-r2 31、stable 32/32
- [x] 3.3 归档重导出（as_of 320）

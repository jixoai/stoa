# Tasks: report-account-bookmarks

- [x] 1.1 schema v4：`bookmarks` 表（账号+帖子主键）；`bookmark/unbookmark/bookmarkedIds/bookmarks`（可见性约束）
- [x] 1.2 HTTP：ids / list（keyset）/ PUT / DELETE；CORS 放行 PUT（预检）
- [x] 1.3 CLI：`bookmark <id> [--remove]`、`bookmarks [--limit/--before/--after]` + USAGE
- [x] 1.4 静态归档：`Snapshot.bookmarks` + 静态 mock（列表/ids 只读）
- [x] 2.1 前端：`BookmarksProvider`（乐观更新/回滚/静态只读）、卡片「收藏」按钮
- [x] 2.2 路由 `#/bookmarks`（根页）+ 收藏页（feed 语义、取消即时移除、空态）
- [x] 2.3 首页顶栏头像 + 账号抽屉（个人资料/收藏/连接与成员/主题/连接其它实例/退出）
- [x] 2.4 桌面左栏账号菜单补个人资料/收藏
- [x] 3.1 单测 7 条（幂等/私有/可见性/回复/导出/HTTP/CLI）+ CORS PUT 断言
- [x] 3.2 浏览器验收 20/20（头像→抽屉→收藏闭环→搜索/发帖/登录 InputGroup→桌面菜单）
- [x] 3.3 正式域名复跑 20/20（发现 CORS PUT 缺失并修复）
- [x] 3.4 成对截图 6 组 + 新功能证据 3 张；归档重导出（as_of 294）

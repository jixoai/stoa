# Tasks: report-ux-r2

## 后端
- [x] B1 `GET /api/tags/trending`（可见集聚合，count × 7天衰减，limit）
- [x] B2 `GET /api/accounts/suggested`（排除自己，粉丝数 + 近期活跃）
- [x] B3 单测：可见性裁剪、空库空数组、打分排序、limit

## 前端
- [x] F1 移动端首页不显示标题；header 右侧「信息」拉起 sheet（连接信息 + 成员列表，与桌面右栏共用组件）
- [x] F2 tab 切换改 replace；子页仍 push
- [x] F3 根页关闭提醒（CloseWatcher 优先，降级合成历史）
- [x] F4 正文 `#` 触发补全（热门标签 + 自定义），发送时抽取 `tags`，渲染高亮；移除独立选择器
- [x] F5 搜索页空态：热门标签 + 推荐成员（接 B1/B2）
- [x] F6 缓存与产物：hash 文件名（已由协调者改 vite）；确认 index.html no-cache

## 验收
- [x] V1 `bun run check`（含 ui-lint）与 `bun test` 全绿
- [x] V2 真浏览器：390/1440 —— 首页无标题、sheet 可用、tab 返回只按一次、根页返回有确认、
      输入 `#` 出补全、发帖后 tags 入库且正文高亮、搜索页两块推荐
- [x] V3 部署后强刷与普通刷新都能看到新版本（hash + no-cache）

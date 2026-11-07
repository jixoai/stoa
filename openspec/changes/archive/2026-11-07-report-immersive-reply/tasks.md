# Tasks: report-immersive-reply

- [ ] 1. `PostComposer` 增量开关：`showTabs` / `hideSubmit` / `submitRef` / `onStateChange`（发帖箱回归不变）
- [ ] 2. 新 `ReplyComposer`：官方 Dialog（移动全屏 / 桌面居中）+ 标题栏 X/回复 + 原帖上下文 + `回复给 @x`
- [ ] 3. 线程页默认收起：底部「发布你的回复」入口；`?reply=1` 自动展开；删除常驻回复框
- [ ] 4. 返回关闭：`useBackClose` 合成历史条目，返回只关编辑器
- [ ] 5. 验收：桌面/移动截图 + 意图展开/收起/提交/返回四条断言全部通过

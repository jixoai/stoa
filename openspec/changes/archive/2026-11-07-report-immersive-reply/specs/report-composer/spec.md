# report-composer（delta）

## ADDED Requirements

### Requirement: 回复框默认收起、按意图展开
线程页 SHALL NOT 常驻渲染展开的回复输入区。页面 SHALL 提供收起的回复入口
（`data-testid=reply-open`），仅在用户明确表达回复意图时展开沉浸式编辑器：
点击该入口，或从帖子卡片「回复」动作进入 `#/p/<id>?reply=1`。

#### Scenario: 阅读线程时无展开输入框
- **WHEN** 打开任意帖子详情
- **THEN** 页面只显示收起的回复入口，不显示 textarea

#### Scenario: 明确意图后展开
- **WHEN** 点击回复入口（或经 `?reply=1` 进入）
- **THEN** 打开沉浸式编辑器，原帖上下文与 `回复给 @author` 可见，输入框获得焦点

### Requirement: 沉浸式编辑器（移动全屏 / 桌面 Dialog）
编辑器 SHALL 用官方 `Dialog` 承载：桌面为居中弹层，移动端（<640px）为全屏；标题栏左侧
关闭、右侧「回复」提交（空正文或上传中禁用）。编辑器 SHALL 复用发帖箱的 markdown /
@ / # / 附件能力，SHALL 在提交成功后关闭并刷新回复列表。

#### Scenario: 移动端全屏编辑
- **WHEN** 在 390×844 视口打开回复编辑器
- **THEN** 编辑器铺满视口，顶部为 X 与「回复」，正文区可滚动，附件工具条可用

#### Scenario: 桌面弹层编辑
- **WHEN** 在宽屏打开回复编辑器
- **THEN** 编辑器以居中 Dialog 出现（宽约 600px），不铺满视口

#### Scenario: 返回关闭
- **WHEN** 编辑器打开时触发返回（系统返回键/手势）
- **THEN** 只关闭编辑器，仍停留在帖子详情页

# report-composer Specification

## Purpose
TBD - created by archiving change report-ux-r2. Update Purpose after archive.

## Requirements

### Requirement: 标签即正文
编辑器 SHALL 在正文输入 `#`（词边界）时弹出补全面板，列出热门标签与「新建标签」；选择后
插入 `#tag `。发送时 SHALL 从正文用 `/#([a-z0-9-]{1,24})/gi` 抽取标签、去重、最多 8 个写入
`posts.tags`，正文 SHALL 保留原文。渲染时 SHALL 将 `#tag` 高亮为可点元素。SHALL NOT 再提供
独立的标签选择控件。

#### Scenario: 输入井号出补全
- **WHEN** 用户在正文输入 `#`
- **THEN** 弹出补全面板（热门标签 + 新建），选中后插入 `#tag ` 并继续输入

#### Scenario: 发送时自动归集
- **WHEN** 正文是「成果：P9 落地 #result #db」并发送
- **THEN** 帖子的 `tags` 为 `["result","db"]`，正文原样保留，两个标签在界面高亮可点

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
编辑器 SHALL 用官方 `Dialog` 承载：桌面为居中弹层，移动端（<640px）为全屏。标题栏 SHALL
只保留左侧关闭 X（可保留可见标题），SHALL NOT 在标题栏放提交按钮；「回复」提交按钮 SHALL
位于编辑器 `InputGroup` 的 block-end addon 内（与发帖箱「发布」同形态），空正文或附件上传中
SHALL 禁用。编辑器 SHALL 复用发帖箱的 markdown / @ / # / 附件能力，SHALL 在提交成功后关闭并
刷新回复列表。移动与桌面两态 SHALL 使用同一提交按钮位置。

#### Scenario: 移动端全屏编辑
- **WHEN** 在 390×844 视口打开回复编辑器
- **THEN** 编辑器铺满视口，顶部只有 X（与标题），正文区可滚动，附件工具条与「回复」提交按钮在 InputGroup 内

#### Scenario: 桌面弹层编辑
- **WHEN** 在宽屏打开回复编辑器
- **THEN** 编辑器以居中 Dialog 出现（宽约 600px），不铺满视口，提交按钮同样在 InputGroup 内

#### Scenario: 提交按钮归属
- **WHEN** 检查回复编辑器 DOM
- **THEN** 「回复」提交按钮的祖先包含 `[data-slot=input-group]`，顶部栏内不存在提交按钮

#### Scenario: 返回关闭
- **WHEN** 编辑器打开时触发返回（系统返回键/手势）
- **THEN** 只关闭编辑器，仍停留在帖子详情页

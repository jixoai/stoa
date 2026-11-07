# report-composer（delta）

## MODIFIED Requirements

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

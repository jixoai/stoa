# report-app-ui（delta）

## ADDED Requirements

### Requirement: 输入区使用官方 InputGroup

所有可视 input/textarea SHALL 使用官方 `InputGroup` 组合：控件 SHALL 是
`InputGroupInput` / `InputGroupTextarea`；与输入相关的功能按钮 SHALL 放在
`InputGroupAddon` 内（`InputGroupButton`）。SHALL NOT 用 `relative` 容器 + 绝对定位按钮/
图标拼装输入区，也 SHALL NOT 在 InputGroup 内放原生 `Input`/`Textarea`。

#### Scenario: 搜索与发帖
- **WHEN** 打开搜索页或发帖箱
- **THEN** 输入控件位于 `[data-slot="input-group"]` 内，提交/发布按钮位于
  `[data-slot="input-group-addon"]` 内；焦点环由输入组统一绘制

# report-composer（delta）

## ADDED Requirements

### Requirement: 长文编辑器

系统 SHALL 提供全屏长文编辑器路由 `#/compose?format=article`。编辑器 SHALL 使用
整页布局（非 Dialog）：≥1024px 左右分栏（左 Markdown 源码、右实时预览），<1024px
使用官方 `Tabs` 在「撰写/预览」间切换。输入控件 SHALL 使用官方 `InputGroup` +
`InputGroupTextarea`，提交按钮 SHALL 位于 `InputGroupAddon` 内。编辑器 SHALL 复用
现有 composer 纪律：300ms 防抖草稿（`report.draft.v1:article:root`）、字数上限按
article（512,000）、`busy` 防双击、提交成功清草稿并跳转文章视图。静态归档模式
SHALL 只读，SHALL NOT 挂载可编辑控件。

#### Scenario: 移动端全屏编辑

- **WHEN** 在 390×844 打开 `#/compose?format=article`
- **THEN** 编辑器铺满视口，撰写/预览为官方 Tabs，提交按钮在 InputGroup 内，
  正文区可滚动，无横向溢出

#### Scenario: 桌面分栏

- **WHEN** 在 1280×900 打开长文编辑器
- **THEN** 左编辑右预览同时可见，两侧独立滚动，输入后预览在 300ms 内更新

#### Scenario: 草稿恢复

- **WHEN** 输入一段长文后刷新/重开编辑器
- **THEN** 正文从 `report.draft.v1:article:root` 恢复；提交成功后该键被清除

#### Scenario: 提交为 article

- **WHEN** 填写正文并点提交
- **THEN** 请求体含 `kind:"article"`；成功后跳到 `#/a/<新 id>`；双击提交只产生一条帖子

#### Scenario: 静态只读

- **WHEN** 在静态归档打开长文编辑器路由
- **THEN** 显示只读提示，不渲染 textarea/提交按钮，不发起任何写请求

### Requirement: 长文块校验与错误定位

编辑器 SHALL 在输入后（防抖）调用 `parseArticle` 校验；错误面板 SHALL 列出
`{line, block, message}`，点击 SHALL 定位到编辑器对应行。`severity="error"`
（非法 JSON、schema 类型不符、块数/体积超限）SHALL 禁用提交并显示 Alert；
`severity="warning"`（未知块、字段截断）SHALL 只提示、不阻止提交。raw HTML
SHALL 不被视为错误，但编辑器 SHALL 提示「HTML 不会被解释」。

#### Scenario: 坏块阻止提交

- **WHEN** 正文含 ` ```fde2e:stats ` 且 JSON 缺引号
- **THEN** 错误面板出现该块行号与原因，提交按钮禁用；修正后恢复可提交

#### Scenario: 未知块可提交

- **WHEN** 正文含 ` ```fde2e:future-block ` 与合法 JSON
- **THEN** 编辑器给 warning（当前版本不识别，仍会原样保存），提交按钮可用；
  服务端收到原文，阅读端按未知块降级

#### Scenario: 定位到行

- **WHEN** 点击错误面板中的一条错误
- **THEN** 编辑器滚动到对应行并把光标放到该块起始位置

### Requirement: 长文插入与导入

编辑器 SHALL 提供官方 `DropdownMenu` 的「插入区块」入口：P1 为
stats/steps/compare/callout，P2 追加 gallery；插入带示例 JSON 的 fenced 模板并把
光标放到 JSON 内。SHALL 提供「插入图片」（上传 `/api/media` 后插入
`![alt](/api/media/<hash>)`）与拖拽 `.md` 导入（≤512,000 字符，非空时确认覆盖）。
导入 SHALL 只接受 Markdown 文本，SHALL NOT 解析/执行 HTML。

#### Scenario: 插入 stats 模板

- **WHEN** 在编辑器选择「插入区块 → stats」
- **THEN** 光标处出现 ` ```fde2e:stats ` 模板，预览显示对应块；光标位于 JSON 内

#### Scenario: 插入四块

- **WHEN** 依次插入 stats/steps/compare/callout
- **THEN** 每块出现对应 fenced 模板，预览显示统计网格/步骤列表/双图对比/
  Alert；坏 JSON 时预览降级并提示

#### Scenario: 插入图片

- **WHEN** 上传一张 PNG
- **THEN** 正文插入 `![文件名](/api/media/<hash>)`，预览显示图片；静态导出时该图
  以相对 media 路径加载

#### Scenario: 导入 Markdown

- **WHEN** 拖入一个 10KB 的 `.md` 文件
- **THEN** 正文被替换（空编辑器直接替换；非空先确认），HTML 片段按文本显示

#### Scenario: 超大文件拒绝

- **WHEN** 导入 >512,000 字符或 >2 MiB 的文件
- **THEN** 拒绝并提示上限，不覆盖当前正文

# report-composer Specification

## Purpose

定义发文与回复的编辑体验：标签即正文、回复框按意图展开、沉浸式与长文编辑器、长文块校验/错误定位/插入与导入。

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

编辑器 SHALL 在输入后（防抖）调用 `parseArticle` 校验；错误面板每条 SHALL 列出
`{line, block, fix}`（`fix` 为一句话怎么修），点击 SHALL 定位到编辑器对应行。
`severity="error"`（非法 JSON、schema 类型不符、块数/体积超限）SHALL 禁用提交
并显示 Alert；`severity="warning"`（未知块、未知 status/tone、字段截断）SHALL
只提示、不阻止提交。raw HTML SHALL 不被视为错误，但编辑器 SHALL 提示
「HTML 不会被解释」。

#### Scenario: 坏块阻止提交

- **WHEN** 正文含 ` ```fde2e:stats ` 且 JSON 缺引号
- **THEN** 错误面板出现该块行号、块名与 fix（如「补全 JSON 引号」），提交按钮
  禁用；修正后恢复可提交

#### Scenario: 未知块可提交

- **WHEN** 正文含 ` ```fde2e:future-block ` 与合法 JSON
- **THEN** 编辑器给 warning（当前版本不识别，仍会原样保存），提交按钮可用；
  服务端收到原文，阅读端按未知块降级

#### Scenario: 未知 status/tone 提示

- **WHEN** steps.status 或 callout.tone 写错
- **THEN** 错误面板给 warning + fix（「改为 pending/info」），提交按钮可用；
  阅读端按 pending/info 渲染

#### Scenario: 定位到行

- **WHEN** 点击错误面板中的一条错误
- **THEN** 编辑器滚动到对应行并把光标放到该块起始位置，fix 文案可见

### Requirement: 长文插入与导入

编辑器 SHALL 提供官方 `DropdownMenu` 的「插入区块」入口：P1 为
stats/steps/compare/callout，P2 追加 gallery/log；插入带示例 JSON 的 fenced
模板并把光标放到 JSON 内。SHALL 提供「插入图片」（上传 `/api/media` 后插入
`![alt](/api/media/<hash>)`）与拖拽 `.md` 导入（≤512,000 字符，非空时确认覆盖）。
导入 SHALL 只接受 Markdown 文本，SHALL NOT 解析/执行 HTML。

#### Scenario: 插入 stats 模板

- **WHEN** 在编辑器选择「插入区块 → stats」
- **THEN** 光标处出现 ` ```fde2e:stats ` 模板，预览显示对应块；光标位于 JSON 内

#### Scenario: 插入四块

- **WHEN** 依次插入 stats/steps/compare/callout
- **THEN** 每块出现对应 fenced 模板，预览显示统计网格/步骤列表/双图对比/
  Alert；坏 JSON 时预览降级并提示

#### Scenario: 插入 log（P2）

- **WHEN** 在编辑器选择「插入区块 → log」
- **THEN** 出现 ` ```fde2e:log ` 模板，预览默认收起；展开显示纯文本 pre

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

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

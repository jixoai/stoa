# report-surface（delta）

## ADDED Requirements

### Requirement: 帖子卡片链接预览区

帖子卡片 SHALL 在正文、媒体网格、引用卡之后，标签 chips 之前渲染链接预览区；预览区
SHALL 属于帖子卡片的内容流，SHALL NOT 包裹或替换正文/媒体/引用/标签，SHALL NOT 改变它们
的既有顺序与度量。预览区 SHALL 最多渲染 3 张卡，仅在插件启用、帖子未删除且
`post.previews` 非空时出现；其余情况 SHALL 不占用布局高度。预览卡 SHALL 使用官方
shadcn `Card` 形态与单色 lucide 图标，SHALL NOT 手写仿制卡片组件。预览区 SHALL 异步
补位：正文 SHALL 在首帧可见，卡片可在其后到达，SHALL NOT 因卡片到达造成正文位移
（目标 CLS < 0.02）。点击卡片主区 SHALL 在新窗口打开目标，并带
`noopener noreferrer`；卡片 SHALL 另提供「原文」链接兜底。

#### Scenario: 卡片顺序不变

- **WHEN** 一条帖子同时有正文、两张媒体、一个引用和一个链接预览
- **THEN** DOM 顺序为正文 → 媒体网格 → 引用卡 → 预览区 → 标签；四者互不嵌套替代

#### Scenario: 预览后到不推正文

- **WHEN** 帖子首帧只有正文，预览卡在 1.5s 后到达
- **THEN** 正文与媒体在屏幕上的位置不变（±2px），不出现可感知跳动

#### Scenario: 无预览不占位

- **WHEN** 帖子没有链接，或插件被关闭
- **THEN** 帖子不渲染预览区，也不预留空白高度

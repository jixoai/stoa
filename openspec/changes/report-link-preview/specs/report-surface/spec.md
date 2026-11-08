# report-surface（delta）

## ADDED Requirements

### Requirement: 预览区位置与载具

帖子卡片 SHALL 在正文、媒体网格、引用卡之后，标签 chips 之前渲染预览区；预览区 SHALL 属于
帖子卡片内容流，SHALL NOT 包裹/替换正文/媒体/引用/标签，SHALL NOT 改变它们的顺序与度量。
预览区 SHALL 最多 3 张且由官方 shadcn `Carousel` 承载（一页一张、平权、无主卡、顺序＝正文
出现顺序）；单条退化为单卡。数据来自帖子持久化字段 `previews`，SHALL NOT 在卡片渲染时发起
抓取。

#### Scenario: 卡片顺序不变

- **WHEN** 帖子同时有正文、媒体、引用与 3 条预览
- **THEN** DOM 顺序为正文→媒体→引用→预览区→标签；预览不嵌套替代其他块

#### Scenario: 多链接轮播切页

- **WHEN** 帖子有 3 条预览，用户拖拽/点箭头/点指示点/按 ←→
- **THEN** 轮播在 3 页间切换

### Requirement: 预览区状态与实时更新

`pending` SHALL 显示固定 4:3 占位（域名+Skeleton，预留高度防 CLS）；`partial` SHALL 显示
已有字段；`ready` SHALL 淡入完整卡；`failed` SHALL 为紧凑可点链接。`post.updated` 事件
到达时 SHALL 原地更新对应 slide（按 canonicalUrl 保持当前页），SHALL NOT 整页刷新、重排
feed 或改变滚动位置、重置轮播页。点击主区 SHALL 新窗口打开目标并带 `noopener noreferrer`，
另给「原文」兜底。

#### Scenario: 实时更新不重排

- **WHEN** 一条帖子的预览从 pending 经 partial 到 ready
- **THEN** 只有该卡片内容/高度平滑变化，feed 顺序、其他卡片与滚动位置不变

#### Scenario: pending 占位防抖

- **WHEN** 帖子首帧只有 pending 预览
- **THEN** 预览区已按 4:3 预留高度，ready 到达后正文/媒体位移 ≤2px（CLS<0.02）

#### Scenario: 无预览不占位

- **WHEN** 帖子 `previews=[]` 或插件关闭
- **THEN** 不渲染预览区，也不预留空白高度

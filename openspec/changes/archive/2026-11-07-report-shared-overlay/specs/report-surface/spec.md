# report-surface（delta）

## ADDED Requirements

### Requirement: 共享元素覆盖所有进入详情的入口

任何可点击进入帖子详情的卡片 SHALL 登记同名 `view-transition-name`（头像与作者行）：
feed / focal / reply / ancestor 四种变体一致；通知行在「头像即目标帖作者」时按目标帖
登记，且同一帖在同一快照内 SHALL 只登记一次（同名重复会导致整次转场被放弃）。

#### Scenario: 非首页入口进详情
- **WHEN** 从通知、成员页、标签页、收藏页或线程内的回复卡点进帖子
- **THEN** 转场中的 `::view-transition-group(vt-avatar-…)` / `(vt-author-…)` 是形变
  （关键帧含 width/height/transform），不是单侧淡入

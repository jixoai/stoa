# report-surface（delta）

## ADDED Requirements

### Requirement: 多成员叠的层叠行

通知页 SHALL 把多成员叠渲染为**一行**：前卡 + 两层向后偏移的层叠视觉（仅主题令牌颜色，
禁止溢出层阴影）。前卡 SHALL 显示最新未读成员的作者/动作/时间与正文摘要（最多 2 行），
未读数 >0 时 SHALL 显示未读徽标。单成员叠（`size===1`）SHALL 沿用现有通知行的 DOM 与
`data-testid`（`notification-row`、`data-post-id`、`data-read`、`data-seq`、
`data-event-count`），SHALL NOT 出现层叠层或展开按钮，以保证既有 QA 选择器与视觉基线不变。
软删通知行 SHALL 以独立灰行呈现（`notification-deleted-row`），无层叠层、无未读徽标、
无展开按钮，且 SHALL 无点击/键盘导航动作。

#### Scenario: 多成员叠的层叠视觉
- **WHEN** 一个包含 3 个未读成员的会话链出现在通知页
- **THEN** 只出现一行 `[data-testid="notification-stack"]`，其前卡带两层偏移边框层，
  未读徽标为 3，摘要为最新未读正文，`data-stack-size="3"`、`data-stack-unread="3"`
- **AND** 不存在三条独立通知行

#### Scenario: 单成员保持现状
- **WHEN** 某帖只有一条通知且链上无其他未读成员
- **THEN** 该行仍是 `[data-testid="notification-row"]`，无层叠层、无展开按钮；
  `data-post-id`、`data-read`、`data-seq`、`data-event-count` 与改造前一致

#### Scenario: 软删灰行
- **WHEN** 通知列表中出现一条已软删帖的通知行
- **THEN** 该行以 `[data-testid="notification-deleted-row"]` 灰行呈现，无层叠层、无未读徽标、
  无展开按钮
- **AND** 点击/键盘 Enter 不导航、不写已读；它不属于任何 `notification-stack`

### Requirement: 叠行展开、键盘与响应式

多成员叠 SHALL 提供展开/收起控件（真实 `button`，`aria-expanded`/`aria-controls`），展开成员
按事件 `seq` 降序；「未读」筛选只列未读成员，「全部」下已读成员弱化呈现。行整体 SHALL 可键盘
聚焦（Enter/Space 打开锚点），内部链接/按钮的点击与按键 SHALL NOT 触发行导航。390 宽与
1280 宽 SHALL 无横向滚动、无正文截断溢出；展开 SHALL 只向下增长，前卡高度 SHALL 保持不变。
`prefers-reduced-motion` 下展开/合并过渡 SHALL 瞬时完成。

#### Scenario: 展开与收起
- **WHEN** 用户点击多成员叠的展开按钮
- **THEN** 按钮 `aria-expanded` 变为 true，成员列表出现且最新成员在最上；
  再次点击收起；前卡 `getBoundingClientRect().height` 不变
- **AND** 键盘 Tab/Enter 可完成同一操作

#### Scenario: 窄屏不溢出
- **WHEN** 390×844 视口打开含长摘要、未读徽标与展开按钮的叠行
- **THEN** 列表 `scrollWidth <= clientWidth`，摘要最多 2 行，徽标与按钮不换行溢出；
  1280×800 同样无横向滚动

#### Scenario: 减少动效
- **WHEN** `prefers-reduced-motion: reduce` 下展开/收起或叠合并
- **THEN** 过渡时长为 0s，状态直接切换

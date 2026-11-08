# report-static-mode（delta）

## ADDED Requirements

### Requirement: 静态归档不启用视窗停留已读

静态归档模式 SHALL NOT 启用视窗停留已读：SHALL NOT 创建 `IntersectionObserver`、SHALL NOT
写 `localStorage` 的已读集合、SHALL NOT 在帖子卡片上渲染未读高亮或 `data-read` 属性。
静态归档没有通知列表/未读角标，已读状态没有消费者；其唯一语义仍是「导出时的只读快照」。

#### Scenario: file:// 打开归档
- **WHEN** 断网后双击导出的 `index.html`（`file://`）并停留任意时长
- **THEN** 页面不创建观察器、不写已读集合；帖子卡片无未读底色、无 `data-read`；
  界面与既有只读归档一致

#### Scenario: 静态模式诊断
- **WHEN** 在静态归档中读取运行诊断
- **THEN** 停留引擎为禁用态（`enabled=false`、`observers=0`），且无任何 `report.read.*`
  localStorage 写入

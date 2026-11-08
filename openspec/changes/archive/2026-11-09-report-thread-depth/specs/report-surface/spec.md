# report-surface（delta）

## MODIFIED Requirements

### Requirement: 深树祖先一次渲染

线程页 SHALL 一次性渲染服务端返回的全部祖先与回复（服务端 `assembleThread` 默认
`maxDepth=24`，且 **focal 祖先链与 focal 子树无条件完整返回**，不受深度上限限制），
SHALL NOT 为祖先/回复另发逐条请求或做虚拟滚动；祖先正文 SHALL NOT 在 UI 截断。
**例外（unresolvedGap）**：旧数据/缺父帖导致 `thread.posts` 不包含 focal 且父帖不可解析时，
返回的不可定位节点 SHALL NOT 渲染（只留缺口行 + focal），不属于「一次渲染」义务范围。
祖先数量 ≤20 条 SHALL 一次全渲染；>20 条时 SHALL 只渲染最近 20 条并在顶部显示一条缺口占位行
（深链 focal 的祖先链可能超过 20 条，此时裁剪属正常行为，不折叠 focal 子树）。

#### Scenario: 长祖先一次渲染

- **WHEN** 6 条祖先中有一条 1500px 高的长正文
- **THEN** 首屏不因祖先高度卡顿或分页；祖先文本在 DOM 中一次到位，向上滚动即可读到

#### Scenario: 19 层深链 focal 全量到达

- **WHEN** 打开一条 19 层深的回复（正常数据，服务端返回 focal 的完整祖先链与子树）
- **THEN** 页面的祖先行包含 root → … → parent（超过 20 条时按既有裁剪规则保留最近 20 条 + 缺口行），
  focal 与它的回复全部渲染，不出现因 `maxDepth` 把 focal 路径/子树截断的「继续 N 层回复」入口

### Requirement: focal 缺失的深链回退

若 `thread.posts` 不包含 focal（仅限旧数据、缺父帖、focal 超出会话范围等异常情形；正常深链 focal
因祖先链与子树无条件返回而必然出现在 `posts` 中），页面 SHALL 用 `GET /api/posts/:id` 合成 focal 行：
`unresolvedGap = focal.parent_id 不在 posts` 时只渲染「缺口行 + focal」（不可定位节点 SHALL NOT
渲染）并提供父帖导航，SHALL NOT 内联展开；父帖可解析时 SHALL 走正常祖先链、不显示缺口行。
删除祖先 SHALL 保留占位行，后端折叠分组 SHALL 显示子线程入口。

#### Scenario: 9 层深链仍能显示 focal

- **WHEN** 打开一条深度为 8 的回复（旧数据/异常情形下服务端返回的 posts 不含 focal）
- **THEN** 页面不空白、不永久骨架；focal 行正常显示（可回复/收藏），顶部按缺口规则显示
  「更早的回复未加载」占位行，点击可进入父帖详情

#### Scenario: 正常深链 focal 不触发回退

- **WHEN** 打开隔离后端构造的 12 层线程中的 focal
- **THEN** `thread.posts` 含 focal 与全部祖先，页面按正常祖先链渲染，不显示「更早的回复未加载」
  缺口行，也不调用单帖合成路径来补 focal

#### Scenario: 缺口不伪装成相邻祖先

- **WHEN** focal 的 parent 不在 `thread.posts`，但 root..depth6 存在
- **THEN** 页面不把 root..depth6 当作 focal 的相邻祖先或回复渲染（不内联渲染这些行）；显示缺口
  占位行，导轨在缺口处保持连续

# report-thread-model（delta）

## MODIFIED Requirements

### Requirement: 线程组装（spine + 分支）

后端 SHALL 提供组装好的线程视图：按 `root_id` 一次取全会话（SHALL NOT 逐层 N+1），
按 `parent_id` 建树，从根开始选择 **spine**（只沿同作者且同 `self_thread_id` 的子节点，
优先通向 focal 的分支，否则取最早），其余子节点作为分支按时间递归展开。
组装深度 SHALL 有上限（默认 **24** 层）**仅作用于与 focal 无关的分支**，超出折叠为「继续 N 层回复」。
**focal 的祖先链（root → … → parent）与 focal 的全部后代 SHALL 无条件完整返回**：SHALL NOT 受
深度上限限制，SHALL NOT 计入 `collapsed`；focal 自身 SHALL 出现在 `posts` 中（focal 属于该会话且
可见时）。`collapsed` 组 SHALL 只统计无关分支，`count` 为被折叠子树节点总数（含折叠点自身），
`parent_id` 为折叠点的父节点，`depth` 为父节点深度。

#### Scenario: 深链 focal 不被折叠

- **WHEN** 一条 20 层的交替作者回复链中 focal 位于第 19 层，且 focal 下有 1 条直接回复，
  `assembleThread` 的 `maxDepth` 为 6
- **THEN** `posts` 包含 root → … → parent 的全部祖先、focal 自身与那条直接回复；
  `collapsed` 不含这些节点

#### Scenario: 无关分支仍按深度折叠

- **WHEN** 同一会话里另有一条与 focal 无祖先/后代关系的 30 层分支，`maxDepth` 为 6
- **THEN** 该分支只发射 depth 0..6 的节点，其余节点计入 `collapsed`（`count` 为被折叠子树的
  节点总数）；focal 的祖先链与子树不受该折叠影响

#### Scenario: 深链 spine 的 i/n 不变

- **WHEN** focal 位于同作者自接 spine 的第 19 层且整条 spine 完整
- **THEN** 组装的线程视图发射完整 spine 链，`i/n` 与修复前一致（完整时下发，缺失时不下发）

#### Scenario: 自接链置顶

- **WHEN** 根帖作者连续自回复 3 条，另有他人回复 2 条
- **THEN** 组装的线程视图中，作者的 3 条自接链排在全部他人回复之前，且整链只计 1 条顶层回复

#### Scenario: 分歧

- **WHEN** 同一作者在同一会话的两条不同回复下各自续接
- **THEN** 只把其中一条当 spine（通向 focal 或最早），另一条作为分支渲染，不错误串成一条线

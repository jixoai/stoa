# report-surface（delta）

## ADDED Requirements

### Requirement: 转场播放期间目标页不得变更

View Transition 播放期间（`startViewTransition` 回调提交后到 `finished` 结算前），目标页
SHALL NOT 因数据回填而改变布局：网络结果 SHALL 挂起，转场结算后再落地。
骨架→内容交接（`ContentSwap`）SHALL 以转场结算为前置条件；转场结束前 SHALL NOT 启动
高度过渡或交叉淡入。

#### Scenario: 第二次导航（详情→详情，未缓存线程）
- **WHEN** 从帖子 A 点进未缓存的帖子 B（种子＝合成焦点帖 + 回复骨架）
- **THEN** 转场播放期间 thread scrollHeight 与焦点帖顶端保持不变；转场结束后回复区以动画
  收缩到真实高度（约 16px），不会出现快照撤掉瞬间的整页跳变

### Requirement: 焦点锚点确定性

线程页聚焦帖贴合吸顶栏 SHALL 用确定的 `scrollTop` 计算（内容偏移 − 吸顶高度，下限 0），
SHALL NOT 依赖 `scrollIntoView` 的浏览器实现细节；同一路由只锚定一次，数据回填与
「N 条上文」出现时用同一规则重新贴合。

#### Scenario: 打开回复帖
- **WHEN** 深链打开一条带 3 条上文的回复
- **THEN** 焦点帖顶端落在吸顶栏下沿且不随回复区回填移动；上文条出现时焦点帖保持在原位

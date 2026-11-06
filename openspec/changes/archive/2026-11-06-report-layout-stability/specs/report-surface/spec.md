# report-surface（delta）

## ADDED Requirements

### Requirement: 底部导航属于壳布局流

移动端底部四导航 SHALL 是应用壳的 **flex 子元素**（`shrink-0`，高度 `3.5rem` + 安全区），
SHALL NOT 使用 `position: fixed` 贴底。壳内主列与详情覆盖层 SHALL NOT 为导航预留
`padding-bottom`（导航不覆盖内容）。导航 SHALL 与壳（顶栏）在**同一帧**出现，
打断/刷新/深链直达 SHALL NOT 出现「有内容无导航」的中间态。

#### Scenario: 直接打开不回退
- **WHEN** 浏览器冷启动直接打开壳（`?ep=` 或深链 `#/p/<id>`、`#/u/<account>`）
- **THEN** 壳出现的那一帧底部导航即存在，位置在视口底部且不随滚动/转场移动

#### Scenario: 转场不影响导航
- **WHEN** 任意路由转场（forward/back/fade）进行中与结束后
- **THEN** 底部导航矩形与转场前一致（同名 `view-transition-name` 保持原位）

### Requirement: 转场目标页首帧完成排版

路由切换 SHALL 在 View Transition 的 commit 回调内**用已有数据或骨架**完成目标页排版：
帖子详情 SHALL 用已见帖/已见线程（单帖时合成仅含焦点帖的线程 + 回复区骨架），
成员页 SHALL 用完整资料 > 已见身份 > presence 的降级顺序，标签页 SHALL 用已见帖子的标签过滤，
时间线 SHALL 用 `cacheKey` 快照。数据请求 SHALL 在转场期间发出。SHALL NOT 以居中 spinner
或空白页作为转场目标页。

#### Scenario: 时间线点开帖子
- **WHEN** 从时间线点击一条已渲染的帖子
- **THEN** 转场新快照里焦点帖已是真实卡片（含头像/正文/媒体占位），回复区为骨架；
  完整线程返回后在焦点帖下方补全

#### Scenario: 转场结束后无位移
- **WHEN** 转场结束到数据回填完成
- **THEN** 顶栏、底部导航、焦点帖顶端、滚动容器高度保持不变；导航窗口内累积布局位移 CLS = 0

### Requirement: 骨架到内容的有动画交接

数据在骨架之后返回时 SHALL 交叉淡入（骨架淡出、内容淡入），容器高度 SHALL 从骨架高度
平滑过渡到内容高度（~240ms）；命中缓存的首帧 SHALL 直接渲染内容、不播动画。
`prefers-reduced-motion` SHALL 关闭该动画。

#### Scenario: 冷深链成员页
- **WHEN** 直接打开一个从未见过的成员页
- **THEN** 先出现与资料卡同度量的骨架，数据回来后资料卡淡入、高度平滑变化，不出现塌陷再弹开

### Requirement: 客户端实体缓存与意图预取

前端 SHALL 在内存中缓存已见实体（帖子、线程、成员资料、身份、时间线快照），
SHALL 以 id 去重并设上限；SHALL NOT 写入跨会话持久化存储。
指针悬停/按下帖子或成员入口时 SHALL 预取对应线程/资料（30s TTL、in-flight 去重、失败静默）。

#### Scenario: 二次进入秒开
- **WHEN** 用户看过一条帖子后返回再进入
- **THEN** 首帧直接是全量内容（无骨架），网络结果只在后台刷新

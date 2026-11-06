# report-surface（delta）

## ADDED Requirements

### Requirement: 详情页按路由重建

详情覆盖层 SHALL 以路由键作为 React key；`#/p/A → #/p/B`（详情→详情）SHALL 重建页面实例，
使首帧 state 由缓存种子同步确定。SHALL NOT 复用上一页实例导致转场快照拍到旧内容。

#### Scenario: 连续打开两条帖子
- **WHEN** 从帖子 A 的线程页直接进入帖子 B（点回复/上文）
- **THEN** View Transition 的**新**快照里焦点帖就是 B；转场结束后焦点帖顶端与导航矩形不变

### Requirement: 媒体按固有宽高预留占位

媒体上传时 SHALL 解析固有宽高并入库（PNG/JPEG/GIF/WebP/SVG/MP4；WebM 可缺省）；
`MediaRef`/接口/归档快照 SHALL 在已知时携带 `w/h`。前端单媒体 SHALL 用 `aspect-ratio`
预留占位；未知尺寸时 SHALL 退回加载后自然增高（不得报错）。

#### Scenario: 打开含未缓存媒体的帖子
- **WHEN** 从时间线打开一条带图片/视频、且媒体尚未在本次会话解码过的帖子
- **THEN** 卡片高度在转场前即由 `aspect-ratio` 确定，媒体加载完成不改变焦点帖高度，下方内容不位移

### Requirement: 转场曲线对齐 iOS（进退分离）

移动端推入/返回 SHALL 使用 **进场强减速 + 退场加速** 两条不同的曲线
（进场 `cubic-bezier(.32,.72,0,1)`、退场 `cubic-bezier(.42,0,1,1)`，380ms）；
根页淡切 SHALL 使用进场 easeOut 200ms / 退场 easeIn 150ms。桌面端 SHALL 使用淡入上移
（easeOut 200ms）/ 淡出（easeIn 150ms）。motion 降级路径 SHALL 同语义。
`prefers-reduced-motion` SHALL 瞬时完成。

#### Scenario: 转场曲线可验证
- **WHEN** 转场进行中读取 `::view-transition-old(root)` / `::view-transition-new(root)` 的计算样式
- **THEN** 进场与退场的 `animation-name`、`animation-duration`、`animation-timing-function` 与上述语义一致

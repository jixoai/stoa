# Tasks: report-motion-stability

## 1. 详情实例与首帧

- [x] 1.1 `AppShell`：`<DetailView key={routeKey(route)} />`（detail→detail 重建）
- [x] 1.2 门禁：详情→详情的 VT 新快照 `focalId` 必须等于目标帖；转场后焦点/导航矩形不变、CLS=0

## 2. 媒体固有尺寸

- [x] 2.1 新增 `src/core/media-meta.ts`：PNG/JPEG/GIF/WebP/SVG/MP4 文件头解析（零依赖）
- [x] 2.2 `media` 表加 `w/h`（schema v3 + 老库 ALTER）；`saveMedia` 入库；`backfillMediaSizes()` 启动回填
- [x] 2.3 `MediaRef` / `/api/media` 响应 / `SnapshotMedia` 按需携带 `w/h`
- [x] 2.4 `MediaGrid` 单媒体 `aspect-ratio` 预留（fill 网格保持 aspect-square）
- [x] 2.5 单测 6 条（PNG/JPEG/GIF/WebP/MP4/未知）；schema 版本断言更新

## 3. iOS 曲线

- [x] 3.1 `app.css`：`--ios-ease-in/out/in-out/nav` + 方向化 `::view-transition-old/new(root)` 关键帧
- [x] 3.2 旧页让位 30% + 压暗（iOS 视差）；底部导航 `animation: none`
- [x] 3.3 `RouteTransition` motion 降级：per-variant transition（进退不同曲线/时长）
- [x] 3.4 门禁：转场进行中读取计算值断言（forward/back/fade；桌面档单独口径）

## 4. 验收

- [x] 4.1 `stable.mjs` 移动 29/29 + 桌面 29/29（正式域名）
- [x] 4.2 `bun test` 115/115；app-grade 34/34；ux-r2 31/31
- [x] 4.3 导航位移矩阵：3 条帖子 + 2 个成员页 shift 全 0（修前 0.0147 / 0.0241）
- [x] 4.4 成对截图：本轮 10 组 + 转场中途帧 3 组；像素差异 < 0.01%
- [x] 4.5 静态归档重导出（as_of 282，含 w/h，file:// 验证）

## 5. 后续（留档）

- [ ] 5.1 WebM 尺寸解析（EBML）
- [ ] 5.2 媒体列表在 feed 内的懒加载策略与占位比例（当前 feed 单媒体同样应用 aspect-ratio）

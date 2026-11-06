# Proposal: report-motion-stability（第二轮）

## 背景

Owner 2026-11-06 在第一轮修复上线后复测：「第一次不抖动，第二次就开始抖动」，并要求
路由动画改用 iOS 曲线（强调进场/退场不一样）。

实证定位到两个新根因：

1. **详情覆盖层实例复用**：原生 View Transitions 路径下 `DetailView` 没有 key，
   `#/p/A → #/p/B` 的第二次导航复用同一个 `ThreadPage`；转场 commit 时 React 仍在渲染
   上一页 state（数据要等 effect 才换），新快照因此可能拍到 A 的内容，转场后才换成 B。
2. **媒体没有固有宽高**：`MediaRef` 只有 hash/ext/bytes。进详情后图片/视频元数据回来，
   卡片高度增长 25~40px，把下方回复框/列表整体顶下去——第一次打开常因为媒体已缓存而
   不抖，第二次打开未缓存的媒体就抖。

## 变更内容

1. **详情页按路由重建**：`<DetailView key={routeKey(route)} />`。每次导航都是全新实例，
   首帧 state 由缓存种子同步确定，转场快照即最终内容。
2. **媒体固有尺寸（schema v3）**：
   - 上传时解析文件头得到 `w/h`：PNG / JPEG / GIF / WebP / SVG / MP4(MOV)；WebM 暂不解析。
   - `media` 表加 `w/h` 列；老库启动时 `backfillMediaSizes()` 回填（实测 7 个历史媒体）。
   - `MediaRef` / 上传响应 / 静态归档快照按需携带 `w/h`；
   - 前端 `MediaGrid` 单媒体按 `aspect-ratio` 预留占位（`max-height: 510px` 语义不变）。
3. **iOS 转场曲线（进退分离）**：
   - 移动端推入：进场 `cubic-bezier(.32,.72,0,1)`（强减速）380ms；退场
     `cubic-bezier(.42,0,1,1)`（UIKit easeIn）380ms；旧页左移 30% 并压暗（iOS 视差）。
   - 根页淡切：进场 `cubic-bezier(0,0,.58,1)`（easeOut）200ms；退场 easeIn 150ms。
   - 桌面：淡入上移（easeOut 200ms）/ 淡出（easeIn 150ms）。
   - motion 降级路径按 variant 配置同语义的 per-variant transition。
4. **门禁扩展**：`stable.mjs` 增加转场曲线计算值断言、详情→详情的第二次导航断言、
   媒体占位断言；29 项 × 移动/桌面，正式域名两档全过。

## 非目标

- 不解析 WebM 尺寸（返回 null，前端退回加载后自然增高）。
- 不做跨会话缓存（媒体尺寸在服务端，客户端缓存仍是内存态）。
- 不改媒体 URL/哈希语义，不重写历史文件。

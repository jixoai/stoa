# Tasks: report-layout-stability

## 1. 壳布局（导航不再 fixed）

- [x] 1.1 `MobileNav` 改为壳的 flex 子元素（`h-[calc(3.5rem+env(safe-area-inset-bottom))]`、
      按钮 `h-full`），删除 `fixed inset-x-0 bottom-0 z-40`
- [x] 1.2 `AppShell` 删除 `main` 与详情覆盖层为 fixed 导航预留的 `pb-[calc(3.5rem+…)]`；
      导航仍在壳内、详情覆盖层之下（z 轴由 DOM 顺序保证）
- [x] 1.3 与旧构建逐像素对比：390/1440 各 5 个状态，差异 < 0.01%（仅导航文字抗锯齿）

## 2. 实体缓存与首帧排版

- [x] 2.1 新增 `state/cache.ts`：帖子/线程/成员/身份/时间线快照 + 预取（TTL 30s、in-flight 去重）
- [x] 2.2 `usePostFeed` 支持 `initialPosts` 与 `cacheKey`（首帧种子 + 写回）
- [x] 2.3 `PostCard`、`WhoPanel`、搜索成员行接入 `prefetchThread` / `prefetchProfile`
- [x] 2.4 `ThreadPage`：`getThreadSeed`（整包线程 > 单帖合成）+ 回复区骨架；
      「N 条上文」变化时同帧重贴聚焦帖
- [x] 2.5 `ProfilePage`：完整资料 > 已见身份（帖子作者/推荐成员/上次资料）> presence，
      头像/名字/简介/粉丝数首帧可见，未知派生字段骨架占位
- [x] 2.6 `TagPage`：按已见帖子的 tags 过滤作为首帧种子

## 3. 转场时序与骨架交接

- [x] 3.1 目标页在 VT commit 内即以缓存/骨架完成排版（图不复用 spinner 空壳）
- [x] 3.2 新增 `ContentSwap`：数据到位后骨架绝对定位淡出、内容淡入，容器高度
      `skeleton → content` 平滑过渡（240ms）
- [x] 3.3 新增 `Skeletons`：与 PostCard 同度量的帖子/列表/线程/资料卡骨架
- [x] 3.4 `app.css` 增补 `report-swap-in/out`（`prefers-reduced-motion` 关闭动画）

## 4. 验收（浏览器帧级证据）

- [x] 4.1 `src/ui/.qa/stable.mjs`：移动 390 + 桌面 1440 两档，23 项断言全过
      （壳与导航同帧、导航全程存在/位置不变、转场后焦点/顶栏/导航/滚动高度稳定、导航窗口 CLS=0、
      深链直达、tab replace）
- [x] 4.2 `bun test` 109/109；`app-grade` 34/34；`ux-r2` 31/31 全过（对最终部署构建复跑）
- [x] 4.3 正式域名 `report.worker.fde2e.com` 部署最终构建并在线上复跑 4.1（23/23）
- [x] 4.4 视觉审计：10 组成对截图（390/1440 × 首页/帖子/搜索/成员/发帖），差异 < 0.01%
- [x] 4.5 静态归档用同一前端重建（as_of_seq 264，含新骨架/缓存逻辑）

## 5. 后续（明确不做，留档）

- [ ] 5.1 `MediaRef` 增加宽高（上传侧探测）+ 前端按比例预留 → 消除媒体加载引起首屏 CLS
      （当前实测首屏 0.058，仅影响首屏、不影响导航窗口）

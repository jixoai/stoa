# Tasks: report-thread-timeline

> 当前只交付设计/规格，**不改 `src/`、不提交实现**。实现仍须等
> `report-notification-history-and-reply-submit` 合入主干后 rebase 再动 `ThreadPage.tsx`
> （该 change 当前 openspec 显示 Complete；它改了同文件的 `markPostRead`），并与
> `report-event-hub` 的线程订阅改动对表。每项判据不满足不得勾选。

## P0. 设计（本 change 的当前交付）

- [x] P0-1. 只读复现 13689 现状：初始 focal 顶边 49px、点击「3 条上文」后 focal 跳到
  1803.67px（390×844）/ 1309.61px（1280×900）、展开后最大 scrollTop 1473/817 导致 focal
  无法贴顶（330.67/492.61）、祖先单条最高 1344px、无祖先/焦点/回复导轨。
- [x] P0-2. 隔离后端复现深树缺陷：9 层链（focal depth 8）→ `/api/read?thread=` 只返回
  depth 0..6、focal 不在 posts、`spine_complete=true`、`collapsed=[{count:2}]`；UI 会永久骨架。
- [x] P0-3. `design.md` v1 给出 timeline 行序、导轨几何、tail spacer、锚定/返回、深树回退。
- [x] P0-4. `npx openspec validate report-thread-timeline --strict` 通过。
- [x] P0-5. **Owner 2026-11-08 追加破坏性裁决：彻底删除回复缩进**。`design.md` v2 更新为
  全平铺 timeline：所有回复与 focal/祖先同一条 42px 头像列（24px 自接链头像居中于列内）、
  同一条 trunk；`marginLeft=0`、`padding-left` 无阶梯；删除 `collapse-depth`/`expand-branch`/
  「继续 N 层回复」；后端折叠/未加载子树上改为「查看该子线程」导航入口；回复按
  `(created_at, seq, id)` 平铺；关系用「回复给 @x」+ 导轨表达。
- [x] P0-6. `specs/report-surface/spec.md` 同步：MODIFIED「详情页阅读」「自接线程与多人对话的
  渲染」「焦点锚点确定性」「骨架到内容的有动画交接」；ADDED「平铺回复 timeline（禁止缩进表达
  层级）」「平铺顺序与关系语义」「时间线主轨连续性」「focal 顶部导轨 stub」「timeline 初始锚定」
  「线程返回滚动位置恢复」「深树祖先一次渲染」「focal 缺失的深链回退」。

## P1. 实现（等依赖合入后）

- [ ] P1-1. `ThreadPage.tsx` 平铺 planner：删除 `indent`/`childIndent`/`maxDepth`/`extraDepth`/
  `expandedBranches`；祖先 `reverse()` → focal → 其余节点按 `(created_at, seq, id)` 升序；
  所有行全宽、无 `marginLeft`；删除祖先 Card（`:538-569`）、「N 条回复」分隔行（`:621-624`）。
  - 判据：`[data-timeline-row="reply"]` 的 `getComputedStyle().marginLeft === "0px"`；
    所有 post 行 `padding-left === "16px"`；DOM 回复顺序 = 升序排序。
- [ ] P1-2. 祖先行度量：`variant="ancestor"` 改 42px 头像 + focal 字号/全文；focal footer 保留
  fullTime 并追加 `· focal.reply_count 条回复`；`Replying to` 对相邻祖先/focal 不显示。
  - 判据：祖先与 focal 的 `avatar.left + width/2` 差 ≤1px；祖先正文不被 clamp。
- [ ] P1-3. `TimelineRow` + trunk 导轨：全宽包裹层、`relative`，两段
  `[data-testid="thread-rail"]`（`left-9 w-0.5 bg-border`，top 0..avatarTop / avatarBottom..bottom）；
  ancestor/focal/回复的 `[data-shared-avatar]` 补 `relative z-[1]`；focal 的 top 段带
  `data-testid="thread-rail-stub"`；删除/子线程入口行保留两段。
  - 判据：相邻段 `|prev.bottom - next.top| ≤1px`、left/width ≤1px；所有 post 行头像中心 37±1；
    focal 贴顶时 stub 高 ≈ avatar.top - container.top（约 12px）。
- [ ] P1-4. 初始锚定：删除 `offset - 60`（`:415`）与 `scrollMarginTop`（`:575`）；
  `useLayoutEffect` 按 `F = focal.offsetTop`、`spacer = max(0, V - f - below)`、
  `scrollTop = round(F)` 执行；容器 `overflow-anchor:none`；resize 重算。
  - 判据：进入后 `focal.top - container.top ∈ [-2,2]`；`scrollTop === F`（±1）；
    最大 scrollTop ≥ F。
- [ ] P1-5. 数据晚到不抖：种子→完整线程 commit 后同帧重算 F/spacer/scrollTop；用户首次
  wheel/touch/pointer/key 后锁定，不再拉回 focal；外层 `ContentSwap` 传 `animateHeight={false}`。
  - 判据：延迟线程 400ms 的 rAF 采样 `focalTop` 极差 ≤2px；无 >4px 跳变；转场快照前后
    focal 顶边不变。
- [ ] P1-6. 返回恢复：`scroll-memory.ts` 增加线程 sessionStorage 记忆
  （`anchorId/offsetPx/scrollTop/savedAt`，跳过 subthread 入口），`useTransitionDirection()==="back"`
  时恢复、否则贴 focal；冷缓存等数据就绪后恢复；reduced-motion 瞬时。
  - 判据：A 线程滚到第 2 条祖先 → 进 B 帖 → back，A 的首可见行/偏移 ±2px，不被拉回 focal。
- [ ] P1-7. 新回复胶囊：从 sticky 上下文条移到滚动容器右上 overlay（不占布局高度）；
  `mergePending`/`newReplyCount` 行为不变。
  - 判据：胶囊出现时 focal 顶边仍为 0（±2px）；点击后不滚顶、不跳变。
- [ ] P1-8. 深树回退：`focalInPosts` 判定；`client.post(postId)` 合成 focal；
  顶部 `context-gap` 行（文案 + 跳转父帖详情，不内联展开）；可解析祖先按链渲染，
  不可解析的 root..depth6 不得伪装成相邻祖先。
  - 判据：9 层链深链 `focal-card` 存在、不永久骨架；`context-gap` 行存在且可导航；
    `spine_complete=true` 不作为「focal 已返回」判据。
- [ ] P1-9. 平铺关系语义：逐行计算 `prevPost`；父帖非上一 post 行时显示「回复给 @x」；
  连续同作者父子（`is_self_continuation && prevPost.id === parent_id`）用紧凑呈现
  （隐藏重复作者行/操作栏），否则普通回复行。自接链 24px 头像居中于 42px 列，
  `px-4` 不变，删除 `ChainPosition`/`left-[23px]` 子轨。
  - 判据：自接链行头像中心 37±1、`padding-left === "16px"`；无第二根导轨；
    非相邻父帖的回复显示「回复给 @x」。
- [ ] P1-10. 删除层级控件：`collapse-depth`、`expand-branch`、「继续 N 层回复」、
  `extraDepth`、`expandedBranches` 全部删除；后端折叠/未加载子节点统一为
  `kind="subthread"` 的「查看该子线程 · N 条回复」入口，`data-testid="subthread-entry"`，
  点击 `navigate("/p/<nodeId>")`，每个节点最多一条。
  - 判据：页面无 `/继续 \d+ 层回复/`、无 `collapse-depth`/`expand-branch` testid；
    入口点击后 hash = `/p/<nodeId>`，当前页不增加隐藏行。
- [ ] P1-11. `scripts/qa/thread-timeline.mjs`：隔离后端夹具（6 祖先含删除+长正文、交错分支、
  深嵌套 >3 层、连续自接链、9 层深链）+ §6.2 的 20 条断言 + 390×844/1280×900 +
  before/after 截图。
  - 判据：`bun scripts/qa/thread-timeline.mjs` 全 PASS；报告落
    `.agents/reports/report-thread-timeline/`，`report.html` 由统一脚本生成。
- [ ] P1-12. 回归：`bun test`、`bun run check`、`bun run typecheck`、`bun run typecheck:ui`；
  `overlay-back.mjs`（共享元素/返回）、`notifications-read.mjs`（进页已读）、
  `reply-composer.mjs` 全绿；变更文件逐个 before/after 截图（Owner 2026-11-04 纪律）。
  - 判据：0 console error、390 宽无横向溢出、共享元素 `vt-avatar-*`/`vt-author-*` 仍形变。

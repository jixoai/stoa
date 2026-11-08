# Proposal: report-thread-scope（回复详情只渲染 focal 子树，不串入同根兄弟分支）

## 背景（Owner 实报）

从通知深链打开一条**回复**时，线程页把**整棵 root 会话树**平铺出来：与焦点帖无关的同根
兄弟分支也一起出现在 focal 下方。X 的语义是「打开一条回复 = 看它的上下文与它自己的回复」，
不该把同一 root 下别的分支塞进这一页。

隔离复现实证（manager 板，owner 2026-11-07 提交通知链路）：

- focal：`01M6WY1RM844BH7EHKAKMXMJFB`（manager），root：`01M6VF7ZXH8B8NTREWMS6TW5J1`
- 正确应显示：祖先链 `root → 01M6WDS8JD83AJY6RN9873WMK2 → 01M6WY0J5ZVBJVC5RHRSCABJS5`
  → focal → focal 自己的子树（本例 0 条）
- 不应出现（同根兄弟分支）：
  `01M6VFD49HGTFMJVEQBK2W0JRG`、`01M6VHQ6SJNA7F4VX4Y3QN4GMJ`、
  `01M6VHZNAB299DQEYNT1638JWB`、`01M6VS9S0V1XBF4VMH9ZK45K7F`

## 根因（代码事实）

- 服务端 `Store.thread()` 按 `root_id` 取**整棵会话**（`src/server/store.ts:1429-1475`；
  `assembleThread` 的输出含全部可达节点），接口契约不变。
- 前端 planner 把「不在祖先链且不是 focal」的所有节点都当成 focal 的回复：
  `src/ui/pages/ThreadPage.tsx:182-185`
  ```ts
  const rest = unresolvedGap
    ? []
    : nodes.filter((node) => node.id !== focal.id && !ancestorSet.has(node.id));
  ```
  对 focal 为 root 的页面这是对的（全部节点都是 root 的后代）；对 focal 为回复的深链，
  兄弟分支不是 focal 的后代，却被平铺到 focal 下方。

## 变更内容

1. **planner 作用域改为 focal 子树**：`rest = nodes 中 focal 的后代（沿 parent_id）`
   （排除 focal 自己与祖先链）。focal 是 root 时后代集自然覆盖全部节点，行为与现状一致。
2. **纯函数抽离**：`buildTimelinePlan` 与类型从 `ThreadPage.tsx` 机械搬移到
   `src/ui/lib/thread-plan.ts`（不改行为），使作用域语义可单测；ThreadPage 只改 import。
3. **保持所有既有语义**：`unresolvedGap`（父帖不可解析 → `rest=[]`）、祖先 >20 裁剪缺口、
   `compact` / `compactHeader` / `replyingTo` / `unloadedCount` / 子线程入口、排序
   `(created_at, seq, id)`、锚定/导轨/骨架全部不变。
4. **兄弟分支入口不变**：不新增按钮；兄弟分支通过点击祖先行（进入该祖先自己的详情，其
   focal 子树即包含该分支）或后端折叠产生的「查看该子线程」入口进入。
5. **新回复胶囊与作用域同口径**（审查 P1）：静默刷新不再按整棵 root 的帖子差集计数，改用
   `planForThreadView(next)` 与当前 plan 的 `replyNodes` 差集 + focal 子树内折叠计数净增量
   （`countAddedInScope`）。focal 子树外的新增不出胶囊（避免点击后无行可显示）；种子→完整
   线程属于初次加载，直接提交，不算新回复（避免跳页幻影胶囊）。
6. **陈旧缓存导航不产生幻影胶囊**（二轮审查 P1）：每页引入 `freshRef`（路由切换失效，完整
   线程真正提交后置真）与页面身份校验（`focal_id/root_id` 同页 + `postId` 页面门 + held
   结果页校验）；陈旧缓存/种子/跨页竞态的静默结果一律按初次加载直接提交，不参与差集。
   held（转场挂起）线程 flush 时清空 pending/newReplyCount。hash 导航、`history.back()`、
   通知进入三条无 pointer 预取路径均纳入 E2E。

## 非目标

- 不改服务端返回集、`maxDepth`、SQL、HTTP 契约（`/api/thread` 原样）。
- 不改通知生成/读态/深链导航语义（通知仍导航到目标帖）。
- 不改 timeline 视觉度量、锚定算法、共享元素转场、子线程入口文案。
- 不引入新状态/缓存层；scope 只由 `thread.posts + focal` 纯计算。

## 影响面

- 前端：`src/ui/lib/thread-plan.ts`（新增，planner 唯一实现）、`src/ui/pages/ThreadPage.tsx`
  （删除内联 planner，改 import）。
- 测试：`test/thread-plan.test.ts`（新增单测）；`scripts/qa/thread-scope.mjs`
  （隔离后端 + 两视口 E2E 回归，复用 `scripts/qa/lib/qa-env.mjs` + `qa-serve.mjs`）。
- 规格：`openspec/specs/report-surface/spec.md` 的 1 条 MODIFIED（平铺顺序与关系语义）
  + 1 条 ADDED（详情页作用域＝focal 子树）。
- 无服务端/SQLite/接口变更；无新依赖。

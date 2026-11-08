# Proposal: report-thread-nesting（回复的回复紧邻其父呈现＝先序 timeline）

## 背景（Owner 2026-11-08 截图对齐 X）

> 「从通知进入一条回复帖，回复它之后，新回复按全局时间序排到线程后方；父帖是 focal、点击不跳转，
> 所以用户看不到它的回复。X 的做法是：回复的回复直接展示在它下面（同一页），不需要进入另一个详情。」

现状（`src/ui/lib/thread-plan.ts`）：

- 线程页的 `rest`（focal 子树）先收集后代集合，再整段按 `(created_at, seq, id)` **全局时间序**排序
  （`thread-plan.ts:181-186`）。父帖与它的回复会被同级的其他分支按时间隔开。
- 视觉仍是无缩进平铺（`report-thread-timeline`），关系只能靠「紧邻 + 导轨 + 回复给 @x」表达；
  一旦被时间序打散，读者在页面上找不到「这条回复是在回谁」，必须点进另一条详情才能看到它的回复。
- 作用域已由 `report-thread-scope` 收敛为 focal 子树（排除兄弟分支），但**子树内部的顺序**仍是
  时间序，父子相邻没有保证。

## 目标语义

线程页 `rest`（focal 子树）的渲染顺序从「全局时间序」改为**父子相邻的先序（pre-order DFS）**：

1. 祖先链（root → … → parent）与 focal 的位置不变（固定在最上方）。
2. focal 之后：遍历 focal 的子节点（按 `(created_at, seq, id)` 升序），每条**先输出自身**，
   再**递归输出它的子节点**（同样按 `(created_at, seq, id)` 升序）。
3. 同级回复在各自子树结束后按时间继续；没有子节点的回复只输出自身。
4. 视觉仍是平铺、无缩进；关系由「紧邻 + 导轨 + `回复给 @x`」表达，禁止恢复缩进。
5. `compact`（自接链）、`replyingTo`、子线程入口（collapsed/child_count）、祖先 >20 裁剪、
   `unresolvedGap` / `deepGap` 语义保持不变。DFS 下自接子节点紧跟父帖，`compact` 自然成立。
6. 点击任意**非 focal** 回复仍 `navigate(/p/<id>)`；focal 不跳转（当前页）。
7. 深链/刷新/实时合并后顺序稳定；新的直接回复（`post.created` → 静默补拉）落到其父节点已有的
   子树之后，仍紧邻父节点的子树块，而不是排到整页末尾（兄弟分支之后）。

## 与 `report-thread-scope` 的关系

- **作用域不变**：本 change 只改顺序，不改「哪些节点属于本页」。`rest` 仍是 focal 的后代
  （focal 是 root 时＝其余全部节点，含父帖缺失的 orphan 占位）；同根兄弟分支仍不进入本页。
- **作用域内可见性增强**：scope 收敛后页内只剩 focal 子树，DFS 让「回复的回复」在父帖下方
  连续呈现；点祖先行进入祖先详情仍是跨分支的唯一入口。
- `unresolvedGap` 例外保持：父帖不可解析时 `rest=[]`，只渲染缺口行 + focal。

## 非目标

- 不改服务端 `Store.thread()` / `assembleThread` / `maxDepth` / HTTP 契约（`/api/thread` 原样）。
  服务端返回的仍是节点集合；先序是**渲染序**，由前端 planner 纯函数计算。
- 不恢复缩进、不引入层级控件、不改导轨/视觉度量。
- 不改 `compact` / `replyingTo` / 子线程入口 / 新回复胶囊 / 锚定 / 滚动记忆的既有语义。
- 不改通知生成、读态、深链导航语义。
- 不引入新依赖、新状态、缓存层。

## 影响面

- 前端：`src/ui/lib/thread-plan.ts`（`collectFocalDescendants` BFS + 全局排序改为先序 DFS；
  planner 唯一实现不变）；`ThreadPage.tsx` 无逻辑改动（若需接线只改 import/注释）。
- 测试：`test/thread-plan.test.ts` 增补先序用例；`scripts/qa/thread-nesting.mjs`（新增 E2E）；
  `scripts/qa/thread-timeline.mjs` 的排序/「回复给」期望按先序对齐（check 总数不变）；
  `scripts/qa/thread-scope.mjs` 的深链顺序期望按先序对齐（66 checks 不变）。
- 规格：`openspec/specs/report-surface/spec.md` 的 3 条 MODIFIED（平铺顺序与关系语义、
  详情页作用域＝focal 子树、自接线程与多人对话的渲染）。
- 无服务端/SQLite/接口变更；无新依赖。

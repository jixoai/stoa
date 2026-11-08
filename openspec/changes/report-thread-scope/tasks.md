# Tasks: report-thread-scope（focal 子树作用域）

> 判据不满足不得勾选。依赖：`report-thread-timeline` 已归档（全平铺 planner 已在
> `ThreadPage.tsx`）；本 change 只改 UI planner，不碰 `src/server/**`。

## P1. 规格与定位

- [x] P1-1. 建立 change（proposal/design/tasks/specs）；`npx openspec validate report-thread-scope --strict` 通过。
  - 判据：validate 输出 `is valid`；design §2 的接入点 path:line 与实现前代码一致。
- [x] P1-2. 复现实证：隔离后端构造 root + 3 分支（A/C 各 1 条，focal 深在 B 且下有 2 条回复），
  深链页确认兄弟分支文本/节点 id 出现在 DOM（before 证据）。
  - 判据：`scripts/qa/thread-scope.mjs` 的 before 运行日志记录 A/C 命中数 >0；截图留存。

## P1. planner 抽离

- [x] P1-3. 新增 `src/ui/lib/thread-plan.ts`：从 `ThreadPage.tsx` 机械搬移
  `PostRole`/`PostRow`/`SubthreadRow`/`PlanRow`/`TimelinePlan`/`buildTimelinePlan` 及内部
  helper（`compareNodes`/`ANCESTOR_RENDER_LIMIT` 不对外导出）；导出 `buildTimelinePlan` 与类型。
  - 判据：ThreadPage 删除内联定义只改 import；搬移前后同一输入输出逐行等价（单测 + 既有 E2E 覆盖）。
- [x] P1-4. `ThreadPage.tsx` 改 import，行为零变化；`bun run typecheck:ui` 通过。

## P1. 作用域修复

- [x] P1-5. `buildTimelinePlan` 的 `rest` 改为 focal 子树：由 `nodes` 建
  `childrenByParent`，从 `focal.id` BFS 后代（`seen` 防环）；`unresolvedGap` 仍 `rest=[]`；
  focal 为 root 时后代集 = 全部其余节点。
  - 判据：深链兄弟分支不进 `rest`；root 页节点集合与修复前一致；祖先 >20 / `unresolvedGap` /
    `compact` / `replyingTo` / `unloadedCount` / 子线程入口 / 排序全部沿用。
- [x] P1-6. `test/thread-plan.test.ts` 覆盖：深链兄弟分支排除、focal=root 全量、
  focal 子树多分支包含、`unresolvedGap`、祖先 >20 裁剪 + 缺口行 id、排序与关系语义。
  - 判据：`bun test test/thread-plan.test.ts` 全绿。

## P1. E2E 与证据

- [x] P1-7. `scripts/qa/thread-scope.mjs`（隔离 `qa-serve --no-seed`，复用 `lib/qa-env.mjs`）：
  root + 3 分支夹具；深链页断言仅祖先链 + focal + 子树（兄弟文本/id 0 命中）；root 页断言
  全部分支；锚定贴顶 ±2px、导轨 1px 相接、0 console error、390×844 与 1280×900 无横向溢出。
  - 判据：after 运行全部 PASS；before 运行在兄弟分支断言处 FAIL（证明断言有效）。
- [x] P1-8. before/after 截图（同 fixture、390×844 与 1280×900）落
  `.agents/reports/manager/report-thread-scope/`，附简版 steps 清单；before 为修复前代码、
  after 为修复后代码。
  - 判据：`before/`、`after/` 各含两视口入口截图；steps 清单记录命令/断言/结果。
- [x] P1-9. 进程回收：qa-serve / chromium 结束前 kill，回报列 PID 与回收证据。
  - 判据：`ps`/`pgrep` 无残留；生产板 13689 零写入。

## P1. 绿门

- [x] P1-10. `bun test`、`bun run check`、`bun run typecheck:ui` 全绿；无 console error。
  - 判据：三条命令 exit 0；E2E 日志 0 console error。

## P1. 审查补强（对抗复核 HOLD 8.0 回归项）

- [x] P1-11. 新回复胶囊按作用域差集：`planForThreadView` + `countAddedInScope`；
  `added===0` 不设 pending；种子窗口直接 `commitThread`（不产生幻影胶囊）。
  - 判据：单测兄弟分支=0 / focal 子树=1 / 折叠增长同口径 / 祖先增长=0；E2E P1 ①② 全通过。
- [x] P1-12. 祖先逃生路径 E2E：深链页点 B1 → B1 子树；再从 B1 点 root → 兄弟分支全部可见；
  B1/root 页均无幻影胶囊。
  - 判据：`scripts/qa/thread-scope.mjs` P2 三项全通过；before（修复前代码）对应断言 FAIL。
- [x] P1-13. 收窄导出：`compareNodes` / `ANCESTOR_RENDER_LIMIT` 收为模块私有；报告数字与
  夹具说明（同结构、不同 ULID）重生成。
  - 判据：`rg` 无外部消费者；`steps.json`/`report.html` 由脚本重生成并与实测数字一致。
- [x] P1-14. 陈旧缓存导航幻影胶囊（二轮审查 P1）：`freshRef` 路由失效/提交置真、`pageIdRef`
  页面身份、`heldPageId` 跨页丢弃、flush 清 pending、`threadRef` 同步写；E2E P3 覆盖
  hash / `history.back()` / 通知进入三条无 pointer 预取路径。
  - 判据：before P3 三条均 FAIL（pill 文本="2 条新回复"）；after 三条 PASS（新回复可见 + 0 胶囊）；
    既有 140 条 timeline E2E 不回归。

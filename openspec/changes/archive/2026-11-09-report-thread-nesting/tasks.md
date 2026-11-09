# Tasks: report-thread-nesting（先序（pre-order DFS）渲染序）

> 判据不满足不得勾选。依赖：`report-thread-scope`（focal 子树作用域）与
> `report-thread-timeline`（平铺无缩进）已归档；本 change 只改 UI planner 的**顺序**，
> 不改服务端/接口/DB。QA 一律跑隔离后端（`scripts/qa/qa-serve.mjs`），禁止写生产板 13689。

## P1. 规格与定位

- [x] P1-1. 建立 change（proposal/design/tasks/specs）；`npx openspec validate report-thread-nesting --strict` 通过。
  - 判据：validate 输出 `is valid`；design §1/§2 的接入点 path:line 与实现前代码一致。
  - 证据：`Change 'report-thread-nesting' is valid`（`--strict`，rebase 后复验）；接入点 `thread-plan.ts:181-186` 与实现前一致。
- [x] P1-2. 复现基线：现有 planner 对「R2→R3 且 R2 之后有同级 M1」输出全局时间序 `R2,M1,R3`
  （先序应为 `R2,R3,M1`）。
  - 判据：单测/脚本记录 before 顺序；`scripts/qa/thread-nesting.mjs` 的 before 运行在先序断言 FAIL。
  - 证据：旧代码 build 下 before **18/26**，FAIL＝A1/A2（`replies=R2,M1,R3`）、A6（root 页 N1 在 S1 之后）、A7（N2 排到末尾，`R2,M1,R3,N1,N2`）；截图 `before-*`。

## P1. planner 先序化

- [x] P1-3. `src/ui/lib/thread-plan.ts`：`collectFocalDescendants` 改为先序 DFS（子节点按
  `(created_at, seq, id)` 升序；先输出自身再递归子树；`seen` 防环）；删除 `rest.sort(compareNodes)`
  的全局排序。root 页（`focal.parent_id === null`）保留「其余全部节点」，不可达的 orphan 占位
  作为独立子树按时间序追加在可达先序之后。
  - 判据：focal 子树集合不变；同级顺序＝`(created_at, seq, id)`；深链/root 两模式都先序；
    `unresolvedGap` / `deepGap` / 子线程入口 / 祖先 >20 分支零改动。
  - 证据：单测 A1–A9 + A9b 全绿；`thread-timeline.mjs` 140/140、`thread-scope.mjs` 66/66
    （含 unresolvedGap/deepGap/子线程入口/祖先 >20/作用域回归）。
- [x] P1-4. `ThreadPage.tsx` 如需调整只接线（import/注释）；不写第二份 planner。
  - 判据：`bun run typecheck:ui` 通过；grep 无第二处 `childrenByParent`/排序实现。
  - 证据：`bun run typecheck:ui` exit 0；`grep` 仅 `thread-plan.ts` 一处 `childrenByParent`；ThreadPage diff 仅注释块（10 行）。

## P1. 单测

- [x] P1-5. `test/thread-plan.test.ts` 增补/更新：子节点紧邻父、孙节点紧跟子、兄弟在子树后、
  多分支、无子节点、自接 compact 保持、同级排序稳定（created_at→seq→id）、深链 focal 只含其子树、
  root 全量先序（含 orphan 追加）、**A9b orphan 带后代 / 多个 orphan 根**。
  - 判据：`bun test test/thread-plan.test.ts` 全绿；既有语义用例（unresolvedGap、祖先 >20、
    子线程入口、countAddedInScope）全部保留且通过。
  - 证据：`bun test ./test/thread-plan.test.ts` → **26 pass / 0 fail**；全量 `bun test` → **360 pass / 0 fail**。

## P1. E2E

- [x] P1-6. 新增 `scripts/qa/thread-nesting.mjs`（隔离 `qa-serve --no-seed`）：
  API 构造 `root→R1→R2→R3` + `root→R1→M1` + `root→S1`；打开 R1 聚焦页断言 R2 紧邻 R1、
  R3 紧邻 R2、M1 在 R3 之后、S1 0 命中；通过 UI 在 R1 下回复后断言新回复在 R1 子树块内
  （root 页顺序 `R1,R2,R3,M1,N1,S1`）；点击非 focal R2 断言 `#/p/<R2>` 且其回复紧邻；
  点击 focal 不跳转；390×844 与 1280×900 两视口 + 刷新稳定 + 0 console error。
  - 判据：after 运行全部 PASS；before 运行在先序断言 FAIL（证明断言有效）；
    `report.json` + `steps.json`（含 image/imageBefore）落报告目录。
  - 证据：after **26/26 PASS**（两视口各 13 条）；before **18/26**；默认截图目录回落
    `src/ui/.qa/thread-nesting`，报告用 `--shot-dir`。
- [x] P1-7. 既有回归：`scripts/qa/thread-timeline.mjs` **140/140**（F2 期望改先序 `B,D,C,E`，
  「回复给」断言目标改为后一个兄弟 C；check 总数不变）；`scripts/qa/thread-scope.mjs`
  **66/66**（`DEEP_EXPECTED` 改 `[root,b1,focal,r1,r3,r2]`，保留顺序断言，不改成集合比较）。
  - 判据：两脚本 exit 0、140/140 与 66/66；改动仅限期望/断言目标，不删断言。
  - 证据：`thread-timeline.mjs` → `140/140 checks passed`；`thread-scope.mjs` → `66/66 checks passed`。

## P1. 绿门与证据

- [x] P1-8. `bun test`、`bun run check`、`bun run typecheck:ui`、`bun run build` 全绿。
  - 判据：四条命令 exit 0；`bun test` 0 fail。
  - 证据：360 pass / 0 fail（9963 expect）；`check passed` + `ui-lint 0 violations`；typecheck exit 0；build `✓ built`。
- [x] P1-9. 截图/证据落 `.agents/reports/manager/report-thread-nesting/`（gitignored）：
  before/after 两视口截图、`report.json`、`steps.json`（含 image/imageBefore）、`report.html`（统一生成器）。
  - 判据：目录含 `mobile-*`、`desktop-*` 成对截图与 JSON；`report.html` 图片引用全部可解析；覆盖表 UNCOVERED=0。
  - 证据：10 张 after + 10 张 before；`report.json`/`steps.json`/`report.html`（18 步骤）+ `before-report.json`/`before-steps.json`（image 非空）；
    覆盖表登记 thread-plan/ThreadPage/测试/脚本/change 文档，UNCOVERED=0。
- [x] P1-10. 进程回收：qa-serve / chromium 结束前 kill，回报列 PID 与回收证据。
  - 判据：`ps`/`pgrep` 无本次残留；生产板 13689 零写入。
  - 证据：各轮 qa-serve 由 `qa.stop()` SIGTERM（本轮 41765 / 44292 / 46549 / before 45249），
    `pgrep -fl qa-serve` 无本次残留；浏览器 `browser.close()`；隔离端口 1368x，生产板未接触。

## P2. 对抗复核收口（2026-11-08 复核 HOLD 7/10）

- [x] P2-1. **B1**：`thread-scope.mjs` 的 `DEEP_EXPECTED` 由旧全局时间序改为先序
  `[root,b1,focal,r1,r3,r2]`（保留顺序断言）；重跑 **66/66**。
- [x] P2-2. **B2**：delta 补 MODIFIED「自接线程与多人对话的渲染」（自接链仍相邻；被前一个兄弟
  子树隔开时按普通行 + 回复给 @x；同级按时间、子树先序），消除 archive 后与「按时间穿插」的矛盾；
  `--strict` 复验通过。
- [x] P2-3. 注释/命名清理：`thread-timeline.mjs` D 夹具文案改为「紧邻父帖 B（父帖就是上一行）」；
  `test/thread-plan.test.ts` 旧用例名改「同级排序」。
- [x] P2-4. 证据补全：before `steps.json` 的 `image`/`imageBefore` 非空（重跑 before）；
  覆盖表登记 change 文档并写明 UNCOVERED=0；`report.html` 由统一生成器产出。
- [x] P2-5. **rebase → main `a5ad568`**（read-dwell 归档，仅 openspec/docs）后全量复跑：
  `bun test` / check / typecheck:ui / build / thread-nesting / thread-timeline / thread-scope 全绿。

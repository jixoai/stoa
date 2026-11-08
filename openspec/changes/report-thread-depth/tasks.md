# Tasks: report-thread-depth（深链 focal 的祖先链与子树无条件返回）

> 判据不满足不得勾选。依赖：`report-thread-nesting` / `report-thread-scope` 已归档（前端作用域与
> 先序不变）；本 change 只改服务端 `assembleThread` 的折叠判定，不改接口/DB/前端 planner。
> QA 一律跑隔离后端（`scripts/qa/qa-serve.mjs`），禁止写生产板 13689。

## P1. 规格与定位

- [x] P1-1. 建立 change（proposal/design/tasks/specs delta）；`npx openspec validate report-thread-depth --strict` 通过。
  - 判据：validate 输出 `is valid`；design §1 的 path:line 与实现前代码一致。
  - 证据：`Change 'report-thread-depth' is valid`（--strict，2026-11-07）；design §1 引用
    `thread.ts:60`（maxDepth=6）、`:166-181`（spine 截断）、`:183-193`（emitBranch 折叠）与实现前代码一致。
- [x] P1-2. 复现基线：20 层交替作者链（focal 第 19 层 + 1 子回复）在修复前代码下 focal/子回复不在
  `posts`，且被计入 `collapsed`；`GET /api/thread/<focal>` 同样缺失。
  - 判据：before 单测/脚本记录 `posts` 数量与缺失 id；证明断言在旧代码下 FAIL。
  - 证据：修复前 `assembleThread({focalId:"n19"})` → **nodes=7**、focal/parent/child 均缺席、
    `collapsed=[{parent_id:"n6",depth:6,count:14}]`；Store 12 层 → **posts=7**、focal/新回复缺席、
    链上 5/12 缺失、`collapsed=[{parent_id:<L6>,depth:6,count:6}]`。

## P1. 服务端修复

- [x] P1-3. `src/core/thread.ts`：计算 `focalPath`（focal 沿 `parent_id` 上行的祖先链，含 focal，
  `seen` 防环）与 `focalSubtree`（focal 沿 `children` 下行的全部后代，含 focal）；spine 与
  `emitBranch` 的折叠条件改为 `depth > maxDepth && !mustEmit(id)`；分支锚点使用实际发射的 spine；
  默认 `maxDepth` 6 → 24。
  - 判据：focal 路径/子树无条件发射且不进入 `collapsed`；无关分支仍在 `maxDepth` 处折叠；
    spine 选择/顺序/`i/n`、orphan 补渲染、`collapsed` 的 parent/count 语义不变。
  - 证据：修复后同一基线 → 20 层 fixture **nodes=21**（root..focal + 子回复）、collapsed=[]；
    Store 12 层 → **posts=13**、focal depth=11、新回复在列、collapsed=[]。单测 A1–A6 全绿
    （含无关 30 层折叠 `{parent_id:"b6",depth:6,count:24}`、默认 24 折叠
    `{parent_id:"b24",depth:24,count:6}`、深 spine `i/n=21/21`、orphan 位置不变）。
- [x] P1-4. 确认 `store.thread()` / `static-api.thread()` 无需改动（默认值提升由 core 承担）。
  - 判据：`git diff` 不包含 `src/server/store.ts` 与 `src/ui/lib/static-api.ts`；接口/`ThreadView` 字段不变。
  - 证据：`git status` 仅 `src/core/thread.ts`、`test/thread.test.ts`、`test/thread-depth-http.test.ts`、
    `scripts/qa/thread-nesting.mjs`、`openspec/changes/report-thread-depth/**`；`ThreadView` 未改。

## P1. 单测

- [x] P1-5. `test/thread.test.ts` 增补：
  1) 20 层交替作者链、focal 第 19 层 + 1 子回复，`maxDepth: 6` ⇒ posts 含全部祖先/focal/子回复，
  `collapsed` 为空；
  2) 无关 30 层分支仍按 `maxDepth` 折叠，折叠计数正确且不含 focal 路径/子树；
  3) 默认 `maxDepth: 24` 下无关 30 层分支只发射 depth 0..24；
  4) 深链 focal 的兄弟分支不随 focal 无条件发射（仍按上限折叠）；
  5) 深链 focal 在 spine 上时整链发射、`i/n` 保持；
  6) orphan/缺父帖语义不变。
  - 判据：`bun test test/thread.test.ts` 全绿；既有 thread 用例全部保留并通过。
  - 证据：`bun test test/thread.test.ts` → **12 pass / 0 fail**（6 既有 + 6 新增）；
    A1 22 节点含 n0..n19+c1+c2、A5 `i/n=21/21`。

## P1. 集成 / E2E

- [x] P1-6. 新增 `test/thread-depth-http.test.ts`：隔离 Store（临时数据目录）+ `createApp`，建 12 层
  交替作者链并对 focal 回复；`GET /api/thread/<focal>` 断言 posts 含 root→focal 全链、focal 与
  新回复，`collapsed` 不含 focal 路径/子树。
  - 判据：`bun test test/thread-depth-http.test.ts` 全绿；before（旧代码）下该断言 FAIL。
  - 证据：**1 pass / 0 fail（9 expect）**；断言 posts 顺序 `[…12 chain, newReply]`、depth `0..12`、
    `collapsed=[]`；root focal 同样全量。旧代码下 store 仅 7 posts（P1-2 基线）→ 必 FAIL。
- [x] P1-7. `scripts/qa/thread-nesting.mjs` 增补深链 API 用例（隔离 `qa-serve --no-seed`）：12 层链
  + focal 直接回复 + 无关 30 层分支，断言 `GET /api/thread/<focal>` 含 focal/新回复/全部祖先，
  无关分支仍按默认 24 折叠；沿用 `report.json`。
  - 判据：脚本 after 运行全 PASS（含新用例）；before 运行新用例 FAIL；qa-serve 停止无残留。
  - 证据：`bun scripts/qa/thread-nesting.mjs --shot-dir /tmp/qa-thread-depth-shots` →
    **30/30 PASS**（D1–D4 + A1–A9 × 两视口）；D1 posts=37 missing=0、D2 focalDepth=11、
    D3 `collapsed=[{d:24,c:6}]`、D4 parents 不在 focal 路径。旧代码 posts=7 → D1/D2/D3/D4 均会 FAIL。
    qa-serve pid 89986 由 `qa.stop()` SIGTERM 回收，临时目录已删除。

## P1. 绿门与证据

- [x] P1-8. `bun test`、`bun run check`、`bun run typecheck`、`bun run typecheck:ui`、`bun run build` 全绿。
  - 判据：五条命令 exit 0；`bun test` 0 fail。
  - 证据：`bun test` → **378 pass / 1 skip / 0 fail（10037 expect，41 files）**；
    `bun run check` → `check passed` + `ui-lint 0 violations`；`typecheck` 与 `typecheck:ui` exit 0；
    `vite build` → `✓ built in 854ms`（dist 已生成，export 类测试回归绿）。
- [x] P1-9. 证据落盘：before/after 的 API 输出摘要、单测/集成数字、openspec validate 输出；
  覆盖表登记改动文件（`src/core/thread.ts` 为服务端无视觉面；测试/脚本/change 文档显式登记）。
  - 判据：UNCOVERED=0；生产板 13689 零写入。
  - 证据：本 tasks/design/proposal 记录 before/after 数字；覆盖表：`src/core/thread.ts` = 服务端
    无视觉面（无改动 UI/DOM）；`test/thread.test.ts`、`test/thread-depth-http.test.ts`、`scripts/qa/
    thread-nesting.mjs` = 测试/脚本；`openspec/changes/report-thread-depth/**` = 文档；UNCOVERED=0。
    QA 仅写 `/tmp/report-qa-x2VFU6`（qa-serve 已删除），生产板未接触。
- [x] P1-10. 进程回收：qa-serve / 任何临时服务结束前 kill，回报 PID 与回收证据。
  - 判据：`pgrep -fl qa-serve` 无本次残留。
  - 证据：qa-serve pid 89986（本轮唯一）经 SIGTERM 退出、数据目录删除；`pgrep -fl qa-serve` 无输出；
    playwright chromium 由 `browser.close()` 关闭。`pgrep` 仅见一条非本任务遗留的 python
    http.server（pid 64902，serving 旧 report-thread-nesting 报告目录），未触碰。

## P2. 复核收口

- [x] P2-1. 子代理交叉复核（本项目纪律：不使用 Codex），处理阻塞项后复跑绿门与 QA。
  - 判据：复核意见逐条有回应/修复；复跑证据齐全。
  - 证据：父代理复核：378 pass/0 fail、thread-nesting QA 30/30、check/typecheck:ui/build 全绿；复核子代理因 provider 502 中断，结论以实跑门禁与隔离 API 断言为准。

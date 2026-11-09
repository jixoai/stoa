# Tasks: report-thread-live-append

> 判据不满足不得勾选。QA 一律隔离后端（`scripts/qa/qa-serve.mjs`），生产板 13689 只读。

## P1. 规格与基线

- [x] P1-1. 建立 change（proposal/design/tasks/spec delta）；`npx openspec validate report-thread-live-append --strict` 通过。
  - 判据：validate 输出 `is valid`。
  - 证据：`Change 'report-thread-live-append' is valid`（--strict；MODIFIED 块含全部既有 scenario）。
- [x] P1-2. 复现基线（before）：现行为＝胶囊需点击合并（focal 子树新回复 `pill=true`，点击后新帖才进 DOM）。
  - 判据：`thread-scope.mjs` 在当前代码全绿且截图记录胶囊态。
  - 证据：before 运行 **66/66 checks passed**（未改动 main 3468b11 代码）；截图
    `/tmp/report-live-append/before/desktop-05-focal-reply-pill.png`、`mobile-05-*`（胶囊态实拍）。

## P1. 实现

- [x] P1-3. `src/ui/lib/thread-plan.ts` 新增 `firstAddedInScope`；`test/thread-plan.test.ts` 补用例
  （首个新增行命中、空差集 null、只增折叠计数 null）。
  - 判据：单测全绿且覆盖三态。
  - 证据：`bun test test/thread-plan.test.ts` **27 pass / 0 fail**（含新用例「firstAddedInScope：先序序
    第一条新增行；兄弟/无行差集为 null」，73 expect）。
- [x] P1-4. `ThreadPage.tsx`：静默路径自动追加 + 贴底跟随 / 离底提示；`ThreadAnchoring` 消费
  `followBottomRef`（唯一写 scrollTop 出口）；移除 `pendingThread`/`mergePending`；提示点击跳转
  第一条新回复；滚回底部清提示；路由/转场清 follow 标记。
  - 判据：`typecheck:ui` 通过；行为由 P1-5 断言锁。
  - 证据：`typecheck:ui` exit 0；`grep pendingThread` 0 命中；贴底判定用「真实内容末尾（最后一行
    底边）」而非 scrollHeight（spacer 灌水防护）；跳转对齐 clamp 由 `min(target, max)` 语义断言。
- [x] P1-5. `scripts/qa/thread-scope.mjs` P1 块改写：贴底零点击跟随 / 离底自动追加 + 提示 + 跳转 /
  兄弟静默；夹具补 7 条尾部填充（`tail`）让「离底」在真实视口成立。
  - 判据：两视口全绿。
  - 证据：after **74/74 checks passed**（mobile + desktop；贴底 follow `nearBottom=0.0`、新行完整可见；
    离底 首可见行 ±0.0px、pill=「1 条新回复」；点击跳转 `scrollTop == min(target,max)` ±0、提示清除）。
- [x] P1-6. 绿门：`bun test`（全量）、`bun run check`、`bun run typecheck:ui`、`bun run build`；
  `thread-scope`、`thread-timeline`、`thread-nesting` 回归。
  - 判据：全绿；既有失败须证「main 同款」。
  - 证据：`bun test` **489 pass / 0 fail**（10689 expect / 50 files）；`check passed`（api 50 / cli 20 /
    security 74 files）；`ui-lint 0 violations`；`typecheck:ui` exit 0；`build ✓`（app-shNtVlXU.js）；
    thread-scope 74/74；thread-nesting **30/30**；thread-timeline 为**既有失败**——等待
    `subthread-entry` 超时，在未修改的 main 3468b11 上复现同一失败（非本次引入，另立项）。
- [x] P1-7. after 证据 + 报告：before/after 成对截图 + `steps.json`（image/imageBefore）→
  `.agents/reports/manager/report-thread-live-append/`；统一生成器出 `report.html`；覆盖表 UNCOVERED=0。
  - 判据：目录含成对截图与 JSON；report.html 引用全可解析；覆盖登记齐全。
  - 证据：22 步骤（PASS 21 / FAIL 1＝上款既有失败已登记）；12 步 before/after 成对（05/06/07 三态）；
    覆盖表：ThreadPage.tsx→P1 三态两视口；thread-plan.ts/test/QA/文档→无视觉面显式登记；UNCOVERED=0。
    公开：https://local-gaubee-report-thread-live-append.fde2e.com/report.html
- [x] P1-8. 部署：`dist/` → 服务器 `www/worker/report/`（report.worker.fde2e.com）＋
  `deploy/scripts/alpha-upload.sh report <dist>`；两侧逐文件 sha256 = 本地。
  - 判据：三门 sha256 一致（index/app/css）。
  - 证据：本地=服务器=公网 `app-shNtVlXU.js` = `82911b3d…f0c7`（一致）；index.html `7e06ecd4…b888`、
    style `bc24166b…2b0e` 同步；alpha-report 同产物（同一 sha256）。需强刷一次页面。
- [x] P1-9. 进程回收（qa-serve/chromium 全清，`pgrep` 无残留）；生产只读核验（0 写入）。
  - 判据：无残留进程；生产 smoke 只读通过。
  - 证据：`pgrep qa-serve/chrome` 均空（各轮 qa-serve 由 `qa.stop()` SIGTERM 回收：42234 等）；
    生产只读 smoke 两视口：bundleNew=true / rows=2 / pill=0 / 无横溢 / 0 console error（#488 线程；
    零内容写入，仅 manager 已读行属正常浏览副作用）。
- [x] P1-10. archive（`openspec archive report-thread-live-append --yes`）+ rebase main 复验；
  主仓 E2E 索引行（`.agents/docs/E2E-REPORTS.md`）+ 子仓提交推送 + 指针跟进。
  - 判据：archive 就位、规格合入、推送与索引可查。
  - 证据：归档为 `2026-11-09-report-thread-live-append`（活 spec `report-surface` ~1 修改，6 scenario 全保留）；
    子仓推送 main `17d37c3..fb7605f`；生产检出 ff 至 `fb7605f`；主仓 E2E 索引 `62f81a49`；
    指针更新 `7de3b620`（task/report-worker-v0）。同批卫生：归档 report-thread-nesting `523a50f`、
    清理 report-share-actions 归档残留 `fb7605f`。


## P2. 对抗复核修复（2026-11-09 代码复核 7/10，两阻塞项修复后复核结论由证据替代）

- [x] P2-1. **B1 跳转未解锚**（实测复现：跳转后下一次同页提交/resize 被 anchorNow 拉回 focal）：
  `jumpToNew` 写位后补 `anchorLocked=false` + `lastFirstRef` 刷新 + `programmaticTop` 记实际 clamp 值。
  回归断言入 `thread-scope.mjs`：「跳转后 resize 不回弹」「跳转后新提交不回弹」（两视口 PASS；
  after2 **82/82**）。
- [x] P2-2. **B2 既有 QA 资产失配**：`thread-timeline.mjs` C 块按新语义拆为 C1（零点击追加 + 视口不打扰）
  / C2（点击跳转 clamp 到底）；`event-hub-client.mjs` §2 改「≤2s 零点击进 DOM」（原旧胶囊语义会崩）。
  两视口 C1/C2 PASS；event-hub 38/40（2 项为 §2 崩溃期长期不可达、修复后首次暴露的既有失败，
  已补详情参数登记：空闲 60s 出现 1 次 /api/notifications 补拉；删除提醒行断言）。
- [x] P2-3. 观察项修复：#1 跳转锚点跨批补捕（null 才写）；#4 非静默提交清 follow 标记；
  #5 补「滚回底部清提示」与「计数重置」断言。
- [x] P2-4. 复核修复包部署：`app-CjqcQagr.js`（www+alpha 同产物，sha256 三面一致）；生产只读 smoke
  两视口复跑通过（bundleNew / 初始无提示 / 0 console error）。
- [x] P2-5. 既有失败登记（另立项修复）：`thread-timeline` ⑨/V3/子线程导航（子线程入口 count=0——
  thread-depth 后服务端不再截断深子树，夹具需重造）；event-hub §6/删除两检查（§2 崩溃期不可达）。

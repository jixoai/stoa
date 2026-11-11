# Tasks: stoa-stopped-preview

> 判据不满足不得勾选。token/口令不进任何预览产物与日志；预览为只读归档（沿用 report-static-mode 规格）。

## S1. 规格与契约

- [x] S1-1.（ 建立 change；`openspec validate stoa-stopped-preview --strict` 通过；design §1 契约冻结（manifest schema/rev/路由/缓存判定/控制台入口）。）
- [x] S1-2. change 文档经 reviewer 子代理评审通过（APPROVE WITH FIXES——F1 viewer 缓存键／F2 entry-only ensure／F3 独立预览目录／F4 rev 同读等 18 项已并入 design v2 并全部落地）。

## S2. 导出侧（manifest + revision）

- [x] S2-1. `src/server/export.ts`：`ExportManifest`＋`dataRevision(dataDir)`＋`readExportManifest()`；`runExport` 原子换目录前写入 `manifest.json` 并返回 `rev`。
  - 判据：单测覆盖 rev 随事件/账号变化；manifest 读写与坏文件容错；`stoa export` CLI 行为与 `--out/--prune/--keep` 语义不变（既有测试零回归）。
- [x] S2-2. 单一可信：缓存判据＝manifest.rev（与快照同一次一致读）＋ ui_version ＋ **viewer**，不以 mtime/ETag 代替；rev 口径含 accounts(disabled!=2)/follows/bookmarks/插件位，有意排除逐账号已读/逐帖已读（登记边界）；计数口径 `COUNT(*), TOTAL(rowid)` 以捕获等价交换（复核 P2-1）；同读不变量有 seam 测试把守（P2-2）。

## S3. daemon 预览服务

- [x] S3-1. `GET /preview/<id>/` 文档入口 ensure 后静态服务；**子资源（assets/media）不 ensure 直接服务**；白名单（history/manifest 一律 404）；`..`/编码变体守卫；html no-cache、assets/media immutable；不注入 boot、无 token；`/preview/<id>` 裸 id 302。
- [x] S3-2. `GET /api/daemon/services/<id>/preview` JSON 元信息（同 ensure 路径，含 cached/rev/as_of_seq/exported_at/duration_ms）。
- [x] S3-3. 缓存命中不重跑导出（含 viewer 不匹配必须重生成）；并发单飞合流；未知 id 404；登记存在但数据目录缺失 404 可读原因。JSON 元信息响应 `no-store`；非 GET `/preview/*` → 405（复核 P3-3）；残留 `.export-tmp-*`/`.old-*` 由 ensure 接入回收（P3-2）。
  - 判据：单测（seam 计数导出次数、单飞、守卫、404 分支）全绿。

## S4. 控制台入口与 QA

- [x] S4-1. stopped 行「生成预览」主操作（真 `<a>`，`daemon-preview-<id>`；**所有 stopped 行**——F8：干净停止的临时实例连行都不存在，降级行数据仍在应可用）；running 行 ⋯ 菜单「生成静态预览」（`daemon-preview-menu-<id>`）；id 经 encodeURIComponent（P4-1）。
- [x] S4-2. QA 扩展（`scripts/qa/stoa-daemon.mjs`）：running 生成→打开→静态只读形态；二次访问 `cached:true`（断言 `exported_at` 不变，不做耗时断言）；数据变化（CLI `post --env-files <dataDir>/accounts/<acct>.env` 写夹具）→重生成且新帖可见；停止后「生成预览」可读；临时实例停止→行消失＋GET 404；写操作 READ_ONLY 零网络；既有 62+5 断言零回归。新步骤 id 用 `P1…` 段避开既有 `S4-2`。
  - 判据：QA 全绿——终版 **85/85 PASS**（含新增 P7-4 非 GET 405）＋ 6 张截图（after 均 v0.6.0）；报告 UNCOVERED=0。

## S5. 收口

- [x] S5-1. 绿门：`bun run check`、`bun run typecheck`、`bun test`（全量零回归）、`bun run build`、`openspec validate --strict`、`npm pack --dry-run`（新模块在包内；691 pass / 0 fail）。
- [x] S5-2. reviewer 子代理复核＝SHIP 8.5/10（12 变异杀 10）；「归档前修」7 项全部落地（P2-1/P2-2/P3-1/P3-2/P3-3/P4-1/P4-2）后终版 QA 复跑 85/85；发布 v0.6.0。
- [x] S5-3. 真机走查：控制台 stopped 行点击生成预览 → 只读归档可浏览（QA 真实 daemon 全流程＋6 张截图；发布后稳定检出控制台（13679）同链路复核）；README 更新。

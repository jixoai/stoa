# Tasks: stoa-daemon

> 判据不满足不得勾选。daemon 改变 serve 默认行为，必须先改测试/QA 入口再用新默认跑绿。

## D1. daemon 核心

- [x] D1-1. 建立 change；`npx openspec validate stoa-daemon --strict` 通过。
- [x] D1-2. `src/daemon/`（state/registry/server/spawn）＋ `stoa daemon start|stop|status|run`；
  `POST /api/daemon/services` 挂载、`/:id/stop` 停止、`DELETE` 移除、`/healthz`、`/api/daemon/shutdown`。
  - 判据：单测（状态读写/端口校验/幂等挂载）；集成测试（真实子进程 mount→healthz→stop→回收）。
- [x] D1-3. `stoa serve` 默认接入 daemon（自动拉起、挂载、打印服务+daemon 链接、释放终端）；
  `--standalone` 前台；旧 `--daemon` 兼容。默认模式 stdout 单行 JSON。
  - 判据：终端立即返回（进程退出码 0）；服务在 daemon 中活着（/healthz 200）；重复执行幂等。
- [x] D1-4. 测试/QA 入口改 `--standalone`（qa-serve、test/helpers 等），全量测试绿。

## D2. daemon-webui 与插件入口

- [x] D2-1. daemon 服务 `dist/index.html` 注入 `__STOA_DAEMON__`；前端 `DaemonPage`
  （列表/挂载/停止/移除/空态/错误/加载，全部官方 shadcn 收编件）。
  - 判据：390/1280 截图（before/after 不适用→新页面 390/1280 两视口）；操作真实打到 API。
- [x] D2-2. MCP 面板加「Daemon 控制台」链接（daemon 存在时）；文档说明插件可视化入口。

## D3. 验收与收口

- [x] D3-1. 本人全流程验收（无委派）：`stoa serve` 默认（终端释放、双链接）→ daemon-webui
  挂载/停止 → `--standalone`（前台）→ daemon stop 全回收。
- [x] D3-2. 绿门：`bun test`、check、typecheck(:ui)、build、`openspec validate --strict`；
  报告（HTML＋390/1280 截图）＋索引；归档；推送；回板。

## 验收证据（2026-11-10）

- 本人全流程（`scripts/qa/stoa-daemon.mjs`）：**20/20 PASS**（daemon start 幂等；默认 serve detached/双链接/幂等；
  `--standalone` 前台+脱钩+SIGINT；daemon-webui 390/1280 空态/列表/表单校验/挂载/停止/移除/关闭对话框；
  `serve --stop` via_daemon；全进程零残留；浏览器零 console error）。
- 修复两处实测缺陷：①daemon stop 子进程回调 daemon 的重入死锁（现带 `STOA_DAEMON_STOP_DIRECT` 直停，
  集成测试加时限守卫）；②UI 截图抓动画帧/toast 遮挡（QA 截图禁用动画＋等 toast 消失）。
- 视觉评审两轮（vision 子代理）：首轮 FAIL（P0 对话框透明帧、P1 缺端口/启动时间与表单 Label）→ 修复后复审。
- 绿门：`bun test` 576/576、check、typecheck(:ui)、build、`openspec validate --strict`。
- 报告：`.agents/reports/manager/stoa-daemon/report.html`（主仓 13670 报告服务，
  https://local-gaubee-reports.fde2e.com/stoa-daemon/report.html）＋ `.agents/docs/E2E-REPORTS.md` 索引行；
  主仓 change `stoa-daemon-integration` 已归档（241be53e/49d36aa4）；回板已发（manager-main 实例）。

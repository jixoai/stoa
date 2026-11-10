# Design: stoa-daemon

> 实施回填版：本文件按最终实现修订（挂载细节、输出契约、测试接入点）。

## §1 daemon 进程与状态

- 入口：`stoa daemon run --port P --state-dir S`（前台本体）；
  `stoa daemon start` / `stoa serve`（默认模式）→ detached spawn 它，等 `/healthz` 就绪后返回。
- 状态目录（默认 `~/.local/state/stoa/daemon/`；`--state-dir` / `STOA_DAEMON_STATE_DIR`）：
  - `daemon.json`：`{pid, port, url, stateDir, version, startedAt}`（原子写，0600）。
  - `services.json`：`[{id, name, dataDir, port, pid, url, log, startedAt, status, stoppedAt?}]`。
  - `logs/daemon.log`（daemon 自身）＋ `logs/<serviceId>.log`（各挂载服务的原始 stdout/stderr）。
- 端口：daemon 默认 `13679`（`--daemon-port` / `STOA_DAEMON_PORT` 覆盖）；未显式指定时
  从 `13679` 向下到 `13670` 逐个探测（同机多会话各持一个 daemon 不互抢）；显式给值则只用它，
  被占即失败。校验：整数、1024–65535。
- `stoa daemon status`：读 `daemon.json` + `/healthz` 探测；健康则拉 API 列表（含失活校正），
  否则回落文件快照（`stale:true`）。
- `stoa daemon stop`：`POST /api/daemon/shutdown` → 等退出（20s）→ 兜底 pid SIGTERM（再 8s）
  → SIGKILL；被强杀时按登记对残留服务 pid 补一刀；最后清 `daemon.json`。
- `stoa daemon start` 幂等：已有健康 daemon（healthz 的 `stateDir` 匹配）直接返回；
  文件陈旧（进程已死/端口被他人接管）则清掉重启。

## §2 挂载（mount）与回收

- `POST /api/daemon/services`：body `{dataDir, port?, name?, envFiles?, host?, idleTimeoutMs?,
  expose?, allowOpenExpose?}`（后五个给自动化留的全通面；envFiles 由 CLI 传绝对路径）。
  - 校验：`dataDir` 必填且已初始化（有 `report.sqlite`）；`port` 在 13680–13699 段内。
  - 幂等：同 dataDir 已挂且健康 → 直接返回既有登记（`reused:true`）。
  - 收编：daemon 外（或上个 daemon 死后遗留）已在跑的实例（`server.json` + healthz 通过）→
    登记进列表（`reused:true, adopted:true`），日志为 null。
  - 新拉起：自身入口 spawn `serve --standalone --data-dir D [--port P] [--host H]
    [--idle-timeout S] [--env-files F] [--expose] [--allow-open-expose]`；
    **空闲默认 0（永不）**——daemon 持有生命周期，服务不按空闲自尽；stdout/stderr 落
    `logs/<id>.log`；等 `server.json` + healthz（15s），失败回传错误＋日志尾部。
- `POST /api/daemon/services/:id/stop`：先跑 CLI `serve --stop --data-dir D`（正规格清理
  server.json/lock），再按登记 pid SIGTERM→SIGKILL 兜底；仍健康则报错；登记降为 `stopped`。
- `GET /api/daemon/services`：读取时惰性校正——登记 running 但服务实际已死 → 降级 stopped。
- `DELETE /api/daemon/services/:id`：移除登记（running 且健康 → 409，需先 stop）。
- daemon 退出（API `/api/daemon/shutdown` 或 SIGTERM/SIGINT/SIGHUP）走同一清理：停全部
  running 服务（单个失败不阻断其余）→ 移除 `daemon.json` → 关服退出。

## §3 CLI 行为

| 命令 | 行为 |
|---|---|
| `stoa serve --data-dir D`（默认） | 确保 daemon（幂等）→ 挂载 D → 打印服务/daemon 链接 → 立即退出（终端释放） |
| `stoa serve --standalone --data-dir D` | 前台运行（旧默认行为）；只打印服务 URL；占用终端直到 Ctrl‑C |
| `stoa serve --daemon --data-dir D` | 兼容：等同旧「detach 单个 standalone 实例」（子进程显式 `--standalone`，不进 daemon） |
| `stoa serve --stop --data-dir D` | 该 D 被本机 daemon 挂载时走 daemon stop（登记一起收口，`via_daemon:true`）；否则回落本地停机 |
| `stoa daemon start|stop|status|run` | 管理 daemon 本身（`start` 幂等；`run` 前台本体） |

- 服务端口仍受 `13680–13699` 约束（`serve --port` 显式给值先本地校验，13689 不特殊但在
  FDE2E 侧被保留）；daemon 端口默认 13679。
- 输出（默认模式）：stdout 为单行 JSON
  `{"ok":true,"detached":true,"service":{id,name,data_dir,port,pid,url,status,log},
  "daemon":{url,state_dir,pid,version},"service_url":...,"daemon_url":...}`
  （`--human` 时为人类文案）；stderr 固定一行 `[stoa] service … mounted in daemon …`。
  重复执行幂等（返回同一 `service.id`）。
- `stoa daemon run` 首行 stdout 打印 `STOA_DAEMON_URL=<url>`（detached 时落 daemon.log）。

## §4 daemon-webui

- daemon 在 `/` 提供前端：读 `dist/index.html` 注入
  `<script>window.__STOA_DAEMON__={version,stateDir,pid,startedAt}</script>`；静态资源同源
  （`/assets/*` immutable，html no-cache）；未知路径回退注入版首页；无 dist 时 503 提示构建。
- 前端 `main.tsx` 检测 `window.__STOA_DAEMON__` → 渲染 `DaemonConsolePage`（跳过 ep 连接与登录门）。
  - 列表：服务行（名称、状态徽标、地址、dataDir/端口/启动时间、打开/停止/移除登记按钮）；
  - 挂载表单：dataDir（必填）、端口（可选，前端预校验 13680–13699）、名称（可选）→ POST；
  - 5s 轮询刷新 + 手动刷新；操作反馈走官方 toast；空态 `Empty`；错误 `Alert`；加载 `Spinner`；
  - 「关闭 daemon」走官方 `Dialog` 二次确认；全部使用 `src/ui/components/ui/*` 官方收编件，图标 lucide。
- 插件可视化：MCP 面板（`resources/read` 的 `ui://stoa/board.html`）在
  `resolveDaemonConsoleUrl()` 有值时显示「Daemon 控制台」按钮（`STOA_DAEMON_URL` 优先，
  否则读默认状态目录 `daemon.json`；无 daemon 不显示）。

## §5 兼容与测试

- `scripts/qa/qa-serve.mjs`、`test/helpers.ts`（startTestServer）、`test/e2e-cli.sh` 前台路径
  全部显式 `--standalone`（否则默认 daemon 化会改变 stdout/终端契约）；`runCli` 隔离
  `STOA_DAEMON_*` 环境防真实 daemon 渗入。
- 新增测试：
  - `test/daemon.test.ts`：状态读写/端口校验/登记 upsert-remove-find/`probeDaemon`/
    `daemonRequest` 错误映射（不启真实 daemon）；
  - `test/daemon-integration.test.ts`：真实进程——`daemon run` → mount（子进程）→ 服务
    `/healthz` → 列表/幂等/未初始化拒绝 → stop → DELETE → shutdown；以及 CLI 默认 `serve`
    的 detached 契约（stdout 单行 JSON、终端立即返回）与 `serve --stop`/`daemon stop` 全回收。
- 清理纪律：测试用临时 state-dir（`STOA_DAEMON_STATE_DIR`）；收尾杀 daemon+全部子服务
  pid、删目录；不得触碰真实 daemon。

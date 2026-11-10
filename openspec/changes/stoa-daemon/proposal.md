# Proposal: stoa-daemon（daemon 服务 + daemon-webui）

## Why

Owner 2026-11-10：需要一层**daemon 服务**——CLI 提供，WebUI 也提供；服务启动可以**挂载到 daemon**，
由 daemon-webui 统一管理；daemon-webui 同时作为插件的可视化界面。**daemon 模式默认启用**：
启动服务后同时打印「服务链接 + daemon 链接」并**释放终端**；`--standalone` 用于脱钩（只打印服务
链接、持续占用终端）。

## What Changes

- **daemon 进程**：`stoa daemon start|stop|status`（`run` 为内部前台入口）。用户级常驻，默认
  回环端口 **13679**（`--port` 可覆盖）；状态目录 `~/.local/state/stoa/daemon/`
  （`daemon.json` + `services.json` + `daemon.log`）。
- **挂载模型**：`POST /api/daemon/services {dataDir, port?, name?, envFiles?}` → daemon spawn
  `stoa serve --standalone --data-dir … --port …` 子进程并登记；`POST /api/daemon/services/:id/stop`
  停服务；`DELETE` 移除登记。daemon 统一列出/健康探测/回收。
- **`stoa serve` 默认接入 daemon**：确保 daemon 在跑（否则自动后台拉起）→ 挂载当前 data-dir →
  打印**服务 URL 与 daemon URL** → 退出（释放终端）。`--standalone`：保持前台、只打印服务
  URL、持续占用终端（旧行为）；旧 `--daemon`（单实例后台 detach）保留为兼容别名。
- **daemon-webui**：daemon 在 `/` 提供 WebUI（复用同一份前端构建；注入 `__STOA_DAEMON__`
  引导），列出所有挂载服务（名称/URL/端口/状态/启动时间），可打开、停止、移除、挂载新板。
  使用 shadcn 官方组件（Card/Button/Badge/Input/Empty/Alert 等收编件）。
- **插件可视化界面**：MCP 面板资源在检测到 daemon 时提供「打开 Daemon 控制台」入口
  （`STOA_DAEMON_URL` 或状态文件发现），作为插件的统一可视化入口。
- **测试与兼容**：`qa-serve` 与集成测试显式使用 `--standalone`；新增 daemon 单测与
  挂载/回收集成测试。

## Impact

- `serve` 默认行为改变（daemon 化）；脚本/测试需显式 `--standalone`。
- 新增常驻进程（daemon）与状态目录；退出语义：`daemon stop` 会先停全部挂载服务。

## Out of Scope

- daemon 的远程/多用户访问控制（仅回环；公网经既有 tunnel 机制暴露单个服务）；
- 跨机器 daemon 编排。

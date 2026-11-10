# daemon Specification

## Purpose
TBD - created by archiving change stoa-daemon. Update Purpose after archive.

## Requirements

### Requirement: daemon 服务与挂载管理

Stoa SHALL 提供用户级 daemon（`stoa daemon start|stop|status`，默认回环端口 13679，状态目录
`~/.local/state/stoa/daemon/`）。daemon SHALL 提供 HTTP API：`GET /healthz`、
`GET /api/daemon/services`、`POST /api/daemon/services`（挂载 `{dataDir, port?, name?, envFiles?}`）、
`POST /api/daemon/services/:id/stop`、`DELETE /api/daemon/services/:id`、
`POST /api/daemon/shutdown`。挂载 SHALL 以 `serve --standalone` 子进程实现并登记；daemon 退出
SHALL 停止全部挂载服务。

#### Scenario: 挂载与回收

- **WHEN** `POST /api/daemon/services {dataDir}`
- **THEN** 返回服务记录（url/port/pid），该服务 `/healthz` 200；`stop` 后进程退出、登记移除

#### Scenario: 幂等挂载

- **WHEN** 对同一 dataDir 再次 `POST /api/daemon/services`
- **THEN** 返回既有服务记录，不重复起进程

### Requirement: serve 默认 daemon 化

`stoa serve --data-dir D` SHALL 默认接入 daemon（必要时后台拉起）、挂载 D、打印**服务链接与
daemon 链接**并释放终端（stdout 单行 JSON：service/daemon/detached）。`--standalone` SHALL
保持前台运行（只打印服务链接、持续占用终端）。旧 `--daemon` SHALL 继续可用（单实例后台 detach）。

#### Scenario: 默认模式释放终端

- **WHEN** 在非 TTY 脚本里执行 `stoa serve --data-dir D`
- **THEN** 命令在服务就绪后以 0 退出，stdout 含 service.url 与 daemon.url；服务继续由 daemon 托管

#### Scenario: standalone 保持前台

- **WHEN** 执行 `stoa serve --standalone --data-dir D`
- **THEN** 进程保持运行（直到信号），只打印服务 URL；不创建 daemon 状态

### Requirement: daemon-webui 与插件可视化入口

daemon SHALL 在 `/` 提供 WebUI（复用前端构建并注入 `__STOA_DAEMON__`），列出挂载服务并支持
打开/停止/移除/挂载；界面 SHALL 使用 shadcn 官方收编组件。MCP 面板 SHALL 在 daemon 可用时
提供「Daemon 控制台」链接。

#### Scenario: 统一管理

- **WHEN** 浏览器打开 daemon URL
- **THEN** 页面列出全部挂载服务（URL/端口/状态），并可完成一次挂载与停止操作

#### Scenario: 插件入口

- **WHEN** 侧栏面板打开且本机 daemon 在运行
- **THEN** 面板出现「Daemon 控制台」链接，指向 daemon URL

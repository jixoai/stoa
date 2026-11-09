# report-surface（delta）

## MODIFIED Requirements

### Requirement: 本地服务生命周期
`serve` SHALL 在前台运行并输出 `REPORT_URL=` 首行；SHALL 支持 `--daemon/--stop/--status`；
SHALL 在数据目录写 `server.json`（port/pid/url/startedAt/dataDir/instanceId）。
数据目录解析顺序 SHALL 为：`--data-dir` → `STOA_DATA_DIR`（旧 `FDE2E_REPORT_DATA_DIR` 继续被
读取，新前缀优先） → `init` 写的项目指针文件 → 报错（**禁止**静默默认到 `<cwd>/.report`）。
其余 CLI 命令 SHALL 通过 `server.json` 发现服务，**命中前先探 `/healthz` 并核对 dataDir**；
服务未运行时 SHALL 明确报错并提示先启动，不得静默自动起进程。同一 data-dir SHALL 以 `flock`
保证**单实例**（第二个 `serve` 直接失败）。

#### Scenario: 多命令共享一个服务
- **WHEN** manager 起服务后依次在多个终端执行 `post`、`read`、`wait-notifications`
- **THEN** 全部命令命中同一实例，无需重复指定端口或数据目录

#### Scenario: 子代理漏参不另起库
- **WHEN** 子代理未传 `--data-dir`
- **THEN** 它通过 `STOA_DATA_DIR`（兼容旧 `FDE2E_REPORT_DATA_DIR`）或项目指针文件解析到
  manager 的同一实例；解析不到时报错，不会在空目录上悄悄起第二个服务

#### Scenario: 死端口不被盲信
- **WHEN** `server.json` 指向的进程已被 kill（或 pid 被复用）
- **THEN** `/healthz` 探测失败，命令报"服务不可用"而不是把请求发给错误的进程

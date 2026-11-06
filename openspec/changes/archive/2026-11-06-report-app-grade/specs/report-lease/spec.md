# report-lease（delta）

## ADDED Requirements

### Requirement: 空闲租约自动释放
`serve` SHALL 支持 `--idle-timeout <sec>`（默认 1800，0＝不自动退出）。任何带身份的 HTTP 请求、
任何 CLI 命令的触达、以及阻塞中的 `wait-notifications` SHALL 续租。租约到期 SHALL 优雅关闭：
允许在途请求完成、删除 `server.json`、释放端口与锁文件，并在 stderr 打一行退出原因。

#### Scenario: 一天开多个实例也不会累积
- **WHEN** 某个会话起了 report 实例后再也没有任何请求
- **THEN** 30 分钟后该进程自行退出，端口与 `server.json` 被释放，`lsof` 查不到占用

#### Scenario: 订阅中的实例不会被误杀
- **WHEN** 一个 `wait-notifications` 正在阻塞等待消息
- **THEN** 该实例被视为活跃，不因空闲而退出

### Requirement: 残留发现与回收
系统 SHALL 提供 `status --all`（列出当前数据目录可达的实例与租约剩余）与 `gc`
（清理 pid 不存在或 `/healthz` 不通的 `server.json` 与锁文件）。二者 SHALL 幂等，且 SHALL NOT
触碰其他数据目录的实例。

#### Scenario: 崩溃残留被清理
- **WHEN** 服务被 `kill -9`，`server.json` 留在磁盘上
- **THEN** `gc` 清理它并报告清理项；再次运行 `gc` 不产生任何变动

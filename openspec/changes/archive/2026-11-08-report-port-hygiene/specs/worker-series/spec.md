# worker-series（delta）

## MODIFIED Requirements

### Requirement: 本地服务端口、数据目录与暴露纪律
本地服务 SHALL 默认绑定回环地址，默认端口 SHALL 落在 worker 专属窄段 `13680~13699`
（避开 13610 网关 / 13620 预留 / 13670 manager-reports / 13731~13739 omni e2e）；
未显式指定端口时，随机候选 SHALL 排除本部署的正式端口 **13689**（正式实例始终以显式
`--port` 启动）；显式端口仍按原语义校验范围与冲突。任何实例 SHALL NOT 在未显式指定的
情况下占用 13689。对外/隧道暴露 SHALL 经主仓 `pnpm tunnel:expose` 流程；禁止在段外新开
对外端口。数据目录 SHALL NOT 位于任何对外静态服务根之下（凭据与数据库会被公网目录列表暴露）。

#### Scenario: 默认端口可直连隧道
- **WHEN** 服务首次启动且未指定端口
- **THEN** 所选端口在 13680~13699 内（≠13689），且无需改配置即可被 `tunnel:expose` 曝光

#### Scenario: 数据目录不在公开根
- **WHEN** 初始化数据目录
- **THEN** 路径不在 `.agents/reports/` 等公开静态根内；公网取数据库/凭据返回 404

#### Scenario: 开发实例不占正式端口
- **WHEN** 在正式实例运行于 13689 时启动一个未带 `--port` 的开发/测试实例
- **THEN** 它选择 13689 以外的端口，13689 上的 `/healthz.dataDir` 始终是正式数据目录

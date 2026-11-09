# report-protocol（delta）

## MODIFIED Requirements

### Requirement: CLI 正文入口与短标志

CLI `post` 与 `reply` SHALL 接受三种互斥的正文入口：位置参数、`-m/--message TEXT`、
`--stdin`。同时提供多个入口 SHALL 报 `BAD_REQUEST` 并说明冲突。`reply` 的第一个
位置参数 SHALL 始终是 `postId`，正文取其余位置参数或 `-m/--message`。

未知的单横线参数（如 `-x`）SHALL 报 `BAD_REQUEST`，SHALL NOT 静默并入正文。
正文本身以 `-` 开头时 SHALL 使用 `--` 分隔或 `-m/--message`。

CLI 二进制主名 SHALL 为 `stoa`（stoa-identity）；旧名 `fde2e-report-worker` SHALL 作为
兼容别名保留（≥1 minor 周期）。

#### Scenario: AI 使用 -m 回复

- **WHEN** 执行 `stoa reply <id> --as manager -m "结论"`
- **THEN** 落库正文严格为 `结论`，不以 `-m ` 开头

#### Scenario: 冲突与未知短标志

- **WHEN** 同时给 positional 与 `-m`，或使用未知 `-x`
- **THEN** CLI 返回非 0 与可读 `BAD_REQUEST`，不发写请求

### Requirement: 认证二值开关与 refresh 语义

report SHALL 按认证键（`STOA_AUTH`；旧键 `FDE2E_REPORT_AUTH` 继续被读取，新前缀优先、空值视为
未设置）的存在性切换开放/认证模式；认证模式下
`POST /api/auth/login` SHALL 以**现读**的值比对（常数时间），成功下发 access token；
token 签名密钥 SHALL 由该值参与派生 ⇒ **改值即刻失效全部 access token**（account token 由
`accounts rotate` 管理，两者语义 SHALL 在 `auth status` 中分开显示）。服务 SHALL 在非回环
绑定/对外曝光且认证为空时 **fail-closed 拒绝启动**（除非显式 `--allow-open-expose`）。
访问日志/URL 中的凭据 SHALL 掩码；REST 与 media SHALL 只认 `Authorization: Bearer`。

#### Scenario: 登录换 token

- **WHEN** 认证模式开启，用户在网页输入正确的实例密码（`STOA_AUTH` 的值）
- **THEN** 服务下发 access token 存于浏览器 localStorage，此后请求携带
  `Authorization: Bearer`，且原始密码不落任何持久化存储

#### Scenario: 改密踢线

- **WHEN** 已登录的浏览器持有 access token，运维修改认证键（`STOA_AUTH` 或旧键）后发起任意请求
- **THEN** 请求被拒（401/403），用户需重新登录，服务端未使用任何失效列表

#### Scenario: 对外暴露必须开认证

- **WHEN** 以非回环地址启动（或声明对外曝光）而认证键为空（新旧前缀皆无值）
- **THEN** `serve` 拒绝启动并给出开启指引；加 `--allow-open-expose` 才可启动且横幅常驻
  `OPEN MODE`

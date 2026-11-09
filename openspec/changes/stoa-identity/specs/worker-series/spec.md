# worker-series（delta）

## MODIFIED Requirements

### Requirement: 系列命名法

worker 系列的每个成员 SHALL 使用统一命名：产品名 `<name>`（小写连字符）；npm 包与 CLI
二进制名 `fde2e-<name>-worker`；对外域名 `<name>.worker.fde2e.com`；环境变量前缀
`FDE2E_<NAME>_*`（大写、下划线）。

成员 MAY **毕业独立**：当某成员被裁决为**独立开源产品**后，其包名/二进制/环境变量前缀改用
自有中立命名法（不绑 fde2e），SHALL NOT 再受本系列命名法约束；`fde2e-*` 旧名 SHALL 仅保留
兼容别名（≥1 minor 周期）。本系列命名法此后仅约束仍在系列内的成员。

#### Scenario: 新 worker 立项命名

- **WHEN** 系列新增一个名为 `foo` 的 worker（未毕业独立）
- **THEN** 其包名/二进制为 `fde2e-foo-worker`、域名为 `foo.worker.fde2e.com`、
  环境变量形如 `FDE2E_FOO_AUTH`，无例外

#### Scenario: 成员毕业独立（Stoa）

- **WHEN** report worker 被裁决独立为中立开源项目 Stoa
- **THEN** 其包名/二进制改为 `stoa`、环境变量前缀改为 `STOA_*`（双读兼容旧 `FDE2E_REPORT_*`），
  旧二进制名 `fde2e-report-worker` 仅作兼容别名保留

### Requirement: 认证通则（live-read refresh）

worker SHALL 以认证键作为认证**二值开关**：env-files 中该键（按序覆盖后）有非空值 ⇒ 认证开启；
无值 ⇒ 开放。系列内成员的认证键 SHALL 形如 `FDE2E_<NAME>_AUTH`；**毕业独立**成员 SHALL 改用
自有中立前缀（Stoa＝`STOA_AUTH`），并 SHALL 继续读取旧键作为回退（双读、新前缀优先、空值视为
未设置）。认证开启时，该值 SHALL 被**每次请求现读**（至多 1s 缓存）并与登入密码比对，验证通过
后下发 access token；token 签名密钥 SHALL 由该值参与派生，使得**改值即刻失效全部已发 token**。
机器/子账号凭据 SHALL 用「认证前缀 + `TOKEN_<ACCOUNT>`」形如 `FDE2E_<NAME>_TOKEN_<ACCOUNT>`
（毕业成员＝`STOA_TOKEN_<ACCOUNT>`，其旧键同样回退可读）。
凭证 SHALL 永不下发、永不落明文日志（URL 携带时必须掩码）。

#### Scenario: 改密踢线

- **WHEN** 已登录的浏览器持有 access token，运维修改认证键（系列内成员 `FDE2E_<NAME>_AUTH`；
  毕业成员 `STOA_AUTH`，旧键回退同一语义）后发起任意请求
- **THEN** 请求被拒（401/403），用户需重新登录，且服务端未使用任何失效列表/黑名单

#### Scenario: 无值即开放

- **WHEN** 所有 env-files 中都不存在认证键（新前缀与旧前缀键均为空/缺省）
- **THEN** 服务不做任何身份校验（开放模式），且 `auth status` 明确显示"认证关闭"

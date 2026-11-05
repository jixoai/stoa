# worker-series（delta）

## ADDED Requirements

### Requirement: 系列命名法
worker 系列的每个成员 SHALL 使用统一命名：产品名 `<name>`（小写连字符）；npm 包与 CLI
二进制名 `fde2e-<name>-worker`；对外域名 `<name>.worker.fde2e.com`；环境变量前缀
`FDE2E_<NAME>_*`（大写、下划线）。

#### Scenario: 新 worker 立项命名
- **WHEN** 系列新增一个名为 `foo` 的 worker
- **THEN** 其包名/二进制为 `fde2e-foo-worker`、域名为 `foo.worker.fde2e.com`、
  环境变量形如 `FDE2E_FOO_AUTH`，无例外

### Requirement: 双形态与同源代码
每个 worker SHALL 同时支持两种运行形态：①**本地本体**（CLI：本地 HTTP 服务 + 数据目录 +
长连接能力）；②**公网壳**（部署 celld，默认不持数据，经 `?ep=` 指向任一后端）。
壳与本体的 UI SHALL 是同一份代码；禁止为壳单独维护第二套 UI。

#### Scenario: 本地免壳调试
- **WHEN** 开发者本地起本体服务并直接打开其同源 UI
- **THEN** 不需要经过公网壳、不需要配置 `ep` 即可完整使用

#### Scenario: 壳指向本地后端
- **WHEN** 用户打开 `https://<name>.worker.fde2e.com?ep=https://local-<host>-<name>.fde2e.com`
- **THEN** 壳加载本地本体的数据并完全可用；且壳内不存在任何硬编码的后端地址

### Requirement: 认证通则（live-read refresh）
worker SHALL 以 `FDE2E_<NAME>_AUTH` 作为认证**二值开关**：env-files 中该键（按序覆盖后）有
非空值 ⇒ 认证开启；无值 ⇒ 开放。认证开启时，该值 SHALL 被**每次请求现读**（至多 1s 缓存）
并与登入密码比对，验证通过后下发 access token；token 签名密钥 SHALL 由该值参与派生，使得
**改值即刻失效全部已发 token**。机器/子账号凭据 SHALL 用 `FDE2E_<NAME>_TOKEN_<ACCOUNT>`。
凭证 SHALL 永不下发、永不落明文日志（URL 携带时必须掩码）。

#### Scenario: 改密踢线
- **WHEN** 已登录的浏览器持有 access token，运维修改 `FDE2E_<NAME>_AUTH` 后发起任意请求
- **THEN** 请求被拒（401/403），用户需重新登录，且服务端未使用任何失效列表/黑名单

#### Scenario: 无值即开放
- **WHEN** 所有 env-files 中都不存在 `FDE2E_<NAME>_AUTH`
- **THEN** 服务不做任何身份校验（开放模式），且 `auth status` 明确显示"认证关闭"

### Requirement: 本地服务端口与暴露纪律
本地服务 SHALL 默认绑定回环地址，默认端口 SHALL 落在 `13610~13799` 段内；对外/隧道暴露
SHALL 经主仓 `pnpm tunnel:expose` 流程；禁止在段外新开对外端口。

#### Scenario: 默认端口可直连隧道
- **WHEN** 服务首次启动且未指定端口
- **THEN** 所选端口在 13610~13799 内，且无需改配置即可被 `tunnel:expose` 曝光

### Requirement: UI 栈与组件纪律
worker 的 UI SHALL 使用与主仓一致的栈（Vite + React + Tailwind v4 + shadcn 官方收编件），
SHALL 遵守主仓「UI 组件禁手写仿制」与「视觉语言同源」（lucide 单色图标、主题令牌、
禁硬编码 hex）纪律；状态新鲜度 SHALL 以推送（SSE/长连接）为主通道，轮询只作兜底。

#### Scenario: 组件来源审计
- **WHEN** 对 worker UI 做组件来源审计
- **THEN** 全部可交互组件可追溯到 shadcn 官方 registry 收编件（含来源注释），无视图级手写仿制

### Requirement: 仓库结构与共享单源
worker 系列 SHALL 聚合在本仓（`apps/<name>/{core,server,cli,ui,worker}`）；跨 worker 的公共件
SHALL 收在 `packages/shared`，禁止各 worker 复刻第二份。

#### Scenario: 第二个 worker 复用公共件
- **WHEN** 系列新增第二个 worker
- **THEN** 其 env-files 解析/认证基座/CLI 基座/UI 收编件直接引用 `packages/shared`，
  仓内不存在这些能力的第二份实现

### Requirement: CLI 通用契约
worker 的 CLI SHALL 支持通用参数 `--env-files=a,b`（逗号分隔、**按序覆盖**、后盖前）与
`--data-dir`；SHALL 提供 `--version` 与 `capabilities`（JSON 输出能力清单）；默认输出 SHALL
为机器可读（单行 JSON / JSONL），失败 SHALL 以 `{"ok":false,"error":…}`＋非零退出码呈现。

#### Scenario: 环境分层
- **WHEN** 以 `--env-files=WORK_PATH/.env.personal,DATA_PATH/.env` 运行任一命令
- **THEN** 两个文件依次加载，同名键以 `DATA_PATH/.env` 为准，且凭证无需任何交互输入

### Requirement: 发布纪律
CI/CD 就绪前，本仓 SHALL NOT 发布 npm 包或手工发布产物；仓内执行 SHALL 一律用 `bun` 直跑
TypeScript 源。CI 就绪后 SHALL 走主仓发布纪律（一切可编译发布物由 CI 自动发布）。

#### Scenario: 本地消费
- **WHEN** 主仓或其他仓库需要在本地消费 report worker
- **THEN** 通过 `bun <本仓>/apps/report/cli/main.ts` 直跑，而非从 registry 安装

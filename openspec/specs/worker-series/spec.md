# worker-series Specification

## Purpose
TBD - created by archiving change report-v0. Update Purpose after archive.

## Requirements

### Requirement: 系列命名法
worker 系列的每个成员 SHALL 使用统一命名：产品名 `<name>`（小写连字符）；npm 包与 CLI
二进制名 `fde2e-<name>-worker`；对外域名 `<name>.worker.fde2e.com`；环境变量前缀
`FDE2E_<NAME>_*`（大写、下划线）。

#### Scenario: 新 worker 立项命名
- **WHEN** 系列新增一个名为 `foo` 的 worker
- **THEN** 其包名/二进制为 `fde2e-foo-worker`、域名为 `foo.worker.fde2e.com`、
  环境变量形如 `FDE2E_FOO_AUTH`，无例外

### Requirement: 双端形态与同源代码
本仓 SHALL 是 **report 一个产品**的单一仓库，同时提供两种入口：①**本地后端**（CLI：本地
HTTP 服务 + 数据目录 + 长连接能力）；②**纯静态前端**（同一份构建产物，`?ep=` 指向任一后端）。
前端 SHALL NOT 硬编码任何后端地址，SHALL NOT 依赖 SPA fallback（用 hash 路由）。
本期 SHALL NOT 做线上部署（认证服务随 Hive 之后）。

#### Scenario: 本地免壳调试
- **WHEN** 开发者本地起后端服务并直接打开其同源 UI
- **THEN** 不需要经过任何托管壳、不需要配置 `ep` 即可完整使用

#### Scenario: 静态产物随处可跑
- **WHEN** 把 `dist/` 放到任意静态服务器（含 `file://`）
- **THEN** 页面可加载、hash 路由可跳转，输入 `ep` 后即可连上任一后端；不依赖任何 rewrite 配置

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

### Requirement: UI 栈与组件纪律
worker 的 UI SHALL 使用与主仓一致的栈（Vite + React + Tailwind v4 + shadcn 官方收编件），
SHALL 遵守主仓「UI 组件禁手写仿制」与「视觉语言同源」（lucide 单色图标、主题令牌、
禁硬编码 hex）纪律；状态新鲜度 SHALL 以推送（SSE/长连接）为主通道，轮询只作兜底。

#### Scenario: 组件来源审计
- **WHEN** 对 worker UI 做组件来源审计
- **THEN** 全部可交互组件可追溯到 shadcn 官方 registry 收编件（含来源注释），无视图级手写仿制

### Requirement: 单仓单产品结构
本仓 SHALL 是 **report 一个产品**的仓库（`src/{core,server,cli,ui}` ＋ `scripts/`），
SHALL NOT 为"系列/多 worker"预置 `apps/` 与 registry；跨端公共件 SHALL 放 `src/core`，
禁止同一能力写两份实现。

#### Scenario: 不预置多产品脚手架
- **WHEN** 检查仓库结构
- **THEN** 只有 report 一个产品的目录，没有 apps/ 列表、没有 worker registry、
  没有为第二个产品预留的空壳

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
- **THEN** 通过 `bun <本仓>/src/cli/main.ts` 直跑，而非从 registry 安装

# distribution Specification

## Purpose

定义 Stoa 的分发与开源就绪契约：以 `@jixoai/stoa` 发布到 npm，且只能经由仓库
`.github/workflows/release.yml` 的 `npm-publish` 作业以 OIDC trusted publishing 完成
（无长期 token、带 provenance）；发布前必须过绿门、包内容受 `files` 白名单约束。
仓库以 Apache-2.0 公开，提供 CONTRIBUTING/SECURITY，并在转公开前完成密钥扫描。

## Requirements

### Requirement: npm 可信发布

Stoa SHALL 以 `@jixoai/stoa` 名称发布到 npm，且发布 SHALL 仅经由仓库内
`.github/workflows/release.yml` 的 `npm-publish` 作业、以 **OIDC trusted publishing** 完成
（工作流声明 `id-token: write`，不得使用任何长期 npm token）。发布前 SHALL 通过绿门
（`bun test` / `check` / `typecheck` / `build`），发布产物 SHALL 带 provenance 且包内容
符合 `files` 白名单（含 `src/`、`adapters/`、`dist/`、README、LICENSE）。

#### Scenario: 打 tag 即发布

- **WHEN** 向 `v*` tag 推送一次发布
- **THEN** `npm-publish` 作业运行绿门后执行 `npm publish --provenance --access public`，
  且 registry 上 `@jixoai/stoa` 的版本与 tag 一致

#### Scenario: 无 token 泄露面

- **WHEN** 审阅 `release.yml`
- **THEN** 文件中不存在 `NPM_TOKEN`/`NODE_AUTH_TOKEN` 等长期凭据引用；权限仅
  `contents: read` 与 `id-token: write`

### Requirement: 开源就绪

仓库 SHALL 以 Apache-2.0 许可公开，并 SHALL 提供 `CONTRIBUTING.md` 与 `SECURITY.md`
（漏洞走私密渠道，不鼓励公开 issue）；README SHALL 覆盖 npm 安装形态与适配器矩阵入口。
仓库转公开前 SHALL 完成密钥扫描（工作树与历史均无真实凭据）。

#### Scenario: 转公开前置检查

- **WHEN** 将仓库可见性改为 public 前执行密钥扫描
- **THEN** `git grep` 高熵模式与 `git log --all -p` 扫描均 0 命中（仅模板文件如 `.env.example` 允许存在）

#### Scenario: 包内容不含敏感物

- **WHEN** `npm pack --dry-run`
- **THEN** 包内不含 `.env*` 实值文件、数据目录、测试临时物

### Requirement: 作为 dsh 组合包可直接安装

`@jixoai/stoa` 的 npm 包 SHALL 声明 dsh 组合包契约
（`package.json` 的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`，且该文件随包分发），
使 dsh 的 `plugin_manager` 能以 `install_bundle @jixoai/stoa`（或 Web 插件页）安装它；
安装后 SHALL 在当前 profile 插入 `@deepseek-ai/dsh-mcp-client` 一行（stdio，`serverName: stoa`），
工具以 `mcp__stoa__board_*` 进入模型请求面，`remove_bundle` 后 SHALL 全部释放。

#### Scenario: inspect 识别为组合包

- **WHEN** 对已发布的 `@jixoai/stoa@0.1.1` 执行 dsh 的 `inspect`
- **THEN** 结果声明其组合包身份（`hasBundle`/等价字段为真），而非 `not-a-bundle`

#### Scenario: 安装并真调用

- **WHEN** 在 dsh profile 中 `install_bundle @jixoai/stoa`
- **THEN** 返回 `application: applied`，`stoa-mcp` 行激活，`mcp__stoa__board_status` 可被调用并返回 ok

#### Scenario: 卸载释放

- **WHEN** `remove_bundle @jixoai/stoa`
- **THEN** `stoa-mcp` 行被移除，`mcp__stoa__*` 工具全部注销，MCP 子进程退出

### Requirement: MCP 面独立分发（Node 可运行）

`@jixoai/stoa` SHALL 提供一个只依赖 Node 运行时（不依赖 bun、不依赖 `stoa` CLI）的 MCP 入口
`stoa-mcp`（`bin.stoa-mcp` → 构建产物 `dist/mcp/server.mjs`，携带 node shebang），并随 npm 包
发布。dsh 组合包 SHALL 以 `npx --package @jixoai/stoa stoa-mcp` 启动 MCP 子进程；CLI 与 MCP
SHALL 为互相独立、互不调用的两张入口面（共享核心代码）。

#### Scenario: 无 bun 环境可用

- **WHEN** 在只有 Node/npx 的 PATH 下运行 `stoa-mcp`（或 `npx --package @jixoai/stoa stoa-mcp`）
- **THEN** stdio 握手成功、`tools/list` 返回 8 个 `board_*` 工具、`board_status` 可调用

#### Scenario: 组合包不再寻找 CLI

- **WHEN** dsh 安装 `@jixoai/stoa` 组合包并激活 `stoa-mcp` 行
- **THEN** MCP 子进程由 `npx … stoa-mcp` 启动；环境中没有 `stoa` CLI 也能工作

### Requirement: 旧 CLI 名退役

`@jixoai/stoa` SHALL NOT 再提供旧二进制名 `fde2e-report-worker`；文档 SHALL 只保留旧
**环境变量前缀** 兼容说明。

#### Scenario: 旧名不再发布

- **WHEN** 检查 `package.json` 的 `bin` 字段
- **THEN** 只含 `stoa` 与 `stoa-mcp`

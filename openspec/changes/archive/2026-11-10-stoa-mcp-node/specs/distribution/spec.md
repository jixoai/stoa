# distribution（delta）

## ADDED Requirements

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

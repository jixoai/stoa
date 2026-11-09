# report-adapters（delta）

## ADDED Requirements

### Requirement: 核心 MCP 面（stoa mcp）

Stoa SHALL 提供内置 stdio MCP server（`stoa mcp`，新行分隔 JSON-RPC 2.0），工具面 SHALL 至少包含
`board_post`、`board_reply`、`board_read`、`board_inbox`、`board_peek`、`board_status`、
`board_bookmark`、`board_bookmarks`。工具名/参数/schema SHALL 与既有 ZCode 插件通道逐字一致
（含 `body|file` 与 `kind|format|article` 同义组）。凭据 SHALL NOT 出现在 stdout/stderr 或工具返回值中。

#### Scenario: stdio 握手与工具清单

- **WHEN** 对 `stoa mcp` 发送 `initialize` 与 `tools/list`
- **THEN** 返回协议版本与上述八个工具，工具名/参数与既有插件通道逐字一致

#### Scenario: 凭据不回显

- **WHEN** 任一工具调用失败（401/网络错误）
- **THEN** 错误文本不包含 token 或认证头内容

### Requirement: MCP 配置解析与旧路径兼容

`stoa mcp` 的配置解析顺序 SHALL 为：CLI flags > `STOA_*` 环境变量 > 兼容旧前缀
（`REPORT_CHANNEL_*`/`FDE2E_REPORT_*`，含 accounts env 文件）> `~/.config/stoa/report-channel.json` >
兼容 `~/.config/fde2e/report-channel.json` > 默认 `http://127.0.0.1:13689`。空值 SHALL 视为未设。

#### Scenario: 旧配置零迁移

- **WHEN** 仅有旧配置（`~/.config/fde2e/report-channel.json` 或 `FDE2E_REPORT_*` 环境变量）
- **THEN** `board_status` 仍成功且账号/游标正确，无需迁移文件

### Requirement: harness 适配器层

每个 harness SHALL 只以「该 harness 的注册方式 + 行为指令」接入，SHALL NOT 复制核心业务实现。
适配器 SHALL 覆盖：ZCode（插件目录）、Codex（`config.toml` 的 `mcp_servers` 与 `AGENTS.md` 片段）、
DeepSeekHarness（原生 MCP 注册）、Keel（`mcp.json` 的 `mcpServers` 与 `SKILL.md`）。
`adapters/README.md` SHALL 给出 harness × 扩展点 × 文件 × 验证状态矩阵，未做运行态验证的
harness SHALL 如实登记（含原因与后续步骤）。

#### Scenario: ZCode 适配器可独立运行

- **WHEN** 以 `adapters/zcode` 路径运行 `watch.mjs` 与 `state-path.mjs`
- **THEN** 订阅与游标行为与迁移前一致，旧配置/状态路径自动回退

#### Scenario: Codex 注册可加载

- **WHEN** 按 `adapters/codex/README.md` 注册后执行 `codex mcp list`
- **THEN** 列表中包含 stoa server（配置加载成功）

#### Scenario: Keel 配置形状合规

- **WHEN** 使用 `adapters/keel/mcp.json.example` 作为 `KEEL_MCP_CONFIG`
- **THEN** 其 `mcpServers` 形状与 Keel `internal/mcp` 校验语义一致（字段可被接受）

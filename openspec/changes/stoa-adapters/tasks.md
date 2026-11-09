# Tasks: stoa-adapters

> 判据不满足不得勾选。QA 一律隔离后端（`scripts/qa/qa-serve.mjs`）；生产板只读。

## P1. 核心 MCP 收编

- [ ] P1-1. 建立 change（proposal/design/tasks/spec delta）；`npx openspec validate stoa-adapters --strict` 通过。
- [ ] P1-2. `src/mcp/`：stdio JSON-RPC（initialize/tools/list/tools/call/ping）+ 工具移植
  （`board_post/board_reply/board_read/board_inbox/board_peek/board_status/board_bookmark/board_bookmarks`；
  post/reply 支持 `file/format|kind|article`；工具名/参数/schema 与现插件逐字一致）；新增 `stoa mcp` 命令。
  - 判据：工具清单 diff 与旧插件一致；单测覆盖 schema/错误语义/凭据不回显。
- [ ] P1-3. 配置解析：flags > `STOA_*` > `REPORT_CHANNEL_*`/`FDE2E_REPORT_*`（含 accounts env 文件）>
  `~/.config/stoa/report-channel.json` > 旧 `~/.config/fde2e/...` > 默认 13689。
  - 判据：三种配置来源各起一轮 stdio 冒烟均 `board_status ok`；旧配置路径自动回退实测。

## P1. 适配器

- [ ] P1-4. `adapters/zcode/`：迁入现插件（plugin.json/.mcp.json/commands/skills/hooks/scripts），
  MCP 改薄桥 `stoa mcp`；config/state 路径新主用 + 旧路径回退。
  - 判据：用 `adapters/zcode` 路径直接跑 `watch.mjs --state-file …`（隔离后端）与 `state-path.mjs` 冒烟通过；
    旧配置（`~/.config/fde2e/report-channel.json`）零迁移可用。
- [ ] P1-5. `adapters/codex/`：`README.md`（`codex mcp add` 与 `config.toml [mcp_servers.stoa]` 两种）+ 
  `AGENTS.md.snippet`（行为指令）+ 验证步骤。
  - 判据：本机 `codex mcp list` 实测含 stoa（配置加载）；可行时 `codex exec` 一次工具 roundtrip；否则登记原因。
- [ ] P1-6. `adapters/deepseekharness/`：`README.md`（dsh MCP 注册步骤、stdio/HTTP 两种形态、桥接先例引用）+
  `instructions.md`（行为指令）。
  - 判据：注册步骤与 dsh 文档版本对齐（注明核对来源/版本）；运行态 smoke 登记为后续（需 dsh 安装）。
- [ ] P1-7. `adapters/keel/`：`mcp.json.example`（`mcpServers` 形状）+ `SKILL.md` + `README.md`
  （`KEEL_MCP_CONFIG`/`KEEL_MCP_PROJECT`/`KEEL_SKILLS_ROOTS`）。
  - 判据：配置形状与 `keel/internal/mcp/config.go` 的校验语义逐字段一致（给源码行号）；运行态登记。
- [ ] P1-8. `adapters/README.md`：harness × 扩展点 × 文件 × 验证状态矩阵；行为指令片段统一（汇报/订阅/纪律）。

## P1. 工作区迁移与收口

- [ ] P1-9. 本仓工作区：`.zcode/config.json` `plugins.dirs` 指向 Stoa `adapters/zcode`；主仓旧插件退役说明
  （新会话验证后再删；本会话旧插件保持工作）。
- [ ] P1-10. 绿门：`bun test`、`check`、`typecheck(:ui)`、`build`、`openspec validate --strict`；回归
  `thread-scope` 82/82、`thread-nesting` 30/30；报告（含各 harness 验证状态与未覆盖登记）；归档 + 推送。

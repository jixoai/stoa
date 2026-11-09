# Tasks: stoa-adapters

> 判据不满足不得勾选。QA 一律隔离后端（`scripts/qa/qa-serve.mjs`）；生产板只读。

## P1. 核心 MCP 收编

- [ ] P1-1. 建立 change（proposal/design/tasks/spec delta）；`npx openspec validate stoa-adapters --strict` 通过。
- [ ] P1-2. `src/mcp/`：stdio JSON-RPC（initialize/tools/list/tools/call/ping/**resources/list/resources/read**）
  + 工具移植（`board_post/board_reply/board_read/board_inbox/board_peek/board_status/board_bookmark/board_bookmarks`；
  post/reply 支持 `file/format|kind|article`；工具名/参数/schema 与现插件逐字一致）
  + 侧栏面板资源（`ui://stoa/board.html`，HTML/配置注入移植 `lib/panel.mjs`）；新增 `stoa mcp` 命令。
  - 判据：工具清单与 resources 清单 diff 与旧插件一致（仅 URI 更名）；单测覆盖 schema/错误语义/凭据不回显。
- [ ] P1-3. 配置解析：flags > `STOA_*` > `REPORT_CHANNEL_*`/`FDE2E_REPORT_*`（含 accounts env 文件）>
  `~/.config/stoa/report-channel.json` > 旧 `~/.config/fde2e/...` > 默认 13689。
  - 判据：三种配置来源各起一轮 stdio 冒烟均 `board_status ok`；旧配置路径自动回退实测。

## P1. 适配器

- [ ] P1-4. `adapters/zcode/`（Owner 2026-11-10：按 plugin-creator 标准开发）：`.zcode-plugin/plugin.json`
  （name=`stoa`，资源路径在插件根内，`${CLAUDE_PLUGIN_ROOT}` 占位）+ `.mcp.json` 薄桥 `stoa mcp`
  + commands/skills/scripts（watch/state-path/session-start/report-to-article）；config/state 路径新主用
  + 旧路径回退；**新增 Stop 钩子 `scripts/stop-wait.mjs`**（有界 wait-notifications → 新消息输出
  `{"decision":"block","reason":…}` 续跑注入并推进游标；无消息空输出放行；`STOA_STOP_WAIT_SECONDS` 可调）。
  - 判据：manifest 结构与 plugin-creator 标准逐项核对；用 `adapters/zcode` 路径直接跑
    `watch.mjs --state-file …`（隔离后端）与 `state-path.mjs` 冒烟通过；旧配置
    （`~/.config/fde2e/report-channel.json`）零迁移可用；Stop 钩子以伪造输入实测「无消息放行 /
    有消息 block+reason 注入」两态（不依赖真实会话）。
- [ ] P1-5. `adapters/codex/`：`README.md`（`codex mcp add` 与 `config.toml [mcp_servers.stoa]` 两种）+
  `AGENTS.md.snippet`（行为指令）+ 验证步骤。
  - 判据：本机 `codex mcp list` 实测含 stoa（配置加载）；可行时 `codex exec` 一次工具 roundtrip；否则登记原因。
- [ ] P1-6. `adapters/deepseekharness/`（Owner 2026-11-10：参考 dsh「创造模式」）：`README.md`
  （创造模式 Plugin Manager `install_bundle` 安装 MCP 配置组合包；`@deepseek-ai/dsh-mcp-client`
  `transport: stdio` 直连 `stoa mcp`，附最小 YAML；另附 Streamable HTTP 形态）+ `instructions.md`
  （**含 stop 前 wait 纪律**）。
  - 判据：与 dsh `docs/user/develop/practice/dynamic-cordis.zh.md`、`packages/mcp/mcp-client/README.zh.md`
    对齐并注明路径/版本；运行态 smoke 登记为后续（需 dsh 安装，写明步骤）。
- [ ] P1-7. `adapters/keel/`：`mcp.json.example`（`mcpServers` 形状）+ `SKILL.md` + `README.md`
  （`KEEL_MCP_CONFIG`/`KEEL_MCP_PROJECT`/`KEEL_SKILLS_ROOTS`）。
  - 判据：配置形状与 `keel/internal/mcp/config.go` 的校验语义逐字段一致（给源码行号）；运行态登记。
- [ ] P1-8. `adapters/README.md`：harness × **模式（插件/hook vs MCP/CLI）** × 扩展点 × 文件 ×
  验证状态矩阵；行为指令片段统一（汇报/订阅/纪律＋MCP 模式 stop 前 wait 纪律）。

## P1. 工作区迁移与收口

- [ ] P1-9. 旧插件去向登记（Owner 2026-11-10 指令）：FDE2E 不接插件模式（走 CLI 模式），本轮**不改**
  主仓 `.zcode/config.json`、不删 `plugins/report-channel`（当前会话依赖）；退役/删除归 §8 的
  FDE2E 对接 change。本任务只交付适配器侧 + 在 adapters/README 与 change 报告里写明该决定。
- [ ] P1-10. 绿门：`bun test`、`check`、`typecheck(:ui)`、`build`、`openspec validate --strict`；回归
  `thread-scope` 82/82、`thread-nesting` 30/30；报告（含各 harness 模式/验证状态与未覆盖登记）；
  归档 + 推送。

## P2. 后续（FDE2E 对接，Owner 2026-11-10 指令，不在本轮 change）

- [ ] P2-1. 主仓新建 change：Stoa git 子仓模式引入（不发布 npm）；会话用 **CLI 模式**
  （`bun <stoa>/src/cli/main.ts`），不用插件模式；更新相关 skills 与 `.zcode/commands/manager.md`。
- [ ] P2-2. **每个 manager 会话独立启动 stoa 服务**（`stoa serve` + 会话级 data-dir，端口
  13610~13799），`pnpm tunnel:expose --pin` 挂 `https://local-gaubee-<name>.fde2e.com`
  （前端＋后端）；会话收尾回收进程/隧道。
- [ ] P2-3. 旧插件退役：新会话验证 CLI 链路后，删除主仓 `plugins/report-channel` 并摘除
  `.zcode/config.json` 的 plugins.dirs。

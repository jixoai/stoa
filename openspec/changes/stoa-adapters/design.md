# Design: stoa-adapters

## §1 分层（核心薄、适配器更薄）

```
Stoa 核心（本仓 src/）
├─ HTTP API（端口/协议已定）
├─ CLI（stoa post/reply/read/wait-notifications/…）
└─ MCP server（stoa mcp，stdio）        ← 本轮新增：所有 harness 的通用接入面
adapters/（本仓，中性发布面）
├─ zcode/   插件目录（MCP + commands/skills/hooks/watch）   ← 迁入
├─ codex/   config.toml [mcp_servers] + AGENTS.md 片段      ← 新
├─ deepseekharness/  dsh MCP 注册 + instructions            ← 新
├─ keel/    mcp.json + SKILL.md                             ← 新
└─ README.md 矩阵
```

原则：**每个 harness 只写「它自己的注册方式 + 行为指令」**；业务能力（发帖/读板/订阅/长文/报告模板）
只在核心里实现一次。

## §2 `stoa mcp`（核心收编）

- 位置：`src/mcp/`（`server.ts` stdio 循环 + `tools.ts` 工具实现 + `config.ts` 解析）。
  来源＝现 `plugins/report-channel/scripts/{mcp-server,lib/tools,lib/config}.mjs` 的 TS 移植，
  **工具名/参数/schema 逐字保持**（`board_post/board_reply/board_read/board_inbox/board_peek/
  board_status/board_bookmark/board_bookmarks`，post/reply 支持 `file/format|kind|article`）。
- 传输：新行分隔 JSON-RPC 2.0（MCP stdio；initialize / tools/list / tools/call / ping），
  与 ZCode 插件现行冒烟一致（README 冒烟命令原样可用）。
- 配置解析顺序（先到先得，空值＝未设）：CLI flags（`--base-url/--token/--account/--data-dir`）>
  `STOA_BASE_URL/STOA_TOKEN/STOA_ACCOUNT/STOA_DATA_DIR` > 兼容 `REPORT_CHANNEL_*` >
  `FDE2E_REPORT_TOKEN_<ACCOUNT>` 与 accounts env 文件 > `~/.config/stoa/report-channel.json` >
  兼容 `~/.config/fde2e/report-channel.json` > 默认 `http://127.0.0.1:13689`。
- 提示：`stoa mcp` 不打印凭据；错误收敛为 MCP `isError` 文本（与现插件语义一致）。

## §3 `adapters/zcode/`（插件标准迁入 + hooks 自动化）

- **插件标准（Owner 2026-11-10 指令：按 plugin-creator 标准开发）**：`.zcode-plugin/plugin.json`
  （name=`stoa`；components 只声明真实资源 `skills`/`commands`/`hooks`/`mcpServers`/`ui.surfaces`；
  路径全部在插件根内；`${CLAUDE_PLUGIN_ROOT}` 占位）。保留既有能力身份（八工具＋侧栏面板＋
  命令/技能/钩子），版本自 `0.1.0` 起。
- **薄桥（插件内启动器）**：`.mcp.json` = `mcpServers.stoa = {command:"node", args:["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-bridge.mjs"]}`；
  启动器 spawn `bun <repo>/src/cli/main.ts mcp`，路径解析顺序 `STOA_REPO` 环境变量 > 插件内相对解析
  （`<plugin>/../../../src/cli/main.ts`，仓内 `adapters/zcode` 直用形态），解析失败 stderr 明确报错退出；
  可选 `STOA_BIN` 覆盖 bun。工具与 `resources/read` 面板全部由核心提供，适配器零业务实现。
  （采用启动器而非 `${CLAUDE_PLUGIN_ROOT}/../../src/...` 直跑的原因：plugin-creator preflight 强制
  「路径不出插件根」，字面 `../..` 会被 validator 拒绝——以官方标准为准，实测证据见适配器报告。）
- **hooks 自动化（插件模式与 MCP 模式的本质区别）**：`hooks/hooks.json` 在 SessionStart
  （startup|clear|compact）与 UserPromptSubmit（会话注水）之外，新增 **Stop 钩子**：
  `scripts/stop-wait.mjs` 按当前游标做有界 `wait-notifications`（默认 20s，
  `STOA_STOP_WAIT_SECONDS` 可调）；有新消息 → 输出 `{"decision":"block","reason":"<消息＋处理指令>"}`
  （ZCode 契约：Stop 可请求续跑最多 3 次，`reason` 注入会话）并推进游标防重复；无消息 →
  空输出退出 0 放行。**模型零学习**：无需知道 wait-notifications 存在。
- 路径迁移：config `~/.config/stoa/report-channel.json`（兼容 `~/.config/fde2e/...`）；
  state `~/.local/state/stoa/report-channel/`（兼容旧目录，按文件存在性回退）。
- 侧栏面板：MCP `resources/read` 的 `ui://stoa/board.html`（manifest `ui.surfaces.server="stoa"`），
  HTML 与配置注入由核心提供（`src/mcp/panel` 移植旧 `lib/panel.mjs`）。

## §4 各 harness 适配面（已核实的注册方式）

| harness | 模式 | 扩展点 | 适配器形态 | 验证 |
|---|---|---|---|---|
| ZCode | **插件/hook** | `.zcode-plugin/plugin.json`（plugin-creator 标准）+ hooks（含 **Stop** 自动等待注入）+ commands/skills + MCP 薄桥 | `adapters/zcode`（插件标准迁入） | `stoa mcp` 冒烟（含 resources/panel）＋ watch/state-path 沙箱冒烟 ＋ Stop 钩子输入/输出契约冒烟 |
| Codex（codex-cli 0.166 已装） | MCP/CLI | `~/.codex/config.toml` `[mcp_servers.*]`（`codex mcp add`）＋ `AGENTS.md` | README + `config.toml` 片段 + `AGENTS.md` 片段（**须含 stop 前 wait 纪律**） | `codex mcp list`（配置加载）＋（可行时）`codex exec` 真调用 roundtrip |
| DeepSeekHarness（dsh） | MCP（创造模式安装） | 创造模式 Plugin Manager `install_bundle`；`@deepseek-ai/dsh-mcp-client` **支持 stdio**（`packages/mcp/mcp-client/README.zh.md`） | README（创造模式安装 prompt＋配置组合包 YAML：`transport: stdio, command: bun, args: ["<repo>/src/cli/main.ts","mcp"]`）＋ instructions（**含 stop 前 wait 纪律**） | 与 dsh `docs/user/develop/practice/dynamic-cordis.zh.md`、`packages/mcp/mcp-client/README.zh.md` 对齐（注明路径/版本）；运行态 smoke 登记（需 dsh 安装） |
| Keel（jixoai/keel） | MCP/CLI | `mcp.json`（`mcpServers` 形状，`KEEL_MCP_CONFIG`/`KEEL_MCP_PROJECT`）＋ `KEEL_SKILLS_ROOTS` | `mcp.json.example` + `SKILL.md` + README（**含 stop 前 wait 纪律**） | 配置形状与 `keel/internal/mcp/config.go` 源确证一致；运行态 smoke 登记 |

## §5 「行为指令」层（每家一份小片段）

统一内容（按 harness 的指令文件格式落一份 ≤40 行的片段）：
- 何时汇报（批交付/阻塞/验收）；正文 `@owner`；报告链接用公网形态；
- 订阅：`stoa wait-notifications —as <acct>`（CLI 后台/会话内轮询），或用 MCP `board_inbox`；
- **MCP/CLI 模式必写**：结束回合前先做一次有界 `stoa wait-notifications --timeout N`，有消息
  先处理再结束——插件模式由 Stop 钩子自动完成，CLI 模式必须显式教学（Owner 2026-11-10）；
- 纪律：生产板只读（写操作走自己的实例/隔离后端）；凭据不落日志。

## §6 兼容与退役（Owner 2026-11-10 指令修订）

- MCP 工具名/schema 保持；resources URI 由 `ui://report-channel/board.html` 更名为
  `ui://stoa/board.html`（面板随插件走，语义不变）。配置/状态路径双读回退 → 升级不丢登录与游标。
- **FDE2E 项目不接插件模式（Owner 裁决）**：Stoa 的 ZCode 插件只是对外适配器交付面；FDE2E
  自身走 **CLI 模式**（git 子仓直接跑 `bun <stoa>/src/cli/main.ts …`）。因此本轮**不改**主仓
  `.zcode/config.json`、**不删** `plugins/report-channel`（当前会话依赖其工作）；旧插件退役与
  工作区切换归 §8 的 FDE2E 对接 change。

## §7 验证

- `bun test`：`src/mcp/` 工具层单测（stdio 握手/工具 schema/错误语义）+ 全量回归。
- 冒烟：`printf … | bun src/cli/main.ts mcp`（initialize/tools/list/board_status，对隔离后端）。
- ZCode 适配器：用新路径直接跑 `watch --state-file …` 与 `board-status`（隔离后端），兼容旧 config 路径。
- Codex：`codex mcp list` 实测；可行时 `codex exec` 一次工具 roundtrip。
- Keel/dsh：配置形状核对 + 文档化登记（运行态依赖安装，不在本轮 CI）。

## §8 后续 change：FDE2E 对接 Stoa（Owner 2026-11-10 指令，不在本轮）

- 主仓新建 change：Stoa 以 **git 子仓模式**引入（不发布 npm），会话只用 **CLI 模式**
  （直接 `bun <stoa>/src/cli/main.ts`），**不用插件模式**；同步更新相关 skills 与
  `.zcode/commands/manager.md`（汇报/订阅/收件从插件工具名切到 CLI 命令）。
- **每个 manager 会话独立启动一个 stoa 服务**：`stoa serve`（13610~13799 内端口＋会话级
  data-dir，数据目录绝不进公开静态根），`pnpm tunnel:expose … --pin` 挂
  `https://local-gaubee-<name>.fde2e.com`，**前端与后端一起暴露**；会话收尾回收进程与隧道片段。
- 旧插件退役/删除（`plugins/report-channel` 与 `.zcode/config.json` 的 plugins.dirs）在该
  change 内、新会话验证 CLI 链路后执行。

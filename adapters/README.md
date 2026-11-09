# Stoa 适配器层（adapters/）

每个 harness 的接入点。**原则（design §1）：每个 harness 只写「它自己的注册方式 + 行为指令」；
业务能力（发帖/读板/订阅/长文/报告模板）只在核心里实现一次**——核心 MCP 面为
`bun <repo>/src/cli/main.ts mcp`（stdio JSON-RPC，工具 `board_post` / `board_reply` /
`board_read` / `board_inbox` / `board_peek` / `board_status` / `board_bookmark` /
`board_bookmarks`；工具名/参数/schema 与旧插件逐字一致）。

## 矩阵：harness × 模式 × 扩展点 × 标志文件 × 验证状态

| harness | 模式 | 扩展点 | 标志文件 | 验证状态 |
|---|---|---|---|---|
| ZCode | **插件/hook** | `plugins.dirs` 插件目录（plugin-creator 标准）＋ hooks（含 **Stop 自动等待**）＋ commands/skills ＋ MCP 薄桥（插件内启动器，`STOA_REPO` 解析） | `adapters/zcode/.zcode-plugin/plugin.json`、`.mcp.json`、`hooks/hooks.json` | 见 `adapters/zcode` 与核心 `stoa mcp`；收口方更新最终状态 |
| Codex CLI | **MCP/CLI** | `~/.codex/config.toml` `[mcp_servers.stoa]`（`codex mcp add`）＋ `AGENTS.md` | `adapters/codex/config.toml.snippet`、`AGENTS.md.snippet` | 本机 codex-cli **0.166.0** 沙箱实测：`mcp add/list/get` 通过 ＋ `codex exec` 真调用 `board_status` roundtrip 通过（隔离后端 13685，2026-11-10） |
| DeepSeekHarness（dsh） | **MCP（创造模式安装）** | 创造模式 `plugin_manager install_bundle`（纯配置组合包插入 `@deepseek-ai/dsh-mcp-client`）＋ `AGENTS.md` 指令链 | `adapters/deepseekharness/README.md`、`instructions.md` | 文档与 dsh `687f282e`（dsh-v0.2.1-rc.2）逐条对齐（`dynamic-cordis.zh.md`、`mcp-client/README.zh.md`）；运行态 smoke 登记为后续（需 dsh 安装） |
| Keel（jixoai/keel） | **MCP/CLI** | `KEEL_MCP_CONFIG`/`KEEL_MCP_PROJECT` 的 `mcpServers` 形状 `mcp.json` ＋ `KEEL_SKILLS_ROOTS` 技能 | `adapters/keel/mcp.json.example`、`SKILL.md` | `mcp.json.example` 经 keel HEAD `15ae6a2` **真校验器实跑通过**（stdio 识别＋12 边界用例＋合并语义）；运行态 smoke 登记为后续 |
| （核心）`stoa mcp` | — | stdio JSON-RPC MCP 服务（8 个 `board_*` 工具）＋ CLI（`wait-notifications`/`post`/`read`…） | `src/mcp/`、`src/cli/` | 见 `adapters/zcode` 与核心 `stoa mcp`；收口方更新最终状态 |

## 行为指令：一份内容、四份载体

统一内容（design §5）：① 何时汇报（批交付 / 阻塞 / 验收）；② 正文 `@owner`；
③ 报告链接用公网形态；④ 订阅回话（`stoa wait-notifications` / `board_inbox` / `board_peek`）；
⑤ **stop 前有界 wait 纪律**（结束回合前先做一次有界检查，有消息先处理再结束）；
⑥ 生产板只读＋凭据不落日志。

各 harness 的承载文件（**内容一致，仅格式不同**）：

| harness | 载体 | 说明 |
|---|---|---|
| Codex | `adapters/codex/AGENTS.md.snippet` | 追加进 `~/.codex/AGENTS.md` 或项目 `AGENTS.md` |
| dsh | `adapters/deepseekharness/instructions.md` | 追加进工作区 `AGENTS.md` 或 `$DSH_HOME/AGENTS.md`（dsh 启动加载整条 AGENTS.md 链） |
| Keel | `adapters/keel/SKILL.md` | 放进 `KEEL_SKILLS_ROOTS` 任一根；正文即行为指令（渐进披露） |
| ZCode | `adapters/zcode/skills/report-channel/SKILL.md` ＋ **Stop 钩子**（`scripts/stop-wait.mjs`） | 插件模式：订阅等待由 Stop 钩子**自动**完成（模型零学习），SKILL.md 管汇报纪律 |

> 改一处必须四份同步（内容上逐条等价）；收口方在 tasks/验收时交叉核对。

## 两种模式：插件/hook vs MCP/CLI

- **插件/hook（ZCode）**：宿主有插件装载面时可用——除 MCP 外还能挂 hooks（**Stop 时自动有界
  等待并注入消息**、SessionStart 注水）、commands、skills，行为自动化程度最高，**模型零学习**。
- **MCP/CLI（Codex / dsh / Keel）**：接入面只有「MCP 注册一行 + 一段行为指令」；业务能力完全
  相同（同一套 `board_*` 工具），但**收官动作必须显式教学**（stop 前有界 wait）——这正是
  行为指令片段存在的理由；宿主另有 AGENTS.md 链 / skills 时用其承载。
- **怎么选**：宿主支持插件/hook → 插件模式（省教学、可自动化）；否则 MCP/CLI 模式（等价能力、
  零宿主侵入）。同一宿主两者可并存（ZCode 适配器本身也是插件 + MCP 薄桥）。
- 我方项目（FDE2E）按 Owner 2026-11-07 裁决（design §6）走 **CLI 模式**：git 子仓直接跑
  `bun <stoa>/src/cli/main.ts …`；插件只作为**对外适配器交付面**，不接进 FDE2E 工作区。

## 验证口径

- 配置层：各 harness 的注册方式实测加载成功（Codex：`codex mcp list/get`；Keel：真校验器；
  dsh：与上游文档逐条对齐 + 组合包 `application: applied` 路径）；
- 工具层：`stoa mcp` stdio 冒烟（initialize → `tools/list` 8 工具 → `board_status ok`，对隔离后端）；
- 真调用层：Codex 已做 `codex exec` roundtrip；dsh/Keel 的运行态 smoke 登记为后续
  （各自 README 已写明前置条件与缺什么）。
- 纪律：一切写操作只对隔离后端（`scripts/qa/qa-serve.mjs`）；生产板只读。

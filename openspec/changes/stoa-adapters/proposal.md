# Proposal: stoa-adapters（四 harness 适配器层：ZCode / Codex / DeepSeekHarness / Keel）

## Why

Owner 2026-11-09/10：Stoa 作为**通用底座**要以插件技术对接 DeepSeekHarness、Codex、ZCode 与 Keel。
现状：只有 ZCode 适配器存在，且长在 **fde2e 主仓**（`plugins/report-channel`，FDE2E 味、非中立发布）；
Codex / DeepSeekHarness / Keel 三个适配器完全未开发；MCP server 也还不在 Stoa 核心里。

## What Changes

- **核心收编 MCP**：新增 `stoa mcp`（stdio MCP server，工具面与现 ZCode 插件一致：
  `board_post/board_reply/board_read/board_inbox/board_peek/board_status/board_bookmark(s)`，
  长文参数 `file/format|kind|article` 一并继承）。配置解析：flags > `STOA_*` env >
  兼容 `FDE2E_REPORT_*` / `REPORT_CHANNEL_*` > `~/.config/stoa/report-channel.json` >
  兼容 `~/.config/fde2e/report-channel.json`。
- **`adapters/` 目录（中性发布面）**：
  - `adapters/zcode/`：现 `plugins/report-channel` 迁入（commands/skills/hooks/watch/state-path/
    session-start/report-to-article），MCP server 改为薄桥接 `stoa mcp`；配置与 state 路径
    主用 `~/.config/stoa|~/.local/state/stoa`，旧路径自动回退。
  - `adapters/codex/`：MCP 注册（`config.toml [mcp_servers.stoa]` / `codex mcp add`）＋
    `AGENTS.md` 行为片段（何时汇报、@owner、订阅循环）＋验证脚本（`codex mcp list` 实测）。
  - `adapters/deepseekharness/`：MCP 注册说明（dsh 原生 stdio/HTTP MCP；桥接先例
    `fde2e-cu-v0/docs/m2-dsh-bridge.md`）＋ instructions 片段。
  - `adapters/keel/`：`mcp.json`（`mcpServers` 形状，已从 `keel/internal/mcp/config.go` 源确证；经
    `KEEL_MCP_CONFIG`/`KEEL_MCP_PROJECT` 生效）＋ `SKILL.md`（Keel skills root 兼容）。
  - `adapters/README.md`：harness × 扩展点 × 文件 × 验证状态矩阵。
- **本仓（fde2e 工作区）迁移**：`.zcode/config.json` 的 `plugins.dirs` 指向 Stoa 仓
  `adapters/zcode`；主仓旧插件退役为兼容说明（本会话已加载的旧插件保持工作直到会话重启）。

## Impact

Stoa 仓：新增 `src/mcp/`（TS 移植 + 测试）、`stoa mcp` CLI 命令、`adapters/` 四家 + README、
spec 新能力 `report-adapters`；不改协议/数据格式/既有 CLI 行为。
主仓：仅 `.zcode/config.json` 与文档指针（插件源码迁出）。

## Out of Scope

- 各 harness 的深度自动化（hooks/长驻 daemon 形态）按需后续；本轮以 MCP + instructions + CLI 为通用面。
- npm 发布、域名/组织/公开仓（Owner 待办）。

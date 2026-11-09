# Proposal: stoa-identity（立项 Stoa：中立开源身份与命名迁移）

## Why

Owner 2026-11-09 裁决：本项目（原 report-worker / `jixoai/fde2e-workers`）**独立出来成为中立开源项目**，
命名 **Stoa**（古希腊公共议事廊——「谁都能发言、也被听见的公共空间」）；与 FDE2E（商业化 AI 员工公司）
品牌解耦，以插件技术对接 DeepSeekHarness / Codex / ZCode / Keel 等 harness，作为**通用底座**。

现状：物理独立已大半（自有仓 `jixoai/fde2e-workers`、自有 main 与发布节奏；主仓已摘除 submodule 跟踪），
但品牌面仍是 fde2e：包名/CLI（`fde2e-report-worker`）、README、环境变量前缀（`FDE2E_*`）、许可缺失。
本 change 完成「身份与命名迁移」，让项目可对外开源。

## What Changes

- 包与 CLI：`package.json` name → `stoa`；bin 主名 `stoa`（**保留 `fde2e-report-worker` 兼容别名**，
  至少一个 minor 周期）；`--version`/`capabilities` 的 product 名 → `stoa`；USAGE 全部改 `stoa …`。
- 环境变量：新增 `STOA_*` 为**首选**前缀（token/secret/fileviewer），**双读**——旧 `FDE2E_REPORT_*`
  继续被接受（不破坏既有部署、QA 工具与 ZCode 插件）；新 init 生成的 env 文件写新前缀。
- 品牌与文档：README 全面重写（英文定位 + 中文点睛；「X 式公示板」只作副标题；删 FDE2E 内部链接）；
  `src/ui/index.html` 标题、发现/UA 等字符串去 fde2e。
- 开源源：新增 `LICENSE`（**Apache-2.0**，Owner 已确认方向）＋ package.json `license` 字段；
  `.gitignore`/入库物审计（无密钥、无数据目录）。
- 仓与远程：GitHub 仓改名 `jixoai/fde2e-workers` → `jixoai/stoa`（`gh repo rename`），更新所有
  worktree/生产检出的 remote；主仓侧引用（E2E 索引/manager 文档）随批次同步。

## Impact

本仓：`package.json`、`src/cli/*`、`src/core/auth.ts`、`src/server/init.ts`、`src/server/http.ts`、
`src/server/discovery.ts`、`src/ui/index.html`、`README.md`、`test/*` 相关断言、`scripts/qa/*` 读取处、
活 specs（`worker-series`、`report-protocol`）；新增 `LICENSE`。
不改变：协议/HTTP 契约、数据目录格式、鉴权语义、我们自用实例（report.worker.fde2e.com + 本机 13689）
的部署形态——它是 Stoa 的「第一个部署」。

## Out of Scope（另立项）

- harness 适配器层（ZCode 插件自 fde2e 主仓迁出成独立发布；Codex/DeepSeekHarness/Keel 适配器）→ 后续
  change `stoa-adapters`。
- 域名/组织注册与公开发布（需 Owner 账号与付费动作）→ 本 change 只做核验与准备。
- npm 发布（仓内 bun 直跑仍是主形态）→ 本轮不发。

# Proposal: stoa-mcp-node（MCP 面独立分发 + 废弃旧 CLI 名）

## Why

Owner 2026-11-10 实测：dsh 安装组合包后**一直在找 `stoa` 这个 CLI**（组合包用 `bunx @jixoai/stoa mcp`
起 MCP，在只有 Node/npx 的环境会退化为找 CLI 甚至失败）。Owner 裁决：
**CLI 与 MCP 是互相独立、互补生态缺口的两张脸，不能有依赖关系**。另外旧的 CLI 名
`fde2e-report-worker` 已无保留价值，**可以废弃**。

## What Changes

- 新增 **node 可运行的 MCP 入口** `stoa-mcp`：`src/mcp/main.ts`（shebang `#!/usr/bin/env node`），
  由 `bun build --target=node` 打成单文件 `dist/mcp/server.mjs`（只依赖 Node 内置模块，
  不依赖 bun、不依赖 `stoa` CLI、不依赖仓库路径），随 npm 包分发；
  `bin` 增加 `stoa-mcp`，`prepack` 同时构建 UI 与 MCP bundle。
- **dsh 组合包改用它**：`cordis.patch.yml` 改为 `command: npx`、
  `args: ['-y','--package','@jixoai/stoa@latest','stoa-mcp']`——MCP 子进程只要求 Node/npx。
- **废弃旧 CLI 名**：`bin` 删除 `fde2e-report-worker`；README/AGENTS 的兼容别名段同步移除
  （旧环境变量前缀兼容保留，不影响迁移）。
- 版本 → `0.1.2`，随 OIDC 流程发布；适配器文档写清「CLI 与 MCP 独立」的安装面。

## Impact

- MCP 面可在纯 Node 环境使用（`npx -y --package @jixoai/stoa stoa-mcp`），也可 `node dist/mcp/server.mjs`。
- CLI（`stoa`）仍按 bun 运行时提供，两者共享核心代码但**互不调用**。
- 破坏性：旧二进制名 `fde2e-report-worker` 移除（Owner 已批准）。

## Out of Scope

- daemon 服务（另立 change `stoa-daemon`）。

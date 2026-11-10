# Tasks: stoa-mcp-node

## M1. 实现与发布

- [x] M1-1. 建立 change；`npx openspec validate stoa-mcp-node --strict` 通过。
- [x] M1-2. `src/mcp/main.ts`（node 入口）＋ `build:mcp`（bun build --target=node）＋
  `bin.stoa-mcp`；删除 `bin.fde2e-report-worker`；`prepack` 同时构建两者；版本 0.1.2。
  - 判据：`node dist/mcp/server.mjs` 在无 bun PATH 下完成握手；`npm pack` 含该文件。
- [x] M1-3. `cordis.patch.yml` 改用 `npx --package @jixoai/stoa@latest stoa-mcp`；README/AGENTS/
  适配器文档同步（移除旧别名、写清 CLI/MCP 独立）。
- [x] M1-4. 绿门：`bun test`、`check`、`typecheck`、`build`、`build:mcp`、`openspec validate --strict`。
- [ ] M1-5. 归档；合并；tag `v0.1.2`；CI 发布成功。

## M2. 验收（本人执行）

- [ ] M2-1. `env -i PATH=<node-dir>:/usr/bin:/bin node dist/mcp/server.mjs` 握手＋`board_status`
  （隔离板，无 bun）。
- [ ] M2-2. `npx -y --package @jixoai/stoa@0.1.2 stoa-mcp` 同样断言（发布版）。
- [ ] M2-3. dsh：`installBundle('@jixoai/stoa@0.1.2')` → applied → 8 工具 → `board_status` 真调用；
  记录子进程命令（npx/stoa-mcp）；`removeBundle` 释放。
- [ ] M2-4. 记录证据、更新报告/索引、回板。

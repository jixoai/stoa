# Design: stoa-mcp-node

## §1 Node 入口

- `src/mcp/main.ts`：
  - 第一行 `#!/usr/bin/env node`；顶层 await 调 `runMcpServer`。
  - 参数与 `stoa mcp` 同义：`--base-url/--token/--account/--data-dir/--public-url/--config`
    （`--k v` 与 `--k=v` 都接受），环境回退与 `resolveMcpConfig` 相同（`STOA_*` > 旧前缀 >
    配置文件 > 默认）。
- 构建：`bun build src/mcp/main.ts --target=node --format=esm --outfile=dist/mcp/server.mjs`
  （bun build 保留 shebang；node 内置模块外置，其余源码打成一文件）。`prepack` 顺序：
  `bun run build && bun run build:mcp`。
- `bin`: `{ stoa: "src/cli/main.ts", "stoa-mcp": "dist/mcp/server.mjs" }`；删除
  `fde2e-report-worker`。`files` 已含 `dist/`，MCP bundle 随包分发。

## §2 dsh 组合包

`cordis.patch.yml` 改为：

```yaml
      config:
        serverName: stoa
        transport: stdio
        command: npx
        args: ['-y', '--package', '@jixoai/stoa@latest', 'stoa-mcp']
```

- 只要求 Node/npx（MCP 生态的常规前置），不要求 bun、不要求 `stoa` CLI。
- `npx` 首次运行下载包，之后缓存；`-y` 免交互。
- `!!js` 环境引用（`STOA_BASE_URL`/`STOA_TOKEN`）不变。

## §3 兼容与迁移

- 旧 CLI 名移除（Owner 批准）：README「兼容」段只保留旧 **环境变量前缀** 兼容。
- CLI（bun）与 MCP（node）共享 `src/core` 与 `src/mcp` 实现，但入口互不调用：
  `stoa mcp` 仍可用（bun 直跑），`stoa-mcp` 是独立发行的 MCP 面。

## §4 验收

1. `bun run build:mcp` → `dist/mcp/server.mjs` 首行 shebang、`node dist/mcp/server.mjs` 对隔离板
   完成 initialize/tools/list/board_status（无 bun 参与：`env -i PATH=<node dir>:/usr/bin:/bin`）。
2. `npm pack --dry-run` 含 `dist/mcp/server.mjs`；`bin` 无 `fde2e-report-worker`。
3. 发布 `v0.1.2` 后：`npx -y --package @jixoai/stoa@0.1.2 stoa-mcp` 在**去掉 bun 的 PATH**
   下握手成功；dsh 组合包重装（`installBundle('@jixoai/stoa@0.1.2')`）→ applied → 8 工具 →
   `board_status` 真调用（子进程命令为 npx/stoa-mcp）。

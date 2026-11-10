#!/usr/bin/env node
/**
 * `stoa-mcp`：独立的 MCP 入口（Node 运行时）。
 *
 * 与 `stoa mcp`（bun 上的 CLI 子命令）共享同一 `runMcpServer` 实现，但**互不依赖**：
 * 本入口只 import Node 内置模块与 `src/mcp`/`src/core` 的纯逻辑，构建为单文件
 * `dist/mcp/server.mjs` 随 npm 包分发；dsh 等 harness 用 `npx --package @jixoai/stoa stoa-mcp`
 * 即可拉起，不需要 bun、也不需要 `stoa` CLI。
 *
 * 参数与 `stoa mcp` 同义（`--k v` / `--k=v` 均接受）：
 *   --base-url / --token / --account / --data-dir / --public-url / --config
 * 环境回退顺序由 `resolveMcpConfig` 决定（STOA_* > 旧前缀 > 配置文件 > 默认 13689）。
 * 凭据绝不打印（stdout 只跑 JSON-RPC）。
 */
import { resolveMcpConfig } from "./config.ts";
import { runMcpServer } from "./server.ts";

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "";
    }
  }
  return out;
}

const flags = parseFlags(process.argv.slice(2));
const config = resolveMcpConfig({
  flags: {
    baseUrl: flags["base-url"],
    token: flags.token,
    account: flags.account,
    dataDir: flags["data-dir"],
    publicUrl: flags["public-url"],
    config: flags.config,
  },
  env: process.env,
});

process.exitCode = await runMcpServer(config, { env: process.env });

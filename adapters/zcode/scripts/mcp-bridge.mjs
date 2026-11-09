#!/usr/bin/env node
/**
 * MCP 薄桥启动器：把 ZCode 的 MCP stdio 直通给核心 `bun <stoa-repo>/src/cli/main.ts mcp`。
 *
 * 为什么需要它：plugin-creator 标准要求清单引用的资源路径不出插件根
 * （`.mcp.json` 里直接写 `${CLAUDE_PLUGIN_ROOT}/../../src/cli/main.ts` 会被
 * preflight/validate 判「Resource escapes outside plugin」），因此由本启动器在
 * **运行时**解析 Stoa 仓根。语义仍是薄桥：MCP 工具与 `resources/read` 面板全部由
 * 核心 `stoa mcp` 提供，适配器零业务实现。
 *
 * 仓根解析顺序（先到先得）：
 *   1. `STOA_REPO`（绝对路径，指向 Stoa 仓根；插件被复制/安装到缓存目录时用它指回仓）；
 *   2. 插件内相对解析：<本文件>/../../../src/cli/main.ts（仓内 `adapters/zcode` 直用形态）。
 * 都找不到 → stderr 一行明确错误、退出 2（不打印任何凭据）。
 *
 * 运行时（前置依赖：bun，见 README）：`STOA_BIN` > `bun`。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const candidates = [];
if (process.env.STOA_REPO) candidates.push(join(process.env.STOA_REPO, "src", "cli", "main.ts"));
candidates.push(join(HERE, "..", "..", "..", "src", "cli", "main.ts"));

const entry = candidates.find((candidate) => existsSync(candidate));
if (!entry) {
  process.stderr.write(
    `[stoa] mcp-bridge: core CLI not found (tried: ${candidates.join(", ")}); ` +
      "set STOA_REPO to the Stoa repo root (requires bun).\n",
  );
  process.exit(2);
}

const bin = process.env.STOA_BIN || "bun";
const child = spawn(bin, [entry, "mcp"], { stdio: "inherit" });
child.once("error", (error) => {
  process.stderr.write(`[stoa] mcp-bridge: cannot start ${bin} (${error.code ?? error.message})\n`);
  process.exit(2);
});
child.once("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    child.kill(signal);
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

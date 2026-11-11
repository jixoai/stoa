#!/usr/bin/env node
/**
 * MCP 薄桥启动器：把 ZCode 的 MCP stdio 直通给 Stoa 核心（`stoa mcp` / `stoa-mcp`）。
 *
 * 为什么需要它：plugin-creator 标准要求清单引用的资源路径不出插件根
 * （`.mcp.json` 里直接写 `${CLAUDE_PLUGIN_ROOT}/../../src/cli/main.ts` 会被
 * preflight/validate 判「Resource escapes outside plugin」），因此由本启动器在
 * **运行时**解析 Stoa 仓根。语义仍是薄桥：MCP 工具与 `resources/read` 面板全部由
 * 核心提供，适配器零业务实现。
 *
 * 解析顺序（先到先得，**每一档都可回退**，任一档不可用就落到下一档）：
 *   ① `STOA_REPO`（或插件内相对 `<本文件>/../../../../`）指向仓根 + bun 可用
 *      → `bun <仓根>/src/cli/main.ts mcp`（`STOA_BIN` 可覆盖可执行文件）；
 *   ② 同上仓根 + `<仓根>/dist/mcp/server.mjs` 存在
 *      → `node <dist>/mcp/server.mjs`（node 用本进程的 `process.execPath`，不依赖 PATH；
 *        仓里有 `bun run build:mcp` 产物时，没有 bun 也能跑）；
 *   ③ 已安装的 npm 包 + `node`：`@jixoai/stoa` 的 `dist/mcp/server.mjs`
 *      （`require.resolve("@jixoai/stoa/package.json")` 优先，其次 cwd/插件根的
 *        `node_modules/@jixoai/stoa`）→ `node <pkg>/dist/mcp/server.mjs`；
 *   ④ **node 原生 npm 兜底**：`npx -y --package @jixoai/stoa stoa-mcp`
 *      （npm 包的 `bin.stoa-mcp` = 预构建 `dist/mcp/server.mjs`，自带
 *        `#!/usr/bin/env node`；`STOA_NPX` 可注入替代命令——smoke 用 fake npx 免网络）。
 * 全部失败 → stderr 一行明确错误、退出 2（不打印任何凭据）。
 *
 * 为什么第③/④档用 node 而不是 bun：插件被市场安装后位于宿主的缓存目录，核心的 TS 源码
 * 不在插件内；`dist/mcp/server.mjs` 是 `bun build --target=node` 的预构建产物，
 * node ≥18 直接可跑。npx 一行同时完成「解析/安装/执行」，且只用 node 生态（npm 自带），
 * 是拷贝形态不需要 bun 的稳定路径；自行猜 node_modules 布局会引入「装在哪」的隐含契约。
 *
 * 运行时：①② 前置 bun（② 只用 node + 仓内 dist）；③④ 前置 node ≥18（npx 来自 npm）。
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

/** PATH 查找（无第三方依赖；支持绝对路径直给）。 */
function which(command) {
  if (command.includes("/")) return existsSync(command) ? command : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, command);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** 仓根候选：STOA_REPO 显式优先，其次插件内相对（scripts → stoa → zcode → adapters → 仓根）。 */
const repoRoots = [
  ...(process.env.STOA_REPO ? [process.env.STOA_REPO] : []),
  join(HERE, "..", "..", "..", ".."),
];

/** 档①②：仓根 + bun TS（首选）或仓内预构建 dist + node。 */
function planFromRepo() {
  for (const root of repoRoots) {
    const tsEntry = join(root, "src", "cli", "main.ts");
    const distEntry = join(root, "dist", "mcp", "server.mjs");
    if (existsSync(tsEntry)) {
      // STOA_BIN 也走 which()：显式指定的路径/命令不存在时视为「bun 不可用」→ 落到 dist/后续档。
      const bun = which(process.env.STOA_BIN || "bun");
      if (bun) return { tier: "repo-bun", bin: bun, args: [tsEntry, "mcp"] };
    }
    if (existsSync(distEntry)) {
      // process.execPath = 当前 node：不依赖 PATH 里的 node 版本。
      return { tier: "repo-node", bin: process.execPath, args: [distEntry] };
    }
  }
  return null;
}

/** 档③：已安装包的 node 入口（dist/mcp/server.mjs）。 */
function planFromInstalledPackage() {
  const roots = [];
  try {
    const require = createRequire(import.meta.url);
    roots.push(dirname(require.resolve("@jixoai/stoa/package.json")));
  } catch {
    /* not resolvable from this file's location */
  }
  roots.push(join(process.cwd(), "node_modules", "@jixoai", "stoa"));
  roots.push(join(PLUGIN_ROOT, "node_modules", "@jixoai", "stoa"));
  for (const root of roots) {
    const distEntry = join(root, "dist", "mcp", "server.mjs");
    if (existsSync(distEntry)) {
      return { tier: "package-node", bin: process.execPath, args: [distEntry] };
    }
  }
  return null;
}

/** 档④：npx 兜底（STOA_NPX 可注入替代命令；smoke 用 fake npx 免网络）。 */
function planFromNpx() {
  return {
    tier: "npx",
    bin: process.env.STOA_NPX || "npx",
    args: ["-y", "--package", "@jixoai/stoa", "stoa-mcp"],
  };
}

const plan = planFromRepo() ?? planFromInstalledPackage() ?? planFromNpx();

const fallbackHint =
  "tried repo bun TS, repo dist, installed @jixoai/stoa, and " +
  `npx (${plan.tier === "npx" ? plan.bin : process.env.STOA_NPX || "npx"} -y --package @jixoai/stoa stoa-mcp); ` +
  "set STOA_REPO to the Stoa repo root (with bun or dist/mcp/server.mjs), or install node+npm for the npm package.";

const child = spawn(plan.bin, plan.args, { stdio: "inherit" });
child.once("error", (error) => {
  process.stderr.write(
    mergeEnvelope(`mcp-bridge: cannot start ${plan.bin} [tier ${plan.tier}] (${error.code ?? error.message})`),
  );
  process.exit(2);
});
child.once("exit", (code, signal) => {
  if ((code ?? 1) !== 0) {
    process.stderr.write(
      mergeEnvelope(`mcp-bridge: core MCP exited ${code ?? signal} [tier ${plan.tier}]`),
    );
    process.exit(2);
  }
  process.exit(0);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    child.kill(signal);
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

function mergeEnvelope(line) {
  return `[stoa] ${line}; ${fallbackHint}\n`;
}

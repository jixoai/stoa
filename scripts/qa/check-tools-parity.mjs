#!/usr/bin/env node
/**
 * tools 漂移门 — 核心 `stoa mcp` 的 `tools/list` 与 ZCode 适配器
 * `adapters/zcode/stoa/scripts/lib/tools.mjs` 的 `TOOLS` **逐字 deep-diff**
 * （name/description/inputSchema 全等；任一漂移即 FAIL）。
 *
 * 为什么独立成脚本（zcode-stoa-plugin S3-7）：这是适配器与核心之间唯一的契约面，
 * 必须能单独跑（本地改动后一条命令、CI 单独门禁），而不是只能埋在
 * `scripts/qa/zcode-adapter-smoke.sh` 里。
 *
 * 实现：起核心 `bun <repo>/src/cli/main.ts mcp`（stdio），喂三行 JSON-RPC
 * （initialize / tools/list / 关闭 stdin），取 id=2 的应答与适配器 TOOLS 比对。
 * `--core-out <file>` 可跳过起核心，直接比对一份已捕获的 MCP stdio 输出
 * （smoke 用它验证「桥/拷贝形态经 npx 兜底拿到的 tools/list」与适配器逐字一致）。
 *
 * 用法：
 *   node scripts/qa/check-tools-parity.mjs [--repo <stoa-repo>] [--adapter <adapter-dir>]
 *                                          [--core-out <captured-stdio-file>]
 * 环境：
 *   BUN_BIN / STOA_BUN      bun 可执行文件（默认 bun）
 *   STOA_CORE_TIMEOUT_MS    核心会话超时（默认 60000）
 * 输出：单行 `true tools-parity (N tools)` 或 `false tools-parity <diffs>`；退出码 0/1。
 * 不读写任何配置/凭据（MCP 握手不发请求；HOME 由调用方决定）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function argValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline === undefined ? null : inline.slice(name.length + 3);
}

const argv = process.argv.slice(2);
const REPO = resolve(argValue(argv, "repo") ?? resolve(HERE, "..", ".."));
const ADAPTER = resolve(argValue(argv, "adapter") ?? join(REPO, "adapters", "zcode", "stoa"));
const CORE_OUT = argValue(argv, "core-out");
const BUN = process.env.BUN_BIN || process.env.STOA_BUN || "bun";
const CLI = join(REPO, "src", "cli", "main.ts");
const TIMEOUT_MS = Number(process.env.STOA_CORE_TIMEOUT_MS) > 0 ? Number(process.env.STOA_CORE_TIMEOUT_MS) : 60_000;

/** 递归稳定序列化（键排序），保证「逐字一致」判定不受键序影响。 */
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(message) {
  console.log(`false tools-parity ${message}`);
  process.exit(1);
}

if (!CORE_OUT && !existsSync(CLI)) fail(`core-cli-missing:${CLI}`);

/** 核心 MCP 握手：只发协议帧（不读配置、不发 HTTP）；`--core-out` 时直接读捕获文件。 */
function captureCoreStdio() {
  if (CORE_OUT) {
    if (!existsSync(CORE_OUT)) fail(`core-out-missing:${CORE_OUT}`);
    return readFileSync(CORE_OUT, "utf8");
  }
  const request = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    "",
  ].join("\n");
  // 隔离 cwd：避免核心在仓根落临时文件；HOME 不动（握手不涉及配置）。
  const workDir = mkdtempSync(join(tmpdir(), "stoa-tools-parity-"));
  let core;
  try {
    core = spawnSync(BUN, [CLI, "mcp"], {
      cwd: workDir,
      input: request,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  if (core.error) fail(`core-unavailable (${core.error.code ?? core.error.message})`);
  if (core.status !== 0) {
    fail(`core-exit-${core.status}:${String(core.stderr ?? "").trim().split("\n")[0]?.slice(0, 200) ?? ""}`);
  }
  return String(core.stdout ?? "");
}

const messages = captureCoreStdio()
  .split("\n")
  .filter((line) => line.trim().startsWith("{"))
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const response = messages.find((message) => message.id === 2 && message.result?.tools);
const coreTools = response?.result?.tools ?? [];
if (!Array.isArray(coreTools) || coreTools.length === 0) fail("core-tools-empty (tools/list 应答缺失)");

const { TOOLS } = await import(pathToFileURL(join(ADAPTER, "scripts", "lib", "tools.mjs")).href);

const coreByName = new Map(coreTools.map((tool) => [tool.name, tool]));
const diffs = [];
if (coreTools.length !== TOOLS.length) {
  diffs.push(`count core=${coreTools.length} adapter=${TOOLS.length}`);
}
for (const tool of TOOLS) {
  const coreTool = coreByName.get(tool.name);
  if (!coreTool) {
    diffs.push(`missing-in-core:${tool.name}`);
    continue;
  }
  for (const key of ["name", "description", "inputSchema"]) {
    if (canon(coreTool[key]) !== canon(tool[key])) diffs.push(`${tool.name}.${key}`);
  }
}
for (const tool of coreTools) {
  if (!TOOLS.some((candidate) => candidate.name === tool.name)) {
    diffs.push(`missing-in-adapter:${tool.name}`);
  }
}
if (diffs.length === 0) {
  console.log(`true tools-parity (${TOOLS.length} tools)`);
  process.exit(0);
}
fail(diffs.slice(0, 6).join(","));

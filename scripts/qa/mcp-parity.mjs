#!/usr/bin/env bun
/**
 * mcp-parity — `stoa mcp`（新核心）与旧 ZCode 插件 `mcp-server.mjs` 的工具面 parity 证据。
 *
 * 同一隔离后端（qa-serve，固定端口 13687，绝不动生产板）下：
 *   1. 旧服务 `node <主仓插件>/scripts/mcp-server.mjs`（REPORT_CHANNEL_* 旧 env）
 *      与新服务 `bun src/cli/main.ts mcp`（STOA_* env）各发 initialize / tools/list；
 *   2. 工具定义规范化（key 排序）后 deep-diff：name/description/inputSchema 必须逐字一致；
 *   3. 两侧各发一次 `tools/call board_status`，均须 ok。
 *
 * 凭据只从隔离实例的 accounts env 文件读，绝不打印；收尾回收所有起过的进程。
 *
 * 用法：
 *   bun scripts/qa/mcp-parity.mjs            # 起隔离后端 → 跑平权 → 全部回收
 *   OLD_PLUGIN_DIR=/path/to/plugins/report-channel bun scripts/qa/mcp-parity.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const QA_SERVE = join(REPO_ROOT, "scripts/qa/qa-serve.mjs");
const CLI = join(REPO_ROOT, "src/cli/main.ts");
const BUN = process.env.BUN_BIN || "bun";
const NODE = process.env.NODE_BIN || "node";

/** 本子代理固定端口（stoa-adapters 分工：13687）。 */
const PORT = 13687;
const WORK_ROOT = "/tmp/stoa-adapters-a";
const DATA_DIR = join(WORK_ROOT, "mcp-parity");
const HOME_OLD = join(WORK_ROOT, "mcp-parity-home-old");
const HOME_NEW = join(WORK_ROOT, "mcp-parity-home-new");

const PASS = [];
const FAIL = [];
const ok = (label, detail = "") => {
  PASS.push(label);
  console.log(`PASS ${label}${detail ? ` — ${detail}` : ""}`);
};
const bad = (label, detail = "") => {
  FAIL.push(label);
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

function findOldPlugin() {
  const candidates = [
    process.env.OLD_PLUGIN_DIR,
    resolve(REPO_ROOT, "../../../plugins/report-channel"), // worktree 布局：<main>/.worktrees/<name>
    resolve(REPO_ROOT, "../../plugins/report-channel"),
    "/Users/kzf/Development/GitHub/jixoai/fde2e/plugins/report-channel",
  ].filter((p) => typeof p === "string");
  for (const dir of candidates) {
    if (existsSync(join(dir, "scripts/mcp-server.mjs"))) return dir;
  }
  return null;
}

function which(bin) {
  const res = spawnSync("command", ["-v", bin], { shell: true, encoding: "utf8" });
  return (res.stdout || "").trim();
}

function readAccountToken(accountId) {
  const path = join(DATA_DIR, "accounts", `${accountId}.env`);
  const text = readFileSync(path, "utf8");
  const suffix = accountId.toUpperCase().replace(/-/g, "_");
  for (const key of [`STOA_TOKEN_${suffix}`, `FDE2E_REPORT_TOKEN_${suffix}`]) {
    const match = new RegExp(`^${key}=(.+)$`, "m").exec(text);
    if (match) return match[1].trim();
  }
  throw new Error(`missing token for ${accountId} in ${path}`);
}

function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canon(value[key]);
    return out;
  }
  return value;
}

/** 起隔离后端（qa-serve），返回 { url, pid, wrapper }。 */
async function startBackend() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(WORK_ROOT, { recursive: true });
  const wrapper = spawn(
    BUN,
    [QA_SERVE, "--data-dir", DATA_DIR, "--no-seed", "--keep", "--port", String(PORT)],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  wrapper.stderr.on("data", (chunk) => process.stderr.write(`[qa-serve] ${chunk}`));
  const line = await new Promise((resolveLine, rejectLine) => {
    let buffer = "";
    const timer = setTimeout(
      () => rejectLine(new Error("qa-serve 未在 60s 内就绪（端口 13687 被占用？）")),
      60_000,
    );
    wrapper.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolveLine(JSON.parse(buffer.slice(0, newline).trim()));
      } catch {
        rejectLine(new Error(`qa-serve 首行不是 JSON: ${buffer.slice(0, 200)}`));
      }
    });
    wrapper.once("exit", (code) => {
      clearTimeout(timer);
      rejectLine(new Error(`qa-serve 提前退出 (code=${code})`));
    });
  });
  wrapper.stdout.resume();
  return { url: line.url, pid: line.pid, dataDir: line.dataDir, wrapper };
}

/** 跑一轮 stdio MCP 会话：写入三行请求、关闭 stdin、收集 stdout。 */
function runMcpSession(label, cmd, args, env, requests) {
  return new Promise((resolveSession, rejectSession) => {
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      rejectSession(new Error(`${label} 会话超时未退出`));
    }, 30_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectSession(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveSession({ code, stdout: stdout.join(""), stderr: stderr.join(""), pid: child.pid });
    });
    child.stdin.write(requests.map((r) => `${JSON.stringify(r)}\n`).join(""));
    child.stdin.end();
  });
}

function parseResponses(stdout, label) {
  const byId = new Map();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      bad(`${label} stdout 非 JSON-RPC 行`, trimmed.slice(0, 120));
      continue;
    }
    if (message.id !== undefined) byId.set(message.id, message);
  }
  return byId;
}

async function main() {
  const oldPlugin = findOldPlugin();
  if (!oldPlugin) {
    bad("定位旧插件 mcp-server.mjs", "可用 OLD_PLUGIN_DIR 指定主仓 plugins/report-channel");
    return 1;
  }
  console.log(`-- 旧插件（只读来源）: ${oldPlugin}`);
  console.log(`-- 新核心: ${CLI} mcp`);
  if (!which(NODE)) {
    bad("node 可用性", "旧插件冒烟需要 node（NODE_BIN 可覆盖）");
    return 1;
  }

  const backend = await startBackend();
  console.log(`-- 隔离后端 url=${backend.url} serve_pid=${backend.pid} dataDir=${backend.dataDir}`);
  let backendStopped = false;
  const stopBackend = async () => {
    if (backendStopped) return;
    backendStopped = true;
    spawnSync(BUN, [QA_SERVE, "--stop", "--data-dir", DATA_DIR, "--keep"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    try {
      backend.wrapper.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.once("exit", () => {
    try {
      backend.wrapper.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  });

  const token = readAccountToken("manager");
  if (!token) {
    bad("读取 manager token", "accounts/manager.env 缺少 token");
    await stopBackend();
    return 1;
  }

  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "board_status", arguments: {} } },
  ];

  // 隔离 HOME：绝不读写真实 ~/.config/{stoa,fde2e}。
  rmSync(HOME_OLD, { recursive: true, force: true });
  rmSync(HOME_NEW, { recursive: true, force: true });
  mkdirSync(HOME_OLD, { recursive: true });
  mkdirSync(HOME_NEW, { recursive: true });

  const sessions = {};
  try {
    sessions.old = await runMcpSession(
      "旧插件",
      NODE,
      [join(oldPlugin, "scripts/mcp-server.mjs")],
      {
        ...process.env,
        HOME: HOME_OLD,
        REPORT_CHANNEL_BASE_URL: backend.url,
        REPORT_CHANNEL_ACCOUNT: "manager",
        REPORT_CHANNEL_DATA_DIR: DATA_DIR,
        REPORT_CHANNEL_FORCE_ACCOUNT: "",
      },
      requests,
    );
    sessions.new = await runMcpSession(
      "新核心",
      BUN,
      [CLI, "mcp"],
      {
        ...process.env,
        HOME: HOME_NEW,
        STOA_BASE_URL: backend.url,
        STOA_ACCOUNT: "manager",
        STOA_DATA_DIR: DATA_DIR,
      },
      requests,
    );
  } catch (err) {
    bad("stdio 会话", err.message);
    await stopBackend();
    return 1;
  }

  const oldRes = parseResponses(sessions.old.stdout, "旧插件");
  const newRes = parseResponses(sessions.new.stdout, "新核心");

  // 1. initialize 两侧均应答（协议版本回显 + tools 能力）。
  for (const [label, res] of [
    ["旧插件", oldRes],
    ["新核心", newRes],
  ]) {
    const init = res.get(1);
    if (init?.result?.protocolVersion === "2024-11-05" && init.result.capabilities?.tools) {
      ok(`${label} initialize 应答（protocolVersion 回显 + tools 能力）`);
    } else {
      bad(`${label} initialize`, JSON.stringify(init ?? null).slice(0, 200));
    }
  }

  // 2. tools/list 规范化 deep-diff（name/description/inputSchema 逐字一致）。
  const oldTools = oldRes.get(2)?.result?.tools;
  const newTools = newRes.get(2)?.result?.tools;
  if (!Array.isArray(oldTools) || !Array.isArray(newTools)) {
    bad("tools/list 载荷", "任一侧缺少 tools 数组");
  } else {
    const oldBy = new Map(oldTools.map((t) => [t.name, t]));
    const newBy = new Map(newTools.map((t) => [t.name, t]));
    const names = [...new Set([...oldBy.keys(), ...newBy.keys()])].sort();
    const mismatches = [];
    for (const name of names) {
      const a = oldBy.get(name);
      const b = newBy.get(name);
      if (!a || !b) {
        mismatches.push(`${name}: ${a ? "仅旧" : "仅新"}`);
        continue;
      }
      const canonA = JSON.stringify(canon(a));
      const canonB = JSON.stringify(canon(b));
      if (canonA !== canonB) {
        mismatches.push(
          `${name}: 规范化后不一致\n    old: ${canonA.slice(0, 500)}\n    new: ${canonB.slice(0, 500)}`,
        );
      }
    }
    if (names.length === 0) bad("tools/list 工具数为空");
    if (mismatches.length === 0) {
      ok(
        "tools/list parity（name/description/inputSchema 规范化 deep-diff）",
        `${names.length}/${names.length} 工具逐字一致：${names.join(", ")}`,
      );
    } else {
      bad(`tools/list parity（${mismatches.length} 处不一致）`, `\n    ${mismatches.join("\n    ")}`);
    }
  }

  // 3. 两侧 board_status 均 ok，且 token 以 present 报（不回显值）。
  for (const [label, res] of [
    ["旧插件", oldRes],
    ["新核心", newRes],
  ]) {
    const call = res.get(3);
    const text = call?.result?.content?.[0]?.text;
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (call?.result?.isError) {
      bad(`${label} board_status`, `isError=true: ${String(text).slice(0, 200)}`);
    } else if (payload?.ok === true && payload.status?.ok === true) {
      ok(
        `${label} board_status ok`,
        `as=${payload.as} token=${payload.config?.token} baseUrl=${payload.config?.baseUrl}`,
      );
    } else {
      bad(`${label} board_status`, String(text).slice(0, 200));
    }
  }

  // 凭据不回显：任一会话 stdout/stderr 不得出现 token。
  for (const [label, session] of Object.entries(sessions)) {
    if (session.stdout.includes(token) || session.stderr.includes(token)) {
      bad(`${label} 凭据不回显`, "输出里出现了 token");
    } else {
      ok(`${label} 凭据不回显`, "stdout/stderr 不含 token");
    }
  }

  await stopBackend();
  // 回收证据：wrapper 与 serve 都必须已死。
  const wrapperDead = await waitGone(backend.wrapper.pid, 5000);
  const serveDead = await waitGone(backend.pid, 5000);
  if (!wrapperDead) bad("qa-serve wrapper 回收", `pid ${backend.wrapper.pid} 仍存活`);
  if (!serveDead) bad("后端 serve 回收", `pid ${backend.pid} 仍存活`);
  if (wrapperDead && serveDead) {
    ok("进程回收", `qa-serve pid ${backend.wrapper.pid}、serve pid ${backend.pid} 均已退出`);
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(HOME_OLD, { recursive: true, force: true });
  rmSync(HOME_NEW, { recursive: true, force: true });

  console.log(`\n== RESULT: PASS=${PASS.length} FAIL=${FAIL.length} ==`);
  return FAIL.length === 0 ? 0 : 1;
}

function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      if (!alive(pid)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

process.exit(await main());

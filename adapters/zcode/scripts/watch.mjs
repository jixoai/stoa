#!/usr/bin/env node
/**
 * 看板常驻脚本：长轮询公示板，一旦有 Owner/他人的新回话就打印并退出 0。
 *
 * 两种订阅模式：
 *   1. 本地游标（默认，多会话安全）：
 *      node scripts/watch.mjs [--max-seconds 1500] [--poll-seconds 15] [--state-file <path>]
 *      - 每个会话一个 state 文件（默认 ~/.local/state/stoa/report-channel/<hash(baseUrl|account)>.json；
 *        旧目录 ~/.local/state/fde2e/report-channel/ 的同名文件按存在性回退，游标零迁移）；
 *        首次运行无状态文件时，先取账号当前 cursor 作为起点（不回溯旧消息）并写入；
 *        之后用 board_peek(cursor=last) 轮询（peek=1，不消费、不 ack、绝不推进账号游标）。
 *      - 有事件：更新 last（本页最大 seq）→ 打印事件 → 退出 0。
 *      - 多个会话同用默认路径会订阅同一段事件（不会互相偷消息，但会重复看到）；
 *        要严格独立，就用 --state-file 给每个会话一个不同路径，并记住它用于续臂。
 *   2. 消费式（旧行为，只允许一个「主会话」用）：
 *      node scripts/watch.mjs --consume [--max-seconds 1500] [--poll-seconds 40]
 *      - 走 board_inbox（消费并 ack，推进账号级游标）。其他会话不得使用，否则会偷走主会话的消息。
 *
 * 退出语义（两种模式一致）：0 = 有回话（stdout 是事件 JSON）或已到 --max-seconds（stdout 是续臂提示）；
 * 2 = 连续 3 次连不上板 / 后端实例身份不符（stderr 说明）。每次退出后重新挂一次即可续臂。
 * 脚本不抛栈：所有后端错误都收敛成 stderr 一行 + 退出码。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { api, loadConfig, resolveStatePath } from "./lib/config.mjs";
import { callTool } from "./lib/tools.mjs";

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const argValue = (name) => {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return null;
};
const numberFlag = (name, fallback) => {
  const raw = argValue(name);
  const value = Number(raw);
  return raw !== null && Number.isFinite(value) && value > 0 ? value : fallback;
};

const consume = hasFlag("consume");
const maxSeconds = numberFlag("max-seconds", 1500);
// 消费式走服务端 25s 长轮询；本地游标是短轮询，默认更密一点。
const pollSeconds = Math.min(numberFlag("poll-seconds", consume ? 40 : 15), 120);

const cfg = loadConfig();
const deadline = Date.now() + maxSeconds * 1000;
let failures = 0;

const expandHome = (path) => {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
};
const stateHash = createHash("sha1").update(`${cfg.baseUrl}|${cfg.account}`).digest("hex").slice(0, 16);
// 默认 state：新目录主用、旧目录按文件回退（stoa-adapters 迁移，零迁移承诺）。
const defaultStatePath = resolveStatePath(`${stateHash}.json`);
const statePath = consume
  ? null
  : resolve(expandHome(argValue("state-file") || defaultStatePath));

if (consume && argValue("state-file")) {
  process.stderr.write("[report-channel] watch: --consume 模式下忽略 --state-file（消费式只用账号游标）\n");
}

/**
 * 实例身份守卫：确认配置的 baseUrl 背后就是配置的数据目录。
 * 实证（2026-11-08 06:08）：13689 上曾短暂出现另一个（QA）后端，watcher 消费到
 * 一条 seq=1/actor=tagged 的陌生事件；吃错后端会静默丢/吞消息，宁可直接失败。
 */
async function assertInstance() {
  const health = await api(cfg, "/healthz", { timeoutMs: 5000 });
  if (health.dataDir !== cfg.dataDir) {
    process.stderr.write(
      `[report-channel] watch: backend identity mismatch — /healthz.dataDir=${health.dataDir} expected=${cfg.dataDir}; refusing to continue\n`,
    );
    process.exit(2);
  }
  return health.instanceId ?? "unknown";
}

/** 读本地游标；返回 null = 需要初始化。身份不符直接失败（避免覆盖别的会话的游标）。 */
function readLocalState() {
  if (!existsSync(statePath)) return null;
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    process.stderr.write(`[report-channel] watch: state file ${statePath} 不是合法 JSON，按首次运行重建\n`);
    return null;
  }
  if (typeof state.baseUrl === "string" && state.baseUrl !== cfg.baseUrl) {
    process.stderr.write(
      `[report-channel] watch: state file ${statePath} 属于 baseUrl=${state.baseUrl}，与当前 ${cfg.baseUrl} 不符；拒绝复用\n`,
    );
    process.exit(2);
  }
  if (typeof state.account === "string" && state.account !== cfg.account) {
    process.stderr.write(
      `[report-channel] watch: state file ${statePath} 属于账号 @${state.account}，与当前 @${cfg.account} 不符；拒绝复用\n`,
    );
    process.exit(2);
  }
  if (!Number.isInteger(state.last) || state.last < 0) {
    process.stderr.write(`[report-channel] watch: state file ${statePath} 缺少合法 last，按首次运行重建\n`);
    return null;
  }
  return state;
}

/** 原子写本地游标（0600；tmp + rename，避免半截文件）。 */
function writeLocalState(last, instanceId) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const payload = {
    baseUrl: cfg.baseUrl,
    account: cfg.account,
    last,
    updated_at: new Date().toISOString(),
    instanceId: instanceId ?? null,
  };
  const tmp = `${statePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, statePath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing else to clean */
    }
    throw error;
  }
}

/**
 * 首次运行：取账号当前 cursor 作为起点（不回溯旧消息），写入 state 文件。
 * 注意：只跳过账号已读位置之前的历史；当前未读仍会照常投递给本会话。
 */
async function initLocalState(instanceId) {
  const res = await api(cfg, "/api/cursor", { timeoutMs: 10_000 });
  const cursor = Number(res.cursor);
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new Error("/api/cursor returned an invalid cursor");
  }
  writeLocalState(cursor, instanceId);
  return cursor;
}

function printEvents(mode, instance, events, cursorBefore, cursorAfter) {
  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mode,
        ...(statePath ? { state_file: statePath } : {}),
        instance,
        count: events.length,
        cursor_before: cursorBefore,
        cursor_after: cursorAfter,
        events,
      },
      null,
      1,
    ),
  );
}

function printIdle(mode, last) {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      mode,
      ...(statePath ? { state_file: statePath } : {}),
      cursor: last ?? null,
      idle_seconds: maxSeconds,
      events: [],
    }),
  );
}

const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));

if (consume) {
  // ── 消费式（旧行为）：board_inbox 消费并 ack，只允许一个主会话 ──────────────
  for (;;) {
    try {
      const instance = await assertInstance();
      const result = await callTool("board_inbox", { timeout_seconds: pollSeconds });
      failures = 0;
      if (result.events.length > 0) {
        printEvents("consume", instance, result.events, null, result.cursor ?? null);
        process.exit(0);
      }
    } catch (error) {
      failures += 1;
      process.stderr.write(`[report-channel] watch: ${String(error?.message ?? error)}\n`);
      if (failures >= 3) process.exit(2);
    }
    if (Date.now() >= deadline) {
      printIdle("consume", null);
      process.exit(0);
    }
  }
}

// ── 本地游标（默认）：peek=1&cursor=last，不消费、不 ack ─────────────────────
let last = null;
let instanceId = null;
for (;;) {
  try {
    instanceId = await assertInstance();
    if (last === null) last = readLocalState()?.last ?? (await initLocalState(instanceId));
    const result = await callTool("board_peek", { cursor: last, limit: 200 });
    failures = 0;
    const events = result.events ?? [];
    if (events.length > 0) {
      const cursorBefore = last;
      const maxSeq = events.reduce(
        (max, event) => (Number.isInteger(event?.seq) && event.seq > max ? event.seq : max),
        last,
      );
      const target = Number.isInteger(result.target) ? result.target : 0;
      last = Math.max(last, maxSeq, target);
      writeLocalState(last, instanceId);
      printEvents("local-cursor", instanceId, events, cursorBefore, last);
      process.exit(0);
    }
  } catch (error) {
    failures += 1;
    process.stderr.write(`[report-channel] watch: ${String(error?.message ?? error)}\n`);
    if (failures >= 3) process.exit(2);
  }
  if (Date.now() >= deadline) {
    printIdle("local-cursor", last);
    process.exit(0);
  }
  await sleep(Math.min(pollSeconds * 1000, deadline - Date.now()));
}

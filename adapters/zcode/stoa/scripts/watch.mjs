#!/usr/bin/env node
/**
 * 看板常驻脚本：长轮询公示板，一旦有 Owner/他人的新回话就打印并退出 0。
 *
 * 两种订阅模式：
 *   1. 本地游标（默认，多会话安全）：
 *      node scripts/watch.mjs [--max-seconds 1500] [--poll-seconds 15] [--state-file <path>]
 *      - 每个会话一个 state 文件（默认**会话级**：`<hash(baseUrl|account)>[-<hash(会话)>].json`，
 *        与 state-path.mjs / stop-wait.mjs 同一派生——有 ZCODE_SESSION_ID 时每会话独立，
 *        没有会话 ID 才回退同账号共享；旧目录 ~/.local/state/fde2e/report-channel/ 的同名文件
 *        按存在性回退，游标零迁移）；
 *        首次运行无状态文件时，先取账号当前 cursor 作为起点（不回溯旧消息）并写入；
 *        之后用 board_peek(cursor=last) 轮询（peek=1，不消费、不 ack、绝不推进账号游标）。
 *      - 有事件：更新 last（本页最大 seq）→ 打印事件 → 退出 0。
 *      - 要完全独立（install 缓存、无会话 ID 的宿主），用 --state-file 显式给路径并记住它用于续臂。
 *   2. 消费式（旧行为，只允许一个「主会话」用）：
 *      node scripts/watch.mjs --consume [--max-seconds 1500] [--poll-seconds 40]
 *      - 走 board_inbox（消费并 ack，推进账号级游标）。其他会话不得使用，否则会偷走主会话的消息。
 *
 * 退出语义（两种模式一致）：0 = 有回话（stdout 是事件 JSON）或已到 --max-seconds（stdout 是续臂提示）；
 * 2 = 连续 3 次连不上板 / 后端实例身份不符（stderr 说明）。每次退出后重新挂一次即可续臂。
 * 脚本不抛栈：所有后端错误都收敛成 stderr 一行 + 退出码。
 *
 * 实例身份守卫：配置了 dataDir 时校验 `/healthz.dataDir` 一致（防吃错后端）；dataDir 为空
 * （远程板/中性板）时**跳过**守卫、信任 baseUrl。`STOA_EXPECT_DATA_DIR`（旧前缀
 * `REPORT_CHANNEL_EXPECT_DATA_DIR` 兼容）可显式指定期望 dataDir（优先于配置）。
 *
 * 默认板安全门（打磨集 S3-2）：dataDir 为空且未设 `STOA_EXPECT_DATA_DIR` / `STOA_ALLOW_REMOTE=1`
 * 时**直接拒绝连接**（退出 2，stderr 一行原因）——空配置会以 @manager 连上默认 127.0.0.1:13689
 * 的生产板，必须先显式 opt-in 才允许连别人的板。
 *
 * 并发：本地游标模式把「读 last → poll → 写 last」整段放在 `<state>.lock` 互斥锁里
 * （见 lib/state-lock.mjs）——常驻 watcher 与 Stop 钩子共用同一游标时不会重复投递；
 * 等锁超时则降级为无锁（stderr 一行说明）保活性。
 *
 * B5（第三轮独立评审）：`last` 不能只在首轮读一次盘——常驻 watcher 睡眠期间，Stop 钩子
 * （stop-wait）会推进同一 state 文件；内存旧游标在下一轮会把同一批事件再投递一次。
 * 现在**每轮进锁后都重读磁盘游标并取 max(memory, disk)**，poll 始终用两路中较新的游标。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  api,
  defaultBoardRefusal,
  expectedDataDirOf,
  loadConfig,
  resolveStatePath,
  sessionStateFileName,
} from "./lib/config.mjs";
import { acquireStateLock } from "./lib/state-lock.mjs";
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
const refusal = defaultBoardRefusal(cfg);
if (refusal) {
  process.stderr.write(`[stoa] watch: refusing to connect — ${refusal}\n`);
  process.exit(2);
}
const deadline = Date.now() + maxSeconds * 1000;
let failures = 0;

const expandHome = (path) => {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
};
// 默认 state：会话级（与 state-path.mjs / stop-wait.mjs 同一派生；旧目录按文件回退，零迁移承诺）。
const defaultStatePath = resolveStatePath(sessionStateFileName(cfg));
const statePath = consume
  ? null
  : resolve(expandHome(argValue("state-file") || defaultStatePath));

if (consume && argValue("state-file")) {
  process.stderr.write("[stoa] watch: --consume 模式下忽略 --state-file（消费式只用账号游标）\n");
}

/**
 * 实例身份守卫：确认配置的 baseUrl 背后就是配置的数据目录。
 * 实证（2026-11-08 06:08）：13689 上曾短暂出现另一个（QA）后端，watcher 消费到
 * 一条 seq=1/actor=tagged 的陌生事件；吃错后端会静默丢/吞消息，宁可直接失败。
 *
 * dataDir 为空（远程板/中性板，配置里根本没有本地数据目录）时跳过守卫——此时没有
 * 「期望的 dataDir」可比，信任 baseUrl；需要强校验时用 `STOA_EXPECT_DATA_DIR` 显式给出。
 */
const expectedDataDir = expectedDataDirOf(cfg);

async function assertInstance() {
  const health = await api(cfg, "/healthz", { timeoutMs: 5000 });
  if (expectedDataDir && health.dataDir !== expectedDataDir) {
    process.stderr.write(
      `[stoa] watch: backend identity mismatch — /healthz.dataDir=${health.dataDir} expected=${expectedDataDir}; refusing to continue\n`,
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
    process.stderr.write(`[stoa] watch: state file ${statePath} 不是合法 JSON，按首次运行重建\n`);
    return null;
  }
  if (typeof state.baseUrl === "string" && state.baseUrl !== cfg.baseUrl) {
    process.stderr.write(
      `[stoa] watch: state file ${statePath} 属于 baseUrl=${state.baseUrl}，与当前 ${cfg.baseUrl} 不符；拒绝复用\n`,
    );
    process.exit(2);
  }
  if (typeof state.account === "string" && state.account !== cfg.account) {
    process.stderr.write(
      `[stoa] watch: state file ${statePath} 属于账号 @${state.account}，与当前 @${cfg.account} 不符；拒绝复用\n`,
    );
    process.exit(2);
  }
  if (!Number.isInteger(state.last) || state.last < 0) {
    process.stderr.write(`[stoa] watch: state file ${statePath} 缺少合法 last，按首次运行重建\n`);
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
      count: 0,
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
      process.stderr.write(`[stoa] watch: ${String(error?.message ?? error)}\n`);
      if (failures >= 3) process.exit(2);
    }
    if (Date.now() >= deadline) {
      printIdle("consume", null);
      process.exit(0);
    }
  }
}

// ── 本地游标（默认）：peek=1&cursor=last，不消费、不 ack ─────────────────────
// 「读 last → poll → 写 last」整段持 state 锁：常驻 watcher 与 Stop 钩子共用同一游标时，
// 后到者会读到已推进的 last，不会把同一批事件再投递一次。
let last = null;
let instanceId = null;
let lockDegraded = false;
for (;;) {
  let events = [];
  let cursorBefore = null;
  try {
    instanceId = await assertInstance();
    const release = await acquireStateLock(statePath, {
      timeoutMs: Math.min(20_000, Math.max(1000, deadline - Date.now())),
      onDegrade: (info) => {
        if (lockDegraded) return;
        lockDegraded = true;
        process.stderr.write(
          `[stoa] watch: state lock ${info.path} busy (holder pid=${info.holder?.pid ?? "?"}, age=${Math.round(info.ageMs)}ms)；降级为无锁轮询（并发窗口内可能重复投递）\n`,
        );
      },
    });
    try {
      // B5：每轮进锁后刷新磁盘游标（首轮仍走 init：无 state 文件时取账号当前 cursor）。
      // 常驻 watcher 睡眠窗口内 stop-wait / 另一会话可能已推进游标，复用内存旧值会重复投递。
      const disk = readLocalState();
      if (last === null) last = disk?.last ?? (await initLocalState(instanceId));
      else if (disk && disk.last > last) last = disk.last;
      const result = await callTool("board_peek", { cursor: last, limit: 200 });
      failures = 0;
      events = result.events ?? [];
      if (events.length > 0) {
        cursorBefore = last;
        const maxSeq = events.reduce(
          (max, event) => (Number.isInteger(event?.seq) && event.seq > max ? event.seq : max),
          last,
        );
        const target = Number.isInteger(result.target) ? result.target : 0;
        last = Math.max(last, maxSeq, target);
        writeLocalState(last, instanceId);
      }
    } finally {
      release();
    }
  } catch (error) {
    failures += 1;
    process.stderr.write(`[stoa] watch: ${String(error?.message ?? error)}\n`);
    if (failures >= 3) process.exit(2);
  }
  if (events.length > 0) {
    printEvents("local-cursor", instanceId, events, cursorBefore, last);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    printIdle("local-cursor", last);
    process.exit(0);
  }
  await sleep(Math.min(pollSeconds * 1000, deadline - Date.now()));
}

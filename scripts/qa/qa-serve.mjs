#!/usr/bin/env bun
/**
 * qa-serve.mjs — the ONLY QA environment allowed to receive writes.
 *
 * The production board (127.0.0.1:13689, data dir
 * .agents/workers/report/report-v0) is the Owner's live board. Automation must
 * NEVER write there: no QA posts, no tombstones, no follow/bookmark side
 * effects. This launcher creates a disposable SQLite board under
 * /tmp/report-qa-*, seeds deterministic fixtures through the real CLI, starts
 * `serve` on loopback, and prints one JSON line:
 *
 *   {"url":"http://127.0.0.1:13681","port":13681,"pid":4242,
 *    "dataDir":"/tmp/report-qa-ab12cd"}
 *
 * The URL is a full backend + static shell origin. Any other shell can talk to
 * the same isolated board with `?ep=http://127.0.0.1:<port>` (CORS allows
 * loopback origins), which is how before/after shells share one data dir.
 *
 * Usage:
 *   bun scripts/qa/qa-serve.mjs                  # fresh temp dir + seed + serve
 *   bun scripts/qa/qa-serve.mjs --keep           # keep the temp dir on exit
 *   bun scripts/qa/qa-serve.mjs --no-seed        # empty (but initialized) board
 *   bun scripts/qa/qa-serve.mjs --data-dir /tmp/report-qa-shared --port 13688
 *   bun scripts/qa/qa-serve.mjs --stop [--data-dir D] [--keep]
 *
 * Stop semantics: SIGINT/SIGTERM (or `--stop`) terminates the serve child and
 * removes the temp data dir unless `--keep` was passed. Custom --data-dir
 * paths are never deleted unless they match /tmp/report-qa-*.
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI = join(REPO_ROOT, "src/cli/main.ts");
const BUN = process.env.BUN_BIN || "bun";
const QA_TMP_ROOT = "/tmp";
const STATE_FILE = join(
  QA_TMP_ROOT,
  `report-qa-serve.${createHash("sha1").update(REPO_ROOT).digest("hex").slice(0, 8)}.json`,
);

const PORT_MIN = 13680;
const PORT_MAX = 13699;
/** Production + neighbouring services we must never touch. */
const RESERVED_PORTS = new Set([13689, 13690, 13696, 13697]);
const PRODUCTION_DATA_DIR =
  "/Users/kzf/Development/GitHub/jixoai/fde2e/.agents/workers/report/report-v0";

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const flagValue = (name, fallback = null) => {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return fallback;
};

const log = (...parts) => process.stderr.write(`[qa-serve] ${parts.join(" ")}\n`);

function fail(message) {
  log(`ERROR ${message}`);
  process.exit(1);
}

// ── port helpers ──────────────────────────────────────────────────────────────
function shuffledPorts() {
  const ports = [];
  for (let p = PORT_MIN; p <= PORT_MAX; p += 1) {
    if (!RESERVED_PORTS.has(p)) ports.push(p);
  }
  for (let i = ports.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [ports[i], ports[j]] = [ports[j], ports[i]];
  }
  return ports;
}

/** true/false = lsof verdict; null = lsof unavailable (let serve retry). */
function portIsListening(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().trim().length > 0;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    return false;
  }
}

function validateExplicitPort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    fail(`--port must be an integer in ${PORT_MIN}-${PORT_MAX} (got ${raw})`);
  }
  if (RESERVED_PORTS.has(port)) {
    fail(`--port ${port} is reserved (production/neighbour service); pick another`);
  }
  if (portIsListening(port) === true) {
    fail(`--port ${port} is already in use (lsof)`);
  }
  return port;
}

// ── CLI helpers (all calls are explicit about --data-dir/--env-files) ────────
function cliJson(args, dataDir) {
  const res = spawnSync(BUN, [CLI, ...args], {
    cwd: dataDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `CLI "${args.slice(0, 2).join(" ")}" failed (exit ${res.status}): ` +
        `${(res.stderr || res.stdout || "").trim().slice(0, 600)}`,
    );
  }
  const line = (res.stdout || "").split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`CLI "${args[0]}" printed no JSON: ${(res.stdout || "").slice(0, 300)}`);
  return JSON.parse(line);
}

function accountArgs(dataDir, envPath, accountId) {
  return [
    "--as",
    accountId,
    "--env-files",
    `${envPath},${join(dataDir, "accounts", `${accountId}.env`)}`,
  ];
}

/** Double read: `STOA_TOKEN_<ID>` preferred, legacy `FDE2E_REPORT_TOKEN_<ID>` accepted. */
function readToken(envFile, accountId) {
  const text = readFileSync(envFile, "utf8");
  const suffix = accountId.toUpperCase().replace(/-/g, "_");
  for (const key of [`STOA_TOKEN_${suffix}`, `FDE2E_REPORT_TOKEN_${suffix}`]) {
    const match = new RegExp(`^${key}=(.+)$`, "m").exec(text);
    if (match) return match[1].trim();
  }
  throw new Error(
    `missing STOA_TOKEN_${suffix} (legacy FDE2E_REPORT_TOKEN_${suffix}) in ${envFile}`,
  );
}

// ── tiny PNG generator (no third-party deps) ─────────────────────────────────
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(width, height, seed = 0) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const off = row + 1 + x * 3;
      raw[off] = (40 + Math.round((x / width) * 160) + seed) & 0xff;
      raw[off + 1] = (90 + Math.round((y / height) * 120) + seed * 2) & 0xff;
      raw[off + 2] = (180 + Math.round(((x + y) / (width + height)) * 60)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── seeding ───────────────────────────────────────────────────────────────────
function seedBoard(dataDir, envPath, baseUrl) {
  log(`seeding fixtures in ${dataDir}`);
  const owner = (extra = []) => [...accountArgs(dataDir, envPath, "owner"), ...extra];
  const as = (id, extra = []) => [...accountArgs(dataDir, envPath, id), ...extra];

  // two fixed agent accounts (owner/manager already exist from init)
  for (const [id, display, profile] of [
    ["sub-backend", "后端工程师", "隔离 QA 夹具账号（后端）"],
    ["sub-frontend", "前端工程师", "隔离 QA 夹具账号（前端）"],
  ]) {
    cliJson(
      [
        "accounts",
        "create",
        id,
        "--role",
        "agent",
        "--display",
        display,
        "--profile",
        profile,
        ...owner(),
      ],
      dataDir,
    );
  }

  const post = (accountId, body, tags = [], attach = []) => {
    const args = [
      "post",
      body,
      ...as(accountId),
      ...tags.flatMap((t) => ["--tag", t]),
      ...attach.flatMap((p) => ["--attach", p]),
    ];
    const out = cliJson(args, dataDir);
    return out.posts?.[0]?.id;
  };
  const reply = (accountId, parentId, body) => {
    const out = cliJson(["reply", parentId, body, ...as(accountId)], dataDir);
    return out.posts?.[0]?.id;
  };

  // 5 root posts: three with #result, two with #note, one media post.
  // Agent accounts only see roots they participate in (visibility.ts), so the
  // manager root mentions both agents: that is what lets them reply later.
  const rootResultA = post(
    "manager",
    "@sub-backend @sub-frontend 成果：报告工作站隔离验收基线。\n\n- 存储层巡检通过\n- 时间线可读\n- 通知链路可验",
    ["result"],
  );
  const rootNoteA = post(
    "sub-backend",
    "@sub-frontend 备注：SQLite WAL 与单实例锁按设计工作，验收数据全部来自本隔离板。",
    ["note"],
  );
  const rootResultB = post(
    "sub-frontend",
    "成果：移动端布局稳定性回归完成，底部导航零抖动。",
    ["result"],
  );

  const imageA = join(dataDir, "qa-fixture-a.png");
  const imageB = join(dataDir, "qa-fixture-b.png");
  writeFileSync(imageA, makePng(640, 360, 0), { mode: 0o600 });
  writeFileSync(imageB, makePng(480, 480, 20), { mode: 0o600 });
  post(
    "sub-frontend",
    "媒体附件：两张隔离夹具图（网格 / 查看器验收）。",
    ["note"],
    [imageA, imageB],
  );
  post(
    "sub-backend",
    "备注：本板所有数据都是临时夹具，qa-serve 停止后会随数据目录一起删除。",
    ["note"],
  );

  // 2 notifications for @owner + a regular reply + a manager self-chain.
  reply("sub-backend", rootResultA, "后端确认：事件序列与游标一致。");
  reply("sub-frontend", rootNoteA, "前端已对齐接口字段。");
  reply("manager", rootResultB, "@owner 前端结论请确认（验收通知 1/2）。");
  reply("sub-backend", rootNoteA, "@owner 后端巡检也已归档（验收通知 2/2）。");
  const self1 = reply("manager", rootResultA, "补充：结果已归档。");
  reply("manager", self1, "自接：再补一句，验证自接链。");

  // Seed assertions: enough posts + at least two owner notifications.
  const read = cliJson(["read", ...as("owner"), "--limit", "100"], dataDir);
  if (!Array.isArray(read.posts) || read.posts.length < 10) {
    throw new Error(`seed produced only ${read.posts?.length ?? 0} posts (expected >= 10)`);
  }

  const ownerToken = readToken(join(dataDir, "accounts", "owner.env"), "owner");
  // Synchronous seed check via the CLI is enough; the HTTP notification check
  // happens in the parent process after this returns.
  return { ownerToken, total: read.posts.length };
}

async function verifyNotifications(baseUrl, ownerToken) {
  const res = await fetch(`${baseUrl}/api/notifications?peek=1`, {
    headers: { authorization: `Bearer ${ownerToken}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`/api/notifications HTTP ${res.status}`);
  const body = await res.json();
  const count = Array.isArray(body.events) ? body.events.length : 0;
  if (count < 2) throw new Error(`seed produced ${count} owner notification(s) (expected >= 2)`);
  return count;
}

// ── server lifecycle ─────────────────────────────────────────────────────────
function readServerJson(dataDir) {
  const path = join(dataDir, "server.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function waitReady(dataDir, port, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    const info = readServerJson(dataDir);
    if (info && info.port === port) {
      try {
        const res = await fetch(`${info.url}/healthz`, {
          signal: AbortSignal.timeout(800),
        });
        if (res.ok) {
          const body = await res.json();
          if (body?.ok && body.dataDir === dataDir) return true;
        }
      } catch {
        /* not ready yet */
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function waitDead(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !pidAlive(pid);
}

function isQaTempDir(dataDir) {
  let resolved;
  try {
    resolved = resolve(dataDir);
  } catch {
    return false;
  }
  const inTmp =
    resolved.startsWith("/tmp/") ||
    resolved.startsWith("/private/tmp/") ||
    resolved.startsWith(`${process.env.TMPDIR ?? "/tmp"}/`);
  return inTmp && basename(resolved).startsWith("report-qa-");
}

function writeState(info) {
  if (!isQaTempDir(info.dataDir)) return;
  writeFileSync(STATE_FILE, JSON.stringify(info, null, 2), { mode: 0o600 });
}

function clearState(dataDir) {
  try {
    if (!existsSync(STATE_FILE)) return;
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!dataDir || state.dataDir === dataDir) rmSync(STATE_FILE, { force: true });
  } catch {
    rmSync(STATE_FILE, { force: true });
  }
}

function resolveStopTarget(explicitDataDir) {
  if (explicitDataDir) return resolve(explicitDataDir);
  if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (state.dataDir && existsSync(state.dataDir)) return state.dataDir;
    } catch {
      /* fall through to scan */
    }
  }
  const candidates = [];
  for (const name of readdirSync(QA_TMP_ROOT)) {
    if (!name.startsWith("report-qa-")) continue;
    const dir = join(QA_TMP_ROOT, name);
    const info = readServerJson(dir);
    if (info?.pid && pidAlive(info.pid)) {
      candidates.push({ dir, startedAt: info.startedAt ?? 0, pid: info.pid });
    }
  }
  candidates.sort((a, b) => b.startedAt - a.startedAt);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    log("multiple live QA backends found; refusing to guess. Pass --data-dir:");
    for (const c of candidates) log(`  ${c.dir} (pid ${c.pid})`);
    return null;
  }
  log(`using the only live QA backend: ${candidates[0].dir} (pid ${candidates[0].pid})`);
  return candidates[0].dir;
}

async function stopBackend(dataDir, keep) {
  if (!dataDir || !existsSync(dataDir)) {
    process.stdout.write(JSON.stringify({ ok: true, stopped: false, reason: "no-data-dir" }) + "\n");
    return 0;
  }
  const info = readServerJson(dataDir);
  const pid = info?.pid;
  let stopped = false;
  if (pid && pidAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      log(`SIGTERM pid ${pid} failed: ${err.message}`);
    }
    await waitDead(pid, 6000);
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
      await waitDead(pid, 2000);
    }
    stopped = true;
  }
  const remove = !keep && isQaTempDir(dataDir);
  if (remove) {
    rmSync(dataDir, { recursive: true, force: true });
    log(`removed ${dataDir}`);
  }
  clearState(dataDir);
  const existsAfter = existsSync(dataDir);
  if (keep && !existsAfter) {
    log(
      "note: the running qa-serve was started WITHOUT --keep, so its own shutdown " +
        "removed the dir; pass --keep to the start command to preserve it",
    );
  }
  process.stdout.write(
    JSON.stringify({
      ok: true,
      stopped,
      pid: pid ?? null,
      dataDir,
      kept: existsAfter,
      removed: !existsAfter,
    }) + "\n",
  );
  return 0;
}

// ── start ────────────────────────────────────────────────────────────────────
async function start() {
  const explicitDataDir = flagValue("data-dir");
  const keep = hasFlag("keep");
  const noSeed = hasFlag("no-seed");
  const explicitPortRaw = flagValue("port");

  let dataDir;
  let created = false;
  if (explicitDataDir) {
    dataDir = resolve(explicitDataDir);
    if (dataDir === PRODUCTION_DATA_DIR || dataDir.startsWith(PRODUCTION_DATA_DIR + "/")) {
      fail(`refusing --data-dir ${dataDir}: that is the production board (read-only for QA)`);
    }
    if (!existsSync(join(dataDir, "report.sqlite"))) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      created = true;
    }
  } else {
    dataDir = mkdtempSync(join(QA_TMP_ROOT, "report-qa-"));
    created = true;
  }
  const envPath = join(dataDir, ".env");

  const existing = readServerJson(dataDir);
  if (existing?.pid && pidAlive(existing.pid)) {
    fail(
      `a report instance is already running for ${dataDir} at ${existing.url} (pid ${existing.pid}); ` +
        `stop it first: bun scripts/qa/qa-serve.mjs --stop --data-dir ${dataDir}`,
    );
  }

  if (created) {
    log(`init ${dataDir}`);
    try {
      const init = cliJson(
        ["init", "--data-dir", dataDir, "--env-files", envPath],
        dataDir,
      );
      if (!init?.ok) throw new Error("init did not report ok");
    } catch (err) {
      if (!keep && isQaTempDir(dataDir)) rmSync(dataDir, { recursive: true, force: true });
      fail(`init failed: ${err.message}`);
    }
  } else {
    if (!existsSync(envPath)) fail(`${dataDir} has report.sqlite but no .env; not a qa-serve data dir`);
    const envText = readFileSync(envPath, "utf8");
    if (!/^(?:STOA_AUTH|FDE2E_REPORT_AUTH)=/m.test(envText)) {
      fail(
        `${envPath} has no STOA_AUTH (legacy FDE2E_REPORT_AUTH); qa-serve needs auth mode ` +
          `(delete the dir and start fresh)`,
      );
    }
  }

  const explicitPort =
    explicitPortRaw !== null ? validateExplicitPort(explicitPortRaw) : null;
  const candidates = explicitPort !== null ? [explicitPort] : shuffledPorts();

  let serveChild = null;
  let port = null;
  let stderrTail = [];
  for (const candidate of candidates.slice(0, 20)) {
    if (explicitPort === null && portIsListening(candidate) === true) continue;
    log(`starting serve on 127.0.0.1:${candidate}`);
    const child = spawn(
      BUN,
      [
        CLI,
        "serve",
        "--data-dir",
        dataDir,
        "--port",
        String(candidate),
        "--env-files",
        envPath,
        "--idle-timeout",
        "0",
      ],
      {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );
    stderrTail = [];
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail.push(text);
      if (stderrTail.length > 40) stderrTail.shift();
      process.stderr.write(text);
    });
    child.stdout.resume();
    const ready = await waitReady(dataDir, candidate, child);
    if (ready) {
      serveChild = child;
      port = candidate;
      break;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await waitDead(child.pid, 2000);
    if (explicitPort !== null) {
      fail(
        `could not start serve on port ${candidate}: ${stderrTail.join("").trim().slice(-800)}`,
      );
    }
    log(`port ${candidate} failed, trying another`);
  }
  if (!serveChild || port === null) {
    if (!keep && created && isQaTempDir(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    fail("no free port in the worker range; check for orphan report processes");
  }

  const url = `http://127.0.0.1:${port}`;

  if (created && !noSeed) {
    try {
      const seeded = seedBoard(dataDir, envPath, url);
      const notifications = await verifyNotifications(url, seeded.ownerToken);
      log(`seeded ${seeded.total} posts, ${notifications} owner notification(s)`);
    } catch (err) {
      log(`seed failed: ${err.message}`);
      try {
        serveChild.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      await waitDead(serveChild.pid, 5000);
      if (!keep && isQaTempDir(dataDir)) rmSync(dataDir, { recursive: true, force: true });
      fail(`seed failed: ${err.message}`);
    }
  } else if (created) {
    log("skipped seeding (--no-seed)");
  }

  const state = { pid: serveChild.pid, port, url, dataDir, startedAt: Date.now() };
  writeState(state);
  process.stdout.write(JSON.stringify({ url, port, pid: serveChild.pid, dataDir }) + "\n");

  let stopping = false;
  const shutdown = async (reason, code = 0) => {
    if (stopping) return;
    stopping = true;
    log(`shutting down (${reason})`);
    if (serveChild.exitCode === null && serveChild.signalCode === null) {
      try {
        serveChild.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      await waitDead(serveChild.pid, 6000);
      if (pidAlive(serveChild.pid)) {
        try {
          serveChild.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        await waitDead(serveChild.pid, 2000);
      }
    }
    if (!keep && isQaTempDir(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
      log(`removed ${dataDir}`);
    } else {
      log(`kept ${dataDir}`);
    }
    clearState(dataDir);
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const exit = await new Promise((resolveExit) => {
    serveChild.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  if (stopping) {
    // shutdown() is already running (signal handler) and owns process.exit().
    // Do not return here: returning would end the process before the temp dir
    // is removed. The pending timers inside shutdown keep the loop alive.
    await new Promise(() => {});
  }
  if (!stopping) {
    log(`serve exited unexpectedly (code=${exit.code}, signal=${exit.signal})`);
    await shutdown("serve-exit", exit.code === 0 ? 0 : 1);
  }
  return 0;
}

// ── main ─────────────────────────────────────────────────────────────────────
if (hasFlag("help")) {
  process.stdout.write(
    [
      "qa-serve — isolated disposable report backend",
      "  bun scripts/qa/qa-serve.mjs [--keep] [--no-seed] [--data-dir D] [--port N]",
      "  bun scripts/qa/qa-serve.mjs --stop [--data-dir D] [--keep]",
      "stdout: one JSON line {url, port, pid, dataDir}",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (hasFlag("stop")) {
  const target = resolveStopTarget(flagValue("data-dir"));
  process.exit(await stopBackend(target, hasFlag("keep")));
} else {
  process.exit(await start());
}

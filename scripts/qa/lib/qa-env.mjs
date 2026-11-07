/**
 * Shared helpers for the isolated QA stack.
 *
 * Hard rule: QA/acceptance scripts may only write to the disposable backend
 * created by `scripts/qa/qa-serve.mjs` (data dir under /tmp/report-qa-*).
 * The production board (127.0.0.1:13689, .agents/workers/report/report-v0)
 * is READ-ONLY for automation; every helper here refuses it.
 *
 * Usage (see scripts/qa/README.md):
 *   const qa = await ensureQa(process.argv.slice(2));
 *   qa.base      // http://127.0.0.1:<port>
 *   qa.dataDir   // /tmp/report-qa-xxxxxx
 *   authSecret(qa.dataDir)                 // FDE2E_REPORT_AUTH (login password)
 *   accountToken(qa.dataDir, "manager")    // FDE2E_REPORT_TOKEN_MANAGER
 *   await qa.stop()                        // stops an auto-started backend
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const QA_SERVE = join(REPO_ROOT, "scripts/qa/qa-serve.mjs");
export const PRODUCTION_DATA_DIR =
  "/Users/kzf/Development/GitHub/jixoai/fde2e/.agents/workers/report/report-v0";
export const PRODUCTION_PORT = 13689;

/** `--name=value` or `--name value`, else fallback. */
export function argValue(argv, name, fallback = null) {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
    return argv[i + 1];
  }
  return fallback;
}

/** Minimal dotenv parser (same shape the worker uses). */
export function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** The browser login password of the isolated backend. */
export function authSecret(dataDir) {
  assertIsolatedDataDir(dataDir);
  const value = parseEnvFile(join(dataDir, ".env")).FDE2E_REPORT_AUTH;
  if (!value) {
    throw new Error(
      `no FDE2E_REPORT_AUTH in ${dataDir}/.env — this is not a qa-serve data dir ` +
        `(start one with: bun scripts/qa/qa-serve.mjs)`,
    );
  }
  return value;
}

/** Account API token from the isolated data dir (never logs it). */
export function accountToken(dataDir, accountId) {
  assertIsolatedDataDir(dataDir);
  const key = `FDE2E_REPORT_TOKEN_${accountId.toUpperCase().replace(/-/g, "_")}`;
  const value = parseEnvFile(join(dataDir, "accounts", `${accountId}.env`))[key];
  if (!value) {
    throw new Error(`no ${key} in ${dataDir}/accounts/${accountId}.env`);
  }
  return value;
}

function isUnder(root, path) {
  const realRoot = (() => {
    try {
      return realpathSync(root);
    } catch {
      return resolve(root);
    }
  })();
  const realPath = (() => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  })();
  return realPath === realRoot || realPath.startsWith(realRoot + "/");
}

/**
 * Refuse the production board and anything that does not look disposable.
 * Allowed: /tmp/report-qa-* (macOS also /private/tmp/...), system temp dirs,
 * or an explicit override REPORT_QA_ALLOW_CUSTOM=1 for a custom --data-dir.
 */
export function assertIsolatedDataDir(dataDir) {
  const resolved = resolve(dataDir);
  if (resolved === PRODUCTION_DATA_DIR || resolved.startsWith(PRODUCTION_DATA_DIR + "/")) {
    throw new Error(
      `refusing production board data dir ${resolved}: QA scripts must never write there. ` +
        `Use bun scripts/qa/qa-serve.mjs (temp /tmp/report-qa-* backend).`,
    );
  }
  const tempRoots = ["/tmp", "/private/tmp", process.env.TMPDIR ?? "/tmp"];
  const inTemp = tempRoots.some((root) => isUnder(root, resolved));
  const named = basename(resolved).startsWith("report-qa-");
  if (!inTemp && !named && process.env.REPORT_QA_ALLOW_CUSTOM !== "1") {
    throw new Error(
      `refusing non-disposable data dir ${resolved}: expected a /tmp/report-qa-* dir. ` +
        `If this is intentional, set REPORT_QA_ALLOW_CUSTOM=1.`,
    );
  }
  return resolved;
}

/** Read the data dir from a running backend's /healthz (source of truth). */
export async function discoverDataDir(base) {
  let res;
  try {
    res = await fetch(new URL("/healthz", base), {
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    throw new Error(
      `no QA backend at ${base}: ${err.message}. ` +
        `Start one with: bun scripts/qa/qa-serve.mjs`,
    );
  }
  if (!res.ok) throw new Error(`${base}/healthz returned HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.ok || typeof body.dataDir !== "string") {
    throw new Error(`${base}/healthz did not report a dataDir`);
  }
  return body.dataDir;
}

function normalizeBase(raw) {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`unsupported base protocol: ${raw}`);
  const host = url.hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if ((host === "127.0.0.1" || host === "localhost" || host === "::1") && port === String(PRODUCTION_PORT)) {
    throw new Error(
      `refusing production board ${raw}: set REPORT_QA_BASE to an isolated qa-serve URL ` +
        `(bun scripts/qa/qa-serve.mjs)`,
    );
  }
  return `${url.protocol}//${url.host}`;
}

function onceChildExit(child, timeoutMs) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolveExit();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

function waitForJsonLine(child, timeoutMs) {
  return new Promise((resolveLine, rejectLine) => {
    let buffer = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      fn(value);
    };
    const onData = (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      try {
        finish(resolveLine, JSON.parse(line));
      } catch {
        finish(rejectLine, new Error(`qa-serve printed a non-JSON first line: ${line.slice(0, 200)}`));
      }
    };
    const onExit = (code, signal) => {
      finish(
        rejectLine,
        new Error(`qa-serve exited before becoming ready (code=${code}, signal=${signal})`),
      );
    };
    const timer = setTimeout(() => {
      finish(rejectLine, new Error(`qa-serve did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

/**
 * Resolve an isolated backend for a QA script.
 *
 * - `--base=URL` or REPORT_QA_BASE set → use that backend (must be isolated).
 * - otherwise spawn `qa-serve.mjs` (fresh temp dir, seeded) and use it.
 *
 * The returned `stop()` is a no-op for an externally owned backend.
 */
export async function ensureQa(argv = process.argv.slice(2), opts = {}) {
  const explicit = argValue(argv, "base") ?? process.env.REPORT_QA_BASE ?? null;
  if (explicit) {
    const base = normalizeBase(explicit);
    const dataDir = await discoverDataDir(base);
    assertIsolatedDataDir(dataDir);
    return { base, dataDir, info: null, owned: null, stop: async () => {} };
  }

  const args = [QA_SERVE, ...(opts.qaServeArgs ?? [])];
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const info = await waitForJsonLine(child, opts.timeoutMs ?? 120_000).catch(async (err) => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await onceChildExit(child, 5000);
    throw err;
  });
  child.stdout.resume(); // drain anything left; the protocol is one JSON line

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await onceChildExit(child, 20_000);
  };
  // Best effort: never leak a seeded backend if the script throws before stop().
  process.once("exit", () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  });
  return { base: info.url.replace(/\/$/, ""), dataDir: info.dataDir, info, owned: child, stop };
}

/**
 * For scripts that must attach to a backend someone else is running (seed and
 * cleanup helpers): no auto-start, fail fast with the exact command to run.
 */
export async function requireQa(argv = process.argv.slice(2)) {
  const explicit = argValue(argv, "base") ?? process.env.REPORT_QA_BASE ?? null;
  if (!explicit) {
    throw new Error(
      "REPORT_QA_BASE is not set. Start an isolated backend first:\n" +
        "  bun scripts/qa/qa-serve.mjs            # prints {url, port, pid, dataDir}\n" +
        "  export REPORT_QA_BASE=http://127.0.0.1:<port>\n" +
        "(never point this at the production board 13689)",
    );
  }
  return ensureQa(argv);
}

/** Small authenticated JSON helper (tokens stay in memory, never logged). */
export async function apiJson(base, path, token, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(new URL(path, base), {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${path}: HTTP ${res.status} ${body?.error?.message ?? text.slice(0, 200)}`);
  }
  return body;
}

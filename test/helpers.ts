import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase, migrate } from "../src/server/db.ts";
import { Store } from "../src/server/store.ts";
import { readServerInfo, probeHealth } from "../src/server/discovery.ts";
import { accountTokenEnvKey } from "../src/core/auth.ts";
import { parseEnv } from "../src/core/env.ts";
import type { Account } from "../src/core/types.ts";

export const CLI = resolve(import.meta.dir, "../src/cli/main.ts");
export const BUN = process.execPath;

export function tempDir(prefix = "report-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface TestStore {
  dir: string;
  db: ReturnType<typeof openDatabase>;
  store: Store;
  owner: Account;
  manager: Account;
  close: () => void;
}

export function makeStore(opts: { clock?: () => number } = {}): TestStore {
  const dir = tempDir();
  const db = openDatabase({ dataDir: dir });
  migrate(db);
  const store = new Store({ dataDir: dir, db, clock: opts.clock });
  const owner = store.ensureInitAccount({ id: "owner", role: "owner", display: "owner" }).account;
  const manager = store.ensureInitAccount({
    id: "manager",
    role: "manager",
    display: "manager",
  }).account;
  // mirrors `init`: owner follows manager by default (design §5.0)
  store.ensureDefaultFollows();
  return {
    dir,
    db,
    store,
    owner,
    manager,
    close: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function createAgents(store: Store, ids: string[]): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const id of ids) {
    const created = store.createAccount({ id, profile: `agent ${id}` });
    tokens.set(id, created.token);
  }
  return tokens;
}

export interface TestWorkspace {
  root: string;
  cwd: string;
  dataDir: string;
  envFiles: string[];
  authValue: string | null;
  cleanup: () => void;
}

function runInit(cwd: string, dataDir: string, envFiles?: string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const args = [BUN, CLI, "init", "--data-dir", dataDir];
  if (envFiles) args.push("--env-files", envFiles.join(","));
  const res = spawnSync(BUN, args.slice(1), { cwd, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Initialize a workspace. `open` forces open mode with a non-existent env file. */
export function initWorkspace(opts: { open?: boolean } = {}): TestWorkspace {
  const root = tempDir();
  const cwd = join(root, "ws");
  mkdirSync(cwd, { recursive: true });
  const dataDir = join(root, "data");
  const missing = join(cwd, ".env.missing");
  const envFiles = opts.open ? [missing] : [];
  const init = runInit(cwd, dataDir, opts.open ? envFiles : undefined);
  if (init.code !== 0) {
    throw new Error(`init failed: ${init.stderr || init.stdout}`);
  }
  let authValue: string | null = null;
  if (!opts.open) {
    const env = readFileSync(join(dataDir, ".env"), "utf8");
    const match = /^(?:STOA_AUTH|FDE2E_REPORT_AUTH)=(.+)$/m.exec(env);
    authValue = match?.[1]?.trim() ?? null;
  }
  return {
    root,
    cwd,
    dataDir,
    envFiles,
    authValue,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface RunningTestServer {
  url: string;
  dataDir: string;
  proc: ReturnType<typeof Bun.spawn>;
  stdout: () => string;
  stderr: () => string;
  stop: () => Promise<void>;
}

export async function startTestServer(opts: {
  workspace: TestWorkspace;
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
}): Promise<RunningTestServer> {
  const { workspace } = opts;
  const args = [BUN, CLI, "serve", "--data-dir", workspace.dataDir];
  if (workspace.envFiles.length > 0) {
    args.push("--env-files", workspace.envFiles.join(","));
  }
  args.push(...(opts.extraArgs ?? []));
  const proc = Bun.spawn({
    cmd: args,
    cwd: workspace.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, STOA_AUTH: "", FDE2E_REPORT_AUTH: "", ...(opts.env ?? {}) },
  });
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const readStream = async (
    stream: ReadableStream<Uint8Array> | null,
    sink: string[],
  ): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sink.push(decoder.decode(value, { stream: true }));
    }
  };
  void readStream(proc.stdout, stdoutChunks);
  void readStream(proc.stderr, stderrChunks);

  const deadline = Date.now() + 20_000;
  let info = null as ReturnType<typeof readServerInfo>;
  while (Date.now() < deadline) {
    info = readServerInfo(workspace.dataDir);
    if (info && (await probeHealth(info))) break;
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 50)),
    ]);
    if (exited) {
      throw new Error(
        `server exited during startup:\n${stderrChunks.join("")}\n${stdoutChunks.join("")}`,
      );
    }
    info = null;
  }
  if (!info) {
    throw new Error(`server did not become healthy:\n${stderrChunks.join("")}`);
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 4000)),
    ]);
    if (!exited) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 2000))]);
    }
  };

  return {
    url: info.url,
    dataDir: workspace.dataDir,
    proc,
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
    stop,
  };
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(
  args: string[],
  opts: {
    cwd?: string;
    stdin?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<CliRun> {
  const proc = Bun.spawn({
    cmd: [BUN, CLI, ...args],
    cwd: opts.cwd ?? process.cwd(),
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // isolate: a developer shell with stoa/report env vars would otherwise
      // redirect every test CLI invocation to a real data directory
      STOA_DATA_DIR: undefined,
      STOA_ENV_FILES: undefined,
      STOA_ACCOUNT: undefined,
      STOA_AUTH: undefined,
      FDE2E_REPORT_DATA_DIR: undefined,
      FDE2E_REPORT_ENV_FILES: undefined,
      FDE2E_REPORT_ACCOUNT: undefined,
      FDE2E_REPORT_AUTH: undefined,
      ...(opts.env ?? {}),
    },
  });
  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, opts.timeoutMs)
      : null;
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
}

export function parseJsonLines(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function accountEnvFile(workspace: TestWorkspace, id: string): string {
  const path = join(workspace.dataDir, "accounts", `${id}.env`);
  if (!existsSync(path)) throw new Error(`missing account env file ${path}`);
  return path;
}

/**
 * Path of the built app bundle inside an export/static directory. Vite emits
 * content-hashed names (`assets/app-<hash>.js`); older builds used `app.js`.
 */
export function appAssetPath(exportDir: string): string | null {
  const assetsDir = join(exportDir, "assets");
  if (!existsSync(assetsDir)) return null;
  const entry = readdirSync(assetsDir).find((name) => /^app(-[\w-]+)?\.js$/.test(name));
  return entry ? join(assetsDir, entry) : null;
}

export function tokenFor(workspace: TestWorkspace, id: string): string {
  const values = parseEnv(readFileSync(accountEnvFile(workspace, id), "utf8"));
  const token = values[accountTokenEnvKey(id)];
  if (!token) throw new Error(`no token in ${id}.env`);
  return token;
}

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BUN,
  CLI,
  initWorkspace,
  runCli,
  startTestServer,
} from "./helpers.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error("condition not met in time");
}

/**
 * 只判断「该 dataDir 的 report 实例是否仍在应答」：端口被其它进程（如 IPv6
 * 通配的 python 服务）复用不算失败，消除环境抖动。
 */
async function servesDataDir(url: string, dataDir: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; dataDir?: string };
    return body.ok === true && body.dataDir === dataDir;
  } catch {
    return false;
  }
}

describe("idle lease (design §1)", () => {
  test("an idle instance exits after --idle-timeout and releases port, server.json and lock", async () => {
    const ws = initWorkspace({ open: true });
    const server = await startTestServer({
      workspace: ws,
      extraArgs: ["--idle-timeout", "1"],
    });
    try {
      const url = server.url;
      // no traffic at all after startup: the lease should expire on its own
      const exited = await Promise.race([
        server.proc.exited.then(() => true),
        sleep(10000).then(() => false),
      ]);
      expect(exited).toBe(true);
      expect(server.proc.exitCode).toBe(0);
      await waitFor(() => server.stderr().includes("[report] idle timeout, shutting down"));
      expect(existsSync(join(ws.dataDir, "server.json"))).toBe(false);
      expect(existsSync(join(ws.dataDir, "serve.lock"))).toBe(false);
      expect(await servesDataDir(url, ws.dataDir)).toBe(false);
    } finally {
      await server.stop();
      ws.cleanup();
    }
  }, 30000);

  test("HTTP activity renews the lease and status --all reports the remainder", async () => {
    const ws = initWorkspace({ open: true });
    const server = await startTestServer({
      workspace: ws,
      extraArgs: ["--idle-timeout", "1"],
    });
    try {
      // Keep touching /healthz for longer than the TTL: the instance must stay up.
      const until = Date.now() + 2200;
      while (Date.now() < until) {
        const res = await fetch(`${server.url}/healthz`);
        expect(res.status).toBe(200);
        await sleep(300);
      }
      expect(server.proc.exitCode).toBeNull();

      const status = await runCli(["status", "--all", "--data-dir", ws.dataDir]);
      expect(status.code).toBe(0);
      const body = JSON.parse(status.stdout) as {
        ok: boolean;
        instances: Array<{
          running: boolean;
          lease_remaining_ms: number | null;
          idle_timeout_ms: number | null;
        }>;
      };
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0]!.running).toBe(true);
      expect(body.instances[0]!.idle_timeout_ms).toBe(1000);
      expect(body.instances[0]!.lease_remaining_ms).not.toBeNull();
      expect(body.instances[0]!.lease_remaining_ms!).toBeGreaterThan(0);
      expect(body.instances[0]!.lease_remaining_ms!).toBeLessThanOrEqual(1000);
    } finally {
      await server.stop();
      ws.cleanup();
    }
  }, 30000);

  test("a blocking wait-notifications keeps the instance alive past the TTL", async () => {
    const ws = initWorkspace({ open: true });
    const server = await startTestServer({
      workspace: ws,
      extraArgs: ["--idle-timeout", "1"],
    });
    const waiter = Bun.spawn({
      cmd: [BUN, CLI, "wait-notifications", "--data-dir", ws.dataDir, "--as", "owner"],
      cwd: ws.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FDE2E_REPORT_AUTH: "" },
    });
    try {
      await sleep(2500);
      expect(server.proc.exitCode).toBeNull();
      expect(waiter.exitCode).toBeNull();
      expect(existsSync(join(ws.dataDir, "server.json"))).toBe(true);
    } finally {
      try {
        waiter.kill("SIGKILL");
      } catch {
        // already gone
      }
      await waiter.exited;
      await server.stop();
      ws.cleanup();
    }
  }, 30000);

  test("gc reclaims a killed instance exactly once and leaves a healthy one alone", async () => {
    const ws = initWorkspace({ open: true });
    const server = await startTestServer({ workspace: ws });
    try {
      // A live instance is never touched.
      const untouched = await runCli(["gc", "--data-dir", ws.dataDir]);
      expect(untouched.code).toBe(0);
      expect((JSON.parse(untouched.stdout) as { removed: unknown[] }).removed).toHaveLength(0);
      expect(server.proc.exitCode).toBeNull();

      // Kill -9 leaves server.json + serve.lock behind.
      server.proc.kill("SIGKILL");
      await server.proc.exited;
      expect(existsSync(join(ws.dataDir, "server.json"))).toBe(true);
      expect(existsSync(join(ws.dataDir, "serve.lock"))).toBe(true);

      const first = await runCli(["gc", "--data-dir", ws.dataDir]);
      expect(first.code).toBe(0);
      const firstBody = JSON.parse(first.stdout) as {
        removed: Array<{ kind: string; reason: string }>;
      };
      expect(firstBody.removed.map((item) => item.kind).sort()).toEqual([
        "serve.lock",
        "server.json",
      ]);
      expect(firstBody.removed.every((item) => item.reason === "pid-dead")).toBe(true);
      expect(existsSync(join(ws.dataDir, "server.json"))).toBe(false);
      expect(existsSync(join(ws.dataDir, "serve.lock"))).toBe(false);

      const second = await runCli(["gc", "--data-dir", ws.dataDir]);
      expect(second.code).toBe(0);
      expect((JSON.parse(second.stdout) as { removed: unknown[] }).removed).toHaveLength(0);
    } finally {
      await server.stop();
      ws.cleanup();
    }
  }, 30000);

  test("--idle-timeout 0 disables the lease", async () => {
    const ws = initWorkspace({ open: true });
    const server = await startTestServer({
      workspace: ws,
      extraArgs: ["--idle-timeout", "0"],
    });
    try {
      await sleep(1800);
      expect(server.proc.exitCode).toBeNull();
      const health = (await (await fetch(`${server.url}/healthz`)).json()) as {
        lease: unknown;
      };
      expect(health.lease).toBeNull();
      expect(existsSync(join(ws.dataDir, "server.json"))).toBe(true);
    } finally {
      await server.stop();
      ws.cleanup();
    }
  }, 30000);
});

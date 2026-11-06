import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  appAssetPath,
  initWorkspace,
  parseJsonLines,
  runCli,
  type TestWorkspace,
} from "./helpers.ts";

/**
 * Acceptance smoke (real processes): init -> serve --daemon -> accounts ->
 * post -> wait-notifications -> reply -> read --thread -> export -> stop.
 */
describe("E2E smoke (real daemon)", () => {
  test("full manager/agent flow", async () => {
    const ws: TestWorkspace = initWorkspace({ open: true });
    let stopped = false;
    try {
      const started = await runCli(["serve", ...["--data-dir", ws.dataDir], "--daemon"], {
        env: { FDE2E_REPORT_AUTH: "" },
        timeoutMs: 30_000,
      });
      expect(started.code).toBe(0);
      const daemon = JSON.parse(started.stdout) as {
        ok: boolean;
        running: boolean;
        url: string;
        port: number;
        pid: number;
      };
      expect(daemon.running).toBe(true);
      expect(daemon.port).toBeGreaterThanOrEqual(13680);
      expect(daemon.port).toBeLessThanOrEqual(13699);
      expect(daemon.url.startsWith("http://127.0.0.1:")).toBe(true);

      const provision = await runCli(
        ["accounts", "create", "a", ...["--data-dir", ws.dataDir], "--as", "manager"],
        { env: { FDE2E_REPORT_AUTH: "" } },
      );
      expect(provision.code).toBe(0);
      const provisionB = await runCli(
        ["accounts", "create", "b", ...["--data-dir", ws.dataDir], "--as", "manager"],
        { env: { FDE2E_REPORT_AUTH: "" } },
      );
      expect(provisionB.code).toBe(0);

      const posted = await runCli(
        ["post", "汇报：第一步完成 @b", ...["--data-dir", ws.dataDir], "--as", "a"],
        { env: { FDE2E_REPORT_AUTH: "" } },
      );
      expect(posted.code).toBe(0);
      const rootId = (JSON.parse(posted.stdout) as { posts: Array<{ id: string }> }).posts[0]!.id;

      const waited = await runCli(
        ["wait-notifications", ...["--data-dir", ws.dataDir], "--as", "b"],
        { env: { FDE2E_REPORT_AUTH: "" }, timeoutMs: 30_000 },
      );
      expect(waited.code).toBe(0);
      const delivered = parseJsonLines(waited.stdout);
      expect(delivered.length).toBeGreaterThanOrEqual(2);
      expect(delivered.some((line) => line.type === "thread.snapshot")).toBe(true);

      const replied = await runCli(
        ["reply", rootId, "收到", ...["--data-dir", ws.dataDir], "--as", "b"],
        { env: { FDE2E_REPORT_AUTH: "" } },
      );
      expect(replied.code).toBe(0);

      const read = await runCli(
        ["read", "--thread", rootId, ...["--data-dir", ws.dataDir], "--as", "a", "--human"],
        { env: { FDE2E_REPORT_AUTH: "" } },
      );
      expect(read.code).toBe(0);
      expect(read.stdout).toContain("汇报：第一步完成");
      expect(read.stdout).toContain("收到");

      const exported = await runCli(["export", ...["--data-dir", ws.dataDir]], {
        env: { FDE2E_REPORT_AUTH: "" },
      });
      expect(exported.code).toBe(0);
      const exportResult = JSON.parse(exported.stdout) as { as_of_seq: number };
      expect(exportResult.as_of_seq).toBeGreaterThan(0);
      const index = join(ws.dataDir, "export", "index.html");
      const html = readFileSync(index, "utf8");
      expect(html).toContain('id="report-snapshot"');
      expect(html).toMatch(/assets\/app(-[\w-]+)?\.js/);
      expect(appAssetPath(join(ws.dataDir, "export"))).not.toBeNull();
      expect(existsSync(join(ws.dataDir, "export", "media"))).toBe(true);

      const status = await runCli(["serve", ...["--data-dir", ws.dataDir], "--status"]);
      expect(status.code).toBe(0);
      expect((JSON.parse(status.stdout) as { running: boolean }).running).toBe(true);

      const stop = await runCli(["serve", ...["--data-dir", ws.dataDir], "--stop"]);
      expect(stop.code).toBe(0);
      expect((JSON.parse(stop.stdout) as { stopped: boolean }).stopped).toBe(true);
      stopped = true;
      const after = await runCli(["serve", ...["--data-dir", ws.dataDir], "--status"]);
      expect((JSON.parse(after.stdout) as { running: boolean }).running).toBe(false);
    } finally {
      if (!stopped) {
        try {
          await runCli(["serve", ...["--data-dir", ws.dataDir], "--stop"], { timeoutMs: 15_000 });
        } catch {
          // best effort
        }
      }
      ws.cleanup();
    }
  }, 120000);
});

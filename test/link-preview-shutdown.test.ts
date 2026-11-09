import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { openDatabase } from "../src/server/db.ts";
import { initWorkspace, startTestServer, tokenFor } from "./helpers.ts";

let fixture: Server<undefined>;
let fixtureOrigin = "";

beforeAll(() => {
  fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response("late", { headers: { "content-type": "text/html" } })), 30_000);
      }),
  });
  fixtureOrigin = `http://127.0.0.1:${fixture.port}`;
});

afterAll(() => {
  fixture?.stop(true);
});

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(40);
  }
  throw new Error("shutdown test waitFor timeout");
}

describe("N4: SIGTERM with an in-flight preview job", () => {
  test("aborts the fetch, returns the job to queued before the DB closes, no closed-db errors", async () => {
    const ws = initWorkspace();
    const server = await startTestServer({
      workspace: ws,
      env: {
        STOA_PREVIEW_TEST_ALLOW_ORIGINS: fixtureOrigin,
        STOA_PREVIEW_WORKER: "1",
      },
    });
    try {
      const token = tokenFor(ws, "owner");
      const created = await fetch(`${server.url}/api/posts`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ body: `慢链接 ${fixtureOrigin}/slow`, media: [], tags: [] }),
      });
      expect(created.status).toBe(201);

      await waitFor(async () => {
        const res = await fetch(`${server.url}/api/status`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) return false;
        const body = (await res.json()) as {
          preview_worker?: { processing: number; running: number } | null;
        };
        return (body.preview_worker?.processing ?? 0) >= 1;
      });

      await server.stop();

      const db = openDatabase({ dataDir: ws.dataDir, readonly: true });
      try {
        const rows = db
          .query("SELECT status, COUNT(*) AS c FROM preview_jobs GROUP BY status")
          .all() as Array<{ status: string; c: number }>;
        const byStatus = Object.fromEntries(rows.map((row) => [row.status, row.c]));
        expect(byStatus.running ?? 0).toBe(0);
        expect(byStatus.queued ?? 0).toBe(1);
        expect((byStatus.failed ?? 0)).toBe(0);
      } finally {
        db.close();
      }
      expect(server.stderr()).not.toContain("Cannot use a closed database");
    } finally {
      await server.stop();
      ws.cleanup();
    }
  }, 30_000);
});

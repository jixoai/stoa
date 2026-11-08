import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server/http.ts";
import { AuthManager } from "../src/server/auth.ts";
import { Presence } from "../src/server/presence.ts";
import { makeStore, createAgents, tempDir } from "./helpers.ts";

const T0 = 1_700_000_000_000;

interface ThreadBody {
  thread: {
    focal_id: string | null;
    posts: Array<{ id: string; depth: number; parent_id: string | null }>;
    collapsed: Array<{ parent_id: string; depth: number; count: number }>;
  };
}

/** Isolated temp-dir Store + open-mode Hono app (same shape as test/http.test.ts). */
function buildApp() {
  let now = T0;
  const t = makeStore({ clock: () => now });
  const envDir = tempDir();
  const envPath = join(envDir, "env");
  writeFileSync(envPath, "# open mode\n");
  const auth = new AuthManager({
    store: t.store,
    envFiles: [envPath],
    secretSalt: "salt",
    envTtlMs: 0,
    processEnv: {},
  });
  const presence = new Presence();
  const app = createApp({
    store: t.store,
    auth,
    presence,
    dataDir: t.dir,
    instanceId: "inst-thread-depth",
    startedAt: T0,
    openExposed: false,
    port: 13680,
  });
  return {
    t,
    app,
    tick: () => {
      now += 10;
    },
  };
}

const json = async (res: Response): Promise<ThreadBody> => (await res.json()) as ThreadBody;

describe("GET /api/thread deep focal (report-thread-depth)", () => {
  test("12-level thread returns every ancestor, focal and the new reply", async () => {
    const { t, app, tick } = buildApp();
    try {
      createAgents(t.store, ["a", "b"]);
      tick();
      const root = t.store.commitOps({
        author: "a",
        batchId: "root",
        ops: [{ op: "post", body: "root @b" }],
      }).posts[0]!;

      const chain = [root.id];
      let parent = root.id;
      for (let i = 1; i <= 11; i++) {
        tick();
        const author = i % 2 === 1 ? "b" : "a";
        const reply = t.store.commitOps({
          author,
          batchId: `layer-${i}`,
          ops: [{ op: "reply", parent, body: `layer ${i}` }],
        }).posts[0]!;
        chain.push(reply.id);
        parent = reply.id;
      }
      const focal = parent;
      tick();
      const newReply = t.store.commitOps({
        author: "a",
        batchId: "new-reply",
        ops: [{ op: "reply", parent: focal, body: "new reply to focal" }],
      }).posts[0]!;

      const res = await app.request(`/api/thread/${focal}?focal=${focal}`, {
        headers: { "x-report-account": "a" },
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.thread.focal_id).toBe(focal);
      expect(body.thread.posts.map((post) => post.id)).toEqual([...chain, newReply.id]);
      expect(body.thread.posts.map((post) => post.depth)).toEqual(
        Array.from({ length: 13 }, (_, i) => i),
      );
      expect(body.thread.posts.some((post) => post.id === chain[chain.length - 2]!)).toBe(true);
      expect(body.thread.collapsed).toEqual([]);

      // Opening the root is the "focal subtree = whole conversation" case.
      const rootRes = await app.request(`/api/thread/${root.id}?focal=${root.id}`, {
        headers: { "x-report-account": "a" },
      });
      expect(rootRes.status).toBe(200);
      const rootBody = await json(rootRes);
      expect(rootBody.thread.posts.map((post) => post.id)).toEqual([...chain, newReply.id]);
      expect(rootBody.thread.collapsed).toEqual([]);
    } finally {
      t.close();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server/http.ts";
import { AuthManager } from "../src/server/auth.ts";
import { Presence } from "../src/server/presence.ts";
import { createAgents, makeStore, tempDir } from "./helpers.ts";

const T0 = 1_700_000_000_000;

function buildApp(opts: { mode: "open" | "auth" }) {
  const t = makeStore({ clock: () => T0 });
  const envDir = tempDir();
  const envPath = join(envDir, "env");
  writeFileSync(envPath, opts.mode === "auth" ? "FDE2E_REPORT_AUTH=topsecret\n" : "# open mode\n");
  const auth = new AuthManager({
    store: t.store,
    envFiles: [envPath],
    secretSalt: "salt",
    envTtlMs: 0,
    processEnv: {},
  });
  const app = createApp({
    store: t.store,
    auth,
    presence: new Presence(),
    dataDir: t.dir,
    instanceId: "inst-reads",
    startedAt: T0,
    openExposed: false,
    port: 13680,
  });
  return {
    t,
    app,
    close: () => {
      t.close();
      rmSync(envDir, { recursive: true, force: true });
    },
  };
}

async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

function post(
  t: ReturnType<typeof makeStore>,
  author: string,
  body: string,
  batchId: string,
) {
  return t.store.commitOps({ author, batchId, ops: [{ op: "post", body }] }).posts[0]!;
}

function as(account: string): Record<string, string> {
  return { "x-report-account": account, "content-type": "application/json" };
}

function bulkPosts(t: ReturnType<typeof makeStore>, count: number) {
  const ops = Array.from({ length: count }, (_, index) => ({
    op: "post" as const,
    body: `bulk ${index}`,
  }));
  return t.store.commitOps({ author: "owner", batchId: "HTTP-BULK", ops }).posts;
}

describe("reads API", () => {
  test("capabilities advertise post_reads + limits", async () => {
    const h = buildApp({ mode: "open" });
    try {
      const caps = await json(await h.app.request("/api/capabilities"));
      expect(caps.features.post_reads).toBe(true);
      expect(caps.limits.reads_batch).toBe(100);
      expect(caps.limits.reads_query).toBe(200);
    } finally {
      h.close();
    }
  });

  test("owner/manager/agent write their own rows; another agent gets 404", async () => {
    const h = buildApp({ mode: "open" });
    try {
      createAgents(h.t.store, ["a", "b"]);
      const root = post(h.t, "a", "a-only", "W1");

      for (const who of ["owner", "manager", "a"]) {
        const res = await h.app.request("/api/reads", {
          method: "POST",
          headers: as(who),
          body: JSON.stringify({ post_id: root.id }),
        });
        expect(res.status).toBe(201);
        const body = await json(res);
        expect(body).toEqual({
          ok: true,
          post_id: root.id,
          read: true,
          read_at: T0,
          created: true,
        });
      }
      expect(h.t.store.readStatesFor("owner", [root.id]).size).toBe(1);
      expect(h.t.store.readStatesFor("manager", [root.id]).size).toBe(1);
      expect(h.t.store.readStatesFor("a", [root.id]).size).toBe(1);

      const hidden = await json(
        await h.app.request("/api/reads", {
          method: "POST",
          headers: as("b"),
          body: JSON.stringify({ post_id: root.id }),
        }),
      );
      expect(hidden.code).toBe("NOT_FOUND");
      expect(h.t.store.readStatesFor("b", [root.id]).size).toBe(0);
    } finally {
      h.close();
    }
  });

  test("single write is idempotent over HTTP: second call is 200 with the same read_at", async () => {
    const h = buildApp({ mode: "open" });
    try {
      const root = post(h.t, "owner", "idempotent", "I1");
      const first = await h.app.request("/api/reads", {
        method: "POST",
        headers: as("owner"),
        body: JSON.stringify({ post_id: root.id }),
      });
      expect(first.status).toBe(201);
      const firstBody = await json(first);
      const second = await h.app.request("/api/reads", {
        method: "POST",
        headers: as("owner"),
        body: JSON.stringify({ post_id: root.id }),
      });
      expect(second.status).toBe(200);
      const secondBody = await json(second);
      expect(secondBody.created).toBe(false);
      expect(secondBody.read_at).toBe(firstBody.read_at);
    } finally {
      h.close();
    }
  });

  test("all read endpoints require a valid identity in auth mode", async () => {
    const h = buildApp({ mode: "auth" });
    try {
      expect((await h.app.request("/api/reads", { method: "POST", body: "{}" })).status).toBe(401);
      expect(
        (
          await h.app.request("/api/reads/batch", {
            method: "POST",
            body: JSON.stringify({ post_ids: ["x"] }),
          })
        ).status,
      ).toBe(401);
      expect((await h.app.request("/api/reads?ids=x")).status).toBe(401);
    } finally {
      h.close();
    }
  });

  test("single write rejects malformed bodies with 400 and unknown posts with 404", async () => {
    const h = buildApp({ mode: "open" });
    try {
      createAgents(h.t.store, ["a", "b"]);
      const root = post(h.t, "a", "private", "V1");
      const cases: string[] = [
        "{}",
        JSON.stringify({ post_id: "" }),
        JSON.stringify({ post_id: 42 }),
        JSON.stringify({ post_id: "x".repeat(129) }),
        "[]",
      ];
      for (const body of cases) {
        const res = await h.app.request("/api/reads", {
          method: "POST",
          headers: as("owner"),
          body,
        });
        expect(res.status).toBe(400);
        expect((await json(res)).code).toBe("BAD_REQUEST");
      }
      const unknown = await h.app.request("/api/reads", {
        method: "POST",
        headers: as("owner"),
        body: JSON.stringify({ post_id: "missing" }),
      });
      expect(unknown.status).toBe(404);
      const invisible = await h.app.request("/api/reads", {
        method: "POST",
        headers: as("b"),
        body: JSON.stringify({ post_id: root.id }),
      });
      expect(invisible.status).toBe(404);
    } finally {
      h.close();
    }
  });

  test("batch validates shape/limits and silently skips unknown or invisible ids", async () => {
    const h = buildApp({ mode: "open" });
    try {
      createAgents(h.t.store, ["a", "b"]);
      const created = bulkPosts(h.t, 100);
      const ids = created.map((row) => row.id);

      const bad: unknown[] = [
        {},
        { post_ids: [] },
        { post_ids: "nope" },
        { post_ids: [""] },
        { post_ids: [123] },
        { post_ids: ["x".repeat(129)] },
        { post_ids: [...ids, "extra-unique"] }, // 101 unique
      ];
      for (const payload of bad) {
        const res = await h.app.request("/api/reads/batch", {
          method: "POST",
          headers: as("owner"),
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(400);
      }

      const mixed = await h.app.request("/api/reads/batch", {
        method: "POST",
        headers: as("owner"),
        body: JSON.stringify({ post_ids: [...ids.slice(0, 97), "missing-1", "missing-2", "missing-3"] }),
      });
      expect(mixed.status).toBe(200);
      const mixedBody = await json(mixed);
      expect(mixedBody.stored).toBe(97);
      expect(mixedBody.skipped.sort()).toEqual(["missing-1", "missing-2", "missing-3"]);
      expect(h.t.store.readStatesFor("owner", ids).size).toBe(97);

      // 101 array elements dedupe to 100 unique ids => allowed.
      const deduped = await h.app.request("/api/reads/batch", {
        method: "POST",
        headers: as("owner"),
        body: JSON.stringify({ post_ids: [...ids, ids[0]!] }),
      });
      expect(deduped.status).toBe(200);
      expect((await json(deduped)).stored).toBe(100);
      expect(h.t.store.readStatesFor("owner", ids).size).toBe(100);

      // an agent batch reports invisible ids as skipped instead of failing.
      const hidden = post(h.t, "a", "private", "V2");
      const agentBatch = await json(
        await h.app.request("/api/reads/batch", {
          method: "POST",
          headers: as("b"),
          body: JSON.stringify({ post_ids: [hidden.id, "missing"] }),
        }),
      );
      expect(agentBatch.stored).toBe(0);
      expect(agentBatch.skipped.sort()).toEqual([hidden.id, "missing"].sort());
    } finally {
      h.close();
    }
  });

  test("GET reads validates ids, caps at 200 and only returns the caller's rows", async () => {
    const h = buildApp({ mode: "open" });
    try {
      const one = post(h.t, "owner", "one", "G1");
      const two = post(h.t, "owner", "two", "G2");
      h.t.store.markPostRead("owner", one.id);
      h.t.store.markPostRead("owner", two.id);

      expect((await h.app.request("/api/reads")).status).toBe(400);
      expect((await h.app.request("/api/reads?ids=")).status).toBe(400);
      expect((await h.app.request(`/api/reads?ids=${one.id},,${two.id}`)).status).toBe(400);
      const tooMany = Array.from({ length: 201 }, (_, index) => `id-${index}`).join(",");
      expect((await h.app.request(`/api/reads?ids=${tooMany}`)).status).toBe(400);

      const mine = await json(
        await h.app.request(`/api/reads?ids=${two.id},${one.id},missing`),
      );
      expect(mine.ok).toBe(true);
      expect(mine.reads).toEqual([
        { post_id: two.id, read_at: T0 },
        { post_id: one.id, read_at: T0 },
      ]);

      const other = await json(
        await h.app.request(`/api/reads?ids=${one.id}`, { headers: as("manager") }),
      );
      expect(other.reads).toEqual([]);
      const exactly200 = Array.from({ length: 200 }, (_, index) => `id-${index}`).join(",");
      expect((await h.app.request(`/api/reads?ids=${exactly200}`)).status).toBe(200);
    } finally {
      h.close();
    }
  });

  test("20 concurrent POSTs land one row, one read_at, no 5xx", async () => {
    const h = buildApp({ mode: "open" });
    try {
      const root = post(h.t, "owner", "race", "A11");
      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          h.app.request("/api/reads", {
            method: "POST",
            headers: as("owner"),
            body: JSON.stringify({ post_id: root.id }),
          }),
        ),
      );
      for (const res of responses) {
        expect([200, 201]).toContain(res.status);
      }
      const bodies = await Promise.all(responses.map(json));
      expect(bodies.filter((body) => body.created === true)).toHaveLength(1);
      expect(new Set(bodies.map((body) => body.read_at)).size).toBe(1);
      const count = h.t.db
        .query("SELECT COUNT(*) AS c FROM post_reads WHERE account_id = 'owner' AND post_id = ?")
        .get(root.id) as { c: number };
      expect(count.c).toBe(1);
    } finally {
      h.close();
    }
  });

  test("PostView read fields flow through every read endpoint", async () => {
    const h = buildApp({ mode: "open" });
    try {
      const root = post(h.t, "owner", "root", "E1");
      const reply = h.t.store.commitOps({
        author: "owner",
        batchId: "E2",
        ops: [{ op: "reply", parent: root.id, body: "reply" }],
      }).posts[0]!;
      await h.app.request("/api/reads", {
        method: "POST",
        headers: as("owner"),
        body: JSON.stringify({ post_id: root.id }),
      });

      const single = await json(await h.app.request(`/api/posts/${root.id}`, { headers: as("owner") }));
      expect(single.post.read).toBe(true);
      expect(single.post.read_at).toBe(T0);
      const replySingle = await json(
        await h.app.request(`/api/posts/${reply.id}`, { headers: as("owner") }),
      );
      expect(replySingle.post.read).toBe(false);

      const timeline = await json(await h.app.request("/api/timeline", { headers: as("owner") }));
      expect(timeline.posts.every((row: Record<string, unknown>) => "read" in row)).toBe(true);

      const thread = await json(
        await h.app.request(`/api/thread/${root.id}`, { headers: as("owner") }),
      );
      const rootNode = thread.thread.posts.find((node: Record<string, any>) => node.id === root.id);
      expect(rootNode.read).toBe(true);
      expect(rootNode.read_at).toBe(T0);

      const history = await json(
        await h.app.request("/api/notifications/history", { headers: as("owner") }),
      );
      expect(Array.isArray(history.events)).toBe(true);
      const unread = await json(
        await h.app.request("/api/notifications?peek=1", { headers: as("owner") }),
      );
      expect(typeof unread.unread_count).toBe("number");
      expect(typeof unread.unread_by_target).toBe("object");

      // write receipts hydrate with the same read fields (new post => unread).
      const receipt = await json(
        await h.app.request("/api/posts", {
          method: "POST",
          headers: as("owner"),
          body: JSON.stringify({ body: "fresh receipt" }),
        }),
      );
      expect(receipt.posts[0].read).toBe(false);
      expect(receipt.posts[0].read_at).toBeNull();
    } finally {
      h.close();
    }
  });
});

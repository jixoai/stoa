import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server/http.ts";
import { AuthManager } from "../src/server/auth.ts";
import { Presence } from "../src/server/presence.ts";
import { makeStore, createAgents, tempDir } from "./helpers.ts";

const T0 = 1_700_000_000_000;

function buildApp(opts: { mode: "open" | "auth" }) {
  const t = makeStore({ clock: () => T0 });
  const envDir = tempDir();
  const envPath = join(envDir, "env");
  writeFileSync(
    envPath,
    opts.mode === "auth" ? "FDE2E_REPORT_AUTH=topsecret\n" : "# open mode\n",
  );
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
    instanceId: "inst-1",
    startedAt: T0,
    openExposed: false,
    port: 13680,
  });
  return { t, app, presence, envPath };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("HTTP API (report-surface: health/CORS/SEED)", () => {
  test("healthz and capabilities are public", async () => {
    const { t, app } = buildApp({ mode: "auth" });
    try {
      const health = await app.request("/healthz");
      expect(health.status).toBe(200);
      const body = await json(health);
      expect(body.dataDir).toBe(t.dir);
      expect(body.instanceId).toBe("inst-1");
      const caps = await json(await app.request("/api/capabilities"));
      expect(caps.product).toBe("fde2e-report-worker");
      expect(caps.protocol).toBe(1);
    } finally {
      t.close();
    }
  });

  test("CORS echoes only exact allowed origins and rejects lookalikes", async () => {
    const { t, app } = buildApp({ mode: "open" });
    try {
      const allowed = [
        "https://report.worker.fde2e.com",
        "https://local-myhost-report.fde2e.com",
        "http://localhost:5173",
        "http://127.0.0.1:8080",
      ];
      for (const origin of allowed) {
        const res = await app.request("/healthz", { headers: { origin } });
        expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      }
      for (const origin of [
        "https://local-x.fde2e.com.evil.com",
        "https://evil.com",
        "http://192.168.1.10:13610",
        "https://local-x.fde2e.com.evil",
      ]) {
        const res = await app.request("/healthz", { headers: { origin } });
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      }
      const preflight = await app.request("/api/posts", {
        method: "OPTIONS",
        headers: {
          origin: "https://report.worker.fde2e.com",
          "access-control-request-method": "POST",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
      const evilPreflight = await app.request("/api/posts", {
        method: "OPTIONS",
        headers: { origin: "https://local-x.fde2e.com.evil.com" },
      });
      expect(evilPreflight.status).toBe(204);
      expect(evilPreflight.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      t.close();
    }
  });

  test("auth mode: 401 without credentials, login/Bearer and account tokens work", async () => {
    const { t, app } = buildApp({ mode: "auth" });
    try {
      createAgents(t.store, ["a"]);
      expect((await app.request("/api/who")).status).toBe(401);
      const login = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: "topsecret" }),
      });
      expect(login.status).toBe(200);
      const loginBody = await json(login);
      const accessToken = loginBody.token as string;
      expect(accessToken.startsWith("v1.")).toBe(true);
      expect(JSON.stringify(loginBody)).not.toContain("topsecret");
      const who = await app.request("/api/who", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(who.status).toBe(200);
      // declared identity is ignored in auth mode
      expect(
        (
          await app.request("/api/who", {
            headers: { "x-report-account": "a" },
          })
        ).status,
      ).toBe(401);
      const accountToken = await app.request("/api/accounts", {
        headers: { authorization: `Bearer ${t.store.rotateAccount("a").token}` },
      });
      expect(accountToken.status).toBe(200); // any authenticated account may list
    } finally {
      t.close();
    }
  });

  test("open mode: declared identity can write and read", async () => {
    const { t, app } = buildApp({ mode: "open" });
    try {
      createAgents(t.store, ["a"]);
      const posted = await app.request("/api/posts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-report-account": "a" },
        body: JSON.stringify({ body: "hello http" }),
      });
      expect(posted.status).toBe(201);
      const body = await json(posted);
      expect((body.posts as Array<{ body_md: string }>)[0]!.body_md).toBe("hello http");
      const timeline = await json(
        await app.request("/api/timeline", { headers: { "x-report-account": "a" } }),
      );
      expect((timeline.posts as unknown[]).length).toBe(1);
      // unknown declared account is rejected
      expect(
        (
          await app.request("/api/timeline", {
            headers: { "x-report-account": "ghost" },
          })
        ).status,
      ).toBe(401);
    } finally {
      t.close();
    }
  });

  test("SSE answers 204 (not 401) when the ticket is missing/invalid", async () => {
    const { t, app } = buildApp({ mode: "auth" });
    try {
      const res = await app.request("/api/stream");
      expect(res.status).toBe(204);
      const bad = await app.request("/api/stream?ticket=nope");
      expect(bad.status).toBe(204);
    } finally {
      t.close();
    }
  });

  test("ticket endpoint issues single-use tickets for authenticated callers", async () => {
    const { t, app } = buildApp({ mode: "auth" });
    try {
      const created = t.store.createAccount({ id: "a" });
      const res = await app.request("/api/stream/ticket", {
        method: "POST",
        headers: { authorization: `Bearer ${created.token}` },
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(typeof body.ticket).toBe("string");
    } finally {
      t.close();
    }
  });

  test("media upload is content-addressed, typed and size-limited", async () => {
    const { t, app } = buildApp({ mode: "open" });
    try {
      createAgents(t.store, ["a"]);
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const uploaded = await app.request("/api/media", {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "x-report-account": "a",
          "x-filename": "shot.png",
        },
        body: new Blob([bytes]),
      });
      expect(uploaded.status).toBe(201);
      const media = await json(uploaded);
      expect(media.ext).toBe("png");
      const fetched = await app.request(`/api/media/${media.hash}`, {
        headers: { "x-report-account": "a" },
      });
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get("content-type")).toContain("image/png");
      expect(existsSync(join(t.dir, "media", `${media.hash}.png`))).toBe(true);

      const bad = await app.request("/api/media", {
        method: "POST",
        headers: { "content-type": "text/html", "x-report-account": "a" },
        body: new Blob(["<html>"]),
      });
      expect(bad.status).toBe(415);

      const tooLarge = await app.request("/api/media", {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "x-report-account": "a",
          "content-length": String(11 * 1024 * 1024),
        },
        body: new Blob([]),
      });
      expect(tooLarge.status).toBe(413);
    } finally {
      t.close();
    }
  });

  test("timeline pagination + thread + read + search", async () => {
    const { t, app } = buildApp({ mode: "open" });
    try {
      createAgents(t.store, ["a"]);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await app.request("/api/posts", {
          method: "POST",
          headers: { "content-type": "application/json", "x-report-account": "a" },
          body: JSON.stringify({ body: `post ${i}` }),
        });
        ids.push(((await json(res)).posts as Array<{ id: string }>)[0]!.id);
      }
      const page1 = await json(
        await app.request("/api/timeline?limit=2", { headers: { "x-report-account": "a" } }),
      );
      expect((page1.posts as unknown[]).length).toBe(2);
      expect(page1.has_more).toBe(true);
      const page2 = await json(
        await app.request(`/api/timeline?limit=2&before=${page1.next_cursor}`, {
          headers: { "x-report-account": "a" },
        }),
      );
      expect((page2.posts as unknown[]).length).toBe(1);
      expect(page2.has_more).toBe(false);

      const thread = await json(
        await app.request(`/api/thread/${ids[0]}`, { headers: { "x-report-account": "a" } }),
      );
      expect((thread.thread as { posts: unknown[] }).posts).toHaveLength(1);
      expect(
        (
          await app.request("/api/thread/does-not-exist", {
            headers: { "x-report-account": "a" },
          })
        ).status,
      ).toBe(404);
      const read = await json(
        await app.request("/api/read?limit=2&order=asc", {
          headers: { "x-report-account": "a" },
        }),
      );
      expect((read.posts as Array<{ body_md: string }>).map((p) => p.body_md)).toEqual([
        "post 0",
        "post 1",
      ]);
      const search = await json(
        await app.request("/api/search?q=post%202", { headers: { "x-report-account": "a" } }),
      );
      expect((search.posts as unknown[]).length).toBe(1);
    } finally {
      t.close();
    }
  });

  test("drafts, notifications and ack over HTTP", async () => {
    const { t, app } = buildApp({ mode: "open" });
    try {
      createAgents(t.store, ["a", "b"]);
      const draft = await json(
        await app.request("/api/drafts", {
          method: "POST",
          headers: { "content-type": "application/json", "x-report-account": "a" },
          body: "{}",
        }),
      );
      const draftId = (draft.draft as { id: string }).id;
      const append = await app.request(`/api/drafts/${draftId}/items`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-report-account": "a" },
        body: JSON.stringify({ op: { op: "post", body: "batched @b" } }),
      });
      expect(append.status).toBe(200);
      const commit = await app.request(`/api/drafts/${draftId}/commit`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-report-account": "a" },
        body: "{}",
      });
      expect(commit.status).toBe(200);
      const committed = await json(commit);
      expect((committed.posts as unknown[]).length).toBe(1);

      const peek = await json(
        await app.request("/api/notifications?peek=1", {
          headers: { "x-report-account": "b" },
        }),
      );
      const events = peek.events as Array<{ seq: number; type: string }>;
      expect(events.some((e) => e.type === "thread.invited")).toBe(true);
      const target = peek.target as number;
      const ack = await json(
        await app.request("/api/notifications/ack", {
          method: "POST",
          headers: { "content-type": "application/json", "x-report-account": "b" },
          body: JSON.stringify({ target }),
        }),
      );
      expect(ack.cursor).toBe(target);
      const empty = await json(
        await app.request("/api/notifications?peek=1", {
          headers: { "x-report-account": "b" },
        }),
      );
      expect((empty.events as unknown[]).length).toBe(0);
      const cursor = await json(
        await app.request("/api/cursor", { headers: { "x-report-account": "b" } }),
      );
      expect(cursor.cursor).toBe(target);
    } finally {
      t.close();
    }
  });

  test("accounts endpoints never return tokens", async () => {
    const { t, app } = buildApp({ mode: "open" });
    try {
      const created = await json(
        await app.request("/api/accounts", {
          method: "POST",
          headers: { "content-type": "application/json", "x-report-account": "manager" },
          body: JSON.stringify({ id: "a", profile: "agent a" }),
        }),
      );
      const serialized = JSON.stringify(created);
      expect(serialized).not.toMatch(/FDE2E_REPORT_ACCOUNT_TOKEN/);
      expect(serialized).not.toMatch(/[A-Za-z0-9_-]{40,}/);
      expect(String(created.env_file)).toContain("accounts/a.env");
      const list = await json(
        await app.request("/api/accounts", { headers: { "x-report-account": "manager" } }),
      );
      expect(JSON.stringify(list)).not.toMatch(/FDE2E_REPORT_ACCOUNT_TOKEN/);
      const forbidden = await app.request("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-report-account": "a" },
        body: JSON.stringify({ id: "b" }),
      });
      expect(forbidden.status).toBe(403);
    } finally {
      t.close();
    }
  });

  test("status and export endpoints", async () => {
    const { t, app } = buildApp({ mode: "open" });
    try {
      createAgents(t.store, ["a"]);
      const created = t.store.commitOps({
        author: "a",
        batchId: "X1",
        ops: [{ op: "post", body: "export me" }],
      });
      const rootId = created.posts[0]!.id;
      const status = await json(
        await app.request("/api/status", { headers: { "x-report-account": "manager" } }),
      );
      expect((status.counts as { posts: number }).posts).toBe(1);
      t.store.commitOps({
        author: "a",
        batchId: "X2",
        ops: [{ op: "post", body: "xss </script><script>alert(1)</script> done" }],
      });
      const exported = await app.request("/api/export", {
        method: "POST",
        headers: { "content-type": "application/json", "x-report-account": "manager" },
        body: "{}",
      });
      expect(exported.status).toBe(200);
      const body = await json(exported);
      expect(body.as_of_seq).toBe(t.store.maxEventSeq());
      expect(existsSync(join(t.dir, "export", "index.html"))).toBe(true);
      expect(existsSync(join(t.dir, "export", "p", `${rootId}.html`))).toBe(true);
      const index = await Bun.file(join(t.dir, "export", "index.html")).text();
      expect(index).not.toContain("</script><script>alert(1)");
      expect(index).toContain("\\u003c/script");
      const forbidden = await app.request("/api/export", {
        method: "POST",
        headers: { "content-type": "application/json", "x-report-account": "a" },
        body: "{}",
      });
      expect(forbidden.status).toBe(403);
    } finally {
      t.close();
    }
  });
});

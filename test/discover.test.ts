import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server/http.ts";
import { AuthManager } from "../src/server/auth.ts";
import { Presence } from "../src/server/presence.ts";
import type { Role } from "../src/core/types.ts";
import {
  createAgents,
  initWorkspace,
  makeStore,
  runCli,
  startTestServer,
  tempDir,
  type RunningTestServer,
  type TestWorkspace,
} from "./helpers.ts";

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const OWNER = { id: "owner", role: "owner" as const };
const AGENT_B = { id: "b", role: "agent" as const };

let batchSeq = 0;

function post(
  t: ReturnType<typeof makeStore>,
  author: string,
  body: string,
  tags: string[] = [],
) {
  batchSeq += 1;
  return t.store.commitOps({
    author,
    batchId: `discover-${batchSeq}`,
    ops: [{ op: "post", body, tags }],
  }).posts[0]!;
}

function buildOpenApp() {
  const t = makeStore({ clock: () => T0 });
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
  const app = createApp({
    store: t.store,
    auth,
    presence: new Presence(),
    dataDir: t.dir,
    instanceId: "discover-inst",
    startedAt: T0,
    openExposed: false,
    port: 13680,
  });
  return { t, app };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("trending tags (store)", () => {
  test("empty board returns an empty array", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      expect(t.store.trendingTags({ viewer: OWNER })).toEqual([]);
    } finally {
      t.close();
    }
  });

  test("only the viewer's visible, non-deleted root posts are aggregated", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b", "c"]);
      post(t, "a", "visible to b @b", ["shared"]);
      post(t, "a", "a only", ["secret"]);
      // replies are never counted even when they carry tags
      const root = t.store.timeline({ viewer: OWNER }).posts[0]!;
      t.store.commitOps({
        author: "a",
        batchId: "discover-reply",
        ops: [{ op: "reply", parent: root.id, body: "reply", tags: ["reply-tag"] }],
      });

      // b participates in the first root but not the second
      expect(t.store.trendingTags({ viewer: AGENT_B }).map((tag) => tag.tag)).toEqual(["shared"]);
      // c participates in nothing
      expect(t.store.trendingTags({ viewer: { id: "c", role: "agent" } })).toEqual([]);
      // owner sees everything, and only one use of `shared` (the root)
      const ownerTags = t.store.trendingTags({ viewer: OWNER });
      expect(new Set(ownerTags.map((tag) => tag.tag))).toEqual(new Set(["shared", "secret"]));
      expect(ownerTags.find((tag) => tag.tag === "shared")!.count).toBe(1);
    } finally {
      t.close();
    }
  });

  test("soft-deleted roots stop contributing", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      const root = post(t, "a", "will be deleted @b", ["gone"]);
      expect(t.store.trendingTags({ viewer: AGENT_B }).map((tag) => tag.tag)).toEqual(["gone"]);
      t.store.softDelete(root.id, { id: "a", role: "agent" as Role });
      expect(t.store.trendingTags({ viewer: AGENT_B })).toEqual([]);
      expect(t.store.trendingTags({ viewer: OWNER })).toEqual([]);
    } finally {
      t.close();
    }
  });

  test("score = count × exp(-age_days / 7) with recency from the last use", () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      createAgents(t.store, ["a"]);
      now = T0 - 14 * DAY;
      for (let i = 0; i < 4; i++) post(t, "a", `old ${i}`, ["old"]);
      now = T0 - 3_600_000;
      post(t, "a", "fresh", ["fresh"]);
      now = T0 - 60_000;
      post(t, "a", "steady 1", ["steady"]);
      now = T0;
      post(t, "a", "steady 2", ["steady"]);

      const tags = t.store.trendingTags({ viewer: OWNER, now: T0 });
      expect(tags.map((tag) => tag.tag)).toEqual(["steady", "fresh", "old"]);
      expect(tags[0]!.count).toBe(2);
      expect(tags[0]!.last_used_at).toBe(T0);
      expect(tags[0]!.score).toBeCloseTo(2, 9);
      expect(tags[1]!.score).toBeCloseTo(Math.exp(-1 / 168), 9);
      expect(tags[2]!.count).toBe(4);
      expect(tags[2]!.last_used_at).toBe(T0 - 14 * DAY);
      expect(tags[2]!.score).toBeCloseTo(4 * Math.exp(-2), 9);
    } finally {
      t.close();
    }
  });

  test("limit defaults to 12 and caps at 50", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a"]);
      for (let round = 0; round < 7; round++) {
        const tags = Array.from({ length: 8 }, (_, i) => `t${round}${i}`);
        post(t, "a", `round ${round}`, tags);
      }
      expect(t.store.trendingTags({ viewer: OWNER })).toHaveLength(12);
      expect(t.store.trendingTags({ viewer: OWNER, limit: 3 })).toHaveLength(3);
      expect(t.store.trendingTags({ viewer: OWNER, limit: 999 })).toHaveLength(50);
      expect(t.store.trendingTags({ viewer: OWNER, limit: 0 })).toEqual([]);
    } finally {
      t.close();
    }
  });
});

describe("suggested accounts (store)", () => {
  test("excludes self, orders by followers then recent post, and marks following", () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      createAgents(t.store, ["a", "b", "c"]);
      now = T0 - 2 * DAY;
      post(t, "manager", "manager post");
      now = T0 - 5 * DAY;
      post(t, "b", "b post");
      now = T0;
      post(t, "c", "c post");

      // a has 2 followers, b has 3, c and manager have 1 each
      t.store.follow("owner", "a");
      t.store.follow("manager", "a");
      t.store.follow("owner", "b");
      t.store.follow("manager", "b");
      t.store.follow("c", "b");
      t.store.follow("a", "c");

      const rows = t.store.suggestedAccounts({ viewer: OWNER, limit: 10 });
      expect(rows.map((row) => row.id)).toEqual(["b", "a", "c", "manager"]);
      expect(rows.map((row) => row.followers)).toEqual([3, 2, 1, 1]);

      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get("b")!.following).toBe(true);
      expect(byId.get("a")!.following).toBe(true);
      expect(byId.get("c")!.following).toBe(false);
      expect(byId.get("c")!.last_post_at).toBe(T0);
      expect(byId.get("manager")!.last_post_at).toBe(T0 - 2 * DAY);
      // ties on followers break by most recent post: c (now) before manager (-2d)
      expect(byId.get("a")!.last_post_at).toBeNull();
      expect(rows.every((row) => row.id !== "owner")).toBe(true);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(
          ["avatar", "display", "followers", "following", "id", "last_post_at", "profile", "role"],
        );
      }
    } finally {
      t.close();
    }
  });

  test("last_post_at never advertises activity in a hidden thread", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b"]);
      post(t, "a", "a private note");
      post(t, "manager", "manager private note");
      // b participates in nothing, so it may only see its own (none) activity
      const rows = t.store.suggestedAccounts({ viewer: AGENT_B, limit: 10 });
      expect(rows.find((row) => row.id === "a")!.last_post_at).toBeNull();
      expect(rows.find((row) => row.id === "manager")!.last_post_at).toBeNull();
      // owner sees both threads
      const ownerRows = t.store.suggestedAccounts({ viewer: OWNER, limit: 10 });
      expect(ownerRows.find((row) => row.id === "a")!.last_post_at).toBe(T0);
      expect(ownerRows.find((row) => row.id === "manager")!.last_post_at).toBe(T0);
    } finally {
      t.close();
    }
  });

  test("tombstones disappear and their outgoing follows stop counting", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["a", "b", "c"]);
      t.store.follow("owner", "b");
      t.store.follow("c", "b");
      expect(t.store.suggestedAccounts({ viewer: OWNER }).find((row) => row.id === "b")!.followers).toBe(2);
      t.store.removeAccount("c");
      const rows = t.store.suggestedAccounts({ viewer: OWNER, limit: 10 });
      expect(rows.map((row) => row.id)).not.toContain("c");
      expect(rows.find((row) => row.id === "b")!.followers).toBe(1);
    } finally {
      t.close();
    }
  });

  test("empty directory (no other active accounts) returns an empty array", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      t.db.query("UPDATE accounts SET disabled = 2 WHERE id = 'manager'").run();
      expect(t.store.suggestedAccounts({ viewer: OWNER })).toEqual([]);
    } finally {
      t.close();
    }
  });
});

describe("discovery HTTP API", () => {
  test("both endpoints answer the caller's visibility slice and validate limit", async () => {
    const { t, app } = buildOpenApp();
    try {
      createAgents(t.store, ["a", "b"]);
      post(t, "a", "visible to b @b", ["result", "shared"]);
      post(t, "a", "a only", ["secret"]);
      const asB = { "x-report-account": "b" };

      const trending = await json(
        await app.request("/api/tags/trending", { headers: asB }),
      );
      expect(trending.ok).toBe(true);
      const tags = trending.tags as Array<{ tag: string; count: number; last_used_at: number; score: number }>;
      expect(new Set(tags.map((tag) => tag.tag))).toEqual(new Set(["result", "shared"]));
      for (const tag of tags) {
        expect(tag.count).toBe(1);
        expect(tag.last_used_at).toBe(T0);
        expect(typeof tag.score).toBe("number");
      }

      const suggested = await json(
        await app.request("/api/accounts/suggested", { headers: asB }),
      );
      expect(suggested.ok).toBe(true);
      const accounts = suggested.accounts as Array<{ id: string; following: boolean }>;
      expect(accounts.map((account) => account.id)).not.toContain("b");
      expect(accounts.map((account) => account.id)).toContain("owner");
      expect(accounts.find((account) => account.id === "manager")!.following).toBe(false);

      for (const path of [
        "/api/tags/trending?limit=0",
        "/api/tags/trending?limit=abc",
        "/api/accounts/suggested?limit=0",
        "/api/accounts/suggested?limit=abc",
      ]) {
        expect((await app.request(path, { headers: asB })).status).toBe(400);
      }
      // limit above the cap is clamped, not rejected
      expect((await app.request("/api/tags/trending?limit=51", { headers: asB })).status).toBe(200);
      // unknown declared identity is rejected (open mode still requires a real account)
      expect(
        (await app.request("/api/tags/trending", { headers: { "x-report-account": "ghost" } })).status,
      ).toBe(401);
    } finally {
      t.close();
    }
  });
});

// ── CLI `discover` against a real server ─────────────────────────────────────
let ws: TestWorkspace;
let server: RunningTestServer;

beforeAll(async () => {
  ws = initWorkspace({ open: true });
  server = await startTestServer({ workspace: ws });
  for (const id of ["tagged", "other"]) {
    const res = await runCli(["accounts", "create", id, "--data-dir", ws.dataDir, "--as", "manager"]);
    expect(res.code).toBe(0);
  }
});

afterAll(async () => {
  await server.stop();
  ws.cleanup();
});

describe("CLI discover", () => {
  test("--tags and --accounts return machine-readable discovery data", async () => {
    for (let i = 0; i < 2; i++) {
      const posted = await runCli([
        "post",
        `tagged ${i}`,
        "--tag",
        "result",
        "--data-dir",
        ws.dataDir,
        "--as",
        "tagged",
      ]);
      expect(posted.code).toBe(0);
    }
    const other = await runCli([
      "post",
      "other note",
      "--tag",
      "note",
      "--data-dir",
      ws.dataDir,
      "--as",
      "other",
    ]);
    expect(other.code).toBe(0);
    const follow = await runCli(["follow", "tagged", "--data-dir", ws.dataDir, "--as", "owner"]);
    expect(follow.code).toBe(0);

    const tags = await runCli(["discover", "--tags", "--data-dir", ws.dataDir, "--as", "owner"]);
    expect(tags.code).toBe(0);
    const tagBody = JSON.parse(tags.stdout) as {
      ok: boolean;
      tags: Array<{ tag: string; count: number }>;
    };
    expect(tagBody.ok).toBe(true);
    expect(tagBody.tags[0]!.tag).toBe("result");
    expect(tagBody.tags[0]!.count).toBe(2);

    const limited = await runCli([
      "discover",
      "--tags",
      "--limit",
      "1",
      "--data-dir",
      ws.dataDir,
      "--as",
      "owner",
    ]);
    expect((JSON.parse(limited.stdout) as { tags: unknown[] }).tags).toHaveLength(1);

    const accounts = await runCli([
      "discover",
      "--accounts",
      "--data-dir",
      ws.dataDir,
      "--as",
      "owner",
    ]);
    expect(accounts.code).toBe(0);
    const accountBody = JSON.parse(accounts.stdout) as {
      ok: boolean;
      accounts: Array<{ id: string; following: boolean; followers: number }>;
    };
    expect(accountBody.ok).toBe(true);
    expect(accountBody.accounts.map((account) => account.id)).not.toContain("owner");
    expect(accountBody.accounts.find((account) => account.id === "tagged")!.following).toBe(true);

    const human = await runCli([
      "discover",
      "--tags",
      "--human",
      "--data-dir",
      ws.dataDir,
      "--as",
      "owner",
    ]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("#result");

    const missing = await runCli(["discover", "--data-dir", ws.dataDir, "--as", "owner"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("exactly one of --tags or --accounts");

    const both = await runCli([
      "discover",
      "--tags",
      "--accounts",
      "--data-dir",
      ws.dataDir,
      "--as",
      "owner",
    ]);
    expect(both.code).not.toBe(0);
  }, 60000);
});

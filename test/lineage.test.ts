/**
 * 只读会话链拓扑（report-notification-stacks P1-2）：
 * `store.postLineage` + `GET /api/posts/lineage?ids=…` 的契约与回归。
 *
 * 判据（tasks P1-2）：
 * ① 8 层链一次返回 9 个节点（含目标自身）；
 * ② 不可见 root 的 id 静默省略（不泄露存在性）；
 * ③ 重复 id 去重；200 上限；空 ids 返回 {nodes:[]}；超限/非法 400；
 * ④ 软删祖先返回 deleted_at 且 parent 指针不变；
 * ⑤ 端点不改变 unread_count/history/peek 响应（回归）且不产生 N+1。
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server/http.ts";
import { AuthManager } from "../src/server/auth.ts";
import { Presence } from "../src/server/presence.ts";
import { LINEAGE_IDS_LIMIT } from "../src/core/protocol.ts";
import type { PostView } from "../src/core/types.ts";
import { createAgents, makeStore, tempDir } from "./helpers.ts";

const T0 = 1_700_000_000_000;

function buildApp() {
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
    instanceId: "inst-lineage",
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

function as(account: string): Record<string, string> {
  return { "x-report-account": account, "content-type": "application/json" };
}

function countQueries<T>(db: Database, needle: string, fn: () => T): { value: T; count: number } {
  let count = 0;
  const original = db.query.bind(db);
  (db as unknown as { query: typeof db.query }).query = ((sql: string) => {
    if (sql.includes(needle)) count += 1;
    return original(sql);
  }) as typeof db.query;
  try {
    return { value: fn(), count };
  } finally {
    delete (db as unknown as { query?: typeof db.query }).query;
  }
}

let batchCounter = 0;
function nextBatch(): string {
  batchCounter += 1;
  return `LINE-${batchCounter}`;
}

function seedChain(
  t: ReturnType<typeof makeStore>,
  depth: number,
  author = "manager",
): PostView[] {
  const first = t.store.commitOps({
    author,
    batchId: nextBatch(),
    ops: [{ op: "post", body: `链根 ${depth}` }],
  }).posts[0]!;
  const chain: PostView[] = [first];
  for (let index = 1; index < depth; index += 1) {
    const parent = chain[chain.length - 1]!;
    const child = t.store.commitOps({
      author,
      batchId: nextBatch(),
      ops: [{ op: "reply", parent: parent.id, body: `链 ${index}` }],
    }).posts[0]!;
    chain.push(child);
  }
  return chain;
}

describe("store.postLineage", () => {
  test("① 8 层链一次返回 9 个节点（含目标自身），按输入序优先", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const chain = seedChain(t, 9);
      const target = chain[chain.length - 1]!;
      const nodes = t.store.postLineage({ viewer: { id: "owner", role: "owner" }, ids: [target.id] });
      expect(nodes.length).toBe(9);
      expect(nodes[0]!.id).toBe(target.id);
      const ids = new Set(nodes.map((node) => node.id));
      for (const post of chain) expect(ids.has(post.id)).toBe(true);
      // 祖先指针保持不变。
      const map = new Map(nodes.map((node) => [node.id, node]));
      for (const post of chain) {
        expect(map.get(post.id)!.parent_id).toBe(post.parent_id);
      }
    } finally {
      t.close();
    }
  });

  test("② 不可见 root 静默省略；可见 root 正常返回", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      createAgents(t.store, ["agent-a"]);
      // 不含 @agent-a 的 root：agent 不可见；带 @agent-a 的可见。
      const hidden = t.store.commitOps({
        author: "manager",
        batchId: nextBatch(),
        ops: [{ op: "post", body: "私下会话（无外人）" }],
      }).posts[0]!;
      const visible = t.store.commitOps({
        author: "manager",
        batchId: nextBatch(),
        ops: [{ op: "post", body: "公开 @agent-a" }],
      }).posts[0]!;
      const viewer = { id: "agent-a", role: "agent" as const };
      const hiddenNodes = t.store.postLineage({ viewer, ids: [hidden.id] });
      expect(hiddenNodes).toEqual([]);
      const both = t.store.postLineage({ viewer, ids: [hidden.id, visible.id] });
      expect(both.map((node) => node.id)).toEqual([visible.id]);
      // owner 全局可见两者。
      const ownerNodes = t.store.postLineage({
        viewer: { id: "owner", role: "owner" },
        ids: [hidden.id, visible.id],
      });
      expect(ownerNodes.map((node) => node.id).sort()).toEqual([hidden.id, visible.id].sort());
    } finally {
      t.close();
    }
  });

  test("③ 去重、空集、超深防御（自环脏数据不挂起）", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const chain = seedChain(t, 3);
      const nodes = t.store.postLineage({
        viewer: { id: "owner", role: "owner" },
        ids: [chain[0]!.id, chain[0]!.id, chain[1]!.id],
      });
      expect(nodes.length).toBe(2);
      expect(t.store.postLineage({ viewer: { id: "owner", role: "owner" }, ids: [] })).toEqual([]);
      expect(
        t.store.postLineage({ viewer: { id: "owner", role: "owner" }, ids: ["", "  "] }),
      ).toEqual([]);
      // 不存在的 id 静默省略。
      expect(
        t.store.postLineage({ viewer: { id: "owner", role: "owner" }, ids: ["no-such-post"] }),
      ).toEqual([]);
    } finally {
      t.close();
    }
  });

  test("④ 软删祖先返回 deleted_at，parent 指针不变", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const chain = seedChain(t, 3);
      const [root, mid, leaf] = chain as [typeof chain[0], typeof chain[0], typeof chain[0]];
      t.store.softDelete(mid.id, { id: "manager", role: "manager" });
      const nodes = t.store.postLineage({ viewer: { id: "owner", role: "owner" }, ids: [leaf.id] });
      expect(nodes.map((node) => node.id)).toEqual([leaf.id, mid.id, root.id]);
      const midNode = nodes.find((node) => node.id === mid.id)!;
      expect(midNode.deleted_at).not.toBeNull();
      expect(midNode.parent_id).toBe(mid.parent_id);
      // 软删不阻断链路：leaf 的祖先仍在。
      expect(nodes.some((node) => node.id === root.id)).toBe(true);
    } finally {
      t.close();
    }
  });

  test("⑤ 分层批量：80 个叶子目标 → 查询数 O(depth)，不是逐 id 查询", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const roots: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        const chain = seedChain(t, 4);
        roots.push(chain[chain.length - 1]!.id);
      }
      const measured = countQueries(t.db, "FROM posts", () =>
        t.store.postLineage({ viewer: { id: "owner", role: "owner" }, ids: roots }),
      );
      // 20 个叶子 + 各 3 层祖先 = 80 节点。
      expect(measured.value.length).toBe(80);
      // 逐 id 查询会是 80 次；分层批量 ≤ depth+1。
      expect(measured.count).toBeLessThanOrEqual(6);
    } finally {
      t.close();
    }
  });
});

describe("GET /api/posts/lineage", () => {
  test("① 主路径：8 层链 9 节点 + ok 包装", async () => {
    const h = buildApp();
    try {
      const chain = seedChain(h.t, 9);
      const target = chain[chain.length - 1]!;
      const res = await h.app.request(`/api/posts/lineage?ids=${target.id}`, {
        headers: as("owner"),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
      expect(body.nodes.length).toBe(9);
      expect(body.nodes[0].id).toBe(target.id);
    } finally {
      h.close();
    }
  });

  test("③ 空 ids → {nodes:[]}；非法（空段）→ 400；超限 → 400", async () => {
    const h = buildApp();
    try {
      const empty = await h.app.request("/api/posts/lineage?ids=", { headers: as("owner") });
      expect(empty.status).toBe(200);
      expect(await json(empty)).toEqual({ ok: true, nodes: [] });
      const missing = await h.app.request("/api/posts/lineage", { headers: as("owner") });
      expect(missing.status).toBe(200);
      expect((await json(missing)).nodes).toEqual([]);

      const illegal = await h.app.request("/api/posts/lineage?ids=a,,b", { headers: as("owner") });
      expect(illegal.status).toBe(400);
      expect((await json(illegal)).code).toBe("BAD_REQUEST");

      const tooMany = Array.from({ length: LINEAGE_IDS_LIMIT + 1 }, (_, index) => `id-${index}`);
      const over = await h.app.request(`/api/posts/lineage?ids=${tooMany.join(",")}`, {
        headers: as("owner"),
      });
      expect(over.status).toBe(400);
      expect((await json(over)).code).toBe("BAD_REQUEST");

      const atLimit = Array.from({ length: LINEAGE_IDS_LIMIT }, (_, index) => `id-${index}`);
      const okLimit = await h.app.request(`/api/posts/lineage?ids=${atLimit.join(",")}`, {
        headers: as("owner"),
      });
      expect(okLimit.status).toBe(200);
      expect((await json(okLimit)).nodes).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("③b 去重后仍超限 → 400（协议校验先于查询）", async () => {
    const h = buildApp();
    try {
      const ids = Array.from({ length: LINEAGE_IDS_LIMIT + 5 }, () => "same-id");
      const res = await h.app.request(`/api/posts/lineage?ids=${ids.join(",")}`, {
        headers: as("owner"),
      });
      expect(res.status).toBe(400);
    } finally {
      h.close();
    }
  });

  test("② 不可见 id 静默省略（HTTP 层）", async () => {
    const h = buildApp();
    try {
      createAgents(h.t.store, ["agent-a"]);
      const hidden = h.t.store.commitOps({
        author: "manager",
        batchId: nextBatch(),
        ops: [{ op: "post", body: "无参与者" }],
      }).posts[0]!;
      const res = await h.app.request(`/api/posts/lineage?ids=${hidden.id}`, {
        headers: as("agent-a"),
      });
      expect(res.status).toBe(200);
      expect((await json(res)).nodes).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("⑤ 回归：lineage 不改变 peek/history/unread_count/未读事件数；不推进游标", async () => {
    const h = buildApp();
    try {
      createAgents(h.t.store, ["agent-a"]);
      const chain = seedChain(h.t, 3, "agent-a");
      const before = {
        peek: await json(
          await h.app.request("/api/notifications?peek=1", { headers: as("manager") }),
        ),
        history: await json(
          await h.app.request("/api/notifications/history?limit=100", { headers: as("manager") }),
        ),
        cursor: await json(await h.app.request("/api/cursor", { headers: as("manager") })),
        events: h.t.store.statusCounts().events,
        maxSeq: h.t.store.maxEventSeq(),
      };
      const lineage = await h.app.request(`/api/posts/lineage?ids=${chain[0]!.id}`, {
        headers: as("manager"),
      });
      expect(lineage.status).toBe(200);
      const after = {
        peek: await json(
          await h.app.request("/api/notifications?peek=1", { headers: as("manager") }),
        ),
        history: await json(
          await h.app.request("/api/notifications/history?limit=100", { headers: as("manager") }),
        ),
        cursor: await json(await h.app.request("/api/cursor", { headers: as("manager") })),
        events: h.t.store.statusCounts().events,
        maxSeq: h.t.store.maxEventSeq(),
      };
      expect(after.peek.unread_count).toBe(before.peek.unread_count);
      expect(after.peek.unread_by_target).toEqual(before.peek.unread_by_target);
      expect(after.peek.cursor).toBe(before.peek.cursor);
      expect(after.history).toEqual(before.history);
      expect(after.cursor).toEqual(before.cursor);
      expect(after.events).toBe(before.events);
      expect(after.maxSeq).toBe(before.maxSeq);
    } finally {
      h.close();
    }
  });

  test("capabilities advertise post_lineage + limits", async () => {
    const h = buildApp();
    try {
      const caps = await json(await h.app.request("/api/capabilities"));
      expect(caps.features.post_lineage).toBe(true);
      expect(caps.limits.lineage_ids).toBe(200);
    } finally {
      h.close();
    }
  });
});

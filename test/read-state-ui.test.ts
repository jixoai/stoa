/**
 * report-server-read-state 客户端已读单测（P1-6 + P1-8 的数据层规则）。
 *
 * - 静态归档客户端：三个 reads 接口只读语义 + 零 fetch；hydrate 透传 read/read_at。
 * - ReadSetStore：对账删除（服务端为准）与账号切换清空。
 */
import { describe, expect, test } from "bun:test";
import { StaticReportClient, type ReportSnapshot } from "../src/ui/lib/static-api.ts";
import {
  READ_QUERY_LIMIT,
  chunkIds,
  isReadFromSources,
  planReadReconciliation,
} from "../src/ui/state/read-sync.ts";
import { ReadSetStore, type ReadSetStorage } from "../src/ui/state/read-set-store.ts";

class FakeStorage implements ReadSetStorage {
  values = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
    this.writes += 1;
  }
}

function makeSnapshot(): ReportSnapshot {
  return {
    version: 1,
    as_of_seq: 10,
    viewer: "owner",
    accounts: [
      { id: "owner", display: "Owner", profile: "", avatar: "", role: "owner", disabled: 0 },
      { id: "agent", display: "Agent", profile: "", avatar: "", role: "agent", disabled: 0 },
    ],
    follows: [],
    posts: [
      {
        id: "p-read",
        author: "agent",
        body_md: "已经读过的帖子",
        created_at: 1_000,
        read: true,
        read_at: 1_700_000_000_000,
      },
      {
        id: "p-unread",
        author: "agent",
        body_md: "还没读的帖子",
        created_at: 2_000,
      },
    ],
    participants: {},
    media: [],
    preview_enabled: true,
  };
}

describe("StaticReportClient reads (P1-6)", () => {
  test("markRead/markReads reject READ_ONLY and readStates is empty — zero fetch", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("static archive must not fetch");
    }) as unknown as typeof fetch;
    try {
      const client = new StaticReportClient(makeSnapshot());
      await expect(client.markRead("p-read")).rejects.toMatchObject({ code: "READ_ONLY" });
      await expect(client.markReads(["p-read"])).rejects.toMatchObject({ code: "READ_ONLY" });
      expect(await client.readStates(["p-read"])).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("hydrate passes read/read_at through (missing fields default false/null)", async () => {
    const client = new StaticReportClient(makeSnapshot());
    const read = await client.post("p-read");
    expect(read.read).toBe(true);
    expect(read.read_at).toBe(1_700_000_000_000);

    const unread = await client.post("p-unread");
    expect(unread.read).toBe(false);
    expect(unread.read_at).toBeNull();

    const page = await client.timeline({ limit: 10 });
    const byId = new Map(page.posts.map((post) => [post.id, post]));
    expect(byId.get("p-read")?.read).toBe(true);
    expect(byId.get("p-unread")?.read).toBe(false);
  });

  test("thread nodes inherit read/read_at from the snapshot", async () => {
    const client = new StaticReportClient(makeSnapshot());
    const thread = await client.thread("p-read");
    expect(thread.posts[0]?.read).toBe(true);
    expect(thread.posts[0]?.read_at).toBe(1_700_000_000_000);
  });
});

describe("ReadSetStore reconciliation primitives (P1-8)", () => {
  test("remove drops only the given ids, notifies them and persists", () => {
    const storage = new FakeStorage();
    const store = new ReadSetStore({ storageKey: "read", storage, debounceMs: 0 });
    store.mark("A");
    store.mark("B");
    let a = 0;
    let b = 0;
    store.subscribe("A", () => (a += 1));
    store.subscribe("B", () => (b += 1));

    const removed = store.remove(["B"]);
    expect(removed).toEqual(["B"]);
    expect(store.has("A")).toBe(true);
    expect(store.has("B")).toBe(false);
    expect(a).toBe(0);
    expect(b).toBe(1);
    store.flush();
    expect(JSON.parse(storage.getItem("read")!)).toEqual(["A"]);
  });

  test("clear empties the set and notifies all subscribers (account switch)", () => {
    const store = new ReadSetStore({ storageKey: null });
    store.mark("A");
    store.mark("B");
    let calls = 0;
    store.subscribe("A", () => (calls += 1));
    store.subscribe("B", () => (calls += 1));
    store.clear();
    expect(store.size()).toBe(0);
    expect(calls).toBe(2);
  });
});

// ── P1-8：对账计划 / 三源合并 / 查询分片（纯规则；Provider 直接复用）──────────

describe("read reconciliation helpers", () => {
  test("chunkIds splits 2000 ids into 10 requests of at most 200", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `p${i}`);
    const chunks = chunkIds(ids, READ_QUERY_LIMIT);
    expect(chunks.length).toBe(10);
    expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
    expect(chunks.flat()).toEqual(ids);
  });

  test("server wins: local {A,B} + server {A} + empty queue → drop B", () => {
    const plan = planReadReconciliation({
      localIds: ["A", "B"],
      queuedIds: new Set<string>(),
      serverIds: new Set(["A"]),
    });
    expect(plan.adopt).toEqual(["A"]);
    expect(plan.orphans).toEqual(["B"]);
  });

  test("queued items are kept even when the server does not know them yet", () => {
    const plan = planReadReconciliation({
      localIds: ["A", "B"],
      queuedIds: new Set(["B"]),
      serverIds: new Set(["A"]),
    });
    expect(plan.orphans).toEqual([]);
  });

  test("isRead merges server / local / cursor sources", () => {
    const sources = {
      serverReadIds: new Set(["S"]),
      localReadIds: new Set(["L"]),
      cursor: 10,
    };
    expect(isReadFromSources(sources, "S", 99)).toBe(true);
    expect(isReadFromSources(sources, "L", 99)).toBe(true);
    expect(isReadFromSources(sources, "X", 10)).toBe(true);
    expect(isReadFromSources(sources, "X", 11)).toBe(false);
    expect(isReadFromSources(sources, null, 11)).toBe(false);
  });
});

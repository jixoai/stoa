import { describe, expect, test } from "bun:test";
import { makeStore } from "./helpers.ts";
import {
  PREVIEW_ACCOUNT_HOURLY_LIMIT,
  PREVIEW_GLOBAL_HOURLY_LIMIT,
  claimPreviewBudget,
} from "../src/server/preview/budget.ts";
import { LINK_PREVIEW_PROVIDER } from "../src/server/preview/link-preview/provider.ts";
import { claimNext } from "../src/server/preview/queue.ts";
import { nextPreviewBudgetWindow } from "../src/server/preview/budget.ts";
import { PreviewService } from "../src/server/preview/service.ts";
import type { PreviewTransport } from "../src/core/plugins/types.ts";

const T0 = 1_700_000_000_000;

const dummyTransport: PreviewTransport = {
  head: async () => {
    throw new Error("no network");
  },
  page: async () => {
    throw new Error("no network");
  },
  probe: async () => {
    throw new Error("no network");
  },
};

describe("preview enqueue budget (B2 / spec 资源与滥用限制)", () => {
  test("per-account 60/h and global 500/h window counters", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      let granted = 0;
      for (let i = 0; i < PREVIEW_ACCOUNT_HOURLY_LIMIT; i += 1) {
        granted += claimPreviewBudget(t.db, { accountId: "a1", count: 1, now: T0 }).granted;
      }
      expect(granted).toBe(60);
      const blocked = claimPreviewBudget(t.db, { accountId: "a1", count: 1, now: T0 });
      expect(blocked).toEqual({ granted: 0, reason: "account_budget" });

      // 9 个账号各 60 → 全局 500 封顶。
      let total = granted;
      let lastReason = "ok";
      for (let account = 2; account <= 9; account += 1) {
        for (let i = 0; i < 60; i += 1) {
          const grant = claimPreviewBudget(t.db, { accountId: `a${account}`, count: 1, now: T0 });
          total += grant.granted;
          lastReason = grant.reason;
        }
      }
      expect(total).toBe(PREVIEW_GLOBAL_HOURLY_LIMIT);
      expect(lastReason).toBe("global_budget");
      // 新窗口恢复额度。
      expect(
        claimPreviewBudget(t.db, {
          accountId: "a1",
          count: 1,
          now: T0 + 60 * 60_000,
        }).granted,
      ).toBe(1);
    } finally {
      t.close();
    }
  });

  test("a 200-post × 3-link batch schedules 600 jobs but only 60 run in the current window (R3)", () => {
    const t = makeStore({ clock: () => T0 });
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      const ops = Array.from({ length: 200 }, (_, index) => ({
        op: "post" as const,
        body: `批量 ${index} https://example.com/a/${index} https://example.com/b/${index} https://example.com/c/${index}`,
      }));
      const result = t.store.commitOps({ author: "owner", batchId: "b-bulk", ops });
      expect(result.posts).toHaveLength(200);
      const rows = t.db.query("SELECT COUNT(*) AS c FROM post_previews").get() as { c: number };
      const jobs = t.db.query("SELECT COUNT(*) AS c FROM preview_jobs").get() as { c: number };
      // R3：未授权链接不丢，全部写行/任务，但延迟到下一预算窗口。
      expect(rows.c).toBe(600);
      expect(jobs.c).toBe(600);
      expect(claimNext(t.db, { now: T0, limit: 1000 })).toHaveLength(PREVIEW_ACCOUNT_HOURLY_LIMIT);
      expect(claimNext(t.db, { now: nextPreviewBudgetWindow(T0), limit: 1000 })).toHaveLength(
        600 - PREVIEW_ACCOUNT_HOURLY_LIMIT,
      );
      // R4：按批次聚合（200 帖只 1 条 warn）。
      const limitedWarns = warns.filter((line) => line.includes("preview enqueue limited for batch"));
      expect(limitedWarns).toHaveLength(1);
    } finally {
      console.warn = original;
      t.close();
    }
  });

  test("R3: 59/60 + 2 links → first runs now, second is deferred to the next budget window", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      for (let i = 0; i < 59; i += 1) {
        expect(claimPreviewBudget(t.db, { accountId: "owner", count: 1, now: T0 }).granted).toBe(1);
      }
      const post = t.store.commitOps({
        author: "owner",
        batchId: "b-partial",
        ops: [{ op: "post", body: "两条 https://example.com/one https://example.com/two" }],
      }).posts[0]!;
      expect(post.previews).toHaveLength(2);
      const jobs = t.db
        .query(
          `SELECT pp.url, pj.next_run_at FROM preview_jobs pj
           JOIN post_previews pp ON pp.post_id = pj.post_id AND pp.url_hash = pj.url_hash
           ORDER BY pj.next_run_at ASC, pp.position ASC`,
        )
        .all() as Array<{ url: string; next_run_at: number }>;
      expect(jobs).toHaveLength(2);
      const immediate = jobs.filter((job) => job.next_run_at <= T0);
      const deferred = jobs.filter((job) => job.next_run_at === nextPreviewBudgetWindow(T0));
      expect(immediate).toHaveLength(1);
      expect(deferred).toHaveLength(1);
      expect(immediate[0]!.url).toBe("https://example.com/one");
      expect(deferred[0]!.url).toBe("https://example.com/two");

      const nowClaim = claimNext(t.db, { now: T0, limit: 10 });
      expect(nowClaim).toHaveLength(1);
      const laterClaim = claimNext(t.db, { now: nextPreviewBudgetWindow(T0), limit: 10 });
      expect(laterClaim).toHaveLength(1);
      expect(new Set([...nowClaim, ...laterClaim].map((job) => job.url_hash))).toEqual(
        new Set(jobs.map((job) => {
          const row = t.db
            .query("SELECT url_hash FROM post_previews WHERE post_id = ? AND url = ?")
            .get(post.id, job.url) as { url_hash: string };
          return row.url_hash;
        })),
      );
    } finally {
      t.close();
    }
  });

  test("scan enqueue also respects the budget (60 of 70 missing posts)", async () => {
    const t = makeStore({ clock: () => T0 });
    try {
      t.store.setPluginEnabled("link-preview", false, "owner");
      const ops = Array.from({ length: 70 }, (_, index) => ({
        op: "post" as const,
        body: `关闭期 ${index} https://example.com/scan/${index}`,
      }));
      t.store.commitOps({ author: "owner", batchId: "b-scan", ops });
      expect(t.db.query("SELECT COUNT(*) AS c FROM post_previews").get()).toEqual({ c: 0 });

      const service = new PreviewService({
        store: t.store,
        provider: LINK_PREVIEW_PROVIDER,
        transport: dummyTransport,
        workerEnabled: false,
        scanBatchDelayMs: 0,
        now: () => T0,
        env: { ...process.env },
      });
      service.setEnabled(true, "owner");
      const scan = await service.scanStale();
      expect(scan.enqueued).toBe(70);
      expect(t.db.query("SELECT COUNT(*) AS c FROM preview_jobs").get()).toEqual({ c: 70 });
      expect(t.db.query("SELECT COUNT(*) AS c FROM post_previews").get()).toEqual({ c: 70 });
      expect(claimNext(t.db, { now: T0, limit: 1000 })).toHaveLength(PREVIEW_ACCOUNT_HOURLY_LIMIT);
      expect(claimNext(t.db, { now: nextPreviewBudgetWindow(T0), limit: 1000 })).toHaveLength(10);
    } finally {
      t.close();
    }
  });
});

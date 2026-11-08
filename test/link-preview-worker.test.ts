import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { makeStore, type TestStore } from "./helpers.ts";
import { LINK_PREVIEW } from "../src/core/plugins/builtin.ts";
import { extractLinks } from "../src/core/link-extract.ts";
import type {
  PreviewProvider,
  PreviewTransport,
} from "../src/core/plugins/types.ts";
import {
  buildPreviewCacheKey,
  previewRulesVersion,
} from "../src/server/preview/link-preview/provider.ts";
import { enqueueJobOnly, hashUrl } from "../src/server/preview/queue.ts";
import { PreviewWorker, previewWorkerLock } from "../src/server/preview/worker.ts";
import { PreviewFetchError } from "../src/server/preview/fetch.ts";

const T0 = 1_700_000_000_000;

const dummyTransport: PreviewTransport = {
  head: async () => {
    throw new Error("transport must not be called by the fake provider");
  },
  page: async () => {
    throw new Error("transport must not be called by the fake provider");
  },
  probe: async () => {
    throw new Error("transport must not be called by the fake provider");
  },
};

function fakeProvider(opts: {
  pages?: boolean;
  delayMs?: number;
  fail?: boolean;
} = {}): PreviewProvider {
  return {
    manifest: LINK_PREVIEW,
    extractUrls: extractLinks,
    buildCacheKey: buildPreviewCacheKey,
    phases: () => (opts.pages === false ? ["probe"] : ["meta", "cover"]),
    async resolvePhase(link, phase) {
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      if (opts.fail) throw new PreviewFetchError("timeout", "fixture timeout");
      if (phase === "meta") {
        return {
          phase,
          fields: {
            kind: "page",
            mime: "text/html",
            final_url: link.url,
            title: `标题 ${link.url}`,
            description: "摘要",
            site_name: "example.com",
          },
        };
      }
      if (phase === "cover") {
        return {
          phase,
          fields: {
            cover: { url: "https://cdn.example.com/cover.png", w: 1200, h: 630, kind: "og" },
          },
        };
      }
      return { phase, fields: {} };
    },
  };
}

function startWorker(
  t: TestStore,
  opts: { provider?: PreviewProvider; instanceId?: string; concurrency?: number; now?: () => number; backoffMs?: number[] } = {},
): PreviewWorker {
  return new PreviewWorker({
    store: t.store,
    provider: opts.provider ?? fakeProvider(),
    transport: dummyTransport,
    instanceId: opts.instanceId ?? "worker-test",
    now: opts.now,
    pollMs: 5,
    concurrency: opts.concurrency ?? 2,
    perDomain: 1,
    backoffMs: opts.backoffMs ?? [10_000],
    maxAttempts: 6,
    logger: () => {},
  });
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("waitFor timeout");
}

function commitWithLink(t: TestStore, body: string, batchId: string, author = "owner") {
  return t.store.commitOps({ author, batchId, ops: [{ op: "post", body }] }).posts[0]!;
}

describe("preview worker (report-link-preview P1-6/P1-7)", () => {
  test("multi-stage writes one event per phase and reaches ready", async () => {
    const t = makeStore({ clock: () => T0 });
    const worker = startWorker(t);
    try {
      const post = commitWithLink(t, "链接 https://example.com/a", "b1");
      expect(post.previews).toHaveLength(1);
      expect(post.previews[0]!.status).toBe("pending");
      expect(post.previews[0]!.phase).toBe("queued");
      expect(worker.start()).toBe(true);
      await waitFor(() => t.store.previewsForPost(post.id)[0]?.status === "ready");

      const preview = t.store.previewsForPost(post.id)[0]!;
      expect(preview.title).toBe(`标题 https://example.com/a`);
      expect(preview.description).toBe("摘要");
      expect(preview.cover).toEqual({
        url: "https://cdn.example.com/cover.png",
        w: 1200,
        h: 630,
        kind: "og",
      });
      expect(preview.fields_ready).toEqual([
        "kind",
        "mime",
        "title",
        "description",
        "site_name",
        "cover",
      ]);
      expect(preview.phase).toBe("cover");
      expect(preview.error_code).toBeNull();

      const jobs = t.db.query("SELECT * FROM preview_jobs").all();
      expect(jobs).toHaveLength(0);

      const events = t.db
        .query("SELECT type, payload_json FROM events WHERE type = 'post.updated' ORDER BY seq ASC")
        .all() as Array<{ type: string; payload_json: string }>;
      expect(events).toHaveLength(2);
      const first = JSON.parse(events[0]!.payload_json) as {
        phase: string;
        status: string;
        previews: Array<{ title: string | null }>;
      };
      const second = JSON.parse(events[1]!.payload_json) as {
        phase: string;
        status: string;
        previews: Array<{ cover: { url: string } | null }>;
      };
      expect(first).toMatchObject({ phase: "meta", status: "partial" });
      expect(first.previews[0]!.title).toContain("标题");
      expect(second).toMatchObject({ phase: "cover", status: "ready" });
      expect(second.previews[0]!.cover!.url).toBe("https://cdn.example.com/cover.png");
    } finally {
      worker.stop();
      t.close();
    }
  });

  test("new post is processed before an older one", async () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    const worker = startWorker(t, { provider: fakeProvider({ delayMs: 15 }), concurrency: 1 });
    try {
      const old = commitWithLink(t, "旧 https://example.com/old", "b-old");
      now = T0 + 1000;
      const fresh = commitWithLink(t, "新 https://example.com/new", "b-new");
      worker.start();
      await waitFor(
        () =>
          t.store.previewsForPost(old.id)[0]?.status === "ready" &&
          t.store.previewsForPost(fresh.id)[0]?.status === "ready",
      );
      const firstEvent = t.db
        .query("SELECT post_id FROM events WHERE type = 'post.updated' ORDER BY seq ASC LIMIT 1")
        .get() as { post_id: string };
      expect(firstEvent.post_id).toBe(fresh.id);
    } finally {
      worker.stop();
      t.close();
    }
  });

  test("restart resets running jobs and still completes (no duplicate jobs)", async () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const post = commitWithLink(t, "续跑 https://example.com/resume", "b-resume");
      // 模拟崩溃遗留：claim 成 running 后不处理。
      const claimed = t.db
        .query("UPDATE preview_jobs SET status = 'running' WHERE post_id = ?")
        .run(post.id);
      expect(Number(claimed.changes)).toBe(1);
      const worker = startWorker(t, { instanceId: "resume-worker" });
      try {
        worker.start();
        await waitFor(() => t.store.previewsForPost(post.id)[0]?.status === "ready");
        expect(t.db.query("SELECT * FROM preview_jobs").all()).toHaveLength(0);
      } finally {
        worker.stop();
      }
    } finally {
      t.close();
    }
  });

  test("single-instance lock: a second worker refuses to claim", () => {
    const t = makeStore({ clock: () => T0 });
    const first = startWorker(t, { instanceId: "w1" });
    const second = startWorker(t, { instanceId: "w2" });
    try {
      expect(first.start()).toBe(true);
      expect(second.start()).toBe(false);
      expect(previewWorkerLock(t.db)?.instanceId).toBe("w1");
      expect(second.stats().locked).toBe(false);
    } finally {
      second.stop();
      first.stop();
      expect(previewWorkerLock(t.db)).toBeNull();
      t.close();
    }
  });

  test("first failure with no fields → failed + backoff job", async () => {
    const t = makeStore({ clock: () => T0 });
    const worker = startWorker(t, {
      provider: fakeProvider({ fail: true }),
      backoffMs: [10_000],
      now: () => T0,
    });
    try {
      const post = commitWithLink(t, "失败 https://example.com/fail", "b-fail");
      worker.start();
      await waitFor(() => t.store.previewsForPost(post.id)[0]?.status === "failed");
      const preview = t.store.previewsForPost(post.id)[0]!;
      expect(preview.error_code).toBe("timeout");
      const job = t.db.query("SELECT * FROM preview_jobs").get() as {
        status: string;
        attempts: number;
        next_run_at: number;
        last_error: string | null;
      };
      expect(job).toMatchObject({ status: "queued", attempts: 1, last_error: "timeout" });
      expect(job.next_run_at).toBe(T0 + 10_000);
    } finally {
      worker.stop();
      t.close();
    }
  });

  test("R7/default: maxAttempts defaults to 6 and the 24h tier is actually reached", async () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    const logs: string[] = [];
    const worker = new PreviewWorker({
      store: t.store,
      provider: fakeProvider({ fail: true }),
      transport: dummyTransport,
      instanceId: "default-attempts",
      now: () => now,
      pollMs: 5,
      concurrency: 1,
      backoffMs: [1, 1, 1, 1, 1],
      logger: (line) => logs.push(line),
    });
    try {
      const post = commitWithLink(t, "默认次数 https://example.com/attempts", "b-attempts");
      worker.start();
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await waitFor(() => {
          const job = t.db
            .query("SELECT attempts, status FROM preview_jobs WHERE post_id = ?")
            .get(post.id) as { attempts: number; status: string } | null;
          return job?.attempts === attempt && job.status === "queued";
        });
        now += 10;
      }
      await waitFor(() => {
        const job = t.db
          .query("SELECT attempts, status FROM preview_jobs WHERE post_id = ?")
          .get(post.id) as { attempts: number; status: string } | null;
        return job?.status === "failed";
      });
      const job = t.db
        .query("SELECT attempts FROM preview_jobs WHERE post_id = ?")
        .get(post.id) as { attempts: number };
      expect(job.attempts).toBe(6);
    } finally {
      worker.stop();
      t.close();
    }
  });

  test("R1/R2: heartbeat interval and start lock writes survive SQLITE_BUSY", async () => {
    const t = makeStore({ clock: () => T0 });
    const logs: string[] = [];
    const worker = new PreviewWorker({
      store: t.store,
      provider: fakeProvider(),
      transport: dummyTransport,
      instanceId: "busy-heartbeat",
      now: () => Date.now(),
      pollMs: 500,
      heartbeatMs: 30,
      concurrency: 1,
      logger: (line) => logs.push(line),
    });
    const db2 = new Database(join(t.dir, "report.sqlite"));
    try {
      // 让整库写锁冲突快速失败（生产默认 5s busy_timeout 会拖慢用例）。
      t.db.exec("PRAGMA busy_timeout = 50");
      db2.exec("PRAGMA busy_timeout = 20");
      db2.exec("BEGIN EXCLUSIVE");
      // R2: acquireLock's setMeta must not throw out of start().
      expect(worker.start()).toBe(false);
      db2.exec("ROLLBACK");

      expect(worker.start()).toBe(true);
      db2.exec("BEGIN EXCLUSIVE");
      await Bun.sleep(220);
      const heartbeatBusy = logs.filter((line) => line.includes("heartbeat busy"));
      expect(heartbeatBusy).toHaveLength(1); // 限频：多次心跳只记一次
      db2.exec("ROLLBACK");
    } finally {
      try {
        db2.exec("ROLLBACK");
      } catch {
        // no transaction
      }
      db2.close();
      worker.stop();
      t.db.exec("PRAGMA busy_timeout = 5000");
      t.close();
    }
  });

  test("N5: tick survives SQLITE_BUSY and resumes after the lock is released", async () => {
    const t = makeStore({ clock: () => T0 });
    const logs: string[] = [];
    const worker = new PreviewWorker({
      store: t.store,
      provider: fakeProvider(),
      transport: dummyTransport,
      instanceId: "busy-worker",
      pollMs: 25,
      concurrency: 1,
      perDomain: 1,
      backoffMs: [10_000],
      maxAttempts: 6,
      logger: (line) => logs.push(line),
    });
    try {
      const post = commitWithLink(t, "忙 https://example.com/busy", "b-busy");
      // 任务先不可 claim，给“占锁”留出窗口，再在 worker 运行时触发 BUSY。
      t.db.query("DELETE FROM preview_jobs WHERE post_id = ?").run(post.id);
      const urlHash = hashUrl("https://example.com/busy");
      const future = Date.now() + 250;
      enqueueJobOnly(t.db, {
        postId: post.id,
        urlHash,
        cacheKey: t.store.previewsForPost(post.id)[0]!.cache_key,
        postCreatedAt: post.created_at,
        now: future,
      });
      t.db.exec("PRAGMA busy_timeout = 20");
      worker.start();
      const db2 = new Database(join(t.dir, "report.sqlite"));
      try {
        db2.exec("PRAGMA busy_timeout = 20");
        db2.exec("BEGIN EXCLUSIVE");
        await Bun.sleep(500);
        expect(worker.stats().started).toBe(true);
        expect(logs.some((line) => /busy|locked/i.test(line))).toBe(true);
      } finally {
        db2.exec("ROLLBACK");
        db2.close();
      }
      t.db.exec("PRAGMA busy_timeout = 5000");
      await waitFor(() => t.store.previewsForPost(post.id)[0]?.status === "ready");
    } finally {
      worker.stop();
      t.close();
    }
  });

  test("reprocessing failure keeps the old ready card (no downgrade)", async () => {
    const t = makeStore({ clock: () => T0 });
    const success = startWorker(t, { instanceId: "ok" });
    try {
      const post = commitWithLink(t, "重处理 https://example.com/reprocess", "b-reprocess");
      success.start();
      await waitFor(() => t.store.previewsForPost(post.id)[0]?.status === "ready");
      const ready = t.store.previewsForPost(post.id)[0]!;
      const urlHash = hashUrl(ready.url);
      success.stop();

      enqueueJobOnly(t.db, {
        postId: post.id,
        urlHash,
        cacheKey: "new-cache-key",
        postCreatedAt: post.created_at,
        now: T0 + 10,
      });

      const failing = startWorker(t, {
        provider: fakeProvider({ fail: true }),
        instanceId: "fail-reprocess",
        now: () => T0 + 20,
        backoffMs: [10_000],
      });
      try {
        failing.start();
        await waitFor(() => {
          const job = t.db.query("SELECT attempts FROM preview_jobs").get() as
            | { attempts: number }
            | null;
          return (job?.attempts ?? 0) >= 1;
        });
        const preview = t.store.previewsForPost(post.id)[0]!;
        expect(preview.status).toBe("ready");
        expect(preview.title).toBe(ready.title);
        expect(preview.cover).toEqual(ready.cover);
        expect(preview.error_code).toBe("timeout");
        const job = t.db.query("SELECT * FROM preview_jobs").get() as {
          status: string;
          cache_key: string;
        };
        expect(job.status).toBe("queued");
        expect(job.cache_key).toBe("new-cache-key");
      } finally {
        failing.stop();
      }
    } finally {
      success.stop();
      t.close();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeStore } from "./helpers.ts";
import {
  adoptJobCacheKey,
  claimNext,
  completeJob,
  enqueueJobOnly,
  enqueuePreviewLinks,
  failJob,
  previewQueueStats,
  previewRow,
  releaseJob,
  resetRunningJobs,
  type PendingLinkInput,
} from "../src/server/preview/queue.ts";

const T0 = 1_700_000_000_000;

function link(url: string, key = "key-a"): PendingLinkInput {
  return {
    position: 0,
    url,
    urlHash: `hash-${url}`,
    label: null,
    cacheKey: key,
  };
}

describe("persistent preview queue (report-link-preview P1-5)", () => {
  test("dedupes (post_id,url_hash) and keeps attempts on same cacheKey", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      enqueuePreviewLinks(t.db, {
        postId: "p1",
        postCreatedAt: 1000,
        links: [link("https://example.com/a")],
        now: T0,
      });
      enqueuePreviewLinks(t.db, {
        postId: "p1",
        postCreatedAt: 1000,
        links: [link("https://example.com/a")],
        now: T0 + 5,
      });
      const jobs = t.db.query("SELECT * FROM preview_jobs").all() as Array<{ attempts: number }>;
      expect(jobs).toHaveLength(1);
      // 同 key 重复入队不清零尝试次数（job 已 failed 才复活）。
      expect(jobs[0]!.attempts).toBe(0);
    } finally {
      t.close();
    }
  });

  test("claims newest post first (post_created_at DESC)", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      enqueuePreviewLinks(t.db, {
        postId: "old",
        postCreatedAt: 1000,
        links: [link("https://example.com/old")],
        now: T0,
      });
      enqueuePreviewLinks(t.db, {
        postId: "new",
        postCreatedAt: 2000,
        links: [link("https://example.com/new")],
        now: T0,
      });
      const first = claimNext(t.db, { now: T0, limit: 1 });
      expect(first.map((job) => job.post_id)).toEqual(["new"]);
      const second = claimNext(t.db, { now: T0, limit: 5 });
      expect(second.map((job) => job.post_id)).toEqual(["old"]);
    } finally {
      t.close();
    }
  });

  test("concurrent claim never returns the same job twice", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      for (const id of ["a", "b", "c"]) {
        enqueuePreviewLinks(t.db, {
          postId: id,
          postCreatedAt: 1000,
          links: [link(`https://example.com/${id}`)],
          now: T0,
        });
      }
      const first = claimNext(t.db, { now: T0, limit: 2 });
      const second = claimNext(t.db, { now: T0, limit: 2 });
      const ids = [...first, ...second].map((job) => job.post_id);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
    } finally {
      t.close();
    }
  });

  test("N5: two processes claiming concurrently never duplicate a job", async () => {
    const t = makeStore({ clock: () => T0 });
    try {
      for (let index = 0; index < 10; index += 1) {
        enqueuePreviewLinks(t.db, {
          postId: `p-${index}`,
          postCreatedAt: 1000 + index,
          links: [link(`https://example.com/claim/${index}`)],
          now: T0,
        });
      }
      const queueUrl = new URL("../src/server/preview/queue.ts", import.meta.url).href;
      const scriptPath = join(t.dir, "claim.mjs");
      writeFileSync(
        scriptPath,
        [
          'import { Database } from "bun:sqlite";',
          `import { claimNext } from ${JSON.stringify(queueUrl)};`,
          "const db = new Database(process.argv[2]);",
          'db.exec("PRAGMA busy_timeout = 15000");',
          "let rows = [];",
          "for (let i = 0; i < 50; i += 1) {",
          "  try {",
          "    rows = claimNext(db, { now: Date.now() + 10_000, limit: 20 });",
          "    break;",
          "  } catch (err) {",
          "    if (!/locked|busy/i.test(String(err?.message))) throw err;",
          "    await Bun.sleep(20);",
          "    if (i === 49) throw err;",
          "  }",
          "}",
          "console.log(JSON.stringify(rows.map((r) => r.post_id + ':' + r.url_hash)));",
          "db.close();",
        ].join("\n"),
      );
      const spawnOne = () =>
        Bun.spawn({
          cmd: [process.execPath, scriptPath, join(t.dir, "report.sqlite")],
          stdout: "pipe",
          stderr: "pipe",
        });
      const first = spawnOne();
      const second = spawnOne();
      const [firstCode, secondCode, firstOut, secondOut, firstErr] = await Promise.all([
        first.exited,
        second.exited,
        new Response(first.stdout).text(),
        new Response(second.stdout).text(),
        new Response(first.stderr).text(),
      ]);
      expect(firstCode, firstErr).toBe(0);
      expect(secondCode).toBe(0);
      expect(firstErr).not.toContain("locked");
      const claimed = [
        ...(JSON.parse(firstOut.trim() || "[]") as string[]),
        ...(JSON.parse(secondOut.trim() || "[]") as string[]),
      ];
      expect(claimed).toHaveLength(10);
      expect(new Set(claimed).size).toBe(10);
    } finally {
      t.close();
    }
  });

  test("cacheKey change resets the job in place (attempts/next_run_at)", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      enqueuePreviewLinks(t.db, {
        postId: "p",
        postCreatedAt: 1000,
        links: [link("https://example.com/a", "key-a")],
        now: T0,
      });
      expect(claimNext(t.db, { now: T0, limit: 1 })).toHaveLength(1);
      enqueueJobOnly(t.db, {
        postId: "p",
        urlHash: "hash-https://example.com/a",
        cacheKey: "key-b",
        postCreatedAt: 1000,
        now: T0 + 1,
      });
      const job = t.db.query("SELECT * FROM preview_jobs").get() as {
        status: string;
        attempts: number;
        cache_key: string;
      };
      expect(job).toMatchObject({ status: "queued", attempts: 0, cache_key: "key-b" });
      const claimed = claimNext(t.db, { now: T0 + 2, limit: 1 });
      expect(claimed[0]!.cache_key).toBe("key-b");
      expect(claimed[0]!.attempts).toBe(1);
    } finally {
      t.close();
    }
  });

  test("failure backs off 5m → 15m → 1h → 6h → 24h and ends failed on the 6th attempt (N6)", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      enqueuePreviewLinks(t.db, {
        postId: "p",
        postCreatedAt: 1000,
        links: [link("https://example.com/a")],
        now: T0,
      });
      const backoff = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3_600_000, 24 * 3_600_000];
      let at = T0;
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const claimed = claimNext(t.db, { now: at, limit: 1 });
        expect(claimed).toHaveLength(1);
        failJob(t.db, {
          postId: "p",
          urlHash: "hash-https://example.com/a",
          error: "timeout",
          now: at,
          backoffMs: backoff,
          maxAttempts: 6,
        });
        const job = t.db.query("SELECT * FROM preview_jobs").get() as {
          status: string;
          next_run_at: number;
          attempts: number;
        };
        if (attempt < 6) {
          expect(job.status).toBe("queued");
          expect(job.next_run_at).toBe(at + backoff[attempt - 1]!);
          // 未到退避时间不可 claim。
          expect(claimNext(t.db, { now: at + 1, limit: 1 })).toHaveLength(0);
          if (attempt === 5) {
            // N6：第 5 次失败使用 24h 档。
            expect(job.next_run_at - at).toBe(24 * 60 * 60_000);
          }
          at = job.next_run_at;
        } else {
          expect(job.status).toBe("failed");
        }
      }
    } finally {
      t.close();
    }
  });

  test("release does not consume an attempt; complete deletes the row", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      enqueuePreviewLinks(t.db, {
        postId: "p",
        postCreatedAt: 1000,
        links: [link("https://example.com/a")],
        now: T0,
      });
      claimNext(t.db, { now: T0, limit: 1 });
      releaseJob(t.db, "p", "hash-https://example.com/a", T0 + 1);
      const job = t.db.query("SELECT status, attempts FROM preview_jobs").get() as {
        status: string;
        attempts: number;
      };
      expect(job).toEqual({ status: "queued", attempts: 0 });
      const claimed = claimNext(t.db, { now: T0 + 2, limit: 1 });
      expect(claimed[0]!.attempts).toBe(1);
      completeJob(t.db, "p", "hash-https://example.com/a");
      expect(t.db.query("SELECT * FROM preview_jobs").all()).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  test("restart resets running jobs to queued and adopt updates the field row key", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      enqueuePreviewLinks(t.db, {
        postId: "p",
        postCreatedAt: 1000,
        links: [link("https://example.com/a", "key-a")],
        now: T0,
      });
      claimNext(t.db, { now: T0, limit: 1 });
      const reset = resetRunningJobs(t.db, T0 + 10, 0);
      expect(reset).toBe(1);
      const job = t.db.query("SELECT status FROM preview_jobs").get() as { status: string };
      expect(job.status).toBe("queued");

      expect(adoptJobCacheKey(t.db, "p", "hash-https://example.com/a", "key-b", T0 + 11)).toBe(1);
      expect(previewRow(t.db, "p", "hash-https://example.com/a")?.cache_key).toBe("key-b");
      const stats = previewQueueStats(t.db);
      expect(stats.queued).toBe(1);
      expect(stats.pending).toBe(1);
    } finally {
      t.close();
    }
  });
});

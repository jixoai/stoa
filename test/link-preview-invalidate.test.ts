import { describe, expect, test } from "bun:test";
import { makeStore } from "./helpers.ts";
import type { PreviewTransport } from "../src/core/plugins/types.ts";
import { LINK_PREVIEW_PROVIDER } from "../src/server/preview/link-preview/provider.ts";
import { PreviewService } from "../src/server/preview/service.ts";
import { claimNext, previewRowsForPost } from "../src/server/preview/queue.ts";

const T0 = 1_700_000_000_000;

const dummyTransport: PreviewTransport = {
  head: async () => {
    throw new Error("no network in service tests");
  },
  page: async () => {
    throw new Error("no network in service tests");
  },
  probe: async () => {
    throw new Error("no network in service tests");
  },
};

function makeService(
  store: ReturnType<typeof makeStore>["store"],
  env: Record<string, string | undefined> = {},
  now: () => number = () => T0,
): PreviewService {
  return new PreviewService({
    store,
    provider: LINK_PREVIEW_PROVIDER,
    transport: dummyTransport,
    workerEnabled: false,
    scanBatchDelayMs: 0,
    env: { ...process.env, ...env },
    now,
  });
}

function commit(store: ReturnType<typeof makeStore>["store"], body: string, batch: string) {
  return store.commitOps({ author: "owner", batchId: batch, ops: [{ op: "post", body }] }).posts[0]!;
}

describe("cacheKey invalidation scan (report-link-preview P1-11)", () => {
  test("version upgrade enqueues stale posts newest-first and keeps old fields", async () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      const oldPost = commit(t.store, "旧 https://example.com/old", "b-old");
      now = T0 + 1000;
      const newPost = commit(t.store, "新 https://example.com/new", "b-new");
      // 模拟“已处理”：清 job，并把 old 的标题写成 ready（旧展示值）。
      t.db.query("DELETE FROM preview_jobs").run();
      const oldRow = previewRowsForPost(t.db, oldPost.id)[0]!;
      t.store.applyPreviewPhase({
        postId: oldPost.id,
        urlHash: oldRow.url_hash,
        cacheKey: oldRow.cache_key,
        phase: "meta",
        fields: { title: "旧标题", kind: "page" },
        fieldsReady: ["title", "kind"],
        status: "ready",
      });

      const service = makeService(t.store, { STOA_PREVIEW_RULES_VERSION: "2000" });
      const scan = await service.scanStale();
      expect(scan.enqueued).toBe(2);
      const claimed = claimNext(t.db, { now: now + 100, limit: 5 });
      expect(claimed.map((job) => job.post_id)).toEqual([newPost.id, oldPost.id]);
      // 旧字段保留（扫描不清库）。
      const preview = t.store.previewsForPost(oldPost.id)[0]!;
      expect(preview.title).toBe("旧标题");
      expect(preview.status).toBe("ready");

      // 重复扫描不会重复入队/重置。
      const again = await service.scanStale();
      expect(again.enqueued).toBe(0);
      expect((t.db.query("SELECT COUNT(*) AS c FROM preview_jobs").get() as { c: number }).c).toBe(2);
    } finally {
      t.close();
    }
  });

  test("same version: 0 re-enqueue; plugin off: 0 scan/0 rows; re-enable backfills missing posts", async () => {
    let now = T0;
    const t = makeStore({ clock: () => now });
    try {
      const indexed = commit(t.store, "已有 https://example.com/keep", "b-keep");
      t.db.query("DELETE FROM preview_jobs").run();
      const service = makeService(t.store);
      expect((await service.scanStale()).enqueued).toBe(0);

      const off = service.setEnabled(false, "owner");
      expect(off.enabled).toBe(false);
      expect((await service.scanStale()).enqueued).toBe(0);
      now = T0 + 500;
      const missing = commit(t.store, "关闭期 https://example.com/missing", "b-missing");
      expect(missing.previews).toEqual([]);
      expect(previewRowsForPost(t.db, missing.id)).toHaveLength(0);

      const on = service.setEnabled(true, "owner");
      expect(on.enabled).toBe(true);
      const scan = await service.scanStale();
      expect(scan.enqueued).toBe(1);
      const rows = previewRowsForPost(t.db, missing.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("pending");
      expect(t.db.query("SELECT * FROM preview_jobs").all()).toHaveLength(1);
      // 同版本已有字段的帖子没有被重抓。
      expect(t.db.query("SELECT * FROM preview_jobs WHERE post_id = ?").all(indexed.id)).toHaveLength(0);
    } finally {
      t.close();
    }
  });

  test("N7: scan is paginated and processes more than one 100-row batch", async () => {
    const t = makeStore({ clock: () => T0 });
    try {
      for (const id of ["agent-a", "agent-b", "agent-c"]) {
        t.store.createAccount({ id, display: id });
      }
      t.store.setPluginEnabled("link-preview", false, "owner");
      const accounts = ["agent-a", "agent-b", "agent-c"];
      for (let index = 0; index < 150; index += 1) {
        t.store.commitOps({
          author: accounts[index % 3]!,
          batchId: `b-page-${index}`,
          ops: [{ op: "post", body: `分页 ${index} https://example.com/page/${index}` }],
        });
      }
      const service = makeService(t.store);
      service.setEnabled(true, "owner");
      const scan = await service.scanStale();
      expect(scan.scanned).toBe(150);
      expect(scan.enqueued).toBe(150);
      expect(t.db.query("SELECT COUNT(*) AS c FROM preview_jobs").get()).toEqual({ c: 150 });
    } finally {
      t.close();
    }
  });

  test("pluginView exposes version/rules/limits/worker summary and dependency status", async () => {
    const t = makeStore({ clock: () => T0 });
    try {
      commit(t.store, "视图 https://example.com/view", "b-view");
      const service = makeService(t.store, { STOA_FILEVIEWER_BASE: "https://file-viewer.example.com" });
      const view = service.pluginView();
      expect(view.id).toBe("link-preview");
      expect(view.version).toBe("1.0.0");
      expect(view.rules_version).toBeGreaterThan(0);
      expect(view.enabled).toBe(true);
      expect(view.requires).toEqual([{ id: "file-viewer", optional: true, status: "missing" }]);
      expect(view.viewer_base).toBe("https://file-viewer.example.com");
      // fileviewer base double read: new prefix wins, legacy key still read
      expect(
        makeService(t.store, {
          STOA_FILEVIEWER_BASE: "https://new.example.com",
          FDE2E_FILEVIEWER_BASE: "https://legacy.example.com",
        }).pluginView().viewer_base,
      ).toBe("https://new.example.com");
      expect(
        makeService(t.store, { FDE2E_FILEVIEWER_BASE: "https://legacy.example.com" }).pluginView()
          .viewer_base,
      ).toBe("https://legacy.example.com");
      expect(view.limits).toEqual({ previews_per_post: 3, url_max_chars: 2048 });
      expect(view.worker).toMatchObject({ queued: 1, ready: 0, partial: 0 });
      expect(service.stats().processing).toBe(0);
      // N3：worker.running 单一来源（DB job 计数），不叠加 processing。
      expect(view.worker!.running).toBe(service.stats().running);
      const policy = service.policySnapshot();
      expect(policy).toMatchObject({ worker_enabled: false, test_allowlist_enabled: false });
      expect(policy).not.toHaveProperty("test_allow_origins");
    } finally {
      t.close();
    }
  });
});

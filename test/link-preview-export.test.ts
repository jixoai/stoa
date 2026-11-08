import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runExport, buildSnapshot, type Snapshot } from "../src/server/export.ts";
import { Store } from "../src/server/store.ts";
import { makeStore, tempDir } from "./helpers.ts";
import { previewRowsForPost } from "../src/server/preview/queue.ts";

const T0 = 1_700_000_000_000;
const SNAPSHOT_RE = /<script type="application\/json" id="report-snapshot">([\s\S]*?)<\/script>/;

function makeUiFixture(): { dir: string; cleanup: () => void } {
  const dir = tempDir("report-ui-fixture-");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>report</title></head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(join(dir, "assets", "app.js"), "window.__REPORT_APP__ = true;\n");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function snapshotOf(html: string): Snapshot {
  const match = SNAPSHOT_RE.exec(html);
  if (!match) throw new Error("snapshot script missing");
  return JSON.parse(match[1]!) as Snapshot;
}

function readyPost(t: ReturnType<typeof makeStore>, body: string, batch: string) {
  const post = t.store.commitOps({ author: "owner", batchId: batch, ops: [{ op: "post", body }] }).posts[0]!;
  const row = previewRowsForPost(t.db, post.id)[0]!;
  t.store.applyPreviewPhase({
    postId: post.id,
    urlHash: row.url_hash,
    cacheKey: row.cache_key,
    phase: "meta",
    fields: { kind: "page", mime: "text/html", title: "导出标题", description: "导出描述" },
    fieldsReady: ["kind", "mime", "title", "description"],
    status: "partial",
  });
  t.store.applyPreviewPhase({
    postId: post.id,
    urlHash: row.url_hash,
    cacheKey: row.cache_key,
    phase: "cover",
    fields: { cover: { url: "https://cdn.example.com/c.png", w: 1200, h: 630, kind: "og" } },
    fieldsReady: ["cover"],
    status: "ready",
  });
  return post;
}

describe("static export carries previews (report-link-preview P1-13)", () => {
  test("snapshot includes previews + preview_enabled; export has no side effects", () => {
    const t = makeStore({ clock: () => T0 });
    const ui = makeUiFixture();
    try {
      const post = readyPost(t, "导出 https://example.com/export", "b-export");
      const jobsBefore = (t.db.query("SELECT COUNT(*) AS c FROM preview_jobs").get() as { c: number }).c;
      const beforeRow = t.db
        .query("SELECT updated_at FROM post_previews WHERE post_id = ?")
        .get(post.id) as { updated_at: number };

      const outDir = join(t.dir, "archive");
      const result = runExport({ dataDir: t.dir, outDir, uiDir: ui.dir, now: T0 });
      expect(result.out_dir).toBe(outDir);
      const snapshot = snapshotOf(readFileSync(join(outDir, "index.html"), "utf8"));
      expect(snapshot.preview_enabled).toBe(true);
      const snapshotPost = snapshot.posts.find((row) => row.id === post.id)!;
      expect(snapshotPost.previews).toHaveLength(1);
      expect(snapshotPost.previews[0]).toMatchObject({
        url: "https://example.com/export",
        title: "导出标题",
        status: "ready",
        cover: { url: "https://cdn.example.com/c.png", w: 1200, h: 630, kind: "og" },
      });

      const jobsAfter = (t.db.query("SELECT COUNT(*) AS c FROM preview_jobs").get() as { c: number }).c;
      const afterRow = t.db
        .query("SELECT updated_at FROM post_previews WHERE post_id = ?")
        .get(post.id) as { updated_at: number };
      expect(jobsAfter).toBe(jobsBefore);
      expect(afterRow.updated_at).toBe(beforeRow.updated_at);
    } finally {
      ui.cleanup();
      t.close();
    }
  });

  test("plugin off: preview_enabled=false but persisted previews stay in the snapshot", () => {
    const t = makeStore({ clock: () => T0 });
    const ui = makeUiFixture();
    try {
      const post = readyPost(t, "关闭导出 https://example.com/off", "b-off");
      t.store.setPluginEnabled("link-preview", false, "owner");
      const outDir = join(t.dir, "archive-off");
      runExport({ dataDir: t.dir, outDir, uiDir: ui.dir, now: T0 });
      const snapshot = snapshotOf(readFileSync(join(outDir, "index.html"), "utf8"));
      expect(snapshot.preview_enabled).toBe(false);
      expect(snapshot.posts.find((row) => row.id === post.id)!.previews).toHaveLength(1);
    } finally {
      ui.cleanup();
      t.close();
    }
  });

  test("old v4 database without preview tables exports previews=[] without failing", () => {
    const t = makeStore({ clock: () => T0 });
    try {
      const post = t.store.commitOps({
        author: "owner",
        batchId: "b-old",
        ops: [{ op: "post", body: "旧库 https://example.com/v4" }],
      }).posts[0]!;
      t.db.exec("DROP TABLE preview_jobs");
      t.db.exec("DROP TABLE post_previews");
      const store = new Store({ dataDir: t.dir, db: t.db, clock: () => T0 });
      const snapshot = buildSnapshot(store, "owner");
      expect(snapshot.preview_enabled).toBe(false);
      expect(snapshot.posts.find((row) => row.id === post.id)!.previews).toEqual([]);
    } finally {
      t.close();
    }
  });
});

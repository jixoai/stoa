import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../src/server/db.ts";
import { tempDir } from "./helpers.ts";

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function indexes(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("schema v5 migration (B3 early-v5 draft compatibility)", () => {
  test("partial v5 tables get missing columns and indexes; migrate is idempotent", () => {
    const dir = tempDir();
    const db = new Database(join(dir, "report.sqlite"), { create: true });
    try {
      // 早期 v5 草稿：表存在但缺 cache_key/status/next_run_at/post_created_at/updated_at。
      db.exec(`
        CREATE TABLE post_previews (
          post_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (post_id, position)
        );
        CREATE TABLE preview_jobs (
          post_id TEXT NOT NULL,
          url_hash TEXT NOT NULL,
          PRIMARY KEY (post_id, url_hash)
        );
      `);
      expect(() => migrate(db)).not.toThrow();
      const previewCols = columns(db, "post_previews");
      for (const column of ["url", "url_hash", "cache_key", "status", "updated_at", "fields_ready"]) {
        expect(previewCols).toContain(column);
      }
      const jobCols = columns(db, "preview_jobs");
      for (const column of ["cache_key", "status", "next_run_at", "post_created_at", "updated_at"]) {
        expect(jobCols).toContain(column);
      }
      const names = indexes(db);
      expect(names).toContain("idx_preview_jobs_ready");
      expect(names).toContain("idx_preview_jobs_post");
      expect(names).toContain("idx_post_previews_cache");
      expect(names).toContain("idx_post_previews_status");

      // 重复 migrate 幂等。
      expect(() => migrate(db)).not.toThrow();
      expect(() => migrate(db)).not.toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fresh v5 database still gets the indexes", () => {
    const dir = tempDir();
    const db = new Database(join(dir, "report.sqlite"), { create: true });
    try {
      migrate(db);
      const names = indexes(db);
      expect(names).toContain("idx_preview_jobs_ready");
      expect(names).toContain("idx_post_previews_status");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

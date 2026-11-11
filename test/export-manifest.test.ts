/**
 * 导出修订清单 + dataRevision（stoa-stopped-preview S2；design §1.1/§1.2）。
 *
 * 锁死契约：manifest 随产物原子换入、rev 由数据本体自证（事件 MAX(seq) 与账号计数）、
 * 缺文件/坏 JSON 读取为 null（视为无缓存）。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LINK_PREVIEW } from "../src/core/plugins/builtin.ts";
import { VERSION } from "../src/core/protocol.ts";
import {
  EXPORT_MANIFEST_FILE,
  dataRevision,
  readExportManifest,
  runExport,
} from "../src/server/export.ts";
import { createAgents, makeStore, tempDir } from "./helpers.ts";

function makeUiFixture(): { dir: string; cleanup: () => void } {
  const dir = tempDir("preview-ui-fixture-");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>report</title>
<script src="./assets/app.js" defer></script></head>
<body><div id="root"></div></body>
</html>
`,
  );
  writeFileSync(join(dir, "assets", "app.js"), "window.__REPORT_APP__ = true;\n");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("dataRevision (design v2 §1.3)", () => {
  test("derives from snapshot seq + accounts/follows/bookmarks/pluginsOn", () => {
    const t = makeStore();
    try {
      // 新库：seq 0；accounts 2 行（rowid 1+2=3）；默认 owner→manager 1 条关注（rowid 1）；
      // 0 收藏（TOTAL 0）；link-preview 默认开启 → pluginsOn = "1"。
      expect(dataRevision(t.dir)).toBe(`0:2,3:1,1:0,0:1`);
      expect(dataRevision(t.dir).split(":")).toEqual(["0", "2,3", "1,1", "0,0", "1"]);

      const post = t.store.commitOps({
        author: "manager",
        batchId: "R1",
        ops: [{ op: "post", body: "revision follows events" }],
      }).posts[0]!;
      const afterPost = dataRevision(t.dir);
      expect(afterPost.split(":")[0]).toBe(String(t.store.maxEventSeq()));
      expect(afterPost).not.toBe("0:2,3:1,1:0,0:1");

      // 账号创建/删除推进 accounts 分量（口径 = listAccounts(false)，排除 tombstone；
      // tombstone 行被 WHERE 排除，count 与 rowid 总量一起回落）。
      createAgents(t.store, ["rev-agent"]);
      expect(dataRevision(t.dir).split(":")[1]).toBe("3,6");
      t.store.removeAccount("rev-agent");
      expect(dataRevision(t.dir).split(":")[1]).toBe("2,3");

      // 新事件继续推进 seq 分量。
      t.store.commitOps({
        author: "owner",
        batchId: "R2",
        ops: [{ op: "reply", parent: post.id, body: "second event" }],
      });
      expect(Number(dataRevision(t.dir).split(":")[0])).toBeGreaterThan(
        Number(afterPost.split(":")[0]),
      );
    } finally {
      t.close();
    }
  });

  test("covers follows / bookmarks / plugin switches (data that never writes events)", () => {
    const t = makeStore();
    try {
      const post = t.store.commitOps({
        author: "manager",
        batchId: "V1",
        ops: [{ op: "post", body: "relation revision" }],
      }).posts[0]!;
      createAgents(t.store, ["rev-observer"]);
      const base = dataRevision(t.dir);
      const seq = String(t.store.maxEventSeq());
      expect(base.split(":")).toEqual([seq, "3,6", "1,1", "0,0", "1"]);

      t.store.follow("owner", "rev-observer");
      const afterFollow = dataRevision(t.dir);
      expect(afterFollow.split(":")).toEqual([seq, "3,6", "2,3", "0,0", "1"]);
      expect(afterFollow).not.toBe(base);

      t.store.bookmark("owner", post.id);
      const afterBookmark = dataRevision(t.dir);
      expect(afterBookmark.split(":")).toEqual([seq, "3,6", "2,3", "1,1", "1"]);
      expect(afterBookmark).not.toBe(afterFollow);

      t.store.setPluginEnabled(LINK_PREVIEW.id, false, "owner");
      const afterPlugin = dataRevision(t.dir);
      expect(afterPlugin.split(":")).toEqual([seq, "3,6", "2,3", "1,1", "0"]);
      expect(afterPlugin).not.toBe(afterBookmark);
      expect(seq).toBe(String(t.store.maxEventSeq())); // 全程无 events 写入
    } finally {
      t.close();
    }
  });

  test("detects set-equivalent swaps via rowid totals (P2-1)", () => {
    const t = makeStore();
    try {
      createAgents(t.store, ["swap-a", "swap-b", "swap-c"]);
      const p1 = t.store.commitOps({
        author: "manager",
        batchId: "SW1",
        ops: [{ op: "post", body: "swap one" }],
      }).posts[0]!;
      const p2 = t.store.commitOps({
        author: "manager",
        batchId: "SW2",
        ops: [{ op: "post", body: "swap two" }],
      }).posts[0]!;
      const p3 = t.store.commitOps({
        author: "manager",
        batchId: "SW3",
        ops: [{ op: "post", body: "swap three" }],
      }).posts[0]!;

      // follows：关注 a、b（count 3）→「取关 a + 关注 c」：行数不变，rowid 总量必变。
      t.store.follow("owner", "swap-a");
      t.store.follow("owner", "swap-b");
      const beforeFollows = dataRevision(t.dir);
      t.store.unfollow("owner", "swap-a");
      t.store.follow("owner", "swap-c");
      const afterFollows = dataRevision(t.dir);
      expect(afterFollows.split(":")[2]!.split(",")[0]).toBe(
        beforeFollows.split(":")[2]!.split(",")[0],
      );
      expect(afterFollows).not.toBe(beforeFollows);

      // bookmarks：收藏 p1、p2 →「取消 p1 + 收藏 p3」：count 不变，rowid 总量必变。
      t.store.bookmark("owner", p1.id);
      t.store.bookmark("owner", p2.id);
      const beforeBookmarks = dataRevision(t.dir);
      t.store.unbookmark("owner", p1.id);
      t.store.bookmark("owner", p3.id);
      const afterBookmarks = dataRevision(t.dir);
      expect(afterBookmarks.split(":")[3]!.split(",")[0]).toBe(
        beforeBookmarks.split(":")[3]!.split(",")[0],
      );
      expect(afterBookmarks).not.toBe(beforeBookmarks);

      // accounts：建 a2 + tombstone a：有效 count 不变，rowid 总量必变。
      const beforeAccounts = dataRevision(t.dir);
      createAgents(t.store, ["swap-a2"]);
      t.store.removeAccount("swap-a");
      const afterAccounts = dataRevision(t.dir);
      expect(afterAccounts.split(":")[1]!.split(",")[0]).toBe(
        beforeAccounts.split(":")[1]!.split(",")[0],
      );
      expect(afterAccounts).not.toBe(beforeAccounts);
    } finally {
      t.close();
    }
  });

  test("reads without mutating the database (readonly open)", () => {
    const t = makeStore();
    try {
      const before = dataRevision(t.dir);
      dataRevision(t.dir);
      dataRevision(t.dir);
      expect(dataRevision(t.dir)).toBe(before);
    } finally {
      t.close();
    }
  });
});

describe("export manifest (design v2 §1.2)", () => {
  test("runExport writes manifest.json next to index.html and returns the same rev", () => {
    const t = makeStore();
    const ui = makeUiFixture();
    try {
      t.store.commitOps({
        author: "manager",
        batchId: "M1",
        ops: [{ op: "post", body: "manifest post" }],
      });
      const now = 1_794_390_000_000;
      const outDir = join(t.dir, "archive");
      const result = runExport({ dataDir: t.dir, outDir, uiDir: ui.dir, now });

      expect(result.rev).toBe(dataRevision(t.dir));
      expect(existsSync(join(outDir, EXPORT_MANIFEST_FILE))).toBe(true);
      const manifest = readExportManifest(outDir);
      expect(manifest).not.toBeNull();
      expect(manifest).toEqual({
        rev: result.rev,
        as_of_seq: result.as_of_seq,
        exported_at: now,
        viewer: "owner",
        ui_version: VERSION,
      });
      expect(manifest!.as_of_seq).toBe(t.store.maxEventSeq());
      // 同读一致性（design v2 §1.3）：rev 的 seq 分量必须就是本次快照的 as_of_seq，
      // 不得事后另查（否则 rev 领先快照会让新帖永久不进归档）。
      expect(Number(manifest!.rev.split(":")[0])).toBe(manifest!.as_of_seq);
      expect(manifest!.ui_version).toBe(JSON.parse(
        readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
      ).version);

      // 清单绝不含凭据或数据目录路径。
      const raw = readFileSync(join(outDir, EXPORT_MANIFEST_FILE), "utf8");
      expect(raw).not.toContain(t.dir);
      expect(raw.toLowerCase()).not.toContain("token");
      expect(raw).not.toContain("STOA_AUTH");
    } finally {
      ui.cleanup();
      t.close();
    }
  });

  test("viewer slice is recorded and the default out keeps history copies in sync", () => {
    const t = makeStore();
    const ui = makeUiFixture();
    try {
      runExport({ dataDir: t.dir, viewer: "manager", uiDir: ui.dir, now: 1 });
      // 默认 out 语义不变：<dataDir>/export + history/<ts>/。
      const outDir = join(t.dir, "export");
      expect(readExportManifest(outDir)!.viewer).toBe("manager");
      expect(readExportManifest(outDir)!.exported_at).toBe(1);

      runExport({ dataDir: t.dir, uiDir: ui.dir, now: 2 });
      const historyDir = join(outDir, "history");
      const entries = readFileSync(join(outDir, EXPORT_MANIFEST_FILE), "utf8");
      expect(JSON.parse(entries).exported_at).toBe(2);
      // history 是整份产物的硬链接副本（manifest 也随同归档）。
      expect(existsSync(historyDir)).toBe(true);
    } finally {
      ui.cleanup();
      t.close();
    }
  });

  test("explicit outDir (preview dir) has no history and never touches <dataDir>/export", () => {
    const t = makeStore();
    const ui = makeUiFixture();
    try {
      const previewDir = join(t.dir, "export-preview");
      runExport({ dataDir: t.dir, outDir: previewDir, uiDir: ui.dir });
      expect(existsSync(join(previewDir, "index.html"))).toBe(true);
      expect(existsSync(join(previewDir, EXPORT_MANIFEST_FILE))).toBe(true);
      // 显式 outDir ⇒ isDefaultOut=false：无 history 机制（design v2 §1.1）。
      expect(existsSync(join(previewDir, "history"))).toBe(false);
      // 预览目录与实例 auto-export / CLI 默认 out 完全隔离。
      expect(existsSync(join(t.dir, "export"))).toBe(false);

      // CLI 默认 out 语义零改动：仍然落 export/ 且保留 history。
      runExport({ dataDir: t.dir, uiDir: ui.dir });
      expect(existsSync(join(t.dir, "export", "index.html"))).toBe(true);
      expect(existsSync(join(t.dir, "export", "history"))).toBe(true);
      // 预览目录没有被默认 out 的导出动过。
      expect(readExportManifest(previewDir)).not.toBeNull();
    } finally {
      ui.cleanup();
      t.close();
    }
  });

  test("missing, corrupt and malformed manifests read as null", () => {
    const dir = tempDir("manifest-read-");
    try {
      expect(readExportManifest(dir)).toBeNull();
      expect(readExportManifest(join(dir, "nope"))).toBeNull();
      writeFileSync(join(dir, EXPORT_MANIFEST_FILE), "{not json");
      expect(readExportManifest(dir)).toBeNull();
      writeFileSync(join(dir, EXPORT_MANIFEST_FILE), JSON.stringify({ rev: 1 }));
      expect(readExportManifest(dir)).toBeNull();
      writeFileSync(
        join(dir, EXPORT_MANIFEST_FILE),
        JSON.stringify({ rev: "1:2", as_of_seq: 1, exported_at: 2, viewer: "owner" }),
      );
      expect(readExportManifest(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

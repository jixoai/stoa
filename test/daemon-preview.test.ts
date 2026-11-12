/**
 * daemon 静态预览（stoa-stopped-preview S3；design §1.3/§1.4）。
 *
 * 覆盖：缓存命中不重跑（seam 计数）、数据变化触发重生成、并发单飞、force、
 * 运行中/已停止都可 ensure、未知 id 与临时实例数据已清理的 404 可读文案、
 * 目录穿越守卫、html no-cache / assets·media immutable / 不注入 boot 不带 token。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountTokenEnvKey } from "../src/core/auth.ts";
import { parseEnv } from "../src/core/env.ts";
import { LINK_PREVIEW } from "../src/core/plugins/builtin.ts";
import { VERSION } from "../src/core/protocol.ts";
import { ensurePreview, previewExportDir } from "../src/daemon/preview.ts";
import { createDaemonApp, type DaemonContext } from "../src/daemon/server.ts";
import { writeServices, type ServiceRecord } from "../src/daemon/state.ts";
import {
  dataRevision,
  readExportManifest,
  runExport,
  type ExportOptions,
  type ExportResult,
} from "../src/server/export.ts";
import { createAgents, makeStore, tempDir } from "./helpers.ts";

function makeUiFixture(): { dir: string; cleanup: () => void } {
  const dir = tempDir("preview-daemon-ui-");
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

let seq = 0;

function previewRecord(dataDir: string, overrides: Partial<ServiceRecord> = {}): ServiceRecord {
  seq += 1;
  return {
    id: `svc-preview-${seq.toString(16).padStart(8, "0")}`,
    name: "board",
    slug: `pboard-${seq.toString(16).padStart(4, "0")}`,
    hostnames: [],
    dataDir,
    port: 13680,
    pid: null,
    url: null,
    log: null,
    startedAt: 1_700_000_000_000,
    status: "stopped",
    ...overrides,
  };
}

function makeDaemonCtx(uiDir: string): DaemonContext {
  return {
    stateDir: tempDir("preview-daemon-state-"),
    version: VERSION,
    startedAt: 1_700_000_000_000,
    url: "http://127.0.0.1:13679",
    host: "127.0.0.1",
    entry: { bin: process.execPath, args: [] },
    uiDir,
    log: () => {},
    shutdown: async () => {},
  };
}

function countingExport(): { fn: (opts: ExportOptions) => ExportResult; calls: () => number } {
  let calls = 0;
  return {
    fn: (opts) => {
      calls += 1;
      return runExport(opts);
    },
    calls: () => calls,
  };
}

describe("ensurePreview (design v2 §1.4)", () => {
  test("miss → generate; hit → no rerun; data change → regenerate; force → regenerate", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      t.store.commitOps({
        author: "manager",
        batchId: "C1",
        ops: [{ op: "post", body: "preview cache post" }],
      });
      const record = previewRecord(t.dir);
      const spy = countingExport();

      const first = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(first.cached).toBe(false);
      expect(spy.calls()).toBe(1);
      expect(first.rev).toBe(dataRevision(t.dir));
      expect(first.as_of_seq).toBe(t.store.maxEventSeq());
      expect(first.dir).toBe(previewExportDir(record));
      expect(existsSync(join(first.dir, "index.html"))).toBe(true);
      expect(existsSync(join(first.dir, "manifest.json"))).toBe(true);
      expect(first.duration_ms).toBeGreaterThanOrEqual(0);

      const second = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(second.cached).toBe(true);
      expect(spy.calls()).toBe(1);
      expect(second.rev).toBe(first.rev);
      expect(second.as_of_seq).toBe(first.as_of_seq);
      expect(second.exported_at).toBe(first.exported_at);

      // 数据变化（新事件）→ rev 自证失效 → 重生成。
      t.store.commitOps({
        author: "owner",
        batchId: "C2",
        ops: [{ op: "post", body: "second post" }],
      });
      const third = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(third.cached).toBe(false);
      expect(spy.calls()).toBe(2);
      expect(third.rev).not.toBe(first.rev);
      expect(third.as_of_seq).toBeGreaterThan(first.as_of_seq);

      const fourth = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(fourth.cached).toBe(true);
      expect(spy.calls()).toBe(2);

      const forced = await ensurePreview(ctx, record, { runExportFn: spy.fn, force: true });
      expect(forced.cached).toBe(false);
      expect(spy.calls()).toBe(3);
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("concurrent ensures for one service share a single export (single flight)", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      t.store.commitOps({
        author: "manager",
        batchId: "S1",
        ops: [{ op: "post", body: "single flight" }],
      });
      const record = previewRecord(t.dir);
      const spy = countingExport();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => ensurePreview(ctx, record, { runExportFn: spy.fn })),
      );
      expect(spy.calls()).toBe(1);
      expect(results.every((item) => item.cached === false)).toBe(true);
      expect(new Set(results.map((item) => item.rev)).size).toBe(1);
      expect(new Set(results.map((item) => item.exported_at)).size).toBe(1);
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("stale ui_version or corrupt manifest is a cache miss", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      const record = previewRecord(t.dir);
      const spy = countingExport();
      await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(spy.calls()).toBe(1);

      // 前端构建升级（ui_version 不符）→ 旧归档失效。
      const manifestPath = join(previewExportDir(record), "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, ui_version: "0.0.0" }));
      const afterVersion = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(afterVersion.cached).toBe(false);
      expect(spy.calls()).toBe(2);

      // 坏 JSON → 视为无缓存，不报错。
      writeFileSync(manifestPath, "{not json");
      const afterCorrupt = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(afterCorrupt.cached).toBe(false);
      expect(spy.calls()).toBe(3);
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });
});

describe("daemon preview routes (design v2 §1.5)", () => {
  test("api + page: stopped service gets an archive, then cached:true (no daemon boot, no token)", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      const media = t.store.saveMedia(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), "png");
      t.store.commitOps({
        author: "manager",
        batchId: "P1",
        ops: [{ op: "post", body: "preview page post", media: [media.hash] }],
      });
      const record = previewRecord(t.dir); // status: stopped —— 主用途
      writeServices(ctx.stateDir, [record]);
      const app = createDaemonApp(ctx);

      const firstApi = await app.request(`/api/daemon/services/${record.id}/preview`);
      expect(firstApi.status).toBe(200);
      expect(firstApi.headers.get("cache-control")).toBe("no-store");
      const first = (await firstApi.json()) as Record<string, unknown>;
      expect(first.ok).toBe(true);
      expect(first.url).toBe(`/preview/${record.id}/`);
      expect(first.cached).toBe(false);
      expect(typeof first.rev).toBe("string");
      expect((first.rev as string).length).toBeGreaterThan(0);
      expect(first.rev).toBe(dataRevision(t.dir));
      expect(first.as_of_seq).toBe(t.store.maxEventSeq());
      expect(typeof first.exported_at).toBe("number");
      expect(typeof first.duration_ms).toBe("number");

      // 独立产物目录（design v2 §1.1）：预览落 export-preview，不碰实例 auto-export 的 export/，
      // 也没有 history/（显式 outDir ⇒ isDefaultOut=false）。
      const previewDir = previewExportDir(record);
      expect(previewDir).toBe(join(t.dir, "export-preview"));
      expect(existsSync(join(previewDir, "index.html"))).toBe(true);
      expect(existsSync(join(previewDir, "manifest.json"))).toBe(true);
      expect(existsSync(join(previewDir, "history"))).toBe(false);
      expect(existsSync(join(t.dir, "export"))).toBe(false);

      const secondApi = await app.request(`/api/daemon/services/${record.id}/preview`);
      expect(secondApi.headers.get("cache-control")).toBe("no-store");
      const second = (await secondApi.json()) as Record<string, unknown>;
      expect(second.cached).toBe(true);
      expect(second.rev).toBe(first.rev);
      expect(second.exported_at).toBe(first.exported_at);

      const page = await app.request(`/preview/${record.id}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("cache-control")).toBe("no-cache");
      const html = await page.text();
      expect(html).toContain('id="report-snapshot"');
      expect(html).toContain("preview page post");
      expect(html).toContain('src="./assets/app.js"');
      // 归档 HTML 不注入 daemon boot、不携带口令。
      expect(html).not.toContain("__STOA_DAEMON__");
      const token = parseEnv(readFileSync(join(t.dir, "accounts", "owner.env"), "utf8"))[
        accountTokenEnvKey("owner")
      ]!;
      expect(html).not.toContain(token);

      const asset = await app.request(`/preview/${record.id}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(await asset.text()).toContain("__REPORT_APP__");

      const mediaRes = await app.request(`/preview/${record.id}/media/${media.hash}.png`);
      expect(mediaRes.status).toBe(200);
      expect(mediaRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      // 裸 id → 带斜杠（相对资源按 /preview/<id>/ 解析）。
      const bare = await app.request(`/preview/${record.id}`);
      expect(bare.status).toBe(302);
      expect(bare.headers.get("location")).toBe(`/preview/${record.id}/`);
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("running service previews through the same ensure path (no health probe required)", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      t.store.commitOps({
        author: "manager",
        batchId: "RUN1",
        ops: [{ op: "post", body: "running preview" }],
      });
      const record = previewRecord(t.dir, {
        status: "running",
        pid: 999_999,
        url: "http://127.0.0.1:13680",
      });
      writeServices(ctx.stateDir, [record]);
      const app = createDaemonApp(ctx);
      const page = await app.request(`/preview/${record.id}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("running preview");
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("unknown id → 404 JSON; ephemeral stopped (data deleted) → readable 404", async () => {
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      const unknown = previewRecord(join(ctx.stateDir, "never-existed"));
      writeServices(ctx.stateDir, [unknown]);
      const app = createDaemonApp(ctx);

      const missingPage = await app.request("/preview/svc-unknown/");
      expect(missingPage.status).toBe(404);
      const missing = (await missingPage.json()) as Record<string, unknown>;
      expect(missing.ok).toBe(false);
      expect(missing.code).toBe("NOT_FOUND");
      expect(String(missing.error)).toContain("no service with id");

      const missingApi = await app.request("/api/daemon/services/svc-unknown/preview");
      expect(missingApi.status).toBe(404);

      // 登记存在但数据目录已删（罕见：手工删除等）→ 404 可读原因（design v2 §1.5）。
      const gone = previewRecord(join(ctx.stateDir, "gone-dir"), {
        ephemeral: true,
        location: "temp",
      });
      writeServices(ctx.stateDir, [unknown, gone]);
      const gonePage = await app.request(`/preview/${gone.id}/`);
      expect(gonePage.status).toBe(404);
      const goneBody = (await gonePage.json()) as Record<string, unknown>;
      expect(String(goneBody.error)).toContain("服务数据目录不可用");
      const goneApi = await app.request(`/api/daemon/services/${gone.id}/preview`);
      expect(goneApi.status).toBe(404);
      expect(String(((await goneApi.json()) as Record<string, unknown>).error)).toContain(
        "服务数据目录不可用",
      );

      // 子资源同样不泄漏、不生成：数据目录缺失时 assets 直接 404。
      const goneAsset = await app.request(`/preview/${gone.id}/assets/app.js`);
      expect(goneAsset.status).toBe(404);
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
    }
  });

  test("traversal guards reject encoded variants; unknown assets 404", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      t.store.commitOps({
        author: "manager",
        batchId: "T1",
        ops: [{ op: "post", body: "traversal target" }],
      });
      const record = previewRecord(t.dir);
      writeServices(ctx.stateDir, [record]);
      const app = createDaemonApp(ctx);
      // 先生成归档，确保守卫不是因为「没有归档」而拒绝。
      const seed = await app.request(`/preview/${record.id}/`);
      expect(seed.status).toBe(200);

      // secret 放在归档之外，若穿越成功就会泄露。
      writeFileSync(join(t.dir, "secret.txt"), "top-secret\n");
      for (const path of [
        `/preview/${record.id}/..%2fsecret.txt`,
        `/preview/${record.id}/%2e%2e%2fsecret.txt`,
        `/preview/${record.id}/assets/..%2f..%2fsecret.txt`,
        `/preview/${record.id}/%00secret.txt`,
      ]) {
        const res = await app.request(path);
        expect(res.status).toBe(400);
        const body = await res.text();
        expect(body).toContain("bad path");
        expect(body).not.toContain("top-secret");
      }

      const absent = await app.request(`/preview/${record.id}/assets/missing.js`);
      expect(absent.status).toBe(404);
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("preview route is not swallowed by the daemon-webui /* fallback", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      const record = previewRecord(t.dir);
      writeServices(ctx.stateDir, [record]);
      const app = createDaemonApp(ctx);
      const page = await app.request(`/preview/${record.id}/`);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).not.toContain("window.__STOA_DAEMON__=");
      expect(html).toContain('id="report-snapshot"');
      // 控制台自身仍走注入版（回归防呆）。
      const consolePage = await app.request("/");
      expect(await consolePage.text()).toContain("window.__STOA_DAEMON__=");
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("foreign viewer slice (manager) is never served as a cached owner preview (F1)", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      t.store.commitOps({
        author: "manager",
        batchId: "F1",
        ops: [{ op: "post", body: "visible to both" }],
      });
      const record = previewRecord(t.dir);
      const previewDir = previewExportDir(record);
      // 模拟实例 auto-export / CLI `--as manager` 留下的他人切片（rev/ui 都与当前一致）。
      runExport({ dataDir: t.dir, outDir: previewDir, viewer: "manager", uiDir: ui.dir });
      expect(readExportManifest(previewDir)!.viewer).toBe("manager");
      expect(readExportManifest(previewDir)!.rev).toBe(dataRevision(t.dir));

      const spy = countingExport();
      const result = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(result.cached).toBe(false);
      expect(spy.calls()).toBe(1);
      expect(readExportManifest(previewDir)!.viewer).toBe("owner");

      const again = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(again.cached).toBe(true);
      expect(spy.calls()).toBe(1);
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("only the document entry triggers ensure; asset requests never export (F2)", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      const record = previewRecord(t.dir);
      writeServices(ctx.stateDir, [record]);
      const app = createDaemonApp(ctx);
      const previewDir = previewExportDir(record);

      // 归档尚不存在：子资源直接 404，且不创建任何产物（不 ensure）。
      const coldAsset = await app.request(`/preview/${record.id}/assets/app.js`);
      expect(coldAsset.status).toBe(404);
      expect(existsSync(previewDir)).toBe(false);

      const entry = await app.request(`/preview/${record.id}/`);
      expect(entry.status).toBe(200);
      const manifestBefore = readExportManifest(previewDir)!;
      expect(manifestBefore).not.toBeNull();

      // 数据变化后，asset 请求仍直接服务旧归档（不重跑导出）。
      t.store.commitOps({
        author: "owner",
        batchId: "E2",
        ops: [{ op: "post", body: "after archive" }],
      });
      const asset = await app.request(`/preview/${record.id}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain("__REPORT_APP__");
      expect(readExportManifest(previewDir)).toEqual(manifestBefore);

      // 文档入口再次访问 → 缓存失效 → 重生成，新帖进归档。
      const entryAgain = await app.request(`/preview/${record.id}/`);
      expect(entryAgain.status).toBe(200);
      const manifestAfter = readExportManifest(previewDir)!;
      expect(manifestAfter.rev).not.toBe(manifestBefore.rev);
      expect(manifestAfter.as_of_seq).toBeGreaterThan(manifestBefore.as_of_seq);
      expect(await entryAgain.text()).toContain("after archive");
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("follows / bookmarks / plugin switch each invalidate the preview (F4 coverage)", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      const post = t.store.commitOps({
        author: "manager",
        batchId: "C1",
        ops: [{ op: "post", body: "revision target" }],
      }).posts[0]!;
      createAgents(t.store, ["rev-observer"]);
      const record = previewRecord(t.dir);
      const spy = countingExport();

      const first = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(first.cached).toBe(false);
      expect(spy.calls()).toBe(1);

      t.store.follow("owner", "rev-observer");
      const afterFollow = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(afterFollow.cached).toBe(false);
      expect(afterFollow.rev).not.toBe(first.rev);
      expect(spy.calls()).toBe(2);

      t.store.bookmark("owner", post.id);
      const afterBookmark = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(afterBookmark.cached).toBe(false);
      expect(afterBookmark.rev).not.toBe(afterFollow.rev);
      expect(spy.calls()).toBe(3);

      t.store.setPluginEnabled(LINK_PREVIEW.id, false, "owner");
      const afterPlugin = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(afterPlugin.cached).toBe(false);
      expect(afterPlugin.rev).not.toBe(afterBookmark.rev);
      expect(spy.calls()).toBe(4);

      const stable = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(stable.cached).toBe(true);
      expect(spy.calls()).toBe(4);
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("whitelist: only index.html / assets / media are served; manifest and history 404 (F7)", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      const record = previewRecord(t.dir);
      writeServices(ctx.stateDir, [record]);
      const app = createDaemonApp(ctx);
      expect((await app.request(`/preview/${record.id}/`)).status).toBe(200);

      for (const path of [
        `/preview/${record.id}/manifest.json`,
        `/preview/${record.id}/history/20260101/index.html`,
        `/preview/${record.id}/index.html.bak`,
        `/preview/${record.id}/other.html`,
      ]) {
        const res = await app.request(path);
        expect(res.status).toBe(404);
        expect(await res.text()).toContain("not found");
      }

      // index.html 显式入口同样走 ensure + html no-cache。
      const index = await app.request(`/preview/${record.id}/index.html`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(index.headers.get("cache-control")).toBe("no-cache");
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("matching manifest with a missing index.html is a cache miss (P3-1)", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      const record = previewRecord(t.dir);
      const spy = countingExport();
      const first = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(first.cached).toBe(false);
      expect(spy.calls()).toBe(1);

      const dir = previewExportDir(record);
      // manifest.rev / ui_version / viewer 全部匹配当前数据与版本，只破坏产物完整性。
      expect(readExportManifest(dir)).not.toBeNull();
      rmSync(join(dir, "index.html"));

      const second = await ensurePreview(ctx, record, { runExportFn: spy.fn });
      expect(second.cached).toBe(false);
      expect(spy.calls()).toBe(2);
      expect(existsSync(join(dir, "index.html"))).toBe(true);
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("rev never runs ahead of the snapshot when a write lands mid-export (P2-2)", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      t.store.commitOps({
        author: "manager",
        batchId: "P21",
        ops: [{ op: "post", body: "before snapshot" }],
      });
      const beforeSeq = t.store.maxEventSeq();
      const record = previewRecord(t.dir);
      let calls = 0;
      let lateWritten = false;
      const exportFn = (opts: ExportOptions): ExportResult => {
        calls += 1;
        return runExport({
          ...opts,
          // 仅测试 seam：快照读完之后、rev 计数之前，实例并发写入（独立连接，WAL）。
          __testAfterSnapshot:
            calls === 1
              ? () => {
                  t.store.commitOps({
                    author: "owner",
                    batchId: "P22",
                    ops: [{ op: "post", body: "late post" }],
                  });
                  lateWritten = true;
                }
              : undefined,
        });
      };

      const first = await ensurePreview(ctx, record, { runExportFn: exportFn });
      expect(lateWritten).toBe(true);
      expect(first.cached).toBe(false);
      expect(first.as_of_seq).toBe(beforeSeq);
      // ① manifest.rev 的 seq 分量仍等于本次 as_of_seq（没有被事后写入抬升）。
      const manifest = readExportManifest(previewExportDir(record))!;
      expect(manifest.as_of_seq).toBe(beforeSeq);
      expect(manifest.rev.split(":")[0]).toBe(String(manifest.as_of_seq));

      // ② 数据已前进：下一次 ensure 因 rev 落后而 miss，重生成后新帖可见。
      expect(dataRevision(t.dir).split(":")[0]).toBe(String(t.store.maxEventSeq()));
      expect(dataRevision(t.dir)).not.toBe(manifest.rev);
      const second = await ensurePreview(ctx, record, { runExportFn: exportFn });
      expect(second.cached).toBe(false);
      expect(calls).toBe(2);
      expect(second.as_of_seq).toBe(t.store.maxEventSeq());
      expect(second.rev).toBe(dataRevision(t.dir));
      expect(readFileSync(join(previewExportDir(record), "index.html"), "utf8")).toContain(
        "late post",
      );
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("ensure reclaims stale export temp/old leftovers but keeps fresh ones (P3-2)", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      const staleTmp = join(t.dir, ".export-tmp-crash-1");
      const staleOld = join(t.dir, "export-preview.old-999-20260101T000000");
      const freshTmp = join(t.dir, ".export-tmp-fresh-1");
      for (const dir of [staleTmp, staleOld, freshTmp]) mkdirSync(dir, { recursive: true });
      const longAgo = new Date(Date.now() - 2 * 3_600_000);
      utimesSync(staleTmp, longAgo, longAgo);
      utimesSync(staleOld, longAgo, longAgo);

      const record = previewRecord(t.dir);
      await ensurePreview(ctx, record, { runExportFn: countingExport().fn });

      expect(existsSync(staleTmp)).toBe(false);
      expect(existsSync(staleOld)).toBe(false);
      expect(existsSync(freshTmp)).toBe(true); // 未过 1h 的新鲜残留不动
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });

  test("non-GET preview requests get 405, not the console SPA fallback (P3-3)", async () => {
    const t = makeStore();
    const ui = makeUiFixture();
    const ctx = makeDaemonCtx(ui.dir);
    try {
      const record = previewRecord(t.dir);
      writeServices(ctx.stateDir, [record]);
      const app = createDaemonApp(ctx);

      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = await app.request(`/preview/${record.id}/manifest.json`, { method });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET");
        expect(((await res.json()) as Record<string, unknown>).code).toBe("METHOD_NOT_ALLOWED");
      }
      const postEntry = await app.request(`/preview/${record.id}/`, { method: "POST" });
      expect(postEntry.status).toBe(405);
      // GET 面不受影响。
      expect((await app.request(`/preview/${record.id}/`)).status).toBe(200);
    } finally {
      ui.cleanup();
      rmSync(ctx.stateDir, { recursive: true, force: true });
      t.close();
    }
  });
});

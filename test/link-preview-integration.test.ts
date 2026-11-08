/**
 * 服务端端到端冒烟：真实 provider + 真实 HttpPreviewTransport + 回环夹具。
 * 覆盖 P1-22 服务端前置（不涉及浏览器）：发帖 pending → worker 阶段推进 → ready →
 * 静态导出带 previews；并验证图片 probe 与超时/404 降级。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeStore, tempDir } from "./helpers.ts";
import { HttpPreviewTransport } from "../src/server/preview/fetch.ts";
import { LINK_PREVIEW_PROVIDER } from "../src/server/preview/link-preview/provider.ts";
import { PreviewService } from "../src/server/preview/service.ts";
import { runExport, type Snapshot } from "../src/server/export.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
let server: Server<undefined>;
let origin = "";
let hits = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      hits += 1;
      const url = new URL(req.url);
      if (url.pathname === "/story") {
        return new Response(
          `<!doctype html><html><head>
            <meta property="og:title" content="集成标题">
            <meta property="og:description" content="集成摘要">
            <meta property="og:site_name" content="Fixture Site">
            <meta property="og:image" content="${origin}/cover.png">
            <meta property="og:image:width" content="1200">
            <meta property="og:image:height" content="630">
          </head><body><p>${"正文".repeat(50)}</p></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname === "/cover.png") {
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      }
      if (url.pathname === "/img.png") {
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      }
      if (url.pathname === "/slow") {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response("late")), 30_000);
        });
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(20);
  }
  throw new Error("integration waitFor timeout");
}

describe("server-side preview pipeline (real fetch)", () => {
  test("page meta→cover and image probe reach ready; static export carries them", async () => {
    const t = makeStore();
    const service = new PreviewService({
      store: t.store,
      provider: LINK_PREVIEW_PROVIDER,
      transport: new HttpPreviewTransport({ testAllowOrigins: [origin], rateLimiter: null }),
      workerEnabled: true,
      scanBatchDelayMs: 0,
      workerOptions: {
        pollMs: 10,
        concurrency: 2,
        perDomain: 1,
        instanceId: "integration",
        backoffMs: [1000],
      },
      env: { ...process.env },
    });
    try {
      const pagePost = t.store.commitOps({
        author: "owner",
        batchId: "b-page",
        ops: [{ op: "post", body: `页面 ${origin}/story` }],
      }).posts[0]!;
      const imagePost = t.store.commitOps({
        author: "owner",
        batchId: "b-image",
        ops: [{ op: "post", body: `图片 ${origin}/img.png` }],
      }).posts[0]!;
      expect(pagePost.previews[0]!.status).toBe("pending");

      service.start();
      await waitFor(
        () =>
          t.store.previewsForPost(pagePost.id)[0]?.status === "ready" &&
          t.store.previewsForPost(imagePost.id)[0]?.status === "ready",
      );

      const page = t.store.previewsForPost(pagePost.id)[0]!;
      expect(page.kind).toBe("page");
      expect(page.title).toBe("集成标题");
      expect(page.description).toBe("集成摘要");
      expect(page.site_name).toBe("Fixture Site");
      expect(page.cover).toMatchObject({
        url: `${origin}/cover.png`,
        w: 1200,
        h: 630,
        kind: "og",
      });
      expect(page.phase).toBe("cover");

      const image = t.store.previewsForPost(imagePost.id)[0]!;
      expect(image.kind).toBe("image");
      expect(image.mime).toBe("image/png");
      expect(image.phase).toBe("probe");
      expect(hits).toBeGreaterThan(0);

      // 静态导出（真实 dist）：previews 原样进入快照。
      const outDir = join(t.dir, "archive");
      runExport({ dataDir: t.dir, outDir });
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      const match = /<script type="application\/json" id="report-snapshot">([\s\S]*?)<\/script>/.exec(html);
      expect(match).not.toBeNull();
      const snapshot = JSON.parse(match![1]!) as Snapshot;
      expect(snapshot.preview_enabled).toBe(true);
      expect(snapshot.posts.find((post) => post.id === pagePost.id)!.previews[0]).toMatchObject({
        title: "集成标题",
        status: "ready",
      });
    } finally {
      await service.stop();
      t.close();
    }
  }, 30_000);

  test("404 and timeout degrade to failed without blocking the post", async () => {
    const t = makeStore();
    const service = new PreviewService({
      store: t.store,
      provider: LINK_PREVIEW_PROVIDER,
      transport: new HttpPreviewTransport({ testAllowOrigins: [origin], rateLimiter: null }),
      workerEnabled: true,
      scanBatchDelayMs: 0,
      workerOptions: {
        pollMs: 10,
        concurrency: 2,
        perDomain: 1,
        instanceId: "integration-2",
        backoffMs: [60_000],
        jobTimeoutMs: 400,
      },
      env: { ...process.env },
    });
    try {
      const missing = t.store.commitOps({
        author: "owner",
        batchId: "b-404",
        ops: [{ op: "post", body: `404 ${origin}/nope` }],
      }).posts[0]!;
      const slow = t.store.commitOps({
        author: "owner",
        batchId: "b-slow",
        ops: [{ op: "post", body: `慢 ${origin}/slow` }],
      }).posts[0]!;
      service.start();
      await waitFor(
        () =>
          t.store.previewsForPost(missing.id)[0]?.status === "failed" &&
          t.store.previewsForPost(slow.id)[0]?.status === "failed",
        15_000,
      );
      expect(t.store.previewsForPost(missing.id)[0]!.error_code).toBe("http_error");
      expect(t.store.previewsForPost(slow.id)[0]!.error_code).toBe("timeout");
      // 帖子本身仍可读（正文未改、不因预览失败回滚）。
      const view = t.store.getPostView(missing.id, { id: "owner", role: "owner" })!;
      expect(view.body_md).toContain("/nope");
    } finally {
      await service.stop();
      t.close();
    }
  }, 30_000);
});

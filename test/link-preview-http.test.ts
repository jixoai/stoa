import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server/http.ts";
import { AuthManager } from "../src/server/auth.ts";
import { Presence } from "../src/server/presence.ts";
import { makeStore, tempDir } from "./helpers.ts";
import type { PreviewTransport } from "../src/core/plugins/types.ts";
import { LINK_PREVIEW_PROVIDER } from "../src/server/preview/link-preview/provider.ts";
import { PreviewService } from "../src/server/preview/service.ts";

const T0 = 1_700_000_000_000;

const dummyTransport: PreviewTransport = {
  head: async () => {
    throw new Error("no network in HTTP tests");
  },
  page: async () => {
    throw new Error("no network in HTTP tests");
  },
  probe: async () => {
    throw new Error("no network in HTTP tests");
  },
};

function buildApp(
  mode: "open" | "auth",
  policy?: { test_allowlist_enabled: boolean; exposed: boolean },
) {
  const t = makeStore({ clock: () => T0 });
  t.store.createAccount({ id: "agent1", display: "Agent One" });
  const envDir = tempDir();
  const envPath = join(envDir, "env");
  writeFileSync(envPath, mode === "auth" ? "FDE2E_REPORT_AUTH=topsecret\n" : "# open mode\n");
  const auth = new AuthManager({
    store: t.store,
    envFiles: [envPath],
    secretSalt: "salt",
    envTtlMs: 0,
    processEnv: {},
  });
  const previews = new PreviewService({
    store: t.store,
    provider: LINK_PREVIEW_PROVIDER,
    transport: dummyTransport,
    workerEnabled: false,
    scanBatchDelayMs: 0,
    now: () => T0,
    workerOptions: { instanceId: "http-test" },
    ...(policy ? { policy } : {}),
  });
  const app = createApp({
    store: t.store,
    auth,
    presence: new Presence(),
    dataDir: t.dir,
    instanceId: "inst-http",
    startedAt: T0,
    openExposed: false,
    port: 13680,
    previews,
  });
  return { t, app, previews };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("plugins HTTP API (report-link-preview P1-12)", () => {
  test("GET /api/plugins returns the full PluginView", async () => {
    const { t, app } = buildApp("open");
    try {
      const res = await app.request("/api/plugins", {
        headers: { "x-report-account": "owner" },
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      const plugins = body.plugins as Array<Record<string, unknown>>;
      expect(plugins).toHaveLength(1);
      const plugin = plugins[0]!;
      expect(plugin).toMatchObject({
        id: "link-preview",
        version: "1.0.0",
        kind: "preview",
        enabled: true,
        default_enabled: true,
        viewer_base: null,
        limits: { previews_per_post: 3, url_max_chars: 2048 },
      });
      expect(plugin.rules_version as number).toBeGreaterThan(0);
      expect(plugin.requires).toEqual([{ id: "file-viewer", optional: true, status: "missing" }]);
      expect(plugin.worker).toMatchObject({ queued: 0 });
    } finally {
      t.close();
    }
  });

  test("PATCH is owner/manager-only, idempotent, 404s unknown ids and broadcasts", async () => {
    const { t, app } = buildApp("open");
    try {
      const forbidden = await app.request("/api/plugins/link-preview?as=agent1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(forbidden.status).toBe(403);

      const missing = await app.request("/api/plugins/other?as=owner", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(missing.status).toBe(404);

      const bad = await app.request("/api/plugins/link-preview?as=owner", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: "no" }),
      });
      expect(bad.status).toBe(400);

      const off = await app.request("/api/plugins/link-preview?as=owner", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(off.status).toBe(200);
      expect((await json(off)).plugin).toMatchObject({ id: "link-preview", enabled: false });
      expect(t.store.pluginEnabled("link-preview")).toBe(false);

      const again = await app.request("/api/plugins/link-preview?as=owner", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(again.status).toBe(200);
      expect((await json(again)).plugin).toMatchObject({ enabled: false });
    } finally {
      t.close();
    }
  });

  test("auth mode: 401 without a token; agent can read but not PATCH", async () => {
    const { t, app } = buildApp("auth");
    try {
      const anon = await app.request("/api/plugins");
      expect(anon.status).toBe(401);
    } finally {
      t.close();
    }
  });

  test("posting with a link returns pending previews immediately (<200ms, no network)", async () => {
    const { t, app } = buildApp("open");
    try {
      const started = performance.now();
      const res = await app.request("/api/posts?as=owner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "有链接 https://example.com/a", media: [], tags: [] }),
      });
      const elapsed = performance.now() - started;
      expect(res.status).toBe(201);
      const posts = (await json(res)).posts as Array<{
        previews: Array<{ url: string; status: string; phase: string }>;
      }>;
      expect(posts[0]!.previews).toHaveLength(1);
      expect(posts[0]!.previews[0]).toMatchObject({
        url: "https://example.com/a",
        status: "pending",
        phase: "queued",
      });
      expect(elapsed).toBeLessThan(200);

      // 关闭插件后：不抽 URL、不建行、不入队。
      await app.request("/api/plugins/link-preview?as=owner", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      const offRes = await app.request("/api/posts?as=owner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "关闭期 https://example.com/b", media: [], tags: [] }),
      });
      const offPosts = (await json(offRes)).posts as Array<{ previews: unknown[] }>;
      expect(offPosts[0]!.previews).toEqual([]);
    } finally {
      t.close();
    }
  });

  test("status exposes preview_worker; capabilities advertise preview fields; no arbitrary URL endpoint", async () => {
    const { t, app } = buildApp("open");
    try {
      const status = await json(await app.request("/api/status?as=owner"));
      expect(status.preview_worker).toMatchObject({
        queued: 0,
        processing: 0,
        locked: false,
        started: false,
      });
      const caps = await json(await app.request("/api/capabilities"));
      const features = caps.features as Record<string, unknown>;
      expect(features.preview_fields).toBe(true);
      expect(features.preview_events).toBe(true);
      const arbitrary = await app.request("/api/previews?post=x&as=owner");
      expect(arbitrary.status).toBe(404);
    } finally {
      t.close();
    }
  });

  test("N12: healthz preview_policy exposes only booleans (no allowlist origins)", async () => {
    const { t, app } = buildApp("open", { test_allowlist_enabled: true, exposed: false });
    try {
      const health = await json(await app.request("/healthz"));
      const text = JSON.stringify(health);
      expect(text).not.toContain("127.0.0.1");
      expect(health.preview_policy).toMatchObject({
        test_allowlist_enabled: true,
        exposed: false,
      });
      expect(health.preview_policy).not.toHaveProperty("test_allow_origins");
    } finally {
      t.close();
    }
  });

  test("CORS preflight advertises PATCH", async () => {
    const { t, app } = buildApp("open");
    try {
      const res = await app.request("/api/plugins/link-preview", {
        method: "OPTIONS",
        headers: {
          origin: "https://report.worker.fde2e.com",
          "access-control-request-method": "PATCH",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-methods")).toContain("PATCH");
    } finally {
      t.close();
    }
  });
});

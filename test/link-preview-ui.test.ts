/**
 * report-link-preview UI 纯逻辑单测（P1-15/P1-16/P1-17/P1-20 的可测部分）。
 *
 * 不挂 React：投影合并/幂等/乱序、插件乐观更新与回滚、轮播页码保持、
 * 静态归档零网络、裸 URL 正则唯一性都在这里验证。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { PluginView, PreviewLink } from "../src/core/plugins/types.ts";
import { scanBareUrls } from "../src/core/link-extract.ts";
import {
  applyPreviewUpdate,
  capPreviews,
  mergePreviewLists,
  previewsEqual,
  resolveCarouselIndex,
} from "../src/ui/lib/link-preview.ts";
import {
  optimisticPluginEnabled,
  replacePlugin,
  restorePlugin,
  staticLinkPreviewPlugin,
} from "../src/ui/lib/plugin-state.ts";
import { StaticReportClient } from "../src/ui/lib/static-api.ts";
import { LINK_PREVIEW_PLUGIN_ID } from "../src/ui/lib/link-preview.ts";

function preview(overrides: Partial<PreviewLink> = {}): PreviewLink {
  return {
    url: "https://example.com/a",
    final_url: null,
    label: null,
    kind: "page",
    mime: null,
    title: null,
    description: null,
    site_name: null,
    cover: null,
    status: "pending",
    phase: "queued",
    fields_ready: [],
    cache_key: "cache",
    attempts: 0,
    updated_at: 1,
    error_code: null,
    ...overrides,
  };
}

function plugin(overrides: Partial<PluginView> = {}): PluginView {
  return {
    id: LINK_PREVIEW_PLUGIN_ID,
    name: "链接预览",
    description: "test",
    version: "1.0.0",
    rules_version: 1,
    kind: "preview",
    capabilities: [],
    enabled: true,
    default_enabled: true,
    requires: [],
    viewer_base: null,
    limits: { previews_per_post: 3, url_max_chars: 2048 },
    ...overrides,
  };
}

describe("post-previews merge", () => {
  test("keeps REST order and appends event-only URLs", () => {
    const a = preview({ url: "https://a.test", updated_at: 1 });
    const b = preview({ url: "https://b.test", updated_at: 1 });
    const bNew = preview({ url: "https://b.test", updated_at: 3, title: "new b" });
    const c = preview({ url: "https://c.test", updated_at: 2 });
    const merged = mergePreviewLists([a, b], [bNew, c]);
    expect(merged.map((row) => row.url)).toEqual([
      "https://a.test",
      "https://b.test",
      "https://c.test",
    ]);
    expect(merged[1]?.title).toBe("new b");
  });

  test("older overlay does not roll back a newer link", () => {
    const newer = preview({ url: "https://a.test", updated_at: 9, title: "new" });
    const older = preview({ url: "https://a.test", updated_at: 2, title: "old" });
    const merged = mergePreviewLists([newer], [older]);
    expect(merged[0]?.title).toBe("new");
    expect(merged[0]?.updated_at).toBe(9);
  });

  test("apply is idempotent for duplicate events", () => {
    const a = preview({ url: "https://a.test", updated_at: 4, status: "partial" });
    const first = applyPreviewUpdate(undefined, [a], 4);
    expect(first?.previews).toHaveLength(1);
    const duplicate = applyPreviewUpdate(first, [a], 4);
    expect(duplicate).toBe(first);
  });

  test("stale event (older updatedAt) returns the same entry", () => {
    const fresh = preview({ url: "https://a.test", updated_at: 9, title: "fresh" });
    const existing = applyPreviewUpdate(undefined, [fresh], 9);
    const stale = preview({ url: "https://a.test", updated_at: 2, title: "stale" });
    const after = applyPreviewUpdate(existing, [stale], 2);
    expect(after).toBe(existing);
    expect(after?.previews[0]?.title).toBe("fresh");
  });

  test("caps at three previews", () => {
    const rows = [1, 2, 3, 4].map((n) =>
      preview({ url: `https://${n}.test`, updated_at: n }),
    );
    expect(capPreviews(rows)).toHaveLength(3);
    const entry = applyPreviewUpdate(undefined, rows, 4);
    expect(entry?.previews).toHaveLength(3);
  });

  test("previewsEqual detects field changes", () => {
    const a = preview({ updated_at: 1 });
    expect(previewsEqual([a], [{ ...a }])).toBe(true);
    expect(previewsEqual([a], [{ ...a, status: "ready" }])).toBe(false);
    expect(previewsEqual([a], [{ ...a, final_url: "https://example.com/final" }])).toBe(false);
    expect(previewsEqual([a], [{ ...a, kind: "image", mime: "image/png" }])).toBe(false);
    expect(previewsEqual([a], [{ ...a, label: "label", site_name: "Example" }])).toBe(false);
    expect(
      previewsEqual(
        [a],
        [{ ...a, cover: { url: "https://example.com/c.png", w: 800, h: 600, kind: "og" } }],
      ),
    ).toBe(false);
    const withCover = preview({
      cover: { url: "https://example.com/c.png", w: 800, h: 600, kind: "og" },
    });
    expect(
      previewsEqual(
        [withCover],
        [{ ...withCover, cover: { ...withCover.cover!, w: 801 } }],
      ),
    ).toBe(false);
    expect(previewsEqual([a], [{ ...a, fields_ready: ["kind"] }])).toBe(false);
  });
});

describe("carousel index", () => {
  const cards = [
    preview({ url: "https://a.test" }),
    preview({ url: "https://b.test" }),
    preview({ url: "https://c.test" }),
  ];

  test("keeps the current canonicalUrl page", () => {
    expect(resolveCarouselIndex(cards, "https://b.test", 0)).toBe(1);
    expect(resolveCarouselIndex(cards, "https://c.test", 0)).toBe(2);
  });

  test("clamps when the selected URL disappears", () => {
    expect(resolveCarouselIndex(cards, "https://gone.test", 9)).toBe(2);
    expect(resolveCarouselIndex(cards, null, 1)).toBe(1);
    expect(resolveCarouselIndex([], "https://a.test", 2)).toBe(0);
  });
});

describe("plugins state", () => {
  test("optimistic toggle + rollback restores the previous row", () => {
    const original = plugin({ enabled: true });
    const on = optimisticPluginEnabled([original], original.id, false);
    expect(on[0]?.enabled).toBe(false);
    const rolledBack = restorePlugin(on, original);
    expect(rolledBack[0]?.enabled).toBe(true);
  });

  test("unknown plugin id is a no-op", () => {
    const original = plugin();
    const list = optimisticPluginEnabled([original], "unknown", false);
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(original);
  });

  test("replacePlugin keeps list identity for other rows", () => {
    const other = plugin({ id: "other", name: "other" });
    const updated = plugin({ version: "2.0.0" });
    const list = replacePlugin([plugin(), other], updated);
    expect(list[0]?.version).toBe("2.0.0");
    expect(list[1]).toBe(other);
  });

  test("static snapshot projects preview_enabled", () => {
    expect(staticLinkPreviewPlugin(false).enabled).toBe(false);
    expect(staticLinkPreviewPlugin(true).enabled).toBe(true);
    expect(staticLinkPreviewPlugin(false).version).toBe("snapshot");
  });
});

describe("static archive plugin API", () => {
  test("plugins()/setPlugin() issue zero fetch requests", async () => {
    const snapshot = {
      version: 1,
      as_of_seq: 0,
      viewer: "owner",
      accounts: [],
      follows: [],
      posts: [],
      media: [],
      preview_enabled: false,
    };
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("static archive must not fetch");
    }) as unknown as typeof fetch;
    try {
      const client = new StaticReportClient(snapshot);
      expect(client.mode).toBe("static");
      expect(await client.plugins()).toEqual([]);
      expect(client.staticPreviewEnabled()).toBe(false);
      await expect(client.setPlugin()).rejects.toMatchObject({ code: "READ_ONLY" });
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("bare URL fallback (single scanner)", () => {
  test("trims trailing punctuation and keeps balanced parentheses", () => {
    const matches = scanBareUrls(
      "看 https://example.com/a. 和 https://en.wikipedia.org/wiki/Foo_(bar)，还有 https://example.com/b?x=1",
    );
    expect(matches.map((match) => match.url)).toEqual([
      "https://example.com/a",
      "https://en.wikipedia.org/wiki/Foo_(bar)",
      "https://example.com/b?x=1",
    ]);
  });

  test("only http/https is linkified", () => {
    const matches = scanBareUrls("ftp://example.com and example.com and http://ok.test/x");
    expect(matches.map((match) => match.url)).toEqual(["http://ok.test/x"]);
  });

  test("Markdown.tsx reuses core/link-extract (no second URL regex)", () => {
    const source = readFileSync(
      new URL("../src/ui/components/Markdown.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('import { scanBareUrls } from "@core/link-extract"');
    expect(source).not.toContain("https?:");
  });
});

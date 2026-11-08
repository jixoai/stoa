import { describe, expect, test } from "bun:test";
import {
  EXTRACT_VERSION,
  MAX_LABEL_CHARS,
  canonicalizeUrl,
  extractLinks,
  scanBareUrls,
} from "../src/core/link-extract.ts";
import { BUILTIN_PLUGINS, LINK_PREVIEW, builtinPlugin } from "../src/core/plugins/builtin.ts";
import { LINK_PREVIEW_PROVIDER, phasesForUrl } from "../src/server/preview/link-preview/provider.ts";

describe("link extraction (report-link-preview P1-3)", () => {
  test("skips fenced code, inline code and images; keeps markdown link + bare URL", () => {
    const body = [
      "正文裸链接 http://example.com/a 与 [报告](https://example.com/r)。",
      "",
      "```",
      "https://code.example.com/block",
      "```",
      "",
      "行内 `https://code.example.com/inline` 不算。",
      "",
      "![图](https://img.example.com/a.png)",
    ].join("\n");
    const links = extractLinks(body);
    expect(links.map((link) => link.url)).toEqual([
      "http://example.com/a",
      "https://example.com/r",
    ]);
    expect(links[1]!.label).toBe("报告");
    expect(links[0]!.label).toBeNull();
  });

  test("normalizes scheme/host, drops fragment/default port/tracking params, keeps query order", () => {
    expect(canonicalizeUrl("HTTP://Example.COM:80/a?b=2&utm_source=x&a=1#frag")).toBe(
      "http://example.com/a?b=2&a=1",
    );
    expect(canonicalizeUrl("https://Example.com:443/p?fbclid=1&z=9")).toBe(
      "https://example.com/p?z=9",
    );
    expect(canonicalizeUrl("ftp://example.com/x")).toBeNull();
  });

  test("dedupes utm/fragment variants and caps at 3 links", () => {
    const body = [
      "https://example.com/a?utm_source=x",
      "https://example.com/a#section",
      "https://example.com/b",
      "https://example.com/c",
      "https://example.com/d",
    ].join(" ");
    const links = extractLinks(body);
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(links.map((link) => link.position)).toEqual([0, 1, 2]);
  });

  test("drops URLs longer than 2048 instead of truncating; truncates labels to 200", () => {
    const long = `https://example.com/${"a".repeat(2050)}`;
    expect(extractLinks(long)).toHaveLength(0);
    const label = "标".repeat(260);
    const links = extractLinks(`[${label}](https://example.com/r)`);
    expect(links[0]!.label!.length).toBe(MAX_LABEL_CHARS);
  });

  test("scanBareUrls trims trailing punctuation and unbalanced parentheses", () => {
    const text = "看 (https://example.com/x)。另见 https://example.com/y，还有 https://example.com/z).";
    const urls = scanBareUrls(text).map((match) => match.url);
    expect(urls).toEqual([
      "https://example.com/x",
      "https://example.com/y",
      "https://example.com/z",
    ]);
  });

  test("N3: bare URL stops at the first CJK/full-width boundary", () => {
    const direct = scanBareUrls("访问https://example.com/a获取详情");
    expect(direct).toHaveLength(1);
    expect(direct[0]!.url).toBe("https://example.com/a");
    expect(direct[0]!.index).toBe(2);
    // 链接文字不得吞掉后续正文。
    expect("访问https://example.com/a获取详情".slice(direct[0]!.index, direct[0]!.index + direct[0]!.length)).toBe(
      "https://example.com/a",
    );

    // 中英混排 + 全角标点。
    expect(scanBareUrls("see https://example.com/a 中文").map((m) => m.url)).toEqual([
      "https://example.com/a",
    ]);
    expect(scanBareUrls("https://example.com/a：继续").map((m) => m.url)).toEqual([
      "https://example.com/a",
    ]);
    expect(scanBareUrls("https://example.com/a，继续").map((m) => m.url)).toEqual([
      "https://example.com/a",
    ]);
    expect(scanBareUrls("（https://example.com/a）后文").map((m) => m.url)).toEqual([
      "https://example.com/a",
    ]);

    // 百分号编码原样保留（%E4%B8%AD 是 ASCII，不应被 CJK 边界截断）。
    expect(scanBareUrls("https://example.com/a%20b/中文?x=%E4%B8%AD后续").map((m) => m.url)).toEqual([
      "https://example.com/a%20b/",
    ]);
    expect(scanBareUrls("https://example.com/a%20b?x=%E4%B8%AD后续").map((m) => m.url)).toEqual([
      "https://example.com/a%20b?x=%E4%B8%AD",
    ]);
  });

  test("N3: extraction uses the truncated URL; markdown links are not duplicated", () => {
    const links = extractLinks("访问https://example.com/a获取详情");
    expect(links.map((link) => link.url)).toEqual(["https://example.com/a"]);

    const markdown = extractLinks("[报告](https://example.com/中文)\n另见 [x](https://example.com/target)");
    expect(markdown.map((link) => link.url)).toEqual([
      "https://example.com/%E4%B8%AD%E6%96%87",
      "https://example.com/target",
    ]);
    expect(markdown.map((link) => link.label)).toEqual(["报告", "x"]);
  });

  test("B4: no 64KiB truncation — links at the tail, across the boundary, and no fake URL", () => {
    const filler = "正文".repeat(50_000); // 100k 字符，跨越旧 64KiB 边界
    const tail = extractLinks(`${filler}\nhttps://example.com/tail`);
    expect(tail.map((link) => link.url)).toEqual(["https://example.com/tail"]);

    // 旧实现会把跨边界的 URL 截成 `https://e.co/` 之类的假 URL。
    const boundaryFiller = "a".repeat(64 * 1024 - 8);
    const boundary = extractLinks(`${boundaryFiller}https://example.com/boundary`);
    expect(boundary.map((link) => link.url)).toEqual(["https://example.com/boundary"]);
    for (const link of boundary) {
      expect(`${boundaryFiller}https://example.com/boundary`).toContain(link.url);
    }

    // 跨边界的 markdown 链接完整抽取（label + href）。
    const mdBoundary = `${"a".repeat(64 * 1024 - 4)}[报告](https://example.com/split)`;
    const split = extractLinks(mdBoundary);
    expect(split).toHaveLength(1);
    expect(split[0]).toMatchObject({
      url: "https://example.com/split",
      label: "报告",
    });

    // 64KiB 之后仍有链接：全部抽取，不因截断丢失。
    const after = extractLinks(`${filler} 后文 https://example.com/after64k`);
    expect(after.map((link) => link.url)).toContain("https://example.com/after64k");
  });

  test("N8: pathological 200k '[' body extracts in <200ms", () => {
    const flood = "[".repeat(200_000);
    const started = performance.now();
    const links = extractLinks(flood);
    expect(links).toEqual([]);
    expect(performance.now() - started).toBeLessThan(200);

    // 单个 "](" 但无 ")" 也不能退化为 O(n²)。
    const almostLink = `${"[".repeat(100_000)}](`;
    const started2 = performance.now();
    expect(extractLinks(almostLink)).toEqual([]);
    expect(performance.now() - started2).toBeLessThan(200);
  });

  test("extraction stays fast on a 200k body", () => {
    const filler = "普通正文段落，没有链接。".repeat(8000).slice(0, 200_000);
    const body = `${filler}\nhttps://example.com/one\nhttps://example.com/two`;
    extractLinks(body); // 预热（JIT/正则编译）
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      const links = extractLinks(body);
      best = Math.min(best, performance.now() - started);
      expect(links).toHaveLength(2);
    }
    // 目标 <5ms（design P1-3）；测试取三次最小值，阈值放宽到 100ms 抵消 CI 抖动。
    expect(best).toBeLessThan(100);
  });

  test("manifest is complete and phases are fixed per kind", () => {
    expect(BUILTIN_PLUGINS.map((plugin) => plugin.id)).toEqual(["link-preview"]);
    expect(builtinPlugin("link-preview")).toBe(LINK_PREVIEW);
    expect(builtinPlugin("missing")).toBeNull();
    expect(LINK_PREVIEW.version).toBe("1.0.0");
    expect(LINK_PREVIEW.rulesVersion).toBeGreaterThan(0);
    expect(LINK_PREVIEW.kind).toBe("preview");
    expect(LINK_PREVIEW.defaultEnabled).toBe(true);
    expect(LINK_PREVIEW.requires).toContainEqual({ id: "file-viewer", optional: true });
    expect(EXTRACT_VERSION).toBeGreaterThan(0);

    expect(phasesForUrl("https://example.com/story")).toEqual(["meta", "cover"]); 
    expect(phasesForUrl("https://example.com/a.png")).toEqual(["probe"]);
    expect(phasesForUrl("https://example.com/a.mp4")).toEqual(["probe"]);
    expect(phasesForUrl("https://example.com/a.pdf")).toEqual(["probe"]);
    expect(LINK_PREVIEW_PROVIDER.manifest).toBe(LINK_PREVIEW);
  });

  test("provider cache key is sha256 over the five-tuple (stable + sensitive)", () => {
    const base = {
      canonicalUrl: "https://example.com/a",
      bodyHash: "b".repeat(64),
      pluginId: "link-preview",
      pluginVersion: "1.0.0",
      rulesVersion: 1001,
    };
    const key = LINK_PREVIEW_PROVIDER.buildCacheKey(base);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(LINK_PREVIEW_PROVIDER.buildCacheKey({ ...base })).toBe(key);
    expect(LINK_PREVIEW_PROVIDER.buildCacheKey({ ...base, rulesVersion: 1002 })).not.toBe(key);
    expect(LINK_PREVIEW_PROVIDER.buildCacheKey({ ...base, pluginVersion: "1.1.0" })).not.toBe(key);
    expect(LINK_PREVIEW_PROVIDER.buildCacheKey({ ...base, canonicalUrl: "https://example.com/b" })).not.toBe(key);
  });
});

import { describe, expect, test } from "bun:test";
import { decodeHtml, decodeEntities, parseHtmlMeta, truncateChars } from "../src/server/preview/html.ts";

const BASE = "https://example.com/articles/1";

describe("HTML metadata scan (report-link-preview P1-10 / design §6.4)", () => {
  test("OG wins and keeps image dimensions", () => {
    const html = `<!doctype html><html><head>
      <title>doc title</title>
      <meta name="description" content="meta desc">
      <meta property="og:title" content="OG Title">
      <meta property="og:description" content="OG Desc">
      <meta property="og:site_name" content="Example Site">
      <meta property="og:image" content="/img/cover.png">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
    </head><body><p>${"正文".repeat(30)}</p></body></html>`;
    const meta = parseHtmlMeta(html, BASE);
    expect(meta.title).toBe("OG Title");
    expect(meta.description).toBe("OG Desc");
    expect(meta.site_name).toBe("Example Site");
    expect(meta.cover).toEqual({
      url: "https://example.com/img/cover.png",
      w: 1200,
      h: 630,
      kind: "og",
    });
  });

  test("missing cover falls back to favicon; SVG is never a cover", () => {
    const html = `<html><head><title>T</title>
      <link rel="icon" href="/favicon.ico">
      <link rel="icon" href="/logo.svg" type="image/svg+xml">
    </head></html>`;
    const meta = parseHtmlMeta(html, BASE);
    expect(meta.cover?.url).toBe("https://example.com/favicon.ico");
    expect(meta.cover?.kind).toBe("favicon");

    const svgOnly = `<html><head><meta property="og:image" content="/cover.svg"><title>T</title></head></html>`;
    expect(parseHtmlMeta(svgOnly, BASE).cover).toBeNull();
  });

  test("Twitter Card is the fallback below OG", () => {
    const html = `<html><head>
      <meta name="twitter:title" content="TW Title">
      <meta name="twitter:description" content="TW Desc">
      <meta name="twitter:image" content="https://cdn.example.com/a.jpg">
    </head></html>`;
    const meta = parseHtmlMeta(html, BASE);
    expect(meta.title).toBe("TW Title");
    expect(meta.description).toBe("TW Desc");
    expect(meta.cover?.url).toBe("https://cdn.example.com/a.jpg");
    expect(meta.cover?.w).toBeNull();
  });

  test("title-only page and article/main first paragraph fallback", () => {
    const html = `<html><head><title>Only Title</title></head><body><main><p>${"长".repeat(60)}</p></main></body></html>`;
    const meta = parseHtmlMeta(html, BASE);
    expect(meta.title).toBe("Only Title");
    expect(meta.description).toBe("长".repeat(60));
    expect(meta.cover).toBeNull();
  });

  test("GBK page decodes Chinese correctly", () => {
    const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));
    const bytes = new Uint8Array([
      ...ascii('<html><head><meta charset="gbk"><title>'),
      0xd6, 0xd0, 0xce, 0xc4, // 中文 (GBK)
      ...ascii("</title></head><body></body></html>"),
    ]);
    const html = decodeHtml(bytes, "text/html; charset=gbk");
    expect(parseHtmlMeta(html, BASE).title).toBe("中文");
  });

  test("charset falls back to <meta charset> then UTF-8", () => {
    const utf8 = new TextEncoder().encode(`<meta charset="utf-8"><title>UTF8 标题</title>`);
    expect(parseHtmlMeta(decodeHtml(utf8, null), BASE).title).toBe("UTF8 标题");
    const broken = new Uint8Array([0xff, 0xfe, 0x41]);
    expect(typeof decodeHtml(broken, null)).toBe("string");
  });

  test("truncates by characters and decodes entities", () => {
    const html = `<html><head>
      <meta property="og:title" content="${"标".repeat(260)}">
      <meta property="og:description" content="${"述".repeat(460)}">
      <meta property="og:site_name" content="&amp;Site &lt;X&gt;">
    </head></html>`;
    const meta = parseHtmlMeta(html, BASE);
    expect(meta.title!.length).toBe(200);
    expect(meta.description!.length).toBe(400);
    expect(meta.site_name).toBe("&Site <X>");
    expect(truncateChars("abcdef", 3)).toBe("abc");
    expect(decodeEntities("&#x4E2D;&#25991;&nbsp;&amp;")).toBe("中文 &");
  });

  test("N1: out-of-range numeric entities fall back to U+FFFD (no RangeError)", () => {
    expect(decodeEntities("&#x110000;")).toBe("\uFFFD");
    expect(decodeEntities("&#99999999;")).toBe("\uFFFD");
    expect(decodeEntities("&#xD800;")).toBe("\uFFFD");
    expect(decodeEntities("&#0;&#x10FFFF;")).toBe("\u0000\uDBFF\uDFFF");
  });

  test("base href resolves relative covers; canonical is captured", () => {
    const html = `<html><head><base href="https://cdn.example.com/root/">
      <meta property="og:image" content="img/a.png">
      <link rel="canonical" href="/canonical">
      <title>T</title>
    </head></html>`;
    const meta = parseHtmlMeta(html, BASE);
    expect(meta.cover?.url).toBe("https://cdn.example.com/root/img/a.png");
    expect(meta.canonical).toBe("https://cdn.example.com/canonical");
  });

  test("scans a 512KiB document in under 20ms", () => {
    const chunk = `<div><p>${"lorem ipsum ".repeat(20)}</p></div>`;
    const html = `<html><head><title>Big</title><meta property="og:image" content="/c.png"></head><body>${chunk.repeat(1400)}</body></html>`;
    const started = performance.now();
    const meta = parseHtmlMeta(html, BASE);
    const elapsed = performance.now() - started;
    expect(meta.title).toBe("Big");
    expect(elapsed).toBeLessThan(50);
  });

  test("B1: 512KiB unclosed <p> flood stays linear (<100ms)", () => {
    const flood = "<p>".repeat(180 * 1024); // 540KiB，全部未闭合
    expect(flood.length).toBeGreaterThan(500_000);
    const started = performance.now();
    const meta = parseHtmlMeta(`<html><head><title>Flood</title></head><body>${flood}</body></html>`, BASE);
    const elapsed = performance.now() - started;
    expect(meta.title).toBe("Flood");
    expect(meta.description).toBeNull();
    expect(elapsed).toBeLessThan(100);
  });

  test("B1: unclosed <p> flood with a long paragraph beyond 64KiB still returns fast", () => {
    const noise = "<p>".repeat(40 * 1024);
    const tail = `<p>${"长".repeat(80)}</p>`;
    const html = `<html><body>${noise}${tail}</body></html>`;
    const started = performance.now();
    const meta = parseHtmlMeta(html, BASE);
    expect(performance.now() - started).toBeLessThan(100);
    // 首段扫描上限 64KiB：尾部段落不参与描述（可接受，避免全文回溯）。
    expect(meta.description).toBeNull();
  });
});

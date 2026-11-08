#!/usr/bin/env node
/**
 * link-preview-fixture.mjs — deterministic fake-site server for
 * openspec change `report-link-preview` E2E (design §14.1).
 *
 * Two loopback listeners in one process:
 *   main     — the ONLY origin placed in
 *              FDE2E_REPORT_PREVIEW_TEST_ALLOW_ORIGINS (pages/resources/redirects)
 *   private  — a second, deliberately NON-allowlisted origin used to prove that
 *              a redirect into loopback is blocked as `blocked_private`
 *              (design §7.5; A8 asserts its counter stays 0)
 *
 * Every non-control request is counted per path/method with the request UA and
 * a small header snapshot. `GET /__stats` returns those counters (main +
 * private); `POST /__reset` zeroes them. `GET /__fixtures` returns ready-made
 * post bodies (including the 4-link body used by A10) for the current origin.
 *
 * Nothing here is stateful beyond the counters: identical requests always get
 * identical bytes. No external network, no files, no persistence.
 *
 * Usage:
 *   node scripts/qa/link-preview-fixture.mjs
 *   node scripts/qa/link-preview-fixture.mjs --port 0 --private-port 0
 *   node scripts/qa/link-preview-fixture.mjs --self-test
 *   bun  scripts/qa/link-preview-fixture.mjs
 *
 * stdout (exactly one JSON line, after both listeners are ready):
 *   {"ok":true,"url":"http://127.0.0.1:41234","port":41234,
 *    "privateUrl":"http://127.0.0.1:41235","privatePort":41235,"pid":4242}
 *
 * Logs go to stderr. SIGINT/SIGTERM close both listeners.
 */
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

// ── argv ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const flagValue = (name, fallback = null) => {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return fallback;
};
const log = (...parts) => process.stderr.write(`[link-fixture] ${parts.join(" ")}\n`);

const HOST = flagValue("host", "127.0.0.1");
const PORT = Number(flagValue("port", "0"));
const PRIVATE_PORT = Number(flagValue("private-port", "0"));
const SELF_TEST = hasFlag("self-test");

// ── deterministic PNG generator (same approach as qa-serve.mjs) ──────────────
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(width, height, seed = 0) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const off = row + 1 + x * 3;
      raw[off] = (40 + Math.round((x / width) * 160) + seed) & 0xff;
      raw[off + 1] = (90 + Math.round((y / height) * 120) + seed * 2) & 0xff;
      raw[off + 2] = (180 + Math.round(((x + y) / (width + height)) * 60)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Pre-compressed payloads (fixed bytes, generated once).
const COVER_PNG = makePng(1200, 630, 3);
const IMG_SMALL_PNG = makePng(320, 240, 7);
const IMG_LARGE_PNG = makePng(1600, 1200, 11);
const FAVICON_PNG = makePng(16, 16, 1);

const MP4_BYTES = (() => {
  const head = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
    0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65,
  ]);
  return Buffer.concat([head, Buffer.alloc(96 * 1024, 0x21)]);
})();
const MP3_BYTES = Buffer.concat([
  Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  Buffer.alloc(48 * 1024, 0x55),
]);
const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.7\n% fixture\n1 0 obj<</Type/Catalog>>endobj\n"),
  Buffer.alloc(24 * 1024, 0x20),
  Buffer.from("\n%%EOF\n"),
]);
const DOCX_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
  Buffer.alloc(24 * 1024, 0x42),
]);
const UNKNOWN_BYTES = Buffer.alloc(16 * 1024, 0x00);
for (let i = 0; i < UNKNOWN_BYTES.length; i += 1) UNKNOWN_BYTES[i] = (i * 31 + 7) & 0xff;
const HUGE_BYTES = Buffer.alloc(5 * 1024 * 1024, 0x41);
const SVG_COVER = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">` +
    `<rect width="1200" height="630" fill="#3355aa"/>` +
    `<text x="40" y="90" fill="#ffffff" font-size="48">SVG cover (must be rejected)</text>` +
  `</svg>\n`,
);

// ── fixed page copy ──────────────────────────────────────────────────────────
const ARTICLE_FIRST_PARAGRAPH =
  "首段抽取标记：这段文字位于 article 的首个段落，长度超过四十个字符，包含标点、数字 2026 与英文 fixture，" +
  "用于验证没有 OG/Twitter/meta description 时回退到正文首段作为描述。";
const ARTICLE_EXTRA = Array.from(
  { length: 40 },
  (_, i) => `第 ${i + 1} 行长正文：链接预览抓取只允许读取前 512KiB，后续内容不得进入元数据。`,
).join("\n");
const LONG_TITLE = "超长".repeat(130); // 260 chars
const LONG_DESCRIPTION = "描述".repeat(250); // 500 chars

// GBK bytes (hard-coded so the fixture never depends on ICU/transcoding).
// "GBK 编码标题" = ASCII "GBK " + B1E0 C2EB B1EA CCE2
// "GBK 编码描述" = ASCII "GBK " + B1E0 C2EB C3E8 CAF6
const GBK_TITLE = Buffer.from("47424b20b1e0c2ebb1eacce2", "hex");
const GBK_DESCRIPTION = Buffer.from("47424b20b1e0c2ebc3e8caf6", "hex");
const GBK_PAGE = Buffer.concat([
  Buffer.from('<html><head><meta charset="gbk"><title>'),
  GBK_TITLE,
  Buffer.from('</title><meta name="description" content="'),
  GBK_DESCRIPTION,
  Buffer.from('"></head><body><p>GBK fixture page</p></body></html>'),
]);

// ── counters ─────────────────────────────────────────────────────────────────
const CONTROL_PREFIX = "/__";
const MAX_SAMPLES = 24;
const MAX_UAS = 16;

function newSide() {
  return { requests: 0, workerRequests: 0, paths: new Map() };
}

const state = {
  startedAt: Date.now(),
  resetAt: Date.now(),
  resets: 0,
  main: newSide(),
  private: newSide(),
  origins: { main: null, private: null },
};

function record(side, req, pathname) {
  if (pathname.startsWith(CONTROL_PREFIX)) return;
  side.requests += 1;
  const bucket = (() => {
    const existing = side.paths.get(pathname);
    if (existing) return existing;
    const created = {
      total: 0,
      worker: 0,
      HEAD: 0,
      GET: 0,
      other: 0,
      firstAt: null,
      lastAt: null,
      uas: [],
      samples: [],
    };
    side.paths.set(pathname, created);
    return created;
  })();
  const ua = String(req.headers["user-agent"] ?? "");
  const isWorker = /^fde2e-report-link-preview/i.test(ua);
  if (isWorker) side.workerRequests += 1;
  bucket.total += 1;
  if (isWorker) bucket.worker += 1;
  if (req.method === "HEAD") bucket.HEAD += 1;
  else if (req.method === "GET") bucket.GET += 1;
  else bucket.other += 1;
  const at = Date.now();
  if (bucket.firstAt === null) bucket.firstAt = at;
  bucket.lastAt = at;
  if (ua && !bucket.uas.includes(ua) && bucket.uas.length < MAX_UAS) bucket.uas.push(ua);
  const sample = {
    at,
    method: req.method,
    ua,
    accept: String(req.headers.accept ?? ""),
    acceptEncoding: String(req.headers["accept-encoding"] ?? ""),
    range: String(req.headers.range ?? ""),
    referer: String(req.headers.referer ?? ""),
    host: String(req.headers.host ?? ""),
    authorization: req.headers.authorization ? "<present>" : "",
    cookie: req.headers.cookie ? "<present>" : "",
    xForwardedFor: String(req.headers["x-forwarded-for"] ?? ""),
  };
  bucket.samples.push(sample);
  if (bucket.samples.length > MAX_SAMPLES) bucket.samples.shift();
}

function sideJson(side) {
  const paths = {};
  for (const [pathname, bucket] of [...side.paths.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    paths[pathname] = { ...bucket, uas: [...bucket.uas], samples: [...bucket.samples] };
  }
  return { requests: side.requests, workerRequests: side.workerRequests, paths };
}

function statsPayload() {
  return {
    ok: true,
    pid: process.pid,
    startedAt: state.startedAt,
    now: Date.now(),
    resetAt: state.resetAt,
    resets: state.resets,
    main: { origin: state.origins.main, ...sideJson(state.main) },
    private: { origin: state.origins.private, ...sideJson(state.private) },
  };
}

function resetStats() {
  state.resets += 1;
  state.resetAt = Date.now();
  state.main = newSide();
  state.private = newSide();
}

// ── response helpers ─────────────────────────────────────────────────────────
function originOf(req, port) {
  return `http://${req.headers.host ?? `${HOST}:${port}`}`;
}

function send(req, res, status, headers, body) {
  const buffer = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const out = { "cache-control": "no-store", ...headers };
  if (!("content-length" in out)) out["content-length"] = String(buffer.length);
  res.writeHead(status, out);
  if (req.method === "HEAD") res.end();
  else res.end(buffer);
}

function html(req, res, body, extra = {}) {
  send(req, res, 200, { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*", ...extra }, body);
}
function media(req, res, type, bytes, extra = {}) {
  const headers = { "content-type": type, "accept-ranges": "bytes", "access-control-allow-origin": "*", ...extra };
  const range = String(req.headers.range ?? "");
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (match && (match[1] !== "" || match[2] !== "")) {
    const total = bytes.length;
    let start = match[1] === "" ? Math.max(0, total - Number(match[2])) : Number(match[1]);
    let end = match[1] === "" || match[2] === "" ? total - 1 : Number(match[2]);
    start = Math.min(Math.max(0, start), total - 1);
    end = Math.min(Math.max(start, end), total - 1);
    const slice = bytes.subarray(start, end + 1);
    send(req, res, 206, {
      ...headers,
      "content-range": `bytes ${start}-${end}/${total}`,
      "content-length": String(slice.length),
    }, slice);
    return;
  }
  send(req, res, 200, headers, bytes);
}

function ogTags({ title, description, siteName, image, width, height, type }) {
  const tags = [];
  if (title != null) tags.push(`<meta property="og:title" content="${title}">`);
  if (description != null) tags.push(`<meta property="og:description" content="${description}">`);
  if (siteName != null) tags.push(`<meta property="og:site_name" content="${siteName}">`);
  if (image != null) tags.push(`<meta property="og:image" content="${image}">`);
  if (width != null) tags.push(`<meta property="og:image:width" content="${width}">`);
  if (height != null) tags.push(`<meta property="og:image:height" content="${height}">`);
  if (type != null) tags.push(`<meta property="og:type" content="${type}">`);
  return tags.join("");
}

function pageHtml(head, body) {
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

const TWITTER_TAGS = [
  `<meta name="twitter:card" content="summary_large_image">`,
  `<meta name="twitter:title" content="Twitter 卡片标题">`,
  `<meta name="twitter:description" content="Twitter 卡片描述：OG 缺失时的回退来源。">`,
].join("");

const PLAIN_PAGE = pageHtml(
  `<title>仅标题页面</title><meta name="description" content="仅标题与描述：没有 OG，也没有 Twitter Card。">`,
  `<main><p>plain fixture</p></main>`,
);

const ARTICLE_PAGE = pageHtml(
  `<title>长正文文章标题</title>`,
  `<nav>导航不应被当作正文</nav><main><article><h1>长正文文章</h1>` +
    `<p>${ARTICLE_FIRST_PARAGRAPH}</p>` +
    `<p>${ARTICLE_EXTRA.replace(/\n/g, "</p><p>")}</p>` +
    `</article></main>`,
);

// ── routing ──────────────────────────────────────────────────────────────────
function fixturesPayload(origin, privateOrigin) {
  const url = (path) => `${origin}${path}`;
  return {
    ok: true,
    origin,
    privateOrigin,
    pages: {
      ogFull: url("/og-full"),
      ogNoCover: url("/og-no-cover"),
      twitter: url("/twitter"),
      plain: url("/plain"),
      noContentType: url("/no-ct"),
      gbk: url("/gbk"),
      article: url("/article"),
      svgCover: url("/svg-cover"),
      longTitle: url("/long-title"),
      metaRefresh: url("/meta-refresh"),
      delay1s: url("/delay-1s"),
      delay2s: url("/delay-2s"),
      slowOk: url("/slow-ok"),
      slow: url("/slow"),
      huge: url("/huge"),
      head405: url("/head-405"),
      notFound: url("/404"),
      redirectOne: url("/redirect-one"),
      redirectChain: url("/redirect-chain"),
      redirectPrivate: url("/redirect-private"),
      redirectLoop: url("/redirect-loop"),
    },
    resources: {
      cover: url("/cover.png"),
      coverSvg: url("/cover.svg"),
      imageSmall: url("/img.png"),
      imageLarge: url("/img-large.png"),
      video: url("/video.mp4"),
      audio: url("/audio.mp3"),
      pdf: url("/doc.pdf"),
      docx: url("/doc.docx"),
      unknown: url("/unknown.bin"),
    },
    posts: {
      fourLinks: [
        "四链接夹具：帖子正文只应产出前 3 条预览。",
        "",
        url("/og-full"),
        url("/twitter"),
        url("/plain"),
        url("/article"),
      ].join("\n"),
      twoLinks: ["双链接夹具。", "", url("/og-full"), url("/og-no-cover")].join("\n"),
      onePage: ["单链接夹具。", "", url("/og-full")].join("\n"),
      oneImage: ["图片链接夹具。", "", url("/img.png")].join("\n"),
      oneVideo: ["视频链接夹具。", "", url("/video.mp4")].join("\n"),
      oneDocument: ["文档链接夹具。", "", url("/doc.pdf")].join("\n"),
    },
  };
}

function handleMain(req, res) {
  const url = new URL(req.url ?? "/", "http://fixture.invalid");
  const pathname = url.pathname;
  record(state.main, req, pathname);
  const origin = state.origins.main ?? originOf(req, state.origins.mainPort);
  const privateOrigin = state.origins.private;

  // control plane
  if (pathname === "/__health") {
    send(req, res, 200, { "content-type": "application/json" }, JSON.stringify({ ok: true }));
    return;
  }
  if (pathname === "/__stats") {
    send(req, res, 200, { "content-type": "application/json" }, JSON.stringify(statsPayload()));
    return;
  }
  if (pathname === "/__reset") {
    if (req.method !== "POST") {
      send(req, res, 405, { allow: "POST" }, "");
      return;
    }
    resetStats();
    send(req, res, 200, { "content-type": "application/json" }, JSON.stringify({ ok: true, resetAt: state.resetAt }));
    return;
  }
  if (pathname === "/__fixtures") {
    send(
      req,
      res,
      200,
      { "content-type": "application/json", "access-control-allow-origin": "*" },
      JSON.stringify(fixturesPayload(origin, privateOrigin)),
    );
    return;
  }

  // pages
  if (pathname === "/og-full") {
    html(
      req,
      res,
      pageHtml(
        ogTags({
          title: "OG 完整页面标题",
          description: "OG 完整页面描述：title/description/site_name/image/width/height 全部存在。",
          siteName: "Link Preview Fixture",
          image: `${origin}/cover.png`,
          width: 1200,
          height: 630,
          type: "article",
        }) + `<title>HTML 标题不应优先于 OG</title>`,
        `<main><p>OG 完整页面正文。</p></main>`,
      ),
    );
    return;
  }
  if (pathname === "/og-no-cover") {
    html(
      req,
      res,
      pageHtml(
        ogTags({
          title: "OG 无封面标题",
          description: "OG 无封面描述：只有文字字段，cover 应为 null。",
          siteName: "Link Preview Fixture",
        }),
        `<main><p>无封面页面。</p></main>`,
      ),
    );
    return;
  }
  if (pathname === "/twitter") {
    html(
      req,
      res,
      pageHtml(
        TWITTER_TAGS + `<meta name="twitter:image" content="${origin}/cover.png"><title>HTML 标题不应优先</title>`,
        `<main><p>Twitter card 页面。</p></main>`,
      ),
    );
    return;
  }
  if (pathname === "/plain") {
    html(req, res, PLAIN_PAGE);
    return;
  }
  if (pathname === "/no-ct") {
    // Deliberately no Content-Type header: the fetcher must fall back to sniffing.
    send(req, res, 200, { "access-control-allow-origin": "*" }, PLAIN_PAGE);
    return;
  }
  if (pathname === "/gbk") {
    send(
      req,
      res,
      200,
      { "content-type": "text/html; charset=gbk", "access-control-allow-origin": "*" },
      GBK_PAGE,
    );
    return;
  }
  if (pathname === "/article") {
    html(req, res, ARTICLE_PAGE);
    return;
  }
  if (pathname === "/svg-cover") {
    html(
      req,
      res,
      pageHtml(
        ogTags({
          title: "SVG 封面页面",
          description: "封面指向 SVG：必须被拒绝，title 仍应保留。",
          siteName: "Link Preview Fixture",
          image: `${origin}/cover.svg`,
        }),
        `<main><p>SVG cover page.</p></main>`,
      ),
    );
    return;
  }
  if (pathname === "/long-title") {
    html(
      req,
      res,
      pageHtml(
        ogTags({
          title: LONG_TITLE,
          description: LONG_DESCRIPTION,
          siteName: "Link Preview Fixture",
        }),
        `<main><p>超长字段页面。</p></main>`,
      ),
    );
    return;
  }
  if (pathname === "/meta-refresh") {
    html(
      req,
      res,
      pageHtml(
        `<title>不应跟随 meta refresh</title><meta http-equiv="refresh" content="0; url=${origin}/og-full">`,
        `<main><p>meta refresh fixture</p></main>`,
      ),
    );
    return;
  }
  if (pathname === "/count") {
    html(req, res, pageHtml(`<title>计数器页面</title>`, `<main><p>count fixture</p></main>`));
    return;
  }

  // delayed pages — HEAD and GET both wait, so the pending placeholder has a
  // stable observation window and job claim order is observable per origin.
  const delayMatch = /^\/(delay-(\d+)s)(\/|$)/.exec(pathname);
  if (delayMatch) {
    const ms = Math.min(Number(delayMatch[2]) * 1000, 30_000);
    const body = pageHtml(
      ogTags({
        title: `延迟 ${delayMatch[2]}s 页面标题`,
        description: `延迟 ${delayMatch[2]}s 页面描述。`,
        siteName: "Link Preview Fixture",
        image: `${origin}/cover.png`,
        width: 1200,
        height: 630,
      }),
      `<main><p>delayed fixture</p></main>`,
    );
    const buffer = Buffer.from(body);
    const timer = setTimeout(() => {
      send(req, res, 200, { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*", "content-length": String(buffer.length) }, buffer);
    }, ms);
    req.on("close", () => clearTimeout(timer));
    return;
  }
  if (pathname === "/slow-ok") {
    const body = pageHtml(
      ogTags({
        title: "慢但成功的页面",
        description: "HEAD 立即返回；GET 正文延迟 2 秒，用于重启续跑（A13）。",
        siteName: "Link Preview Fixture",
      }),
      `<main><p>slow-ok fixture</p></main>`,
    );
    const buffer = Buffer.from(body);
    if (req.method === "HEAD") {
      send(req, res, 200, { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*", "content-length": String(buffer.length) }, "");
      return;
    }
    // Headers first, body after 2s: keeps every socket idle window < 3s while
    // leaving a deterministic "kill mid-flight" window for A13.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(buffer.length),
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    const timer = setTimeout(() => {
      if (!res.writableEnded) res.end(buffer);
    }, 2_000);
    req.on("close", () => clearTimeout(timer));
    return;
  }
  if (pathname === "/slow") {
    if (req.method === "HEAD") {
      send(req, res, 200, { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" }, "");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    let tick = 0;
    const timer = setInterval(() => {
      if (res.writableEnded) return;
      res.write(`<!-- drip ${(tick += 1)} -->\n`);
    }, 500);
    req.on("close", () => clearInterval(timer));
    return;
  }
  if (pathname === "/huge") {
    send(
      req,
      res,
      200,
      { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*", "content-length": String(HUGE_BYTES.length) },
      HUGE_BYTES,
    );
    return;
  }
  if (pathname === "/head-405") {
    if (req.method === "HEAD") {
      send(req, res, 405, { allow: "GET", "content-type": "text/html; charset=utf-8" }, "");
      return;
    }
    html(
      req,
      res,
      pageHtml(
        ogTags({
          title: "HEAD 405 回退标题",
          description: "HEAD 返回 405，必须回退 GET 才能拿到元数据。",
          siteName: "Link Preview Fixture",
        }),
        `<main><p>head-405 fixture</p></main>`,
      ),
    );
    return;
  }
  if (pathname === "/404") {
    send(
      req,
      res,
      404,
      { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" },
      pageHtml(`<title>404 fixture</title>`, `<main><p>not found fixture</p></main>`),
    );
    return;
  }

  // redirects
  if (pathname === "/redirect-one") {
    send(req, res, 302, { location: `${origin}/og-no-cover`, "content-type": "text/plain" }, "redirect-one");
    return;
  }
  if (pathname === "/redirect-chain") {
    send(req, res, 302, { location: `${origin}/redirect-chain-2`, "content-type": "text/plain" }, "hop1");
    return;
  }
  if (pathname === "/redirect-chain-2") {
    send(req, res, 302, { location: "/redirect-chain-3", "content-type": "text/plain" }, "hop2");
    return;
  }
  if (pathname === "/redirect-chain-3") {
    send(req, res, 302, { location: `${origin}/og-full`, "content-type": "text/plain" }, "hop3");
    return;
  }
  if (pathname === "/redirect-private") {
    const target = `${privateOrigin}/secret`;
    log(`/redirect-private -> ${target}`);
    send(req, res, 302, { location: target, "content-type": "text/plain" }, "redirect-private");
    return;
  }
  if (pathname === "/redirect-loop") {
    send(req, res, 302, { location: `${origin}/redirect-loop-b`, "content-type": "text/plain" }, "loop-a");
    return;
  }
  if (pathname === "/redirect-loop-b") {
    send(req, res, 302, { location: `${origin}/redirect-loop`, "content-type": "text/plain" }, "loop-b");
    return;
  }

  // resources
  if (pathname === "/favicon.png") {
    media(req, res, "image/png", FAVICON_PNG);
    return;
  }
  if (pathname === "/cover.png") {
    media(req, res, "image/png", COVER_PNG);
    return;
  }
  if (pathname === "/cover.svg") {
    media(req, res, "image/svg+xml", SVG_COVER);
    return;
  }
  if (pathname === "/img.png") {
    media(req, res, "image/png", IMG_SMALL_PNG);
    return;
  }
  if (pathname === "/img-large.png") {
    media(req, res, "image/png", IMG_LARGE_PNG);
    return;
  }
  if (pathname === "/video.mp4") {
    media(req, res, "video/mp4", MP4_BYTES);
    return;
  }
  if (pathname === "/audio.mp3") {
    media(req, res, "audio/mpeg", MP3_BYTES);
    return;
  }
  if (pathname === "/doc.pdf") {
    media(req, res, "application/pdf", PDF_BYTES);
    return;
  }
  if (pathname === "/doc.docx") {
    media(req, res, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", DOCX_BYTES);
    return;
  }
  if (pathname === "/unknown.bin") {
    media(req, res, "application/octet-stream", UNKNOWN_BYTES);
    return;
  }

  send(
    req,
    res,
    404,
    { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" },
    pageHtml(`<title>404</title>`, `<main><p>no fixture route for ${pathname}</p></main>`),
  );
}

function handlePrivate(req, res) {
  const url = new URL(req.url ?? "/", "http://fixture.invalid");
  const pathname = url.pathname;
  record(state.private, req, pathname);
  if (pathname === "/__health") {
    send(req, res, 200, { "content-type": "application/json" }, JSON.stringify({ ok: true }));
    return;
  }
  if (pathname === "/__stats") {
    send(req, res, 200, { "content-type": "application/json" }, JSON.stringify(statsPayload()));
    return;
  }
  send(
    req,
    res,
    200,
    { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    pageHtml(`<title>PRIVATE-ONLY</title>`, `<main><p>This second loopback origin must never be fetched.</p></main>`),
  );
}

// ── self-test ────────────────────────────────────────────────────────────────
async function selfTest(base, privateUrl) {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: Boolean(ok), detail });
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
  };
  const get = (path, init) => fetch(new URL(path, base), { redirect: "manual", ...init });

  let res = await get("/__health");
  check("__health 200", res.status === 200);

  res = await get("/og-full");
  let text = await res.text();
  check(
    "/og-full 200 + OG 全字段",
    res.status === 200 &&
      text.includes('property="og:title"') &&
      text.includes('property="og:image"') &&
      text.includes('property="og:image:width" content="1200"') &&
      text.includes(`${base}/cover.png`),
  );

  res = await get("/og-no-cover");
  text = await res.text();
  check("/og-no-cover 无 og:image", res.status === 200 && !text.includes("og:image"));

  res = await get("/twitter");
  text = await res.text();
  check("/twitter 只有 Twitter Card", text.includes("twitter:title") && !text.includes("og:title"));

  res = await get("/plain");
  text = await res.text();
  check("/plain 只有 title/meta", res.status === 200 && text.includes("仅标题页面"));

  res = await get("/no-ct");
  check("/no-ct 无 Content-Type", res.status === 200 && res.headers.get("content-type") === null);

  res = await get("/gbk");
  const gbk = Buffer.from(await res.arrayBuffer());
  check(
    "/gbk charset=gbk + GBK 字节",
    String(res.headers.get("content-type")).includes("charset=gbk") &&
      gbk.includes(Buffer.from("b1e0c2ebb1eacce2", "hex")),
  );

  res = await get("/article");
  text = await res.text();
  check("/article 首段标记在首个 <p>", res.status === 200 && text.includes(ARTICLE_FIRST_PARAGRAPH.slice(0, 24)));

  res = await get("/svg-cover");
  text = await res.text();
  check("/svg-cover 指向 cover.svg", text.includes(`${base}/cover.svg`));

  res = await get("/long-title");
  text = await res.text();
  check("/long-title 超长元数据", text.includes(LONG_TITLE) && text.includes('content="' + LONG_TITLE + '"'));

  res = await get("/head-405", { method: "HEAD" });
  check("HEAD /head-405 = 405", res.status === 405);
  res = await get("/head-405");
  check("GET /head-405 = 200", res.status === 200);

  res = await get("/huge", { method: "HEAD" });
  check(
    "HEAD /huge Content-Length 5MiB",
    res.status === 200 && res.headers.get("content-length") === String(HUGE_BYTES.length),
  );

  res = await get("/img.png", { headers: { range: "bytes=0-7" } });
  check(
    "/img.png Range 206",
    res.status === 206 && res.headers.get("content-range")?.startsWith("bytes 0-7/"),
    res.headers.get("content-range") ?? "",
  );

  for (const [path, type] of [
    ["/video.mp4", "video/mp4"],
    ["/audio.mp3", "audio/mpeg"],
    ["/doc.pdf", "application/pdf"],
    ["/unknown.bin", "application/octet-stream"],
  ]) {
    res = await get(path);
    check(`${path} Content-Type ${type}`, res.status === 200 && (res.headers.get("content-type") ?? "").includes(type));
  }

  res = await get("/redirect-one");
  check("/redirect-one 302", res.status === 302 && (res.headers.get("location") ?? "").includes("/og-no-cover"));
  res = await get("/redirect-chain");
  check("/redirect-chain 302", res.status === 302);
  res = await get("/redirect-chain-2");
  check("/redirect-chain-2 302 相对 Location", res.status === 302 && res.headers.get("location") === "/redirect-chain-3");
  res = await get("/redirect-private");
  check(
    "/redirect-private 指向未放行第二 origin",
    res.status === 302 && res.headers.get("location") === `${privateUrl}/secret`,
    res.headers.get("location") ?? "",
  );
  res = await get("/redirect-loop");
  check("/redirect-loop 302", res.status === 302);

  res = await get("/404");
  check("/404 = 404", res.status === 404);

  const delayStart = Date.now();
  res = await get("/delay-1s", { method: "HEAD" });
  check("/delay-1s HEAD 200", res.status === 200);
  check("/delay-1s HEAD 有延迟", Date.now() - delayStart >= 900);

  res = await get("/__fixtures");
  const fixtures = await res.json();
  check(
    "__fixtures 四链接帖子恰有 4 个 http URL",
    (fixtures.posts.fourLinks.match(/https?:\/\//g) ?? []).length === 4,
  );

  // stats: content requests were recorded; control requests are not.
  res = await get("/__stats");
  const stats = await res.json();
  check(
    "__stats 记录主 origin 请求",
    stats.main.requests > 0 && Boolean(stats.main.paths["/og-full"]) && stats.private.requests === 0,
    `main=${stats.main.requests} private=${stats.private.requests}`,
  );
  check(
    "__stats 记录 UA/方法",
    (stats.main.paths["/og-full"]?.GET ?? 0) >= 1 && (stats.main.paths["/og-full"]?.uas ?? []).length >= 1,
  );

  res = await get("/__reset", { method: "POST" });
  check("__reset 200", res.status === 200);
  res = await get("/__stats");
  const cleared = await res.json();
  check("__reset 后计数归零", cleared.main.requests === 0 && cleared.private.requests === 0);

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} fixture checks passed\n`);
  return failed.length === 0;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const mainServer = createServer((req, res) => {
    try {
      handleMain(req, res);
    } catch (error) {
      log("main handler error", error?.stack ?? error);
      if (!res.headersSent) send(req, res, 500, { "content-type": "text/plain" }, "fixture error");
      else res.destroy();
    }
  });
  const privateServer = createServer((req, res) => {
    try {
      handlePrivate(req, res);
    } catch (error) {
      log("private handler error", error?.stack ?? error);
      if (!res.headersSent) send(req, res, 500, { "content-type": "text/plain" }, "fixture error");
      else res.destroy();
    }
  });

  const listen = (server, port) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, HOST, () => resolve(server.address()));
    });

  const mainAddr = await listen(mainServer, PORT);
  let privateAddr;
  try {
    privateAddr = await listen(privateServer, PRIVATE_PORT);
  } catch (error) {
    mainServer.close();
    throw error;
  }

  const mainUrl = `http://${HOST}:${mainAddr.port}`;
  const privateUrl = `http://${HOST}:${privateAddr.port}`;
  state.origins = { main: mainUrl, mainPort: mainAddr.port, private: privateUrl, privatePort: privateAddr.port };

  const shutdown = () => {
    log("shutting down");
    mainServer.close();
    privateServer.close();
    setTimeout(() => process.exit(0), 50).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (SELF_TEST) {
    let ok = false;
    try {
      ok = await selfTest(mainUrl, privateUrl);
    } catch (error) {
      log("self-test error", error?.stack ?? error);
    }
    mainServer.close();
    privateServer.close();
    process.exit(ok ? 0 : 1);
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      url: mainUrl,
      port: mainAddr.port,
      privateUrl,
      privatePort: privateAddr.port,
      pid: process.pid,
    }) + "\n",
  );

  // Keep the process alive until a signal arrives.
  await new Promise(() => {});
}

main().catch((error) => {
  log("fatal", error?.stack ?? error);
  process.exit(1);
});

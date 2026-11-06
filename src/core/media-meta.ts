/**
 * 媒体固有尺寸：上传时从文件头解析（零依赖、只读前若干字节）。
 *
 * 目的：前端按 `w/h` 预留媒体占位，避免「图片/视频元数据回来 → 卡片增高 → 下方内容跳动」。
 * 解析失败（不支持的格式/损坏文件）返回 null，前端退回旧行为（加载后自然增高）。
 *
 * 支持：PNG / JPEG / GIF / WebP / MP4(MOV, QuickTime 同容器) / SVG；
 * WebM 暂不解析（返回 null）。
 */
export interface MediaSize {
  w: number;
  h: number;
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}
function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
function ascii(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i += 1) s += String.fromCharCode(b[o + i] ?? 0);
  return s;
}
function ok(w: number, h: number): MediaSize | null {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w <= 0 || h <= 0 || w > 100_000 || h > 100_000) return null;
  return { w: Math.round(w), h: Math.round(h) };
}

function pngSize(b: Uint8Array): MediaSize | null {
  if (b.length < 24) return null;
  if (b[0] !== 0x89 || ascii(b, 1, 3) !== "PNG") return null;
  return ok(u32be(b, 16), u32be(b, 20));
}

function gifSize(b: Uint8Array): MediaSize | null {
  if (b.length < 10 || ascii(b, 0, 3) !== "GIF") return null;
  return ok(u16le(b, 6), u16le(b, 8));
}

function jpegSize(b: Uint8Array): MediaSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = u16be(b, i + 2);
    if (len < 2) break;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return ok(u16be(b, i + 7), u16be(b, i + 5));
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): MediaSize | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const kind = ascii(b, 12, 4);
  if (kind === "VP8X") return ok(1 + u24le(b, 24), 1 + u24le(b, 27));
  if (kind === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return ok(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return null;
}

function svgSize(bytes: Uint8Array): MediaSize | null {
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return null;
  const num = (name: string) => {
    const m = new RegExp(`${name}\\s*=\\s*["']\\s*([0-9.]+)`).exec(tag);
    return m ? Number(m[1]) : null;
  };
  const w = num("width");
  const h = num("height");
  if (w && h) return ok(w, h);
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(tag);
  if (vb) return ok(Number(vb[1]), Number(vb[2]));
  return null;
}

// ── MP4 / MOV（ISO BMFF）────────────────────────────────────────────────────

interface Box {
  type: string;
  start: number; // box start (size field)
  body: number; // first byte after the 8-byte header
  end: number;
}

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > to) break;
      // 64-bit size (rare for our files)
      size = u32be(b, p + 12) + u32be(b, p + 8) * 2 ** 32;
      header = 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < header || p + size > to) break;
    out.push({ type, start: p, body: p + header, end: p + size });
    p += size;
  }
  return out;
}

function mp4Size(b: Uint8Array): MediaSize | null {
  if (b.length < 32) return null;
  const top = boxes(b, 0, b.length);
  const moov = top.find((x) => x.type === "moov");
  if (!moov) return null;
  for (const trak of boxes(b, moov.body, moov.end).filter((x) => x.type === "trak")) {
    const kids = boxes(b, trak.body, trak.end);
    const tkhd = kids.find((x) => x.type === "tkhd");
    if (!tkhd) continue;
    const version = b[tkhd.body]!;
    const wOff = tkhd.body + 4 + (version === 1 ? 84 : 72);
    const hOff = wOff + 4;
    if (hOff + 4 > tkhd.end) continue;
    const w = u32be(b, wOff) / 65536;
    const h = u32be(b, hOff) / 65536;
    const size = ok(w, h);
    if (size) return size;
  }
  return null;
}

/** 从上传字节推断固有尺寸；未知/不支持返回 null。 */
export function readMediaSize(bytes: Uint8Array, ext: string): MediaSize | null {
  const type = ext.toLowerCase();
  try {
    if (type === "png") return pngSize(bytes);
    if (type === "jpg" || type === "jpeg") return jpegSize(bytes);
    if (type === "gif") return gifSize(bytes);
    if (type === "webp") return webpSize(bytes);
    if (type === "svg") return svgSize(bytes);
    if (type === "mp4" || type === "mov" || type === "m4v") return mp4Size(bytes);
    return null;
  } catch {
    return null;
  }
}

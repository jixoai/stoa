import { describe, expect, test } from "bun:test";
import { readMediaSize } from "../src/core/media-meta.ts";

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function u16(n: number): number[] {
  return [(n >>> 8) & 255, n & 255];
}
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

describe("media intrinsic size", () => {
  test("png", () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...u32(13), ...ascii("IHDR"), ...u32(1280), ...u32(720), 8, 6, 0, 0, 0,
    ]);
    expect(readMediaSize(bytes, "png")).toEqual({ w: 1280, h: 720 });
  });

  test("jpeg", () => {
    const app0 = [0xff, 0xe0, ...u16(4), 0x00, 0x00];
    const sof = [0xff, 0xc0, ...u16(11), 8, ...u16(900), ...u16(1440), 3, 1, 1, 0];
    const bytes = new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
    expect(readMediaSize(bytes, "jpg")).toEqual({ w: 1440, h: 900 });
  });

  test("gif", () => {
    const bytes = new Uint8Array([...ascii("GIF89a"), 0x20, 0x03, 0x58, 0x02, 0, 0]);
    expect(readMediaSize(bytes, "gif")).toEqual({ w: 800, h: 600 });
  });

  test("webp vp8x", () => {
    const b = new Array(40).fill(0);
    ascii("RIFF").forEach((v, i) => (b[i] = v));
    ascii("WEBP").forEach((v, i) => (b[8 + i] = v));
    ascii("VP8X").forEach((v, i) => (b[12 + i] = v));
    b[24] = 0xff;
    b[25] = 0x03;
    b[26] = 0x00;
    b[27] = 0xff;
    b[28] = 0x02;
    b[29] = 0x00;
    expect(readMediaSize(new Uint8Array(b), "webp")).toEqual({ w: 1024, h: 768 });
  });

  test("mp4 tkhd (v0, 16.16 fixed)", () => {
    const box = (type: string, body: number[]): number[] => {
      const size = 8 + body.length;
      return [...u32(size), ...ascii(type), ...body];
    };
    const tkhdBody = new Array(4 + 72).fill(0);
    tkhdBody[0] = 0; // version 0
    const fixed = (n: number) => u32(n * 65536);
    fixed(1080).forEach((v, i) => (tkhdBody[4 + 72 + i] = v));
    fixed(1920).forEach((v, i) => (tkhdBody[4 + 76 + i] = v));
    const bytes = new Uint8Array(box("moov", box("trak", box("tkhd", tkhdBody))));
    expect(readMediaSize(bytes, "mp4")).toEqual({ w: 1080, h: 1920 });
  });

  test("unknown / broken → null", () => {
    expect(readMediaSize(new Uint8Array([1, 2, 3]), "png")).toBeNull();
    expect(readMediaSize(new Uint8Array([1, 2, 3]), "webm")).toBeNull();
    expect(readMediaSize(new Uint8Array([1, 2, 3]), "txt")).toBeNull();
  });
});

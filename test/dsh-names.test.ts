/**
 * 姓名池与命名生成器单测（openspec stoa-dsh-session-mode S2-1 / S2-2）。
 *
 * 覆盖：
 * - 池规模与合法性（名 ≥256、姓 ≥128、py/zh 各自唯一、py 小写无音调、长度上限）；
 * - 空占用返回单名（id = py，display = zh）；
 * - 单名全撞 → 姓+名（id = `<surnamePy>-<givenPy>`）；
 * - 单名与姓+名全撞 → 数字后缀（id 以 `-2` 结尾且过 SLUG_RE）；
 * - 连续生成 200 个名字 id/display 全部唯一；
 * - 注入随机源可复现（同一 seed 两次序列一致）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface NameEntry {
  zh: string;
  py: string;
}

interface NamePool {
  given: NameEntry[];
  surnames: NameEntry[];
}

type PickName = (options?: {
  takenIds?: string[] | Set<string>;
  takenDisplays?: string[] | Set<string>;
  random?: () => number;
}) => { id: string; display: string };

/** 板子 `src/core/validation.ts` 的 SLUG_RE（小写 1-32，字母开头）。 */
const SLUG_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const pool = JSON.parse(readFileSync(new URL("../data/names.json", import.meta.url), "utf8")) as NamePool;

// lib/names.js 是无 .d.ts 的纯 ESM；用动态 import 避免 tsc 解析声明文件。
const { pickName } = (await import(new URL("../lib/names.js", import.meta.url).href)) as {
  pickName: PickName;
};

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("data/names.json", () => {
  test("名 ≥256、姓 ≥128，且每项 py/zh 唯一、合法", () => {
    expect(pool.given.length).toBeGreaterThanOrEqual(256);
    expect(pool.surnames.length).toBeGreaterThanOrEqual(128);

    const violations: string[] = [];
    for (const [label, rows] of [
      ["given", pool.given],
      ["surnames", pool.surnames],
    ] as const) {
      const seenPy = new Set<string>();
      const seenZh = new Set<string>();
      for (const entry of rows) {
        const where = `${label}:${entry.zh}/${entry.py}`;
        if (!/^[a-z][a-z0-9]*$/.test(entry.py)) violations.push(`${where} py 非小写无声调拼音`);
        if (entry.py.length > 12) violations.push(`${where} py 超长`);
        if ([...entry.zh].length < 1 || [...entry.zh].length > 2) violations.push(`${where} zh 长度非 1-2 字`);
        if (seenPy.has(entry.py)) violations.push(`${where} py 重复`);
        if (seenZh.has(entry.zh)) violations.push(`${where} zh 重复`);
        seenPy.add(entry.py);
        seenZh.add(entry.zh);
      }
    }
    expect(violations).toEqual([]);
  });

  test("姓+名拼接后的 id 不超过 32 字符", () => {
    const maxGiven = Math.max(...pool.given.map((entry) => entry.py.length));
    const maxSurname = Math.max(...pool.surnames.map((entry) => entry.py.length));
    expect(maxSurname + 1 + maxGiven).toBeLessThanOrEqual(32);
  });
});

describe("pickName", () => {
  test("空占用时返回单名（id=py，display=zh）", () => {
    const { id, display } = pickName();
    const entry = pool.given.find((candidate) => candidate.py === id);
    expect(entry).toBeDefined();
    expect(entry?.zh).toBe(display);
    expect(SLUG_RE.test(id)).toBe(true);
  });

  test("单名撞车时配姓（姓+名）", () => {
    const takenIds = pool.given.map((entry) => entry.py);
    const takenDisplays = pool.given.map((entry) => entry.zh);
    const firstGiven = pool.given[0]!;
    const firstSurname = pool.surnames[0]!;

    // random()=0 固定取两池首项：小满 → 王小满 / wang-xiaoman。
    const { id, display } = pickName({ takenIds, takenDisplays, random: () => 0 });

    expect(id).toBe(`${firstSurname.py}-${firstGiven.py}`);
    expect(display).toBe(`${firstSurname.zh}${firstGiven.zh}`);
    expect(id).toContain("-");
    expect(SLUG_RE.test(id)).toBe(true);
  });

  test("id 或 display 单侧撞车也算撞名", () => {
    const firstGiven = pool.given[0]!;
    const firstSurname = pool.surnames[0]!;
    const expected = { id: `${firstSurname.py}-${firstGiven.py}`, display: `${firstSurname.zh}${firstGiven.zh}` };

    const byId = pickName({
      takenIds: pool.given.map((entry) => entry.py),
      random: () => 0,
    });
    const byDisplay = pickName({
      takenDisplays: pool.given.map((entry) => entry.zh),
      random: () => 0,
    });

    expect(byId).toEqual(expected);
    expect(byDisplay).toEqual(expected);
  });

  test("单名与全部姓+名组合都撞时追加数字后缀", () => {
    const takenIds = new Set<string>(pool.given.map((entry) => entry.py));
    const takenDisplays = new Set<string>(pool.given.map((entry) => entry.zh));
    for (const surname of pool.surnames) {
      for (const given of pool.given) {
        takenIds.add(`${surname.py}-${given.py}`);
        takenDisplays.add(`${surname.zh}${given.zh}`);
      }
    }
    const firstGiven = pool.given[0]!;
    const firstSurname = pool.surnames[0]!;

    const { id, display } = pickName({ takenIds, takenDisplays, random: () => 0 });

    expect(id).toBe(`${firstSurname.py}-${firstGiven.py}-2`);
    expect(display).toBe(`${firstSurname.zh}${firstGiven.zh}`);
    expect(id.endsWith("-2")).toBe(true);
    expect(SLUG_RE.test(id)).toBe(true);
  });

  test("连续生成 200 个名字全部唯一且合法", () => {
    const ids = new Set<string>();
    const displays = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const { id, display } = pickName({ takenIds: ids, takenDisplays: displays });
      expect(SLUG_RE.test(id)).toBe(true);
      expect(ids.has(id)).toBe(false);
      expect(displays.has(display)).toBe(false);
      ids.add(id);
      displays.add(display);
    }
    expect(ids.size).toBe(200);
    expect(displays.size).toBe(200);
  });

  test("注入随机源可复现（同 seed 两次序列一致）", () => {
    const run = (): string[] => {
      const random = mulberry32(0x5e7a2026);
      const takenIds = new Set<string>(pool.given.map((entry) => entry.py));
      const takenDisplays = new Set<string>(pool.given.map((entry) => entry.zh));
      const out: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        const { id, display } = pickName({ takenIds, takenDisplays, random });
        out.push(`${id}|${display}`);
        takenIds.add(id);
        takenDisplays.add(display);
      }
      return out;
    };

    expect(run()).toEqual(run());
  });
});

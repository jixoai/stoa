/**
 * ep 历史与健康探测单测（openspec change report-instance-page P1-1）。
 *
 * 锁住：旧 `string[]` 历史零迁移可读、新 `{url,lastUsedAt}` 格式、置顶/去重/上限 8、
 * forget/clear，以及 `/healthz` 的在线判定与可读错误（不读响应体、不打印凭据）。
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  EP_HISTORY_KEY,
  checkEp,
  clearEpHistory,
  forgetEp,
  loadEpHistory,
  loadEpHistoryEntries,
  probeEpHealth,
  rememberEp,
} from "../src/ui/lib/ep.ts";

class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

const storage = new MemoryStorage();
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

const originalFetch = globalThis.fetch;

beforeEach(() => {
  storage.clear();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

function historyRaw(value: unknown): string {
  storage.setItem(EP_HISTORY_KEY, JSON.stringify(value));
  return EP_HISTORY_KEY;
}

describe("ep history", () => {
  test("旧 string[] 格式可读，时间未知", () => {
    historyRaw(["https://a.example.com/", "http://127.0.0.1:13680", "https://a.example.com/?x=1"]);
    const entries = loadEpHistoryEntries();
    expect(entries.map((entry) => entry.url)).toEqual([
      "https://a.example.com",
      "http://127.0.0.1:13680",
    ]);
    expect(entries.every((entry) => entry.lastUsedAt === 0)).toBe(true);
    expect(loadEpHistory()).toEqual(["https://a.example.com", "http://127.0.0.1:13680"]);
  });

  test("新格式保留 lastUsedAt，并按存储顺序返回", () => {
    historyRaw([
      { url: "https://new.example.com", lastUsedAt: 1_700_000_000_000 },
      { url: "https://old.example.com", lastUsedAt: 1_600_000_000_000 },
    ]);
    const entries = loadEpHistoryEntries();
    expect(entries[0]).toEqual({ url: "https://new.example.com", lastUsedAt: 1_700_000_000_000 });
    expect(entries[1]).toEqual({ url: "https://old.example.com", lastUsedAt: 1_600_000_000_000 });
  });

  test("混合格式、去重、非法项过滤、上限 8", () => {
    historyRaw([
      "https://a.example.com",
      { url: "https://a.example.com", lastUsedAt: 9 },
      { url: "https://b.example.com", lastUsedAt: 8 },
      { url: "http://192.168.1.10:13610" },
      ...Array.from({ length: 10 }, (_, index) => `https://n${index}.example.com`),
    ]);
    const entries = loadEpHistoryEntries();
    expect(entries.length).toBe(8);
    expect(entries[0]).toEqual({ url: "https://a.example.com", lastUsedAt: 0 });
    expect(entries[1]?.url).toBe("https://b.example.com");
    expect(entries.some((entry) => entry.url.includes("192.168.1.10"))).toBe(false);
    expect(new Set(entries.map((entry) => entry.url)).size).toBe(entries.length);
  });

  test("rememberEp 置顶并刷新时间，forgetEp / clearEpHistory 同步", () => {
    rememberEp("https://a.example.com");
    const first = loadEpHistoryEntries()[0]!;
    expect(first.url).toBe("https://a.example.com");
    expect(first.lastUsedAt).toBeGreaterThan(0);

    rememberEp("https://b.example.com");
    expect(loadEpHistory().slice(0, 2)).toEqual([
      "https://b.example.com",
      "https://a.example.com",
    ]);

    const before = loadEpHistoryEntries().find((entry) => entry.url === "https://a.example.com")!;
    rememberEp("https://a.example.com");
    const after = loadEpHistoryEntries()[0]!;
    expect(after.url).toBe("https://a.example.com");
    expect(after.lastUsedAt).toBeGreaterThanOrEqual(before.lastUsedAt);

    forgetEp("https://a.example.com");
    expect(loadEpHistory()).toEqual(["https://b.example.com"]);

    clearEpHistory();
    expect(loadEpHistoryEntries()).toEqual([]);
    expect(storage.getItem(EP_HISTORY_KEY)).toBeNull();
  });
});

describe("probeEpHealth", () => {
  test("report 协议 → online，请求带超时且不带凭据", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(
        JSON.stringify({ ok: true, instanceId: "inst-1", version: "0.1.0", protocol: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await probeEpHealth("https://a.example.com/");
    expect(result).toEqual({ ok: true, instanceId: "inst-1", version: "0.1.0" });
    expect(seenUrl).toBe("https://a.example.com/healthz");
    expect(seenInit?.credentials).toBe("omit");
    expect(seenInit?.cache).toBe("no-store");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test("非 report 协议 → 离线且文案可读", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await probeEpHealth("https://a.example.com");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("不是 report 实例");
  });

  test("HTTP 错误 → 离线并带状态码", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    const result = await probeEpHealth("https://a.example.com");
    expect(result).toEqual({ ok: false, error: "目标 /healthz 返回 HTTP 502" });
  });

  test("非 JSON → 离线", async () => {
    globalThis.fetch = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    const result = await probeEpHealth("https://a.example.com");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("不是 JSON");
  });

  test("超时 → 离线且不悬挂", async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const result = await probeEpHealth("https://a.example.com", 1000);
    expect(result).toEqual({ ok: false, error: "连接超时（1 秒内没有响应）" });
  });

  test("网络错误 → 离线", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const result = await probeEpHealth("https://a.example.com");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("无法访问该地址");
  });

  test("非法 ep 不发请求", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await probeEpHealth("http://192.168.1.10:13610");
    expect(result.ok).toBe(false);
    expect(result.error).toBe(checkEp("http://192.168.1.10:13610").error!);
    expect(called).toBe(0);
  });
});

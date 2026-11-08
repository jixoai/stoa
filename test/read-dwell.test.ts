/**
 * report-read-dwell 纯逻辑单测（P1-1/P1-2/P1-3 的可测部分）。
 *
 * 不挂 React：阈值公式、覆盖率（含高卡）、停留状态机（暂停/恢复/去重/卸载）、
 * per-id 订阅与 2000/LRU 持久化全部在这里验证。假 IO + 假时钟，零真实定时器。
 */
import { describe, expect, test } from "bun:test";
import {
  DWELL_MAX_MS,
  DWELL_MIN_MS,
  MEDIA_EXTRA_MS,
  coverageOf,
  dwellThresholdMs,
} from "../src/ui/lib/dwell-threshold.ts";
import {
  ReadDwellEngine,
  type DwellEntryLike,
  type DwellDocumentLike,
  type ObserverLike,
} from "../src/ui/state/read-dwell.ts";
import {
  READ_SET_LIMIT,
  ReadSetStore,
  parseReadSet,
  readSetStorageKey,
  type ReadSetStorage,
} from "../src/ui/state/read-set-store.ts";

// ── helpers ─────────────────────────────────────────────────────────────────

class FakeClock {
  time = 0;
  private timers: Array<{ id: number; at: number; callback: () => void }> = [];
  private nextId = 1;

  now = (): number => this.time;

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.time + Math.max(0, ms), callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };

  activeTimers(): number {
    return this.timers.length;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.time = due.at;
      due.callback();
    }
    this.time = target;
  }
}

class FakeObserver implements ObserverLike {
  targets = new Set<Element>();
  disconnects = 0;
  constructor(private readonly callback: (entries: DwellEntryLike[]) => void) {}
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    this.disconnects += 1;
  }
  emit(entries: DwellEntryLike[]): void {
    this.callback(entries);
  }
}

interface FakeRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
  width: number;
}

function makeEl(rect: FakeRect): HTMLElement & { dataset: Record<string, string | undefined> } {
  const dataset: Record<string, string | undefined> = {};
  return {
    dataset,
    getBoundingClientRect: () => ({ ...rect }),
  } as unknown as HTMLElement & { dataset: Record<string, string | undefined> };
}

function entryFor(
  el: Element,
  rect: FakeRect,
  options: { ratio?: number; visibleHeight?: number; rootHeight?: number | null } = {},
): DwellEntryLike {
  const ratio = options.ratio ?? 1;
  return {
    target: el,
    intersectionRatio: ratio,
    intersectionRect: { height: options.visibleHeight ?? rect.height * ratio },
    boundingClientRect: { height: rect.height },
    rootBounds: options.rootHeight === null ? null : { height: options.rootHeight ?? 800 },
  };
}

class FakeDocument implements DwellDocumentLike {
  visibilityState: DocumentVisibilityState = "visible";
  private listeners = new Set<() => void>();
  querySelectorResult: Element | null = null;
  body: Node | null = null;
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: () => void): void {
    this.listeners.delete(listener);
  }
  querySelector(): Element | null {
    return this.querySelectorResult;
  }
  emitVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    for (const listener of [...this.listeners]) listener();
  }
  listenerCount(): number {
    return this.listeners.size;
  }
}

function makeEngine(options: {
  clock: FakeClock;
  observer: FakeObserver;
  doc?: FakeDocument;
  readSet?: Set<string>;
  marks?: string[];
  selfId?: string | null;
  viewportHeight?: number;
  viewportWidth?: number;
}) {
  const readSet = options.readSet ?? new Set<string>();
  const marks = options.marks ?? [];
  const engine = new ReadDwellEngine({
    markPostRead: (postId) => {
      marks.push(postId);
      readSet.add(postId);
    },
    isRead: (postId) => readSet.has(postId),
    getSelfId: () => options.selfId ?? null,
    document: options.doc ?? new FakeDocument(),
    viewportHeight: () => options.viewportHeight ?? 800,
    viewportWidth: () => options.viewportWidth ?? 400,
    now: options.clock.now,
    setTimeout: options.clock.setTimeout,
    clearTimeout: options.clock.clearTimeout,
    createObserver: (callback) => {
      const observer = options.observer;
      (observer as unknown as { callback: (entries: DwellEntryLike[]) => void }).callback = callback;
      return observer;
    },
    observeModals: false,
  });
  return { engine, readSet, marks };
}

const STANDARD_RECT: FakeRect = { top: 0, bottom: 100, left: 0, right: 400, height: 100, width: 400 };

// ── P1-1 阈值与覆盖率 ──────────────────────────────────────────────────────

describe("dwellThresholdMs", () => {
  test("clamps to the 400ms floor for short/empty bodies", () => {
    expect(DWELL_MIN_MS).toBe(400);
    expect(dwellThresholdMs({ bodyMd: "", hasMedia: false })).toBe(400);
    expect(dwellThresholdMs({ bodyMd: "你好呀", hasMedia: false })).toBe(400);
    expect(dwellThresholdMs({ bodyMd: "12345678", hasMedia: true })).toBe(400); // 100 + 300 边界
  });

  test("uses code points / 80 chars per second for mid-length bodies", () => {
    expect(dwellThresholdMs({ bodyMd: "x".repeat(80), hasMedia: false })).toBe(1000);
    expect(dwellThresholdMs({ bodyMd: "x".repeat(96), hasMedia: false })).toBe(1200);
    expect(dwellThresholdMs({ bodyMd: "😀".repeat(80), hasMedia: false })).toBe(1000);
  });

  test("adds 300ms for media before clamping", () => {
    expect(dwellThresholdMs({ bodyMd: "x".repeat(100), hasMedia: false })).toBe(1250);
    expect(dwellThresholdMs({ bodyMd: "x".repeat(100), hasMedia: true })).toBe(1500);
    expect(MEDIA_EXTRA_MS).toBe(300);
  });

  test("clamps long bodies to 1500ms exactly", () => {
    expect(DWELL_MAX_MS).toBe(1500);
    expect(dwellThresholdMs({ bodyMd: "x".repeat(200), hasMedia: false })).toBe(1500);
    expect(dwellThresholdMs({ bodyMd: "x".repeat(120), hasMedia: true })).toBe(1500);
  });
});

describe("coverageOf", () => {
  test("normal cards use intersectionRatio", () => {
    const el = makeEl(STANDARD_RECT);
    expect(coverageOf(entryFor(el, STANDARD_RECT, { ratio: 0.49 }), 800)).toBeCloseTo(0.49);
    expect(coverageOf(entryFor(el, STANDARD_RECT, { ratio: 0.5 }), 800)).toBe(0.5);
  });

  test("tall cards use visible height / viewport height (Owner D10)", () => {
    const tall = { top: -300, bottom: 2500, left: 0, right: 400, height: 2800, width: 400 };
    const el = makeEl(tall);
    // >2 屏的长帖只露出 50% 视口高 → 达标
    expect(coverageOf(entryFor(el, tall, { visibleHeight: 400 }), 800)).toBe(0.5);
    // 只露 40% → 不达标
    expect(coverageOf(entryFor(el, tall, { visibleHeight: 320 }), 800)).toBeCloseTo(0.4);
  });

  test("rootBounds=null falls back to the provided viewport height", () => {
    const el = makeEl(STANDARD_RECT);
    expect(coverageOf(entryFor(el, STANDARD_RECT, { ratio: 0.75, rootHeight: null }), 800)).toBe(0.75);
  });

  test("zero/unknown viewport yields 0", () => {
    const el = makeEl(STANDARD_RECT);
    expect(coverageOf(entryFor(el, STANDARD_RECT, { rootHeight: 0 }), 800)).toBe(0);
    expect(coverageOf(entryFor(el, STANDARD_RECT, { rootHeight: 0 }), 0)).toBe(0);
  });
});

// ── P1-2 引擎状态机 ────────────────────────────────────────────────────────

describe("ReadDwellEngine", () => {
  test("enters dwell, fires at threshold, writes exactly once and stops observing", () => {
    const clock = new FakeClock();
    const observer = new FakeObserver(() => {});
    const { engine, readSet, marks } = makeEngine({ clock, observer });
    const el = makeEl(STANDARD_RECT);
    engine.observe(el, {
      postId: "p1",
      author: "alice",
      seq: 10,
      bodyMd: "short",
      hasMedia: false,
    });
    expect(el.dataset.dwellState).toBe("idle");
    expect(observer.targets.size).toBe(1);
    expect(engine.hasObserver()).toBe(true);

    observer.emit([entryFor(el, STANDARD_RECT, { ratio: 1 })]);
    expect(el.dataset.dwellState).toBe("dwell");
    expect(engine.stats().timers).toBe(1);

    clock.advance(399);
    expect(marks).toEqual([]);
    expect(el.dataset.read).toBeUndefined();

    clock.advance(1);
    expect(marks).toEqual(["p1"]);
    expect(readSet.has("p1")).toBe(true);
    expect(el.dataset.read).toBe("1");
    expect(el.dataset.dwellState).toBe("read");
    expect(engine.trackedCount()).toBe(0);
    expect(observer.disconnects).toBe(1);
    expect(engine.stats().observers).toBe(0);
  });

  test("scroll-out pauses and keeps accumulated time; return resumes the remainder", () => {
    const clock = new FakeClock();
    const observer = new FakeObserver(() => {});
    const { engine, marks } = makeEngine({ clock, observer });
    const el = makeEl(STANDARD_RECT);
    engine.observe(el, { postId: "p2", author: "a", seq: 1, bodyMd: "", hasMedia: false });
    observer.emit([entryFor(el, STANDARD_RECT, { ratio: 1 })]);
    clock.advance(200);
    expect(el.dataset.dwellState).toBe("dwell");

    observer.emit([entryFor(el, STANDARD_RECT, { ratio: 0.2, visibleHeight: 20 })]);
    expect(el.dataset.dwellState).toBe("paused");
    expect(engine.stats().timers).toBe(0);

    clock.advance(5000);
    expect(marks).toEqual([]);

    observer.emit([entryFor(el, STANDARD_RECT, { ratio: 1 })]);
    expect(el.dataset.dwellState).toBe("dwell");
    clock.advance(199);
    expect(marks).toEqual([]);
    clock.advance(1);
    expect(marks).toEqual(["p2"]);
  });

  test("visibilitychange hidden pauses; visible resumes and can complete", () => {
    const clock = new FakeClock();
    const observer = new FakeObserver(() => {});
    const doc = new FakeDocument();
    const { engine, marks } = makeEngine({ clock, observer, doc });
    const el = makeEl(STANDARD_RECT);
    engine.observe(el, { postId: "p3", author: "a", seq: 1, bodyMd: "", hasMedia: false });
    observer.emit([entryFor(el, STANDARD_RECT, { ratio: 1 })]);
    clock.advance(200);

    doc.emitVisibility("hidden");
    expect(el.dataset.dwellState).toBe("paused");
    clock.advance(2000);
    expect(marks).toEqual([]);

    doc.emitVisibility("visible");
    expect(el.dataset.dwellState).toBe("dwell");
    clock.advance(200);
    expect(marks).toEqual(["p3"]);
  });

  test("scoped hold pauses only targets outside the overlay scope", () => {
    const clock = new FakeClock();
    const observer = new FakeObserver(() => {});
    const { engine, marks } = makeEngine({ clock, observer });
    const rootCard = makeEl(STANDARD_RECT);
    const detailCard = makeEl({ ...STANDARD_RECT, top: 120, bottom: 220 });
    engine.observe(rootCard, { postId: "root", author: "a", seq: 1, bodyMd: "", hasMedia: false });
    engine.observe(detailCard, { postId: "detail", author: "a", seq: 2, bodyMd: "", hasMedia: false });
    observer.emit([
      entryFor(rootCard, STANDARD_RECT, { ratio: 1 }),
      entryFor(detailCard, { ...STANDARD_RECT, top: 120, bottom: 220 }, { ratio: 1 }),
    ]);
    clock.advance(100);

    const scope = { contains: (node: unknown) => node === detailCard } as unknown as Element;
    engine.hold("route-detail", scope);
    expect(rootCard.dataset.dwellState).toBe("paused");
    expect(detailCard.dataset.dwellState).toBe("dwell");

    clock.advance(400);
    expect(marks).toEqual(["detail"]);
    // 底层卡在覆盖期间不计时；关闭覆盖层后从累计 100ms 继续。
    engine.release("route-detail");
    expect(rootCard.dataset.dwellState).toBe("dwell");
    clock.advance(299);
    expect(marks).toEqual(["detail"]);
    clock.advance(1);
    expect(marks).toEqual(["detail", "root"]);
  });

  test("re-observing a read card keeps data-dwell-state=read (fade animation survives)", () => {
    const clock = new FakeClock();
    const observer = new FakeObserver(() => {});
    const { engine, marks } = makeEngine({ clock, observer });
    const el = makeEl(STANDARD_RECT);
    const target = { postId: "read-again", author: "a", seq: 1, bodyMd: "", hasMedia: false };
    engine.observe(el, target);
    observer.emit([entryFor(el, STANDARD_RECT, { ratio: 1 })]);
    clock.advance(400);
    expect(marks).toEqual(["read-again"]);
    expect(el.dataset.dwellState).toBe("read");

    // 0→1 后的 effect 重注册（同元素）不得把 read 降级为 skipped。
    engine.observe(el, target);
    expect(el.dataset.dwellState).toBe("read");
    expect(engine.trackedCount()).toBe(0);
  });

  test("LRU-evicted post can be written again after remount (no permanent written gate)", () => {
    const clock = new FakeClock();
    const observer = new FakeObserver(() => {});
    const readSet = new Set<string>();
    const { engine, marks } = makeEngine({ clock, observer, readSet });
    const target = { postId: "evicted", author: "a", seq: 1, bodyMd: "", hasMedia: false };

    const first = makeEl(STANDARD_RECT);
    engine.observe(first, target);
    observer.emit([entryFor(first, STANDARD_RECT, { ratio: 1 })]);
    clock.advance(400);
    expect(marks).toEqual(["evicted"]);

    // 模拟 LRU 淘汰 + 重新挂载：read-set 不再命中，应能再次写回。
    readSet.delete("evicted");
    const second = makeEl(STANDARD_RECT);
    engine.observe(second, target);
    observer.emit([entryFor(second, STANDARD_RECT, { ratio: 1 })]);
    clock.advance(400);
    expect(marks).toEqual(["evicted", "evicted"]);
    expect(second.dataset.read).toBe("1");
  });

  test("hold() pauses and release() resumes (modal overlay)", () => {
    const clock = new FakeClock();
    const observer = new FakeObserver(() => {});
    const { engine, marks } = makeEngine({ clock, observer });
    const el = makeEl(STANDARD_RECT);
    engine.observe(el, { postId: "p4", author: "a", seq: 1, bodyMd: "", hasMedia: false });
    observer.emit([entryFor(el, STANDARD_RECT, { ratio: 1 })]);
    clock.advance(100);

    engine.hold("modal");
    expect(el.dataset.dwellState).toBe("paused");
    clock.advance(3000);
    expect(marks).toEqual([]);

    engine.release("modal");
    expect(el.dataset.dwellState).toBe("dwell");
    clock.advance(300);
    expect(marks).toEqual(["p4"]);
  });

  test("two instances of the same post write only once", () => {
    const clock = new FakeClock();
    const observer = new FakeObserver(() => {});
    const { engine, marks } = makeEngine({ clock, observer });
    const first = makeEl(STANDARD_RECT);
    const second = makeEl({ ...STANDARD_RECT, top: 120, bottom: 220 });
    engine.observe(first, { postId: "dup", author: "a", seq: 1, bodyMd: "", hasMedia: false });
    engine.observe(second, { postId: "dup", author: "a", seq: 1, bodyMd: "", hasMedia: false });
    observer.emit([
      entryFor(first, STANDARD_RECT, { ratio: 1 }),
      entryFor(second, { ...STANDARD_RECT, top: 120, bottom: 220 }, { ratio: 1 }),
    ]);
    clock.advance(400);
    expect(marks).toEqual(["dup"]);
    expect(second.dataset.read).toBe("1");
    expect(engine.trackedCount()).toBe(0);
  });

  test("unobserve clears the timer, drops progress and disconnects the empty observer", () => {
    const clock = new FakeClock();
    const observer = new FakeObserver(() => {});
    const { engine, marks } = makeEngine({ clock, observer });
    const el = makeEl(STANDARD_RECT);
    engine.observe(el, { postId: "p5", author: "a", seq: 1, bodyMd: "", hasMedia: false });
    observer.emit([entryFor(el, STANDARD_RECT, { ratio: 1 })]);
    expect(clock.activeTimers()).toBe(1);

    engine.unobserve(el);
    expect(clock.activeTimers()).toBe(0);
    expect(engine.trackedCount()).toBe(0);
    expect(observer.targets.size).toBe(0);
    expect(observer.disconnects).toBe(1);

    clock.advance(5000);
    expect(marks).toEqual([]);
  });

  test("skips own posts, deleted posts and already-read posts", () => {
    const clock = new FakeClock();
    const observer = new FakeObserver(() => {});
    const readSet = new Set(["read-post"]);
    const { engine, marks } = makeEngine({
      clock,
      observer,
      readSet,
      selfId: "me",
    });
    const own = makeEl(STANDARD_RECT);
    const deleted = makeEl(STANDARD_RECT);
    const read = makeEl(STANDARD_RECT);
    engine.observe(own, { postId: "own", author: "me", seq: 1, bodyMd: "", hasMedia: false });
    engine.observe(deleted, {
      postId: "deleted",
      author: "a",
      seq: 2,
      bodyMd: "",
      hasMedia: false,
      deleted: true,
    });
    engine.observe(read, { postId: "read-post", author: "a", seq: 3, bodyMd: "", hasMedia: false });

    expect(own.dataset.dwellState).toBe("skipped");
    expect(deleted.dataset.dwellState).toBe("skipped");
    expect(read.dataset.dwellState).toBe("skipped");
    expect(engine.trackedCount()).toBe(0);
    expect(engine.hasObserver()).toBe(false);
    expect(observer.targets.size).toBe(0);
    clock.advance(5000);
    expect(marks).toEqual([]);
  });

  test("recheck failure at timer time pauses instead of writing", () => {
    const clock = new FakeClock();
    const observer = new FakeObserver(() => {});
    const { engine, marks } = makeEngine({ clock, observer });
    let rect: FakeRect = { ...STANDARD_RECT };
    const el = {
      dataset: {} as Record<string, string | undefined>,
      getBoundingClientRect: () => ({ ...rect }),
    } as unknown as HTMLElement;
    engine.observe(el, { postId: "p6", author: "a", seq: 1, bodyMd: "", hasMedia: false });
    observer.emit([entryFor(el as Element, STANDARD_RECT, { ratio: 1 })]);
    // 到点前滚出视口（DOM 度量变化，但引擎尚未收到 IO 回调）
    rect = { top: 900, bottom: 1000, left: 0, right: 400, height: 100, width: 400 };
    clock.advance(400);
    expect(marks).toEqual([]);
    expect((el as unknown as { dataset: { dwellState?: string } }).dataset.dwellState).toBe("paused");
  });
});

// ── P1-3 读集合 / 订阅 / LRU / 持久化 ──────────────────────────────────────

class FakeStorage implements ReadSetStorage {
  values = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
    this.writes += 1;
  }
}

describe("ReadSetStore", () => {
  test("storage key keeps backend+account isolation and the 2000 cap is pinned", () => {
    expect(READ_SET_LIMIT).toBe(2000);
    expect(readSetStorageKey("http://127.0.0.1:13688", "owner")).toBe(
      "report.read.v1:http://127.0.0.1:13688:owner",
    );
    expect(readSetStorageKey("", "owner")).toBe("report.read.v1:same-origin:owner");
  });

  test("mark notifies only that post's subscribers", () => {
    const clock = new FakeClock();
    const store = new ReadSetStore({ storageKey: null, timers: clock });
    let a = 0;
    let b = 0;
    store.subscribe("A", () => a++);
    store.subscribe("B", () => b++);
    store.mark("A");
    expect(a).toBe(1);
    expect(b).toBe(0);
    expect(store.has("A")).toBe(true);
  });

  test("duplicate mark only touches LRU: no subscriber notification, order moves to newest", () => {
    const clock = new FakeClock();
    const store = new ReadSetStore({ storageKey: null, timers: clock });
    store.mark("A");
    store.mark("B");
    let calls = 0;
    store.subscribe("A", () => calls++);
    const result = store.mark("A");
    expect(result.changed).toBe(false);
    expect(calls).toBe(0);
    expect(store.values()).toEqual(["B", "A"]);
  });

  test("notifyAll reaches every subscription (ack / account switch)", () => {
    const clock = new FakeClock();
    const store = new ReadSetStore({ storageKey: null, timers: clock });
    store.mark("A");
    store.mark("B");
    let a = 0;
    let b = 0;
    store.subscribe("A", () => a++);
    store.subscribe("B", () => b++);
    store.notifyAll();
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test("account switch flushes the old key, loads the new set and notifies all", () => {
    const clock = new FakeClock();
    const storage = new FakeStorage();
    storage.setItem("k1", JSON.stringify(["old"]));
    storage.setItem("k2", JSON.stringify(["new1", "new2"]));
    const store = new ReadSetStore({ storageKey: "k1", storage, timers: clock });
    expect(store.has("old")).toBe(true);
    store.mark("fresh");
    let calls = 0;
    store.subscribe("new1", () => calls++);

    store.switchKey("k2", storage);
    expect(storage.getItem("k1")).toContain("fresh");
    expect(store.has("new1")).toBe(true);
    expect(store.has("old")).toBe(false);
    expect(calls).toBe(1);
  });

  test("10 marks within 250ms persist once (trailing debounce); flush is synchronous", () => {
    const clock = new FakeClock();
    const storage = new FakeStorage();
    const store = new ReadSetStore({
      storageKey: "read",
      storage,
      timers: clock,
      debounceMs: 250,
      onPersist: () => {},
    });
    for (let i = 0; i < 10; i += 1) {
      store.mark(`p${i}`);
      clock.advance(10);
    }
    expect(storage.writes).toBe(0);
    // 最后一次 mark 在 t=90，timer 到期 t=340；当前 t=100。
    clock.advance(239);
    expect(storage.writes).toBe(0);
    clock.advance(1);
    expect(storage.writes).toBe(1);
    expect(JSON.parse(storage.getItem("read")!)).toHaveLength(10);

    store.mark("p10");
    store.flush();
    expect(storage.writes).toBe(2);
    expect(JSON.parse(storage.getItem("read")!)).toContain("p10");
  });

  test("600 consecutive marks keep the earliest 100 (no ghost unread)", () => {
    const clock = new FakeClock();
    const store = new ReadSetStore({ storageKey: null, timers: clock });
    for (let i = 0; i < 600; i += 1) store.mark(`post-${i}`);
    expect(store.size()).toBe(600);
    for (let i = 0; i < 100; i += 1) expect(store.has(`post-${i}`)).toBe(true);
    expect(store.has("post-599")).toBe(true);
  });

  test("2001st mark evicts only the least-recently-read entry and notifies it", () => {
    const clock = new FakeClock();
    const store = new ReadSetStore({ storageKey: null, timers: clock });
    for (let i = 0; i < READ_SET_LIMIT; i += 1) store.mark(`post-${i}`);
    expect(store.size()).toBe(READ_SET_LIMIT);

    let evictedNotifications = 0;
    store.subscribe("post-0", () => evictedNotifications++);
    const result = store.mark("post-2000");
    expect(result.changed).toBe(true);
    expect(result.evicted).toEqual(["post-0"]);
    expect(store.size()).toBe(READ_SET_LIMIT);
    expect(store.has("post-0")).toBe(false);
    expect(store.has("post-1")).toBe(true);
    expect(store.has("post-2000")).toBe(true);
    expect(evictedNotifications).toBe(1);
  });

  test("serialized size stays under 150KB per account at the 2000 cap", () => {
    const clock = new FakeClock();
    const storage = new FakeStorage();
    const store = new ReadSetStore({ storageKey: "read", storage, timers: clock });
    for (let i = 0; i < READ_SET_LIMIT; i += 1) {
      // ULID 形状的真实 id 长度（26 字符）
      store.mark(`01JQ${String(i).padStart(22, "0")}`);
    }
    store.flush();
    const size = storage.getItem("read")!.length;
    expect(size).toBeLessThan(150 * 1024);
  });

  test("parseReadSet tolerates corrupt data, dedupes and keeps the newest", () => {
    expect(parseReadSet(null)).toEqual([]);
    expect(parseReadSet("not json")).toEqual([]);
    expect(parseReadSet(JSON.stringify([1, "", "a", "a"]))).toEqual(["a"]);
    expect(parseReadSet(JSON.stringify(["a", "b", "a"]))).toEqual(["b", "a"]);
    expect(parseReadSet(JSON.stringify(["a", "b", "c"]), 2)).toEqual(["b", "c"]);
  });
});

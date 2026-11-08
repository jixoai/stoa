/**
 * 视窗停留已读引擎（report-read-dwell design §2/§3）。
 *
 * 与 React 解耦：Provider 只负责创建/重置/挂载；`PostCard` 注册根 `article`。
 * 硬约束：
 * - 每个文档全局**一个** `IntersectionObserver`（懒创建，跟踪集合为空即 disconnect）；
 * - 不监听 scroll、无 rAF/setState；IO 回调只读 entry 字段；
 * - 可见面积 ≥50% 且 document.visible 且未被模态层 hold 才累计；
 * - 高卡（高于视口）按「可见高度 ÷ 视口高度 ≥50%」判定（D10）；
 * - 到点只做一次 `getBoundingClientRect` 复核（防滚出后误标）；
 * - 卸载丢弃未完成累计；同帖只写一次；引擎侧跳过自己的帖/软删帖/已读帖；
 * - `window.__reportReadDwell` 只读诊断（enabled/observers/targets/timers/
 *   marks/persists/lastMarkAt）。
 */
import {
  DWELL_COVERAGE,
  coverageOf,
  dwellThresholdMs,
  type CoverageEntryLike,
} from "@/lib/dwell-threshold";

export type DwellState = "idle" | "visible" | "dwell" | "paused" | "read" | "skipped";

export interface DwellTargetInput {
  postId: string;
  author: string;
  seq: number;
  bodyMd: string;
  hasMedia: boolean;
  deleted?: boolean;
}

export interface DwellElementLike {
  dataset: { read?: string; dwellState?: string };
  getBoundingClientRect(): {
    top: number;
    bottom: number;
    left: number;
    right: number;
    height: number;
    width: number;
  };
}

export interface DwellEntryLike extends CoverageEntryLike {
  target: Element;
}

export interface ObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export interface DwellDocumentLike {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  querySelector(selector: string): Element | null;
  body?: Node | null;
}

export interface ReadDwellEngineOptions {
  markPostRead: (postId: string) => void;
  /** 与通知同源：read-set 命中或 seq ≤ 已 ack 游标（训练 provider 传入）。 */
  isRead: (postId: string, seq: number) => boolean;
  getSelfId?: () => string | null;
  document?: DwellDocumentLike | null;
  viewportHeight?: () => number;
  viewportWidth?: () => number;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  createObserver?: (
    callback: (entries: DwellEntryLike[]) => void,
    init: IntersectionObserverInit,
  ) => ObserverLike | null;
  /** 诊断计数（默认写模块级 __reportReadDwell）。 */
  onStats?: () => void;
  observeModals?: boolean;
}

export interface ReadDwellStats {
  observers: number;
  targets: number;
  timers: number;
}

export interface ReadDwellDiagnostics {
  enabled: boolean;
  observers: number;
  targets: number;
  timers: number;
  marks: number;
  persists: number;
  lastMarkAt: number;
}

const diagnostics: ReadDwellDiagnostics = {
  enabled: false,
  observers: 0,
  targets: 0,
  timers: 0,
  marks: 0,
  persists: 0,
  lastMarkAt: 0,
};

let diagnosticsInstalled = false;

/** 安装只读诊断对象；禁用态也安装，字段保持 enabled=false / 计数 0。 */
export function installReadDwellDiagnostics(
  target: Window | undefined = typeof window === "undefined" ? undefined : window,
): void {
  if (diagnosticsInstalled || !target) return;
  diagnosticsInstalled = true;
  try {
    Object.defineProperty(target, "__reportReadDwell", {
      configurable: true,
      get: () => ({ ...diagnostics }),
    });
  } catch {
    // sandboxed/old browsers: diagnostics are best-effort only
  }
}

installReadDwellDiagnostics();

export function getReadDwellDiagnostics(): ReadDwellDiagnostics {
  return { ...diagnostics };
}

/** Provider 在引擎可用/禁用时调用；禁用态把计数清零，保证 A5 断言稳定。 */
export function setReadDwellEnabled(enabled: boolean): void {
  diagnostics.enabled = enabled;
  if (!enabled) {
    diagnostics.observers = 0;
    diagnostics.targets = 0;
    diagnostics.timers = 0;
    diagnostics.marks = 0;
    diagnostics.persists = 0;
    diagnostics.lastMarkAt = 0;
  }
}

/** 读集合真正写入 localStorage 时由 Provider 调用（`persists` 诊断）。 */
export function noteReadSetPersist(): void {
  diagnostics.persists += 1;
}

/** 模态层选择器（design §2.5）：dialog/sheet 打开即 hold。 */
export const MODAL_SELECTOR =
  '[data-slot="dialog-content"], [data-slot="sheet-content"], [role="dialog"][data-open]';

const OBSERVER_THRESHOLDS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function defaultDocument(): DwellDocumentLike | null {
  return typeof document === "undefined" ? null : (document as unknown as DwellDocumentLike);
}

function defaultViewportHeight(): number {
  return typeof window === "undefined" ? 0 : window.innerHeight;
}

function defaultViewportWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

function defaultCreateObserver(
  callback: (entries: DwellEntryLike[]) => void,
  init: IntersectionObserverInit,
): ObserverLike | null {
  if (typeof IntersectionObserver === "undefined") return null;
  return new IntersectionObserver(
    (entries) => callback(entries as unknown as DwellEntryLike[]),
    init,
  );
}

interface HoldEntry {
  /** null = 全局遮挡（模态层）；Element = 只豁免该子树内的卡片 */
  scope: Element | null;
  refs: number;
}

interface TrackedTarget {
  el: DwellElementLike & Element;
  postId: string;
  seq: number;
  threshold: number;
  state: DwellState;
  accMs: number;
  dwellSince: number | null;
  timer: unknown;
  lastCoverage: number;
}

export class ReadDwellEngine {
  private readonly options: ReadDwellEngineOptions;
  private readonly doc: DwellDocumentLike | null;
  private readonly entries = new Map<Element, TrackedTarget>();
  private readonly holds = new Map<string, HoldEntry>();
  private observer: ObserverLike | null = null;
  private modalObserver: MutationObserver | null = null;
  private modalHeld = false;
  private visibilityBound: (() => void) | null = null;
  private timerCount = 0;
  private disposed = false;

  constructor(options: ReadDwellEngineOptions) {
    this.options = options;
    this.doc = options.document ?? defaultDocument();
  }

  /**
   * 注册一个卡片根节点。自己的帖/软删帖**不注册**；已读帖也不注册（不建 timer），
   * 但保留既有的 `data-dwell-state=read`，避免 0→1 翻转后的重注册杀掉淡出动画。
   */
  observe(el: Element, target: DwellTargetInput): void {
    if (this.disposed) return;
    if (this.entries.has(el)) this.unobserve(el);
    const element = el as unknown as DwellElementLike & Element;
    const selfId = this.options.getSelfId?.() ?? null;
    if (target.deleted || (selfId !== null && target.author === selfId)) {
      if (element.dataset.dwellState !== "read") element.dataset.dwellState = "skipped";
      return;
    }
    if (this.options.isRead(target.postId, target.seq)) {
      // 已读帖首帧由 React 渲染 data-read="1"；已有 read 状态时不要重置。
      if (element.dataset.dwellState !== "read") element.dataset.dwellState = "skipped";
      return;
    }
    const observer = this.ensureObserver();
    if (!observer) {
      element.dataset.dwellState = "skipped";
      return;
    }
    const tracked: TrackedTarget = {
      el: element,
      postId: target.postId,
      seq: target.seq,
      threshold: dwellThresholdMs({ bodyMd: target.bodyMd, hasMedia: target.hasMedia }),
      state: "idle",
      accMs: 0,
      dwellSince: null,
      timer: null,
      lastCoverage: 0,
    };
    this.entries.set(el, tracked);
    element.dataset.dwellState = "idle";
    observer.observe(el);
    this.ensureModalWatch();
    this.syncStats();
  }

  /** 卸载：清 timer、丢弃未完成累计（D8），跟踪集合为空时断开观察器。 */
  unobserve(el: Element): void {
    const tracked = this.entries.get(el);
    if (!tracked) return;
    this.clearTimer(tracked);
    tracked.dwellSince = null;
    tracked.accMs = 0;
    this.entries.delete(el);
    this.observer?.unobserve(el);
    if (this.entries.size === 0) this.teardownObserver();
    this.syncStats();
  }

  /**
   * 遮挡/覆盖层暂停门（引用计数）。
   * - `hold(reason)`：全局，暂停所有目标（模态层）；
   * - `hold(reason, scopeEl)`：只暂停 scope 之外的目标（详情覆盖层）——
   *   覆盖层内的卡片继续计时，底层根页卡片暂停并保留累计。
   */
  hold(reason: string, scope?: Element | null): void {
    const existing = this.holds.get(reason);
    if (existing) {
      existing.refs += 1;
      if (scope && !existing.scope) existing.scope = scope;
    } else {
      this.holds.set(reason, { scope: scope ?? null, refs: 1 });
    }
    this.reconcileAll();
  }

  release(reason: string): void {
    const entry = this.holds.get(reason);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) this.holds.delete(reason);
    this.reconcileAll();
  }

  /** 账号/后端切换：断开并丢弃全部状态（新 read-set 重新计时）。 */
  reset(): void {
    for (const tracked of this.entries.values()) this.clearTimer(tracked);
    this.entries.clear();
    this.teardownObserver();
    this.syncStats();
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
    this.holds.clear();
    setReadDwellEnabled(false);
  }

  stats(): ReadDwellStats {
    return {
      observers: this.observer ? 1 : 0,
      targets: this.entries.size,
      timers: this.timerCount,
    };
  }

  /** 跟踪集合（测试/诊断用）。 */
  trackedCount(): number {
    return this.entries.size;
  }

  hasObserver(): boolean {
    return this.observer !== null;
  }

  // ── 观察器生命周期 ────────────────────────────────────────────────────────

  private ensureObserver(): ObserverLike | null {
    if (this.observer) return this.observer;
    const factory = this.options.createObserver ?? defaultCreateObserver;
    const observer = factory((entries) => this.handleEntries(entries), {
      root: null,
      rootMargin: "0px",
      threshold: OBSERVER_THRESHOLDS,
    });
    if (!observer) return null;
    this.observer = observer;
    this.bindVisibility();
    this.syncStats();
    return observer;
  }

  private teardownObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.unbindVisibility();
    if (this.modalObserver) {
      this.modalObserver.disconnect();
      this.modalObserver = null;
    }
    if (this.modalHeld) {
      this.modalHeld = false;
      this.release("modal");
    }
  }

  private bindVisibility(): void {
    if (this.visibilityBound || !this.doc) return;
    const listener = () => {
      if (this.doc?.visibilityState === "visible") this.resumeAll();
      else this.pauseAll();
    };
    this.visibilityBound = listener;
    this.doc.addEventListener("visibilitychange", listener);
  }

  private unbindVisibility(): void {
    if (!this.visibilityBound || !this.doc) return;
    this.doc.removeEventListener("visibilitychange", this.visibilityBound);
    this.visibilityBound = null;
  }

  private ensureModalWatch(): void {
    if (this.modalObserver || this.options.observeModals === false) return;
    if (typeof MutationObserver === "undefined") return;
    const body = this.doc?.body;
    if (!body) return;
    this.modalObserver = new MutationObserver(() => this.syncModalHold());
    this.modalObserver.observe(body, { childList: true, subtree: true });
    this.syncModalHold();
  }

  private syncModalHold(): void {
    const open = Boolean(this.doc?.querySelector(MODAL_SELECTOR));
    if (open && !this.modalHeld) {
      this.modalHeld = true;
      this.hold("modal");
    } else if (!open && this.modalHeld) {
      this.modalHeld = false;
      this.release("modal");
    }
  }

  // ── 状态机 ────────────────────────────────────────────────────────────────

  private handleEntries(entries: DwellEntryLike[]): void {
    if (this.disposed) return;
    const viewportHeight = this.viewportHeight();
    for (const entry of entries) {
      const tracked = this.entries.get(entry.target);
      if (!tracked) continue;
      const coverage = coverageOf(entry, viewportHeight);
      tracked.lastCoverage = coverage;
      this.reconcile(tracked, coverage);
    }
  }

  private reconcile(tracked: TrackedTarget, coverage: number): void {
    if (tracked.state === "read") return;
    const eligible =
      coverage >= DWELL_COVERAGE &&
      this.documentVisible() &&
      !this.holdAppliesTo(tracked.el);
    if (eligible) {
      this.enterDwell(tracked);
      return;
    }
    this.pause(tracked, coverage);
  }

  /** 只暂停 scope 之外的目标：详情覆盖层内的卡片继续计时。 */
  private holdAppliesTo(el: Element): boolean {
    for (const entry of this.holds.values()) {
      if (!entry.scope || !entry.scope.contains(el)) return true;
    }
    return false;
  }

  private reconcileAll(): void {
    for (const tracked of this.entries.values()) {
      this.reconcile(tracked, tracked.lastCoverage);
    }
  }

  private enterDwell(tracked: TrackedTarget): void {
    if (tracked.state === "dwell") return;
    tracked.dwellSince = this.now();
    const remaining = Math.max(0, tracked.threshold - tracked.accMs);
    tracked.timer = this.setTimeout(() => {
      tracked.timer = null;
      this.timerCount = Math.max(0, this.timerCount - 1);
      this.onTimer(tracked);
    }, remaining);
    this.timerCount += 1;
    this.syncStats();
    this.setState(tracked, "dwell");
  }

  private pause(tracked: TrackedTarget, coverage: number): void {
    if (tracked.state === "dwell") {
      const since = tracked.dwellSince;
      if (since !== null) tracked.accMs += Math.max(0, this.now() - since);
      tracked.dwellSince = null;
      this.clearTimer(tracked);
    }
    if (tracked.state === "read") return;
    let next: DwellState;
    if (coverage >= DWELL_COVERAGE) {
      // 可见但被 hidden/hold 挡住：保留累计。
      next = "paused";
    } else if (coverage > 0) {
      next = tracked.accMs > 0 ? "paused" : "visible";
    } else {
      next = tracked.accMs > 0 ? "paused" : "idle";
    }
    this.setState(tracked, next);
  }

  private onTimer(tracked: TrackedTarget): void {
    if (this.disposed || tracked.state !== "dwell") return;
    const since = tracked.dwellSince;
    if (since !== null) tracked.accMs += Math.max(0, this.now() - since);
    tracked.dwellSince = null;
    const remaining = tracked.threshold - tracked.accMs;
    if (remaining > 1) {
      // 定时器被系统提前唤醒/上一次累计不足：补足剩余时间。
      this.setState(tracked, "paused");
      this.enterDwell(tracked);
      return;
    }
    if (!this.recheck(tracked.el)) {
      this.setState(tracked, "paused");
      return;
    }
    this.markRead(tracked);
  }

  /** 到点复核（design §3.4）：每帖最多一次布局读取。 */
  private recheck(el: DwellElementLike): boolean {
    if (!this.documentVisible() || this.holdAppliesTo(el as unknown as Element)) return false;
    const rect = el.getBoundingClientRect();
    const rootH = this.viewportHeight();
    const rootW = this.viewportWidth();
    if (!(rect.height > 0) || !(rect.width > 0) || !(rootH > 0)) return false;
    const visibleH = Math.min(rect.bottom, rootH) - Math.max(rect.top, 0);
    const visibleW = Math.min(rect.right, rootW) - Math.max(rect.left, 0);
    if (visibleH <= 0 || visibleW <= 0) return false;
    if (rect.height > rootH) return visibleH / rootH >= DWELL_COVERAGE;
    return (visibleH * visibleW) / (rect.height * rect.width) >= DWELL_COVERAGE;
  }

  private markRead(tracked: TrackedTarget): void {
    if (tracked.state === "read") return;
    tracked.state = "read";
    this.clearTimer(tracked);
    tracked.el.dataset.dwellState = "read";
    tracked.el.dataset.read = "1";
    // 以 read-set 为唯一权威（LRU 淘汰后重新挂载可以再次写入）；
    // 已读（含 ack 游标）时不重复写、不递增 marks。
    if (!this.options.isRead(tracked.postId, tracked.seq)) {
      this.options.markPostRead(tracked.postId);
      diagnostics.marks += 1;
      diagnostics.lastMarkAt = this.now();
    }
    // 标记后不再需要观察这张卡（targets 数回到未读卡数）。
    this.entries.delete(tracked.el);
    this.observer?.unobserve(tracked.el);
    if (this.entries.size === 0) this.teardownObserver();
    this.syncStats();
  }

  private pauseAll(): void {
    for (const tracked of this.entries.values()) {
      if (tracked.state === "dwell") {
        const since = tracked.dwellSince;
        if (since !== null) tracked.accMs += Math.max(0, this.now() - since);
        tracked.dwellSince = null;
        this.clearTimer(tracked);
      }
      if (tracked.state !== "read") this.setState(tracked, "paused");
    }
  }

  private resumeAll(): void {
    for (const tracked of this.entries.values()) {
      if (tracked.state === "read") continue;
      this.reconcile(tracked, tracked.lastCoverage);
    }
  }

  private setState(tracked: TrackedTarget, state: DwellState): void {
    if (tracked.state === state) return;
    tracked.state = state;
    tracked.el.dataset.dwellState = state;
  }

  private clearTimer(tracked: TrackedTarget): void {
    if (tracked.timer !== null) {
      this.clearTimeout(tracked.timer);
      tracked.timer = null;
      this.timerCount = Math.max(0, this.timerCount - 1);
      this.syncStats();
    }
  }

  private syncStats(): void {
    diagnostics.observers = this.observer ? 1 : 0;
    diagnostics.targets = this.entries.size;
    diagnostics.timers = this.timerCount;
    this.options.onStats?.();
  }

  private documentVisible(): boolean {
    return (this.doc?.visibilityState ?? "visible") === "visible";
  }

  private viewportHeight(): number {
    return (this.options.viewportHeight ?? defaultViewportHeight)();
  }

  private viewportWidth(): number {
    return (this.options.viewportWidth ?? defaultViewportWidth)();
  }

  private now(): number {
    return (this.options.now ?? defaultNow)();
  }

  private setTimeout(callback: () => void, ms: number): unknown {
    if (this.options.setTimeout) return this.options.setTimeout(callback, ms);
    return setTimeout(callback, ms);
  }

  private clearTimeout(handle: unknown): void {
    if (this.options.clearTimeout) {
      this.options.clearTimeout(handle);
      return;
    }
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

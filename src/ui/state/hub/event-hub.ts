/**
 * 客户端事件总线引擎（design §4.2 / §4.3，零 React、零 DOM 依赖）。
 *
 * 职责（单点）：
 * - 每标签页**一条** `EventSource`，所有实时面共享；每次（重）连都重新取 ticket
 *   （一次性票据，禁止复用 URL）。
 * - 自有状态机：任何非 200（含 204/503）都会让 EventSource 永久失败且**不自动重连**，
 *   因此 `onerror` 一律 `close()` + 自带退避重连（1/2/4/8s）；不依赖浏览器内建重试。
 * - 双水位：`lastSeq`（已应用的流位置）与 `resumeSeq`（下次 `since`）。数据帧去重；
 *   `lastSeq` 只在 `caught_up`/`heartbeat`（或首连无 backlog 的 `hello`）推进；
 *   `pendingCatchUp` 未清时心跳不得越过空洞上界。
 * - reset（replay_limit / rollback）：标记空洞 → 活跃视图 REST 强重取 → **全部成功**
 *   才确认水位；失败保留 pending 并按退避重试，绝不假装追上。
 * - 首连竞态：`since = min(活跃视图 seed.as_of_seq)`；每次 hello 后对落后视图强制一次
 *   REST catch-up；视图在连接后才注册且已落后 → 注册即补拉。
 * - 心跳看门狗：`2.5 × heartbeat_ms` 无任何帧 → 关闭重连；visible/online/pageshow 立即重连。
 */
import type {
  HubByeFrame,
  HubCaughtUpFrame,
  HubCursorFrame,
  HubDegradedReason,
  HubDispatch,
  HubEventLine,
  HubHeartbeatFrame,
  HubHelloFrame,
  HubListener,
  HubPluginUpdatedFrame,
  HubResetFrame,
  HubState,
  HubStatus,
  HubTopic,
  HubView,
} from "./types";

/** 结构化最小 EventSource（浏览器原生实现；测试注入假实现）。 */
export interface EventSourceLike {
  addEventListener(
    type: string,
    listener: (event: { data: string; lastEventId?: string }) => void,
  ): void;
  close(): void;
  onerror: ((event: unknown) => void) | null;
  /** 浏览器语义：0 CONNECTING / 1 OPEN / 2 CLOSED（测试可省略） */
  readyState?: number;
}

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface EventHubOptions {
  /** 当前账号（open 模式 `as=` 与派生 topic 过滤都用它）。 */
  accountId: string;
  /** 生成一次性连接 URL（内部先换 ticket 再拼 `hub=2&since=`）；拒绝即按失败重连。 */
  openUrl: (since: number | null) => Promise<string>;
  /** EventSource 工厂（测试注入）。 */
  createSource?: (url: string) => EventSourceLike;
  now?: () => number;
  /** hello 前的兜底心跳间隔（默认 15s）。 */
  heartbeatMs?: number;
  /** hello 等待上限（默认 10s）。 */
  helloTimeoutMs?: number;
  /** 退避序列（默认 1/2/4/8s，之后停在最后一档）。 */
  backoff?: readonly number[];
  /** 退避抖动上限（默认 250ms；测试设 0 得到确定时序）。 */
  jitterMs?: number;
  /** 连续失败多少轮进入 degraded（默认 5）。 */
  maxFailuresBeforeDegraded?: number;
  /** 可注入计时器（测试缩短等待）。 */
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  /** 可见性探针（默认读 document.visibilityState；非 DOM 环境视为 visible）。 */
  isVisible?: () => boolean;
}

interface PendingCatchUp {
  asOfSeq: number;
  views: Set<() => HubView | null>;
  generation: number;
  /** rollback = 换库（新 as_of 可低于本地水位）；replay_limit = 同库空洞 */
  mode: "replay_limit" | "rollback";
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000] as const;
const VIEW_CATCH_UP_DEBOUNCE_MS = 250;
const CATCH_UP_RETRY_MAX_MS = 10_000;
/** degraded（reconnect_failed）期间的兜底轮询间隔（design §5.3 / P2-5）。 */
const DEGRADED_POLL_MS = 60_000;

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class EventHub {
  readonly accountId: string;

  private readonly openUrl: (since: number | null) => Promise<string>;
  private readonly createSource: (url: string) => EventSourceLike;
  private readonly now: () => number;
  private readonly backoff: readonly number[];
  private readonly jitterMs: number;
  private readonly maxFailures: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (handle: TimerHandle) => void;
  private readonly helloTimeoutMs: number;
  private readonly isVisible: () => boolean;

  private heartbeatMs: number;
  private started = false;
  private live = false;
  private connecting = false;
  private source: EventSourceLike | null = null;
  private stateValue: HubState = "off";
  private reason: HubDegradedReason | null = null;

  /** 已应用的流位置（去重高水位）。 */
  private lastSeq = 0;
  /** 下次连接发送的 `since`（reset 后可前跳）。 */
  private resumeSeq: number | null = null;
  private cursorMirror = 0;
  private attempts = 0;
  private connectedAt: number | null = null;
  private lastFrameAt: number | null = null;
  private lastSince: number | null = null;
  private firstHello = true;

  private pendingCatchUp: PendingCatchUp | null = null;
  private catchUpGeneration = 0;
  private catchUpRetries = 0;

  private reconnectTimer: TimerHandle | null = null;
  private watchdogTimer: TimerHandle | null = null;
  private helloTimer: TimerHandle | null = null;
  private viewCatchUpTimer: TimerHandle | null = null;
  private catchUpRetryTimer: TimerHandle | null = null;
  private degradedPollTimer: TimerHandle | null = null;
  private connectToken = 0;

  private readonly views = new Set<() => HubView | null>();
  private readonly listeners = new Map<HubTopic, Set<HubListener>>();
  private readonly onVisibility = (): void => {
    this.handleVisibilityChange();
  };
  private readonly onOnline = (): void => this.resumeNow();
  private readonly onPageShow = (): void => this.resumeNow();
  private readonly onOffline = (): void => {
    // 断网：收掉连接并**按失败推进状态机**（重试会继续失败 → 5 次后 degraded，
    // 界面显示「轮询兜底」）；恢复 online 时 resumeNow 立即取消退避重连。
    if (!this.started) return;
    this.dropSource();
    this.live = false;
    this.connecting = false;
    this.onFailure();
  };

  constructor(opts: EventHubOptions) {
    this.accountId = opts.accountId;
    this.openUrl = opts.openUrl;
    this.createSource = opts.createSource ?? ((url) => new EventSource(url) as EventSourceLike);
    this.now = opts.now ?? Date.now;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.jitterMs = Math.max(0, opts.jitterMs ?? 250);
    this.maxFailures = opts.maxFailuresBeforeDegraded ?? 5;
    this.setTimeoutFn = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeout ?? ((handle) => clearTimeout(handle));
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
    this.isVisible =
      opts.isVisible ??
      (() => typeof document === "undefined" || document.visibilityState === "visible");
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;
    this.installResumeListeners();
    this.syncState();
    void this.connectNow();
  }

  stop(): void {
    if (!this.started) {
      this.dropSource();
      this.clearAllTimers();
      this.stateValue = "off";
      this.reason = null;
      return;
    }
    this.started = false;
    this.live = false;
    this.connecting = false;
    this.connectToken += 1;
    this.uninstallResumeListeners();
    this.clearAllTimers();
    this.dropSource();
    this.pendingCatchUp = null;
    this.stateValue = "off";
    this.reason = null;
    this.emit({ topic: "stream.state", status: this.getStatus() });
  }

  /**
   * visible / online / pageshow：取消退避，立即重连；已 live 但疑似冻结则强重连。
   */
  resumeNow(): void {
    if (!this.started || this.stateValue === "off") return;
    if (this.live) {
      const stale =
        this.lastFrameAt !== null && this.now() - this.lastFrameAt > this.heartbeatMs;
      if (!stale) return;
      this.forceReconnect();
      return;
    }
    if (this.connecting) return;
    this.clearReconnectTimer();
    void this.connectNow();
  }

  /**
   * 可见性变化（design §4.2：degraded 只在 visible 时轮询）：
   * - visible：尝试立即重连；若仍在 degraded{reconnect_failed}，立即补一次活跃视图
   *   catch-up 并重建 60s 定时器；
   * - hidden：暂停兜底轮询（清定时器），不做任何补拉。
   * 公开方法供测试/宿主复用；document 监听只是它的一层薄壳。
   */
  handleVisibilityChange(): void {
    if (!this.started) return;
    if (this.isVisible()) {
      this.resumeNow();
      if (this.stateValue === "degraded" && this.reason === "reconnect_failed") {
        this.scheduleViewCatchUp();
        this.syncDegradedPolling(this.stateValue, this.reason);
      }
    } else {
      this.clearDegradedPoll();
    }
    if (this.stateValue === "degraded") {
      // degradedPolling 随可见性变化，推一次状态给 UI/通知对账订阅者。
      this.emit({ topic: "stream.state", status: this.getStatus() });
    }
  }

  getStatus(): HubStatus {
    return {
      state: this.stateValue,
      reason: this.reason,
      account: this.started ? this.accountId : null,
      cursor: this.cursorMirror,
      asOfSeq: this.lastSeq,
      resumeSeq: this.resumeSeq,
      attempts: this.attempts,
      catchingUp: this.pendingCatchUp !== null,
      catchUpReason: this.pendingCatchUp?.mode ?? null,
      degradedPolling: this.degradedPollTimer !== null,
      connectedAt: this.connectedAt,
      lastFrameAt: this.lastFrameAt,
      heartbeatMs: this.heartbeatMs,
      since: this.lastSince,
    };
  }

  // ── subscriptions ───────────────────────────────────────────────────────────

  subscribe(topics: HubTopic | readonly HubTopic[], listener: HubListener): () => void {
    const list = typeof topics === "string" ? [topics] : topics;
    const added: HubTopic[] = [];
    for (const topic of list) {
      let set = this.listeners.get(topic);
      if (!set) {
        set = new Set();
        this.listeners.set(topic, set);
      }
      set.add(listener);
      added.push(topic);
    }
    return () => {
      for (const topic of added) {
        const set = this.listeners.get(topic);
        if (!set) continue;
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(topic);
      }
    };
  }

  private emit(dispatch: HubDispatch): void {
    const set = this.listeners.get(dispatch.topic);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        listener(dispatch);
      } catch {
        // a broken subscriber must not kill the stream
      }
    }
  }

  // ── views（活跃视图的 seed 水位 + catch-up/reload） ─────────────────────────

  registerView(getter: () => HubView | null): () => void {
    this.views.add(getter);
    const view = getter();
    if (view && view.asOfSeq > 0 && view.asOfSeq < this.lastSeq) {
      // 视图是在连接之后才挂载的：它 REST seed 之后、注册之前的事件已经流过，
      // 必须补一次（design §3.4 首连竞态第 2 条的同源规则）。
      this.scheduleViewCatchUp();
    }
    return () => {
      this.views.delete(getter);
    };
  }

  // ── connection state machine ────────────────────────────────────────────────

  private async connectNow(): Promise<void> {
    if (!this.started || this.live || this.connecting) return;
    this.connecting = true;
    this.clearReconnectTimer();
    this.syncState();
    const token = ++this.connectToken;
    const since = this.computeSince();
    this.lastSince = since;
    let url: string;
    try {
      url = await this.openUrl(since);
    } catch {
      if (token !== this.connectToken || !this.started) return;
      this.connecting = false;
      this.onFailure();
      return;
    }
    if (token !== this.connectToken || !this.started) return;
    this.dropSource();
    let source: EventSourceLike;
    try {
      source = this.createSource(url);
    } catch {
      this.connecting = false;
      this.onFailure();
      return;
    }
    this.source = source;
    this.helloTimer = this.setTimeoutFn(() => this.onHelloTimeout(source), this.helloTimeoutMs);
    source.addEventListener("hello", (raw) => this.onHello(source, raw.data));
    source.addEventListener("caught_up", (raw) => this.onCaughtUp(source, raw.data));
    source.addEventListener("heartbeat", (raw) => this.onHeartbeat(source, raw.data));
    source.addEventListener("cursor", (raw) => this.onCursor(source, raw.data));
    source.addEventListener("reset", (raw) => this.onReset(source, raw.data));
    source.addEventListener("bye", (raw) => this.onBye(source, raw.data));
    source.addEventListener("plugin.updated", (raw) => this.onPluginUpdated(source, raw.data));
    source.addEventListener("hub", (raw) => this.onData(source, raw.data));
    source.onerror = () => this.onSourceFailure(source);
  }

  private onHello(source: EventSourceLike, raw: string): void {
    if (source !== this.source) return;
    const hello = safeParse<HubHelloFrame>(raw);
    if (!hello || typeof hello.as_of_seq !== "number" || !hello.account) {
      this.onSourceFailure(source);
      return;
    }
    this.clearHelloTimer();
    if (hello.hub !== 2) {
      // 旧后端（无 hub:2）：本版不做 legacy 适配器（design §5.1 P3 才收口）。
      // 明确关闭实时层，不假装有推送。
      this.halted();
      return;
    }
    const first = this.firstHello;
    this.firstHello = false;
    this.live = true;
    this.connecting = false;
    this.attempts = 0;
    this.connectedAt = this.now();
    this.lastFrameAt = this.now();
    this.heartbeatMs =
      typeof hello.heartbeat_ms === "number" && hello.heartbeat_ms > 0
        ? hello.heartbeat_ms
        : this.heartbeatMs;
    this.cursorMirror = Math.max(this.cursorMirror, hello.cursor ?? 0);

    if (hello.as_of_seq < this.lastSeq) {
      // 换库/恢复导致水位回滚：等同 reset（REST 成功才确认）。
      this.beginCatchUp(hello.as_of_seq, "rollback");
    } else if (hello.since === null) {
      // 首连且服务端没有按 since 补发：水位就是 hello 的 as_of_seq。
      this.advanceWatermark(hello.as_of_seq);
    }
    this.resetWatchdog();

    // hello 后对落后视图强制一次 REST catch-up；非首次 hello 所有视图都补。
    const lagging = [...this.views].some((getter) => {
      const view = getter();
      return !view || view.asOfSeq < hello.as_of_seq;
    });
    if (!first || lagging) this.scheduleViewCatchUp();

    this.syncState();
    if (!first) this.emit({ topic: "stream.reconnected", hello });
  }

  private onCaughtUp(source: EventSourceLike, raw: string): void {
    if (source !== this.source) return;
    const frame = safeParse<HubCaughtUpFrame>(raw);
    this.resetWatchdog();
    if (!frame || typeof frame.as_of_seq !== "number") return;
    this.advanceWatermark(frame.as_of_seq);
  }

  private onHeartbeat(source: EventSourceLike, raw: string): void {
    if (source !== this.source) return;
    const frame = safeParse<HubHeartbeatFrame>(raw);
    this.resetWatchdog();
    if (!frame || typeof frame.as_of_seq !== "number") return;
    this.advanceWatermark(frame.as_of_seq);
    this.emit({
      topic: "stream.heartbeat",
      asOfSeq: frame.as_of_seq,
      unreadCount: typeof frame.unread_count === "number" ? frame.unread_count : 0,
    });
  }

  private onCursor(source: EventSourceLike, raw: string): void {
    if (source !== this.source) return;
    const frame = safeParse<HubCursorFrame>(raw);
    this.resetWatchdog();
    if (!frame || typeof frame.cursor !== "number") return;
    this.cursorMirror = Math.max(this.cursorMirror, frame.cursor);
    this.emit({
      topic: "cursor.acked",
      cursor: this.cursorMirror,
      unreadCount: typeof frame.unread_count === "number" ? frame.unread_count : 0,
    });
  }

  private onReset(source: EventSourceLike, raw: string): void {
    if (source !== this.source) return;
    const frame = safeParse<HubResetFrame>(raw);
    this.resetWatchdog();
    if (!frame || typeof frame.as_of_seq !== "number") return;
    this.beginCatchUp(frame.as_of_seq, frame.reason === "rollback" ? "rollback" : "replay_limit");
    this.emit({
      topic: "stream.reset",
      asOfSeq: frame.as_of_seq,
      reason: frame.reason === "rollback" ? "rollback" : "replay_limit",
    });
  }

  private onBye(source: EventSourceLike, raw: string): void {
    if (source !== this.source) return;
    const frame = safeParse<HubByeFrame>(raw);
    const reason = frame?.reason ?? "shutdown";
    if (reason === "auth") {
      this.halted();
      return;
    }
    this.forceReconnect();
  }

  /** 插件开关控制帧（无 id/seq）：不推进水位，只更新订阅者。 */
  private onPluginUpdated(source: EventSourceLike, raw: string): void {
    if (source !== this.source) return;
    const frame = safeParse<HubPluginUpdatedFrame>(raw);
    this.resetWatchdog();
    if (!frame || typeof frame.plugin_id !== "string" || typeof frame.enabled !== "boolean") return;
    this.emit({
      topic: "plugin.updated",
      pluginId: frame.plugin_id,
      enabled: frame.enabled,
      version: typeof frame.version === "string" ? frame.version : null,
    });
  }

  private onData(source: EventSourceLike, raw: string): void {
    if (source !== this.source) return;
    const event = safeParse<HubEventLine>(raw);
    this.resetWatchdog();
    if (!event || typeof event.seq !== "number" || typeof event.type !== "string") return;
    // 单连接内 seq 严格升序；已应用过的帧直接丢弃（重连补发/双重重连都靠它去重）。
    if (event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    this.resumeSeq = event.seq;
    if (event.type === "post.created") {
      this.emit({ topic: "post.created", event: event as HubEventLine & { type: "post.created" } });
    } else if (event.type === "post.updated") {
      this.emit({ topic: "post.updated", event: event as HubEventLine & { type: "post.updated" } });
    } else if (event.type === "post.deleted") {
      this.emit({ topic: "post.deleted", event: event as HubEventLine & { type: "post.deleted" } });
    } else if (event.type === "thread.invited") {
      this.emit({ topic: "thread.invited", event: event as HubEventLine & { type: "thread.invited" } });
    }
    this.emit({ topic: "*", event });
    if (
      (event.type === "post.created" || event.type === "thread.invited") &&
      event.actor !== this.accountId &&
      event.post_deleted !== true
    ) {
      this.emit({
        topic: "notification.created",
        event: event as HubEventLine & { type: "post.created" | "thread.invited" },
      });
    }
  }

  private onHelloTimeout(source: EventSourceLike): void {
    if (source !== this.source) return;
    this.onSourceFailure(source);
  }

  private onSourceFailure(source: EventSourceLike): void {
    if (source !== this.source || !this.started) return;
    this.dropSource();
    this.live = false;
    this.connecting = false;
    this.onFailure();
  }

  private onFailure(): void {
    this.attempts += 1;
    this.syncState();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.started || this.live) return;
    if (this.reconnectTimer !== null) return;
    const index = Math.min(Math.max(this.attempts - 1, 0), this.backoff.length - 1);
    const base = this.backoff[index] ?? this.backoff[this.backoff.length - 1] ?? 1000;
    const delay = base + Math.floor(Math.random() * this.jitterMs);
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      void this.connectNow();
    }, delay);
  }

  private forceReconnect(): void {
    this.clearReconnectTimer();
    this.dropSource();
    this.live = false;
    this.connecting = false;
    this.connectToken += 1;
    if (!this.started) return;
    this.attempts = 0;
    this.syncState();
    void this.connectNow();
  }

  /** bye{auth} / 旧后端：关掉实时层，交登录态或降级（不循环重连）。 */
  private halted(): void {
    this.dropSource();
    this.live = false;
    this.connecting = false;
    this.started = false;
    this.uninstallResumeListeners();
    this.clearAllTimers();
    this.syncState();
  }

  private dropSource(): void {
    this.clearHelloTimer();
    this.clearWatchdog();
    const source = this.source;
    this.source = null;
    if (!source) return;
    source.onerror = null;
    try {
      source.close();
    } catch {
      // already closed
    }
  }

  // ── watermarks ──────────────────────────────────────────────────────────────

  /**
   * `lastSeq = max(lastSeq, asOf)`；`pendingCatchUp` 未清时上限钳在空洞上界
   * （心跳/补发帧不得越过空洞，否则会「假装追上」）。
   */
  private advanceWatermark(asOf: number): void {
    if (!Number.isFinite(asOf) || asOf < 0) return;
    let target = Math.max(this.lastSeq, asOf);
    if (this.pendingCatchUp) {
      target = Math.max(this.lastSeq, Math.min(target, this.pendingCatchUp.asOfSeq));
    }
    if (target > this.lastSeq) {
      this.lastSeq = target;
      this.resumeSeq = target;
    } else if (this.resumeSeq === null) {
      this.resumeSeq = this.lastSeq;
    }
  }

  private computeSince(): number | null {
    // 空洞未确认（尤其 rollback）时只认 resumeSeq：残留的视图旧 seed 会把 since
    // 顶回高位，导致对低水位新库反复 rollback（review B1）。
    if (this.pendingCatchUp) return this.resumeSeq;
    let minSeed: number | null = null;
    for (const getter of this.views) {
      const view = getter();
      if (!view) continue;
      const seq = view.asOfSeq;
      if (!Number.isInteger(seq) || seq <= 0) continue;
      minSeed = minSeed === null ? seq : Math.min(minSeed, seq);
    }
    if (minSeed === null) return this.resumeSeq;
    // design §3.4：since = min(活跃视图 seed)。用 min 而不是 max：视图 seed 可能
    // 高于流位置（REST 快照更新）或高于新库 as_of（rollback 后的残留），取 max
    // 会跳过事件/反复触发 rollback；重放重复由客户端 seq 去重吸收。
    if (this.resumeSeq === null) return minSeed;
    return Math.min(this.resumeSeq, minSeed);
  }

  // ── reset / catch-up ────────────────────────────────────────────────────────

  private beginCatchUp(asOfSeq: number, reason: "replay_limit" | "rollback"): void {
    this.catchUpGeneration += 1;
    const mode = reason;
    if (!this.pendingCatchUp) {
      this.pendingCatchUp = {
        asOfSeq,
        views: new Set(this.views),
        generation: this.catchUpGeneration,
        mode,
      };
    } else if (mode === "rollback") {
      // 服务端时间线整体换库：新 as_of 是唯一真相，允许低于本地水位。
      this.pendingCatchUp.mode = "rollback";
      this.pendingCatchUp.asOfSeq = asOfSeq;
      this.pendingCatchUp.generation = this.catchUpGeneration;
      for (const getter of this.views) this.pendingCatchUp.views.add(getter);
    } else {
      this.pendingCatchUp.asOfSeq = Math.max(this.pendingCatchUp.asOfSeq, asOfSeq);
      this.pendingCatchUp.generation = this.catchUpGeneration;
      for (const getter of this.views) this.pendingCatchUp.views.add(getter);
    }
    if (mode === "rollback") {
      // design §4.3-3 修订（review B2）：rollback = 新库真相。旧水位必须立即作废，
      // 否则新库 seq ≤ 旧水位的事件会被 onData 的去重静默丢弃；pending 仍然要求
      // 活跃视图 REST 成功才清除（status 保持 catching_up/degraded）。
      this.lastSeq = asOfSeq;
    }
    // design §4.3-1：resumeSeq 直接取 reset 的 as_of_seq（可前跳，也可在 rollback
    // 时下降），防止旧 since 反复触发 reset（review B1）。
    this.resumeSeq = this.pendingCatchUp.asOfSeq;
    this.catchUpRetries = 0;
    this.syncState();
    void this.runCatchUp();
  }

  private async runCatchUp(): Promise<void> {
    const pending = this.pendingCatchUp;
    if (!pending) return;
    const generation = pending.generation;
    const getters = [...pending.views];
    const results = await Promise.allSettled(
      getters.map(async (getter) => {
        const view = getter();
        if (view) await view.reload();
      }),
    );
    if (this.pendingCatchUp !== pending) return;
    if (pending.generation !== generation) {
      // 重试期间又来了新的 reset：以最新上界为准再跑一轮。
      void this.runCatchUp();
      return;
    }
    if (results.every((result) => result.status === "fulfilled")) {
      // rollback 在声明时已把 lastSeq 拨到新库水位；期间若已收到新事件（seq 更大）
      // 则保留进度，max 不会回退。
      this.lastSeq = Math.max(this.lastSeq, pending.asOfSeq);
      this.resumeSeq = this.lastSeq;
      this.pendingCatchUp = null;
      this.catchUpRetries = 0;
      this.syncState();
      return;
    }
    this.scheduleCatchUpRetry();
  }

  private scheduleCatchUpRetry(): void {
    if (this.catchUpRetryTimer !== null || !this.started) return;
    const delay = Math.min(
      CATCH_UP_RETRY_MAX_MS,
      1000 * 2 ** Math.min(this.catchUpRetries, 4),
    );
    this.catchUpRetries += 1;
    this.catchUpRetryTimer = this.setTimeoutFn(() => {
      this.catchUpRetryTimer = null;
      void this.runCatchUp();
    }, delay);
  }

  private scheduleViewCatchUp(): void {
    if (this.viewCatchUpTimer !== null) return;
    this.viewCatchUpTimer = this.setTimeoutFn(() => {
      this.viewCatchUpTimer = null;
      for (const getter of [...this.views]) {
        const view = getter();
        if (!view) continue;
        try {
          const result = view.catchUp();
          if (result && typeof (result as Promise<void>).catch === "function") {
            void (result as Promise<void>).catch(() => {
              // 视图补拉失败：下一次 reconnected/reset 或用户刷新再试
            });
          }
        } catch {
          // 同步视图错误不能打断总线
        }
      }
    }, VIEW_CATCH_UP_DEBOUNCE_MS);
  }

  // ── timers / state ─────────────────────────────────────────────────────────

  private resetWatchdog(): void {
    this.lastFrameAt = this.now();
    if (!this.live) return;
    this.clearWatchdog();
    const timeout = Math.max(1000, Math.round(this.heartbeatMs * 2.5));
    this.watchdogTimer = this.setTimeoutFn(() => {
      this.watchdogTimer = null;
      if (!this.started || !this.live) return;
      this.forceReconnect();
    }, timeout);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      this.clearTimeoutFn(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== null) {
      this.clearTimeoutFn(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearReconnectTimer();
    this.clearWatchdog();
    this.clearHelloTimer();
    if (this.viewCatchUpTimer !== null) {
      this.clearTimeoutFn(this.viewCatchUpTimer);
      this.viewCatchUpTimer = null;
    }
    if (this.catchUpRetryTimer !== null) {
      this.clearTimeoutFn(this.catchUpRetryTimer);
      this.catchUpRetryTimer = null;
    }
    if (this.degradedPollTimer !== null) {
      this.clearTimeoutFn(this.degradedPollTimer);
      this.degradedPollTimer = null;
    }
  }

  private syncState(): void {
    let state: HubState;
    let reason: HubDegradedReason | null = null;
    if (!this.started) {
      state = "off";
    } else if (this.pendingCatchUp !== null) {
      state = "degraded";
      reason = "catching_up";
    } else if (this.attempts >= this.maxFailures) {
      state = "degraded";
      reason = "reconnect_failed";
    } else if (this.live) {
      state = "live";
    } else if (this.attempts > 0) {
      state = "reconnecting";
    } else {
      state = "connecting";
    }
    if (state === this.stateValue && reason === this.reason) return;
    this.stateValue = state;
    this.reason = reason;
    this.syncDegradedPolling(state, reason);
    this.emit({ topic: "stream.state", status: this.getStatus() });
  }

  /**
   * degraded 兜底（review B4 / design §4.2/§5.3）：只在 reconnect_failed **且页面
   * 可见**时对活跃视图每 60s 发一次轻量 catch-up；catching_up 走 reset 的 REST
   * 强重取，不算轮询；隐藏标签页不轮询（对齐 design 的 visible 门）。
   */
  private syncDegradedPolling(state: HubState, reason: HubDegradedReason | null): void {
    const shouldPoll =
      this.started &&
      state === "degraded" &&
      reason === "reconnect_failed" &&
      this.isVisible();
    if (shouldPoll && this.degradedPollTimer === null) {
      this.degradedPollTimer = this.setTimeoutFn(() => {
        this.degradedPollTimer = null;
        if (!this.started) return;
        if (!this.isVisible()) {
          // 定时器存续期间变成了 hidden：不补拉、不重建（visible 时会立即补一次）。
          this.syncDegradedPolling(this.stateValue, this.reason);
          return;
        }
        this.scheduleViewCatchUp();
        // 重新武装：syncState 在这个状态下不会再次触发（状态未变），必须自续。
        this.syncDegradedPolling(this.stateValue, this.reason);
      }, DEGRADED_POLL_MS);
      return;
    }
    if (!shouldPoll) this.clearDegradedPoll();
  }

  private clearDegradedPoll(): void {
    if (this.degradedPollTimer === null) return;
    this.clearTimeoutFn(this.degradedPollTimer);
    this.degradedPollTimer = null;
  }

  private installResumeListeners(): void {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      window.addEventListener("offline", this.onOffline);
      window.addEventListener("pageshow", this.onPageShow);
    }
  }

  private uninstallResumeListeners(): void {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("offline", this.onOffline);
      window.removeEventListener("pageshow", this.onPageShow);
    }
  }
}

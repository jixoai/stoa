/**
 * Idle lease (design §1): a server stays alive only while something is talking
 * to it. Any HTTP request (`/healthz` included, so every CLI probe renews),
 * any long-poll/stream hold renews the lease; once the lease runs out with no
 * request in flight, the process is expected to shut down gracefully.
 *
 * The class is deliberately transport-agnostic and timer-driven so it can be
 * unit-tested with a fake clock and a tiny timeout.
 */

/** Default `serve --idle-timeout` (30 minutes). */
export const DEFAULT_IDLE_TIMEOUT_SEC = 1800;

export interface LeaseSnapshot {
  /** configured timeout; 0 means "never expire" (but the lease is then absent) */
  idle_timeout_ms: number;
  /** remaining time before the next idle check fires; null when disabled */
  lease_remaining_ms: number | null;
  last_activity_at: number;
  /** requests + long-lived subscriptions currently held open */
  in_flight: number;
}

export interface IdleLeaseOptions {
  idleTimeoutMs: number;
  onIdle: () => void | Promise<void>;
  now?: () => number;
  /** override for tests; defaults to a quarter of the timeout, clamped to [50, 1000] */
  checkIntervalMs?: number;
}

export class IdleLease {
  readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly onIdle: () => void | Promise<void>;
  private readonly checkIntervalMs: number;
  private lastActivityAt: number;
  private holds = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fired = false;
  private stopped = false;

  constructor(opts: IdleLeaseOptions) {
    if (!Number.isInteger(opts.idleTimeoutMs) || opts.idleTimeoutMs <= 0) {
      throw new Error(`idleTimeoutMs must be a positive integer (got ${opts.idleTimeoutMs})`);
    }
    if (
      opts.checkIntervalMs !== undefined &&
      (!Number.isInteger(opts.checkIntervalMs) || opts.checkIntervalMs <= 0)
    ) {
      throw new Error(`checkIntervalMs must be a positive integer (got ${opts.checkIntervalMs})`);
    }
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.now = opts.now ?? Date.now;
    this.onIdle = opts.onIdle;
    this.checkIntervalMs =
      opts.checkIntervalMs ?? Math.max(50, Math.min(1000, Math.floor(opts.idleTimeoutMs / 4)));
    this.lastActivityAt = this.now();
  }

  /** Start the expiry timer (activity may happen before `start` is called). */
  start(now = this.now()): void {
    if (this.stopped || this.timer !== null) return;
    this.lastActivityAt = now;
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
    // Do not keep the event loop alive just for the lease: the HTTP server owns that.
    this.timer.unref?.();
  }

  /** Renew the lease (a request arrived or a CLI probe touched the server). */
  touch(now = this.now()): void {
    if (this.stopped || this.fired) return;
    this.lastActivityAt = now;
  }

  /**
   * Mark an in-flight request/subscription. While any hold is open the lease
   * never expires (a blocking `wait-notifications` is activity by definition).
   */
  hold(): () => void {
    if (this.stopped || this.fired) return () => {};
    this.holds += 1;
    this.touch();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds = Math.max(0, this.holds - 1);
      this.touch();
      this.check();
    };
  }

  snapshot(now = this.now()): LeaseSnapshot {
    const elapsed = Math.max(0, now - this.lastActivityAt);
    return {
      idle_timeout_ms: this.idleTimeoutMs,
      lease_remaining_ms: Math.max(0, this.idleTimeoutMs - elapsed),
      last_activity_at: this.lastActivityAt,
      in_flight: this.holds,
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private check(): void {
    if (this.stopped || this.fired) return;
    if (this.holds > 0) return;
    if (this.now() - this.lastActivityAt < this.idleTimeoutMs) return;
    this.fired = true;
    this.stop();
    try {
      void Promise.resolve(this.onIdle()).catch(() => {
        // shutdown errors are surfaced by the caller's close path
      });
    } catch {
      // synchronous throw from onIdle: nothing else to do here
    }
  }
}

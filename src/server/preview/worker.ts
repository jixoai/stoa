/**
 * 异步预览 worker（design §5，P1-6/P1-7）。
 *
 * - SQLite 持久化队列：重启续跑（`running` 残留重置 queued）；
 * - 单实例锁（meta `preview.worker.lock`，心跳 5s，>30s 陈旧可接管）；
 * - 最新优先（post_created_at DESC）+ 全局并发 3 / 每域名 1；
 * - 多阶段推进：每阶段同事务写字段 + 一条 `post.updated` 事件；
 * - 失败 5m→15m→1h→6h→24h 退避；重处理失败保留旧字段，不降级已展示卡片；
 * - 禁用/退出 abort，任务回 queued（不丢）。
 */
import type { Database } from "bun:sqlite";
import type {
  PhaseFields,
  PreviewErrorCode,
  PreviewPhase,
  PreviewProvider,
  PreviewStatus,
  PreviewTransport,
} from "../../core/plugins/types.ts";
import { get, getMeta, run, setMeta } from "../db.ts";
import type { Store } from "../store.ts";
import {
  claimNext,
  completeJob,
  failJob,
  parseFieldsReady,
  previewQueueStats,
  previewRow,
  releaseJob,
  resetRunningJobs,
  setJobPhase,
  type PreviewJobRow,
  type PreviewQueueStats,
  type PreviewRow,
} from "./queue.ts";
import { PreviewPolicyError } from "./ssrf.ts";
import { PreviewFetchError } from "./fetch.ts";

export const PREVIEW_WORKER_LOCK_KEY = "preview.worker.lock";
export const DEFAULT_PREVIEW_BACKOFF_MS = [
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

export interface PreviewWorkerStats extends PreviewQueueStats {
  processing: number;
  locked: boolean;
  started: boolean;
}

export interface PreviewWorkerOptions {
  store: Store;
  provider: PreviewProvider;
  transport: PreviewTransport;
  instanceId?: string;
  now?: () => number;
  pollMs?: number;
  concurrency?: number;
  perDomain?: number;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  jobTimeoutMs?: number;
  lockTtlMs?: number;
  heartbeatMs?: number;
  enabled?: () => boolean;
  logger?: (line: string) => void;
}

interface Inflight {
  controller: AbortController;
  task: Promise<void>;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}

function fieldsReadyFor(fields: PhaseFields): string[] {
  const ready: string[] = [];
  if (fields.kind !== undefined) ready.push("kind");
  if (fields.mime !== undefined) ready.push("mime");
  if (fields.title !== undefined) ready.push("title");
  if (fields.description !== undefined) ready.push("description");
  if (fields.site_name !== undefined) ready.push("site_name");
  if (fields.cover !== undefined) ready.push("cover");
  return ready;
}

function errorCodeOf(err: unknown): PreviewErrorCode {
  if (err instanceof PreviewPolicyError) return err.code;
  if (err instanceof PreviewFetchError) return err.code;
  return "parse_error";
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class PreviewWorker {
  private readonly store: Store;
  private readonly provider: PreviewProvider;
  private readonly transport: PreviewTransport;
  readonly instanceId: string;
  private readonly now: () => number;
  private readonly pollMs: number;
  readonly concurrency: number;
  readonly perDomain: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: readonly number[];
  private readonly jobTimeoutMs: number;
  private readonly lockTtlMs: number;
  private readonly heartbeatMs: number;
  private readonly enabledFn: () => boolean;
  private readonly logger: (line: string) => void;

  private readonly inflight = new Map<string, Inflight>();
  private readonly activeDomains = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private lockHeld = false;
  private lastError: string | null = null;
  private lastHeartbeatAt = 0;
  private lastHeartbeatBusyLogAt = -Infinity;

  constructor(opts: PreviewWorkerOptions) {
    this.store = opts.store;
    this.provider = opts.provider;
    this.transport = opts.transport;
    this.instanceId = opts.instanceId ?? `preview-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 200;
    this.concurrency = opts.concurrency ?? 3;
    this.perDomain = opts.perDomain ?? 1;
    this.maxAttempts = opts.maxAttempts ?? 6; // N6：5m→15m→1h→6h→24h 五档后退避，第 6 次置 failed
    this.backoffMs = opts.backoffMs ?? DEFAULT_PREVIEW_BACKOFF_MS;
    this.jobTimeoutMs = opts.jobTimeoutMs ?? 30_000;
    this.lockTtlMs = opts.lockTtlMs ?? 30_000;
    this.heartbeatMs = opts.heartbeatMs ?? 5_000;
    this.enabledFn = opts.enabled ?? (() => this.store.pluginEnabled(this.provider.manifest.id));
    this.logger = opts.logger ?? ((line) => console.warn(`[report] ${line}`));
  }

  pluginId(): string {
    return this.provider.manifest.id;
  }

  /** 获取单实例锁并启动轮询；返回 false = 另一实例持有锁（本进程不 claim）。 */
  start(): boolean {
    if (this.started) return true;
    let locked = false;
    try {
      locked = this.acquireLock();
    } catch (err) {
      this.logger(`preview worker lock error: ${(err as Error).message}`);
      return false;
    }
    if (!locked) return false;
    try {
      resetRunningJobs(this.store.db, this.now());
    } catch (err) {
      this.releaseLock();
      this.logger(`preview worker startup error: ${(err as Error).message}`);
      return false;
    }
    this.started = true;
    this.schedule(0);
    if (this.heartbeatTimer === null) {
      // R1：心跳定时器里的 SQLITE_BUSY 绝不能冒泡成未捕获异常。
      this.heartbeatTimer = setInterval(() => this.safeHeartbeat(), this.heartbeatMs);
    }
    return true;
  }

  private safeHeartbeat(): void {
    try {
      this.heartbeat();
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (/database is locked|SQLITE_BUSY|busy/i.test(message)) {
        const now = this.now();
        if (now - this.lastHeartbeatBusyLogAt >= 60_000) {
          this.lastHeartbeatBusyLogAt = now;
          this.logger("preview worker heartbeat busy (database is locked); retrying");
        }
      } else {
        this.logger(`preview worker heartbeat error: ${message}`);
      }
    }
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const entry of this.inflight.values()) entry.controller.abort();
    this.releaseLock();
  }

  /** 插件关闭/管理员中断：abort 在飞任务（catch 里回 queued），不停止进程。 */
  abortAll(): void {
    for (const entry of this.inflight.values()) entry.controller.abort();
  }

  stats(): PreviewWorkerStats {
    const queue = previewQueueStats(this.store.db);
    return {
      ...queue,
      last_error: this.lastError ?? queue.last_error,
      processing: this.inflight.size,
      locked: this.lockHeld,
      started: this.started,
    };
  }

  // ── scheduling ─────────────────────────────────────────────────────────────
  private schedule(delay = this.pollMs): void {
    if (!this.started || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, Math.max(0, delay));
    this.timer.unref?.();
  }

  private tick(): void {
    if (!this.started) return;
    try {
      this.heartbeat();
      if (this.enabledFn()) {
        const free = Math.max(0, this.concurrency - this.inflight.size);
        if (free > 0) {
          const jobs = claimNext(this.store.db, { now: this.now(), limit: free });
          for (const job of jobs) this.launch(job);
        }
      }
      this.schedule();
    } catch (err) {
      // N5：跨进程/长事务下 claim 可能抛 SQLITE_BUSY；定时器里绝不能冒泡。
      const message = (err as Error).message ?? String(err);
      const busy = /database is locked|SQLITE_BUSY|busy/i.test(message);
      this.logger(
        busy
          ? "preview worker tick busy (database is locked); backing off"
          : `preview worker tick error: ${message}`,
      );
      this.schedule(Math.max(this.pollMs, busy ? 250 : 500));
    }
  }

  /** 等待在飞任务完成 abort 后的回队（stop 之后、关库之前调用）。 */
  async drain(timeoutMs = 1500): Promise<void> {
    const tasks = [...this.inflight.values()].map((entry) => entry.task);
    if (tasks.length === 0) return;
    await Promise.race([
      Promise.allSettled(tasks).then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  private launch(job: PreviewJobRow): void {
    const row = previewRow(this.store.db, job.post_id, job.url_hash);
    if (!row) {
      completeJob(this.store.db, job.post_id, job.url_hash);
      return;
    }
    const domain = domainOf(row.url);
    if ((this.activeDomains.get(domain) ?? 0) >= this.perDomain) {
      releaseJob(this.store.db, job.post_id, job.url_hash, this.now());
      return;
    }
    this.activeDomains.set(domain, (this.activeDomains.get(domain) ?? 0) + 1);
    const controller = new AbortController();
    const key = `${job.post_id}\0${job.url_hash}`;
    const task = this.runJob(job, row, controller)
      .catch((err: unknown) => {
        this.logger(`preview worker job failed (${job.post_id.slice(0, 8)}): ${(err as Error).message}`);
      })
      .finally(() => {
        this.activeDomains.set(domain, Math.max(0, (this.activeDomains.get(domain) ?? 1) - 1));
        this.inflight.delete(key);
        this.schedule(0);
      });
    this.inflight.set(key, { controller, task });
  }

  private async runJob(
    job: PreviewJobRow,
    row: PreviewRow,
    controller: AbortController,
  ): Promise<void> {
    const db = this.store.db;
    const post = this.store.previewPost(job.post_id);
    if (!post || post.deleted_at !== null) {
      completeJob(db, job.post_id, job.url_hash);
      return;
    }
    if (!this.enabledFn()) {
      releaseJob(db, job.post_id, job.url_hash, this.now());
      return;
    }
    this.store.adoptPreviewCacheKey(job.post_id, job.url_hash, job.cache_key);
    const link = { url: row.url, position: row.position, label: row.label };
    const phases = this.provider.phases(link);
    const ctx = {
      signal: controller.signal,
      deadlineAt: this.now() + this.jobTimeoutMs,
      transport: this.transport,
      policy: { allowed_ports: [80, 443, 8080, 8443] as const, max_page_bytes: 512 * 1024, max_media_bytes: 64 * 1024 },
      cache: new Map<string, unknown>(),
    };
    for (let index = 0; index < phases.length; index += 1) {
      const phase: PreviewPhase = phases[index]!;
      if (!this.enabledFn()) {
        releaseJob(db, job.post_id, job.url_hash, this.now());
        return;
      }
      const fresh = previewRow(db, job.post_id, job.url_hash);
      if (!fresh || fresh.cache_key !== job.cache_key) {
        releaseJob(db, job.post_id, job.url_hash, this.now());
        return;
      }
      const alive = this.store.previewPost(job.post_id);
      if (!alive || alive.deleted_at !== null) {
        completeJob(db, job.post_id, job.url_hash);
        return;
      }
      setJobPhase(db, job.post_id, job.url_hash, phase, this.now());
      let result;
      try {
        result = await this.provider.resolvePhase(link, phase, ctx);
      } catch (err) {
        if (controller.signal.aborted) {
          releaseJob(db, job.post_id, job.url_hash, this.now());
          return;
        }
        const code = errorCodeOf(err);
        const status = this.statusAfterError(fresh);
        this.store.applyPreviewPhase({
          postId: job.post_id,
          urlHash: job.url_hash,
          cacheKey: job.cache_key,
          phase,
          fields: {},
          status,
          errorCode: code,
          attempts: job.attempts,
        });
        this.fail(job, code);
        return;
      }
      const status: PreviewStatus = result.errorCode
        ? this.statusAfterError(fresh)
        : index === phases.length - 1
          ? "ready"
          : "partial";
      const previews = this.store.applyPreviewPhase({
        postId: job.post_id,
        urlHash: job.url_hash,
        cacheKey: job.cache_key,
        phase,
        fields: result.fields,
        fieldsReady: fieldsReadyFor(result.fields),
        status,
        errorCode: result.errorCode ?? null,
        attempts: job.attempts,
      });
      if (previews === null) {
        // 行/帖子被删或 cacheKey 已被新任务替换：停止本任务（不覆盖新值）。
        const gone = this.store.previewPost(job.post_id);
        if (!gone || gone.deleted_at !== null) completeJob(db, job.post_id, job.url_hash);
        else releaseJob(db, job.post_id, job.url_hash, this.now());
        return;
      }
      if (result.errorCode) {
        // 有旧字段：卡片保持 partial/ready，job 退避重试；无字段：failed 后重试。
        this.fail(job, result.errorCode);
        return;
      }
    }
    completeJob(db, job.post_id, job.url_hash);
  }

  private statusAfterError(row: PreviewRow): PreviewStatus {
    const hasFields = parseFieldsReady(row.fields_ready).length > 0;
    if (row.status === "ready") return "ready";
    if (row.status === "partial" || hasFields) return "partial";
    return "failed";
  }

  private fail(job: PreviewJobRow, code: PreviewErrorCode): void {
    this.lastError = code;
    failJob(this.store.db, {
      postId: job.post_id,
      urlHash: job.url_hash,
      error: code,
      now: this.now(),
      backoffMs: this.backoffMs,
      maxAttempts: this.maxAttempts,
    });
  }

  // ── single-instance lock ───────────────────────────────────────────────────
  private acquireLock(): boolean {
    const db: Database = this.store.db;
    const raw = getMeta(db, PREVIEW_WORKER_LOCK_KEY);
    const now = this.now();
    if (raw) {
      try {
        const lock = JSON.parse(raw) as { instanceId?: string; heartbeatAt?: number; pid?: number };
        if (typeof lock.instanceId === "string" && lock.instanceId !== this.instanceId) {
          // 进程已死（崩溃重启）可立即接管；同进程的第二个 worker 仍被拒绝。
          const ownerAlive = typeof lock.pid === "number" ? pidAlive(lock.pid) : true;
          const fresh =
            typeof lock.heartbeatAt === "number" && now - lock.heartbeatAt < this.lockTtlMs;
          if (ownerAlive && fresh) return false;
        }
      } catch {
        // 损坏的锁按陈旧处理
      }
    }
    try {
      setMeta(
        db,
        PREVIEW_WORKER_LOCK_KEY,
        JSON.stringify({
          pid: process.pid,
          instanceId: this.instanceId,
          startedAt: now,
          heartbeatAt: now,
        }),
      );
    } catch (err) {
      // R2：启动瞬间数据库被外部写锁占用时，返回 false 而不是抛给调用方。
      this.logger(`preview worker lock busy: ${(err as Error).message}`);
      return false;
    }
    this.lockHeld = true;
    this.lastHeartbeatAt = now;
    return true;
  }

  private heartbeat(): void {
    if (!this.lockHeld) return;
    const now = this.now();
    if (now - this.lastHeartbeatAt < this.heartbeatMs) return;
    this.lastHeartbeatAt = now;
    let startedAt = now;
    try {
      const raw = getMeta(this.store.db, PREVIEW_WORKER_LOCK_KEY);
      const parsed = raw ? (JSON.parse(raw) as { startedAt?: number }) : {};
      startedAt = typeof parsed.startedAt === "number" ? parsed.startedAt : now;
    } catch {
      startedAt = now;
    }
    setMeta(
      this.store.db,
      PREVIEW_WORKER_LOCK_KEY,
      JSON.stringify({
        pid: process.pid,
        instanceId: this.instanceId,
        startedAt,
        heartbeatAt: now,
      }),
    );
  }

  private releaseLock(): void {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    const raw = getMeta(this.store.db, PREVIEW_WORKER_LOCK_KEY);
    if (!raw) return;
    try {
      const lock = JSON.parse(raw) as { instanceId?: string };
      if (lock.instanceId !== this.instanceId) return;
    } catch {
      // 损坏锁直接清
    }
    try {
      run(this.store.db, "DELETE FROM meta WHERE key = ?", PREVIEW_WORKER_LOCK_KEY);
    } catch (err) {
      // R2：关停阶段数据库已锁/已关时不冒泡（下次启动按陈旧锁接管）。
      this.logger(`preview worker unlock error: ${(err as Error).message}`);
    }
  }
}

/** 测试辅助：判断 meta 里是否还有 worker 锁。 */
export function previewWorkerLock(db: Database): { instanceId?: string; heartbeatAt?: number } | null {
  const row = get<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", PREVIEW_WORKER_LOCK_KEY);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as { instanceId?: string; heartbeatAt?: number };
  } catch {
    return null;
  }
}

/**
 * 预览服务门面（design §2.3 / §13.2，P1-11）。
 *
 * - 启动/启用时扫描 cacheKey 不匹配或缺 `post_previews` 行的帖子，按
 *   `post_created_at DESC` 入队；旧字段一律保留；
 * - 插件开关：关闭 → worker 停止 claim/abort 在飞任务（0 抓取/0 入队）；
 *   打开 → 扫描 + 重启 worker（同版本已有字段不会重抓）；
 * - 组合 worker stats / PluginView（API 与设置页的唯一数据源）。
 */
import { builtinPlugin } from "../../core/plugins/builtin.ts";
import type {
  PluginDependencyView,
  PluginView,
  PreviewProvider,
  PreviewTransport,
} from "../../core/plugins/types.ts";
import { all, get } from "../db.ts";
import type { Store } from "../store.ts";
import { bodyHash, previewPluginVersion, previewRulesVersion, PREVIEW_LIMITS } from "./link-preview/provider.ts";
import { hashUrl, enqueueJobOnly, type PreviewRow } from "./queue.ts";
import { claimPreviewBudget, nextPreviewBudgetWindow } from "./budget.ts";
import { indexPostPreviewLinks } from "./indexer.ts";
import { PreviewWorker } from "./worker.ts";

export interface PreviewScanResult {
  scanned: number;
  enqueued: number;
}

export interface PreviewServiceOptions {
  store: Store;
  provider: PreviewProvider;
  transport: PreviewTransport;
  instanceId?: string;
  now?: () => number;
  /** `FDE2E_REPORT_PREVIEW_WORKER=0` 关闭 worker（测试/只读场景）。 */
  workerEnabled?: boolean;
  /** 扫描分批间隔（design §13.2：100 条 + 250ms；测试传 0）。 */
  scanBatchDelayMs?: number;
  /** 每批候选数（design §13.2：100 条/批）。 */
  scanBatchSize?: number;
  /** 透传给 worker（测试注入短轮询/并发）。 */
  workerOptions?: {
    pollMs?: number;
    concurrency?: number;
    perDomain?: number;
    backoffMs?: readonly number[];
    maxAttempts?: number;
    jobTimeoutMs?: number;
    lockTtlMs?: number;
    heartbeatMs?: number;
    instanceId?: string;
    enabled?: () => boolean;
  };
  env?: Record<string, string | undefined>;
  /** `/healthz.preview_policy` 审计信息（仅布尔，不暴露白名单 origin）。 */
  policy?: { test_allowlist_enabled: boolean; exposed: boolean };
}

export class PreviewService {
  readonly store: Store;
  readonly provider: PreviewProvider;
  readonly worker: PreviewWorker;
  private readonly env: Record<string, string | undefined>;
  private readonly workerEnabled: boolean;
  private readonly scanBatchDelayMs: number;
  private readonly scanBatchSize: number;
  private readonly policy: { test_allowlist_enabled: boolean; exposed: boolean };
  private readonly now: () => number;
  private scanning: Promise<PreviewScanResult> | null = null;

  constructor(opts: PreviewServiceOptions) {
    this.store = opts.store;
    this.provider = opts.provider;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.workerEnabled = opts.workerEnabled !== false;
    this.scanBatchDelayMs = opts.scanBatchDelayMs ?? 250;
    this.scanBatchSize = opts.scanBatchSize ?? 100;
    this.policy = opts.policy ?? { test_allowlist_enabled: false, exposed: false };
    this.worker = new PreviewWorker({
      store: opts.store,
      provider: opts.provider,
      transport: opts.transport,
      instanceId: opts.workerOptions?.instanceId ?? opts.instanceId,
      now: opts.now,
      pollMs: opts.workerOptions?.pollMs,
      concurrency: opts.workerOptions?.concurrency,
      perDomain: opts.workerOptions?.perDomain,
      backoffMs: opts.workerOptions?.backoffMs,
      maxAttempts: opts.workerOptions?.maxAttempts,
      jobTimeoutMs: opts.workerOptions?.jobTimeoutMs,
      lockTtlMs: opts.workerOptions?.lockTtlMs,
      heartbeatMs: opts.workerOptions?.heartbeatMs,
      enabled: opts.workerOptions?.enabled ?? (() => this.store.pluginEnabled(this.provider.manifest.id)),
    });
  }

  /** serve ready 后调用（导出/静态路径不调用）。 */
  start(): void {
    if (!this.workerEnabled) return;
    if (!this.store.pluginEnabled(this.provider.manifest.id)) return;
    void this.scanStale();
    this.worker.start();
  }

  async stop(): Promise<void> {
    this.worker.stop();
    await this.worker.drain(1500);
  }

  abortAll(): void {
    this.worker.abortAll();
  }

  enabled(): boolean {
    return this.store.pluginEnabled(this.provider.manifest.id);
  }

  setEnabled(enabled: boolean, actor: string): PluginView {
    this.store.setPluginEnabled(this.provider.manifest.id, enabled, actor);
    if (enabled) {
      if (this.workerEnabled) {
        void this.scanStale();
        this.worker.start();
      }
    } else {
      this.worker.abortAll();
      this.worker.stop();
    }
    return this.pluginView();
  }

  stats() {
    return this.worker.stats();
  }

  policySnapshot(): {
    test_allowlist_enabled: boolean;
    exposed: boolean;
    worker_enabled: boolean;
  } {
    return { ...this.policy, worker_enabled: this.workerEnabled };
  }

  /** 扫描 cacheKey 不匹配 + 缺少字段行的帖子，倒序入队；不并发扫描。 */
  scanStale(): Promise<PreviewScanResult> {
    if (this.scanning) return this.scanning;
    this.scanning = this.runScan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async runScan(): Promise<PreviewScanResult> {
    if (!this.enabled()) return { scanned: 0, enqueued: 0 };
    const db = this.store.db;
    const pluginVersion = previewPluginVersion(this.env);
    const rulesVersion = previewRulesVersion(this.env);
    const batchSize = Math.max(1, this.scanBatchSize);
    const now = this.now();
    let scanned = 0;
    let enqueued = 0;
    let deferredCount = 0;
    const limited = { account_budget: 0, global_budget: 0 };

    type StaleRow = PreviewRow & {
      author: string;
      body_md: string;
      post_created_at: number;
      deleted_at: number | null;
    };
    // 分批 keyset（design §13.2：100 条/批 + 250ms 间隔），不整体装载全表。
    let staleCursor: { createdAt: number; id: string; position: number } | null = null;
    for (;;) {
      if (!this.enabled()) return { scanned, enqueued };
      const batch: StaleRow[] = staleCursor
        ? all<StaleRow>(
            db,
            `SELECT pp.*, p.author, p.body_md, p.created_at AS post_created_at, p.deleted_at
             FROM post_previews pp JOIN posts p ON p.id = pp.post_id
             WHERE p.deleted_at IS NULL
               AND (p.created_at < ? OR (p.created_at = ? AND
                    (p.id < ? OR (p.id = ? AND pp.position > ?))))
             ORDER BY p.created_at DESC, p.id DESC, pp.position ASC
             LIMIT ?`,
            staleCursor.createdAt,
            staleCursor.createdAt,
            staleCursor.id,
            staleCursor.id,
            staleCursor.position,
            batchSize,
          )
        : all<StaleRow>(
            db,
            `SELECT pp.*, p.author, p.body_md, p.created_at AS post_created_at, p.deleted_at
             FROM post_previews pp JOIN posts p ON p.id = pp.post_id
             WHERE p.deleted_at IS NULL
             ORDER BY p.created_at DESC, p.id DESC, pp.position ASC
             LIMIT ?`,
            batchSize,
          );
      if (batch.length === 0) break;
      for (const row of batch) {
        if (!this.enabled()) return { scanned, enqueued };
        scanned += 1;
        const expected = this.provider.buildCacheKey({
          canonicalUrl: row.url,
          bodyHash: bodyHash(row.body_md),
          pluginId: this.provider.manifest.id,
          pluginVersion,
          rulesVersion,
        });
        if (row.cache_key === expected) continue;
        // 任务去重：同 key 的 queued/running 任务已存在时不重复计数/重置。
        const existing = get<{ cache_key: string; status: string }>(
          db,
          "SELECT cache_key, status FROM preview_jobs WHERE post_id = ? AND url_hash = ?",
          row.post_id,
          hashUrl(row.url),
        );
        if (existing && existing.cache_key === expected && existing.status !== "failed") continue;
        const budget = claimPreviewBudget(db, {
          accountId: row.author,
          count: 1,
          now,
        });
        if (budget.granted < 1) {
          // R3：不丢链接——job 写入但延迟到下一预算窗口。
          limited[budget.reason === "global_budget" ? "global_budget" : "account_budget"] += 1;
          deferredCount += 1;
        }
        const jobNow = now;
        enqueueJobOnly(db, {
          postId: row.post_id,
          urlHash: hashUrl(row.url),
          cacheKey: expected,
          postCreatedAt: row.post_created_at,
          now: jobNow,
          nextRunAt: budget.granted >= 1 ? jobNow : nextPreviewBudgetWindow(now),
        });
        enqueued += 1;
      }
      const last: StaleRow = batch[batch.length - 1]!;
      staleCursor = {
        createdAt: last.post_created_at,
        id: last.post_id,
        position: last.position,
      };
      if (batch.length < batchSize) break;
      if (this.scanBatchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.scanBatchDelayMs));
      }
    }

    // 插件关闭期间发布/从未索引的帖子：有 http 链接但无 post_previews 行（同样分批）。
    let missingCursor: { createdAt: number; id: string } | null = null;
    for (;;) {
      if (!this.enabled()) return { scanned, enqueued };
      const batch: Array<{ id: string; author: string; body_md: string; created_at: number }> = missingCursor
        ? all<{ id: string; author: string; body_md: string; created_at: number }>(
            db,
            `SELECT p.id, p.author, p.body_md, p.created_at FROM posts p
             WHERE p.deleted_at IS NULL
               AND p.body_md LIKE '%http%'
               AND NOT EXISTS (SELECT 1 FROM post_previews pp WHERE pp.post_id = p.id)
               AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))
             ORDER BY p.created_at DESC, p.id DESC
             LIMIT ?`,
            missingCursor.createdAt,
            missingCursor.createdAt,
            missingCursor.id,
            batchSize,
          )
        : all<{ id: string; author: string; body_md: string; created_at: number }>(
            db,
            `SELECT p.id, p.author, p.body_md, p.created_at FROM posts p
             WHERE p.deleted_at IS NULL
               AND p.body_md LIKE '%http%'
               AND NOT EXISTS (SELECT 1 FROM post_previews pp WHERE pp.post_id = p.id)
             ORDER BY p.created_at DESC, p.id DESC
             LIMIT ?`,
            batchSize,
          );
      if (batch.length === 0) break;
      for (const post of batch) {
        if (!this.enabled()) return { scanned, enqueued };
        scanned += 1;
        try {
          const inserted = indexPostPreviewLinks(db, {
            post,
            now,
            pluginId: this.provider.manifest.id,
            onBudgetLimited: (reason) => {
              if (reason === "account_budget") limited.account_budget += 1;
              else if (reason === "global_budget") limited.global_budget += 1;
              deferredCount += 1;
            },
          });
          if (inserted > 0) enqueued += inserted;
        } catch {
          // 单帖抽取失败不阻断扫描（indexer 内部已记固定错误码日志）
        }
      }
      const last: { id: string; author: string; body_md: string; created_at: number } = batch[batch.length - 1]!;
      missingCursor = { createdAt: last.created_at, id: last.id };
      if (batch.length < batchSize) break;
      if (this.scanBatchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.scanBatchDelayMs));
      }
    }

    if (deferredCount > 0) {
      console.warn(
        `[report] preview scan deferred ${deferredCount} enqueue(s): ` +
          `account_budget=${limited.account_budget} global_budget=${limited.global_budget}`,
      );
    }
    return { scanned, enqueued };
  }

  pluginView(): PluginView {
    const manifest = this.provider.manifest;
    const stats = this.worker.stats();
    const requires: PluginDependencyView[] = (manifest.requires ?? []).map((dep) => {
      const builtin = builtinPlugin(dep.id);
      return {
        ...dep,
        status: builtin ? (this.store.pluginEnabled(dep.id) ? "enabled" : "disabled") : "missing",
      };
    });
    const viewerBase = this.env.FDE2E_FILEVIEWER_BASE?.trim();
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: previewPluginVersion(this.env),
      rules_version: previewRulesVersion(this.env),
      kind: manifest.kind,
      capabilities: manifest.capabilities,
      enabled: this.store.pluginEnabled(manifest.id),
      default_enabled: manifest.defaultEnabled,
      requires,
      viewer_base: viewerBase && viewerBase ? viewerBase : null,
      worker: {
        queued: stats.queued,
        running: stats.running,
        ready: stats.ready,
        partial: stats.partial,
        failed: stats.preview_failed,
      },
      limits: { ...PREVIEW_LIMITS },
    };
  }
}

/**
 * daemon 按需预览（stoa-stopped-preview design v2 §1.1/§1.4）。
 *
 * 已停止实例的内容不可达问题由「静态归档 + 构建缓存」解决：整个导出读路径只碰
 * dataDir 磁盘，实例停止时天然可用（零端口占用、零口令）。
 *
 * 独立产物目录（F3）：预览写 `<dataDir>/export-preview`（显式 outDir），与实例自身
 * auto-export 的 `<dataDir>/export` 完全隔离——两者不再竞争同一个 `rename(2)` 目标
 * （共享目录时对非空目录 rename 会 ENOTEMPTY，必有一方失败且可能丢 history）；
 * 显式 outDir ⇒ `isDefaultOut=false`，预览目录没有 history 机制，只需「一份当前归档」。
 *
 * 缓存判定（design v2 §1.4，单一信源）：
 *   cached = manifest != null
 *         && manifest.rev === dataRevision(dataDir)   // 数据本体自证（同一事务口径）
 *         && manifest.ui_version === VERSION          // 前端构建版本变化后自动重生成
 *         && manifest.viewer === "owner"              // 运行中实例 auto-export / CLI --as 会写他人切片
 *         && existsSync(<previewDir>/index.html)      // 产物完整
 * 命中则不重跑导出；未命中/force 时走 `runExport`（owner 切片）。
 *
 * 并发：同一 service 的 ensure 合流到同一个 Promise（单飞），完成后移除；
 * 不同 service 各自独立。导出全同步执行（大媒体会短暂占用 daemon 事件循环，design §5 登记）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../core/protocol.ts";
import {
  cleanupStaleExports,
  dataRevision,
  readExportManifest,
  runExport,
  type ExportOptions,
  type ExportResult,
} from "../server/export.ts";
import type { ServiceRecord } from "./state.ts";

/** ensurePreview 只需要 daemon 的前端构建目录（结构化兼容 DaemonContext）。 */
export interface PreviewContext {
  uiDir: string | null;
}

export interface PreviewOptions {
  /** 忽略缓存强制重生成（运维/测试用；并发时仍合流到进行中的那次）。 */
  force?: boolean;
  /** 测试 seam：替换导出实现（默认 runExport）。 */
  runExportFn?: (opts: ExportOptions) => ExportResult;
  /** 测试 seam：替换修订读取（默认 dataRevision）。 */
  dataRevisionFn?: (dataDir: string) => string;
}

export interface PreviewResult {
  /** 本次是否命中缓存（true = 没有执行导出）。 */
  cached: boolean;
  rev: string;
  as_of_seq: number;
  exported_at: number;
  /** 归档产物根（`<dataDir>/export-preview`）。 */
  dir: string;
  /** 本次 ensure 的墙钟耗时（命中时为毫秒级）。 */
  duration_ms: number;
}

/** 预览独立产物目录名（F3：与实例 auto-export 的 `export/` 隔离）。 */
export const PREVIEW_EXPORT_DIR_NAME = "export-preview";

/** 预览归档目录：显式 outDir，不与 `stoa export` 默认 out（`export/`）共用。 */
export function previewExportDir(service: Pick<ServiceRecord, "dataDir">): string {
  return join(service.dataDir, PREVIEW_EXPORT_DIR_NAME);
}

/** 单飞登记：serviceId → 进行中的 ensure。完成后移除。 */
const inflight = new Map<string, Promise<PreviewResult>>();

/**
 * 确保该服务的静态预览已就绪（必要时生成），返回元信息。
 *
 * 单飞：并发调用共享同一次导出（即便带 force 也合流，避免两次原子换目录互踩）；
 * 导出完成后的后续调用按 manifest 判定缓存。
 */
export function ensurePreview(
  ctx: PreviewContext,
  service: Pick<ServiceRecord, "id" | "dataDir">,
  opts: PreviewOptions = {},
): Promise<PreviewResult> {
  const pending = inflight.get(service.id);
  if (pending) return pending;
  const task = runEnsure(ctx, service, opts).finally(() => {
    // 只有自己仍是当前登记时才清（防御性：正常情况下 key 上只会有一个 task）。
    if (inflight.get(service.id) === task) inflight.delete(service.id);
  });
  inflight.set(service.id, task);
  return task;
}

async function runEnsure(
  ctx: PreviewContext,
  service: Pick<ServiceRecord, "id" | "dataDir">,
  opts: PreviewOptions,
): Promise<PreviewResult> {
  const started = Date.now();
  // daemon 侧没有导出生命周期钩子：ensure 入口顺手回收崩溃残留
  // （`.export-tmp-*` / `.export-history-hold-*` / `<out>.old-*`，仅 >1h 的条目）。
  cleanupStaleExports(service.dataDir);
  const readRevision = opts.dataRevisionFn ?? dataRevision;
  const exportFn = opts.runExportFn ?? runExport;
  const dir = previewExportDir(service);
  const rev = readRevision(service.dataDir);

  if (!opts.force) {
    const manifest = readExportManifest(dir);
    const cached =
      manifest !== null &&
      manifest.rev === rev &&
      manifest.ui_version === VERSION &&
      manifest.viewer === "owner" &&
      existsSync(join(dir, "index.html"));
    if (cached) {
      return {
        cached: true,
        rev: manifest.rev,
        as_of_seq: manifest.as_of_seq,
        exported_at: manifest.exported_at,
        dir,
        duration_ms: Date.now() - started,
      };
    }
  }

  const result = exportFn({
    dataDir: service.dataDir,
    // 显式 outDir：独立目录、无 history（isDefaultOut=false），与实例 auto-export 零竞争。
    outDir: dir,
    viewer: "owner",
    uiDir: ctx.uiDir ?? null,
  });
  // 导出器保证 manifest 与 index.html 同批换入；万一被外部清掉，用返回值兜底。
  const manifest = readExportManifest(dir);
  return {
    cached: false,
    rev: manifest?.rev ?? result.rev ?? rev,
    as_of_seq: manifest?.as_of_seq ?? result.as_of_seq,
    exported_at: manifest?.exported_at ?? Date.now(),
    dir,
    duration_ms: Date.now() - started,
  };
}

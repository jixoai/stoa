/**
 * 入队预算（spec「资源与滥用限制」/ design §6.6）：每账号 60 次/小时、
 * 全局 500 次/小时（按「入队链接数」计）。窗口计数持久化在 meta，
 * 与写入事务同库；超限跳过入队并返回固定原因码（调用方只记错误码/日志）。
 */
import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "../db.ts";

export const PREVIEW_ACCOUNT_HOURLY_LIMIT = 60;
export const PREVIEW_GLOBAL_HOURLY_LIMIT = 500;
export const PREVIEW_BUDGET_WINDOW_MS = 60 * 60_000;

export type PreviewBudgetReason = "ok" | "account_budget" | "global_budget";

/** 下一个预算窗口起点（未授权链接延迟入队用，R3）。 */
export function nextPreviewBudgetWindow(now: number): number {
  return (Math.floor(now / PREVIEW_BUDGET_WINDOW_MS) + 1) * PREVIEW_BUDGET_WINDOW_MS;
}

export interface PreviewBudgetGrant {
  granted: number;
  reason: PreviewBudgetReason;
}

interface WindowCounter {
  window: number;
  count: number;
}

function windowOf(now: number): number {
  return Math.floor(now / PREVIEW_BUDGET_WINDOW_MS);
}

function readCounter(db: Database, key: string, window: number): WindowCounter {
  const raw = getMeta(db, key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<WindowCounter>;
      if (parsed.window === window && typeof parsed.count === "number" && parsed.count >= 0) {
        return { window, count: Math.floor(parsed.count) };
      }
    } catch {
      // 损坏计数按新窗口处理
    }
  }
  return { window, count: 0 };
}

/**
 * 申请 `count` 个入队名额；返回实际批准数。计数在同一事务里递增，
 * 超限部分不入队（调用方跳过并记固定原因）。
 */
export function claimPreviewBudget(
  db: Database,
  input: { accountId: string; count: number; now: number },
): PreviewBudgetGrant {
  const count = Math.max(0, Math.floor(input.count));
  if (count === 0) return { granted: 0, reason: "ok" };
  const window = windowOf(input.now);
  const accountKey = `preview.budget.account.${input.accountId}`;
  const globalKey = "preview.budget.global"; // global 是关键词，这里只是字符串键
  const account = readCounter(db, accountKey, window);
  const global = readCounter(db, globalKey, window);
  const accountRemaining = Math.max(0, PREVIEW_ACCOUNT_HOURLY_LIMIT - account.count);
  const globalRemaining = Math.max(0, PREVIEW_GLOBAL_HOURLY_LIMIT - global.count);
  const granted = Math.min(count, accountRemaining, globalRemaining);
  if (granted > 0) {
    setMeta(
      db,
      accountKey,
      JSON.stringify({ window, count: account.count + granted }),
    );
    setMeta(
      db,
      globalKey,
      JSON.stringify({ window, count: global.count + granted }),
    );
  }
  if (granted === count) return { granted, reason: "ok" };
  return {
    granted,
    reason: accountRemaining <= globalRemaining ? "account_budget" : "global_budget",
  };
}

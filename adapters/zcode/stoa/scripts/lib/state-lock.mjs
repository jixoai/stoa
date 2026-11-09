/**
 * state 文件互斥锁：watch 常驻订阅与 Stop 钩子共用同一份本地游标，
 * 「读 last → poll → 写 last」必须整段互斥，否则两路会同时读到旧游标、
 * 同时轮询到同一批事件并各自投递一次（重复注入）。
 *
 * 语义（对齐 stoa-adapters 修复规格）：
 *  - 锁文件＝`<state 文件>.lock`，`writeFileSync(..., { flag: "wx" })` 原子创建，
 *    内容 JSON `{pid, at, nonce, host}`（pid+时间戳用于诊断与陈旧判定）。
 *  - 锁已存在时：锁龄 > `STALE_LOCK_MS`（默认 40s）视为陈旧 → 抢占（删除后重试，
 *    最多 3 次防活锁）；否则每 50ms 重试，等待超过 `timeoutMs`（默认 20s）→ **降级**：
 *    不加锁继续，并回调 `onDegrade`（调用方在 stderr 说明；保活性优先，并发窗口内可能重复投递）。
 *  - release 只在锁仍属于本进程（nonce 匹配）时删除，绝不误删抢占者的锁。
 *  - 无第三方依赖；锁文件 0600，目录 0700。
 *
 * 阈值依据（P2-4）：锁的持有区间是「读 last → poll → 写 last」整段——首轮可能覆盖
 * `initLocalState`（/api/cursor，10s 超时）＋ poll（10s 超时），服务端长轮询单次上限
 * 25s（src/server/http.ts 的 wait 截止）。旧值 10s 与单次请求超时同量级，会在合法请求
 * 尚未返回时误判陈旧并抢占，反而制造两路并发投递。40s = 25s 长轮询上限 + 首轮 init/
 * 写盘/网络余量。`STOA_STATE_LOCK_STALE_MS` 可注入正数覆盖（冒烟用小阈值快速验证抢占）。
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

const DEFAULT_STALE_LOCK_MS = 40_000;
/** 陈旧阈值（ms）：默认 40s；`STOA_STATE_LOCK_STALE_MS` 正数可覆盖（测试注入用）。 */
export const STALE_LOCK_MS = (() => {
  const raw = Number(process.env.STOA_STATE_LOCK_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_LOCK_MS;
})();
export const DEFAULT_LOCK_TIMEOUT_MS = 20_000;
const RETRY_MS = 50;
const MAX_PREEMPTIONS = 3;

export function lockPathFor(statePath) {
  return `${statePath}.lock`;
}

function readLockInfo(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** 锁龄：优先用锁内 `at` 时间戳，读不到时退回文件 mtime。 */
function lockAgeMs(path, info) {
  const at = Number(info?.at);
  if (Number.isFinite(at) && at > 0) return Date.now() - at;
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return STALE_LOCK_MS + 1;
  }
}

function tryCreate(path, payload) {
  try {
    writeFileSync(path, `${JSON.stringify(payload)}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * 获取 state 锁，返回 release()（降级时返回空操作）。
 * @param {string} statePath
 * @param {{timeoutMs?: number, onDegrade?: (info: {path: string, holder: unknown, ageMs: number}) => void}} [opts]
 */
export async function acquireStateLock(statePath, opts = {}) {
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0 ? opts.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const path = lockPathFor(statePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(8).toString("hex");
  const payload = { pid: process.pid, at: Date.now(), nonce, host: hostname() };
  const deadline = Date.now() + timeoutMs;
  let preemptions = 0;

  for (;;) {
    if (tryCreate(path, payload)) {
      return () => {
        const info = readLockInfo(path);
        if (info?.nonce === nonce) {
          try {
            rmSync(path, { force: true });
          } catch {
            /* 已被别人清掉：正常 */
          }
        }
      };
    }
    const info = readLockInfo(path);
    const ageMs = lockAgeMs(path, info);
    if (ageMs > STALE_LOCK_MS && preemptions < MAX_PREEMPTIONS) {
      preemptions += 1;
      try {
        rmSync(path, { force: true });
      } catch {
        /* 竞争者已先删：下一轮重试 */
      }
      continue;
    }
    if (Date.now() >= deadline) {
      opts.onDegrade?.({ path, holder: info, ageMs });
      return () => {};
    }
    await sleep(RETRY_MS);
  }
}

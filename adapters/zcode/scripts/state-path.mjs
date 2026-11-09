#!/usr/bin/env node
/**
 * 打印本会话的 watch state 文件路径（供 commands/report-channel.md 的 shell 展开使用）。
 * 规则由 lib/config.mjs 的 sessionStateFileName 提供——stop-wait.mjs（Stop 钩子）复用同一派生，
 * 同一会话的常驻订阅与钩子等待共用一份游标。
 *
 * 规则：
 *   base    = ~/.local/state/stoa/report-channel/<hash(baseUrl|account)>.json
 *             （旧目录 ~/.local/state/fde2e/report-channel/ 同名文件按存在性回退，游标零迁移）
 *   session = ZCODE_SESSION_ID | CLAUDE_SESSION_ID | CLAUDE_CODE_SESSION_ID
 *   有会话 ID → <base>-<hash(session)>.json（每个 ZCode 会话独立游标）
 *   无会话 ID → base（与 watch.mjs 的默认路径一致）
 *
 * 用法：
 *   node scripts/state-path.mjs            # 只打印 state 路径
 *   node scripts/state-path.mjs --json     # {path, baseUrl, account, sessionScoped}
 *   node scripts/state-path.mjs --command  # 直接可后台运行的 watch 命令
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveStatePath, sessionId, sessionStateFileName } from "./lib/config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const path = resolveStatePath(sessionStateFileName(cfg));

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({
      path,
      baseUrl: cfg.baseUrl,
      account: cfg.account,
      sessionScoped: Boolean(sessionId()),
    }),
  );
} else if (process.argv.includes("--command")) {
  console.log(
    `node "${join(HERE, "watch.mjs")}" --state-file "${path}" --max-seconds 1500`,
  );
} else {
  console.log(path);
}

/**
 * `/stoa` host command for the dsh host half (S3; design §2).
 *
 * Grammar: `/stoa` (=on, idempotent), `/stoa status`, `/stoa off`,
 * `/stoa subagents=on|off`. The handler runs against the session's agent and
 * returns only a UI result (`{kind:'success'|'error', text}`) — dsh renders it
 * outside model history, so a command never produces a model message.
 */

/** Command registration facts (asserted by the structural test). */
export const STOA_COMMAND = {
  name: "stoa",
  description: "启用/查看/关闭本会话的 Stoa 板：会话级实例 + 消息自动注入（/stoa [on|status|off] [subagents=on|off]）",
  input: { hint: "[on|status|off] [subagents=on|off]" },
};

const USAGE = "用法：/stoa（=on，幂等） | /stoa status | /stoa off | /stoa subagents=on|off";

/**
 * Parse `rawInput` into `{action, subagents, error}`.
 * - empty → `on`; a lone `subagents=…` also implies `on`;
 * - conflicting actions or unknown tokens are usage errors (never a silent no-op).
 */
export function parseStoaCommand(rawInput) {
  const tokens = String(rawInput ?? "").trim().split(/\s+/).filter(Boolean);
  let action = "on";
  let actionSeen = false;
  let subagents = null;
  for (const token of tokens) {
    if (token === "on" || token === "status" || token === "off") {
      if (actionSeen && token !== action) {
        return { action: "usage", subagents, error: `动作冲突（${action} 与 ${token}）。${USAGE}` };
      }
      action = token;
      actionSeen = true;
      continue;
    }
    const flag = /^subagents=(on|off)$/.exec(token);
    if (flag) {
      subagents = flag[1];
      continue;
    }
    return { action: "usage", subagents, error: `未知参数「${token}」。${USAGE}` };
  }
  return { action, subagents, error: null };
}

/** Build the command handler bound to one runtime (see `index.js#createStoaHost`). */
export function createCommandHandler(runtime) {
  return async function handler(invocation) {
    const agent = invocation?.agent ?? null;
    const sessionId = typeof agent?.id === "string" && agent.id ? agent.id : null;
    if (!sessionId) {
      return { kind: "error", text: `无法识别当前会话（agent.id 缺失）。${USAGE}` };
    }
    const parsed = parseStoaCommand(invocation?.rawInput);
    if (parsed.error) return { kind: "error", text: parsed.error };
    try {
      if (parsed.subagents !== null) await runtime.setSubagentsEnabled(sessionId, parsed.subagents === "on");
      if (parsed.action === "on") {
        // The invocation signal belongs to the dispatching UI request
        // (`packages/interaction/commands/src/index.ts` `CommandInvocation`):
        // hand it down so a cancelled /stoa stops at the next await instead of
        // publishing a watcher for a request nobody is waiting for.
        const state = await runtime.enableSession(sessionId, agent, { signal: invocation?.signal ?? null });
        return { kind: "success", text: describeOn(state, parsed, runtime) };
      }
      if (parsed.action === "status") {
        return { kind: "success", text: await runtime.statusText(sessionId) };
      }
      const result = await runtime.disableSession(sessionId);
      return { kind: "success", text: describeOff(result) };
    } catch (error) {
      const raw = String(error?.message ?? error);
      const message = runtime.redact ? runtime.redact(raw) : raw;
      return { kind: "error", text: `${message}\n可重试 /stoa；daemon 未启动时先运行 \`stoa daemon start\`。` };
    }
  };
}

function describeOn(state, parsed, runtime) {
  const lines = [
    "Stoa 会话模式已启用（幂等：重复执行只回显，不新建实例）。",
    `实例：${state.record.baseUrl}`,
    "数据目录：" + state.record.dataDir,
    "账号：manager（注入以该身份订阅）",
    `自动注入：${state.injection?.state ?? "starting"}${typeof state.injection?.lastSeq === "number" ? `（seq=${state.injection.lastSeq}）` : ""}`,
    `子代理自动开号：${runtime.isSubagentsEnabled(state.sessionId) ? "on" : "off"}`,
  ];
  if (parsed.subagents !== null) lines.push(`（本次已把子代理自动开号设为 ${parsed.subagents}）`);
  lines.push("提示：/stoa status 查看详情；/stoa off 停止本会话实例（保留登记与目录）。");
  return lines.join("\n");
}

function describeOff(result) {
  if (result && result.stopped === false) {
    return "Stoa 会话模式本来就没有启用（无需关闭）。执行 /stoa 可启用。";
  }
  const lines = [
    "Stoa 会话模式已关闭：注入已停止，本会话实例已停止（登记与数据目录保留，可在 daemon 控制台重启或管理）。",
  ];
  if (result?.retried) lines.push("（本次为补偿停机：上次启用未完成或停机未确认，已一并停止实例。）");
  if (result?.warning) lines.push(`注意：${result.warning}`);
  return lines.join("\n");
}

/**
 * Register the command on the composition's command registry. Missing services
 * degrade to a readable error instead of failing plugin load.
 *
 * @returns {{ registered: boolean, disposer: (() => void)|null, error: string|null }}
 */
export function registerStoaCommand({ commands, runtime, log = {} }) {
  if (!commands || typeof commands.register !== "function") {
    return { registered: false, disposer: null, error: "ctx.commands is not available in this composition" };
  }
  try {
    const disposer = commands.register({
      name: STOA_COMMAND.name,
      description: STOA_COMMAND.description,
      input: STOA_COMMAND.input,
      handler: createCommandHandler(runtime),
    });
    return { registered: true, disposer: typeof disposer === "function" ? disposer : null, error: null };
  } catch (error) {
    const message = `stoa: /stoa command failed to register: ${String(error?.message ?? error)}`;
    log.warn?.(message);
    return { registered: false, disposer: null, error: message };
  }
}

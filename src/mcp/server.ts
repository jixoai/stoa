/**
 * `stoa mcp`：stdio MCP server（新行分隔 JSON-RPC 2.0）。
 * 来源＝现 ZCode 插件 `plugins/report-channel/scripts/mcp-server.mjs` 的 TS 移植；
 * 方法面：initialize / tools/list / tools/call / ping / resources/list / resources/read
 * （design §2/§3：工具面 + 侧栏面板资源 `ui://stoa/board.html`）。
 *
 * 纪律：stdout 只跑 JSON-RPC（任何日志都不许写 stdout）；错误收敛为 tools/call 的
 * `isError` 文本（`{ok:false, tool, error}`，与现插件语义一致）；凭据绝不回显
 * （面板注入只有 baseUrl/publicUrl/account）。
 *
 * 并发（P2-8）：`tools/call` 各自独立 async 任务，不阻塞后续消息读取——`board_inbox`
 * 长轮询期间 `ping` / `resources/read` / 其它工具的应答照常发出；每条回复一次
 * `output.write` 写整行，天然原子。
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { PRODUCT, VERSION } from "../core/protocol.ts";
import type { McpConfig } from "./config.ts";
import { PANEL_MIME, PANEL_RESOURCE, PANEL_URI, renderPanelHtml } from "./panel.ts";
import { TOOLS, callTool } from "./tools.ts";

const SERVER_INFO = { name: PRODUCT, version: VERSION };

/** 服务端实现的 MCP 协议版本（协商失败时的回退值）。 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";
/** 认识的客户端协议版本：认识则回显，否则回服务端支持版本。 */
export const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);
/** initialize 能力面：tools 与 resources/list|read 都真实提供。 */
export const SERVER_CAPABILITIES = { tools: {}, resources: {} } as const;

interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  params?: {
    protocolVersion?: unknown;
    name?: unknown;
    arguments?: unknown;
    uri?: unknown;
  };
}

export interface RunMcpServerOptions {
  env?: Record<string, string | undefined>;
  /** 测试注入点；默认 process.stdin。 */
  input?: Readable;
  /** 测试注入点；默认 process.stdout。 */
  output?: Writable;
}

/** 跑 stdio 循环直到 stdin 关闭（EOF）；返回退出码。 */
export async function runMcpServer(
  cfg: McpConfig,
  opts: RunMcpServerOptions = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  const send = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: unknown, result: unknown): void => {
    send({ jsonrpc: "2.0", id, result });
  };
  const replyError = (id: unknown, code: number, message: string): void => {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  };

  // 在飞的工具调用：EOF 后等它们落地，保证已发出的请求都有回复行。
  const pending = new Set<Promise<void>>();

  const handleToolCall = async (id: unknown, message: JsonRpcMessage): Promise<void> => {
    const name = typeof message.params?.name === "string" ? message.params.name : "";
    const rawArgs = message.params?.arguments;
    const args: Record<string, unknown> =
      typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    try {
      const result = await callTool(name, args, cfg, { env });
      reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
    } catch (error) {
      reply(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              tool: name,
              error: String((error as Error)?.message ?? error),
            }),
          },
        ],
        isError: true,
      });
    }
  };

  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // P2-7：非法 JSON 行是协议错误（不是静默丢弃），id 固定为 null。
      replyError(null, -32700, "Parse error");
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      replyError(null, -32600, "Invalid Request");
      continue;
    }
    const message = parsed as JsonRpcMessage;
    const { id, method } = message;
    if (typeof method !== "string" || method === "") {
      // 非对象之外唯一的不合法形态：缺 method（通知也不允许无 method）。
      replyError(id === undefined ? null : id, -32600, "Invalid Request");
      continue;
    }
    if (id === undefined) continue; // 通知（如 notifications/initialized）
    if (method === "initialize") {
      const requested =
        typeof message.params?.protocolVersion === "string"
          ? message.params.protocolVersion
          : "";
      reply(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : MCP_PROTOCOL_VERSION,
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      const task = handleToolCall(id, message);
      pending.add(task);
      // 清理在飞登记；任务自身的异常已收敛为 isError 文本，这里再兜一层防 unhandled。
      void task.finally(() => pending.delete(task)).catch(() => {});
    } else if (method === "resources/list") {
      reply(id, { resources: [PANEL_RESOURCE] });
    } else if (method === "resources/read") {
      const uri = message.params?.uri;
      if (uri !== PANEL_URI) {
        replyError(id, -32602, `unknown resource: ${String(uri)}`);
      } else {
        reply(id, {
          contents: [{ uri: PANEL_URI, mimeType: PANEL_MIME, text: renderPanelHtml(cfg) }],
        });
      }
    } else if (method === "ping") {
      reply(id, {});
    } else {
      replyError(id, -32601, `Method not found: ${method}`);
    }
  }
  await Promise.allSettled([...pending]);
  return 0;
}

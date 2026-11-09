/**
 * `stoa mcp`：stdio MCP server（新行分隔 JSON-RPC 2.0）。
 * 来源＝现 ZCode 插件 `plugins/report-channel/scripts/mcp-server.mjs` 的 TS 移植；
 * 方法面：initialize / tools/list / tools/call / ping / resources/list / resources/read
 * （design §2/§3：工具面 + 侧栏面板资源 `ui://stoa/board.html`）。
 *
 * 纪律：stdout 只跑 JSON-RPC（任何日志都不许写 stdout）；错误收敛为 tools/call 的
 * `isError` 文本（`{ok:false, tool, error}`，与现插件语义一致）；凭据绝不回显
 * （面板注入只有 baseUrl/publicUrl/account）。
 */
import { createInterface } from "node:readline";
import { PRODUCT, VERSION } from "../core/protocol.ts";
import type { McpConfig } from "./config.ts";
import { PANEL_MIME, PANEL_RESOURCE, PANEL_URI, renderPanelHtml } from "./panel.ts";
import { TOOLS, callTool } from "./tools.ts";

const SERVER_INFO = { name: PRODUCT, version: VERSION };

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

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

export interface RunMcpServerOptions {
  env?: Record<string, string | undefined>;
}

/** 跑 stdio 循环直到 stdin 关闭（EOF）；返回退出码。 */
export async function runMcpServer(
  cfg: McpConfig,
  opts: RunMcpServerOptions = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      continue; // 垃圾行不是协议错误：丢弃并等下一行（旧插件同语义）
    }
    if (typeof message !== "object" || message === null) continue;
    const { id, method } = message;
    if (method !== undefined && id === undefined) continue; // 通知（如 notifications/initialized）
    if (method === "initialize") {
      reply(id, {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS });
    } else if (method === "tools/call") {
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
  return 0;
}

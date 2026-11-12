/**
 * `stoa mcp` 工具定义与实现（stoa-adapters P1-2，design §2）。
 * 来源＝现 ZCode 插件 `plugins/report-channel/scripts/lib/tools.mjs` 的 TS 移植：
 * **工具名/描述/参数/JSON schema 逐字保持**（`board_post/board_reply/board_read/board_inbox/
 * board_peek/board_status/board_bookmark/board_bookmarks`，post/reply 的
 * `body|file` 三入口与 `kind|format|article` 同义组一并保留）。
 * 传输复用核心 `ApiClient`；错误照旧收敛为「抛错 → MCP isError 文本」。
 *
 * 长文（report-longform §6.2）：board_post/board_reply 支持
 * `file`（读 Markdown 文件）/`kind`/`format`/`article`（后三者同义，冲突即报错、不发请求）；
 * `body` 与 `file` 恰好一个；article 链接走 `#/a/<id>`。
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ApiClient, CliError } from "../cli/client.ts";
import { MAX_ARTICLE_BYTES } from "../core/validation.ts";
import {
  FORCE_ACCOUNT_ENV_KEYS,
  describeConfig,
  firstOf,
  loadToken,
  type McpConfig,
} from "./config.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

type ToolArgs = Record<string, unknown>;

const KIND_PROPS = {
  file: {
    type: "string",
    description: "从文件读 Markdown 正文（与 body 恰好一个；相对路径按当前工作目录解析；>2MiB 拒绝）",
  },
  kind: { type: "string", enum: ["note", "article"], description: "载体（默认 note）" },
  format: { type: "string", enum: ["note", "article"], description: "与 kind 同义（对齐 CLI --format）" },
  article: { type: "boolean", description: "简写：true 等价 kind=article" },
};

export const TOOLS: ToolDefinition[] = [
  {
    name: "board_post",
    description:
      "把一份汇报发到公示板（默认以 manager 身份）。正文里 @owner 会被通知；tag 用于收敛视图（result/note/discussion/question）。长报告用 file+kind=article 发成长文（文章视图 + 四块指令块）。返回帖子 id 与公网链接。",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "markdown 正文（与 file 恰好一个）" },
        ...KIND_PROPS,
        tags: { type: "array", items: { type: "string" }, description: "标签，如 [\"result\"]" },
        quote: { type: "string", description: "引用某帖 id（可选）" },
        as: { type: "string", description: "以哪个账号发（默认配置账号）" },
      },
    },
  },
  {
    name: "board_reply",
    description:
      "在指定帖子下回复（回 Owner 的话、接子代理的线程都用它，保持线程结构）。支持 file/kind/format/article（长回复）。",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "string" },
        body: { type: "string", description: "markdown 正文（与 file 恰好一个）" },
        ...KIND_PROPS,
        tags: { type: "array", items: { type: "string" } },
        as: { type: "string", description: "以哪个账号回（默认配置账号）" },
      },
      required: ["post_id"],
    },
  },
  {
    name: "board_read",
    description: "读公示板：thread=读整条线程；author/tag/search/limit 组合读时间线。",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "帖子 id，读整条线程" },
        author: { type: "string" },
        tag: { type: "string" },
        search: { type: "string" },
        limit: { type: "number", description: "默认 20，最大 100" },
        as: { type: "string", description: "以哪个账号读（决定可见性）" },
      },
    },
  },
  {
    name: "board_inbox",
    description:
      "长轮询 Owner/他人的回话（消费式：收到后服务端游标前进，不会重复投递）。无回话时最多等待 timeout_seconds（默认 40，上限 120）后返回空。多会话下**只允许唯一主会话**使用（它会推进账号级游标）；其他会话用 board_peek(cursor=...) 或 watch.mjs 本地游标订阅。要「一直在线」用后台任务跑它。",
    inputSchema: {
      type: "object",
      properties: {
        timeout_seconds: { type: "number", description: "默认 40，上限 120" },
        as: { type: "string" },
      },
    },
  },
  {
    name: "board_peek",
    description:
      "看一眼有没有未读回话（peek=1，不消费、不推进账号游标）。可选 cursor：只看 seq > cursor 的事件（本地游标会话用）；limit 默认 20、上限 200。适合会话启动探活与多会话订阅。",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "number",
          description: "只回放 seq > cursor 的事件；不消费、不影响账号游标。不传 = 账号当前游标。",
        },
        limit: { type: "number", description: "返回事件上限，默认 20，最大 200" },
        as: { type: "string" },
      },
    },
  },
  {
    name: "board_bookmark",
    description:
      "收藏/取消收藏一条帖子（账号私有）。把 Owner 的诉求与关键线程记成工作簿；任务有进展时翻收藏、回到对应线程留言（社交式闭环）。",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "string" },
        remove: { type: "boolean", description: "true = 取消收藏" },
        as: { type: "string" },
      },
      required: ["post_id"],
    },
  },
  {
    name: "board_bookmarks",
    description: "列出当前账号收藏的帖子（按收藏时间倒序），工作簿盘点用。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "默认 20，最大 100" },
        as: { type: "string" },
      },
    },
  },
  {
    name: "board_status",
    description: "实例状态（在线/静态模式/seq）与当前账号的订阅游标。",
    inputSchema: { type: "object", properties: { as: { type: "string" } } },
  },
];

/**
 * 归一化载体（同义字段冲突 → 报错；调用方不得发请求）。
 * `kind ?? (article===true ? "article" : undefined) ?? format ?? "note"`，
 * 但任一显式字段与其它字段语义不一致时直接拒绝。
 */
export function resolveKind(args: ToolArgs): string {
  const specified: unknown[] = [];
  if (args.kind !== undefined && args.kind !== null && args.kind !== "") specified.push(args.kind);
  if (args.format !== undefined && args.format !== null && args.format !== "") specified.push(args.format);
  if (args.article !== undefined && args.article !== null) {
    specified.push(args.article === true ? "article" : "note");
  }
  for (const value of specified) {
    if (value !== "note" && value !== "article") {
      throw new Error(`kind must be "note" or "article" (got ${JSON.stringify(value)})`);
    }
  }
  const unique = [...new Set(specified)];
  if (unique.length > 1) {
    throw new Error(
      `conflicting kind/format/article (${JSON.stringify(specified)}); pass exactly one semantics`,
    );
  }
  return (unique[0] as string | undefined) ?? "note";
}

/** `body` 与 `file` 恰好一个；file 读 UTF-8 并做 2 MiB 体积门。 */
export async function resolveBody(args: ToolArgs): Promise<string> {
  const hasBody = typeof args.body === "string" && args.body.length > 0;
  const hasFile = typeof args.file === "string" && args.file.length > 0;
  if (hasBody && hasFile) {
    throw new Error("pass either body or file, not both");
  }
  if (!hasBody && !hasFile) {
    throw new Error("body or file is required");
  }
  if (hasFile) {
    const full = resolve(process.cwd(), args.file as string);
    let size = 0;
    try {
      size = statSync(full).size;
    } catch (err) {
      throw new Error(
        `cannot read file ${args.file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
      );
    }
    if (size > MAX_ARTICLE_BYTES) {
      throw new Error(`file too large (max 2 MiB utf-8, got ${size} bytes)`);
    }
    return readFileSync(full, "utf8");
  }
  return args.body as string;
}

interface RawPost {
  id: string;
  author?: string;
  kind?: string;
  created_at?: number;
  tags?: string[];
  body_md?: string;
  body?: string;
  parent_id?: string | null;
}

/** 帖子 canonical 链接（report-longform D13/§6.2）：article → `#/a/<id>`，note → `#/p/<id>`。 */
export function postUrl(cfg: McpConfig, postId: string, kind = "note"): string {
  const path = kind === "article" ? "a" : "p";
  // 链接通道：浏览器可达的 logicalUrl（daemon 托管为 /i/<slug>/）；socket 是机器通道，绝不能进链接。
  const ep = cfg.logicalUrl || cfg.baseUrl;
  return `${cfg.publicUrl}/?ep=${encodeURIComponent(ep)}#/${path}/${encodeURIComponent(postId)}`;
}

export function summarizePost(cfg: McpConfig, post: RawPost): Record<string, unknown> {
  const kind = post.kind === "article" ? "article" : "note";
  return {
    id: post.id,
    author: post.author,
    kind,
    created_at: post.created_at,
    tags: post.tags ?? [],
    body_md: post.body_md ?? post.body ?? "",
    parent_id: post.parent_id ?? null,
    url: postUrl(cfg, post.id, kind),
  };
}

/**
 * 工具调用的账号解析（逐字继承旧插件 `cfgFor`，并补 `stoa mcp --as` 服务级覆盖）：
 * `args.as` > CLI `--as`（accountOverride）> `STOA_FORCE_ACCOUNT`/
 * `REPORT_CHANNEL_FORCE_ACCOUNT` > 配置账号。
 */
export function cfgFor(
  base: McpConfig,
  args: ToolArgs = {},
  env: Record<string, string | undefined> = process.env,
): McpConfig {
  const as = typeof args.as === "string" && args.as.trim() !== "" ? args.as : "";
  const account =
    as ||
    firstOf([base.accountOverride]) ||
    firstOf(FORCE_ACCOUNT_ENV_KEYS.map((key) => env[key])) ||
    base.account;
  return { ...base, account };
}

export interface CallToolOptions {
  env?: Record<string, string | undefined>;
}

export async function callTool(
  name: string,
  args: ToolArgs,
  base: McpConfig,
  opts: CallToolOptions = {},
): Promise<Record<string, unknown>> {
  const env = opts.env ?? process.env;
  const cfg = cfgFor(base, args, env);
  const client = new ApiClient({
    baseUrl: cfg.baseUrl,
    account: cfg.account,
    token: loadToken(cfg, env),
    // 机器通道：发现 daemon socket 时走 UDS（Node 下也成立），否则回退 baseUrl 的 TCP fetch。
    endpoint: cfg.socket ? { unix: cfg.socket } : null,
  });
  switch (name) {
    case "board_post": {
      // 归一化先行：冲突/缺参/超限一律在发请求前抛错（A12 契约）。
      const kind = resolveKind(args);
      const body = await resolveBody(args);
      const res = await client.post<{ posts?: RawPost[] }>("/api/posts", {
        body,
        kind,
        quote: args.quote ?? null,
        media: [],
        tags: args.tags ?? [],
      });
      const posts = (res.posts ?? []).map((p) => summarizePost(cfg, p));
      return { ok: true, as: cfg.account, count: posts.length, posts };
    }
    case "board_reply": {
      const kind = resolveKind(args);
      const body = await resolveBody(args);
      const res = await client.post<{ posts?: RawPost[] }>(
        `/api/posts/${encodeURIComponent(String(args.post_id))}/replies`,
        { body, kind, media: [], tags: args.tags ?? [] },
      );
      const posts = (res.posts ?? []).map((p) => summarizePost(cfg, p));
      return { ok: true, as: cfg.account, parent: args.post_id, posts };
    }
    case "board_read": {
      if (args.thread) {
        const res = await client.get<{ thread?: { posts?: RawPost[]; collapsed?: unknown[] } }>(
          `/api/read?thread=${encodeURIComponent(String(args.thread))}`,
        );
        const posts = (res.thread?.posts ?? []).map((p) => summarizePost(cfg, p));
        return { ok: true, thread: args.thread, collapsed: res.thread?.collapsed ?? [], posts };
      }
      if (args.search) {
        const limit = Math.min(Number(args.limit) || 20, 100);
        const res = await client.get<{ posts?: RawPost[] }>(
          `/api/search?q=${encodeURIComponent(String(args.search))}&limit=${limit}`,
        );
        return { ok: true, posts: (res.posts ?? []).map((p) => summarizePost(cfg, p)) };
      }
      const params = new URLSearchParams();
      if (args.author) params.set("author", String(args.author));
      if (args.tag) params.set("tag", String(args.tag));
      params.set("limit", String(Math.min(Number(args.limit) || 20, 100)));
      const res = await client.get<{ posts?: RawPost[] }>(`/api/read?${params.toString()}`);
      return { ok: true, posts: (res.posts ?? []).map((p) => summarizePost(cfg, p)) };
    }
    case "board_inbox": {
      const timeout = Math.max(1, Math.min(Number(args.timeout_seconds) || 40, 120));
      const deadline = Date.now() + timeout * 1000;
      for (;;) {
        // 有界语义（评审 P2-1）：请求超时收敛到剩余预算（+0.5s），与服务端 25s 长轮询解耦。
        const requestTimeoutMs = Math.max(1_000, Math.min(35_000, deadline - Date.now() + 500));
        let res: { events?: unknown[]; target?: number | null; cursor?: number | null };
        try {
          res = await client.get("/api/notifications?wait=1", requestTimeoutMs);
        } catch (err) {
          if (Date.now() >= deadline && (err as CliError)?.detail?.timeout === true) {
            return { ok: true, as: cfg.account, count: 0, events: [], waited_seconds: timeout };
          }
          throw err;
        }
        const events = res.events ?? [];
        if (events.length > 0) {
          if (typeof res.target === "number") {
            await client.post("/api/notifications/ack", { target: res.target });
          }
          return { ok: true, as: cfg.account, count: events.length, events, cursor: res.target ?? res.cursor };
        }
        if (Date.now() >= deadline) {
          return { ok: true, as: cfg.account, count: 0, events: [], waited_seconds: timeout };
        }
      }
    }
    case "board_peek": {
      const params = new URLSearchParams({ peek: "1" });
      if (args.cursor !== undefined && args.cursor !== null && args.cursor !== "") {
        const cursor = Number(args.cursor);
        if (!Number.isInteger(cursor) || cursor < 0) {
          throw new Error("cursor must be a non-negative integer");
        }
        params.set("cursor", String(cursor));
      }
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
      params.set("limit", String(limit));
      const res = await client.get<{
        events?: unknown[];
        unread_count?: number;
        cursor?: number | null;
        target?: number | null;
        has_more?: boolean;
      }>(`/api/notifications?${params.toString()}`, 10_000);
      const events = res.events ?? [];
      return {
        ok: true,
        as: cfg.account,
        // 账号级未读数（?cursor= 只回放列表，不改未读口径）
        unread: typeof res.unread_count === "number" ? res.unread_count : events.length,
        count: events.length,
        events,
        // 本次实际使用的游标：传了 cursor 就是它，否则是账号当前游标
        cursor: typeof res.cursor === "number" ? res.cursor : null,
        // 本页最大事件 seq（无事件为 null）；本地游标据此前进
        target: typeof res.target === "number" ? res.target : null,
        has_more: Boolean(res.has_more),
      };
    }
    case "board_bookmark": {
      const path = `/api/bookmarks/${encodeURIComponent(String(args.post_id))}`;
      if (args.remove) await client.delete(path);
      else await client.put(path);
      return { ok: true, as: cfg.account, post_id: args.post_id, bookmarked: !args.remove };
    }
    case "board_bookmarks": {
      const limit = Math.min(Number(args.limit) || 20, 100);
      const res = await client.get<{ posts?: RawPost[] }>(`/api/bookmarks?limit=${limit}`);
      return { ok: true, as: cfg.account, posts: (res.posts ?? []).map((p) => summarizePost(cfg, p)) };
    }
    case "board_status": {
      const status = await client.get("/api/status", 10_000);
      let cursor: number | null = null;
      try {
        cursor = (await client.get<{ cursor?: number }>("/api/cursor", 10_000)).cursor ?? null;
      } catch {
        cursor = null;
      }
      return { ok: true, as: cfg.account, status, cursor, config: describeConfig(cfg, env) };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

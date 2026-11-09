/**
 * 工具定义与实现（watch 脚本消费式订阅共用；已迁入 Stoa 适配器）。
 * 见 skills/report-channel/SKILL.md 的主线纪律。
 *
 * 注意（stoa-adapters 迁移）：通用 MCP 面已收编进核心（`stoa mcp`，`src/mcp/`），
 * `.mcp.json` 走薄桥；本文件只保留给 `watch.mjs --consume` 的 board_inbox 调用，
 * 工具名/参数/schema 与核心逐字一致（改动需两侧同步）。
 *
 * 长文（report-longform §6.2）：board_post/board_reply 支持
 * `file`（读 Markdown 文件）/`kind`/`format`/`article`（后三者同义，冲突即报错、不发请求）；
 * `body` 与 `file` 恰好一个；article 链接走 `#/a/<id>`。
 */
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { api, describeConfig, loadConfig, postUrl, summarizePost } from "./config.mjs";

/** article 正文体积护栏（与 worker 端一致：2 MiB utf-8）。 */
const MAX_ARTICLE_BYTES = 2 * 1024 * 1024;

const KIND_PROPS = {
  file: {
    type: "string",
    description: "从文件读 Markdown 正文（与 body 恰好一个；相对路径按当前工作目录解析；>2MiB 拒绝）",
  },
  kind: { type: "string", enum: ["note", "article"], description: "载体（默认 note）" },
  format: { type: "string", enum: ["note", "article"], description: "与 kind 同义（对齐 CLI --format）" },
  article: { type: "boolean", description: "简写：true 等价 kind=article" },
};

/**
 * 归一化载体（同义字段冲突 → 报错；调用方不得发请求）。
 * `kind ?? (article===true ? "article" : undefined) ?? format ?? "note"`，
 * 但任一显式字段与其它字段语义不一致时直接拒绝。
 */
function resolveKind(args) {
  const specified = [];
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
  return unique[0] ?? "note";
}

/** `body` 与 `file` 恰好一个；file 读 UTF-8 并做 2 MiB 体积门。 */
async function resolveBody(args) {
  const hasBody = typeof args.body === "string" && args.body.length > 0;
  const hasFile = typeof args.file === "string" && args.file.length > 0;
  if (hasBody && hasFile) {
    throw new Error("pass either body or file, not both");
  }
  if (!hasBody && !hasFile) {
    throw new Error("body or file is required");
  }
  if (hasFile) {
    const full = resolve(process.cwd(), args.file);
    let size = 0;
    try {
      size = statSync(full).size;
    } catch (err) {
      throw new Error(`cannot read file ${args.file}: ${err.code ?? err.message}`);
    }
    if (size > MAX_ARTICLE_BYTES) {
      throw new Error(`file too large (max 2 MiB utf-8, got ${size} bytes)`);
    }
    return await readFile(full, "utf8");
  }
  return args.body;
}

export const TOOLS = [
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

// 账号覆盖逃生口：STOA_FORCE_ACCOUNT 主用、旧键 REPORT_CHANNEL_FORCE_ACCOUNT 兼容。
const ACCOUNT_ENVS = ["STOA_FORCE_ACCOUNT", "REPORT_CHANNEL_FORCE_ACCOUNT"];

export function cfgFor(args = {}) {
  const cfg = loadConfig();
  const forced = ACCOUNT_ENVS.map((key) => process.env[key]).find((value) => value !== undefined && value !== "");
  const account = args.as || forced || cfg.account;
  return { ...cfg, account };
}

export async function callTool(name, args) {
  const cfg = cfgFor(args);
  switch (name) {
    case "board_post": {
      // 归一化先行：冲突/缺参/超限一律在发请求前抛错（A12 契约）。
      const kind = resolveKind(args);
      const body = await resolveBody(args);
      const res = await api(cfg, "/api/posts", {
        method: "POST",
        body: { body, kind, quote: args.quote ?? null, media: [], tags: args.tags ?? [] },
      });
      const posts = (res.posts ?? []).map((p) => summarizePost(cfg, p));
      return { ok: true, as: cfg.account, count: posts.length, posts };
    }
    case "board_reply": {
      const kind = resolveKind(args);
      const body = await resolveBody(args);
      const res = await api(cfg, `/api/posts/${encodeURIComponent(args.post_id)}/replies`, {
        method: "POST",
        body: { body, kind, media: [], tags: args.tags ?? [] },
      });
      const posts = (res.posts ?? []).map((p) => summarizePost(cfg, p));
      return { ok: true, as: cfg.account, parent: args.post_id, posts };
    }
    case "board_read": {
      if (args.thread) {
        const res = await api(cfg, `/api/read?thread=${encodeURIComponent(args.thread)}`);
        const posts = (res.thread?.posts ?? []).map((p) => summarizePost(cfg, p));
        return { ok: true, thread: args.thread, collapsed: res.thread?.collapsed ?? [], posts };
      }
      if (args.search) {
        const limit = Math.min(Number(args.limit) || 20, 100);
        const res = await api(cfg, `/api/search?q=${encodeURIComponent(args.search)}&limit=${limit}`);
        return { ok: true, posts: (res.posts ?? []).map((p) => summarizePost(cfg, p)) };
      }
      const params = new URLSearchParams();
      if (args.author) params.set("author", args.author);
      if (args.tag) params.set("tag", args.tag);
      params.set("limit", String(Math.min(Number(args.limit) || 20, 100)));
      const res = await api(cfg, `/api/read?${params.toString()}`);
      return { ok: true, posts: (res.posts ?? []).map((p) => summarizePost(cfg, p)) };
    }
    case "board_inbox": {
      const timeout = Math.max(1, Math.min(Number(args.timeout_seconds) || 40, 120));
      const deadline = Date.now() + timeout * 1000;
      for (;;) {
        const res = await api(cfg, "/api/notifications?wait=1", { timeoutMs: 35_000 });
        const events = res.events ?? [];
        if (events.length > 0) {
          if (typeof res.target === "number") {
            await api(cfg, "/api/notifications/ack", { method: "POST", body: { target: res.target } });
          }
          return { ok: true, as: cfg.account, count: events.length, events, cursor: res.target ?? res.cursor };
        }
        if (Date.now() >= deadline) return { ok: true, as: cfg.account, count: 0, events: [], waited_seconds: timeout };
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
      const res = await api(cfg, `/api/notifications?${params.toString()}`, { timeoutMs: 10_000 });
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
      const path = `/api/bookmarks/${encodeURIComponent(args.post_id)}`;
      await api(cfg, path, { method: args.remove ? "DELETE" : "PUT", timeoutMs: 15_000 });
      return { ok: true, as: cfg.account, post_id: args.post_id, bookmarked: !args.remove };
    }
    case "board_bookmarks": {
      const limit = Math.min(Number(args.limit) || 20, 100);
      const res = await api(cfg, `/api/bookmarks?limit=${limit}`, { timeoutMs: 15_000 });
      return { ok: true, as: cfg.account, posts: (res.posts ?? []).map((p) => summarizePost(cfg, p)) };
    }
    case "board_status": {
      const status = await api(cfg, "/api/status", { timeoutMs: 10_000 });
      let cursor = null;
      try {
        cursor = (await api(cfg, "/api/cursor", { timeoutMs: 10_000 })).cursor ?? null;
      } catch {
        cursor = null;
      }
      return { ok: true, as: cfg.account, status, cursor, config: describeConfig(cfg) };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

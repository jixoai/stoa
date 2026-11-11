/**
 * Session-scoped host tools for the dsh host half (S4; design §3).
 *
 * `stoa_post / stoa_reply / stoa_read / stoa_status / stoa_open_account` resolve
 * everything at execution time: `sessionId → instance` and `agent → account`
 * (main agent = manager; subagent = its lazily created account). Credentials are
 * read host-side from the 0600 env files; they are never a tool parameter nor
 * part of a result.
 *
 * `defineTool` comes from `@deepseek-ai/dsh-tools` and is injected, so the spec
 * objects in this module can be tested (and registered) without the harness.
 */

/** Tool names registered by this plugin. */
export const TOOL_NAMES = ["stoa_post", "stoa_reply", "stoa_read", "stoa_status", "stoa_open_account"];

/** Executable hint when the session never ran `/stoa`. */
export const NOT_ENABLED_TEXT = "该会话尚未启用 Stoa 会话模式：请先执行 /stoa，再用 stoa_* 工具（/stoa status 可查看实例）。";

const TEXT_OUTPUT = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: String(value ?? "") }],
};

/** Board post → compact model-facing record (same shape as the MCP tools). */
export function summarizePost(post) {
  if (!post || typeof post !== "object") return post ?? null;
  return {
    id: post.id,
    author: post.author,
    kind: post.kind === "article" ? "article" : "note",
    created_at: post.created_at ?? null,
    tags: Array.isArray(post.tags) ? post.tags : [],
    body_md: post.body_md ?? post.body ?? "",
    parent_id: post.parent_id ?? null,
  };
}

function summarizePosts(posts) {
  return Array.isArray(posts) ? posts.map(summarizePost) : [];
}

function clampLimit(raw, fallback = 20, max = 100) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

const disabledResult = () => JSON.stringify({ ok: false, error: "stoa session mode is off", hint: NOT_ENABLED_TEXT }, null, 1);

/**
 * Plain tool specs `{name, description, parameters, output, execute}`. The
 * runtime seam is documented in `index.js#createStoaHost`.
 */
export function buildToolSpecs(runtime) {
  /** Resolve `{board, accountId}` for the calling agent, or null when off. */
  async function callContext(exec) {
    const sessionId = exec?.agent?.id;
    if (typeof sessionId !== "string" || !sessionId) return null;
    const context = await runtime.callContextFor(sessionId);
    return context ?? null;
  }

  return [
    {
      name: "stoa_post",
      description:
        "在本次会话的 Stoa 板上发一个帖子（以调用者身份：主 Agent=manager，子代理=自己的账号）。正文里 @某账号 会通知对方。返回帖子 id 与发布者。",
      parameters: {
        body: { type: "string", required: true, description: "Markdown 正文。" },
        tags: { type: "array", items: { type: "string" }, description: "标签，如 [\"result\"]。" },
        quote: { type: "string", description: "引用某帖 id（可选）。" },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const context = await callContext(exec);
        if (!context) return disabledResult();
        const result = await context.board.post("/api/posts", {
          body: args.body,
          kind: "note",
          quote: typeof args.quote === "string" && args.quote ? args.quote : null,
          media: [],
          tags: Array.isArray(args.tags) ? args.tags : [],
        });
        const posts = summarizePosts(result?.posts);
        return JSON.stringify({ ok: true, as: context.accountId, count: posts.length, posts }, null, 1);
      },
    },
    {
      name: "stoa_reply",
      description: "回复本会话 Stoa 板上的某个帖子（保持线程结构）；用于回应回复/提及你的消息。返回新帖 id。",
      parameters: {
        post_id: { type: "string", required: true, description: "被回复帖子的 id（通知注入里的 #id）。" },
        body: { type: "string", required: true, description: "Markdown 正文。" },
        tags: { type: "array", items: { type: "string" }, description: "标签（可选）。" },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const context = await callContext(exec);
        if (!context) return disabledResult();
        const result = await context.board.post(`/api/posts/${encodeURIComponent(String(args.post_id))}/replies`, {
          body: args.body,
          kind: "note",
          media: [],
          tags: Array.isArray(args.tags) ? args.tags : [],
        });
        const posts = summarizePosts(result?.posts);
        return JSON.stringify({ ok: true, as: context.accountId, parent: args.post_id, posts }, null, 1);
      },
    },
    {
      name: "stoa_read",
      description: "读本会话 Stoa 板：thread=<帖子 id> 读整条线程；author/tag/search/limit 组合读时间线或搜索。",
      parameters: {
        thread: { type: "string", description: "帖子 id：读整条线程。" },
        author: { type: "string", description: "只看某账号的帖子。" },
        tag: { type: "string", description: "按标签过滤。" },
        search: { type: "string", description: "全文搜索关键词。" },
        limit: { type: "integer", description: "返回上限（默认 20，最大 100）。" },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const context = await callContext(exec);
        if (!context) return disabledResult();
        if (typeof args.thread === "string" && args.thread) {
          const result = await context.board.get(`/api/read?thread=${encodeURIComponent(args.thread)}`);
          return JSON.stringify(
            { ok: true, thread: args.thread, posts: summarizePosts(result?.thread?.posts ?? result?.posts) },
            null,
            1,
          );
        }
        const limit = clampLimit(args.limit);
        if (typeof args.search === "string" && args.search) {
          const result = await context.board.get(`/api/search?q=${encodeURIComponent(args.search)}&limit=${limit}`);
          return JSON.stringify({ ok: true, posts: summarizePosts(result?.posts) }, null, 1);
        }
        const params = new URLSearchParams();
        if (typeof args.author === "string" && args.author) params.set("author", args.author);
        if (typeof args.tag === "string" && args.tag) params.set("tag", args.tag);
        params.set("limit", String(limit));
        const result = await context.board.get(`/api/read?${params.toString()}`);
        return JSON.stringify({ ok: true, posts: summarizePosts(result?.posts) }, null, 1);
      },
    },
    {
      name: "stoa_status",
      description: "查看本会话 Stoa 状态：实例地址/数据目录、当前身份、未读计数、注入与子代理开关。",
      parameters: {},
      output: TEXT_OUTPUT,
      async execute(_args, exec) {
        const sessionId = exec?.agent?.id;
        if (typeof sessionId !== "string" || !sessionId) return disabledResult();
        const context = await runtime.callContextFor(sessionId);
        if (!context) return disabledResult();
        let unread = null;
        try {
          const peek = await context.board.get("/api/notifications?peek=1&limit=1");
          unread = typeof peek?.unread_count === "number" ? peek.unread_count : null;
        } catch {
          unread = null;
        }
        const description = runtime.describeSession(sessionId) ?? {};
        const payload = JSON.stringify(
          {
            ok: true,
            instance: {
              baseUrl: context.baseUrl,
              dataDir: context.dataDir,
              serviceId: context.serviceId ?? null,
              publicUrl: context.publicUrl ?? null,
            },
            account: context.accountId,
            unread_count: unread,
            injection: description.injection ?? null,
            subagents: description.subagents ?? null,
          },
          null,
          1,
        );
        // `injection.lastError` carries raw transport messages; scrub it like
        // the command side does so a token echoed by a board never reaches the
        // model through a tool result either.
        return typeof runtime.redact === "function" ? runtime.redact(payload) : payload;
      },
    },
    {
      name: "stoa_open_account",
      description:
        "为本会话 Stoa 板预开一个子代理账号（可指定 name/display；省略则从内置姓名池随机）。把返回的 id 写进子代理任务文本 `[[stoa:<id>]]`，该子代理就会以这个身份收发消息。",
      parameters: {
        name: { type: "string", description: "账号 id（小写字母/数字，1-32 字符；省略则自动取名）。" },
        display: { type: "string", description: "展示名（省略则同 id 或自动取名）。" },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const sessionId = exec?.agent?.id;
        if (typeof sessionId !== "string" || !sessionId) return disabledResult();
        const open = await runtime.openAccountFor(sessionId, {
          name: typeof args.name === "string" && args.name ? args.name : null,
          display: typeof args.display === "string" && args.display ? args.display : null,
        });
        if (!open) return disabledResult();
        return JSON.stringify(
          { ok: true, id: open.id, display: open.display, marker: `[[stoa:${open.id}]]` },
          null,
          1,
        );
      },
    },
  ];
}

/**
 * Register every spec through `defineTool`; a missing `tools` service or a
 * failing `defineTool` returns a readable error instead of breaking plugin load.
 *
 * @returns {{ registered: string[], disposers: Array<() => void>, error: string|null }}
 */
export function registerStoaTools({ tools, defineTool, runtime, log = {} }) {
  const registered = [];
  const disposers = [];
  if (!tools || typeof tools.register !== "function") {
    return { registered, disposers, error: "ctx.tools is not available in this composition" };
  }
  if (typeof defineTool !== "function") {
    return { registered, disposers, error: "defineTool (@deepseek-ai/dsh-tools) could not be loaded" };
  }
  for (const spec of buildToolSpecs(runtime)) {
    try {
      const disposer = tools.register(defineTool(spec));
      if (typeof disposer === "function") disposers.push(disposer);
      registered.push(spec.name);
    } catch (error) {
      const message = `stoa: tool ${spec.name} failed to register: ${String(error?.message ?? error)}`;
      log.warn?.(message);
      return { registered, disposers, error: message };
    }
  }
  return { registered, disposers, error: null };
}

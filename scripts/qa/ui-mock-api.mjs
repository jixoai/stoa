#!/usr/bin/env bun
/**
 * 临时 UI mock（link-preview 前端截图用，不入库）。
 *
 * 只实现壳启动所需的最小 REST + 一条保持打开的 SSE 流；previews 按
 * `PostView.previews` 契约直接返回，并暴露 `/__emit` 让截图脚本注入
 * `post.updated` 事件（验证轮播按 canonicalUrl 保持当前页）。
 */
const PORT = Number(process.env.MOCK_PORT ?? 13612);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const now = Date.now();

const ACCOUNTS = [
  {
    id: "owner",
    display: "Owner",
    profile: "项目所有者",
    avatar: "",
    role: "owner",
    disabled: 0,
  },
  {
    id: "manager",
    display: "Manager",
    profile: "项目经理",
    avatar: "",
    role: "manager",
    disabled: 0,
  },
  {
    id: "agent",
    display: "Agent",
    profile: "AI 员工",
    avatar: "",
    role: "agent",
    disabled: 0,
  },
];

const byId = new Map(ACCOUNTS.map((account) => [account.id, account]));

function cover(n, w = 800, h = 600) {
  return { url: `${ORIGIN}/cover.svg?n=${n}`, w, h, kind: "og" };
}

function preview(input) {
  const {
    url,
    status,
    phase,
    title = null,
    description = null,
    kind = "page",
    cover: image = null,
    error_code = null,
    updated_at = now,
    label = null,
  } = input;
  let site_name = null;
  try {
    site_name = new URL(url).hostname;
  } catch {
    // ignore
  }
  return {
    url,
    final_url: url,
    label,
    kind,
    mime: null,
    title,
    description,
    site_name,
    cover: image,
    status,
    phase,
    fields_ready: status === "ready" ? ["kind", "title", "description", "site_name", "cover"] : [],
    cache_key: "mock-cache-key",
    attempts: 1,
    updated_at,
    error_code,
  };
}

const POSTS = [
  {
    id: "p-pending",
    body_md: "刚发出的帖子：预览排队中（pending）。\n\nhttps://example.com/pending",
    tags: ["result"],
    previews: [
      preview({
        url: "https://example.com/pending",
        status: "pending",
        phase: "queued",
        updated_at: now - 9000,
      }),
    ],
  },
  {
    id: "p-partial",
    body_md:
      "多阶段推进：元数据阶段已完成，封面阶段还在队列里。\n\nhttps://example.com/partial",
    tags: ["result"],
    previews: [
      preview({
        url: "https://example.com/partial",
        status: "partial",
        phase: "meta",
        title: "部分阶段：标题与描述已就绪",
        description: "封面阶段稍后到达；卡片高度保持稳定，不产生 CLS。",
        updated_at: now - 8000,
      }),
    ],
  },
  {
    id: "p-ready",
    body_md:
      "完整预览：标题、描述与封面都已就绪。\n\nhttps://example.com/ready 点击整卡在新窗口打开。",
    tags: ["result"],
    previews: [
      preview({
        url: "https://example.com/ready",
        status: "ready",
        phase: "cover",
        title: "FDE2E 链接预览完成态",
        description: "封面、标题与描述全部就绪；点击整卡在新窗口打开，原文链接在卡片底部。",
        cover: cover(2),
        updated_at: now - 7000,
      }),
    ],
  },
  {
    id: "p-failed",
    body_md: "抓取失败：私网地址被 SSRF 策略拦截。\n\nhttps://127.0.0.1/secret",
    tags: ["result"],
    previews: [
      preview({
        url: "https://127.0.0.1/secret",
        status: "failed",
        phase: "probe",
        error_code: "blocked_private",
        updated_at: now - 6000,
      }),
    ],
  },
  {
    id: "p-partial-fail",
    body_md:
      "同一张卡先 partial、随后失败：必须保留槽位高度，不能塌成 40px。\n\nhttps://example.com/partial-then-fail",
    tags: ["result"],
    previews: [
      preview({
        url: "https://example.com/partial-then-fail",
        status: "partial",
        phase: "meta",
        title: "先 partial 后 failed",
        description: "事件把状态改为 failed 时，卡片高度保持与 partial 一致。",
        updated_at: now - 5500,
      }),
    ],
  },
  {
    id: "p-carousel",
    body_md:
      "一个帖子最多三条链接，一页一张、平权轮播：\n\nhttps://alpha.example/a\n\nhttps://beta.example/b\n\nhttps://gamma.example/c",
    tags: ["result"],
    previews: [
      preview({
        url: "https://alpha.example/a",
        status: "ready",
        phase: "cover",
        title: "第一张：Alpha 长文",
        description: "轮播第 1 页；触摸拖拽、桌面箭头、底部指示点与键盘左右都能切换。",
        cover: cover(3),
        updated_at: now - 5000,
      }),
      preview({
        url: "https://beta.example/b",
        status: "ready",
        phase: "cover",
        title: "第二张：Beta 设计稿",
        description: "轮播第 2 页。post.updated 到达后仍保持当前页，不重置。",
        cover: cover(4),
        updated_at: now - 4000,
      }),
      preview({
        url: "https://gamma.example/c",
        status: "ready",
        phase: "cover",
        title: "第三张：Gamma 发布说明",
        description: "轮播第 3 页；顺序与正文出现顺序一致，没有主卡特权。",
        cover: cover(5),
        updated_at: now - 3000,
      }),
    ],
  },
];

const posts = POSTS.map((post, index) => {
  const author = byId.get("owner");
  return {
    id: post.id,
    author: "owner",
    body_md: post.body_md,
    parent_id: null,
    root_id: post.id,
    self_thread_id: post.id,
    self_thread_is_leaf: 1,
    reply_to_account_id: null,
    quoted_post_id: null,
    tags: post.tags,
    created_at: now - index * 60_000,
    seq: index + 1,
    batch_id: "mock-batch",
    deleted_at: null,
    author_account: author,
    media: [],
    reply_count: 0,
    quoted: null,
    quoted_visible: false,
    previews: post.previews,
  };
});

const postsById = new Map(posts.map((post) => [post.id, post]));
const INITIAL_PREVIEWS = new Map(posts.map((post) => [post.id, structuredClone(post.previews)]));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-max-age": "600",
    },
  });
}

const AUTH_STATUS = {
  mode: "open",
  auth_enabled: false,
  auth_value_masked: "",
  env_files_loaded: [],
  env_files_missing: [],
  access_token_ttl_ms: 0,
  open_mode_warning: null,
};

const PLUGIN = {
  id: "link-preview",
  name: "链接预览",
  description: "识别帖文中的链接并在后台抓取标题、描述与封面（图片裁剪为后续能力）。",
  version: "1.0.0",
  rules_version: 3,
  kind: "preview",
  capabilities: ["url-extract", "preview-resolve", "viewer-open"],
  enabled: true,
  default_enabled: true,
  requires: [{ id: "file-viewer", optional: true, status: "missing" }],
  viewer_base: "https://file-viewer.tool.fde2e.com",
  worker: {
    queued: 2,
    running: 1,
    ready: 18,
    partial: 3,
    failed: 1,
    last_error: "timeout: https://slow.example/page",
  },
  limits: { previews_per_post: 3, url_max_chars: 2048 },
};

const sseClients = new Set();
let eventSeq = 10_000;
/** N2 首帧门测试用：延迟/强制开关/能力矩阵。 */
let pluginDelayMs = 0;
let pluginEnabledOverride = null;
let previewFields = true;

function currentPlugin() {
  return pluginEnabledOverride === null
    ? PLUGIN
    : { ...PLUGIN, enabled: pluginEnabledOverride };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "authorization,content-type",
          "access-control-max-age": "600",
        },
      });
    }

    if (url.pathname === "/healthz") {
      return json({ ok: true, dataDir: "mock", version: "mock", instanceId: "mock" });
    }
    if (url.pathname === "/api/auth/status") return json(AUTH_STATUS);
    if (url.pathname === "/api/capabilities") {
      return json({
        ok: true,
        product: "fde2e-report-worker",
        version: "mock",
        protocol: 1,
        features: { preview_fields: previewFields, preview_events: previewFields },
      });
    }
    if (url.pathname === "/api/status") {
      return json({
        server: {
          instanceId: "mock",
          pid: process.pid,
          port: PORT,
          dataDir: "mock",
          startedAt: now,
          openMode: true,
          openExposed: false,
        },
        account: { id: "owner", role: "owner" },
        auth: AUTH_STATUS,
        preview_worker: { queued: 2, running: 1, ready: 18, partial: 3, failed: 1, last_error: null },
      });
    }
    if (url.pathname === "/api/who") {
      return json({
        accounts: ACCOUNTS.map((account) => ({
          ...account,
          online: account.id !== "agent",
          last_seen: now,
        })),
        presence_ttl_ms: 90_000,
      });
    }
    if (url.pathname === "/api/accounts") {
      return json({
        accounts: ACCOUNTS.map((account) => ({ ...account, created_at: now })),
      });
    }
    if (url.pathname === "/api/feed" || url.pathname === "/api/timeline") {
      const tab = url.searchParams.get("tab") ?? "recommended";
      return json({
        ...(url.pathname === "/api/feed" ? { tab } : {}),
        posts,
        has_more: false,
        next_cursor: null,
        order: "desc",
        as_of_seq: 10_000,
      });
    }
    if (url.pathname === "/api/plugins") {
      if (pluginDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, pluginDelayMs));
      return json({ ok: true, plugins: [currentPlugin()] });
    }
    if (url.pathname.startsWith("/api/plugins/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/plugins/".length));
      if (id !== PLUGIN.id) return json({ ok: false, error: "plugin not found" }, 404);
      if (request.method === "PATCH") {
        const body = await request.json().catch(() => ({}));
        PLUGIN.enabled = Boolean(body?.enabled);
        for (const client of sseClients) {
          client.send("plugin.updated", {
            plugin_id: PLUGIN.id,
            enabled: PLUGIN.enabled,
            version: PLUGIN.version,
          });
        }
        return json({ ok: true, plugin: currentPlugin() });
      }
      return json({ ok: false, error: "method not allowed" }, 405);
    }
    if (url.pathname === "/api/bookmarks/ids") return json({ ok: true, ids: [] });
    if (url.pathname.startsWith("/api/profile/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/profile/".length));
      const account = byId.get(id);
      if (!account) return json({ ok: false, error: "account not found" }, 404);
      return json({
        account: {
          ...account,
          created_at: now,
          following: false,
          follower_count: 0,
          following_count: 0,
          online: true,
          last_seen: now,
        },
        posts: [],
        has_more: false,
        next_cursor: null,
        order: "desc",
        as_of_seq: 10_000,
      });
    }
    if (url.pathname.startsWith("/api/thread/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/thread/".length));
      const post = postsById.get(id);
      if (!post) return json({ ok: false, error: "post not found" }, 404);
      return json({
        thread: {
          root_id: post.id,
          focal_id: post.id,
          spine_complete: true,
          posts: [
            {
              ...post,
              depth: 0,
              is_spine: true,
              is_self_continuation: false,
              child_count: 0,
            },
          ],
          collapsed: [],
          participants: ["owner"],
          as_of_seq: 10_000,
        },
      });
    }
    if (url.pathname === "/api/notifications") {
      return json({
        events: [],
        target: null,
        cursor: 0,
        role: "owner",
        unread_count: 0,
        unread_by_target: {},
        limit: 100,
        has_more: false,
      });
    }
    if (url.pathname === "/api/stream") {
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const send = (event, data) =>
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            send("hello", {
              hub: 2,
              account: "owner",
              role: "owner",
              cursor: 0,
              as_of_seq: 10_000,
              since: null,
              replay_limit: 500,
              heartbeat_ms: 15_000,
              instance_id: "mock",
              auth_mode: "open",
            });
            const heartbeat = setInterval(() => {
              try {
                send("heartbeat", { as_of_seq: 10_000, unread_count: 0 });
              } catch {
                clearInterval(heartbeat);
              }
            }, 10_000);
            const client = {
              send,
              close() {
                clearInterval(heartbeat);
                try {
                  controller.close();
                } catch {
                  // already closed
                }
              },
            };
            sseClients.add(client);
          },
          cancel() {
            for (const client of sseClients) client.close();
            sseClients.clear();
          },
        }),
        {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
          },
        },
      );
    }
    if (url.pathname === "/cover.svg") {
      const n = Number(url.searchParams.get("n") ?? 1);
      const hue = [212, 265, 160, 24, 330, 190][n % 6];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 70% 42%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360} 65% 24%)"/>
    </linearGradient>
  </defs>
  <rect width="800" height="600" fill="url(#g)"/>
  <circle cx="640" cy="140" r="150" fill="rgba(255,255,255,.12)"/>
  <circle cx="160" cy="480" r="210" fill="rgba(255,255,255,.08)"/>
  <text x="56" y="300" fill="rgba(255,255,255,.92)" font-family="system-ui, sans-serif" font-size="54" font-weight="700">FDE2E</text>
  <text x="58" y="352" fill="rgba(255,255,255,.72)" font-family="system-ui, sans-serif" font-size="28">link preview cover ${n}</text>
</svg>`;
      return new Response(svg, {
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        },
      });
    }
    if (url.pathname === "/__config" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (typeof body?.pluginDelayMs === "number") pluginDelayMs = body.pluginDelayMs;
      if (typeof body?.pluginEnabled === "boolean") pluginEnabledOverride = body.pluginEnabled;
      if (typeof body?.previewFields === "boolean") previewFields = body.previewFields;
      return json({ ok: true, pluginDelayMs, pluginEnabledOverride, previewFields });
    }
    if (url.pathname === "/__reset" && request.method === "POST") {
      pluginDelayMs = 0;
      pluginEnabledOverride = null;
      previewFields = true;
      for (const post of posts) {
        post.previews = structuredClone(INITIAL_PREVIEWS.get(post.id));
      }
      PLUGIN.enabled = true;
      return json({ ok: true });
    }
    if (url.pathname === "/__emit" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const post = postsById.get(body?.post_id);
      if (!post) return json({ ok: false, error: "unknown post" }, 404);
      const previews = Array.isArray(body?.previews) ? body.previews : post.previews;
      post.previews = previews;
      eventSeq += 1;
      for (const client of sseClients) {
        client.send("hub", {
          seq: eventSeq,
          type: "post.updated",
          actor: "owner",
          post_id: post.id,
          root_id: post.id,
          batch_id: "mock-batch",
          created_at: Date.now(),
          payload: {
            post_id: post.id,
            root_id: post.id,
            phase: "cover",
            status: "ready",
            previews,
          },
        });
      }
      return json({ ok: true, seq: eventSeq });
    }
    return json({ ok: false, error: `not found: ${url.pathname}` }, 404);
  },
});

console.log(`ui mock api listening on ${ORIGIN}`);

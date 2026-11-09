/**
 * 公示板侧栏面板（MCP App 资源：`ui://stoa/board.html`）。
 * 来源＝现 ZCode 插件 `plugins/report-channel/scripts/lib/panel.mjs` 的 TS 移植：
 * HTML 模板体逐字保持（仅资源 URI 更名 `ui://report-channel/board.html` → `ui://stoa/board.html`，
 * 以及 MCP Apps 桥身份 `appInfo.name` 中性化 `report-channel` → `stoa`），
 * `text/html;profile=mcp-app` 与「桥不通则降级为静态说明 + 直链」的行为不变。
 *
 * 官方口径：侧栏入口 = 清单 `ui.surfaces` + MCP `resources/read` 返回
 * `text/html;profile=mcp-app` 的 HTML（对照官方 pdf 0.2.x 的 dist/server.mjs + dist/ui/panel.html）。
 * 面板内用 MCP Apps 桥（postMessage JSON-RPC：ui/initialize → ui/notifications/initialized →
 * tools/call / ui/open-link）拿数据；桥不可用时降级为静态说明 + 直链，绝不留白屏。
 *
 * 配置由服务端在 read 时注入（`__REPORT_CHANNEL_BOOT__` 占位）——注入内容只含
 * baseUrl/publicUrl/account，绝不含凭据。
 */
import type { McpConfig } from "./config.ts";

/** 资源 URI（stoa-adapters design §6：随插件更名，面板语义不变）。 */
export const PANEL_URI = "ui://stoa/board.html";
export const PANEL_MIME = "text/html;profile=mcp-app";

/** `resources/list` 的清单条目（name/title/mimeType 与旧插件逐字一致）。 */
export const PANEL_RESOURCE = {
  uri: PANEL_URI,
  name: "公示板",
  title: "公示板（侧栏面板）",
  mimeType: PANEL_MIME,
} as const;

export function renderPanelHtml(cfg: McpConfig): string {
  const boot = JSON.stringify({
    baseUrl: cfg.baseUrl,
    publicUrl: cfg.publicUrl,
    account: cfg.account,
  });
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>公示板</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:transparent;color:#111}
  @media (prefers-color-scheme:dark){body{color:#eee}}
  header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(127,127,127,.22);position:sticky;top:0;background:color-mix(in srgb,Canvas 88%,transparent);backdrop-filter:blur(8px)}
  header b{font-size:13px}
  .badge{margin-left:auto;font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.16)}
  .badge.hot{background:#c62828;color:#fff}
  .wrap{padding:8px 12px 16px}
  .muted{opacity:.62}
  .row{padding:8px 0;border-bottom:1px solid rgba(127,127,127,.14)}
  .row:last-child{border-bottom:0}
  .meta{display:flex;gap:6px;align-items:center;font-size:11px;opacity:.68;margin-bottom:2px}
  .tag{font-size:10px;padding:1px 6px;border-radius:999px;background:rgba(127,127,127,.16)}
  .body{white-space:pre-wrap;word-break:break-word}
  button{font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer}
  button:hover{background:rgba(127,127,127,.12)}
  .bar{display:flex;gap:8px;align-items:center;padding:10px 12px;border-top:1px solid rgba(127,127,127,.22);position:sticky;bottom:0;background:color-mix(in srgb,Canvas 88%,transparent);backdrop-filter:blur(8px)}
  .err{color:#c62828}
</style>
</head>
<body>
<header>
  <b>公示板</b>
  <span id="conn" class="muted">连接中…</span>
  <span id="unread" class="badge">…</span>
</header>
<div class="wrap" id="list"><div class="muted">加载中…</div></div>
<div class="bar">
  <button id="refresh">刷新</button>
  <button id="open">在公示板打开</button>
  <span id="hint" class="muted" style="margin-left:auto">每 20s 自动刷新</span>
</div>
<script>
const BOOT = ${boot};
let rid = 0; const pending = new Map(); let bridged = false;
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++rid;
    pending.set(id, { resolve, reject });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    setTimeout(() => { if (pending.delete(id)) reject(new Error(method + " 超时")); }, 6000);
  });
}
window.addEventListener("message", (event) => {
  // 只认宿主窗口（父窗口）的应答：顶层自答会把「桥不通」误判成「桥通了」——
  // 面板会显示编造的「在线/无新回话」，比降级提示更糟（2026-11-07 实证）。
  if (event.source === window) return;
  const msg = event.data;
  if (!msg || msg.jsonrpc !== "2.0" || msg.id === undefined) return;
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  msg.error ? slot.reject(new Error(msg.error.message || "rpc error")) : slot.resolve(msg.result);
});
async function callTool(name, args) {
  const res = await rpc("tools/call", { name, arguments: args || {} });
  const text = res?.content?.find?.((entry) => entry.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}
async function connect() {
  await rpc("ui/initialize", {
    appInfo: { name: "stoa", version: "0.3.0" },
    appCapabilities: {},
    protocolVersion: "2025-06-18",
  });
  window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
  bridged = true;
}
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function renderList(posts) {
  const list = document.getElementById("list");
  if (!posts?.length) { list.innerHTML = '<div class="muted">板上还没有内容。</div>'; return; }
  list.innerHTML = posts.map((p) => {
    const when = new Date(p.created_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const tags = (p.tags || []).map((t) => '<span class="tag">#' + esc(t) + "</span>").join(" ");
    return '<div class="row"><div class="meta"><b>@' + esc(p.author) + "</b>" + tags + '<span class="muted">' + when + '</span><button data-open="' + esc(p.id) + '" style="margin-left:auto">打开</button></div><div class="body">' + esc((p.body_md || "").slice(0, 400)) + "</div></div>";
  }).join("");
  for (const btn of list.querySelectorAll("button[data-open]")) {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-open");
      const url = BOOT.publicUrl + "/?ep=" + encodeURIComponent(BOOT.baseUrl) + "#/p/" + encodeURIComponent(id);
      if (bridged) rpc("ui/open-link", { url }).catch(() => window.open(url, "_blank"));
      else window.open(url, "_blank");
    });
  }
}
async function refresh() {
  const conn = document.getElementById("conn");
  const unread = document.getElementById("unread");
  try {
    if (!bridged) await connect();
    const [status, feed, peek] = await Promise.all([
      callTool("board_status"),
      callTool("board_read", { limit: 12 }),
      callTool("board_peek"),
    ]);
    conn.textContent = "@" + BOOT.account + " · " + (status?.status?.mode === "static" ? "静态" : "在线") + " · " + BOOT.baseUrl.replace(/^https?:\\/\\//, "");
    const unreadCount = peek?.unread ?? 0;
    unread.textContent = unreadCount > 0 ? unreadCount + " 条新回话" : "无新回话";
    unread.className = "badge" + (unreadCount > 0 ? " hot" : "");
    renderList(feed?.posts);
    document.getElementById("hint").textContent = "每 20s 自动刷新";
  } catch (error) {
    conn.innerHTML = '<span class="err">面板桥未就绪：' + esc(error.message) + "</span>";
    document.getElementById("list").innerHTML =
      '<div class="muted">此环境未提供面板桥，数据不在这里显示。可以在对话里用 board_peek / board_read 读板，或点下方按钮在浏览器打开公示板：<br><br><code>' +
      esc(BOOT.publicUrl + "/?ep=" + encodeURIComponent(BOOT.baseUrl)) + "</code></div>";
    document.getElementById("hint").textContent = "面板桥不通：数据仍在板上，用工具或直链读";
  }
}
document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("open").addEventListener("click", () => {
  const url = BOOT.publicUrl + "/?ep=" + encodeURIComponent(BOOT.baseUrl);
  if (bridged) rpc("ui/open-link", { url }).catch(() => window.open(url, "_blank"));
  else window.open(url, "_blank");
});
refresh();
setInterval(refresh, 20000);
</script>
</body>
</html>`;
}

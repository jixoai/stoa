import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { renderMarkdownHtml } from "../core/markdown.ts";
import type { PostView, ThreadView } from "../core/types.ts";
import { openDatabase } from "./db.ts";
import { Store } from "./store.ts";

export interface ExportOptions {
  dataDir: string;
  outDir?: string | null;
  prune?: boolean;
  keep?: number | null;
  now?: number;
}

export interface ExportResult {
  out_dir: string;
  as_of_seq: number;
  pages: number;
  threads: number;
  media: number;
  duration_ms: number;
}

const VIEWER = { id: "owner", role: "owner" as const };
const PAGE_SIZE = 50;

interface ExportAccount {
  id: string;
  display: string;
  profile: string;
  avatar: string;
  role: string;
  disabled: number;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function htmlPage(opts: {
  title: string;
  base: string;
  pageType: string;
  data: unknown;
  extraHead?: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="fde2e-report-worker export">
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="${opts.base}assets/app.css">
${opts.extraHead ?? ""}
</head>
<body data-base="${opts.base}" data-page="${opts.pageType}">
<div id="app"></div>
<script type="application/json" id="report-data">${safeJson(opts.data)}</script>
<script src="${opts.base}assets/app.js" defer></script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function withBodyHtml(post: PostView & { body_html?: string }): PostView & { body_html: string } {
  return { ...post, body_html: post.deleted_at ? "" : renderMarkdownHtml(post.body_md) };
}

function exportPost(post: PostView): Record<string, unknown> {
  const enriched = withBodyHtml(post);
  return {
    ...enriched,
    quoted: enriched.quoted ? withBodyHtml(enriched.quoted as unknown as PostView) : null,
  };
}

function exportThread(thread: ThreadView): Record<string, unknown> {
  return {
    ...thread,
    posts: thread.posts.map((node) => ({
      ...exportPost(node),
      depth: node.depth,
      is_spine: node.is_spine,
      is_self_continuation: node.is_self_continuation,
      child_count: node.child_count,
      ...(node.i !== undefined ? { i: node.i, n: node.n } : {}),
    })),
  };
}

function accountPayload(store: Store): ExportAccount[] {
  return store.listAccounts(true).map((account) => ({
    id: account.id,
    display: account.display,
    profile: account.profile,
    avatar: account.avatar,
    role: account.role,
    disabled: account.disabled,
  }));
}

function pruneHistory(historyDir: string, keep: number): void {
  if (!existsSync(historyDir)) return;
  const entries = readdirSync(historyDir)
    .filter((name) => {
      try {
        return statSync(join(historyDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  while (entries.length > keep) {
    const victim = entries.shift();
    if (victim) rmSync(join(historyDir, victim), { recursive: true, force: true });
  }
}

/**
 * SSG export: reads SQLite directly (no HTTP dependency) and writes a
 * self-contained static site (classic IIFE app.js, inline JSON data, no fetch).
 */
export function runExport(opts: ExportOptions): ExportResult {
  const started = Date.now();
  const now = opts.now ?? started;
  const ts = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const db = openDatabase({ dataDir: opts.dataDir, readonly: true });
  let store: Store;
  try {
    store = new Store({ dataDir: opts.dataDir, db, clock: () => now });

    const isDefaultOut = !opts.outDir;
    const outRoot = resolve(opts.outDir ?? join(opts.dataDir, "export"));
    const asOfSeq = store.maxEventSeq();
    const accounts = accountPayload(store);

    const tmpRoot = join(
      opts.dataDir,
      `.export-tmp-${ts}-${process.pid}`,
    );
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(join(tmpRoot, "assets"), { recursive: true, mode: 0o700 });
    mkdirSync(join(tmpRoot, "p"), { recursive: true, mode: 0o700 });
    mkdirSync(join(tmpRoot, "media"), { recursive: true, mode: 0o700 });

    writeFileSync(join(tmpRoot, "assets", "app.js"), APP_JS);
    writeFileSync(join(tmpRoot, "assets", "app.css"), APP_CSS);

    // gather timeline pages
    const pagesData: Array<{ posts: Record<string, unknown>[] }> = [];
    let before: string | null = null;
    for (;;) {
      const page = store.timeline({ viewer: VIEWER, limit: PAGE_SIZE, before });
      pagesData.push({ posts: page.posts.map(exportPost) });
      if (!page.has_more || !page.next_cursor) break;
      before = page.next_cursor;
      if (pagesData.length > 10_000) break; // sanity bound
    }

    const pageCount = Math.max(pagesData.length, 1);
    for (let idx = 0; idx < pageCount; idx++) {
      const fileName = idx === 0 ? "index.html" : `page-${idx + 1}.html`;
      const data = {
        page_type: "timeline",
        as_of_seq: asOfSeq,
        generated_at: now,
        accounts,
        posts: pagesData[idx]?.posts ?? [],
        page: idx + 1,
        page_count: pageCount,
        prev: idx > 0 ? (idx === 1 ? "index.html" : `page-${idx}.html`) : null,
        next: idx + 1 < pageCount ? `page-${idx + 2}.html` : null,
      };
      writeFileSync(
        join(tmpRoot, fileName),
        htmlPage({ title: "report · 时间线", base: "", pageType: "timeline", data }),
      );
    }

    // thread pages
    let threadCount = 0;
    for (const rootId of store.rootIds()) {
      const thread = store.thread({ viewer: VIEWER, postId: rootId });
      if (!thread) continue;
      threadCount += 1;
      const data = {
        page_type: "thread",
        as_of_seq: asOfSeq,
        generated_at: now,
        accounts,
        thread: exportThread(thread),
      };
      writeFileSync(
        join(tmpRoot, "p", `${rootId}.html`),
        htmlPage({
          title: `report · ${rootId.slice(0, 8)}`,
          base: "../",
          pageType: "thread",
          data,
        }),
      );
    }

    // who
    writeFileSync(
      join(tmpRoot, "who.html"),
      htmlPage({
        title: "report · 成员",
        base: "",
        pageType: "who",
        data: { page_type: "who", as_of_seq: asOfSeq, generated_at: now, accounts },
      }),
    );

    // search index (inline; no fetch under file://)
    const allPosts = store.allPostsForExport().filter((post) => post.deleted_at === null);
    const searchPosts = allPosts.map((post) => {
      const view = store.getPostView(post.id, VIEWER);
      return {
        id: post.id,
        root_id: post.root_id,
        author: post.author,
        created_at: post.created_at,
        body_md: post.body_md,
        body_html: renderMarkdownHtml(post.body_md),
        media: view?.media ?? [],
      };
    });
    writeFileSync(
      join(tmpRoot, "search.html"),
      htmlPage({
        title: "report · 搜索",
        base: "",
        pageType: "search",
        data: {
          page_type: "search",
          as_of_seq: asOfSeq,
          generated_at: now,
          accounts,
          posts: searchPosts,
        },
      }),
    );

    // media (one shared copy at the export root)
    let mediaCount = 0;
    for (const media of store.mediaForExport()) {
      const src = store.mediaPath(media.hash, media.ext);
      if (!existsSync(src)) continue;
      copyFileSync(src, join(tmpRoot, "media", `${media.hash}.${media.ext}`));
      mediaCount += 1;
    }

    // atomic swap
    mkdirSync(outRoot, { recursive: true, mode: 0o700 });
    const historyDir = join(outRoot, "history");
    const hold = join(opts.dataDir, `.export-history-hold-${process.pid}`);
    if (existsSync(hold) && !existsSync(historyDir)) renameSync(hold, historyDir);
    if (isDefaultOut && existsSync(historyDir)) {
      renameSync(historyDir, hold);
    }
    const old = `${outRoot}.old-${process.pid}-${ts}`;
    if (existsSync(outRoot)) renameSync(outRoot, old);
    renameSync(tmpRoot, outRoot);
    if (existsSync(old)) rmSync(old, { recursive: true, force: true });
    if (isDefaultOut) {
      if (existsSync(hold)) renameSync(hold, join(outRoot, "history"));
      const histRoot = join(outRoot, "history", ts);
      copyTreeExpress(outRoot, histRoot, ["history"]);
      if (opts.prune) pruneHistory(join(outRoot, "history"), Math.max(opts.keep ?? 5, 1));
    }

    return {
      out_dir: outRoot,
      as_of_seq: asOfSeq,
      pages: pageCount,
      threads: threadCount,
      media: mediaCount,
      duration_ms: Date.now() - started,
    };
  } finally {
    db.close();
  }
}

function copyTreeExpress(src: string, dest: string, skip: string[]): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (skip.includes(entry)) continue;
    const from = join(src, entry);
    const to = join(dest, entry);
    const st = statSync(from);
    if (st.isDirectory()) copyTreeExpress(from, to, []);
    else {
      try {
        linkSync(from, to);
      } catch {
        copyFileSync(from, to);
      }
    }
  }
}

/** Best-effort cleanup of interrupted exports (older than 1h). */
export function cleanupStaleExports(dataDir: string, now = Date.now()): void {
  try {
    for (const entry of readdirSync(dataDir)) {
      if (!/^\.export-tmp-|^\.export-history-hold-/.test(entry)) continue;
      const path = join(dataDir, entry);
      try {
        if (now - statSync(path).mtimeMs > 3_600_000) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

/** Mark/clear the pending-export retry flag (design §14). */
export function setPendingExportFlag(dataDir: string, pending: boolean): void {
  const db = openDatabase({ dataDir, readonly: false });
  try {
    const store = new Store({ dataDir, db });
    store.setPendingExport(pending);
  } finally {
    db.close();
  }
}

const APP_JS = String.raw`(function () {
  "use strict";
  var base = document.body.getAttribute("data-base") || "";
  var page = document.body.getAttribute("data-page") || "";
  var root = document.getElementById("app");
  var node = document.getElementById("report-data");
  var data = node ? JSON.parse(node.textContent || "{}") : {};
  var accounts = {};
  (data.accounts || []).forEach(function (a) { accounts[a.id] = a; });

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") el.textContent = attrs[k];
      else if (k === "html") el.innerHTML = attrs[k];
      else if (k === "class") el.className = attrs[k];
      else if (k === "href") el.setAttribute("href", attrs[k]);
      else if (k === "src") el.setAttribute("src", attrs[k]);
      else el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined) return;
      el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return el;
  }
  function time(ts) {
    try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); }
  }
  function initials(name) { return (name || "?").slice(0, 1).toUpperCase(); }
  function avatar(a, size) {
    var who = accounts[a] || { id: a, display: a, avatar: "slate" };
    var el = h("span", { class: "avatar avatar-" + (who.avatar || "slate") + (size === "small" ? " small" : ""), text: initials(who.display || who.id) });
    el.title = who.display + " @" + a;
    return el;
  }
  function mediaGrid(media) {
    if (!media || !media.length) return null;
    var wrap = h("div", { class: "media media-" + media.length });
    media.slice(0, 4).forEach(function (m) {
      var src = base + "media/" + m.hash + "." + m.ext;
      var img = h("img", { src: src, alt: m.hash.slice(0, 8), loading: "lazy" });
      wrap.appendChild(img);
    });
    return wrap;
  }
  function postCard(p, opts) {
    opts = opts || {};
    var author = accounts[p.author] || { id: p.author, display: p.author };
    var card = h("article", { class: "post" + (p.deleted_at ? " deleted" : "") });
    if (p.is_self_continuation) card.className += " continuation";
    var head = h("header", { class: "post-head" }, [
      avatar(p.author, p.is_self_continuation ? "small" : ""),
      h("div", { class: "post-meta" }, [
        h("span", { class: "display", text: author.display }),
        h("span", { class: "handle", text: "@" + p.author }),
        h("span", { class: "time", text: time(p.created_at) })
      ])
    ]);
    card.appendChild(head);
    var body = h("div", { class: "body" });
    if (p.deleted_at) body.appendChild(h("div", { class: "tombstone", text: "此帖已删除" }));
    else body.innerHTML = p.body_html || "";
    card.appendChild(body);
    var media = mediaGrid(p.media);
    if (media) card.appendChild(media);
    if (p.quoted) {
      var q = h("a", { class: "quote", href: base + "p/" + p.quoted.id + ".html" });
      var qa = accounts[p.quoted.author] || { display: p.quoted.author };
      q.appendChild(h("div", { class: "quote-head", text: qa.display + " @" + p.quoted.author }));
      var qb = h("div", { class: "quote-body" });
      qb.innerHTML = p.quoted.body_html || "";
      q.appendChild(qb);
      card.appendChild(q);
    } else if (p.quoted_post_id && p.quoted_visible === false) {
      card.appendChild(h("div", { class: "quote unavailable", text: "引用内容不可见" }));
    }
    var foot = h("footer", { class: "post-foot" });
    if (p.parent_id === null) {
      foot.appendChild(h("a", { href: base + "p/" + p.id + ".html", text: "查看会话" + (p.reply_count ? " · " + p.reply_count + " 条回复" : "") }));
    }
    if (p.i !== undefined && p.n !== undefined) {
      foot.appendChild(h("span", { class: "badge", text: p.i + "/" + p.n }));
    }
    card.appendChild(foot);
    return card;
  }
  function renderTimeline() {
    root.appendChild(h("nav", { class: "nav" }, [
      h("a", { href: "index.html", text: "时间线" }),
      h("a", { href: "search.html", text: "搜索" }),
      h("a", { href: "who.html", text: "成员" })
    ]));
    root.appendChild(h("h1", { text: "report" }));
    if (!data.posts || !data.posts.length) {
      root.appendChild(h("p", { class: "empty", text: "还没有帖子" }));
    } else {
      data.posts.forEach(function (p) { root.appendChild(postCard(p)); });
    }
    var pager = h("div", { class: "pager" });
    if (data.prev) pager.appendChild(h("a", { href: data.prev, text: "← 更新" }));
    pager.appendChild(h("span", { text: "第 " + data.page + " / " + data.page_count + " 页" }));
    if (data.next) pager.appendChild(h("a", { href: data.next, text: "更早 →" }));
    root.appendChild(pager);
    root.appendChild(h("footer", { class: "foot", text: "静态归档 · as-of seq " + data.as_of_seq }));
  }
  function renderThread() {
    var t = data.thread;
    root.appendChild(h("nav", { class: "nav" }, [
      h("a", { href: "../index.html", text: "← 时间线" }),
      h("a", { href: "../search.html", text: "搜索" }),
      h("a", { href: "../who.html", text: "成员" })
    ]));
    root.appendChild(h("h1", { text: "会话" }));
    (t.posts || []).forEach(function (p) {
      var wrap = h("div", { class: "thread-node" });
      wrap.style.marginLeft = Math.min(p.depth, 3) * 24 + "px";
      wrap.appendChild(postCard(p));
      root.appendChild(wrap);
    });
    (t.collapsed || []).forEach(function (group) {
      root.appendChild(h("div", { class: "collapsed", text: "继续 " + group.count + " 层回复" }));
    });
    root.appendChild(h("footer", { class: "foot", text: "静态归档 · as-of seq " + data.as_of_seq }));
  }
  function renderWho() {
    root.appendChild(h("nav", { class: "nav" }, [
      h("a", { href: "index.html", text: "时间线" }),
      h("a", { href: "search.html", text: "搜索" })
    ]));
    root.appendChild(h("h1", { text: "成员" }));
    var list = h("div", { class: "who" });
    (data.accounts || []).forEach(function (a) {
      if (a.disabled === 2) return;
      var row = h("div", { class: "who-row" }, [
        avatar(a.id),
        h("div", { class: "who-meta" }, [
          h("div", { class: "display", text: a.display }),
          h("div", { class: "handle", text: "@" + a.id + " · " + a.role }),
          h("div", { class: "profile", text: a.profile || "" })
        ])
      ]);
      list.appendChild(row);
    });
    root.appendChild(list);
    root.appendChild(h("footer", { class: "foot", text: "静态归档 · as-of seq " + data.as_of_seq }));
  }
  function renderSearch() {
    root.appendChild(h("nav", { class: "nav" }, [
      h("a", { href: "index.html", text: "时间线" }),
      h("a", { href: "who.html", text: "成员" })
    ]));
    root.appendChild(h("h1", { text: "搜索" }));
    var input = h("input", { type: "search", placeholder: "搜索正文 / 作者", class: "search" });
    var results = h("div", { class: "results" });
    root.appendChild(input);
    root.appendChild(results);
    function run() {
      var q = input.value.trim().toLowerCase();
      while (results.firstChild) results.removeChild(results.firstChild);
      if (!q) return;
      var hits = (data.posts || []).filter(function (p) {
        return (p.body_md || "").toLowerCase().indexOf(q) >= 0 || p.author.indexOf(q) >= 0;
      }).slice(0, 100);
      results.appendChild(h("p", { class: "hint", text: hits.length + " 条结果" }));
      hits.forEach(function (p) {
        var a = h("a", { class: "search-hit", href: "p/" + p.root_id + ".html" });
        var who = accounts[p.author] || { display: p.author };
        a.appendChild(h("div", { class: "search-meta", text: who.display + " @" + p.author + " · " + time(p.created_at) }));
        var b = h("div", { class: "search-body" });
        b.innerHTML = p.body_html || "";
        a.appendChild(b);
        results.appendChild(a);
      });
    }
    input.addEventListener("input", run);
    input.focus();
    root.appendChild(h("footer", { class: "foot", text: "静态归档 · as-of seq " + data.as_of_seq }));
  }
  if (page === "timeline") renderTimeline();
  else if (page === "thread") renderThread();
  else if (page === "who") renderWho();
  else if (page === "search") renderSearch();
})();
`;

const APP_CSS = String.raw`*{box-sizing:border-box}
:root{--bg:#0b0e13;--panel:#121722;--panel2:#171e2b;--text:#e8edf7;--dim:#8b97ad;--line:#232c3d;--accent:#5b9dff;--radius:18px}
@media (prefers-color-scheme:light){:root{--bg:#f5f7fb;--panel:#fff;--panel2:#f0f3f9;--text:#101725;--dim:#5c6779;--line:#e2e8f2;--accent:#1c6cf0}}
html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
#app{max-width:720px;margin:0 auto;padding:24px 16px 72px}
h1{font-size:22px;margin:8px 0 20px}
.nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.nav a{color:var(--dim);text-decoration:none;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--panel)}
.nav a:hover{color:var(--text);border-color:var(--accent)}
.post{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin:12px 0}
.post.continuation{margin-top:6px;padding:12px 16px}
.post-head{display:flex;gap:12px;align-items:center;margin-bottom:10px}
.post.continuation .post-head{margin-bottom:6px}
.avatar{width:42px;height:42px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:700;color:#fff;background:#64748b;flex:0 0 auto}
.avatar.small{width:24px;height:24px;font-size:11px}
.avatar-slate{background:#64748b}.avatar-sky{background:#0284c7}.avatar-violet{background:#7c3aed}.avatar-amber{background:#b45309}.avatar-emerald{background:#047857}.avatar-rose{background:#be123c}.avatar-teal{background:#0f766e}.avatar-indigo{background:#4338ca}
.post-meta{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.display{font-weight:700}
.handle,.time,.hint{color:var(--dim);font-size:13px}
.body{word-break:break-word}
.body p{margin:0 0 .7em}.body p:last-child{margin-bottom:0}
.body pre{background:var(--panel2);padding:12px;border-radius:12px;overflow:auto;font-size:13px}
.body code{background:var(--panel2);padding:1px 5px;border-radius:6px;font-size:13px}
.body pre code{background:none;padding:0}
.body blockquote{margin:0;border-left:3px solid var(--line);padding-left:12px;color:var(--dim)}
.body table{border-collapse:collapse;width:100%;margin:8px 0;font-size:14px}
.body th,.body td{border:1px solid var(--line);padding:6px 8px;text-align:left}
.body img{max-width:100%;border-radius:12px}
.media{display:grid;gap:2px;margin-top:12px;border-radius:16px;overflow:hidden}
.media-1{grid-template-columns:1fr}.media-2{grid-template-columns:1fr 1fr}.media-3{grid-template-columns:2fr 1fr}.media-4{grid-template-columns:1fr 1fr}
.media img{width:100%;height:100%;object-fit:cover;max-height:510px;display:block;background:var(--panel2)}
.media-3 img:first-child{grid-row:span 2}
.quote{display:block;border:1px solid var(--line);border-radius:14px;padding:12px;margin-top:12px;text-decoration:none;color:inherit;background:var(--panel2)}
.quote-head{font-weight:600;font-size:13px}.quote-body{color:var(--dim);font-size:14px;max-height:120px;overflow:hidden}
.quote.unavailable{color:var(--dim);font-size:13px}
.post-foot{display:flex;gap:12px;align-items:center;margin-top:12px;font-size:13px}
.post-foot a{color:var(--accent);text-decoration:none}
.badge{background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:12px;color:var(--dim)}
.tombstone{color:var(--dim);font-style:italic}
.pager{display:flex;gap:16px;justify-content:center;align-items:center;margin:24px 0;color:var(--dim)}
.pager a{color:var(--accent);text-decoration:none}
.foot{color:var(--dim);font-size:12px;text-align:center;margin-top:32px}
.thread-node{position:relative}
.collapsed{margin:8px 0 16px 24px;padding:8px 12px;border-left:1px solid var(--line);color:var(--dim);font-size:13px}
.who-row{display:flex;gap:12px;align-items:center;padding:14px;background:var(--panel);border:1px solid var(--line);border-radius:14px;margin-bottom:10px}
.who-meta .profile{color:var(--dim);font-size:13px}
.search{width:100%;padding:12px 14px;border-radius:14px;border:1px solid var(--line);background:var(--panel);color:var(--text);font-size:15px;margin-bottom:16px}
.search-hit{display:block;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px;text-decoration:none;color:inherit}
.search-meta{font-size:13px;color:var(--dim);margin-bottom:6px}
.empty{color:var(--dim);text-align:center;padding:40px}
`;

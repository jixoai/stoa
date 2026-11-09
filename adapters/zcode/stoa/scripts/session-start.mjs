#!/usr/bin/env node
/**
 * SessionStart / UserPromptSubmit 钩子：探一眼公示板有没有 Owner/他人的新回话，
 * 有就把「去读板」写进会话上下文。
 *
 * 只做 peek（不消费、不 ack），2.5s 超时；任何失败都静默退出 0——
 * 钩子绝不能让会话起不来。真正的读取/回复由 board_read / board_reply 工具完成。
 *
 * 纪律：
 *  - 计数按**帖子 id 去重**：`thread.invited` 会随附一条 `thread.snapshot` 合成行
 *    （含整条线程），同一帖的 `post.created`/`thread.invited`/snapshot 只算 1 条，
 *    不把合成行当新回话重复计数。
 *  - 事件名**严格透传**输入里的 `hook_event_name`（缺省才用 `SessionStart`）；
 *    输出 `hookSpecificOutput.hookEventName` 与输入一致，宿主才不会把 UserPromptSubmit
 *    的输出当成 SessionStart 拒掉。
 */
import { api, loadConfig } from "./lib/config.mjs";

function output(eventName, context) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, additionalContext: context },
    })}\n`,
  );
}

/** 钩子事件 JSON 走 stdin（Claude 系约定）；不给就按 SessionStart 处理，最多等 300ms。 */
async function readHookEvent() {
  if (process.stdin.isTTY) return null;
  return await new Promise((resolve) => {
    let raw = "";
    const timer = setTimeout(() => resolve(null), 300);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function excerpt(text, max = 120) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 通知页 → 去重后的展示行（每帖一条，按事件首次出现顺序）。
 * 事件行提供 post_id/actor/type；`thread.snapshot` 只用来补正文，不单独计数。
 */
function summarizeEvents(events) {
  const eventPosts = new Map(); // post_id → 事件行（先到先得）
  for (const event of events) {
    if (!event || event.type === "thread.snapshot" || !event.post_id) continue;
    if (!eventPosts.has(event.post_id)) eventPosts.set(event.post_id, event);
  }
  const postById = new Map(); // post_id → snapshot 里的帖子（正文来源）
  for (const event of events) {
    if (event?.type !== "thread.snapshot") continue;
    for (const post of event.thread?.posts ?? []) {
      if (post?.id) postById.set(post.id, post);
    }
  }
  const lines = [...eventPosts.entries()].slice(0, 5).map(([id, event]) => {
    const post = postById.get(id);
    if (post) {
      return `- @${post.author ?? event.actor ?? "?"}（帖子 ${id}）: ${excerpt(post.body_md) || "(无正文)"}`;
    }
    return `- [${event.type}] @${event.actor ?? "?"}（帖子 ${id}）`;
  });
  return { count: eventPosts.size, lines };
}

try {
  const hookEvent = await readHookEvent();
  // 严格透传：宿主给什么就回什么（UserPromptSubmit 不能被改写成 SessionStart）。
  const eventName =
    typeof hookEvent?.hook_event_name === "string" ? hookEvent.hook_event_name : "SessionStart";
  const cfg = loadConfig();
  const res = await api(cfg, "/api/notifications?peek=1", { timeoutMs: 2500 });
  const events = Array.isArray(res.events) ? res.events : [];
  const { count, lines } = summarizeEvents(events);
  if (count === 0) process.exit(0);
  output(
    eventName,
    [
      `<stoa>公示板有 ${count} 条新回话（未消费）。`,
      ...lines,
      "默认用 `watch.mjs --state-file <本会话 state>` 后台常驻（本地游标，不消费）；只有唯一主会话才允许 `--consume`。",
      "先 board_read 对应线程、该回就 board_reply，然后按主线纪律继续。</stoa>",
    ].join("\n"),
  );
} catch {
  // 板不可达/未配置：静默不打扰会话
}
process.exit(0);

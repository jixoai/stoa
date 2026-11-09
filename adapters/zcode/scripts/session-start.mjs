#!/usr/bin/env node
/**
 * SessionStart 钩子：探一眼公示板有没有 Owner/他人的新回话，有就把「去读板」写进会话上下文。
 *
 * 只做 peek（不消费、不 ack），2.5s 超时；任何失败都静默退出 0——
 * 钩子绝不能让会话起不来。真正的读取/回复由 board_inbox / board_read 工具完成。
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

try {
  const hookEvent = await readHookEvent();
  const eventName = typeof hookEvent?.hook_event_name === "string" ? hookEvent.hook_event_name : "SessionStart";
  const cfg = loadConfig();
  const res = await api(cfg, "/api/notifications?peek=1", { timeoutMs: 2500 });
  const events = res.events ?? [];
  if (events.length === 0) process.exit(0);
  const lines = events.slice(0, 5).map((event) => {
    const body = String(
      event.payload?.body_md ?? event.body_md ?? event.payload?.excerpt ?? event.body ?? "",
    )
      .replace(/\s+/g, " ")
      .slice(0, 120);
    const actor = event.actor ?? event.author ?? "?";
    const kind = event.kind ?? event.type ?? "event";
    return `- [${kind}] @${actor}: ${body}`;
  });
  output(
    eventName,
    [
      `<report-channel>公示板有 ${events.length} 条新回话（未消费）。`,
      ...lines,
      "先 board_read 对应线程、该回就 board_reply，然后按主线纪律继续（board_inbox 后台常驻订阅）。</report-channel>",
    ].join("\n"),
  );
} catch {
  // 板不可达/未配置：静默，不打扰会话
}
process.exit(0);

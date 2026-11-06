import { writeSync } from "node:fs";
import type { PostView } from "../core/types.ts";

export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function emitHuman(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function emitError(message: string, extra?: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message, ...(extra ?? {}) })}\n`);
}

/** Synchronous fd write: no user-space buffering, so "printed" really means flushed. */
export function writeLineSync(line: string): void {
  writeSync(1, `${line}\n`);
}

export function formatTime(ts: number): string {
  try {
    return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  } catch {
    return String(ts);
  }
}

export function summarizePost(post: PostView): Record<string, unknown> {
  return {
    id: post.id,
    author: post.author,
    // body is the point of reading a board: the default machine output carries it
    // (deleted posts expose no text).
    body_md: post.deleted_at ? null : post.body_md,
    root_id: post.root_id,
    parent_id: post.parent_id,
    self_thread_id: post.self_thread_id,
    self_thread_is_leaf: post.self_thread_is_leaf,
    reply_to_account_id: post.reply_to_account_id,
    tags: post.tags,
    seq: post.seq,
    created_at: post.created_at,
    deleted: post.deleted_at !== null,
    reply_count: post.reply_count,
    media: post.media.map((m) => m.hash),
    quoted_post_id: post.quoted_post_id,
    i: (post as unknown as { i?: number }).i,
    n: (post as unknown as { n?: number }).n,
  };
}

export function postLine(post: PostView): string {
  const author = post.author_account?.display ?? post.author;
  const tags = post.tags.length ? ` ${post.tags.map((t) => `#${t}`).join(" ")}` : "";
  const head = `@${post.author} (${author}) · ${formatTime(post.created_at)} · ${post.id}${tags}`;
  const body = post.deleted_at ? "[此帖已删除]" : post.body_md;
  const media = post.media.length ? `\n  media: ${post.media.map((m) => m.url).join(" ")}` : "";
  return `${head}\n  ${body.replace(/\n/g, "\n  ")}${media}`;
}

/**
 * 客户端实体缓存：让「进入子页」的第一帧就能用已有数据排版（design report-app-grade §3.1）。
 *
 * 只缓存**已见过的服务端数据**，不做跨会话持久化（刷新即失效，滚动记忆另有实现）：
 * - 帖子：任何一次列表/线程/通知渲染都写入，按 id 去重、上限 600 条；
 * - 线程：`GET /api/thread` 的整包结果，键是**入口帖子 id**；
 * - 成员：`GET /api/profile/:account` 的完整资料（含粉丝数与关注关系）；
 * - 时间线快照：feed 成功后按 {@link cacheKey} 存最后一批，返回 tab/子页时立即排版。
 *
 * 预取（prefetch*）：指针悬停/按下时提前发请求，进入页面时网络往往已回来。
 * 全部请求都带 TTL 与 in-flight 去重，避免误触点连发；失败静默（页面自己会再请求）。
 */
import type { AuthorView, PostView, SuggestedAccount, ThreadNode, ThreadView } from "@core/types";
import type { ProfileAccountView, ReportClient } from "@/lib/api";

const POST_LIMIT = 600;
const PREFETCH_TTL_MS = 30_000;

/**
 * 已见身份（帖子作者 / 推荐成员 / 完整资料）：成员页首帧就能画出真实头像与名字，
 * 只有尚未知情的派生字段（如关注数）用骨架占位。
 */
export interface KnownIdentity extends AuthorView {
  followers?: number;
  following?: boolean;
  createdAt?: number;
  online?: boolean;
  lastSeen?: number | null;
}

const postIndex = new Map<string, PostView>();
const threadIndex = new Map<string, ThreadView>();
const profileIndex = new Map<string, ProfileAccountView>();
const identityIndex = new Map<string, KnownIdentity>();
const feedIndex = new Map<string, PostView[]>();
const prefetchedAt = new Map<string, number>();
const inflight = new Map<string, Promise<unknown>>();

function trimPosts(): void {
  while (postIndex.size > POST_LIMIT) {
    const oldest = postIndex.keys().next().value;
    if (oldest === undefined) return;
    postIndex.delete(oldest);
  }
}

export function rememberIdentity(identity: AuthorView | null | undefined): void {
  if (!identity?.id) return;
  identityIndex.set(identity.id, {
    ...identity,
    ...(identityIndex.get(identity.id) ?? {}),
  });
}

export function rememberSuggested(rows: readonly SuggestedAccount[]): void {
  for (const row of rows) {
    identityIndex.set(row.id, {
      ...identityIndex.get(row.id),
      id: row.id,
      display: row.display,
      profile: row.profile,
      avatar: row.avatar,
      role: row.role,
      disabled: identityIndex.get(row.id)?.disabled ?? 0,
      followers: row.followers,
      following: row.following,
    });
  }
}

/** 任何作者行（who/accounts/搜索结果）都可以作为首帧身份。 */
export function rememberAuthors(rows: readonly AuthorView[]): void {
  for (const row of rows) rememberIdentity(row);
}

export function getCachedIdentity(id: string): KnownIdentity | null {
  return identityIndex.get(id) ?? null;
}

export function rememberPosts(posts: readonly PostView[]): void {
  for (const post of posts) {
    if (!post?.id) continue;
    postIndex.delete(post.id);
    postIndex.set(post.id, post);
    rememberIdentity(post.author_account);
  }
  trimPosts();
}

export function rememberThread(entryId: string, thread: ThreadView): void {
  threadIndex.delete(entryId);
  threadIndex.set(entryId, thread);
  rememberPosts(thread.posts);
}

export function rememberProfile(profile: ProfileAccountView): void {
  profileIndex.set(profile.id, profile);
  identityIndex.set(profile.id, {
    ...identityIndex.get(profile.id),
    id: profile.id,
    display: profile.display,
    profile: profile.profile,
    avatar: profile.avatar,
    role: profile.role,
    disabled: profile.disabled,
    followers: profile.follower_count,
    following: profile.following,
    createdAt: profile.created_at,
    online: profile.online,
    lastSeen: profile.last_seen,
  });
}

export function getCachedPost(id: string): PostView | null {
  return postIndex.get(id) ?? null;
}

export function getCachedThread(id: string): ThreadView | null {
  return threadIndex.get(id) ?? null;
}

/**
 * 线程页首帧种子：整包线程 > 单帖合成。
 *
 * 从时间线点开帖子时，完整线程请求还在路上；此时用帖子缓存合成一条
 * 「只有焦点帖」的线程，让目标页第一帧就有真实卡片（转场快照即最终排版），
 * 回复区先用骨架占位，网络回来后在焦点帖**下方**补全。
 */
export function getThreadSeed(id: string): ThreadView | null {
  const cached = threadIndex.get(id);
  if (cached) return cached;
  const post = postIndex.get(id);
  if (!post) return null;
  const node: ThreadNode = {
    ...post,
    depth: 0,
    is_spine: true,
    is_self_continuation: false,
    child_count: post.reply_count,
  };
  return {
    root_id: post.root_id,
    focal_id: id,
    spine_complete: false,
    posts: [node],
    collapsed: [],
    participants: [],
    as_of_seq: post.seq,
  };
}

export function getCachedProfile(id: string): ProfileAccountView | null {
  return profileIndex.get(id) ?? null;
}

/** 该成员的根帖（来自任何已见过的列表），用于成员页首帧。 */
export function getCachedAuthorRoots(id: string): PostView[] {
  const rows: PostView[] = [];
  for (const post of postIndex.values()) {
    if (post.author !== id) continue;
    if (post.root_id !== post.id) continue;
    if (post.deleted_at !== null) continue;
    rows.push(post);
  }
  return rows.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : b.created_at - a.created_at));
}

/** 该标签下的根帖（标签是正文派生字段，直接按 tags 过滤已见帖子）。 */
export function getCachedTagPosts(tag: string): PostView[] {
  const rows: PostView[] = [];
  for (const post of postIndex.values()) {
    if (post.deleted_at !== null) continue;
    if (!post.tags.includes(tag)) continue;
    rows.push(post);
  }
  return rows.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : b.created_at - a.created_at));
}

// ── 时间线快照 ────────────────────────────────────────────────────────────────

export function writeFeedCache(key: string, posts: readonly PostView[]): void {
  feedIndex.set(key, posts.slice());
  rememberPosts(posts);
}

export function readFeedCache(key: string): PostView[] {
  return feedIndex.get(key)?.slice() ?? [];
}

// ── 预取 ─────────────────────────────────────────────────────────────────────

function shouldPrefetch(key: string): boolean {
  if (inflight.has(key)) return false;
  const at = prefetchedAt.get(key);
  if (at !== undefined && performance.now() - at < PREFETCH_TTL_MS) return false;
  prefetchedAt.set(key, performance.now());
  return true;
}

function settle(key: string, promise: Promise<unknown>): void {
  inflight.set(key, promise);
  void promise
    .catch(() => undefined)
    .finally(() => inflight.delete(key));
}

export function prefetchThread(client: ReportClient | null, postId: string): void {
  if (!client || !postId) return;
  if (threadIndex.has(postId)) return;
  const key = `thread:${postId}`;
  if (!shouldPrefetch(key)) return;
  settle(key, client.thread(postId, postId).then((thread) => rememberThread(postId, thread)));
}

export function prefetchProfile(client: ReportClient | null, accountId: string): void {
  if (!client || !accountId) return;
  if (profileIndex.has(accountId)) return;
  const key = `profile:${accountId}`;
  if (!shouldPrefetch(key)) return;
  settle(
    key,
    client.profile(accountId, { limit: 30 }).then((page) => {
      rememberProfile(page.account);
      rememberPosts(page.posts);
      writeFeedCache(`profile:${accountId}`, page.posts);
    }),
  );
}

/**
 * 清空全部实体缓存（切换后端/登出必须调用）：不同实例的私域帖子、
 * 线程、成员身份与 feed 快照不得跨实例泄漏到首帧。
 */
export function clearEntityCache(): void {
  postIndex.clear();
  threadIndex.clear();
  profileIndex.clear();
  identityIndex.clear();
  feedIndex.clear();
  prefetchedAt.clear();
  inflight.clear();
}

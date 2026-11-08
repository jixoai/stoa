/**
 * 写入路径的预览索引（design §4）：在 `commitOps` 同一事务内抽 URL、
 * 算 cacheKey、upsert pending 行 + 持久化任务；**不发网络请求**。
 *
 * 失败只返回 0（调用方继续提交帖子）；预览永远不能成为发帖失败原因。
 */
import type { Database } from "bun:sqlite";
import { LINK_PREVIEW } from "../../core/plugins/builtin.ts";
import { previewProvider } from "./registry.ts";
import { bodyHash, previewPluginVersion, previewRulesVersion } from "./link-preview/provider.ts";
import { enqueuePreviewLinks, hashUrl } from "./queue.ts";
import { claimPreviewBudget, nextPreviewBudgetWindow, type PreviewBudgetReason } from "./budget.ts";

export interface IndexablePost {
  id: string;
  author: string;
  body_md: string;
  created_at: number;
}

/** 返回入队的链接数（0 = 无链接/插件缺失/抽取失败/预算耗尽）。 */
export function indexPostPreviewLinks(
  db: Database,
  input: {
    post: IndexablePost;
    now: number;
    pluginId?: string;
    /** 预算限流回调（调用方按批次聚合日志，R4）。 */
    onBudgetLimited?: (reason: PreviewBudgetReason) => void;
  },
): number {
  const pluginId = input.pluginId ?? LINK_PREVIEW.id;
  const provider = previewProvider(pluginId);
  if (!provider) return 0;
  let links;
  try {
    links = provider.extractUrls(input.post.body_md);
  } catch (err) {
    // 固定错误码 + 帖子 id；不记录正文/URL（spec 日志不泄露）。
    console.warn(
      `[report] preview extraction failed (parse_error) for post ${input.post.id}: ${(err as Error).name}`,
    );
    return 0;
  }
  if (links.length === 0) return 0;
  const budget = claimPreviewBudget(db, {
    accountId: input.post.author,
    count: links.length,
    now: input.now,
  });
  if (budget.granted < links.length) {
    // R3：未授权链接不丢弃——行 + job 仍写入，但 next_run_at 延迟到下一预算窗口。
    input.onBudgetLimited?.(budget.reason);
  }
  const digest = bodyHash(input.post.body_md);
  const pluginVersion = previewPluginVersion();
  const rulesVersion = previewRulesVersion();
  const deferredAt = nextPreviewBudgetWindow(input.now);
  const entries = links.map((link, index) => ({
    position: link.position,
    url: link.url,
    label: link.label,
    urlHash: hashUrl(link.url),
    cacheKey: provider.buildCacheKey({
      canonicalUrl: link.url,
      bodyHash: digest,
      pluginId: provider.manifest.id,
      pluginVersion,
      rulesVersion,
    }),
    nextRunAt: index < budget.granted ? input.now : deferredAt,
  }));
  enqueuePreviewLinks(db, {
    postId: input.post.id,
    postCreatedAt: input.post.created_at,
    links: entries,
    now: input.now,
  });
  return entries.length;
}

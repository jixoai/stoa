# 调研：X 的数据模型与阅读体验（report-v0 设计依据）

> 本文只保留**可实施的结论与出处**；完整调研记录见交付报告。设计正文见 `design.md` §5/§5.1/§5.2/§12。

## 1. 数据模型：保留什么

| 保留（语义驱动） | 理由 | 出处 |
|---|---|---|
| 根帖与回复**同一张表**，`parent_id` | 回复就是帖；分表会失去树与序号 | X Tweetypie `Tweet.inReplyToStatusId` |
| `root_id`（＝X 的 `conversation_id`） | 父帖被删也能找回整棵树；一次索引查询取全会话 | X 文档 `conversation_id` |
| `self_thread_id` + `is_leaf` | 自接线是**另一根轴**，不能靠"同作者连续段"猜（同作者可能落在多个分支） | Tweetypie `SelfThreadMetadata{id,isLeaf}` |
| `reply_to_account_id` | 跨自回复保留"回复谁"，否则自接链上无法回答 Replying to | Mastodon `in_reply_to_account_id` |
| `quoted_post_id`（引用是新帖 + 一条边） | 引用不是回复，有自己的正文与时间线位置 | X `quoted_status_id` / v2 `referenced_tweets` |
| 软删除 | 树不散、根身份保留 | Bluesky tombstone |

**丢弃（规模驱动）**：预写 fan-out / 物化时间线、Snowflake 分片、独立 TimelineService、
ML 候选生成与排序、编辑历史、withheld/法务字段、多副本一致性。

**v0 不建的表**：`reposts` / `likes` / `bookmarks` / `follows` / `post_views`——都是边表，
v1 需要时新增，`posts` 无需改动。

## 2. 分页

- keyset `(created_at, id)`，不用 offset：头部插入会让 offset 分页重复/漏条。
- 游标不透明（含版本号），`before` 取旧、`after` 取新，多取 1 条判 `has_more`。
- 同一批写入共享 `created_at`（提交时刻），一批汇报不被时间线打散。

## 3. 阅读体验：可直接验收的行为

| 行为 | 规则 | 出处 |
|---|---|---|
| 新帖暂存 | 新数据先进 `pending[]`，绝不直接插入 | Bluesky `usePrependPill` |
| 到顶判定 | `scrollTop ≤ 5px`，且只在拖拽/惯性结束后判定 | Bluesky `useSettleAtTop` |
| 新帖胶囊 | 非顶部显示「N 条新帖子」，400ms 合并抖动，上限 `99+`，点击插入并滚顶且**不发请求** | Bluesky `NewPostsPill` |
| 返回恢复 | 先按 anchor id + offsetPx 恢复，后刷新；恢复期间禁止重排 | Bluesky `useWebScrollRestoration` / Mastodon `state_storage` |
| focal 定位 | 数据到位后滚到视口顶部，用 `scroll-margin-top` 避开吸顶栏 | Elk/Mastodon |
| 自接链渲染 | 置顶、不缩进、24px 头像、仅首条显作者、隐 `Replying to`、连续连接线 | Bluesky `ThreadItemPost` / `const.ts` |
| `i/n` | 由后端给出（根 + 总数），前端不推断 | Bluesky `opThreadPostIndex/Count` |
| 分支「读更多」 | 「Read N more replies」**跳转**到该回复详情页，不内联展开 | Bluesky `ThreadItemReadMore` |
| 折叠阈值 | 子分支 >10 条默认收起 | Phanpy `SUBCOMMENTS_OPEN_ALL_LIMIT` |
| 引用 | 只渲染一层，二级降级为链接 | X DOM / Nitter |

**不复刻**：相关性排序、推荐流、ML 垃圾折叠、广告与增长位、无限自动插入与算法重排、
平台专有手势、视频自动播放、引用递归。

## 4. 出处

- X 数据字典 / conversation_id / 分页：`github.com/xdevplatform/docs`（`x-api/fundamentals/`）
- X 内部模型：`github.com/twitter/the-algorithm` → `tweetypie/.../tweet.thrift`、
  `SelfThreadBuilder.scala`、`FanoutServiceStore.scala`
- Bluesky：`github.com/bluesky-social/atproto` → `lexicons/app/bsky/feed/{post,getPostThread,defs,threadgate}.json`
- Bluesky 客户端：`bluesky-social/social-app` → `state/queries/usePostThread/{traversal,utils}.ts`、
  `screens/PostThread/*`、`features/followingV2/home/usePrependPill.ts`、`useSettleAtTop.ts`、
  `lib/hooks/useWebScrollRestoration.ts`
- Mastodon：`db/schema.rb`、`app/models/status.rb`、`features/status/redesign.tsx`、
  `containers/scroll_container/state_storage.ts`
- Elk：`app/pages/[[server]]/@[account]/[status].vue`、`app/composables/paginator.ts`
- Phanpy：`src/pages/status.jsx`
- Nitter（X 前端复刻）：`src/views/tweet.nim`

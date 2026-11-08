# Design: report-notification-stacks（通知按会话链叠放）

## 0. 决策摘要

| # | 决策 | 依据 |
|---|------|------|
| D1 | 相关性＝同 `root_id` 且祖先/后代可比；共享「叠锚点」才同叠；共同未读祖先下兄弟可同叠 | Owner 口径 1 + 2026-11-08 修正；见 §2 严格口径 |
| D2 | 分组键＝highest unread ancestor；全已读退化到「最靠根的已通知帖」，再无则自身 | Owner 口径 2；保证全已读历史仍可叠 |
| D3 | 叠行摘要＝最新一条**未读**；未读数＝叠内去重后的未读帖数 | Owner 口径 3；同帖多事件只算 1 |
| D4 | 点击叠行 focal＝最早一条未读（不是最新）；全已读叠 focal＝锚点 | Owner 口径 3；锚点 scope 覆盖叠内全部分支 |
| D5 | 祖先/子树/`scopeOf`/highestUnreadAncestor 抽到 `src/ui/lib/thread-plan.ts`，与线程 planner 共用 | Owner 口径 4；单一事实源 |
| D6 | 新增只读 `GET /api/posts/lineage?ids=…` 批量取祖先拓扑；不产生 N+1 | 100 通知 O(n)；通知/CLI 契约不变 |
| D7 | 不实现任何「叠已读」写路径，完全复用 read-dwell + 既有 read-set | Owner 口径 5 |
| D8 | 单成员叠沿用现有行 DOM/`data-testid`；只有 ≥2 成员才出现层叠视觉 | 兼容现有 QA 与视觉基线 |
| D9 | 软删帖从成员/锚点候选剔除；其通知行作为独立「此帖已删除」灰行保留（不可点/不可展开/不参与分组/不从历史抹除） | Owner 2026-11-08 定案；历史完整 |
| D10 | 分组在「history ∪ live」合并集合上做；成员可跨历史页，加载更早只增不减 | Owner 口径 6「分页/历史通知仍可叠」 |
| D11 | 叠行打开**不**调用 `markPostRead`（读由视窗停留触发） | 「已读不是路由事件」；read-dwell D5 |

## 1. 现状与接入点（path:line）

> 行号取自 2026-11-08 工作树；`report-link-preview` / `report-read-dwell` /
> `report-thread-scope` 合入后行号会移动。**接入点以锚点（函数名/`data-testid`/选择器）为准。**

| 用途 | 位置 | 现状 |
|------|------|------|
| 通知页历史分页 | `src/ui/pages/NotificationsPage.tsx:56-92` | `HISTORY_PAGE_SIZE=50`，`before` keyset，union 去重 |
| 历史/实时帖子投影补拉 | `src/ui/pages/NotificationsPage.tsx:101-125` | 只 hydrate 目标的 post，不取祖先 |
| 通知行分组（按帖） | `src/ui/state/notifications.tsx:128-160`（`groupNotificationEvents`） | 同帖多事件合并一行；无会话链概念 |
| `NotificationItem` 形状 | `src/ui/state/notifications.tsx:33-47` | `event/events/post/targetId/deleted/read/sortSeq` |
| 行渲染与点击已读 | `src/ui/pages/NotificationsPage.tsx:164-230`（`:191,200` `markPostRead`） | 点击即标该帖已读（read-dwell 将接管） |
| 通知列表容器 | `src/ui/pages/NotificationsPage.tsx:331-333` | `<Card>` + `divide-y`，每项一行 |
| 未读页脚 | `src/ui/pages/NotificationsPage.tsx:150-155,335-362` | `unreadRowCount` 按**行**计数（叠后需改按 target） |
| 实时投影 | `src/ui/state/notifications.tsx:274-293,349-411` | peek + EventHub 增量；`unread_by_target` 已落地 |
| 按帖已读 | `src/ui/state/notifications.tsx:477-498` | `markPostRead` / `isRead`；read-set 按 `base+account` |
| 角标同源 | `src/ui/state/notifications.tsx:527`、`src/ui/components/Nav.tsx:104,209` | `projection.badge(readIds)` |
| 通知历史 REST | `src/server/store.ts:2090-2148` | 返回事件 + `read`；**无祖先拓扑** |
| 未读按 target | `src/server/store.ts:2003-2020` | `unread_by_target` 权威未读 target 集合 |
| 事件切片 | `src/server/store.ts:1905-1963` | `post_deleted` 读时投影；含 payload |
| `post.created` payload | `src/server/store.ts:799-804,853-858` | 已含 `parent_id`/`root_id`（目标自身一层） |
| `thread.invited` payload | `src/server/store.ts:973-977` | 只有 `post_id/snapshot_seq`，不含 parent |
| 软删 + `post.deleted` | `src/server/store.ts:1771-1798` | 同事务落墓碑与事件（payload 含 parent_id） |
| 线程组装（全 root） | `src/server/store.ts:1623-1671`（`thread`）、`src/core/thread.ts:56-219` | maxDepth 6，超出折叠；**不能当完整祖先源** |
| 线程 planner | `src/ui/pages/ThreadPage.tsx:38-212`（`buildTimelinePlan` `:93-212`） | 祖先 + focal + **全 root 其余节点**（含兄弟）平铺 |
| focal/祖先计算 | `src/ui/pages/ThreadPage.tsx:708-780` | 父子指针来自 `ThreadView.posts` |
| 进入即已读（待删） | `src/ui/pages/ThreadPage.tsx:589-596` | read-dwell 的 P1-7 删除 |
| 线程渲染/滚动 | `src/ui/pages/ThreadPage.tsx:990-1118` | `thread-scroll` + timeline rows |
| 通知 API 客户端 | `src/ui/lib/api.ts:496-540` | `notifications` / `notificationHistory` / `ack` |
| 单帖/线程 API 客户端 | `src/ui/lib/api.ts:430-443` | `thread(id,focal)`、`post(id)` |
| HTTP 路由 | `src/server/http.ts:626-642,779-861` | `/api/thread`、`/api/posts/:id`、通知三端点 |
| 静态通知空实现 | `src/ui/lib/static-api.ts:749-761` | 归档无事件流；不适用 |
| 路由/导航 | `src/ui/lib/router.tsx:47-49,420` | `#/p/:id`；`navigate()` |
| 头像/头像组 | `src/ui/components/AuthorAvatar.tsx:25-66`、`src/ui/components/ui/avatar.tsx:80-111` | `AvatarGroup` 为 shadcn 官方件 |
| 共享元素 | `src/ui/lib/shared-element.ts:36`（`markSharedSubject`） | 列表 → 详情的转场主体 |
| 线程 scope 模块 | `src/ui/lib/thread-plan.ts` | **尚不存在**；由 `report-thread-scope` 抽出 |
| `report-thread-scope` change | `openspec/changes/report-thread-scope/` | **本工作树尚未出现**；按依赖处理（§14） |

**结论**：通知数据只有「目标自身」的 parent 指针；中间祖先可能没有通知事件，因此纯客户端
无法从事件集合还原完整祖先链（`thread()` 又受 maxDepth 6 折叠）。本设计新增一个最小只读
lineage 端点，分组本身仍是客户端纯函数，保证与线程 planner 共用同一套 scope 语义。

## 2. 术语与精确定义

设帖集合为同一 `root_id` 的树（`parent_id` 指父）。

- **祖先/后代**：`a` 是 `b` 的祖先 ⇔ 从 `b` 沿 `parent_id` 可达 `a`。可比 ⇔ 一方是另一方的
  祖先或自身。兄弟（同一 parent 的两个不同子）不可比。
- **timeline/scope**：`scopeOf(f)` ＝ `ancestors(f)`（root→parent）＋ `{f}` ＋
  `descendants(f)`。这正是 `report-thread-scope` 的详情可见集合；打开 `f` 不会显示 `f` 的兄弟。
- **已通知帖**：该帖在通知集合中（有 `post.created`/`thread.invited` 事件，读或未读）。
- **未读帖**：该帖的未读事件数 > 0，即 `target ∈（server unread_by_target ∪ 本地新 target）`
  且 `target ∉ readSet`；软删帖永远不是未读帖（服务端 `p.deleted_at IS NULL` 过滤）。
- **叠锚点（highest unread ancestor）**：
  `anchor(p) = U(p) ?? N(p) ?? p`，其中
  - `U(p)`＝自身与祖先中最靠根的未读帖；若自身未读则 `U(p)=p`；
  - `N(p)`＝自身与祖先中最靠根的已通知帖（含已读）；若自身已通知则 `N(p)=p`；
  - 软删帖不参与 `U/N` 的候选，但**链路可穿过**（中间软删不断链）。
- **成员**：按 `targetId` 去重后的通知目标（同帖多事件只留一个成员）。
- **叠**：共享同一锚点的全部成员（按锚点分组的等价类）。
- **未读数**：叠内「未读成员」个数（去重后按帖计，不按事件计）。

**为什么全已读要退化到 `N(p)`**：若只定义 `U`，全已读后每个帖都没有 key，历史通知无法叠放，
且「全部已读」会把整页叠结构打散。`N(p)` 让全已读链继续以最靠根的已通知帖为锚，打开它仍能
在 scope 内看到所有成员。

**关于「兄弟分支不算」的严格口径（Owner 2026-11-08 修正）**：两个兄弟帖**没有共同未读
祖先时**不同叠（因为打开其中一个不会同屏另一个）；但当共同祖先本身是未读锚点时，打开该祖先
的 timeline 会显示它的**全部后代分支**，此时两个兄弟与祖先共享锚点、同叠是符合「从最早未读
打开能看到叠内全部成员」的。形式化：
- `U(B) = U(D) = A` 且 A 未读 ⇒ B、D **同叠**（打开 A 同屏两分支）；
- A 已读且 B、D 无未读共同祖先 ⇒ B、D **不同叠**（各自 self 锚点）。

「兄弟不算」约束的是**无未读共同锚点时的自动合并**，**不是**「兄弟永远不同叠」；实现者
禁止按简化理解把 `U(B)=U(D)=A` 的兄弟拆开。该口径同时写入 proposal、report-thread-model
契约测试与 A2/A11 判据。

## 3. 分组算法与状态机

### 3.1 输入

```ts
interface StackInput {
  /** history ∪ live，按 targetId 去重后的成员 */
  members: NotificationMember[];
  /** 目标 id 并集（含未加载 history 行的未读 target）的祖先拓扑 */
  topology: ThreadTopology;
  /** 权威未读判定（provider 投影 − read-set） */
  isUnread(id: string): boolean;
  /** 是否在通知集合（已加载事件 target ∪ 未读 target） */
  isNotified(id: string): boolean;
  /** 软删判定（post 投影或 post.deleted 事件） */
  isDeleted(id: string): boolean;
}
```

### 3.2 锚点 DP（O(V)）

`U(p)` 与 `N(p)` 都只依赖父节点，可一次自根向下 DP（用显式路径 + 记忆化避免深递归）：

```ts
function resolveAnchors(topology, isUnread, isNotified, isDeleted) {
  const memo = new Map<string, { u: string | null; n: string | null }>();

  const resolve = (id: string): { u: string | null; n: string | null } => {
    const path: string[] = [];
    let cur: string | null = id;
    while (cur && !memo.has(cur)) {
      path.push(cur);
      cur = topology.parentOf(cur)?.id ?? null;
    }
    let base = cur ? memo.get(cur)! : { u: null, n: null };
    // path 是「从当前节点向上」的顺序，倒序即父→子
    for (const nodeId of path.reverse()) {
      const deleted = isDeleted(nodeId);
      const u = !deleted && isUnread(nodeId) ? nodeId : base.u;
      const n = !deleted && isNotified(nodeId) ? nodeId : base.n;
      memo.set(nodeId, { u, n });
      base = { u, n };
    }
    return memo.get(id) ?? { u: null, n: null };
  };

  return {
    anchorOf(id: string): string {
      const { u, n } = resolve(id);
      return u ?? n ?? id;
    },
  };
}
```

- 拓扑里不存在的节点（lineage 未返回/不可见）：`parentOf=null`，退化为自身锚点，不阻塞渲染。
- 复杂度：每个节点最多解析一次 → `O(V)`；分组 `O(T)`；成员排序 `O(T log T)`（100 条可忽略）。

### 3.3 分组与排序

```ts
function buildNotificationStacks(input) {
  const groups = new Map<string, NotificationMember[]>();
  const standalone: NotificationMember[] = []; // 软删 / 无 target 的事件行

  for (const member of input.members) {
    if (!member.targetId) { standalone.push(member); continue; } // event:<seq>
    if (member.deleted) { standalone.push(member); continue; }   // D9：不进叠
    const a = anchors.anchorOf(member.targetId);
    (groups.get(a) ?? groups.set(a, []).get(a)!).push(member);
  }

  const stacks = [...groups].map(([anchorId, members]) => {
    members.sort((x, y) => y.sortSeq - x.sortSeq); // 最新在前
    const unread = members.filter((m) => !m.read);
    return {
      key: `stack:${anchorId}`,
      anchorId,
      rootId: members[0]?.post?.root_id ?? null,
      members,
      unreadMembers: unread,
      size: members.length,
      unreadCount: unread.length,
      sortSeq: members[0]!.sortSeq,
      newestUnread: unread[0] ?? null,
      representative: unread[0] ?? members[0]!,
      anchorLoaded: members.some((m) => m.targetId === anchorId),
    };
  });

  // 叠整体按「最新活动」倒序；单成员与多成员同权
  return { stacks: stacks.sort((a, b) => b.sortSeq - a.sortSeq), standalone };
}
```

- 成员按 `sortSeq`（组内最大事件 seq）降序；叠按 `max(sortSeq)` 降序。
- 摘要：`newestUnread`；若它被删（`post_deleted` / `postOf=null`），建造时已在成员过滤中剔除，
  自然回退到次新未读；无未读时用 `members[0]`。
- 单成员叠由页面对 `size===1 && unreadCount<=1` 走现有行渲染（D8），视觉与今天一致。

### 3.4 分页/历史

- 输入是页面已累计的 `history ∪ liveEvents`，分组在**合并集合**上做；
  「加载更早」只是向集合加入旧 member → 已有叠的 `size/unreadCount` 增长，不产生重复行。
- 未读目标的**锚点解析**使用权威 `isUnread`（来自 `unread_by_target` + 本地新 target），
  不要求锚点的 history 行已加载：因此一个叠的 `anchorId` 可能暂时不在成员里
  （`anchorLoaded=false`），点击仍去正确锚点；当对应页加载后锚点成为成员，行内容补全。
- 页脚「还有 N 条未读」＝`notifications.unread − 已加载未读 target 数`（按 target，不按行）；
  叠内 `unreadCount` 只统计已加载成员，避免与全局 remainder 重复计数。
- 已读链的 `N(p)` 锚点只能来自「已加载的已通知帖」：历史页未加载时，已读后代会暂时以自身为锚；
  加载后自动合并（可接受的渐进收敛，见 A6）。

### 3.5 状态机（叠的生命周期）

```
provisional（lineage 未回，anchor=self）
   └─ lineage 到达 → settled(anchor=a)
settled(anchor=a)
   ├─ 新未读后代加入（同 anchor）        → grow（成员+1，unread+1）
   ├─ 新未读祖先加入（a 的祖先）          → reanchor（key 变为新祖先，旧 key 行合并）
   ├─ 成员转已读 / read-set 命中          → shrink（unread−1；该成员可能成为已读上下文）
   ├─ 锚点转已读且下方仍有未读            → split（读上下文栈 + 新未读后代栈）
   ├─ 最新未读被删                        → fallback（摘要回退次新，unread−1）
   ├─ 全部成员被删                        → dissolve（叠行消失；各软删帖转独立灰行）
   └─ ack（全部已读）                     → read-stack（unread=0，anchor→N(p)）
```

- 叠的 React key 固定为 `stack:${anchorId}`；`reanchor/split` 会换 key（卸载/挂载），P2 用
  `data-stack-transition` 做 180ms 高亮过渡；P1 允许直接切换。
- 展开状态按 `anchorId` 存在页面局部 `Set<string>`；key 变化后旧展开态自然丢弃。

## 4. 拓扑数据来源：只读 lineage 端点

### 4.1 为什么不是纯客户端

- 事件 payload 只给目标自身 `parent_id`（`store.ts:799-804,853-858`）；中间祖先可能没有通知。
- `thread()` 受 `assembleThread maxDepth=6` 折叠（`src/core/thread.ts:60,169-203`），深链缺祖先。
- 逐帖 `client.post()` 递归是 N+1：100 条回复 × 平均深度会产生数百请求，违背「100 通知 O(n)」。

### 4.2 契约

`GET /api/posts/lineage?ids=<id1,id2,…>`

- `ids`：逗号分隔，去重；上限 200（与 peek 上限一致）；空 → `{nodes: []}`；
  非法/超限 → 400 `BAD_REQUEST`。
- 返回**输入帖 + 全部祖先**的最小行（不含正文/媒体）：
  ```ts
  interface LineageNode {
    id: string;
    parent_id: string | null;
    root_id: string;
    deleted_at: number | null;
    created_at: number;
    seq: number;
  }
  interface LineageResponse { nodes: LineageNode[] }
  ```
- 可见性：与 `/api/posts/:id` 同口径（`visibleRootsClause` + viewer 角色）；不可见 id 静默省略
  （不泄露存在性）。同一 root 可见性一致，因此祖先可见性与目标一致。
- 软删祖先/目标 SHALL 返回（带 `deleted_at`），供「穿链但不当锚点」使用。
- 实现：单条 SQL 递归 CTE（`WITH RECURSIVE`）或按层批量 `id IN (…)`；禁止逐 id 查询；
  建议深度上限 64（防御脏数据自环）。
- 纯读：不写库、不推进游标、不影响 `MAX(seq)`/history/peek/CLI。

### 4.3 客户端缓存与失效

- `NotificationsProvider` 持 `Map<postId, LineageNode>`，按 `client.base|account.id` 分区；
  账号/后端切换时清空（与 posts/projection 同步）。
- `ensureLineage(ids)`：过滤已缓存 id，150ms trailing debounce 合并成 1 次请求；在途请求按
  批次去重；失败不阻塞 UI（该批目标以 self 锚点先行，下一次事件/对账再补）。
- `post.deleted`：若目标在拓扑中，置 `deleted_at`（不改 parent），触发重新分组；
  未知节点 no-op（下次 lineage 会带墓碑）。
- 历史页新增 target、实时 `notification.created` 新 target 都调用 `ensureLineage([targetId])`。
- 静态模式（`staticMode`）不调用；`StaticReportClient` 覆写返回空 nodes（防御）。

## 5. 实时增量（post.created / 删除 / ack / 已读）

| 事件 | 处理 | 叠的效果 |
|------|------|----------|
| `notification.created`（新 seq） | 投影 `applyEvent` 已做；页面合并进 live；`ensureLineage([target])`；重算 | grow（同锚）/ new / reanchor（新帖是祖先） |
| `notification.created`（重复 seq） | 投影幂等返回 false | noop（不重算） |
| `post.deleted` | `applyDelete` 扣减 target；provider 标记 post/lineage deleted；重算 | fallback / dissolve；若删的是锚点候选，重新锚定 |
| `cursor.acked` | `applyCursor` 清未读；页面随后 `loadHistory(true)` | 全部叠转 read-stack（unread=0） |
| read-set 变化（dwell） | `isRead` 快照变化 → 页面重算 | shrink / split / merge 为读态 |
| `stream.reset` | 既有 `refresh()` 全量快照 + 页面重载 history | 从头重算 |
| history「加载更早」 | union 合并 + `ensureLineage` 新 ids | 既有叠补成员，不重复 |
| 登录/账号切换 | provider 重置 projection/posts/lineage，页面重载 | 全部重建；read-set 独立 |

- 重算只由上述输入变化触发（`useMemo` 依赖），**滚动、展开、窗口 resize 不触发**。
- 新增 `notification.created` 到达时若祖先链未知：member 以 `anchor=self` 先入列表（不阻塞
  推送），lineage 返回后若 reanchor 则合并；`data-stack-transition="merge"` 供 QA/P2 动画。
- 不重新拉 history：实时增量只并入 live + 重算纯函数（与 event-hub「不整页刷新」一致）。

## 6. 叠行 UI 形态

### 6.1 行结构（≥2 成员）

```
┌ 叠层 2（inset-x-6, top-0, h-2, rounded-t-xl, border, bg-muted/40）   ← aria-hidden
│┌ 叠层 1（inset-x-3, top-1, h-2, ... bg-muted/60）                  ← aria-hidden
││┌ 前卡（relative z-10, rounded-xl, border, bg-card）
│││ [avatar]  [作者 + 动作]                    [N 条未读] [⌄ 展开]
│││           最新未读正文（Markdown，line-clamp-2）
│││           时间 · 共 M 条会话提醒
││└─ 展开区（size≥2 且 expanded）：成员行 1..M（最新在前，紧凑）
└──
```

- 层叠用两层绝对定位的 `div`/`span`（主题令牌 `bg-muted/*`、`border-border/*`），**不用
  box-shadow**（项目视觉纪律；透明窗阴影红线虽针对窗口，但统一不用溢出层的阴影）。层叠层
  是 `aria-hidden` 的纯装饰，不构成新组件；行内交互件全部复用现有 shadcn 官方件
  （`Card`/`Badge`/`Button`/`AuthorAvatar`/`AvatarGroup`），不手写替代组件。
- 前卡复用现有行内容：`AuthorAvatar`（最新未读 actor）＋ `AuthorLine` ＋ `eventText` ＋
  `Markdown` 摘要 ＋ 时间。多作者场景的 `AvatarGroup`（最多 3 枚 tiny + count）作为 P2 打磨。
- 未读徽标：`Badge variant="secondary" data-testid="notification-stack-unread"`；
  `size≥2` 且 `unreadCount>0` 时显示数字；`unreadCount=0` 不显示。
- 展开按钮：`Button variant="ghost" size="icon-sm"` + `ChevronDownIcon/ChevronUpIcon`（lucide），
  `aria-expanded`、`aria-controls`、`aria-label="展开/收起 N 条会话提醒"`；点击 `stopPropagation`。
- 展开成员行：`data-testid="notification-stack-member"` + `data-post-id` + `data-read`；
  `AuthorAvatar size="tiny"`（20px）＋作者/动作/时间＋正文 1 行（P1 用纯文本截断，不做 Markdown
  渲染，避免 100 行 Markdown 开销）；成员点击导航该帖（不强制走锚点）。
- 「未读」筛选下：只保留 `unreadCount>0` 的叠；展开只列未读成员；「全部」下展开列全部成员，
  已读成员 `opacity-70` 并带已读态（不额外加「已读」徽标）。

### 6.2 单成员叠（D8）

`size===1` 且 `unreadCount<=1` 时渲染**现有行 DOM**（`data-testid="notification-row"`、
`data-post-id`、`data-read`、`data-seq`、`data-event-count`），不出现层叠层与展开按钮；
`data-stack-size="1"` 仍可加属性供诊断。这样 `scripts/qa/notifications-read.mjs` 的现有
选择器继续有效。注意：若该成员只是叠内的已加载成员、真正的锚点尚未加载
（`anchorLoaded=false`），`data-post-id` 仍写**成员 id**（保 QA 选择器兼容），但点击导航目标
一律是 `anchorId`；需要区分时由 `data-stack-key` 提供锚点。

### 6.3 响应式与无障碍

| 视口 | 约束 |
|------|------|
| 390×844 | 前卡 `flex` 不换行溢出：作者列 `min-w-0 flex-1`，徽标/按钮 `shrink-0`；摘要 `line-clamp-2`；无横向滚动（`scrollWidth<=clientWidth`） |
| 1280×800 | 行宽随列表容器；摘要仍最多 2 行；展开不改变前卡高度（只向下增长） |

- 行 `role="button" tabIndex=0`，`Enter`/`Space` 打开锚点；内部 `a,button` 的点击/按键不触发行导航
  （沿用 `NotificationsPage.tsx:186,196` 的 `closest("a,button")` 守护）。
- 展开按钮是唯一嵌套交互件；`aria-expanded` 随状态翻转；`aria-controls` 指向成员容器 id。
- 徽标视觉数字对读屏提供 `aria-label="{N} 条未读"`；不新增 `aria-live`（避免每次实时事件播报噪音）。

### 6.4 空/加载/错误

- 无任何叠：沿用现有空态（`notifications-empty`）。
- 首次 history + lineage 未回：沿用 skeleton（`loadingFirstPage`），不闪现未分组行。
- lineage 失败：不报错横幅（后台能力），目标以 self 锚点渲染，下一次事件/刷新重试；
  `window.__reportNotificationStacks.lineageFailures` 进入诊断（P2）。

## 7. 点击锚点与线程 scope

- 点击叠行（非展开按钮/成员/链接）：
  1. `markSharedSubject(rowEl, anchorId)`；
  2. **不** `markPostRead`（D11；读由 read-dwell 的停留触发）；
  3. `navigate('/p/' + encodeURIComponent(anchorId))`。
- focal 选择：
  - 有未读成员：`anchorId`＝最早未读（`U` 链的最靠根未读）；
  - 全已读：`anchorId`＝`N` 链的最靠根已通知帖（**不做「跳最新」变体**）。
- **全已读叠＝上下文回看语义**：focal 取该叠最靠根的已通知帖；线程页按时间升序向下排列其
  全部后代，用户要看最新内容**向下滚**即可，不另做「跳到最新成员」入口。
  判据：点击后叠内**全部成员**都在该 timeline 的首屏可达集合（`scopeOf(focal)`，无需另开
  详情），且 focal 是该叠的**最靠根者**。
- 线程页（report-thread-scope 之后）从 focal 渲染 `scopeOf(focal)`：
  - 向上：已读祖先上下文（用户可回溯）；
  - 向下：全部后代；后续未读成员按时间平铺在下方，停留达标逐条转已读。
- 为什么全已读叠取 `N` 锚点：`scopeOf(N)` 含全部分支成员；取「最新成员」会漏掉它的兄弟分支
  （`scopeOf(最新)` 不含兄弟），违反一致性契约。这也是「上下文回看」而非「直达最新」的原因。
- 共享元素：前卡头像是最新未读 actor，anchor 作者可能不同 → 若不同，View Transition 找不到
  同名 avatar 会自然降级（不影响导航）；P2 可在展开列表里为 anchor 的头像登记 shared id。
- 事务/错误：导航失败无额外处理（hash 路由同步）；锚点不可见/被删时线程页按既有 404 空态。

## 8. 与 read-dwell 的联动（不新增已读逻辑）

- 通知页**不写** read-set：叠行/成员行的点击都不调用 `markPostRead`；展开也不写。
- `report-read-dwell` 的 dwell 引擎在任意面（含线程页 focal/回复）停留达标后调用
  `markPostRead(postId)`（read-dwell design D3/D7），通知页下次渲染时：
  - `isUnread(target)` 变 false → 锚点重算 → `unreadCount` 减少；
  - 最早未读被读掉 → 锚点下移（`shrink`）；读上下文与未读后代分开（`split`）；
  - 全部读掉 → read-stack（unread=0，锚点回到 `N`）。
- 「全部已读」：`ack()` 推进游标（唯一路径），页面随后 `loadHistory(true)`；叠全部转 read-stack。
- read-set 淘汰（>500）：旧帖可能重新未读，锚点可能重新上移/分裂；这是既有规格行为，
  不视为叠 bug（§12 R7）。
- 静态模式：无通知、无 dwell 引擎；不适用。

## 9. 去重、删除与边界规则

| 场景 | 行为 | 判据 |
|------|------|------|
| 同帖 `post.created` + `thread.invited` | 合并为 1 个成员；未读数 1；展开 1 行 | `data-event-count` 保留事件数，`data-stack-size` 只计 target |
| 同帖在 history 与 live 各出现 | 按 `seq` 去重（union）；成员 1 个 | 无重复 `data-post-id` |
| 软删目标 | 不作成员/锚点；其通知行作为独立「此帖已删除」灰行保留（**不可点/不可展开**）；未读数不含它；不从 history 抹除 | `notification-deleted-row` 仍在列表；无 `data-stack-key`；点击无导航/无 `markPostRead`；叠内 `data-member-ids` 不含该 id |
| 共同祖先未读的兄弟 | 共享未读祖先锚点 ⇒ **同叠**；打开锚点同屏两个分支 | 两个兄弟成员同一 `data-stack-key`；`scopeOf(anchor)` 含双方 |
| 共同祖先已读的兄弟 | 无未读共同祖先 ⇒ **不同叠**，各自 self 锚点 | 两个 `data-stack-key`；互相不在对方 `scopeOf` |
| 中间祖先软删 | 链路继续（`parentOf` 仍可走）；该节点不参与 `U/N`；线程页显示删除占位 | 锚点/叠不因中间删除断开 |
| 最新未读被删 | 摘要回退到次新未读；unread−1；若叠空则该**叠行**消失（软删帖自身转独立灰行） | 摘要作者/正文来自次新；`data-stack-size` 递减；`notification-deleted-row` 保留 |
| 事件无 target | 独立 `event:<seq>` 行，不参与叠 | 不出现 `notification-stack` |
| 锚点 history 行未加载 | 叠照常渲染已加载成员；`data-anchor-loaded="0"`；点击仍去锚点 | 页脚 remainder 覆盖未加载未读数 |
| 锚点不可见/lineage 缺失 | self 锚点先行；lineage 回来后 reanchor | 不阻塞、不报错 |
| 静态归档 | 无叠、无 lineage 请求、空态 | `__reportNotificationStacks.enabled=false` |
| 多账号 | lineage/posts/projection 重置；read-set 按账号隔离 | A 已读不影响 B；切回 A 不丢 |
| 自己发的帖 | 服务端 REST 已排除（`actor != ?`）；不出现成员 | 无行 |
| 通知页在后台 | 实时事件仍并入投影（EventHub），页面不可见不渲染；返回时重算 | 无布局抖动 |

## 10. 性能预算（100 条通知）

| 指标 | 预算 | 验证 |
|------|------|------|
| lineage 请求 | ≤1 次/合并批（≤200 ids）；账号生命周期内每帖 ≤1 次 | `__reportNotificationStacks.lineageRequests` |
| 拓扑节点数 V | ≤ 100 targets + 其祖先并集（典型 ≤ 300；深链夹具 ≤ 1000） | `lineageNodes` |
| 分组计算 | `O(V + T log T)`；100 通知 < 50ms | `lastGroupMs` + PerformanceObserver longtask |
| 重算次数 | 只随 history/live/readIds/lineage/删除变化；滚动/展开 0 次 | `recomputes` |
| 每行 Markdown | 仅前卡摘要（未展开成员用纯文本） | DOM 统计 |
| 网络 | 不新增 per-row 请求；不 re-peek history | 网络面板/QA |
| 内存 | topology/lineage 按帖 O(1)；账号切换清空 | 回归用例 |

- 不使用虚拟滚动（现有列表量级 50–100；与 `report-notification-history` 一致）。
- `useMemo` 依赖显式列出，禁止依赖 `rows` 数组身份导致每次渲染重算。

## 11. 共享纯函数签名与一致性契约

### 11.1 `src/ui/lib/thread-plan.ts`（由 `report-thread-scope` 抽出）

```ts
export interface ThreadTopologyNode {
  id: string;
  parent_id: string | null;
  root_id: string;
  deleted_at: number | null;
}

export interface ThreadScope {
  rootId: string;
  focalId: string;
  /** root → parent（不含 focal） */
  ancestorIds: readonly string[];
  /** 全部后代（不含 focal，时间序） */
  descendantIds: readonly string[];
  /** id 是否在 scope 内（祖先 ∪ focal ∪ 后代） */
  has(id: string): boolean;
}

export interface ThreadTopology {
  byId: ReadonlyMap<string, ThreadTopologyNode>;
  parentOf(id: string): ThreadTopologyNode | null;
  ancestorsOf(id: string): readonly ThreadTopologyNode[];
  descendantsOf(id: string): readonly ThreadTopologyNode[];
  isAncestor(ancestorId: string, descendantId: string): boolean;
  scopeOf(focalId: string): ThreadScope | null;
}

export function buildThreadTopology(nodes: Iterable<ThreadTopologyNode>): ThreadTopology;

/** 本 change 在 thread-plan.ts 的扩展（通知叠与 planner 共用） */
export interface NotificationRelevance {
  /** 该帖有未读通知且未命中 read-set（软删由调用方先排除） */
  isUnread(id: string): boolean;
  /** 该帖在通知集合（已加载事件 target ∪ 未读 target；软删排除） */
  isNotified(id: string): boolean;
}
/** 返回 nodeId → anchorId 的完整映射；缺失拓扑退化为自身 */
export function resolveStackAnchors(
  topology: ThreadTopology,
  relevance: NotificationRelevance,
): Map<string, string>;

/** 便捷：单点查询（内部走同一 DP/缓存） */
export function highestUnreadAncestor(
  topology: ThreadTopology,
  id: string,
  relevance: NotificationRelevance,
): string | null;
```

### 11.2 `src/ui/lib/notification-stacks.ts`（本 change 新增）

```ts
export interface NotificationMember {
  /** null = 无 target 的协议事件（独立行） */
  targetId: string | null;
  post: PostView | null;
  deleted: boolean;
  events: NotificationEventLine[]; // seq 降序
  read: boolean;
  sortSeq: number;
  /** 代表事件：post.created 优先 */
  event: NotificationEventLine;
}

export interface NotificationStack {
  key: string;              // stack:<anchorId>
  anchorId: string;
  rootId: string | null;
  members: NotificationMember[];       // seq 降序，已剔除软删
  unreadMembers: NotificationMember[];
  size: number;
  unreadCount: number;
  sortSeq: number;
  newestUnread: NotificationMember | null;
  representative: NotificationMember;
  anchorLoaded: boolean;
}

export function buildNotificationStacks(input: {
  members: Iterable<NotificationMember>;
  topology: ThreadTopology | null;
  relevance: NotificationRelevance;
  isDeleted(id: string): boolean;
}): { stacks: NotificationStack[]; standalone: NotificationMember[] };
```

### 11.3 一致性契约测试（硬判据）

在 `test/notification-stacks.test.ts` 用合成树（含兄弟双向、深链、中间软删、全已读叠）断言：

1. **同叠 ⇒ timeline 包含**：对每个叠的每个未读成员 m，
   `topology.scopeOf(anchorId)!.has(m.targetId) === true`。
2. **timeline 内未读 ⇒ 同叠**：对每个锚点 a 与 scope 内任一未读帖 u
   （`u === a` 或 `isAncestor(a,u)`），`anchors.get(u) === a`。
3. **兄弟口径（双向，禁止简化成「兄弟永不同叠」）**：
   - 若 x、y 为兄弟且共同祖先 A **未读**（`U(x)=U(y)=A`）→
     `anchor(x) === anchor(y) === A`，且 `scopeOf(A)` 同时包含 x、y；
   - 若 x、y 为兄弟且**无共同未读祖先** → `anchor(x) !== anchor(y)`，
     `scopeOf(anchor(x))` 不含 y，`scopeOf(anchor(y))` 不含 x。
4. **planner 交叉验证**（`report-thread-scope` 合入后）：用 `scopeOf(anchor)` 构造
   `buildTimelinePlan` 输入，断言叠内每个未读成员都出现在 `plan.rows` 的 post 行或
   `subthread` 入口（不要求 DOM 展开），且不出现兄弟分支行。
5. **全已读叠上下文回看**：选择 `N` 锚点时，`scopeOf(anchor)` SHALL 包含叠内全部成员
   （含兄弟分支）；断言不存在「跳最新」焦点入口。
6. **锚点/父链缺失**：拓扑缺失时 `anchor(x)===x`，不抛异常。

> 契约的精确形式：**对未读帖集合等价**。`scopeOf` 含祖先，而「最早未读」之上的祖先按定义
> 全是已读，所以把「timeline 内未读 ⇒ 同叠」限定在未读帖上时是严格等价，不存在反例。

## 12. 验收矩阵（A1–A10）

> QA 一律对隔离后端（`scripts/qa/qa-serve.mjs`）跑；A1/A7/A9 各跑 390×844 与 1280×800，
> 其余默认 1280×800。断言以 DOM 属性、网络计数与 localStorage 为准。

| ID | 场景 | 步骤 | 断言 |
|----|------|------|------|
| A1 | 同链叠放基础 | 造 root A→B→C 三条未读通知，打开通知页 | 一行 `notification-stack`；`data-stack-key=A`、`data-stack-size=3`、`data-stack-unread=3`；摘要来自 C；点击进 `#/p/A`（focal=A，不是 C）；390/1280 均无横向滚动 |
| A2 | 兄弟口径 | ①共同祖先 A 已读，B、D 兄弟各有未读；②A 未读，B、D 兄弟各有未读 | ①两行独立叠（key=B/D），点 B 的 timeline 不含 D；②B、D 与 A 同叠（key=A），打开 A 同屏两分支；契约测试同断言 |
| A3 | 未读+已读混叠 | A 未读、B 已读、C 未读（同链） | 一叠 key=A，`unread=2`，`size=3`；展开列出 3 条，B 呈已读；摘要来自 C |
| A4 | 实时新增/合并 | 停留通知页；SSE 推同链新回复；再推 A 的祖先新回复 | 第一次：现有叠 unread+1、摘要更新，无整页刷新/无 history 重拉；第二次：两叠合并为一行，anchor 变新祖先，`data-stack-transition=merge`（P2 动画） |
| A5 | 删除回退 | 删除叠内最新未读帖 | 该帖从成员/摘要消失，摘要回退次新，unread−1；其通知行改为独立「此帖已删除」灰行仍在 history、不可点/不可展开；若删空则叠行消失；角标同步；无 `data-post-id` 指向删除帖 |
| A6 | 跨页拼叠 | 叠成员跨 history 两页（>50 条历史） | 加载更早后仍一行；`data-stack-size`/`unread` 增长；无重复 `data-post-id`；页脚 remainder=服务端未读−已加载未读 target |
| A7 | 停留已读联动 | 从叠进 A，滚动使 A 与后续成员停留达标，返回通知页 | A 移出未读（read-set 命中）；unread 递减/锚点下移；无额外已读写路径（`__reportReadDwell.marks` 与 read-set 新增一致）；390/1280 |
| A8 | 同帖双事件去重 | 同帖同时有 `post.created`+`thread.invited` | 叠内 1 个成员、unread 1；展开 1 行；打开一次该帖两条事件都视为已读（沿用既有语义） |
| A9 | 100 通知性能 | 10 个 root、100 条通知、含 8 层深链 | 分组 `lastGroupMs<50`；`lineageRequests` ≤1/合并批；无 >50ms longtask；滚动/展开 `recomputes` 不增；390/1280 |
| A10 | 静态/多账号/契约 | 静态归档打开通知页；账号 A/B 切换；跑契约测试 | 静态：无叠、无 lineage 请求、空态；切换：lineage/posts 清空、read-set 隔离；契约六断言全绿（含兄弟双向） |
| A11 | 全已读叠上下文回看（Owner 2026-11-08 追加） | 叠内全部已读；点击叠行 | focal=该叠最靠根已通知帖；`scopeOf(focal)` 含叠内全部成员（首屏可达集合，无需另开详情）；页面按时间升序，向下滚可见最新成员；不出现「跳最新」焦点入口 |

## 13. 风险与回滚

| # | 风险 | 缓解 |
|---|------|------|
| R1 | `report-thread-scope` 未落，`thread-plan.ts` 不存在 | 硬依赖：P1-3/P1-4 阻塞；不得在本 change 复制 planner |
| R2 | Owner 拒绝新增 lineage 端点 | 降级：逐帖 `client.post` 递归 + 记忆化 + 深度上限 8；明确登记为性能降级（100 通知可能 >50ms 网络） |
| R3 | read-dwell 未落，点击仍走旧「进入即已读」 | 硬顺序：read-dwell 先合；若临时先合本 change，叠仍工作，但 A7 不通过（登记） |
| R4 | reanchor/split 导致行 key 变化、展开态丢失 | key 用 anchor；展开态按 key 存储；P2 动画；不阻塞 P1 |
| R5 | 深链/100 条分组卡顿 | 祖先 DP O(V)、无布局读取；预算 A9 |
| R6 | 中间软删导致链断/锚点错 | `parentOf` 穿过删除节点；删除节点不参与 U/N；契约含中间删除夹具 |
| R7 | read-set 500 上限淘汰导致叠重新变未读 | 既有规格行为；登记，不另做「叠已读」 |
| R8 | lineage 缓存陈旧（祖先后续被删） | `post.deleted` 就地更新 deleted_at；parent 不会变；账号切换清空 |
| R9 | 390 下徽标/按钮挤压 | `min-w-0`+`shrink-0`+摘要 clamp；A1/A7 两视口断言 |
| R10 | 单成员行被层叠样式误伤 | D8：`size===1` 复用现有 DOM/类名；兼容脚本 `notifications-read.mjs` |

**回滚**：页面切回「按帖一行」渲染路径 + 移除 `notification-stacks.ts` 调用即可；lineage 端点
是加性只读接口，可保留不用；无 schema/数据迁移，read-set 格式不变。

## 14. 合并顺序与冲突点

1. `report-link-preview`（在途）：`PostCard` 插入点；先合。
2. `report-read-dwell`（在途）：`PostCard` 已读属性、`notifications.tsx` per-id 订阅、
   `ThreadPage` 删除进入即已读。本 change 的点击不写已读依赖它。
3. `report-thread-scope`（在途/待落）：抽出 `src/ui/lib/thread-plan.ts`、线程 scope 收敛。
   本 change 只扩展该模块；它未合入前不得动 `ThreadPage`。
4. **本 change**：最后 rebase。

冲突面与策略：

- `NotificationsPage.tsx`：本 change 重写列表映射（`renderRow` → `renderStack`），read-dwell
  不改该文件；link-preview 不改；冲突风险低。
- `notifications.tsx`：本 change 加 `unreadTargets`、`ensureLineage`、`lineageOf`、
  `markLineageDeleted`；read-dwell 改 read-set 订阅/持久化。加性合并，保持 `markPostRead`
  幂等与 `ack` 唯一清空。
- `thread-plan.ts`：thread-scope 新建；本 change 追加 `NotificationRelevance` /
  `resolveStackAnchors`。若 thread-scope 已实现相似函数，以它的命名为准，本 change 只做别名/扩展。
- `store.ts`/`http.ts`：只加 `postLineage` 与一个 GET 路由；不动通知读路径。
- `src/core/types.ts`：只加 `LineageNode`/`LineageResponse` 类型。
- `app.css`：末尾追加叠层/展开 utility 与 reduced-motion 规则，不动 View Transition 段。
- `scripts/qa/notifications-read.mjs`：单成员叠保持原 testid，脚本只补「若种子被叠则按
  `data-member-ids` 定位」的兼容分支（不改变原断言语义）。

## 15. 决策记录

- **D2（2026-11-08）**：key 采用 `U(p) ?? N(p) ?? p` 两段式。理由：只定义 U 会让全已读历史
  失去叠；只定义 N 会让未读链从最靠根的已读帖开始，违背「focal=最早未读」。
- **D3**：未读数按去重 target 计，不按事件计（与角标 `unread_by_target` 同口径）。
- **D6**：lineage 用批量端点而非 `thread()`/逐帖递归。理由：`thread()` 受 maxDepth 6 折叠，
  逐帖是 N+1。
- **D9（Owner 2026-11-08 定案）**：软删通知行保留为独立「此帖已删除」灰行：不从 history 抹除、
  **不可点/不可展开**、不参与叠分组与未读计数。理由：历史完整（既有「已读通知仍然可见」要求）。
- **D11**：叠行点击不写已读。理由：Owner「已读不是路由事件」；由 read-dwell 的 dwell 引擎
  统一写入，避免「点开即已读」让叠在用户还没看时就收缩。
- **D12（Owner 2026-11-08 定案）**：全已读叠点击 focal＝该叠**最靠根的已通知帖**，语义是
  「上下文回看」；**不做「跳最新」变体**。要看最新内容向下滚（timeline 按时间升序）。
  判据见 A11：叠内全部成员在 `scopeOf(focal)` 的首屏可达集合内。
- **D13（Owner 2026-11-08 修正）**：共同祖先未读时，兄弟分支**可同叠**（打开祖先同屏全部
  后代分支）；「兄弟分支不算」仅指**无未读共同锚点**时不得自动合并。实现者不得按「兄弟永远
  不同叠」的简化理解写错；契约测试与 A2 双向覆盖。

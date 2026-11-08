# Proposal: report-thread-timeline（回复详情的连续溯源 + 全平铺 timeline）

## 背景（Owner 原话）

### 2026-11-08 第一次裁决：溯源要像 X 的 timeline

> 「关于回复里面嵌套回复。我感觉体验非常奇怪，按照 x 的设计，它应该是一个 timeline 的风格，但
> 我完全感受不到它是一个 timeline，而是传统意义上的'回复'。你知道的，x 里面的回复本质上是发帖。
> 换句话说，在我点开一个'回复'的帖子，并展开它的上下文的时候，我应该要看到一个 timeline，这个
> timeline 是关于这个回复的完整溯源。按照 x 的做法，它并不是点击展开，而是给了一种非常丝滑的滚动
> 行为来将 timeline 从上方展示出来：我现在的做法是点击展开相关的上下文，这会导致页面直接跳变，
> 会被上下文直接填满。」

### 2026-11-08 追加裁决（破坏性更新，覆盖 v1「回复树缩进不变」）

> 「大胆破坏性更新，现在最让我难受的，就是每一个回复都有缩进，通过缩进来表达回复已经是非常落后的
> 概念了。用 timeline 来表达'回复帖子的帖子'，才是最适合我们这个项目的。」

## 现状（只读实测，13689）

- 祖先上下文：`ancestorsExpanded` 折叠卡 + `ancestors-toggle`（`ThreadPage.tsx:248`、`:503-535`），
  展开后最多 3 条祖先 +「继续 N 条上文」（`:538-569`、`:553-567`）。
- 锚定：`container.scrollTop = offset - 60`（`ThreadPage.tsx:404-416`、`:415`）；实测详情吸顶栏
  实际高度 49px。
- 展开跳变：点击「3 条上文」后 focal 顶边 49px → **1803.67px**（390×844）/ **1309.61px**
  （1280×900），focal 离开视口；且展开后最大 scrollTop 1473/817 < focal offset 1803.67/1309.61，
  focal 无法贴顶（330.67/492.61）。
- 缩进层级：`buildReplyPlan` 用 `childIndent = Math.min(72, parentIndent + 24)`
  （`ThreadPage.tsx:87`）；`collapse-depth`（3 级封顶，`:134-141`）与 `expand-branch`
  （`:126-133`）把层级做进布局；后端折叠显示「继续 N 层回复」（`:669-681`）。
- 现状缩进实测（线程 `01M6V8HYXNPYWTS42H67N4X9AB`，390×844）：focal 卡片 left=12；
  回复行 left=36 / 60 / 84（marginLeft 24 / 48 / 72）；头像中心 x=49 / 73 / 84 / 97 / 121，
  完全不在同一列。
- 导轨：祖先/focal/回复行没有左侧导轨；唯一导轨是自接链的 `left-[23px] w-0.5`
  （`PostCard.tsx:133-145`）。
- 头像：祖先（小号）与 focal/回复（标准号）尺寸不一致（`PostCard.tsx:211`、`AuthorAvatar.tsx:32`）。
- 深树：`maxDepth=6`（`core/thread.ts:60`、`:166-181`），9 层链深链返回 7 条且 focal 不在
  `posts`（隔离后端已复现），当前 UI 永久骨架（`ThreadPage.tsx:499`）。

## 破坏性更新的目标

1. **彻底删除缩进**：所有回复（含自接链）与 focal/祖先使用同一条头像列、同一条左侧导轨；
   `marginLeft` 恒为 0，`padding-left` 无阶梯；不存在「每级 +24」「3 级封顶」。
2. **timeline 表达回复**：删除 `collapse-depth` / `expand-branch` /「继续 N 层回复」等因缩进
   存在的控件；后端折叠/未加载的深树改为平铺的「查看该子线程」入口（导航到该节点详情），
   不在本页内联嵌套。
3. **关系靠社交语义 + 导轨**：行内「回复给 @x」表达指向；自接链（同作者连续续接）用连续导轨
   段 + 紧凑呈现表达（仍不缩进）；分支按时间平铺。
4. **连续溯源**：祖先 + focal 同一条 timeline；进入即 focal 贴顶，祖先在上方可向上滚出；
   删除「N 条上文」折叠与「继续 N 条上文」。
5. **锚定稳定**：初始 scrollTop 确定、数据晚到不抖、返回恢复滚动位置、reduced-motion 瞬时。
6. **深树可读**：一次渲染服务端返回的全部祖先与回复；focal 被服务端截断时有明确回退，
   不空白/不骨架死锁。

## 非目标

- 不改线程数据模型与 HTTP 接口（`/api/read?thread=` 契约不变；不改 `maxDepth`）。
- 不改回复编辑器、通知/读态、共享元素转场契约。
- 不引入新的组件库；不重写 `PostCard` 的操作栏/正文渲染。
- 不强制给每行加「root 内路径」标签；「回复给 @x」已足够表达分支，路径标签仅作为可选补充。
- 不改服务端排序；平铺顺序在前端按 `thread.posts` 的 `created_at/seq/id` 稳定排序。

## 与在途 change 的关系（合并顺序不变）

- `report-notification-history-and-reply-submit` 当前 openspec 显示 **Complete**；它正在改
  `ThreadPage.tsx`（进页 `markPostRead`）与 `NotificationsPage`。本 change 的**实现**仍须等它
  合入主干后 rebase 再做，避免撞车。
- `report-event-hub` 也会改 `ThreadPage` 的 SSE 订阅；实现时以最后合入的主干为准。
- 本 change 当前只交付设计 + 规格，**不改 `src/`、不提交实现**。

## 影响面

- 前端：`src/ui/pages/ThreadPage.tsx`（`buildReplyPlan` 重写为平铺 planner、删除
  `extraDepth`/`expandedBranches`/indent/折叠控件、子线程入口、锚定/返回恢复）、
  `src/ui/components/PostCard.tsx`（自接链 24px 头像同轴居中于 46px 列、删除 `ChainPosition`
  子轨、祖先行 46px）、`src/ui/components/ContentSwap.tsx`（`animateHeight` 开关）、
  `src/ui/lib/scroll-memory.ts`（线程滚动记忆）、`Skeletons.tsx`（可选对齐）。
- 测试：新增 `scripts/qa/thread-timeline.mjs`（隔离后端 + 两视口 + 平铺/导轨/子线程入口断言 +
  before/after 截图）。
- 规格：`openspec/specs/report-surface/spec.md` 的 3 条 MODIFIED + 8 条 ADDED。
- 无服务端/SQLite/接口变更；无新依赖。

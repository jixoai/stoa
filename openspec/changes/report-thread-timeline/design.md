# Design: report-thread-timeline（v2，全平铺 timeline）

> v2 按 Owner 2026-11-08 追加裁决重写：**彻底删除缩进**。所有回复（含自接链）与 focal/祖先使用同一条
> 头像列、同一条左侧导轨；层级不再用 margin/padding/每级 +24/3 级封顶表达；关系靠
> 「回复给 @x」+ 导轨 + 时间顺序表达；`collapse-depth` / `expand-branch` /「继续 N 层回复」
> 全部删除；后端折叠深树改为平铺的「查看该子线程」入口（导航到该节点详情）。
>
> 目标：把「点开一条回复 → 点击展开上文 → 页面被上下文填满」改成 X 式体验：
> **进入即 focal 贴顶、祖先在滚动区上方；向上滚自然回溯；所有回复同列同轨、按时间平铺。**

---

## 0. 现状与证据（13689 只读实测）

### 0.1 代码事实

| 事实 | 位置 |
|------|------|
| 祖先折叠状态与开关 | `src/ui/pages/ThreadPage.tsx:248`、`:503-535` |
| 展开后祖先卡（最多 3 条）+「继续 N 条上文」 | `src/ui/pages/ThreadPage.tsx:538-569`、`:553-567` |
| 锚定 `scrollTop = offset - 60` | `src/ui/pages/ThreadPage.tsx:404-416`（`:415`） |
| 锚定 effect key 只含 `ancestorChain.length`，展开不重锚 | `src/ui/pages/ThreadPage.tsx:406` |
| 焦点卡 `scrollMarginTop` 依赖 sticky 条高度 | `src/ui/pages/ThreadPage.tsx:575` |
| 回复区「N 条回复」独立分隔行 | `src/ui/pages/ThreadPage.tsx:621-624` |
| 回复列表独立 Card | `src/ui/pages/ThreadPage.tsx:627` |
| **缩进公式 `childIndent = min(72, parentIndent + 24)`** | `src/ui/pages/ThreadPage.tsx:87` |
| **`expand-branch`（分支 >10 条内联展开）** | `src/ui/pages/ThreadPage.tsx:126-133`、`:683-703` |
| **`collapse-depth`（3 级封顶 +「继续 N 层回复」）** | `src/ui/pages/ThreadPage.tsx:134-141`、`:704-711` |
| **后端折叠「继续 N 层回复」** | `src/ui/pages/ThreadPage.tsx:669-681` |
| **`read-more`「Read N more replies」** | `src/ui/pages/ThreadPage.tsx:654-667` |
| 祖先 24px 头像 / focal+回复 42px | `src/ui/components/PostCard.tsx:211`、`src/ui/components/AuthorAvatar.tsx:32` |
| 现有导轨只服务自接链（`left-[23px] w-0.5`） | `src/ui/components/PostCard.tsx:133-145` |
| 吸顶栏实际高度：`h-12`(48px)+1px border=49px | `src/ui/components/PageHeader.tsx:47` |
| 骨架→内容：转场期间挂起，结束后 240ms 高度过渡 | `src/ui/components/ContentSwap.tsx:47-73` |
| 线程组装 `maxDepth=6`，超出折叠为 `collapsed` | `src/core/thread.ts:60`、`:166-181` |
| `spine_complete` 只表示 spine 无删除，不表示 focal 被返回 | `src/core/thread.ts:118` |
| 深链线程接口返回 | `src/server/store.ts:1393-1438`、`src/server/http.ts:486-494,572-581` |
| 路由方向（返回判定） | `src/ui/lib/router.tsx:409-418` |
| `prefers-reduced-motion` 判定 | `src/ui/lib/router.tsx:244-249` |
| 线程种子（单帖合成） | `src/ui/state/cache.ts:124-160` |

### 0.2 实测数字（只读 Playwright，生产 13689，深度 3 的回复 `01M6VAR943ASSEBD3PC9XRAPWF`）

| 指标 | 390×844 | 1280×900 |
|------|---------|----------|
| 详情 header 高度 | 49px（root 底下另有一个 89px feed header，测试要 scope） | 49px |
| scroll 容器 top / clientHeight | 49 / 739 | 49 / 851 |
| 初始 scrollTop / scrollHeight | 0 / 739（内容不足一屏） | 0 / 851 |
| 初始 focal 顶边（容器坐标） | **49px**（不是 60） | **49px** |
| sticky 上下文条 | top 49 / bottom 86（37px），`3 条上文` 按钮 53..81 | 同左 |
| 点击「3 条上文」后 focal 顶边 | **1803.67px**（Δ 1754.67） | **1309.61px**（Δ 1260.61） |
| 点击后 focal 是否在视口 | 否 | 否 |
| 展开后 scrollHeight / 最大 scrollTop | 2212 / 1473 | 1668 / 817 |
| 强行滚到 focal（scrollTop=最大）时 focal 顶边 | **330.67px**（无法贴顶） | **492.61px** |
| 3 条祖先高度 | 148.41 / 1344.05 / 250.22 | 123.7 / 924.09 / 200.81 |
| 祖先/focal/回复行导轨数量 | **0** | **0** |

### 0.3 缩进实测（同一线程 `01M6V8HYXNPYWTS42H67N4X9AB`，390×844）

| 行 | 卡片 left | marginLeft | 头像 left | 头像中心 x |
|----|-----------|------------|-----------|------------|
| focal | 12 | 0 | 28 | 49 |
| 一级回复 | 36 | 24 | 52 | 73 |
| 自接链续接 | 60 | 48 | 72 | 84（24px 头像） |
| 二级回复 | 60 | 48 | 76 | 97 |
| 三级回复 | 84 | 72 | 100 | 121 |

结论：现状头像中心 x 从 49 到 121 分散；`marginLeft` 24/48/72 阶梯；这正是 Owner 追加裁决要
彻底删除的「用缩进表达回复」。

### 0.4 深树实测（隔离后端 13683，9 层自接链）

- 链：root(depth0) → … → focal(depth8)，共 9 条。
- `GET /api/read?thread=<focal>` 返回 `posts.length=7`（depth 0..6），**focal 不在 posts**；
  `spine_complete=true`；`collapsed=[{parent_id: depth6, depth:6, count:2}]`。
- 当前 UI 的 `focal = nodeMap.get(thread.focal_id) ?? nodeMap.get(postId) ?? null` 得到 null，
  `ContentSwap ready={Boolean(focal)}` 永久骨架（`ThreadPage.tsx:499`）。
- 本 change 必须兜住（用现有 `GET /api/posts/:id`，不改接口）；折叠深树改「查看该子线程」入口，
  不做内联嵌套。

---

## 1. 目标 / 非目标

### 目标

1. **全平铺**：祖先 + focal + 所有回复（含自接链）在同一条全宽 timeline；所有回复行
   `marginLeft=0`、`padding-left` 无阶梯、头像列中心一致（±1px）、共用一条 trunk。
2. **删除层级控件**：`collapse-depth` / `expand-branch` /「继续 N 层回复」全部删除；
   后端折叠/未加载深树改为平铺的「查看该子线程」入口（导航到该节点详情）。
3. **关系靠社交语义 + 导轨**：行内「回复给 @x」表达指向；自接链用连续导轨段 + 紧凑呈现
   （仍不缩进）；分支按时间平铺。
4. **连续溯源**：祖先 + focal 同一条 timeline；删除「N 条上文」折叠/「继续 N 条上文」；
   进入即 focal 贴顶，祖先在上方可向上滚出。
5. **锚定稳定**：初始 scrollTop 确定、数据晚到不抖、返回恢复滚动位置、reduced-motion 瞬时。
6. **深树可读**：一次渲染服务端返回的全部祖先与回复；focal 被服务端截断时有明确回退，
   不空白/不骨架死锁。

### 非目标

- 不改 `thread()` / `/api/read?thread=` 契约与 `maxDepth`。
- 不改回复编辑器、通知/读态、共享元素转场契约。
- 不引入组件库；不重写 `PostCard` 操作栏/正文渲染。
- 不强制给每行加「root 内路径」标签；「回复给 @x」已足够表达分支；路径标签仅作为可选补充。
- 不强制把 24px 自接链头像改成 42px：允许 24px 头像**居中于 42px 头像列**（中心 x=37），
  但禁止任何缩进/padding-left 阶梯。

---

## 2. 平铺 timeline 模型

### 2.1 行序（唯一顺序口径）

1. **祖先链**：`ancestorChain`（focal parent→…→root）`reverse()` → root → … → parent，渲染在
   focal 上方。
2. **focal**：紧随祖先链。
3. **平铺回复**：`thread.posts` 中排除 focal 与整条祖先链的节点，按
   `(created_at, seq, id)` 升序稳定排序；不分组、不置顶自接链、不按深度嵌套。
4. **子线程入口**：对任一节点，若 `backendCollapsed.get(node.id) ?? 0 > 0` 或
   `node.child_count > loadedChildren`，在该节点行之后插入一条 `kind="subthread"` 的
   「查看该子线程 · N 条回复」入口；它**不是回复行**，不参与头像列/时间排序，只作为该节点的
   未加载子树导航。
5. 祖先链内部仍按 root → parent 时间顺序；focal 的 parent 就是上一行，因此 focal 不显示
   「回复给」；祖先同理。

> 为什么是「祖先+focal 固定在上、其余按时间平铺」：focal 是本次打开的锚点，必须可溯源；
> 其余回复是围绕该 root 的对话，按时间平铺最符合 X 的「回复即发帖」。不把整棵树按全序
> 重新混排，避免 focal 被卷进无关分支。

### 2.2 DOM 结构（口径）

```tsx
<div className="relative flex h-full min-h-0 flex-col">
  <ThreadHeader />                                  {/* 49px，sticky，不参与滚动 */}
  <div className="relative min-h-0 flex-1">
    <div ref={containerRef} data-testid="thread-scroll"
         className="h-full overflow-y-auto" style={{ overflowAnchor: "none" }}>
      <ContentSwap ready={Boolean(focal)} animateHeight={false} skeleton={<ThreadSkeleton />}
                   testId="thread-swap">
        {focal ? (
          <>
            <div data-testid="thread-timeline" className="divide-y divide-border/60">
              {ancestors.map((node) => (
                <TimelineRow key={node.id} kind="ancestor" railPosition={...}>
                  <PostCard post={node} variant="ancestor" ... />
                </TimelineRow>
              ))}

              <TimelineRow kind="focal" testId="focal-card" railPosition={...}>
                <PostCard post={focal} variant="focal" replyingTo={null} ... />
                <div className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
                  {fullTime(focal.created_at)}
                  {focal.reply_count > 0 ? ` · ${focal.reply_count} 条回复` : null}
                </div>
              </TimelineRow>

              {loaded ? flatRows.map((row) => row.kind === "post" ? (
                <TimelineRow key={`p-${row.node.id}`} kind="reply" railPosition="middle">
                  <PostCard post={row.node} variant="reply"
                            selfContinuation={row.compact}
                            selfHeader={row.compactHeader}
                            replyingTo={row.replyingTo} ... />
                </TimelineRow>
              ) : (
                <TimelineRow key={`s-${row.nodeId}`} kind="subthread" railPosition="middle">
                  <button data-testid="subthread-entry" onClick={() => navigate(`/p/${row.nodeId}`)}>
                    <ChevronRightIcon /> 查看该子线程 · {row.count} 条回复
                  </button>
                </TimelineRow>
              )) : (
                <TimelineRow kind="reply-skeleton" railPosition="middle"><ReplySkeleton /></TimelineRow>
              )}
            </div>

            <div data-testid="thread-tail-spacer" aria-hidden style={{ height: tailSpacer }} />
            <div className="sticky bottom-0 ...">{/* 发布你的回复 */}</div>
          </>
        ) : null}
      </ContentSwap>

      {newReplyCount > 0 ? (
        <div className="absolute right-3 top-3 z-20">
          <Button data-testid="new-replies-pill" ...>{newReplyCount} 条新回复</Button>
        </div>
      ) : null}
    </div>
  </div>
  <ReplyComposer ... />
</div>
```

要点：

- **所有行全宽、无 `marginLeft`、无 `padding-left` 阶梯**；行与行用 `divide-y` 相接。
- 不再有 sticky 上下文条；新回复胶囊移到滚动容器右上角 overlay，不占布局高度。
- 删除「N 条回复」独立分隔行；回复数放到 focal footer（用服务端 `focal.reply_count`）。
- 祖先行使用与 focal 相同的 PostCard 度量（42px 头像、`px-4 py-3`、作者行、全文正文）。
- 自接链续接行（`compact`）仍可隐藏重复作者行/操作栏，但使用 **同一个 42px 头像列**
  （24px 头像居中于列内），`px-4` 不变，不产生 padding 阶梯。

### 2.3 关系表达（「回复给 @x」）

- 对每一条 post 行（祖先/focal/回复），设 `prevPost` = 上一条 **post 行**（跳过 subthread 入口）。
- 若 `node.parent_id && node.parent_id !== prevPost?.id`，显示「回复给 @parentAuthor」；
  `parentAuthor = node.reply_to_account_id ?? parentNode?.author ?? node.parent_id`。
- 若父帖就是上一行（祖先链、focal、紧随 focal 的首条回复、自接链父子相邻），不显示；
  这正是「关系已经由导轨 + 邻位表达」。
- `i/n`：保留服务端返回时的显示（spine 叙事）；不是层级信号。
- `selfContinuation`（紧凑呈现）的判定：`node.is_self_continuation && prevPost?.id === node.parent_id`
  ——只有**时间上连续的同作者父子**才用紧凑行；若被其他分支按时间隔开，则按普通回复行渲染
  并显示「回复给 @x」。`selfHeader = compact && !prevPost?.is_self_continuation`（连续链只在
  第一条显示作者/时间；后续只留头像 + 正文 + `i/n`）。这样「自接链」是时间连续的自然结果，
  不是布局分组。

### 2.4 状态机

| 状态 | 触发 | 页面表现 |
|------|------|----------|
| `seed` | 首帧无完整线程，仅有单帖种子 | focal 行 + 回复骨架；focal 锚 0；无祖先 |
| `full` | `load()` 返回完整线程（转场期间 held，结束后 commit） | 祖先插入 focal 上方；同一 layout 帧重算 spacer/scrollTop，focal 屏幕位置不变 |
| `flat` | full 后有回复 | 所有回复按 `(created_at, seq, id)` 平铺；子线程入口附着在父行后 |
| `scrolled` | 用户 wheel/touch/pointer/key 滚动 | 解除锚定锁；后续数据更新不得强行拉回 focal |
| `restore` | 路由方向 = back 且本线程有滚动记忆 | 恢复离开前的首可见行 + 偏移；不贴 focal |
| `deep-gap` | `thread.posts` 不含 focal | `GET /api/posts/:id` 合成 focal；顶部上下文缺口行（见 §5） |
| `new-replies` | SSE 静默补拉到新回复 | `pendingThread` + 浮动胶囊；不重排、不动 focal |
| `deleted` | focal 已删除 | 保留 focal 占位行与回复区；隐藏回复入口；导轨不断 |

没有 `expanded` / `collapsed-depth` / `expanded-branches` 状态。

---

## 3. 几何（全平铺 + 一条 trunk）

### 3.1 度量

沿用现有 `PostCard` 行度量：

| 量 | 值 | 来源/说明 |
|----|----|-----------|
| 行水平 padding | 16px (`px-4`)，**所有 post 行一致** | `PostCard.tsx:193`；自接链分支也改为 `px-4` |
| 头像列宽 | **42px**（所有 post 行一致） | 42px 头像；24px 自接链头像居中于该列 |
| 头像/正文 gap | 12px (`gap-3`) | 自接链分支也改为 `gap-3` |
| 头像中心 x（行内） | 16 + 21 = **37px** | 行左缘为 0（全宽行，`marginLeft=0`） |
| 导轨宽 | **2px** (`w-0.5`)，颜色 `border` 令牌 | 与现有自接链导轨同视觉 |
| 导轨左缘 x | **36px**（`left-9`） | 36..38 → 中心 37 |
| 普通行头像上缘 y | 12px (`py-3`) | `PostCard.tsx:193` |
| 普通行头像下缘 y | 12 + 42 = 54px | |
| 自接链行头像上缘 y | 6 + (42-24)/2 = **15px**（`py-1.5`） | 24px 头像居中于 42px 列 |
| 自接链行头像下缘 y | 15 + 24 = **39px** | |
| 行间分隔 | 1px `divide-y` | 允许 1px 容差 |

### 3.2 行内导轨段（两段式）

每条 timeline 行（`TimelineRow`）是 `position:relative` 的全宽包裹层，导轨是两条
`pointer-events-none` 的绝对定位 span，**不放在 PostCard 内部**（这样 focal footer 也覆盖）：

```tsx
{railAbove ? (
  <span aria-hidden data-testid="thread-rail" data-rail="top"
        className="pointer-events-none absolute left-9 w-0.5 bg-border"
        style={{ top: 0, height: "var(--rail-avatar-top, 12px)" }} />
) : null}
{railBelow ? (
  <span aria-hidden data-testid="thread-rail" data-rail="bottom"
        className="pointer-events-none absolute left-9 w-0.5 bg-border"
        style={{ top: "var(--rail-avatar-bottom, 54px)", bottom: 0 }} />
) : null}
```

- 头像盖住导轨：`PostCard` 的 `[data-shared-avatar]` 包裹层加 `relative z-[1]`；
  `AuthorAvatar` 的 `bg-muted` 不透明，导轨在头像区域被遮住，视觉上是「头像上方一段 +
  下方一段」。
- `railAbove` / `railBelow` 由行在 timeline 中的位置决定：
  - 首行：`railAbove=false`；
  - 末行：`railBelow=false`；
  - 中间行：两段都有；
  - 只有一行：两段都没有。
- **focal 的 `railAbove` 段就是顶部 stub**：focal 有祖先时一定有上段；贴顶时从滚动视口顶边
  （=吸顶栏下沿）延伸到 focal 头像上缘（12px）。
  - 渲染条件：`hasAncestorAbove(focal) === true`。
  - 可见判据：`focalRow.top <= containerTop < focalAvatar.bottom`（几何自然决定）。
  - 测试 id：focal 的 top 段额外带 `data-testid="thread-rail-stub"`。
- **连续性容差**：相邻行 bottom 段 `bottom:0` 与下一行 top 段 `top:0` 相接；`divide-y` 的 1px
  边框计入，允许 `|prev.bottom - next.top| <= 1px`、`|left-left'| <= 1px`、
  `|width-width'| <= 1px`。
- **trunk 全局唯一**：所有 post 行（祖先/focal/所有回复/自接链）都在 x=36..38 同一条线上；
  不再有第二根 `left-[23px]` 子轨，也不再因 indent 改变 x。

### 3.3 自接链（compact）如何保持不缩进

自接链后续条仍可用 24px 头像和紧凑正文，但**必须落在同一个 42px 头像列**：

- 行结构改为：`relative flex gap-3 px-4 py-1.5`；头像包裹层
  `relative z-[1] flex h-[42px] w-[42px] shrink-0 items-center justify-center`；
  `AuthorAvatar size="small"`（24px）在列内居中。
- 该行设置 `--rail-avatar-top: 15px`、`--rail-avatar-bottom: 39px`（`py-1.5` + 42px 列内
  居中的 24px 头像）；trunk 的上/下段按紧凑几何贴合头像。
- 删除 `ChainPosition` / `left-[23px]` 子轨：自接链的连续性由 trunk 表达。
- 紧凑呈现仅用于「时间上连续的父子同作者」：`prevPost.id === node.parent_id &&
  node.is_self_continuation`。被其他分支隔开时按普通回复行渲染（作者行 +「回复给 @x」）。
- `padding-left` 恒为 16px，**没有 25px / 24px 阶梯**；头像中心 x 仍为 37。

### 3.4 子线程入口（替代 collapse-depth / expand-branch / 继续 N 层）

| 旧控件 | 新表现 |
|--------|--------|
| `collapse-depth`（3 级封顶 +「继续 N 层回复」） | **删除**；深层节点直接平铺，不再折叠 |
| `expand-branch`（分支 >10 条内联展开） | **删除**；分支按时间平铺，不内联展开 |
| `backend-collapse`（后端折叠「继续 N 层回复」） | 改为 `kind="subthread"` 行：**「查看该子线程 · N 条回复」**，点击 `navigate("/p/<nodeId>")` |
| `read-more`（「Read N more replies」） | 同上，统一为「查看该子线程 · N 条回复」，导航到该节点详情 |

子线程入口行的几何：

- 全宽、`marginLeft=0`、`pl-12`（48px，让出 x=36 的导轨槽）、`pr-4`、`py-2`；
- 无头像；trunk 两段贯穿（`railAbove/railBelow` 按位置）；
- `data-testid="subthread-entry"`、`data-node-id="<parentId>"`；
- 文案与图标：`ChevronRightIcon` + 「查看该子线程 · N 条回复」；
- 计数：`backendCollapsed.get(nodeId) ?? (node.child_count - loadedChildren)`；每个节点只渲染
  一条入口，避免同一子树出现两个入口；
- 它**不是回复行**，不参与「头像中心 x」断言，也不参与 `(created_at, seq, id)` 排序；
  只附着在父 post 行之后。

### 3.5 删除 / 折叠 / 控制行

| 行类型 | 高度 | 导轨 | 说明 |
|--------|------|------|------|
| 删除占位（祖先/回复） | `DeletedBody` 高度（min-h-16） | 两段 | 不跳过、不塌陷，前后行连续 |
| 子线程入口 | 按钮行（py-2） | 两段 | 导航到该节点详情，不内联展开 |
| focal footer（fullTime · N 条回复） | 约 32px | focal 的 bottom 段贯穿 | footer 属于 focal 行，不能断点 |

不再存在 `collapse-depth` / `expand-branch` / 「继续 N 层回复」行。

### 3.6 与共享元素转场的关系

- 只有 focal 行保留 `variant="focal"` 的静态共享名（`PostCard.tsx:82,211-223`）；祖先行不登记
  静态名。点击任一卡片仍由 `markSharedSubject` 按被点击主体打标（`lib/shared-element.ts:36-57`）。
- 祖先 24→42px 只影响目标页 focal 的落点对齐；共享元素形变仍由浏览器对同名
  `vt-avatar-*` / `vt-author-*` 做 transform/size 插值，不改 `shared-element.ts` / `router.tsx`。
- 转场首帧：完整线程命中缓存时，祖先已在首帧 DOM 中，锚定在 commit 的 layout 阶段完成，
  快照即最终位置；只有单帖种子时，祖先在转场结束后插入，锚定补偿使 focal 屏幕位置不变
  （见 §4.2），快照撤掉前后无位移。

---

## 4. 初始锚定、数据晚到、返回恢复

### 4.1 初始锚定（进入详情）

滚动容器顶边就是吸顶栏下沿（容器在 header 之外，`ThreadPage.tsx:496-498`）。因此目标不是
「减 60」，而是**容器坐标 0**：

```ts
// useLayoutEffect，数据就绪且 focal 行已挂载
const container = containerRef.current;
const focalRow = focalRowRef.current;
if (!container || !focalRow) return;

// 0) 先把上次的 spacer 归零，否则 below 会把 spacer 自己算进去
spacerRef.current.style.height = "0px";

// 1) 先量：F = focal 行在滚动内容中的 offsetTop
const F = focalRow.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        + container.scrollTop;

// 2) 再补 tail spacer，保证 F 可达（见 4.1.1）
const V = container.clientHeight;
const f = focalRow.offsetHeight;
const below = container.scrollHeight - F - f;   // focal 底部之后的内容（含回复/编辑器/spacer=0）
const spacer = Math.ceil(Math.max(0, V - f - below)); // 向上取整，避免亚像素 clamp
spacerRef.current.style.height = `${spacer}px`;

// 3) 贴顶（同一 layout 帧，before paint）
container.scrollTop = Math.min(Math.round(F), container.scrollHeight - V);

// 4) 验收口径
//    focalRow.getBoundingClientRect().top - container.getBoundingClientRect().top ∈ [-2, 2]
```

- **不再使用** `offset - 60`（旧代码 `ThreadPage.tsx:415`）；也不再依赖 `scroll-margin-top`
  （旧 `:575`），两者删除。
- 只锚定一次：`anchorKey = thread.root_id | focal_id | entryPostId`；同一 key 不重复。
  种子→完整线程时 key 不变，但 `ancestorChain.length` 变化触发**补偿锚定**（见 4.2），
  仍然只在用户未滚动时执行。
- 若 `F` 因内容不足被浏览器 clamp（理论上 spacer 已消除），以 `scrollHeight - clientHeight`
  为上限，并记录 `data-anchor-clamped="true"` 供 QA 报警。

#### 4.1.1 为什么必须有 tail spacer

实测展开后 focal offset 1803.67px，但最大 scrollTop 只有 1473px，focal 只能到 330.67px。
公式推导：

- 设 `V=clientHeight`、`f=focal 行高`、`below=focal 底部之后的内容高度`、`F=focal offsetTop`。
- 当前 `H = F + f + below`，最大滚动 `max = H - V`。要 `max >= F`，需 `F + f + below - V >= F`
  → `f + below >= V`。
- 若 `f + below < V`，补 `S = V - f - below`；补后 `max = F + f + below + S - V = F`，恰好可达。
- spacer 为空 div，`aria-hidden`，`data-testid="thread-tail-spacer"`；窗口 resize / 回复合并时
  重算。spacer 在 focal 下方，变化不影响已显示内容的视觉位置。

### 4.2 数据晚到（seed → full）不抖

时序：

1. 首帧种子（无祖先）或骨架：focal 在 0；`anchorLocked=true`。
2. 完整线程在转场期间被 `heldThread` 挂起（`ThreadPage.tsx:221-242`），不插入祖先。
3. 转场结束 → `commitThread` 落地：祖先插入 focal 上方，focal 内容坐标 F 从 0 变为
   `sum(祖先行高)`。
4. **同一 layout 帧**执行 §4.1 的步骤：重算 F、spacer、`scrollTop = F`。浏览器尚未 paint，
   用户看到的是「focal 一直在吸顶栏下沿」，祖先在屏幕上方。
5. 外层 `ContentSwap` 传 `animateHeight={false}`：骨架→timeline 不做 240ms 高度过渡，
   避免容器高度被临时钳在骨架高度、导致 `scrollTop=F` 被 clamp 到 0、先看到祖先再跳到
   focal 的中间帧。
6. `scroller.style.overflowAnchor = "none"`：阻止浏览器自身的 scroll anchoring 与我们的
   `scrollTop` 补偿打架。
7. `anchorLocked` 只在**首次内容锚定完成后**、用户首次滚动（wheel/touchstart/pointerdown/keydown）
   后解除；骨架/种子阶段的滚动不解除。解除后数据更新只做「保持当前首可见行」的补偿
   （更新前记录该行的 `rowTop - containerTop`，更新后用同一公式把差值补回，阈值 2px），
   **不**把用户拉回 focal。
8. 回复区骨架 → 回复行的内容替换发生在 focal 下方，不改变 focal 的 offsetTop；可在回复区
   保留现有 `ContentSwap` 的 240ms 高度过渡（不影响锚点），也可以直接条件渲染回复行。

### 4.3 返回时滚动位置恢复

- key：`report.thread.v1:<postId>`（`sessionStorage`，同会话返回即可）。
- 值：`{ anchorId, offsetPx, scrollTop, savedAt }`；`anchorId` = 容器顶边下方第一条
  `[data-timeline-row]` 的 `data-post-id`（跳过 subthread 入口），`offsetPx` =
  该行 top − 容器 top（可为负）。
- 写入时机：滚动 rAF 节流、`pagehide`、`visibilitychange=hidden`、组件卸载。
- 恢复条件：`useTransitionDirection() === "back"`（`lib/router.tsx:409-418`）且 key 存在。
  深链/前进（`fade`/`forward`）忽略记忆，按 §4.1 贴 focal。
- 恢复算法（layout 阶段，内容就绪后）：
  ```ts
  const row = container.querySelector(`[data-post-id="${CSS.escape(entry.anchorId)}"]`);
  if (row) {
    const top = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop += top - entry.offsetPx;
  } else {
    container.scrollTop = entry.scrollTop;
  }
  ```
  恢复后不执行 focal 锚定；`anchorLocked=false`。
- 冷缓存（返回时线程不在内存缓存）：先骨架，线程到达后 instant 落地并恢复，仍不贴 focal。
- 验收：在 A 线程滚到第 2 条祖先，点开 B 帖再返回 A，A 的首可见行与偏移 ±2px。

### 4.4 `prefers-reduced-motion`

- 锚定与恢复一律直接写 `scrollTop`（瞬时），**禁止** `scrollTo({behavior:"smooth"})`。
- 线程页外层 `ContentSwap` 的 `animateHeight=false`；CSS 既有
  `@media (prefers-reduced-motion: reduce)` 已把 `report-swap-in/out` 压到 1ms
  （`src/ui/app.css:177-185`）。
- 转场本身由 router 在 reduced-motion 下跳过（`lib/router.tsx:262-266`），本 change 不碰。
- 导轨/stub 是静态元素，无动画。

---

## 5. 深树、缺失祖先与阈值

### 5.1 一次全渲染（默认）

- `thread()` 先取该 root 的全部 posts，再 `assembleThread`；`maxDepth=6` 意味着返回的节点
  最多 depth 0..6。
- 所有返回的节点一次渲染：祖先链在上、focal、其余按时间平铺；不做虚拟滚动、不逐条请求、
  不做祖先/回复懒加载。
- 祖先正文不截断（与 focal 全文口径一致）。
- 安全阈值：祖先 >20 条时只渲染**最近 20 条**，其余在顶部显示缺口占位行（当前 maxDepth=6，
  正常不触发）。

### 5.2 focal 缺失（深度 >6 的深链）

判定（不要用 `spine_complete`，它只表示 spine 无删除）：

```ts
const focalInPosts = thread.posts.some((p) => p.id === (thread.focal_id ?? postId));
```

当 `!focalInPosts`：

1. 用现有 `client.post(postId)`（`src/ui/lib/api.ts:389`）取焦点帖，合成一个 `ThreadNode`
   作为 focal 行渲染；页面不再空白/永久骨架。
2. 在 timeline 顶部渲染 `kind="context-gap"` 行：「更早的上文未随本页加载」+ 父帖作者/时间
   （若有）+ 跳转父帖详情 `navigate("/p/" + focal.parent_id)`；**导航**，不是内联展开。
3. `thread.posts` 中可沿 `parent_id` 解析为 focal 祖先的节点按链渲染；走不通的 root..depth6
   节点不得伪装成 focal 的相邻祖先。
4. `thread.collapsed` 的组若落在缺口上，只作为缺口行的计数来源，不渲染成 ancestor 行。

### 5.3 删除祖先 / 后端折叠

- 删除祖先/回复在 `thread.posts` 中仍存在，按 §3.5 渲染占位行，导轨不断。
- 后端折叠分组（`thread.collapsed`）与未加载子节点：统一渲染为 §3.4 的
  「查看该子线程」入口，**不再有「继续 N 层回复」**；入口附着在父 post 行之后。
- 删除 `collapse-depth` / `expand-branch` / `extraDepth` / `expandedBranches` 全部状态与 UI。
- 说明：当前 `maxDepth=6` 下，折叠入口导航到父节点详情仍可能受同一 maxDepth 限制；这是
  接口契约的已知边界（本 change 非目标不改 `maxDepth`），但入口语义与手势按 Owner 要求落地。

---

## 6. 验收方案（浏览器，隔离后端）

### 6.1 环境

- 后端：`bun scripts/qa/qa-serve.mjs`（fresh `/tmp/report-qa-*`，禁止 13689）。
- 视口：390×844（`hasTouch/isMobile`）与 1280×900。
- 夹具（脚本用 API 写入隔离后端）：
  1. 链 root→A1→A2→A3→A4→A5→focal（6 条祖先），focal 下 3 条回复；
  2. A2 删除；A4 长正文（>40 行）；
  3. **交错分支**：A→B(t1), A→C(t2), B→D(t3), C→E(t4)，用于平铺时间序/「回复给 @x」；
  4. **深嵌套** A→B→C→D→E（>3 层），用于「无 3 级封顶、无继续 N 层」；
  5. **自接链** A→S1→S2 连续同作者，用于紧凑行 + 连续导轨；
  6. **9 层链**用于 focal 缺失回退与「查看该子线程」入口。
- 截图落 `.agents/reports/report-thread-timeline/`，含 before（当前 13689 只读）与 after
  （隔离后端新构建）成对截图；`report.html` 用统一脚本生成。

### 6.2 断言清单

| # | 断言 | 方法 |
|---|------|------|
| 1 | 不存在祖先展开入口 | `[data-testid="ancestors-toggle"]`=0；无文本 `/条上文/` |
| 2 | 进入即 focal 贴顶 | `focalRow.top - container.top ∈ [-2,2]`；`scrollTop === F`（rect 计算，±1） |
| 3 | 祖先在首屏上方、无需点击 | 祖先文本在 DOM；`scrollTop > 0`（有祖先时）；向上滚可见 root；全程无点击 |
| 4 | 不填满视口 | focal 可见高度 ≥ 行高 60%（夹具 3 行 focal） |
| 5 | 数据晚到不抖 | 延迟 `/api/read?thread=` 400ms；rAF 采样 60 帧 `focalTop`，极差 ≤2px，无 >4px 跳变 |
| 6 | **无缩进** | 每条 `[data-timeline-row="reply"]` 的 `getComputedStyle().marginLeft === "0px"`；所有 post 行 `padding-left === "16px"`（无 24/48/72 阶梯） |
| 7 | **头像同列** | 祖先/focal/所有回复（含自接链）的头像中心 x 与 37px 差 ≤1px；任意两行中心差 ≤1px |
| 8 | **无层级控件** | 无 `[data-testid="collapse-depth"]` / `[data-testid="expand-branch"]`；无文本 `/继续 \d+ 层回复/`；无 `extraDepth` 控件 |
| 9 | **子线程入口** | 有折叠/未加载子树的节点后存在 `[data-testid="subthread-entry"]`，文案含「查看该子线程」；点击后 `location.hash` 变为 `/p/<nodeId>`；当前页不增加隐藏行 |
| 10 | **平铺时间序** | focal 之后 `[data-timeline-row="reply"]` 的 `data-post-id` 顺序 = 把 API JSON 的 nodes 按 `(created_at, seq, id)` 排序后的顺序（不是后端原序） |
| 11 | **回复给 @x** | 父帖不是上一 post 行的回复显示「回复给 @x」；相邻父子（祖先/focal/首条回复/连续自接链）不显示 |
| 12 | **自接链导轨连续** | 连续同作者父子行的 trunk 段在 1px 内相接；不存在第二根 `left-[23px]` 子轨；自接链行头像中心仍为 37±1 |
| 13 | 导轨连续（祖先→focal→回复） | 相邻 `[data-testid="thread-rail"]`：`|prev.bottom-next.top| ≤1`、left/width ≤1 |
| 14 | focal 贴顶有 stub | `[data-testid="thread-rail-stub"]` 存在；高度 ≈ `avatar.top - container.top`（约 12px，≥8px） |
| 15 | 删除行不断轨 | 删除占位行存在，前后 trunk 相接 |
| 16 | 返回恢复 | A 滚到第 2 条祖先 → 进 B → back：A 首可见行/偏移 ±2px，不被拉回 focal |
| 17 | 深树 focal 不丢 | 9 层链：`focal-card` 存在；顶部 `context-gap` 行可导航父帖 |
| 18 | 共享元素仍形变 | 复用 `overlay-back.mjs` 的 `vt-avatar-*`/`vt-author-*` 组断言 |
| 19 | reduced-motion | 首帧即到位（±2px），无平滑滚动中间帧 |
| 20 | 无 console error / 无横向溢出 | `pageerror`/console error=0；390 宽 `scrollWidth <= clientWidth` |

### 6.3 采样细节

- 锚定/rAF 采样只统计 `focalRow` 存在之后的帧。
- 导轨/头像矩形取 `getBoundingClientRect()`，`toFixed(1)`；1px 容差覆盖 `divide-y` 边框。
- 测试 scope 到 `[data-testid="thread-scroll"]`：底层 root 页仍挂载（实测有两个 header：
  89px feed header + 49px detail header），`document.querySelector("header")` 会取错。
- 所有写操作只对隔离后端；13689 只做 before 截图（只读）。

---

## 7. 实现落点（实现阶段，按此顺序）

1. `ThreadPage.tsx`
   - **重写 `buildReplyPlan` 为平铺 planner**：
     - 删除 `indent`/`childIndent`/`maxDepth`/`extraDepth`/`expandedBranches`；
     - `ancestors` = reverse(ancestorChain)；
     - `flat` = `thread.posts` 排除 focal 与祖先，按 `(created_at, seq, id)` 升序；
     - 逐行计算 `prevPost`、`compact = is_self_continuation && prevPost.id === parent_id`、
       `replyingTo = parent_id && parent_id !== prevPost.id`；
     - 子线程入口：每个节点最多一条，`count = backendCollapsed.get(id) ?? (child_count - loaded)`；
   - 删除 `ancestorsExpanded`（`:248`）、`ancestors-toggle`（`:503-535`）、祖先 Card
     （`:538-569`）、`scrollMarginTop`（`:575`）、「N 条回复」header（`:621-624`）、
     `collapse-depth`/`expand-branch`/`backend-collapse`/`read-more` 的旧按钮
     （`:654-711`）。
   - 所有行包 `TimelineRow`（全宽、`relative`、导轨两段、`data-timeline-row` /
     `data-rail-position`），**不再给行加 `style={{ marginLeft }}`**。
   - 删除旧锚定（`:404-416`），实现 §4.1 的 F/spacer/scrollTop；`overflow-anchor:none`。
   - 种子→完整线程：沿用 `heldThread`，commit 后 layout 帧补偿；用户滚动后锁定。
   - 新回复胶囊移到滚动容器右上 overlay。
   - 深树：`focalInPosts` 判定 + `client.post` 合成 focal + `context-gap` 行。
2. `PostCard.tsx`
   - `variant="ancestor"` 头像 24→42（`:211`），正文用 focal 字号；废弃 24px 祖先紧凑样式。
   - 普通分支 `[data-shared-avatar]` 补 `relative z-[1]`。
   - 自接链分支：`px-3` → `px-4`、`gap-2` → `gap-3`；头像包裹层
     `flex h-[42px] w-[42px] items-center justify-center`（24px 头像居中）；
     删除 `left-[23px]` 子轨与 `chainPosition` 逻辑。
   - 删除 `ChainPosition` 类型/导出；`selfContinuation`/`selfHeader` 保留，由 planner 传入。
   - `replyingTo` 文案从现有「回复 @x」改为「回复给 @x」（`PostCard.tsx:226-230`），与 spec 一致；
     仅在 `parent_id !== prevPost.id` 时显示。
3. `ContentSwap.tsx`
   - 新增 `animateHeight?: boolean`（默认 true）；线程页外层传 false。
4. `scroll-memory.ts`
   - 新增线程滚动记忆（sessionStorage，`anchorId/offsetPx/scrollTop/savedAt`）。
5. `Skeletons.tsx`
   - `ThreadSkeleton` 保持与 timeline 行同度量（42px 头像、px-4 py-3），避免骨架→内容高度差。
6. `scripts/qa/thread-timeline.mjs`
   - 按 §6 实现 20 条断言 + before/after 截图 + report.json；
   - 复用 `scripts/qa/lib/qa-env.mjs` 的隔离后端/登录/清理；不读生产 token。
7. 回归
   - `bun test`、`bun run check`、`bun run typecheck`、`bun run typecheck:ui`；
   - `overlay-back.mjs`（共享元素/返回）、`notifications-read.mjs`（进页已读）、
     `reply-composer.mjs` 全绿；
   - 变更文件逐个 before/after 截图（Owner 2026-11-04 纪律）。

---

## 8. 备选方案与否决理由

| 方案 | 结论 | 理由 |
|------|------|------|
| 保留缩进，只改祖先上下文 | 否决 | Owner 2026-11-08 追加裁决：缩进表达回复是落后概念 |
| 保留 3 级封顶/继续 N 层 | 否决 | 层级控件随缩进一起删除 |
| 所有回复统一 42px 头像 | 备选 | 最统一；但会丢掉自接链的紧凑呈现，故采用 24px 居中于 42px 列 |
| 自接链 24px 头像 + `padding-left:25px` 对齐 | 否决 | 会产生 padding-left 阶梯，违反 Owner 的「无 padding-left 阶梯」 |
| 自接链 24px 居中于 42px 列 + `px-4` | **采用** | 头像中心 37、padding-left 16 恒等、紧凑视觉保留 |
| 自接链保持独立 `left-[23px]` 子轨 | 否决 | 出现第二根导轨，违反「同一条左侧导轨」 |
| 按 backend `thread.posts` 原序平铺 | 否决 | 后端是 spine-first/branch DFS，不是纯时间；Owner 要求按时间 |
| 前端按 `(created_at, seq, id)` 稳定排序 | **采用** | 确定、可测、无接口变更 |
| 折叠入口内联展开 | 否决 | Owner 明确「不内联嵌套」；改为导航子线程 |
| 保留 `read-more` 的英文文案 | 否决 | 与「查看该子线程」统一，避免两套控件语言 |

---

## 9. 风险与兼容

| 风险 | 缓解 |
|------|------|
| 全平铺后分支关系难读 | 「回复给 @x」在父帖非邻位时显示；自接链紧凑呈现；可选路径标签 |
| 自接链被其他分支按时间隔开 | 只有连续同作者父子用紧凑行；否则正常行 + 回复给 @x |
| 24px 头像居中于 42px 列的垂直几何 | 行 `py-1.5`，`--rail-avatar-top:15px` / `--rail-avatar-bottom:39px`；QA 头像中心 x |
| 折叠入口导航受 maxDepth=6 限制 | 入口按 Owner 要求落地；接口上限为已知边界，另立 change 才改 |
| 全宽 `divide-y` 行替代圆角 Card | 与 feed 同源（`TimelineFeed.tsx:547`）；before/after 截图由 Owner 审 |
| `overflow-anchor:none` 与浏览器滚动锚定 | 只作用于线程滚动容器 |
| tail spacer 在 focal 下方产生空白 | 只在 `f + below < V` 时补足到一屏 |
| 种子→完整线程补偿与转场快照 | 沿用 `heldThread` 等转场结束再 commit；补偿在 layout 帧内完成 |
| 两个 header（root 89px / detail 49px） | 实现不依赖 `document.querySelector("header")`；QA scope 到 thread-scroll |
| 返回恢复与「进页已读」在途 change | 等 `report-notification-history-and-reply-submit` 合入主干后 rebase（当前 openspec 已显示 Complete） |

---

## 10. 结论

- v2 的核心是 **一个平面、一条 trunk、一个时间序**：所有回复与 focal/祖先同列同轨；缩进、
  3 级封顶、`collapse-depth`、`expand-branch`、「继续 N 层回复」全部消失。
- 关系由「回复给 @x」+ 连续导轨 + 时间顺序表达；自接链只在时间连续时紧凑呈现，仍同列同轨。
- 折叠深树改为「查看该子线程」导航入口；不在本页内联嵌套。
- 祖先溯源、focal 贴顶、tail spacer、stub、返回恢复、深树 focal 兜底沿用 v1 的几何与锚定方案。

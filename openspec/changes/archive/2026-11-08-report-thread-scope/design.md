# Design: report-thread-scope（focal 子树作用域）

## 1. 语义定义

设 `N = thread.posts`（服务端返回的整棵 root 会话节点集），`focal` 为当前页焦点节点。

- **祖先链** `A(focal)`：从 `focal.parent_id` 起沿 `parent_id` 上溯、在 `N` 内可解析的链
  （现状 `ancestorChain`，`ThreadPage.tsx:752-763`）。
- **focal 子树** `D(focal)`：`N` 中沿 `parent_id` 从 `focal` 可达的全部后代（不含 focal）。
- **渲染作用域**：
  - 行集合 = 可见祖先链（root → parent，>20 条裁剪）+ focal + `D(focal)`；
  - `rest = unresolvedGap ? [] : D(focal)`，按 `(created_at, seq, id)` 升序平铺；
  - `focal.parent_id === null`（focal 是 root）时 `rest` 直接取「其余全部节点」——与修复前
    逐节点一致，并保留 `assembleThread` 特意补渲染的 orphan 占位（parent_id 不在 posts 里、
    但同属该 root 的节点）。

兄弟分支（`D(root) \ ({focal} ∪ A(focal) ∪ D(focal))`）**不进入本页**。

## 2. 接入点（path:line，实现前实测）

| 位置 | 现状 | 本 change |
|------|------|-----------|
| `src/ui/pages/ThreadPage.tsx:93-212` | 内联 `buildTimelinePlan` | 机械搬移到 `src/ui/lib/thread-plan.ts`，逻辑仅改 `rest` 计算 |
| `src/ui/pages/ThreadPage.tsx:182-185` | `rest = nodes.filter(n => n.id !== focal.id && !ancestorSet.has(n.id))` | `rest = unresolvedGap ? [] : descendantsOf(focal)` |
| `src/ui/pages/ThreadPage.tsx:752-763` | `ancestorChain` 沿 parent 上溯 | 不变 |
| `src/ui/pages/ThreadPage.tsx:773-793` | `deepGap` / `unresolvedGap` / `plan` useMemo | 不变（入参同名同义） |
| `src/server/store.ts:1429-1475` | 按 `root_id` 返回整棵会话 | 不变（非目标） |
| `src/core/thread.ts:166-214` | `maxDepth` 裁剪 + `collapsed` 折叠组 | 不变（>maxDepth 后代仍以子线程入口表达） |
| `src/ui/pages/NotificationsPage.tsx:192` | 通知点击 `navigate('/p/<targetId>')` | 不变（深链入口） |

## 3. 后代集算法

一次性由 `nodes` 建 `childrenByParent: Map<string, ThreadNode[]>`（`parent_id` 为键），再从
`focal.id` 做 BFS 收集后代；`seen` 集合防环（脏数据 `parent_id` 成环时不重复、不死循环）。
复杂度 `O(|N|)`，与现状 filter 同阶。focal 为 root 时走「其余全部节点」快路径（见 §1），
不经过 BFS——保证 root 页（含 orphan 占位）与修复前完全一致。

不使用 `depth` 字段判断作用域：`depth` 只表示 root 深度，兄弟分支与 focal 子树会重叠
（例如 focal 的兄弟也在 depth 3）；唯一可靠判据是 `parent_id` 链。

## 4. 保留语义清单（实现必须逐项保持）

1. `unresolvedGap`：`rest=[]`，只渲染缺口行 + focal（不可定位节点不得平铺）。
2. `deepGap`：focal 不在 `posts`（合成 focal）时，focal 行不生成指向自己的子线程入口；
   后代集仍从 `focal.id` 计算（若 posts 中含其子节点则显示）。
3. 祖先 >20：只渲染最近 20 条，缺口行跳「被丢弃的最后一条祖先」的 `id`（不是 `parent_id`）。
4. `unloadedCount` = `collapsed` 优先，否则 `child_count - loadedDirect`；子线程入口附在父行后。
5. `compact`：`is_self_continuation && parent_id === prevPost.id`；`compactHeader` 同现状。
6. `replyingTo`：父帖不是上一 post 行时显示 `reply_to_account_id ?? nodeMap(parent).author ?? parentId`；
   focal/祖先恒 `null`。
7. 排序：`(created_at, seq, id)` 升序；不按 depth 分组。
8. 锚定/导轨/骨架/转场：行几何与 `data-*` 不变。
9. **新回复胶囊**：`added = countAddedInScope(prevPlan, nextPlan)`；
   `nextPlan = planForThreadView(next, postId, focalRef)`，`prevPlan` 取当前渲染 `planRef`
   （缺失时由当前 `ThreadView` 重建）。`added === 0` 不设 `pendingThread/newReplyCount`；
   种子窗口（`loadedRef === false`）的静默结果属于初次完整线程，直接 `commitThread`，
   不计为新回复。
10. 胶囊计数 = `nextPlan.replyNodes` 差集 + focal/其后代节点的子线程入口计数净增量
   （折叠/超 maxDepth 的新回复同口径）；祖先链的增长可能来自兄弟分支，不计入。
11. **陈旧缓存/跨页竞态**：`freshRef` 按路由失效、完整线程真正提交（含转场 flush）后置真；
   静默差集要求 `freshRef && current.focal_id === next.focal_id && current.root_id ===
   next.root_id`；`load` 落地前校验 `pageIdRef`（页面身份），held 结果记录所属页并在 flush
   时丢弃跨页结果 + 清空 pending/newReplyCount。陈旧缓存与种子上的静默结果直接
   `commitThread`（新回复立即可见、无胶囊）。

## 4.2 陈旧缓存导航（二轮审查 P1）

复现：首访 root（进缓存）→ hash 去 focal → 在 focal 页期间给兄弟分支与 focal 子树各回 1 条
（root 已卸载，缓存陈旧）→ hash 回 root / `history.back()`。旧实现 `loaded=true`（陈旧缓存也
算已加载）+ 视口转场持有非静默提交 + 静默 catch-up 以陈旧 plan 为基线 → 「2 条新回复」胶囊
持续存在；点击后行集合不变（页面其实已显示 7/9 行）。

修法：

| 机制 | 作用 |
|------|------|
| `freshRef` | 路由切换置 false；只有完整线程提交（非静默/初次/转场 flush）置 true |
| `pageIdRef` | `load` 迟到结果与 held 结果的页面身份；跨页直接丢弃 |
| `heldPageId` | held 结果所属页；flush 时 `heldPageId !== pageIdRef` 不提交 |
| 同页校验 | 静默差集要求 `current.focal_id === next.focal_id` 且 `root_id` 相同 |
| flush 清胶囊 | 完整线程落地时 `setPendingThread(null)/setNewReplyCount(0)` |
| `threadRef` 同步写 | 关闭 `setThread → render` 的静默窗口，差集基线不落后 |

E2E P3（无 pointer 预取）：hash 导航、`history.back()`、通知页点击旧通知行三条路径进入陈旧
缓存线程，断言「新回复可见 + 0 胶囊」；P2 的 pointer 点击路径仍保留（祖先逃生语义）。
E2E P4（真 seed）：B1 无任何线程缓存，只能由 `postIndex` 合成单帖 seed；用 `page.route` 同时
挂起初始 load 与静默补拉，再按「先静默、后初始」放行，配合 MutationObserver 断言全程
（含瞬时）无胶囊；该用例对 `freshRef` 门槛做变异验证（移除门槛 → 2 条断言红）。

## 4.1 新回复胶囊的作用域差集（审查 P1）

原实现 `added = next.posts.filter(!known)` 按整棵 root 计数：scope 收敛后，深链页收到兄弟分支
新回复会出现「1 条新回复」胶囊，点击后 DOM 行集合不变（复核实测）。

修法（`src/ui/lib/thread-plan.ts`）：

- `planForThreadView(view, postId, focalFallback)`：由网络返回的 `ThreadView` 构建 planner 输出，
  焦点优先取 `posts`，深链超 `maxDepth` 回退合成 focal；`loaded=true`。
- `countAddedInScope(prev, next)`：
  - `next.replyNodes` 与 `prev.replyNodes` 的差集（本页会渲染的新行）；
  - `next` 中 focal/其后代节点的 `subthread` 入口计数净增量（折叠/超深度新回复）；
  - 兄弟分支节点不在 scope 内，恒不计数。
- 副作用修正：导航到只有焦点帖种子的页面时，静默补拉不再把「种子 → 完整线程」误报为一批
  新回复（`loadedRef` 门）。

E2E：`scripts/qa/thread-scope.mjs` P1-①②③（兄弟分支不提示 / focal 子树提示且可点开 /
B1→root 祖先逃生路径 + 幻影胶囊断言）。

## 5. 与 report-thread-timeline 的关系

`report-thread-timeline`（已归档 2026-11-08）定义「全平铺 timeline」与「平铺顺序与关系语义」，
其中「focal 之后的所有回复」在本 change 明确为 **focal 的后代**（而非 root 内其余全部节点）。
其余度量、导轨、锚定、子线程入口、缺口模式全部沿用，不重开。
本 change 是该 change 的作用域补丁（向后兼容：focal=root 时输出逐节点不变）。

## 6. 验收矩阵

| # | 夹具 | 断言 |
|---|------|------|
| A | root + 3 分支 A/C（各 1 条）+ 分支 B（focal 深 2 层，focal 下 2 条回复） | 深链页 `[data-timeline-row][data-post-id]` = 祖先链 + focal + focal 回复；A/C 文本 0 命中；A/C id 0 命中 |
| B | 同上，打开 root | root 页含 A/B/C 全部分支（节点 id 全集）；行为不变 |
| C | focal 下 2 个子分支（focal 回复 + 该回复的回复） | 两分支都在 focal 子树内，时间序正确；`replyingTo` 语义不变 |
| D | unresolvedGap（focal 父帖不在 posts） | 只缺口行 + focal，`rest=[]` |
| E | 祖先 >20（单测） | 只渲染最近 20 条 + 缺口行跳被丢弃的最后一条祖先 |
| F | 既有 timeline 断言 | 锚定贴顶 ±2px、导轨 1px 相接、无 console error、两视口无横向溢出 |

## 7. 风险与回滚

- 风险：祖先行的 `unloadedCount` 仍按「全部已加载子节点」计数，被隐藏的兄弟分支不会让
  祖先多出「查看该子线程」入口——与现状一致，不新增噪音；若未来需要「兄弟分支入口」，
  另立 change。
- 回滚：单文件级——`rest` 一行改回 `nodes.filter(...)` 即恢复旧行为；planner 抽离本身
  不改变任何输出（单测同时锁旧语义）。

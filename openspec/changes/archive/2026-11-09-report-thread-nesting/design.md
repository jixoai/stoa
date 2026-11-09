# Design: report-thread-nesting（先序（pre-order DFS）渲染序）

## §1 根因（实现前代码事实）

`src/ui/lib/thread-plan.ts:181-186`：

```ts
const rest = unresolvedGap
  ? []
  : focal.parent_id === null
    ? nodes.filter((node) => node.id !== focal.id && !ancestorSet.has(node.id))
    : collectFocalDescendants(focal, nodes, ancestorSet);
rest.sort(compareNodes);   // ← 全局时间序：父子被同级分支隔开
```

- `collectFocalDescendants`（`:74-98`）用 **BFS** 收集后代集合，随后整段 `sort(compareNodes)`：
  集合正确、顺序是全局时间。
- 例：focal 有子 `R2(t3)` 与 `M1(t4)`，`R2` 又有子 `R3(t5)`；全局时间序输出
  `R2, M1, R3` —— `R3` 与父帖 `R2` 被 `M1` 隔开，页面上「这条回复在回谁」不可见。
- X 的语义：回复的回复直接展示在父帖下面（同一页）；DFS 先序正是这种「父子相邻」的展开。

## §2 算法（`thread-plan.ts` 纯函数，唯一 planner）

```
childrenByParent = group(nodes, parent_id)          // 忽略 parent_id === null
for each childList: childList.sort(compareNodes)    // (created_at, seq, id) 升序
seen = { focal.id }
stack = []

pushChildren(parentId):                             // 逆序入栈 ⇒ 弹出顺序＝升序
  for i = kids.length - 1 ... 0: stack.push(kids[i])

drain():
  while stack not empty:
    node = stack.pop()
    if seen.has(node.id): continue                  // 防环/防重复
    seen.add(node.id)
    if node.id ∉ ancestorSet: out.push(node)        // 祖先永不成行（脏数据成环时仍只跳过自身）
    pushChildren(node.id)                           // 先序：子节点紧接在自身之后处理

pushChildren(focal.id); drain()

if focal.parent_id === null:                        // root 页：不可达的 orphan 占位
  for node of nodes.filter(∉ seen ∪ {focal} ∪ ancestorSet).sort(compareNodes):
    stack.push(node); drain()                       // 作为独立子树先序追加
```

- **先序**：`pop` 后立刻把子节点压栈，子节点在栈顶，先于兄弟被处理；子树结束后才回到兄弟。
- **稳定性**：同一父节点下按 `(created_at, seq, id)` 升序；`compareNodes` 保持不变。
- **防环**：`seen` 集合；脏数据成环时每个 id 只成行一次（与旧实现同语义）。
- **root 页 orphan**：`assembleThread` 会补渲染父帖缺失的占位节点（`parent_id` 不在 `posts`），
  它们不在 focal 可达树里；按时间序作为独立子树追加在可达先序结果之后（`report-thread-scope`
  的「root 页渲染其余全部节点」不回归）。
- **`unresolvedGap`**：`rest=[]` 分支不变（不可定位节点不成行）。

## §3 与既有语义的关系（全部保持不变）

| 语义 | 实现位置 | 变化 |
| --- | --- | --- |
| 祖先链 root→parent + >20 裁剪 + 缺口行 | `buildTimelinePlan` 前半段 | 无 |
| focal 固定、focal 不跳转 | `ThreadPage.tsx` `onOpen={isFocal ? undefined : openPost}` | 无 |
| `compact` / `compactHeader` | `adjacent = prevPost.id === parent_id` | 语义不变；DFS 下自接子节点顺序紧跟父帖，紧凑链自然连续 |
| `replyingTo` | `parent_id !== prevPost.id` 时显示 | 语义不变；DFS 下只有「后一个兄弟子树的首行」显示「回复给 @x」 |
| 子线程入口 | `pushNode` 在行后追加 `subthread` 控制行 | 位置不变（紧跟其父行）；控制行不参与 `prevPost` 邻接判断 |
| `unresolvedGap` / `deepGap` | 既有分支 | 无 |
| 新回复胶囊 | `countAddedInScope`（集合差集，与顺序无关） | 无 |
| 锚定 / 滚动记忆 / 导轨 | `ThreadPage.tsx`（行几何，与顺序无关） | 无 |

`compact` 判定依赖「父帖就是上一 post 行」。DFS 后：

- 自接链 `A → S1 → S2`（每个都是上一个的唯一子节点）→ `S1` 紧邻 `A`、`S2` 紧邻 `S1`，
  紧凑行与 `compactHeader` 与旧行为一致。
- 某节点有多个子节点时，第二个及之后的子节点不再是「紧邻父」，按普通行渲染并显示
  「回复给 @x」——与 spec「被其他分支隔开时按普通回复行渲染」同义，只是隔开它的从「时间交错」
  变成「前一个兄弟的子树」。

## §4 深链 / 刷新 / 实时

- 深链：`ThreadPage` 的 `ancestorChain` 计算与 `buildTimelinePlan` 入参不变；只有 `rest` 的顺序变。
- 刷新/静默合并：`planForThreadView` 复用同一 planner；先序输出是 `thread.posts` 集合的确定函数，
  相同集合 ⇒ 相同顺序（除 `created_at/seq/id` 外不依赖输入数组顺序）。
- 新回复（`post.created`）：静默补拉后新行作为其父节点的较晚子节点，先序位置＝父节点子树内
  最后一个子节点块；若父节点是 focal（直接回复），则位于 focal 已加载子树之后、兄弟分支之前
  （不再排到整页末尾）。胶囊点击前的 pending 语义不变。

## §5 验收矩阵 A1–A10

| # | 断言 | 层 | 证据 |
| --- | --- | --- | --- |
| A1 | 直接子节点紧邻父：focal 后第一行是其最早子节点 | 单测 | `test/thread-plan.test.ts` |
| A2 | 孙节点紧跟子：`A→B→C` 输出 `A,B,C`（C 紧邻 B） | 单测 | 同上 |
| A3 | 兄弟在子树后：`A→B(t1), A→C(t2), B→D(t3)` ⇒ `B,D,C` | 单测 | 同上 |
| A4 | 多分支/多层混合先序（`R1→R2→R3` + `R1→M1` ⇒ `R2,R3,M1`） | 单测 + E2E | 同上；`thread-nesting.mjs` |
| A5 | 无子节点回复只输出自身 | 单测 | 同上 |
| A6 | 自接链 `compact/compactHeader` 保持（DFS 下相邻） | 单测 | 同上 |
| A7 | 排序稳定：同级 `(created_at, seq, id)` 升序、重复构建结果一致 | 单测 | 同上 |
| A8 | 深链 focal 页仍只含祖先链 + focal 子树（thread-scope 不回归） | 单测 + E2E | `thread-nesting.mjs`（S1 0 命中） |
| A9 | root 页全量先序（含 orphan 占位追加） | 单测 | 同上 |
| A9b | orphan 占位带后代 / 多个 orphan 根：各自作为独立子树先序追加 | 单测 | 同上 |
| A10 | E2E：UI 回复后新回复紧邻父节点块；点击非 focal 回复路由到 `#/p/<id>`；390/1280 两视口截图；深链/刷新顺序稳定 | E2E | `scripts/qa/thread-nesting.mjs` + `thread-timeline.mjs` 回归 |

## §6 E2E 夹具与步骤（`scripts/qa/thread-nesting.mjs`）

隔离后端 `qa-serve --no-seed`（只写 /tmp/report-qa-*，生产板 13689 零写入）。

夹具 N1（先序 + 作用域）：

```
root
├── R1                     ← 深链 focal（root 的子节点）
│   ├── R2                 ← 直接子节点（紧邻 R1）
│   │   └── R3             ← 孙节点（紧邻 R2）
│   └── M1                 ← R1 的第二个子节点（时间早于 R3）
└── S1                     ← 兄弟分支（R1 页不得出现）
```

创建顺序 `root → R1 → R2 → M1 → R3`，令全局时间序为 `R2,M1,R3`、先序为 `R2,R3,M1`。

1. 打开 `#/p/R1`：DOM `reply` 行 = `[R2, R3, M1]`（R2 紧邻 R1、R3 紧邻 R2、S1 0 命中）。
2. 在 R1 页通过 UI 回复（`reply-open` → `composer-input` → `reply-submit`）：
   新回复 N 是 R1 的第三个子节点 ⇒ DOM = `[R2,R3,M1,N]`；断言 N 在 R1 子树块内、
   `R1` 与 `N` 之间没有兄弟分支（S1 仍 0 命中）；改开 root 页断言 `R1,R2,R3,M1,N,S1`
   （N 在 S1 之前，不排到整页末尾）。
3. 点击非 focal 的 R2：`location.hash` 变为 `#/p/R2`；R2 页 DOM = `[R3]`（回复紧邻 focal）。
4. 点击 focal R1：hash 不变（不跳转）。
5. 两个视口（390×844 / 1280×900）各跑一遍 + 关键步骤截图 + 0 console error / 无横向溢出。

## §7 影响面与风险

- 单文件纯函数改动 + 测试；`ThreadPage` 零逻辑改动（如需仅改注释/import）。
- 风险：`thread-timeline.mjs`（F2 交错分支）与 `thread-scope.mjs`（DEEP_EXPECTED 深链顺序）
  的既有全局时间序断言会因语义升级而失败——按本 change 的先序语义更新期望（check 总数保持
  140 / 66），并在 tasks 记录这是**规格升级**而非回归。
- 无 DB/接口/部署变更；无迁移。

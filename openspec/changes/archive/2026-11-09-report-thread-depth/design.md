# Design: report-thread-depth（focal 路径/子树无条件，无关分支保留深度折叠）

## §1 根因（实现前代码事实）

`src/core/thread.ts`（实现前）：

- `assembleThread`：`const maxDepth = opts.maxDepth ?? 6;`（`:60`）。
- spine 发射（`:166-181`）：

  ```ts
  for (let idx = 0; idx < spine.length; idx++) {
    const post = spine[idx]!;
    if (idx > maxDepth) { spineTruncated = true; break; }
    emitNode(post, idx, true);
  }
  ```

  深链 focal 若在 spine 上（同作者自接链），第 `maxDepth+1` 个节点起整段截断；`emittedSpine`
  也随之截断，后续分支锚点不再遍历（`:196`）。

- 分支发射（`:183-193`）：

  ```ts
  const emitBranch = (post: T, depth: number) => {
    if (depth > maxDepth) {
      addCollapsed(post.parent_id ?? root.id, maxDepth, 1 + countDescendants(post.id));
      return;
    }
    ...
  };
  ```

  `depth > maxDepth` 时**不看身份**一律折叠：focal 的祖先、focal 自身、focal 的子树都在
  `countDescendants` 里被吞掉。Owner 实测 9–10 层线程只剩 9 个 posts、focal 与父帖缺席，
  前端合成 focal 后看不到 focal 的新回复。

## §2 算法（`assembleThread` 内纯集合判定）

新增两个集合，合称「无条件集合」：

```
focalPath   = 从 focal 沿 parent_id 上行到 root 的链（含 focal；seen 防环）
focalSubtree = 从 focal 沿 children 下行可达的全部后代（含 focal；seen 防环）
mustEmit(id) = focalPath.has(id) || focalSubtree.has(id)
```

- focal 不存在于本次 posts（例如调用方传了范围外的 `focalId`）时两集合为空，行为与修复前一致。
- **祖先链**：focalPath 是一条 root→focal 的链；spine 与 focalPath 在树中共享从 root 开始的
  连续前缀，因此「在 focalPath 上的 spine 节点」总是 spine 的前缀。spine 循环只在
  `idx > maxDepth && !mustEmit(post.id)` 时截断——该截断点之后不会再有必须发射的 spine 节点。

发射规则：

1. **spine**：`idx <= maxDepth || mustEmit` 的节点全部发射；首個被截断处把「剩余 spine 节点数」
   记为一个折叠组 `{ parent_id: 最后发射的 spine 节点, depth: 其 depth, count: 剩余 }`。
2. **分支**：`depth <= maxDepth || mustEmit` 的节点发射并继续递归；否则
   `addCollapsed(parent, depth - 1, 1 + countDescendants)`。
   - 非 mustEmit 节点不可能含有 mustEmit 后代：若后代在 focalPath 上则该节点也是 focal 祖先；
     若后代在 focalSubtree 内则该节点也在 focal 子树内。故 `countDescendants` 不会把 focal
     路径/子树算进折叠组。
3. **分支锚点**：使用「实际发射的 spine 节点」而不是 `spine.slice(0, maxDepth+1)`，深链 focal
   落在深 spine 节点分支下时仍能遍历到。
4. **孤儿兜底**：`parentMissing` 的节点仍按 `emitBranch(post, min(maxDepth, 1))` 补渲染；
   mustEmit 条件使其在深链下也能完整展开 focal 链。

## §3 排序 / spine / 折叠语义（保持不变）

| 语义 | 变化 |
| --- | --- |
| spine 选择（同作者 + 同 self_thread，优先通向 focal） | 无 |
| spine 先整链、再按锚点展开分支（自接链置顶） | 无 |
| 同级排序 `(created_at, id)`（时间相同按 id） | 无 |
| `i` / `n` 仅在 spine 完整且长度 ≥2 时下发 | 无 |
| `collapsed.count` = 被折叠子树节点总数（含根） | 无 |
| `collapsed.parent_id` = 折叠点的父节点 | 无 |
| `collapsed.depth` | 由固定 `maxDepth` 改为「父节点实际 depth」（普通分支等价，深链锚点下更准确） |
| orphan / 缺父帖补渲染 | 无（仅叠加 mustEmit 的无条件发射） |

## §4 默认 `maxDepth` 24

- 深链 focal 的正确性不依赖默认值（祖先链/focal 子树无条件）；默认值只保护无关分支的响应体积。
- 6 层对真实会话过浅（Owner 实测 9–10 层），提高到 **24**：普通分支仍可读，响应仍以整棵会话
  一次查询为上限（无 N+1），无分页接口变更。
- 显式传入 `maxDepth` 的调用/测试语义不变（显式值优先）。

## §5 验收矩阵 A1–A9

| # | 断言 | 层 | 证据 |
| --- | --- | --- | --- |
| A1 | 20 层交替作者链、focal 第 19 层 + 1 子回复，`maxDepth: 6` 下 posts 含全部 21 个路径节点与子回复，`collapsed` 为空 | 单测 | `test/thread.test.ts` |
| A2 | 无关 30 层分支仍按 `maxDepth` 折叠；折叠组不含 focal 路径/子树 | 单测 | 同上 |
| A3 | 默认 `maxDepth: 24`：无关 30 层分支只发射 depth 0..24，余下折叠计数正确 | 单测 | 同上 |
| A4 | 深链 focal 的兄弟分支（非 focal 祖先/后代）不随 focal 无条件发射，仍按上限折叠 | 单测 | 同上 |
| A5 | 深链 focal 在 spine 上（同作者自接链）：整链发射、`i/n` 保持 | 单测 | 同上 |
| A6 | orphan / 缺父帖语义不变（补渲染位置与计数） | 单测 | 同上 |
| A7 | `GET /api/thread/<focal>`：12 层线程 + 对 focal 的回复，posts 含 root→focal 全链、focal 与新回复 | 集成 | `test/thread-depth-http.test.ts` |
| A8 | 隔离后端（`qa-serve --no-seed`）同 A7 的 12 层夹具 + 新回复断言 | E2E/API | `scripts/qa/thread-nesting.mjs` |
| A9 | 现有 thread/thread-plan/store 测试与 `bun test` 全绿；check/typecheck/typecheck:ui/build 全绿 | 绿门 | 命令输出 |

## §6 E2E 夹具（`scripts/qa/thread-nesting.mjs` 新增 API 段）

```
root(A)
├── L1(B) → L2(A) → … → L11(focal, depth 11)   ← 交替作者链
│                          └── NEW            ← 对 focal 的直接回复
└── U1 → U2 → … → U30                          ← 无关 30 层分支
```

1. 逐个 `POST /api/posts/:parent/replies` 建链（隔离后端，生产板 13689 零写入）。
2. `GET /api/thread/<focal>?focal=<focal>`：
   - `posts` 含 `{root, L1..L11, NEW}`，focal `depth=11`；
   - 无关分支只到 `maxDepth=24`：U1..U24 在、U25..U30 不在，`collapsed` 恰为
     `{parent_id: U24, depth: 24, count: 6}`；
   - `collapsed` 的 `parent_id` 不在 focal 路径/子树内。
3. 对 focal 新回复使 NEW 进入 focal 子树；断言其随 `posts` 返回。

## §7 风险

- `maxDepth` 6 → 24 会改变「深无关分支」的返回体积（仍是一次全会话查询）；需要折叠的用户仍可
  通过 `collapsed` 子线程入口下钻，无接口变化。
- `collapsed.depth` 由固定值改为父节点实际 depth：UI 只按 `parent_id` 计数，无视觉影响；单测
  断言按新语义记录。
- 深链 focal 的 `posts` 可能超过前端「祖先 >20」裁剪阈值：UI 既有裁剪规则保持不变（保留最近 20
  条祖先 + 缺口行），不影响 focal 与子树。

# Proposal: report-thread-depth（深链 focal 的祖先链与子树无条件返回）

## 背景（Owner 实测，2026-11-07）

线程 `01M6XTMRGJ9WDTHP8RZD34HG3R`（root `01M6XDQ0CWGE1CRBCC36QQENN6`）已嵌套到 9–10 层。
`GET /api/thread/<focal>` 只返回 9 个 posts，**focal 与其父帖都不在 posts 里**；前端只能把 focal
合成一行（deepGap），新回复因此不可见（`thread.posts` 里没有 focal 的子树）。

根因（`src/core/thread.ts`）：

- `assembleThread` 的 `maxDepth` 默认 6，spine 与 branch 两条发射路径都以 `depth > maxDepth`
  为唯一条件折叠；
- `emitBranch` 对 `depth > maxDepth` 的节点直接 `addCollapsed` 并停止递归，**不区分该节点是否在
  focal 的祖先链上、是否在 focal 子树内**；
- spine 链路同样在第 `maxDepth+1` 个节点截断，`emittedSpine` 后续的分支锚点不再遍历。
  结果：深链 focal 自身、focal 的全部祖先与 focal 的全部后代一起被折叠，前端无从渲染。

## 目标语义

1. **focal 的祖先链（root → … → parent）无条件完整返回**：不受 `maxDepth` 限制，且 SHALL NOT
   计入任何折叠组（`collapsed`）。
2. **focal 子树（focal 的全部后代）无条件完整返回**：同样不受 `maxDepth` 限制、不计入折叠组；
   focal 自身 SHALL 出现在 `posts` 里。
3. **无关分支保留深度折叠**：既不是 focal 祖先、也不在 focal 子树内的分支仍按 `maxDepth`
   折叠为「继续 N 层回复」，折叠组语义（`parent_id`/`depth`/`count`）不变。
4. **排序/结构不变**：仍先发 spine 链、再按 spine 锚点展开分支；同级按 `(created_at, id)`；
   `spine` 的 `i/n` 语义不变（spine 完整才下发）。
5. **默认 `maxDepth` 提高到 24**：作为普通分支的保护上限（深链 focal 仍无条件完整）。
6. **接口与类型不变**：`thread()` 入参、`ThreadView` 字段、HTTP 契约零改动；前端 deepGap 兜底
   保留（旧数据/缺父帖仍可用）。

## 影响面

- 服务端核心：`src/core/thread.ts`（`assembleThread` 增加「focal 路径 + focal 子树」无条件集合；
  spine/分支发射条件改为 `depth > maxDepth && !mustEmit`；默认值 6 → 24）。
- 测试：`test/thread.test.ts` 增补深链/无关分支/兄弟/孤儿用例；新增 HTTP 集成用例断言
  `GET /api/thread/<focal>` 在 12 层深链下仍含 focal 与新直接回复。
- QA：`scripts/qa/thread-nesting.mjs` 增补深链 API 用例（隔离 `qa-serve --no-seed`）。
- 规格：`openspec/specs/report-thread-model`「线程组装（spine + 分支）」与
  `openspec/specs/report-surface`「深树祖先一次渲染」「focal 缺失的深链回退」。
- 无 DB/迁移/依赖/前端 planner 改动；生产板 13689 零写入。

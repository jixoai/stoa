# Tasks: report-thread-timeline

> **状态（2026-11-08 终审）**：P0 设计与 P1 实现均已完成；依赖 change
> `report-notification-history-and-reply-submit` 已合入（`markPostRead` 保留），
> `report-event-hub` 的并发改动未触碰本 change 的文件。每项判据不满足不得勾选；
> P1 的勾选证据见各项「证据」行（QA 编号 / 命令 / 截图目录）。**尚未 commit**。

## P0. 设计（本 change 的当前交付）

- [x] P0-1. 只读复现 13689 现状：初始 focal 顶边 49px、点击「3 条上文」后 focal 跳到
  1803.67px（390×844）/ 1309.61px（1280×900）、展开后最大 scrollTop 1473/817 导致 focal
  无法贴顶（330.67/492.61）、祖先单条最高 1344px、无祖先/焦点/回复导轨。
- [x] P0-2. 隔离后端复现深树缺陷：9 层链（focal depth 8）→ `/api/read?thread=` 只返回
  depth 0..6、focal 不在 posts、`spine_complete=true`、`collapsed=[{count:2}]`；UI 会永久骨架。
- [x] P0-3. `design.md` v1 给出 timeline 行序、导轨几何、tail spacer、锚定/返回、深树回退。
- [x] P0-4. `npx openspec validate report-thread-timeline --strict` 通过。
- [x] P0-5. **Owner 2026-11-08 追加破坏性裁决：彻底删除回复缩进**。`design.md` v2 更新为
  全平铺 timeline：所有回复与 focal/祖先同一条 46px 头像列（24px 自接链头像同轴居中，中心 39）、
  同一条 trunk；`marginLeft=0`、`padding-left` 无阶梯；删除 `collapse-depth`/`expand-branch`/
  「继续 N 层回复」；后端折叠/未加载子树上改为「查看该子线程」导航入口；回复按
  `(created_at, seq, id)` 平铺；关系用「回复给 @x」+ 导轨表达。
- [x] P0-6. `specs/report-surface/spec.md` 同步：MODIFIED「详情页阅读」「自接线程与多人对话的
  渲染」「焦点锚点确定性」「骨架到内容的有动画交接」；ADDED「平铺回复 timeline（禁止缩进表达
  层级）」「平铺顺序与关系语义」「时间线主轨连续性」「focal 顶部导轨 stub」「timeline 初始锚定」
  「线程返回滚动位置恢复」「深树祖先一次渲染」「focal 缺失的深链回退」。

## P1. 实现（终审 v3 已落地；证据见括号内 QA 断言号）

- [x] P1-1. `ThreadPage.tsx` 平铺 planner：删除 `indent`/`childIndent`/`maxDepth`/`extraDepth`/
  `expandedBranches`；祖先 `reverse()` → focal → 其余节点按 `(created_at, seq, id)` 升序；
  所有行全宽、无 `marginLeft`；删除祖先 Card 与「N 条回复」分隔行。
  - 判据：`[data-timeline-row="reply"]` 的 `marginLeft === "0px"`；所有 post 行
    `padding-left === "16px"`；DOM 回复顺序 = 升序排序。
  - 证据：QA #6（`rows=3 values=0px` / `values=16px`）、#10（dom 顺序 = expected）。
- [x] P1-2. 祖先行度量：`variant="ancestor"` 46px 头像 + focal 字号/全文；focal footer 保留
  fullTime 并追加 `· focal.reply_count 条回复`；`回复给 @x` 对相邻祖先/focal 不显示。
  - 判据：祖先与 focal 的头像中心差 ≤1px；祖先正文不被 clamp。
  - 证据：QA #7（`n=9 maxΔ=0.00`）、V4（`17/25`）、V1（footer 文字 68 且不压导轨）。
- [x] P1-3. `TimelineRow` + trunk 导轨：全宽包裹层、`relative`；带头像行两段
  `[data-testid="thread-rail"]`（`left-[38px] w-0.5 bg-thread-rail`，top 0..avatarTop /
  avatarBottom..bottom）；`[data-shared-avatar]` 补 `relative z-[1]`；focal top 段带
  `data-testid="thread-rail-stub"`；控制行非末行贯穿、**末行不画**。
  - 判据：相邻段 `|prev.bottom - next.top| ≤1px`、left/width ≤1px；所有头像中心 39±1；
    focal 贴顶时 stub 高**精确等于** `avatar.top - container.top`（22px）。
  - 证据：QA #13（`maxV=1.00 maxL=0 maxW=0`）、#12（`leftRel=38`）、#14
    （`height=22.0 avatarΔ=22.0 visible=22.0`）、V3（末行控制行 DOM 导轨数 0）。
- [x] P1-4. 初始锚定：删除 `offset - 60` 与 `scrollMarginTop`；`useLayoutEffect` 按
  `F = focal.offsetTop`、`spacer = target + V - contentHeight`、`scrollTop = round(F)`；
  容器 `overflow-anchor:none`；resize 重算。
  - 判据：进入后 `focal.top - container.top ∈ [-2,2]`；`scrollTop === F`（±1）；最大 scrollTop ≥ F。
  - 证据：QA #2（`delta=0.05 scrollTop=1864.0`）、#17（深链 `delta=0.00 scrollTop=81`）。
- [x] P1-5. 数据晚到不抖：种子→完整线程 commit 后同帧重算；用户首次
  wheel/touch/pointer/key 后解锁；外层 `ContentSwap` 传 `animateHeight={false}`。
  - 判据：延迟 `/api/thread/**` 的 rAF 采样 `focalTop` 极差 ≤2px；无 >4px 跳变。
  - 证据：QA #5（60 帧 `min=max=0.05 range=0.00 maxJump=0.00`）、#19（reduced 30 帧 0.05）。
- [x] P1-6. 返回恢复：`scroll-memory.ts` 线程 sessionStorage 记忆（`anchorId/offsetPx/scrollTop`，
  跳过 subthread 入口）；`direction === "back"` 时经 `scrollToTarget`（补 spacer）恢复。
  - 判据：A 滚到第 2 条祖先 → 进 B → back：首可见行/偏移 ±2px，不被拉回 focal。
  - 证据：QA #16（`-95.0 → -95.0 restored`）、C（解锁后合并 `-95.0 → -95.0`）。
- [x] P1-7. 新回复胶囊：移到滚动容器右上 overlay（不占布局高度）；`mergePending`/`newReplyCount` 不变。
  - 判据：胶囊出现/点击后焦点位置不变。
  - 证据：QA C（点击胶囊合并后首可见行/偏移不变 + 新回复文本进 DOM）。
- [x] P1-8. 深树回退：`unresolvedGap = focal.parent_id 不在 posts`；`client.post(postId)` 合成 focal；
  `unresolvedGap` 只渲染「缺口行 + focal」（不可定位节点不渲染），父帖可解析时走正常祖先链。
  - 判据：9 层深链 focal 存在、不永久骨架；缺口行可导航；不伪装/不平铺不可定位节点。
  - 证据：QA #17（`delta=0.00`、`gapBottomΔ=0.0`、文案「更早的回复未加载」、可导航）、
    B1（`replies=0 rows=context-gap→focal`、`posts=7 gapTarget=mix[6]`）、B1b（`ancestors=7 gap=0`）。
- [x] P1-9. 平铺关系语义：`prevPost` → 「回复给 @x」；连续同作者父子紧凑呈现；自接链 24px 头像
  与普通行同轴（中心 39，gutter 17）、`px-4` 不变；删除 `ChainPosition`/子轨。
  - 判据：紧凑行头像中心 39±1、`padding-left === "16px"`；无第二根导轨；非相邻父帖显示「回复给 @x」。
  - 证据：QA #12（`widths=24,24 heights=71,46 centers=39,39,39,39`、行内后缀 `· 2/3`）、#11。
- [x] P1-10. 删除层级控件：`collapse-depth`/`expand-branch`/「继续 N 层回复」/`extraDepth`/
  `expandedBranches` 全删；折叠/未加载子树 → `kind="subthread"` 入口（`data-testid="subthread-entry"`，
  点击 `navigate("/p/<nodeId>")`，每节点最多一条）。
  - 判据：无层级控件文案/testid；入口点击后 hash = `/p/<nodeId>`；当前页不增加隐藏行。
  - 证据：QA #8、#9（`查看该子线程 · 2 条回复`、`dom=3 expected=3`、hash 精确）、V3。
- [x] P1-11. `scripts/qa/thread-timeline.mjs`：隔离后端夹具（5 祖先含删除+长正文、交错分支、
  4 层多人对话、连续自接链 + 普通回复、9 层深链、混合作者深链、种子长列表）+ 70 条断言/视口 +
  390×844/1280×900 + 截图与 `report.json`。
  - 判据：`bun scripts/qa/thread-timeline.mjs` 全 PASS。
  - 证据：**140/140 PASS**；截图落 `src/ui/.qa/thread-timeline/`（8 组×2 视口 + report.json；
    目录被 `src/ui/.qa/.gitignore` 忽略）。偏离原计划：未生成 `.agents/reports/**/report.html`
    （Owner 2026-11-08 明确要求截图落 `src/ui/.qa/thread-timeline/`）。
- [x] P1-12. 回归：`bun test`、`bun run check`、`bun run typecheck:ui`；`overlay-back`/
  `notifications-read`/`reply-composer` 全绿；共享元素与 0 console error。
  - 判据：0 console error、390 宽无横向溢出、`vt-avatar-*`/`vt-author-*` 仍形变。
  - 证据：`bun test` 158 pass / 0 fail（并发负载下 lease.test.ts 偶发 1 fail，单跑 3/3）、
    `check` passed + ui-lint 0、`typecheck:ui` 0 error；QA #20（无溢出、三上下文 console error=0）、
    #18（vt 组含 width/height/transform）；overlay-back 20/20、notifications-read 13/13、
    reply-composer 30/30（回复计数数值 +1）。

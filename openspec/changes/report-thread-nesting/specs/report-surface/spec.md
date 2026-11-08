# report-surface（delta）

## MODIFIED Requirements

### Requirement: 平铺顺序与关系语义

focal 之后的所有回复 SHALL 按**父子相邻的先序（pre-order DFS）**稳定平铺（祖先链与 focal 固定
在最上方）：遍历某个节点的子节点时 SHALL 按 `(created_at, seq, id)` 升序，每条 SHALL 先输出自身、
紧接着递归输出它自己的子树（同样按 `(created_at, seq, id)` 升序），子树结束后再继续同级的下一条；
没有子节点的回复 SHALL 只输出自身。SHALL NOT 使用「先收集后代集合、再整段按时间排序」的全局
时间序；SHALL NOT 按深度分组或把自接链整链置顶；SHALL NOT 恢复缩进或引入层级控件（视觉仍是
单一平面、同一头像列、同一条主轨）。**回复集合 SHALL 等于 focal 的后代**（沿 `parent_id` 从 focal
可达、排除 focal 与祖先链），SHALL NOT 包含同根兄弟分支（细则见「详情页作用域＝focal 子树」）；
focal 为 root 时该集合等于其余全部节点（父帖缺失的 orphan 占位 SHALL 追加在可达先序结果之后，
按 `(created_at, seq, id)` 升序）。**例外（unresolvedGap）**：`focal.parent_id` 解析不到时 SHALL NOT
平铺任何不可定位节点（只留缺口行 + focal，见「focal 缺失的深链回退」）。
每一条 post 行 SHALL 与上一条 post 行比较：若父帖不是上一 post 行（`parent_id !== prevPost.id`），
SHALL 显示「回复给 @parentAuthor」；若父帖就是上一行，SHALL NOT 显示。`is_self_continuation` 的
紧凑呈现 SHALL 只用于「父帖就是上一 post 行」的连续同作者行；被其他子树隔开时 SHALL 按普通回复行
渲染。页面 MAY 额外显示「root 内路径」小标签，但 SHALL NOT 引入视觉缩进。子线程入口 SHALL 附着在
其父 post 行之后，不参与先序排序，也不参与头像列断言。

#### Scenario: 先序展开（子节点紧邻父）

- **WHEN** 打开一个包含 `A→B(t1)`、`A→C(t2)`、`B→D(t3)` 的 root
- **THEN** focal 之后 DOM 中回复行的 `data-post-id` 顺序为 B、D、C（B 的子树 D 结束后才回到 C），
  不按全局时间序排成 B、C、D

#### Scenario: 回复的回复紧邻其父

- **WHEN** 一条回复 R2 有子回复 R3，且 R2 之后还有同级回复 M1（时间晚于 R2、早于 R3）
- **THEN** DOM 顺序为 R2、R3、M1：R3 紧邻 R2 呈现（不需要进入另一页），M1 在 R2 子树结束后继续；
  R3 的 `parent_id` 等于 R2 的 id 且两行之间没有其他 post 行

#### Scenario: 时间序平铺

- **WHEN** 打开一个包含同级回复 B(t1)、C(t2) 且 B 有子回复 D(t3) 的 root
- **THEN** 同一父节点下的同级顺序仍按 `(created_at, seq, id)` 升序（B 在 C 之前）；但 B 的子树
  D 在 C 之前输出完（先序），同级之间不再按全局时间穿插

#### Scenario: 深链到 B 时只平铺 B 的子树

- **WHEN** 深链 focal 是 A→B 分支中的一个节点，C/E 是 A 下的另一分支
- **THEN** focal 之后只出现 B 的后代（按先序展开）；C/E 不出现在任何 post 行；点击祖先行 A
  进入 A 自己的详情后才可见 C/E 分支

#### Scenario: 多分支先序稳定

- **WHEN** focal 有两个子节点，第一个子节点自身还有两条回复，第二个子节点还有一条回复
- **THEN** 输出顺序 = 子1 → 子1的所有后代（各自子树先序）→ 子2 → 子2的后代；同级节点之间按
  `(created_at, seq, id)` 升序，重复构建/刷新后顺序一致

#### Scenario: 无子节点只输出自身

- **WHEN** 一条回复没有任何子回复
- **THEN** 它在 DOM 中只有一行，其后直接跟同级的下一条（或页面结束），不产生空占位/空入口

#### Scenario: 回复给 @x

- **WHEN** 一条回复的父帖不是它的上一 post 行（先序下即「前一个兄弟子树的首行」）
- **THEN** 该行显示「回复给 @parentAuthor」；若父帖就是上一行（祖先链、focal、首条回复、连续自接
  链），则不显示

#### Scenario: 自接链连续导轨

- **WHEN** 同作者连续续接的父子行（A→S1→S2）按先序相邻平铺
- **THEN** 三行共用同一条 2px trunk（x=38..40），相邻导轨段在 1px 内相接；S1/S2 用 24px 头像
  居中于 46px 列，头像中心 x 与 A 一致（39±1px，导轨从头像中心穿过），且不存在独立子轨

### Requirement: 详情页作用域＝focal 子树

详情页平铺区 SHALL 只渲染「可见祖先链 + focal + focal 的后代」；`focal` 的后代 SHALL 由
`thread.posts` 中沿 `parent_id` 从 focal 可达的节点确定（`seen` 防环），SHALL NOT 用 `depth`
或「不属于祖先链」推断。当 focal 是 root（`parent_id === null`）时，页面 SHALL 渲染其余全部节点
（含父帖缺失的 orphan 占位），并按「平铺顺序与关系语义」的先序展开（orphan 占位追加在可达先序
结果之后，仍按 `(created_at, seq, id)` 升序）。同根兄弟分支（既不是 focal 祖先、也不是 focal
后代）SHALL NOT 出现在本页任何 post 行或子线程入口中；用户 SHALL 通过点击祖先行（进入该祖先
自己的详情）或既有「查看该子线程 · N 条回复」入口进入兄弟分支。`unresolvedGap` 例外保持不变：
focal 的父帖不可解析时 SHALL 只渲染缺口行 + focal。

#### Scenario: 深链到回复不串入兄弟分支

- **WHEN** 打开一条位于分支 B 深层的回复（root 另有分支 A/C，各 1 条回复）
- **THEN** DOM 中 `[data-timeline-row][data-post-id]` 只含「root → … → parent → focal →
  focal 后代」；分支 A/C 的帖子 id 与正文文本 0 命中；页面不出现 A/C 的「查看该子线程」入口

#### Scenario: 打开 root 仍是整棵会话

- **WHEN** 打开该会话的 root 帖
- **THEN** A/B/C 三个分支的全部节点都出现在本页（节点 id 集合与修复前一致），顺序为先序展开：
  每个分支的父帖后紧跟它的子树，再继续同级分支

#### Scenario: focal 子树多分支全部保留

- **WHEN** focal 下有两条回复，其中一条还有自己的回复
- **THEN** 这两条回复及其后代都渲染在 focal 下方，不被裁剪；第一条回复自己的回复紧邻它呈现
  （先序），`compact` /「回复给 @x」语义与既有「平铺顺序与关系语义」一致

#### Scenario: 深链页的新回复紧邻父节点

- **WHEN** 在一条有子的 focal 页通过回复编辑器提交一条直接回复，线程刷新后重新构建 planner
- **THEN** 新回复出现在 focal 的子树块内（其父节点是 focal），且不排到兄弟分支之后；刷新或
  静默合并后顺序与首次构建一致

### Requirement: 自接线程与多人对话的渲染

**自接线程** SHALL 按父子相邻的先序（pre-order DFS，见「平铺顺序与关系语义」）平铺，SHALL NOT 再
整链置顶或分组；所有行 SHALL 使用与 focal/普通回复相同的 **46px 头像列（中心 x=39）**（24px 头像
SHALL 与普通行**同轴居中**，即中心 x=39、gutter≈17，SHALL NOT 用 `marginLeft`/indent/`padding-left`
缩进）；同一作者**连续续接**的相邻行 MAY 使用紧凑呈现（仅首条显示作者名/时间，其余只留头像 +
正文；编号 SHALL 只以正文行内后缀 `· i/n` 表达，SHALL NOT 另起 chip 行或角标；隐藏操作栏）；
被前一个兄弟的子树隔开（父帖不是上一 post 行）时 SHALL 按普通回复行渲染并显示「回复给 @x」；
连接线 SHALL 为 timeline 主轨（同一条 trunk，导轨从 compact 头像中心穿过），SHALL NOT 另画子轨。
**多人对话** SHALL 平铺：SHALL NOT 用一级/每级缩进表达层级，SHALL NOT 有 3 级封顶；所有回复与
focal/祖先同一头像列、同一 trunk；父关系 SHALL 由「回复给 @x」+ 先序（子节点紧跟父节点）+ 导轨
表达；后端折叠/未加载子树 SHALL 显示「查看该子线程 · N 条回复」入口并导航到该节点详情，SHALL NOT
内联展开；SHALL NOT 存在 `collapse-depth` / `expand-branch` /「继续 N 层回复」。

#### Scenario: 自接汇报可连续阅读

- **WHEN** 一个子代理把一份长汇报拆成 1 条根帖 + 4 条连续自回复
- **THEN** 5 条按先序相邻平铺（自接子节点紧跟父帖）、同一条头像列与同一条 trunk、无任何缩进；
  连续自回复用紧凑行（无重复作者名、显示 `1/5`…`5/5`）；其他回复在自接链子树结束后按同级时间
  继续，不被整链置顶、也不穿插打断自接链

#### Scenario: 兄弟回复不打断自接链

- **WHEN** 自接链 A→S1→S2 之间还有一条同级他人回复 X（X 的创建时间晚于 S1、早于 S2）
- **THEN** 先序输出 A、S1、S2、X：S2 仍紧邻 S1 并使用紧凑行，X 在自接链子树结束后继续并显示
  「回复给 @x」；不得按全局时间排成 A、S1、X、S2

#### Scenario: 深层多人对话不压扁

- **WHEN** 一条会话的回复嵌套到第 4 层
- **THEN** 所有层级都平铺在同一头像列、同一导轨，不缩进、不折叠、不显示「继续 N 层回复」；
  父关系由「回复给 @x」+ 先序（子节点紧跟父节点）+ 连续导轨表达，窄屏仍可读

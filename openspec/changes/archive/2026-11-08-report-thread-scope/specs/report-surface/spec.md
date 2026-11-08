# report-surface（delta）

## ADDED Requirements

### Requirement: 详情页作用域＝focal 子树

详情页平铺区 SHALL 只渲染「可见祖先链 + focal + focal 的后代」；`focal` 的后代 SHALL 由
`thread.posts` 中沿 `parent_id` 从 focal 可达的节点确定（`seen` 防环），SHALL NOT 用 `depth`
或「不属于祖先链」推断。当 focal 是 root（`parent_id === null`）时，页面 SHALL 渲染其余全部节点
（含父帖缺失的 orphan 占位），与「平铺顺序与关系语义」的既有行为一致。同根兄弟分支（既不是 focal
祖先、也不是 focal 后代）SHALL NOT 出现在本页任何 post 行或子线程入口中；用户 SHALL 通过
点击祖先行（进入该祖先自己的详情）或既有「查看该子线程 · N 条回复」入口进入兄弟分支。
`unresolvedGap` 例外保持不变：focal 的父帖不可解析时 SHALL 只渲染缺口行 + focal。

#### Scenario: 深链到回复不串入兄弟分支

- **WHEN** 打开一条位于分支 B 深层的回复（root 另有分支 A/C，各 1 条回复）
- **THEN** DOM 中 `[data-timeline-row][data-post-id]` 只含「root → … → parent → focal →
  focal 后代」；分支 A/C 的帖子 id 与正文文本 0 命中；页面不出现 A/C 的「查看该子线程」入口

#### Scenario: 打开 root 仍是整棵会话

- **WHEN** 打开该会话的 root 帖
- **THEN** A/B/C 三个分支的全部节点都出现在本页（节点 id 集合与修复前一致），排序仍为
  `(created_at, seq, id)` 升序

#### Scenario: focal 子树多分支全部保留

- **WHEN** focal 下有两条回复，其中一条还有自己的回复
- **THEN** 这两条回复及其后代都渲染在 focal 下方，不被裁剪；`compact` /「回复给 @x」语义与
  既有「平铺顺序与关系语义」一致

### Requirement: 详情页新回复提示与作用域一致

静默刷新产生「N 条新回复」提示时，N SHALL 只统计本页作用域（focal 子树及其折叠子树）内的新增，
SHALL NOT 统计同根兄弟分支的新增；点击提示后 SHALL 至少有对应的新行或子线程入口变化可见。
种子（只有焦点帖）→ 完整线程的初次加载 SHALL NOT 计为新回复，SHALL NOT 产生幻影提示。

#### Scenario: 兄弟分支新回复不提示

- **WHEN** 深链页停在分支 B 的 focal，同根分支 A 收到新回复
- **THEN** 不出现「N 条新回复」胶囊，DOM 中 post 行集合不变

#### Scenario: focal 子树新回复可点开

- **WHEN** 深链页 focal 子树收到新回复
- **THEN** 出现胶囊且 N = 作用域内新增数；点击后新帖进入 DOM，兄弟分支新回复仍不出现

#### Scenario: 导航种子不产生幻影胶囊

- **WHEN** 从祖先页进入另一条帖子，首帧只有焦点帖种子、完整线程随后到达
- **THEN** 页面直接显示完整线程，不出现「N 条新回复」胶囊

#### Scenario: 陈旧缓存线程导航不产生幻影胶囊

- **WHEN** 某页此前已缓存完整线程，离开期间会话新增回复，用户通过 hash 导航、`history.back()`
  或通知进入该页（未经 pointer 预取）
- **THEN** 页面直接提交最新完整线程（新回复可见、行集合有变化），不出现「N 条新回复」胶囊；
  转场挂起的线程落地时旧的 pending 提示 SHALL 被清空

## MODIFIED Requirements

### Requirement: 平铺顺序与关系语义

focal 之后的所有回复 SHALL 按 `(created_at, seq, id)` 升序稳定平铺（祖先链与 focal 固定在最上方），
SHALL NOT 按深度分组或把自接链整链置顶。**回复集合 SHALL 等于 focal 的后代**（沿 `parent_id`
从 focal 可达、排除 focal 与祖先链），SHALL NOT 包含同根兄弟分支（细则见「详情页作用域＝focal
子树」）；focal 为 root 时该集合等于其余全部节点。**例外（unresolvedGap）**：`focal.parent_id`
解析不到时 SHALL NOT 平铺任何不可定位节点（只留缺口行 + focal，见「focal 缺失的深链回退」）。
每一条 post 行 SHALL 与上一条 post 行比较：若父帖不是上一
post 行（`parent_id !== prevPost.id`），SHALL 显示「回复给 @parentAuthor」；若父帖就是上一行，SHALL
NOT 显示。`is_self_continuation` 的紧凑呈现 SHALL 只用于「父帖就是上一 post 行」的连续同作者行；
被其他分支隔开时 SHALL 按普通回复行渲染。页面 MAY 额外显示「root 内路径」小标签，但 SHALL NOT
引入视觉缩进。子线程入口 SHALL 附着在其父 post 行之后，不参与时间排序，也不参与头像列断言。

#### Scenario: 时间序平铺

- **WHEN** 打开一个包含交错分支 A→B(t1)、A→C(t2)、B→D(t3)、C→E(t4) 的 root
- **THEN** focal 之后 DOM 中回复行的 `data-post-id` 顺序为 B、C、D、E（按 `(created_at, seq, id)`），
  不按深度分组、不把 B→D 缩进到 B 下

#### Scenario: 深链到 B 时只平铺 B 的子树

- **WHEN** 深链 focal 是 A→B 分支中的一个节点，C/E 是 A 下的另一分支
- **THEN** focal 之后只出现 B 的后代（按时间序）；C/E 不出现在任何 post 行；点击祖先行 A
  进入 A 自己的详情后才可见 C/E 分支

#### Scenario: 回复给 @x

- **WHEN** 一条回复的父帖不是它的上一 post 行
- **THEN** 该行显示「回复给 @parentAuthor」；若父帖就是上一行（祖先链、focal、首条回复、连续自接
  链），则不显示

#### Scenario: 自接链连续导轨

- **WHEN** 同作者连续续接的父子行（A→S1→S2）按时间相邻平铺
- **THEN** 三行共用同一条 2px trunk（x=38..40），相邻导轨段在 1px 内相接；S1/S2 用 24px 头像
  居中于 46px 列，头像中心 x 与 A 一致（39±1px，导轨从头像中心穿过），且不存在独立子轨

# report-surface（delta）

## MODIFIED Requirements

### Requirement: 详情页阅读

详情页 SHALL 把服务端返回的**祖先链**与焦点帖渲染在**同一条连续 timeline** 中（祖先在上、focal
在下，所有回复从 focal 下方继续向下），SHALL NOT 提供「展开上文」「N 条上文」「继续 N 条上文」
等祖先上下文的折叠/展开动作。祖先行 SHALL 使用与 focal 相同的 PostCard 度量（**46px 头像**、
`px-4`、同作者行、全文正文不截断），SHALL NOT 使用旧的 24px 紧凑祖先样式。**所有回复行
SHALL 与 focal/祖先使用同一条 46px 头像列（中心 x=39）与同一条左侧主轨，SHALL NOT 使用
`marginLeft`/indent/逐级 `padding-left` 表达层级**（细则见「平铺回复 timeline」）。
**例外（unresolvedGap）**：focal 不在 `thread.posts` 且 `focal.parent_id` 也解析不到时，页面
SHALL 只渲染「缺口行 + focal」，SHALL NOT 把不可定位节点平铺成回复（见「focal 缺失的深链回退」）。
focal 正文 SHALL 永不截断（仅 feed
卡片截断约 6 行）。进入详情 SHALL 把 focal 行顶边贴到吸顶栏下沿（滚动容器坐标 0，±2px），祖先
SHALL 保留在滚动区上方并可通过向上滚动自然回溯到根帖；SHALL NOT 在进入时用上文填满视口或把
focal 挤出视口。focal 行 SHALL 保留完整时间（及服务端 `reply_count` 回复数，若有）的底部信息行，
该信息行属于 focal 行且导轨 SHALL 贯穿。回复列表 SHALL 紧接 focal 行，SHALL NOT 在两者之间插入
独立的「N 条回复」分隔行。`Replying to` SHALL 仅在父帖不在视觉邻位且非 focal 时显示。子分支/
后端折叠 SHALL 显示「查看该子线程 · N 条回复」并**跳转到该节点自己的详情页**，SHALL NOT 内联
展开。被删除的帖 SHALL 保留占位（「此帖已删除」），SHALL NOT 塌陷，且 SHALL NOT 断开 timeline
导轨。

#### Scenario: 深链到回复仍有上下文

- **WHEN** 用户从通知点进一条位于第 3 层的回复
- **THEN** 页面直接显示「根 → … → parent → focal」的连续 timeline，focal 贴在吸顶栏下沿；不存在
  「N 条上文」按钮，不触发展开动作；向上滚动即可读到根帖全文

#### Scenario: 进入不填满视口

- **WHEN** 打开一条有 6 条祖先、其中一条祖先正文长达 40 行、focal 只有 3 行的回复
- **THEN** 首屏以 focal 为主体，祖先行全部在视口上方（`ancestor.bottom <= container.top + 1`）；
  页面没有因上下文展开而跳变，focal 可见高度不少于其行高的 60%

#### Scenario: 子分支不内联爆炸

- **WHEN** 某条回复下还有 12 条未加载的回复
- **THEN** 显示「查看该子线程 · 12 条回复」，点击进入该节点详情页，当前页不展开这 12 条

#### Scenario: 删除祖先不断轨

- **WHEN** 祖先链中间有一条已删除帖
- **THEN** 该位置显示「此帖已删除」占位行（高度大于 0），前后行与占位行的左侧导轨在 1px 内相接，
  timeline 不跳过该位置

### Requirement: 自接线程与多人对话的渲染

**自接线程** SHALL 按时间平铺，SHALL NOT 再整链置顶或分组；所有行 SHALL 使用与 focal/普通回复
相同的 **46px 头像列（中心 x=39）**（24px 头像 SHALL 与普通行**同轴居中**，即中心 x=39、
gutter≈17，SHALL NOT 用 `marginLeft`/indent/`padding-left` 缩进）；同一作者**连续续接**的相邻行
MAY 使用紧凑呈现（仅首条显示作者名/时间，其余只留头像 + 正文；编号 SHALL 只以正文行内后缀
`· i/n` 表达，SHALL NOT 另起 chip 行或角标；隐藏操作栏）；被其他分支按时间隔开时 SHALL 按普通
回复行渲染并显示「回复给 @x」；连接线 SHALL 为 timeline 主轨（同一条 trunk，导轨从 compact
头像中心穿过），SHALL NOT 另画子轨。
**多人对话** SHALL 平铺：SHALL NOT 用一级/每级缩进表达层级，SHALL NOT 有 3 级封顶；所有回复与
focal/祖先同一头像列、同一 trunk；父关系 SHALL 由「回复给 @x」+ 时间顺序 + 导轨表达；后端折叠/
未加载子树 SHALL 显示「查看该子线程 · N 条回复」入口并导航到该节点详情，SHALL NOT 内联展开；
SHALL NOT 存在 `collapse-depth` / `expand-branch` /「继续 N 层回复」。

#### Scenario: 自接汇报可连续阅读

- **WHEN** 一个子代理把一份长汇报拆成 1 条根帖 + 4 条连续自回复
- **THEN** 5 条按时间平铺、同一条头像列与同一条 trunk、无任何缩进；连续自回复用紧凑行（无重复
  作者名、显示 `1/5`…`5/5`）；其他回复按时间穿插平铺，不被整链置顶

#### Scenario: 深层多人对话不压扁

- **WHEN** 一条会话的回复嵌套到第 4 层
- **THEN** 所有层级都平铺在同一头像列、同一导轨，不缩进、不折叠、不显示「继续 N 层回复」；
  父关系由「回复给 @x」+ 时间顺序 + 连续导轨表达，窄屏仍可读

### Requirement: 焦点锚点确定性

线程页聚焦帖贴合吸顶栏 SHALL 用确定的 `scrollTop` 计算：滚动容器顶边即吸顶栏下沿，目标为
`scrollTop = focal 行在滚动内容中的 offsetTop`（容器坐标 0），SHALL NOT 再减硬编码吸顶高度
（旧 60px 常量作废），SHALL NOT 依赖 `scrollIntoView` 的浏览器实现细节。同一路由 SHALL 只自动
锚定一次；数据回填（单帖种子 → 完整线程）在用户尚未手动滚动时 SHALL 用同一规则重新贴合，并在
同一 layout 帧补偿祖先插入带来的高度差；用户已手动滚动后 SHALL NOT 强制拉回 focal。timeline 末尾
SHALL 提供 tail spacer，保证 `container.scrollHeight - container.clientHeight >= focal.offsetTop`，
使目标 `scrollTop` 可达；锚定完成后 SHALL 满足
`focalRow.top - container.top ∈ [-2, 2]px`，SHALL NOT 出现 `scrollTop` 被浏览器 clamp 到小于
focal offset 的状态。

#### Scenario: 打开回复帖

- **WHEN** 深链打开一条带 3 条祖先的回复
- **THEN** focal 顶端落在吸顶栏下沿 ±2px；祖先插入或线程回填不改变 focal 的屏幕位置；返回时恢复
  离开前滚动位置

#### Scenario: 内容不足一屏也能贴顶

- **WHEN** focal 下方没有回复、focal 行高加下方内容小于滚动容器高度
- **THEN** tail spacer 补足高度，focal 仍能贴到吸顶栏下沿（±2px），不会停在 330px 之类的中间位置

### Requirement: 骨架到内容的有动画交接

数据在骨架之后返回时 SHALL 交叉淡入（骨架淡出、内容淡入），容器高度 SHALL 从骨架高度平滑过渡到
内容高度（~240ms）；命中缓存的首帧 SHALL 直接渲染内容、不播动画。需要把 focal 锚定到吸顶栏的线程页
MAY 跳过容器高度过渡（`animateHeight=false`），但 SHALL 在 layout 阶段以最终高度落地并完成锚定，
骨架→内容交接 SHALL NOT 造成 focal 位移，SHALL NOT 出现「先显示上文、再跳到 focal」的中间帧。
`prefers-reduced-motion` SHALL 关闭该动画。

#### Scenario: 冷深链成员页

- **WHEN** 直接打开一个从未见过的成员页
- **THEN** 先出现与资料卡同度量的骨架，数据回来后资料卡淡入、高度平滑变化，不出现塌陷再弹开

#### Scenario: 线程页锚定优先

- **WHEN** 冷深链打开一条有 6 条祖先的回复
- **THEN** 内容以最终高度一次落地并在 layout 阶段把 focal 贴到吸顶栏；跳过 240ms 高度过渡，
  不出现先显示祖先再跳到 focal 的中间帧

## ADDED Requirements

### Requirement: 平铺回复 timeline（禁止缩进表达层级）

详情页的所有回复行 SHALL 平铺：`marginLeft` SHALL 恒为 0、所有 post 行的 `padding-left` SHALL 相等
（16px），SHALL NOT 出现 24/48/72px 等逐级阶梯；所有 post 行 SHALL 共用同一条 2px 左侧主轨。
页面 SHALL NOT 存在 `collapse-depth`/`expand-branch` 控件或「继续 N 层回复」文案；客户端 SHALL NOT
有 `extraDepth`/`expandedBranches` 式的深度上限状态。后端折叠/未加载子树 SHALL 渲染为
「查看该子线程 · N 条回复」入口并导航到该节点详情页，SHALL NOT 内联展开。

#### Scenario: 平铺无缩进

- **WHEN** 检查任意回复行的计算样式与头像矩形
- **THEN** `getComputedStyle(row).marginLeft === "0px"`；所有 post 行 `padding-left === "16px"`；
  普通/focal 46px 头像、compact 24px 头像的列中心 x 均为 39（±1px，与导轨同轴）；不存在第二根导轨

#### Scenario: 无层级控件

- **WHEN** 打开一条曾触发 3 级封顶/分支 >10 条的线程
- **THEN** DOM 中不存在 `collapse-depth` / `expand-branch`，页面无「继续 N 层回复」；所有深层
  节点直接平铺

#### Scenario: 折叠分支改子线程入口

- **WHEN** 某节点有后端折叠或未加载的子树
- **THEN** 该节点行后显示「查看该子线程 · N 条回复」的 `[data-testid="subthread-entry"]`；点击后
  `location.hash` 变为 `/p/<nodeId>`；当前页 DOM 不增加隐藏子节点，也不出现内联嵌套

### Requirement: 平铺顺序与关系语义

focal 之后的所有回复 SHALL 按 `(created_at, seq, id)` 升序稳定平铺（祖先链与 focal 固定在最上方），
SHALL NOT 按深度分组或把自接链整链置顶。**例外（unresolvedGap）**：`focal.parent_id` 解析不到时
SHALL NOT 平铺任何不可定位节点（只留缺口行 + focal，见「focal 缺失的深链回退」）。每一条 post 行 SHALL 与上一条 post 行比较：若父帖不是上一
post 行（`parent_id !== prevPost.id`），SHALL 显示「回复给 @parentAuthor」；若父帖就是上一行，SHALL
NOT 显示。`is_self_continuation` 的紧凑呈现 SHALL 只用于「父帖就是上一 post 行」的连续同作者行；
被其他分支隔开时 SHALL 按普通回复行渲染。页面 MAY 额外显示「root 内路径」小标签，但 SHALL NOT
引入视觉缩进。子线程入口 SHALL 附着在其父 post 行之后，不参与时间排序，也不参与头像列断言。

#### Scenario: 时间序平铺

- **WHEN** 打开一个包含交错分支 A→B(t1)、A→C(t2)、B→D(t3)、C→E(t4) 的 root
- **THEN** focal 之后 DOM 中回复行的 `data-post-id` 顺序为 B、C、D、E（按 `(created_at, seq, id)`），
  不按深度分组、不把 B→D 缩进到 B 下

#### Scenario: 回复给 @x

- **WHEN** 一条回复的父帖不是它的上一 post 行
- **THEN** 该行显示「回复给 @parentAuthor」；若父帖就是上一行（祖先链、focal、首条回复、连续自接
  链），则不显示

#### Scenario: 自接链连续导轨

- **WHEN** 同作者连续续接的父子行（A→S1→S2）按时间相邻平铺
- **THEN** 三行共用同一条 2px trunk（x=38..40），相邻导轨段在 1px 内相接；S1/S2 用 24px 头像
  居中于 46px 列，头像中心 x 与 A 一致（39±1px，导轨从头像中心穿过），且不存在独立子轨

### Requirement: 时间线主轨连续性

timeline 的祖先、focal、回复行与控制行 SHALL 共享同一条左侧主轨（trunk）：宽 2px、左缘 38px
（= 46px 头像列中心 39），颜色 SHALL 使用主题 `thread-rail` 令牌（#C3C9D2；divider 仍用 `border`）。
相邻行 SHALL 在行边界处无缝相接（±1px）；头像 SHALL 盖住导轨（上方/下方各露一段）；首行 SHALL NOT
画上段、末行 SHALL NOT 画下段；控制行按首末截断（细则见场景）；删除占位行 SHALL 保留 trunk；
trunk 的 x 坐标 SHALL NOT 因行类型改变。

#### Scenario: 相邻行导轨相接

- **WHEN** 读取祖先→focal→首条回复的 `[data-testid="thread-rail"]` 段矩形
- **THEN** 每对相邻段的 `bottom` 与下一段的 `top` 差值 ≤1px，`left`/`width` 差值 ≤1px，且
  ancestor/focal 行的导轨中心与其 46px 头像中心重合（≤1px），compact 行 24px 头像也同轴

#### Scenario: 删除与折叠不断轨

- **WHEN** timeline 中夹有已删除占位行或**非末行**的「查看该子线程」入口行
- **THEN** 该行的 trunk 段仍与相邻行在 1px 内相接，视觉上是一条连续导轨

#### Scenario: 末行控制行收轨

- **WHEN** 「查看该子线程」入口行是 timeline 的最后一行
- **THEN** 该行 SHALL NOT 绘制任何导轨段（DOM 中 `[data-testid="thread-rail"]` 数 = 0），不留悬空线

### Requirement: focal 顶部导轨 stub

focal 行上方有祖先且 focal 贴顶时，focal 的「上段导轨」SHALL 作为顶部 stub 从滚动视口顶边延伸到
focal 头像顶边（**22px**，与 focal 行上内边距同源）；stub 的可见性 SHALL 由 focal 行的几何决定（行顶 ≤ 视口顶 < 头像底），
SHALL NOT 依赖额外的展开/滚动状态。stub SHALL 带 `data-testid="thread-rail-stub"`。

#### Scenario: focal 贴顶有向上 stub

- **WHEN** 深链进入一条有祖先的回复且 focal 已贴顶
- **THEN** 存在从滚动视口顶边到 focal 头像顶边的 `[data-testid="thread-rail-stub"]`，其高度等于
  `avatar.top - container.top`（**精确相等**，22px）；向上滚动后祖先的 bottom 段与该 stub 连续，
  不出现断口或悬浮孤线

### Requirement: timeline 初始锚定

进入详情（深链/前进导航）SHALL 在数据就绪后的 layout 阶段把 focal 行顶边锚定到滚动容器顶边
（等于吸顶栏下沿；容器坐标 0，±2px）；SHALL NOT 使用硬编码吸顶高度；SHALL NOT 使用
`scrollIntoView`。为避免 focal 因下方内容不足而无法贴顶，页面 SHALL 在 timeline 末尾提供 tail
spacer，使 `container.scrollHeight - container.clientHeight >= focal.offsetTop`。数据从种子/骨架
晚到时，SHALL 在同一 layout 帧重算 focal offset 与 spacer 并补偿 `scrollTop`，保持 focal 的屏幕
位置不变；用户尚未手动滚动前 SHALL 允许重新锚定，用户手动滚动后 SHALL NOT 强行拉回 focal。

#### Scenario: 冷深链首帧

- **WHEN** 直接打开一条有 6 条祖先的回复详情（无缓存）
- **THEN** 骨架结束后 focal 顶边距吸顶栏下沿 ≤2px，祖先全部位于视口上方；从 focal 首次出现起
  连续 rAF 采样 focal 顶边，极差 ≤2px，不出现 >4px 的跳动

#### Scenario: 种子→完整线程不抖

- **WHEN** 从时间线点开一条已有单帖种子的回复，完整线程（含祖先）在转场结束后到达
- **THEN** 祖先插入使 `scrollTop` 增加对应高度，focal 在屏幕上保持原位；转场快照撤掉前后 focal
  顶边不变

### Requirement: 线程返回滚动位置恢复

从另一条详情返回本线程时，SHALL 恢复离开前的滚动位置（优先恢复首个可见行 + 行内偏移，缺失时回退
`scrollTop`），SHALL NOT 重新贴 focal。线程页 `prefers-reduced-motion` 下所有锚定/恢复 SHALL 瞬时
完成（直接写 `scrollTop`，禁止 `behavior:"smooth"`）。

#### Scenario: 返回恢复

- **WHEN** 在一条线程里向上滚到第 2 条祖先，点开另一条帖子后返回
- **THEN** 回到该线程时滚动位置恢复到 ±2px，第 2 条祖先仍可见，不被强制拉回 focal

#### Scenario: 减少动态

- **WHEN** `prefers-reduced-motion: reduce` 下进入或返回带祖先的线程
- **THEN** 没有平滑滚动或高度过渡，focal/恢复位置在内容出现的第一帧即到位（±2px）

### Requirement: 深树祖先一次渲染

线程页 SHALL 一次性渲染服务端返回的全部祖先与回复（当前 `assembleThread` `maxDepth=6`，即最多
depth 0..6），SHALL NOT 为祖先/回复另发逐条请求或做虚拟滚动；祖先正文 SHALL NOT 在 UI 截断。
**例外（unresolvedGap）**：focal 缺失且父帖不可解析时，返回的不可定位节点 SHALL NOT 渲染
（只留缺口行 + focal），不属于「一次渲染」义务范围。
祖先数量 ≤20 条 SHALL 一次全渲染；>20 条时 SHALL 只渲染最近 20 条并在顶部显示一条缺口占位行
（当前接口上限 6，正常不触发）。

#### Scenario: 长祖先一次渲染

- **WHEN** 6 条祖先中有一条 1500px 高的长正文
- **THEN** 首屏不因祖先高度卡顿或分页；祖先文本在 DOM 中一次到位，向上滚动即可读到

### Requirement: focal 缺失的深链回退

若 `thread.posts` 不包含 focal（超过 `maxDepth`），页面 SHALL 用 `GET /api/posts/:id` 合成 focal 行：
`unresolvedGap = focal.parent_id 不在 posts` 时只渲染「缺口行 + focal」（不可定位节点 SHALL NOT
渲染）并提供父帖导航，SHALL NOT 内联展开；父帖可解析（如 depth7）时 SHALL 走正常祖先链、不显示
缺口行。删除祖先 SHALL 保留占位行，后端折叠分组 SHALL 显示子线程入口。

#### Scenario: 9 层深链仍能显示 focal

- **WHEN** 打开一条深度为 8 的回复（服务端只返回 depth 0..6，focal 不在 posts）
- **THEN** 页面不空白、不永久骨架；focal 行正常显示（可回复/收藏），顶部有「更早的回复未加载」
  占位行，点击可进入父帖详情

#### Scenario: 缺口不伪装成相邻祖先

- **WHEN** focal 的 parent 不在 `thread.posts`，但 root..depth6 存在
- **THEN** 页面不把 root..depth6 当作 focal 的相邻祖先或回复渲染（不内联渲染这些行）；显示缺口
  占位行，导轨在缺口处保持连续

### Requirement: 线程 timeline 的视觉度量与共享件（v3 终审）

详情页 timeline 的度量 SHALL 与 design §0.0 一致（唯一信源）：正文 17px/25px、正文列 = 行左缘 +68px、
头像 46px（中心 39）、compact 头像 24px 同轴、导轨 2px @x=38..40（`thread-rail`）、focal 上内边距与
顶部 stub 22px（精确相等）、操作行限宽 464px、吸顶栏玻璃 + `thread-hairline`。任何页面 SHALL NOT
另立一套度量；共享件（AuthorLine/PageHeader/Skeletons）SHALL 与该口径同源。

#### Scenario: 作者行不重复身份

- **WHEN** display 与 handle 相同（默认账号就是这种情况）
- **THEN** 作者行只出现一次用户名文本，角色胶囊显示真角色（owner→「人类」、manager→「总调度」），
  时间以 `· 刚刚` 与 handle 同行；成员卡、通知行与线程行同形态

#### Scenario: 逐项度量

- **WHEN** 读取详情页 focal/回复行的计算样式与几何
- **THEN** 正文 17px/25px、name/handle 16px、时间 13px（`· 刚刚` 同行）、角色胶囊为真角色
  （owner→人类、manager→总调度）；focal footer 左对齐 68px 且不被导轨穿过；操作行图标 16px、
  首图标墨迹对齐正文列、宽 `min(文字列, 464px)`；吸顶栏为 `bg-background/75` + `backdrop-blur-xl`
  + `thread-hairline` 下边线；缺口行文案为「更早的回复未加载」；骨架与上述度量同源
  （46px 头像、正文列 68、compact 41px 槽 + gutter 11、13px 行块）。

#### Scenario: 深度只出现一次

- **WHEN** 打开一条 spine 上的回复（例如 4/9）且其下有连续自接续接行
- **THEN** 只有紧凑行的正文行内出现 `· 5/9` 之类的后缀；focal 右上角没有重复的 `4/9` 角标

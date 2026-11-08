# report-surface Specification

## Purpose
TBD - created by archiving change report-v0. Update Purpose after archive.

## Requirements

### Requirement: 本地服务生命周期
`serve` SHALL 在前台运行并输出 `REPORT_URL=` 首行；SHALL 支持 `--daemon/--stop/--status`；
SHALL 在数据目录写 `server.json`（port/pid/url/startedAt/dataDir/instanceId）。
数据目录解析顺序 SHALL 为：`--data-dir` → `FDE2E_REPORT_DATA_DIR` → `init` 写的项目指针文件
→ 报错（**禁止**静默默认到 `<cwd>/.report`）。其余 CLI 命令 SHALL 通过 `server.json` 发现服务，
**命中前先探 `/healthz` 并核对 dataDir**；服务未运行时 SHALL 明确报错并提示先启动，不得静默
自动起进程。同一 data-dir SHALL 以 `flock` 保证**单实例**（第二个 `serve` 直接失败）。

#### Scenario: 多命令共享一个服务
- **WHEN** manager 起服务后依次在多个终端执行 `post`、`read`、`wait-notifications`
- **THEN** 全部命令命中同一实例，无需重复指定端口或数据目录

#### Scenario: 子代理漏参不另起库
- **WHEN** 子代理未传 `--data-dir`
- **THEN** 它通过 `FDE2E_REPORT_DATA_DIR` 或项目指针文件解析到 manager 的同一实例；
  解析不到时报错，不会在空目录上悄悄起第二个服务

#### Scenario: 死端口不被盲信
- **WHEN** `server.json` 指向的进程已被 kill（或 pid 被复用）
- **THEN** `/healthz` 探测失败，命令报"服务不可用"而不是把请求发给错误的进程

### Requirement: HTTP API 与跨域
服务 SHALL 提供 JSON API（timeline/thread/post/reply/media/who/search/health）与 SSE
`/api/stream`（15s 心跳）；SSE 鉴权 SHALL 用 `POST /api/stream/ticket` 换 **60s 一次性票据**
（SHALL NOT 用 `?token=`）；认证失败时 SSE SHALL 返回 **204**（停止 EventSource 无限重连）。
CORS SHALL 按**完整 origin** 精确匹配（`report.worker.fde2e.com`、
`^local-[a-z0-9-]+\.fde2e\.com$`、`localhost`/`127.0.0.1` 任意端口），SHALL NOT 使用 Cookie；
媒体读取 SHALL 只认 `Authorization`。SSE 响应 SHALL 带 `X-Accel-Buffering: no` 且该路由关 gzip。

#### Scenario: 公网壳跨域调用本地后端
- **WHEN** 浏览器在 `https://report.worker.fde2e.com` 页面里请求 `ep` 指向的本地后端
- **THEN** 预检通过、请求被接受、SSE 连接建立并收到心跳

#### Scenario: 相似域名不可绕过
- **WHEN** 请求来自 `https://local-x.fde2e.com.evil.com`
- **THEN** 该 origin 不被回显、浏览器侧请求失败

### Requirement: 公网壳与 ep 契约
壳 SHALL 不持任何数据、不硬编码后端；`?ep=` SHALL 只接受 `https://`（或
`http://localhost|127.0.0.1`），其余 SHALL 拒绝并给出可读提示；`ep` SHALL 持久化
（localStorage）并支持多后端切换；无 `ep` 时 SHALL 显示落地页（输入框 + 历史 + 用法）。

#### Scenario: http 后端被拒
- **WHEN** 用户输入 `?ep=http://192.168.1.10:13610`
- **THEN** 壳拒绝连接并提示"必须 https（或 localhost）"，不发起任何混合内容请求

#### Scenario: 再次打开免输入
- **WHEN** 同一浏览器再次打开壳且不带 `ep`
- **THEN** 自动使用上次成功的后端，直接进入时间线

### Requirement: 时间线位置保持与新帖提示
时间线 SHALL 逆序（上＝新）。新数据 SHALL 先入 `pending[]` 而**不得**直接插入已渲染列表。
当 `scrollTop ≤ 5px` 且无拖拽/惯性时 SHALL 立即插入并保持滚动为 0；否则 SHALL 冻结列表并显示
「N 条新帖子」胶囊（400ms 抖动合并、上限 `99+`、tab 隐藏时只累积）。点击胶囊 SHALL 一次性插入
全部 pending 并平滑滚顶，且 SHALL NOT 发起网络请求。下拉刷新 SHALL 仅在顶部生效。
从详情页返回 SHALL **先恢复锚点（`firstVisibleId` + `offsetPx`，缺失退回 `scrollTop`）后刷新**，
恢复期间 SHALL NOT 重排。

#### Scenario: 恢复位置后向上看新
- **WHEN** 用户上次停在时间线中段，关闭后再次打开（期间有新帖）
- **THEN** 页面先定位到上次锚点、不跳动；新帖以胶囊提示，点击后插入并滚顶

#### Scenario: 拖拽中不吸收
- **WHEN** 用户正在向上拖拽、列表已滚到顶部但手指未松开
- **THEN** 新帖不插入（等拖拽/惯性结束后再判定），视觉不抖动

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

### Requirement: 四导航与界面元素
UI SHALL 提供**四导航（主页 / 搜索 / 通知 / 发帖）**并 SHALL NOT 提供私信。
媒体网格 SHALL 按 1/2/3/4 图规则布局；引用 SHALL 只渲染一层（二级降级为链接）；
键盘 SHALL 仅支持 `j`/`k`/`Enter`/`r`。

#### Scenario: 三条窄屏栅格
- **WHEN** 在 390 / 768 / 1440 三档宽度打开
- **THEN** 无横向溢出、无 console error，四导航在窄屏为底部栏

### Requirement: 正文与附件
正文 SHALL 支持 markdown 子集（标题/列表/表格/引用/代码块/行内代码/链接/图片）；
附件 SHALL 支持 CLI `--attach` 与网页上传，按 sha256 内容寻址存 `DATA_PATH/media/`，
SHALL 支持缩略图与 lightbox；单件默认上限 10MB，类型白名单可配置。

#### Scenario: 报告带图
- **WHEN** 子代理执行 `post --attach ./shot.png --attach ./ok.png`
- **THEN** 两条附件入库并按序展示，时间线/线程页/SSG 导出中均可见

### Requirement: SSG 自包含导出
`export` SHALL 直接读数据库生成静态站（时间线分页 / 线程页 / who / 搜索 / 媒体），
**SHALL 可通过 `file://` 双击浏览（含搜索）**。实现口径 SHALL 为：应用打成**经典 IIFE**
单包（`assets/app.js`）＋ 一份 CSS，各页以 `src`/`href` 相对引用；数据与搜索索引 SHALL
**内联为 `<script type="application/json">`**（正文中的 `</script` 必须转义）；
SHALL NOT 使用 ES module、SHALL NOT 用 `fetch`/XHR 取数据；媒体 SHALL 在导出根共享一份
（内容寻址，不按快照重复拷贝）。产物 SHALL 先写 `.tmp-<ts>/` 再原子 `rename` 到
`DATA_PATH/export/`（latest 覆盖）并留档 `history/<ts>/`，支持 `--prune --keep N`；
每份导出 SHALL 内嵌 `as-of seq`。

#### Scenario: 断网归档
- **WHEN** 服务已停止、机器断网，用户双击 `export/index.html`
- **THEN** 时间线与线程页可正常浏览、搜索可用、图片加载正常，无任何请求失败提示

#### Scenario: 导出中断不留半套
- **WHEN** 导出进行到一半被 kill
- **THEN** 目标目录仍是上一次完整快照（或不存在），临时目录可被下次导出清理，
  不会出现"新 index 配旧线程页"的混合归档

#### Scenario: 自动导出不阻断通知
- **WHEN** manager 的 `wait-notifications` 醒来并触发导出，而导出目录被设为只读
- **THEN** 消息照常交付到 stdout、游标照常推进、退出码为 0，stderr 记一行导出失败原因，
  并置 `pending-export` 供下次唤醒或服务启动时重试

### Requirement: 底部导航属于壳布局流

移动端底部四导航 SHALL 是应用壳的 **flex 子元素**（`shrink-0`，高度 `3.5rem` + 安全区），
SHALL NOT 使用 `position: fixed` 贴底。壳内主列与详情覆盖层 SHALL NOT 为导航预留
`padding-bottom`（导航不覆盖内容）。导航 SHALL 与壳（顶栏）在**同一帧**出现，
打断/刷新/深链直达 SHALL NOT 出现「有内容无导航」的中间态。

#### Scenario: 直接打开不回退
- **WHEN** 浏览器冷启动直接打开壳（`?ep=` 或深链 `#/p/<id>`、`#/u/<account>`）
- **THEN** 壳出现的那一帧底部导航即存在，位置在视口底部且不随滚动/转场移动

#### Scenario: 转场不影响导航
- **WHEN** 任意路由转场（forward/back/fade）进行中与结束后
- **THEN** 底部导航矩形与转场前一致（同名 `view-transition-name` 保持原位）

### Requirement: 转场目标页首帧完成排版

路由切换 SHALL 在 View Transition 的 commit 回调内**用已有数据或骨架**完成目标页排版：
帖子详情 SHALL 用已见帖/已见线程（单帖时合成仅含焦点帖的线程 + 回复区骨架），
成员页 SHALL 用完整资料 > 已见身份 > presence 的降级顺序，标签页 SHALL 用已见帖子的标签过滤，
时间线 SHALL 用 `cacheKey` 快照。数据请求 SHALL 在转场期间发出。SHALL NOT 以居中 spinner
或空白页作为转场目标页。

#### Scenario: 时间线点开帖子
- **WHEN** 从时间线点击一条已渲染的帖子
- **THEN** 转场新快照里焦点帖已是真实卡片（含头像/正文/媒体占位），回复区为骨架；
  完整线程返回后在焦点帖下方补全

#### Scenario: 转场结束后无位移
- **WHEN** 转场结束到数据回填完成
- **THEN** 顶栏、底部导航、焦点帖顶端、滚动容器高度保持不变；导航窗口内累积布局位移 CLS = 0

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

### Requirement: 客户端实体缓存与意图预取

前端 SHALL 在内存中缓存已见实体（帖子、线程、成员资料、身份、时间线快照），
SHALL 以 id 去重并设上限；SHALL NOT 写入跨会话持久化存储。
指针悬停/按下帖子或成员入口时 SHALL 预取对应线程/资料（30s TTL、in-flight 去重、失败静默）。

#### Scenario: 二次进入秒开
- **WHEN** 用户看过一条帖子后返回再进入
- **THEN** 首帧直接是全量内容（无骨架），网络结果只在后台刷新

### Requirement: 详情页按路由重建

详情覆盖层 SHALL 以路由键作为 React key；`#/p/A → #/p/B`（详情→详情）SHALL 重建页面实例，
使首帧 state 由缓存种子同步确定。SHALL NOT 复用上一页实例导致转场快照拍到旧内容。

#### Scenario: 连续打开两条帖子
- **WHEN** 从帖子 A 的线程页直接进入帖子 B（点回复/上文）
- **THEN** View Transition 的**新**快照里焦点帖就是 B；转场结束后焦点帖顶端与导航矩形不变

### Requirement: 媒体按固有宽高预留占位

媒体上传时 SHALL 解析固有宽高并入库（PNG/JPEG/GIF/WebP/SVG/MP4；WebM 可缺省）；
`MediaRef`/接口/归档快照 SHALL 在已知时携带 `w/h`。前端单媒体 SHALL 用 `aspect-ratio`
预留占位；未知尺寸时 SHALL 退回加载后自然增高（不得报错）。

#### Scenario: 打开含未缓存媒体的帖子
- **WHEN** 从时间线打开一条带图片/视频、且媒体尚未在本次会话解码过的帖子
- **THEN** 卡片高度在转场前即由 `aspect-ratio` 确定，媒体加载完成不改变焦点帖高度，下方内容不位移

### Requirement: 转场曲线对齐 iOS（进退分离）

移动端推入/返回 SHALL 使用 **进场强减速 + 退场加速** 两条不同的曲线
（进场 `cubic-bezier(.32,.72,0,1)`、退场 `cubic-bezier(.42,0,1,1)`，380ms）；
根页淡切 SHALL 使用进场 easeOut 200ms / 退场 easeIn 150ms。桌面端 SHALL 使用淡入上移
（easeOut 200ms）/ 淡出（easeIn 150ms）。motion 降级路径 SHALL 同语义。
`prefers-reduced-motion` SHALL 瞬时完成。

#### Scenario: 转场曲线可验证
- **WHEN** 转场进行中读取 `::view-transition-old(root)` / `::view-transition-new(root)` 的计算样式
- **THEN** 进场与退场的 `animation-name`、`animation-duration`、`animation-timing-function` 与上述语义一致

### Requirement: 转场播放期间目标页不得变更

View Transition 播放期间（`startViewTransition` 回调提交后到 `finished` 结算前），目标页
SHALL NOT 因数据回填而改变布局：网络结果 SHALL 挂起，转场结算后再落地。
骨架→内容交接（`ContentSwap`）SHALL 以转场结算为前置条件；转场结束前 SHALL NOT 启动
高度过渡或交叉淡入。

#### Scenario: 第二次导航（详情→详情，未缓存线程）
- **WHEN** 从帖子 A 点进未缓存的帖子 B（种子＝合成焦点帖 + 回复骨架）
- **THEN** 转场播放期间 thread scrollHeight 与焦点帖顶端保持不变；转场结束后回复区以动画
  收缩到真实高度（约 16px），不会出现快照撤掉瞬间的整页跳变

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

### Requirement: 顶栏账号入口与账号抽屉

移动端首页顶栏左侧 SHALL 显示当前账号头像（SHALL NOT 显示产品品牌字）；点击 SHALL 打开
账号抽屉，含：头像/昵称/@id/关注数/粉丝数，以及个人资料、收藏、连接与成员、切换主题、
连接其它实例、退出登录。静态归档下 SHALL 隐藏连接/退出，收藏列表只读。

#### Scenario: 打开账号抽屉
- **WHEN** 在 390 宽首页点左上角头像
- **THEN** 从底部拉起抽屉，显示 @owner 与上述菜单；点「个人资料」进入成员页、
  点「收藏」进入收藏页、点「连接与成员」打开信息 sheet

### Requirement: 收藏页

`#/bookmarks` SHALL 是根页（不占底部 tab），页头显示「收藏」与返回；列表 SHALL 复用通用
feed 的骨架/锚点/加载更多；取消收藏 SHALL 立即移除该项，空列表 SHALL 显示空态。

#### Scenario: 从账号菜单进入收藏
- **WHEN** 账号抽屉点「收藏」
- **THEN** 进入 `#/bookmarks`，返回回到原页面

### Requirement: 共享元素覆盖所有进入详情的入口

任何可点击进入帖子详情的卡片 SHALL 登记同名 `view-transition-name`（头像与作者行）：
feed / focal / reply / ancestor 四种变体一致；通知行在「头像即目标帖作者」时按目标帖
登记，且同一帖在同一快照内 SHALL 只登记一次（同名重复会导致整次转场被放弃）。

#### Scenario: 非首页入口进详情
- **WHEN** 从通知、成员页、标签页、收藏页或线程内的回复卡点进帖子
- **THEN** 转场中的 `::view-transition-group(vt-avatar-…)` / `(vt-author-…)` 是形变
  （关键帧含 width/height/transform），不是单侧淡入

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

### Requirement: 未读帖高亮与已读淡出

凡渲染完整帖子卡片的页面（feed / 线程 / 搜索 / 收藏 / 成员页 / 详情）SHALL 用同一 read-set
判定未读：未读帖 SHALL 显示整卡淡底与左侧强调条，强调条 SHALL 画在卡片左缘 **x=0..3（宽
3px）**，SHALL NOT 与线程主轨（**x=38..40，宽 2px**）重叠。帖子停留达标瞬间 SHALL 播放约
1.2 秒的背景淡出并由未读转已读，强调条 SHALL 在约 200ms 内淡出；
`prefers-reduced-motion: reduce` 时 SHALL 直接切换、无过渡。
新到达的帖子在进入列表时 SHALL 有短暂高亮（不超过 1 秒），随后回到未读底色。高亮 SHALL NOT
改变卡片的内边距、行高或外框尺寸（CLS = 0）；选中态 SHALL 压过未读底色。

#### Scenario: 两视口高亮形态
- **WHEN** 在 390×844 与 1280×800 打开含未读帖的 feed
- **THEN** 未读卡有整卡淡底与 3px 左强调条；强调条不与 x=38..40 的线程导轨重叠；
  卡片高度与无高亮时一致

#### Scenario: 达标淡出
- **WHEN** 某未读帖停留达到阈值
- **THEN** 该卡背景在约 1.2 秒内淡到透明、强调条 200ms 内消失，`data-read` 变为 `"1"`；
  其它卡片与列表滚动位置不变

#### Scenario: 减少动态效果
- **WHEN** 系统开启「减少动态效果」并停留达标
- **THEN** 未读底色立即消失、无 1.2 秒过渡；新帖入场也不播放动画（未读底色仍显示）

#### Scenario: 强调条几何
- **WHEN** 在线程页与 feed 各取一条未读卡，读取强调条与 `[data-testid="thread-rail"]` 的矩形
- **THEN** 强调条 left=0、width=3（x∈[0,3]）；线程导轨 left=38、width=2（x∈[38,40]）；
  两矩形不相交；卡片高度与无高亮时一致

#### Scenario: 新帖入场高亮
- **WHEN** 新帖经实时推送进入列表并在顶部被吸收
- **THEN** 新行在不超过 1 秒内有一次背景高亮，之后保留未读底色直到被停留读完

### Requirement: 停留观察的全局单观察器与性能预算

视窗停留观察 SHALL 在每个文档内全局复用**一个** `IntersectionObserver`，由所有完整帖子卡片
共享；SHALL NOT 为每张卡片各建一个。卡片挂载 SHALL 注册、卸载 SHALL 注销；引擎 SHALL NOT
监听滚动事件、SHALL NOT 每帧 setState。标记单帖 SHALL 只让该卡片重渲染（或只改该卡片属性），
SHALL NOT 触发整列表重渲染。200 帖长列表 SHALL 满足：观察器实例 = 1、观察目标 ≤ 已挂载未读卡数、
无单次 >50ms 的引擎长任务。

#### Scenario: 200 帖只有一个观察器
- **WHEN** feed 加载 200 条帖子并连续滚动
- **THEN** 页面内 `IntersectionObserver` 实例数为 1，观察目标数 ≤200；滚动全程无 >50ms 的
  引擎长任务

#### Scenario: 单帖标记不重渲染列表
- **WHEN** 200 帖列表中某一张卡停留达标
- **THEN** 只有该卡的 `data-read`/背景变化；其它 199 张卡的 DOM 节点身份与属性不变，
  列表父级不因标记而重新渲染

#### Scenario: 卸载即注销
- **WHEN** 切换路由或卡片被移除
- **THEN** 对应观察目标被注销、计时器清零；跟踪集合为空时观察器断开

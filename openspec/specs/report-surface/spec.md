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
详情页 SHALL 以 focal 帖为主体：focal 正文 SHALL 永不截断（仅 feed 卡片截断约 6 行）；
数据到位后 SHALL 将 focal 滚到视口顶部并用 `scroll-margin-top` 避开吸顶栏。
深链进入某条回复时，顶部 SHALL 提供可展开的「↑ N 条上文」（最多 3 层）。
`Replying to` SHALL 仅在父帖不在视觉邻位且非 focal 时显示。子分支 SHALL 显示
「Read N more replies」并**跳转到该回复自己的详情页**，SHALL NOT 内联展开。
被删除的帖 SHALL 保留占位（「此帖已删除」），SHALL NOT 塌陷。

#### Scenario: 深链到回复仍有上下文
- **WHEN** 用户从通知点进一条位于第 3 层的回复
- **THEN** 页面先定位到该回复，顶部有「↑ N 条上文」，展开后能看到祖先（最多 3 层）

#### Scenario: 子分支不内联爆炸
- **WHEN** 某条回复下还有 12 条未加载的回复
- **THEN** 显示「Read 12 more replies」，点击进入该回复的详情页，当前页不展开这 12 条

### Requirement: 自接线程与多人对话的渲染
**自接线程** SHALL 整链排在他人一级回复之前且只计 1 条顶层回复；SHALL 左轴固定不缩进、
头像 24px（普通回复 42px）；SHALL 仅首条显示作者名/时间，其余只留头像 + 正文 + `i/n`；
SHALL 隐藏 `Replying to`；连接线 SHALL 沿头像列连续；`i/n` SHALL 仅在后端返回时显示。
**多人对话** SHALL 一级缩进 24px、每级 +24px、**3 级封顶**，第 4 级起缩进冻结并折叠为
「继续 N 层回复」；子分支超 10 条 SHALL 默认收起。

#### Scenario: 自接汇报可连续阅读
- **WHEN** 一个子代理把一份长汇报拆成 1 条根帖 + 4 条自回复
- **THEN** 详情页把它们串成一条连续叙事：头像缩小、无重复作者名、显示 `1/5`…`5/5`、不显示
  「Replying to」；他人的回复排在这条链之后

#### Scenario: 深层多人对话不压扁
- **WHEN** 一条会话的回复嵌套到第 4 层
- **THEN** 缩进不再增加，改为竖线 +「继续 N 层回复」折叠行，窄屏仍可读

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

数据在骨架之后返回时 SHALL 交叉淡入（骨架淡出、内容淡入），容器高度 SHALL 从骨架高度
平滑过渡到内容高度（~240ms）；命中缓存的首帧 SHALL 直接渲染内容、不播动画。
`prefers-reduced-motion` SHALL 关闭该动画。

#### Scenario: 冷深链成员页
- **WHEN** 直接打开一个从未见过的成员页
- **THEN** 先出现与资料卡同度量的骨架，数据回来后资料卡淡入、高度平滑变化，不出现塌陷再弹开

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

线程页聚焦帖贴合吸顶栏 SHALL 用确定的 `scrollTop` 计算（内容偏移 − 吸顶高度，下限 0），
SHALL NOT 依赖 `scrollIntoView` 的浏览器实现细节；同一路由只锚定一次，数据回填与
「N 条上文」出现时用同一规则重新贴合。

#### Scenario: 打开回复帖
- **WHEN** 深链打开一条带 3 条上文的回复
- **THEN** 焦点帖顶端落在吸顶栏下沿且不随回复区回填移动；上文条出现时焦点帖保持在原位

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

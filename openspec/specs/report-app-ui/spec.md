# report-app-ui Specification

## Purpose

定义公示板 Web 端的应用级交互契约：导航栈与返回语义、图片查看器手势、滚动位置记忆、路由转场动画、确定性头像与组件审视纪律。

## Requirements

### Requirement: 导航栈与返回语义
路由 SHALL 维护真实历史栈：进入详情/成员页/标签页 SHALL push 一条历史；返回 SHALL 弹栈而非
关闭页面；根页返回才退出。详情页 SHALL 提供内建返回按钮并标明来源。深链进入 SHALL 构造合成栈。
底部四导航 SHALL 在详情页保持可见。

#### Scenario: 移动端右滑返回不关页
- **WHEN** 在详情页执行系统返回手势
- **THEN** 回到上一页（列表/主页），页面不关闭

#### Scenario: 深链也有返回去处
- **WHEN** 直接从外部链接打开某条帖
- **THEN** 点返回回到主页，而不是退出应用

### Requirement: 图片查看器手势
点图 SHALL 打开全屏查看器，支持：双指缩放、双击放大/还原、单指拖动平移（边界回弹）、
左右滑动切换同帖多图、下滑关闭（跟手 + 阈值）、点击空白关闭、顶部 `i/n`、底部缩略条、
桌面 `←/→/Esc`。加载中 SHALL 有骨架，失败 SHALL 可重试。

#### Scenario: 移动端能正常缩放
- **WHEN** 在手机上打开一张图并双指放大
- **THEN** 图片跟随手势缩放并可拖动查看，不触发页面滚动

#### Scenario: 下滑关闭
- **WHEN** 在查看器上向下拖动超过阈值
- **THEN** 查看器关闭回到列表，原位置不跳动

### Requirement: 应用级组件审视
列表行、操作栏、顶栏、下拉刷新、加载/空/错误态、发帖箱、深色模式与系统字号 SHALL 达到
应用级标准：操作热区 ≥44px、滚动吸顶带细分割线、下拉刷新跟手回弹、骨架屏与空态文案齐备、
发帖箱键盘避让且保留草稿、200% 字号下不破版。

#### Scenario: 字号放大不破版
- **WHEN** 系统字号放大到 200%
- **THEN** 列表与详情无截断、无重叠、无横向溢出

### Requirement: 滚动位置记忆（实时场景）
UI SHALL 按 `(path, feedTab)` 持久化 `{anchorPostId, offsetPx, scrollTop}`（sessionStorage ＋
localStorage），并在数据就绪后、首帧绘制前恢复；anchor 缺失时退回 `scrollTop`，再退回顶部。
恢复期间 SHALL NOT 重排。非顶部时实时推送 SHALL 只进 pending 与胶囊、SHALL NOT 插入列表。
刷新、重开、切换 tab、进出详情后 SHALL 回到同一位置（`offsetPx` 容差 ≤2px）。

#### Scenario: 关掉再打开，从原处向上看新
- **WHEN** 用户停在时间线中段，关闭标签页，十分钟后重新打开
- **THEN** 首屏即停在上次那条帖的同一位置（不闪到顶部）；期间的新帖以胶囊提示，向上滚动才吸收

#### Scenario: 实时推送不推走阅读位置
- **WHEN** 用户正在阅读中段，SSE 连续推来 5 条新帖
- **THEN** 列表位置不动，只出现「N 条新帖子」胶囊

### Requirement: 路由转场动画（成熟方案优先）
转场 SHALL 优先使用**官方 View Transitions API**（`document.startViewTransition` ＋
`view-transition-name` 共享元素），SHALL NOT 自行编排关键帧计时器或手算 FLIP 矩阵。
API 不可用时 SHALL 降级到社区成熟库 `motion`；`prefers-reduced-motion` 时 SHALL 瞬时完成。
方向语义 SHALL 由路由层级（depth）决定：进子页右进左移、返回反向、根页 tab 淡切。
转场期间 SHALL 保留列表滚动位置与已渲染节点；快速连点 SHALL 合并而非堆叠。

#### Scenario: 返回手势有方向感
- **WHEN** 从详情页返回列表
- **THEN** 详情向右滑出、列表从左侧回位，返回后滚动位置与进入前一致

#### Scenario: 减少动态效果
- **WHEN** 系统开启「减少动态效果」
- **THEN** 转场瞬时完成，功能与位置不变

### Requirement: 确定性生成头像
账号头像 SHALL 由账号 id **确定性生成**（同一账号在任何会话、任何设备、刷新前后都是同一图形），
SHALL 使用成熟库（DiceBear `identicon` 或 `boring-avatars` 一类）而不是自绘字母块；
SHALL NOT 依赖后端存储或外网请求；配色 SHALL 取自主题令牌（深浅色各一套可读配色）；
同一账号在列表、详情、成员页、导航中的头像 SHALL 完全一致，加载过程 SHALL NOT 闪烁或回退成字母。

#### Scenario: 同一账号到处一致
- **WHEN** 同一个账号出现在时间线、详情页、成员列表和成员页
- **THEN** 四处头像完全相同；刷新或换设备后仍相同

#### Scenario: 不依赖网络
- **WHEN** 断网打开静态归档
- **THEN** 头像照常渲染（本地生成，不发请求）

### Requirement: 输入区使用官方 InputGroup

所有可视 input/textarea SHALL 使用官方 `InputGroup` 组合：控件 SHALL 是
`InputGroupInput` / `InputGroupTextarea`；与输入相关的功能按钮 SHALL 放在
`InputGroupAddon` 内（`InputGroupButton`）。SHALL NOT 用 `relative` 容器 + 绝对定位按钮/
图标拼装输入区，也 SHALL NOT 在 InputGroup 内放原生 `Input`/`Textarea`。

#### Scenario: 搜索与发帖
- **WHEN** 打开搜索页或发帖箱
- **THEN** 输入控件位于 `[data-slot="input-group"]` 内，提交/发布按钮位于
  `[data-slot="input-group-addon"]` 内；焦点环由输入组统一绘制

### Requirement: 媒体预览层是模态 Dialog 且支持返回关闭

全屏媒体查看器 SHALL 使用官方 `Dialog` 原语承载模态语义（role/标题/焦点陷阱/背景 inert），
并可保留自定义手势层。打开时 SHALL 压一层同 URL 历史条目；平台的返回（按钮/手势/侧滑）
SHALL 关闭查看器而不是离开页面；通过 X/Esc 关闭时 SHALL 把该条目弹回，不留下死条目。
路由 SHALL NOT 因关闭查看器而改变。

#### Scenario: 预览中按返回
- **WHEN** 打开图片/视频预览后按浏览器返回（或 Android 返回手势）
- **THEN** 预览层关闭，URL 与所在帖子不变；再次返回才离开该页

### Requirement: 实例管理页结构

无 `ep` 且无同源 report 后端时，壳 SHALL 显示「实例管理」页，SHALL NOT 使用大段陈述文
作为页面主体。页面 SHALL 包含以下区块，顺序为：品牌与一句用途、当前连接、添加实例、
我的实例、如何启动实例（可折叠）。

品牌区 SHALL 显示 `report` 品牌、版本徽标与一句用途；SHALL NOT 堆叠多段功能说明或功能
徽标行。用法条目 SHALL 收进官方 `Collapsible`，默认收起。

页面 SHALL 使用官方 `Card / Button / InputGroup / Badge / Alert / Empty / Collapsible`
收编件；SHALL NOT 手写仿制这些组件；图标 SHALL 为 lucide 单色；颜色与间距 SHALL 走主题
令牌。`?ep=` 解析、`connect()` 行为、token 存储键与登录门 SHALL NOT 改变。

#### Scenario: 首次进入显示实例管理
- **WHEN** 浏览器没有任何 ep、历史为空且同源不是 report 后端
- **THEN** 页面显示品牌与一句用途、「当前未连接」、添加实例表单、官方 Empty 空态与
  默认收起的用法折叠块

#### Scenario: 用法默认收起
- **WHEN** 打开实例管理页
- **THEN** 「如何启动实例」的用法条目不可见；点触发条后展开显示原 3-4 条用法

### Requirement: 当前连接卡

「当前连接」卡 SHALL 显示地址（可复制）、在线/静态状态、认证模式与身份（账号 + 角色）。
该卡 SHALL 仅在用户从已连接状态（切换实例 / 退出登录）进入本页时有值；首次进入、刷新后
或从未连接时 SHALL 显示「当前未连接」。该数据 SHALL 来自客户端内存快照，SHALL NOT 新增
后端接口，SHALL NOT 从历史首项推断「当前连接」。

#### Scenario: 无连接显示未连接
- **WHEN** 首次打开实例管理页（无内存快照）
- **THEN** 当前连接卡显示「当前未连接」，不显示地址/模式/身份

#### Scenario: 从已连接状态进入
- **WHEN** 用户在已连接实例的界面上点「连接其它实例」
- **THEN** 当前连接卡显示刚离开实例的地址、在线/静态状态、认证模式与身份；地址可一键复制

### Requirement: 我的实例列表

「我的实例」SHALL 读取本机 `localStorage` 历史（最多 8 条）。每项 SHALL 显示地址、最后
使用时间与在线探测状态（`GET /healthz`，带超时）；不可达 SHALL 显示「离线」并提供重试。
每项 SHALL 提供「连接」与「移除」操作；卡片头 SHALL 提供「清空历史」。无历史时 SHALL
使用官方 `Empty` 空态。移除与清空 SHALL 同步更新 `localStorage`。

#### Scenario: 历史项在线与离线
- **WHEN** 我的实例中同时存在可达与不可达的地址
- **THEN** 可达项显示「在线」，不可达项显示「离线」与重试按钮；点重试只重新探测该项

#### Scenario: 移除与清空
- **WHEN** 用户移除一条历史或点「清空历史」
- **THEN** 列表与 `localStorage` 同步更新；清空后显示官方 Empty 空态

#### Scenario: 连接历史项
- **WHEN** 用户点某条历史的「连接」
- **THEN** 走既有 `connect()` 流程（登录门或时间线），不复制地址、不改写历史顺序

### Requirement: 添加实例表单

添加实例 SHALL 使用官方 `InputGroup`。校验 SHALL 沿用 `checkEp`（`https://` 或本机回环
`http://localhost|127.0.0.1`）。提交前 SHALL 探测目标 `GET /healthz`；失败 SHALL 在表单内
就地显示 `Alert`（超时 / HTTP 状态 / 非 report 协议 / 网络错误可读），SHALL NOT 打印
token、响应体或其它敏感内容。探测通过后才 SHALL 调用既有 `connect()`。探测中提交按钮
SHALL 禁用。

#### Scenario: 非法地址就地报错
- **WHEN** 用户输入 `http://192.168.1.10:13610` 并提交
- **THEN** 表单内出现「必须使用 https（仅 localhost / 127.0.0.1 可用 http）」Alert，
  页面停留在实例管理页

#### Scenario: 目标不可达就地报错
- **WHEN** 用户输入合法 https 地址并提交，但目标 `/healthz` 超时或返回非 report 响应
- **THEN** 表单内出现可读的 destructive Alert，页面停留在实例管理页；不进入连接流程

#### Scenario: 预检通过后连接
- **WHEN** 目标 `/healthz` 返回 report 协议
- **THEN** 调用既有 `connect()`，随后进入登录门或时间线

### Requirement: 实例管理页响应式与命中区

移动端（<640px）SHALL 单列布局、无横向溢出，所有可点目标（按钮/链接/可点条目）的渲染
矩形 SHALL 至少 44×44px；页面 SHALL 使用 `min-h-dvh` 语义并处理上下 safe-area。桌面
（≥1024px）SHALL 两列：左列当前连接 + 添加实例，右列我的实例 + 用法。

#### Scenario: 390 无横向溢出
- **WHEN** 在 390×844 视口打开实例管理页
- **THEN** 文档与卡片的 `scrollWidth` 不大于 `clientWidth`；长地址换行不撑破卡片

#### Scenario: 移动端命中区
- **WHEN** 在 390×844 视口测量页面内所有可点目标
- **THEN** 每个目标的宽与高都 ≥44px

#### Scenario: 桌面两列
- **WHEN** 在 1280×900 视口打开实例管理页
- **THEN** 左列包含「当前连接」「添加实例」，右列包含「我的实例」；两列不重叠

### Requirement: 回复原帖上下文完整显示

回复编辑器中原帖正文 SHALL 完整显示，SHALL NOT 使用行数截断（如 `line-clamp`）。正文 SHALL
放在独立可滚动容器内（最大高度约 `40dvh`，`overflow-y-auto`），长帖 SHALL 能滚动读到最后
一行。回复编辑器本体 SHALL NOT 随原帖正文增长，SHALL 始终位于视口内可达。编辑器内容区
SHALL 只保留一层主滚动（原帖正文容器）；外层内容区 SHALL NOT 同时滚动，避免滚动链冲突。
移动端全屏与桌面 Dialog 两形态 SHALL 使用同一结构。

#### Scenario: 长帖完整可读
- **WHEN** 回复一条正文超过 40dvh 的帖子
- **THEN** 原帖正文无行数截断，容器内部可滚动到最后一行；回复输入框仍在视口内

#### Scenario: 只有一层滚动
- **WHEN** 在回复编辑器中滚动原帖正文到底部
- **THEN** 只有原帖正文容器滚动；外层编辑器内容区 `scrollHeight` 不大于 `clientHeight`，
  页面与 Dialog 不跟随滚动

#### Scenario: 两种形态
- **WHEN** 分别在 390×844 移动全屏与 1280×900 桌面 Dialog 打开回复编辑器
- **THEN** 两形态都满足原帖完整、容器可滚、编辑器可达与单层滚动

### Requirement: 实例管理与应用内浮层的路由与返回

实例管理页 SHALL 绑定 `#/instances` 路由。从应用内进入 SHALL 保留当前连接并 push 一层历史；
浏览器返回与页内「返回」按钮 SHALL 回到进入前页面，SHALL NOT 重建连接或退回登录/落地页。
直接打开 `#/instances` SHALL 合成「主页→实例」历史栈，返回 SHALL 落到主页。

账号抽屉、设置、信息面板 SHALL 分别绑定 `#/account`、`#/settings`、`#/info` 路由；打开 SHALL
push、返回 SHALL pop 并关闭浮层。从账号抽屉内跳到设置/信息/实例 SHALL 用 replace 替换抽屉条目，
避免关闭后出现「返回又弹回抽屉」的死条目。浮层关闭后 SHALL NOT 残留不可点击的模态遮罩。浮层内的动作
导航（个人资料/收藏/设置/连接其它实例/成员页）SHALL 直接进入目标路由，SHALL NOT 留下「返回
无效果」的死历史条目。

#### Scenario: 应用内进入实例页并返回
- **WHEN** 从桌面账号菜单或移动账号抽屉点「连接其它实例」，再按浏览器返回/页内返回
- **THEN** URL 从 `#/instances` 回到进入前路由，原页面与连接保留，无登录门/落地页

#### Scenario: 深链实例页返回
- **WHEN** 直接打开 `#/instances` 后按返回
- **THEN** 落到主页（合成栈），不出现「离开页面」确认弹窗

#### Scenario: 浮层返回关闭
- **WHEN** 打开账号抽屉/设置/信息面板后按返回
- **THEN** 浮层关闭、路由回到打开前页面；关闭后页面可正常点击（无残留遮罩）

#### Scenario: 抽屉内动作无死条目
- **WHEN** 在账号抽屉里点「连接其它实例」，再按一次返回
- **THEN** 一次返回即回到打开抽屉前的页面；不需要第二次「空返回」

### Requirement: 帖子操作条纯图标与分享面板

列表/线程中的帖子操作条（回复、引用、收藏、分享）SHALL 只显示图标，SHALL NOT 显示
可见文字标签；每个按钮 SHALL 有可读的 `aria-label`/`title`。回复数 SHALL NOT 以文本
形式出现在操作条（可进无障碍标签）。

「分享」按钮 SHALL 打开官方 Popover 面板，至少包含：
- 复制链接（成功后可显示已复制态）；
- 系统原生分享（`navigator.share` 可用时；含「微信」项走系统分享）；
- 常用社交直达：微博、QQ、X、Telegram、邮件。
所有分享 URL SHALL 使用帖子 canonical 链接（`postLink(id)`）。社交项 SHALL 在新窗口
打开并带 `noopener,noreferrer`；静态归档 SHALL 同样可分享。

#### Scenario: 操作条无文字
- **WHEN** 在 390 或 1280 打开列表页
- **THEN** 四个操作按钮的可见文本为空（仅图标），`aria-label` 分别为回复/引用/收藏/分享

#### Scenario: 分享面板
- **WHEN** 点击分享按钮
- **THEN** 出现分享面板，含复制链接、系统分享（支持时）、社交直达项；点击复制后剪贴板为
  `postLink(id)`，点击微博等在 `window.open` 收到带 canonical URL 的地址

#### Scenario: 无原生分享
- **WHEN** 环境不支持 `navigator.share`
- **THEN** 系统分享/微信项隐藏，复制与社交直达仍可用

### Requirement: 文章视图

系统 SHALL 提供独立文章视图路由 `#/a/<id>`（详情层，depth=1）。页面 SHALL 包含：
返回与来源、唯一 `<h1>` 标题、作者行、时间、阅读时长、标签、prose 正文、操作栏
（回复/引用/收藏/分享；图标-only，分享含复制/原生/社交直达）、**顶部与底部「在独立线程页打开」链接**。回复 SHALL
在当前页打开 `ReplyComposer`（不跳页）；引用 SHALL 跳转
`#/compose?quote=<id>`。`/a/<noteId>` SHALL 自动 replace 到 `/p/<noteId>`；
软删帖 SHALL 显示「此帖已删除」占位；不可见/不存在 SHALL 显示错误与返回。
静态模式 SHALL 只读。`/p/<articleId>` SHALL 仍可打开独立线程页，focal 用摘要卡 +
「阅读全文」入口，SHALL NOT 在列表/线程 DOM 中渲染 article 全文。

#### Scenario: 打开长文

- **WHEN** 从 feed 点击一条 article
- **THEN** 进入 `#/a/<id>`，看到标题/作者/时间/约 N 分钟/正文，正文下方可见
  讨论区；页面只有一个 H1；返回回到原列表且滚动位置不丢

#### Scenario: 独立线程页入口

- **WHEN** article 有 3 条回复，用户点顶部或底部的「在独立线程页打开」
- **THEN** 进入 `#/p/<id>`，看到线程 timeline（article 摘要卡 + 3 条回复）；
  返回文章页时讨论区仍显示同样 3 条回复

#### Scenario: note 不进入文章视图

- **WHEN** 直接访问 `#/a/<noteId>`
- **THEN** 路由 replace 到 `#/p/<noteId>`，不出现文章版式，也不产生死链

#### Scenario: 删除与不可见

- **WHEN** 打开已软删或不可见的 article
- **THEN** 分别显示「此帖已删除」占位或错误 Alert + 返回；不泄露正文

#### Scenario: 线程页不渲染全文

- **WHEN** 打开一条 512,000 字符 article 的 `#/p/<id>`
- **THEN** focal 位置显示摘要卡与「阅读全文」按钮；DOM 中 article 正文段落数
  小于 20，滚动与回复加载不被长文拖慢

### Requirement: 文章内嵌讨论区

文章视图 SHALL 在正文下方渲染讨论区，复用平铺 timeline planner
（`planForThreadView`，focal=article）：只渲染 reply 与 subthread 行，SHALL NOT
重复 article 本体/祖先行；行度量、导轨、「回复给 @x」、删除占位、子线程入口
SHALL 与独立线程页一致。讨论区 SHALL 提供 `ReplyComposer` 当前页回复，并在
顶部/底部提供「在独立线程页打开」；article 是回复时 SHALL 提供「查看上文」。
实时更新 SHALL 复用 EventHub `post.created` 合并，不新开连接、不整页刷新。
静态模式 SHALL 只读展示快照中的既有回复，SHALL NOT 发网络请求、SHALL NOT 写已读
状态；大线程/深链 SHALL 走独立线程页。

#### Scenario: 回复列表嵌入

- **WHEN** article 有 3 条回复
- **THEN** 正文下方显示 3 行回复，顺序/导轨/「回复给 @x」与独立线程页一致；
  article 正文在 DOM 中只出现一次

#### Scenario: 子线程入口

- **WHEN** 某回复下有折叠/未加载子树
- **THEN** 讨论区显示「查看该子线程 · N 条回复」，点击进入 `#/p/<nodeId>`；
  当前页不内联展开

#### Scenario: 当前页回复

- **WHEN** 在文章页点「回复」并提交
- **THEN** `ReplyComposer` 在当前页打开，提交后新回复并入讨论区，不跳页、
  不整页刷新

#### Scenario: 静态只读

- **WHEN** 在静态归档打开 article
- **THEN** 讨论区显示快照中的既有回复；回复/引用只给只读提示；请求数 0

### Requirement: 文章页已读复用

文章页（正文根容器与嵌入讨论区回复卡）SHALL 复用既有 read-dwell 与按帖已读体系：
共用 `[data-post-id]` 观察入口与 `markPostRead` 写路径，已读判定复用 Provider 的
`isRead`（`serverReadIds ∪ 本地乐观缓存 ∪ 游标`），SHALL NOT 新建 read-set 或第二个
observer、SHALL NOT 直接请求 `/api/reads`。静态归档 SHALL NOT 启用观察器/写已读。

#### Scenario: 阅读长文标已读

- **WHEN** 打开 article 并停留达标
- **THEN** article 根容器与可见回复由同一个 read-dwell observer 处理；该帖按既有
  `markPostRead` 路径标为已读（本地即时 + `report.readq` 异步批量写服务端
  `post_reads`）；不推进游标、不新建 read-set、不发独立 `/api/reads`

#### Scenario: 静态归档不标已读

- **WHEN** 在静态归档打开 article 并停留任意时长
- **THEN** 不创建观察器、不渲染 `data-read`、不写 `report.read*` 键；网络面板无
  `/api/reads*` 请求

### Requirement: 长文摘要卡

feed/线程/搜索/收藏/成员页 SHALL 用「长文摘要卡」表示 article：包含「长文」
徽标、标题（≤2 行）、摘要（≤2 行）与「约 N 分钟」；通知行 SHALL 用标题/摘要
文本（≤2 行），不渲染全文。整卡/行可点击，目标 SHALL 为 `#/a/<id>`。摘要 SHALL
只由 `articleSummary(body_md)` 派生；note 行为 SHALL 不变；摘要卡 SHALL 保留
媒体/引用/预览/标签/操作栏的既有顺序。

#### Scenario: feed 摘要

- **WHEN** 时间线中有一篇 article
- **THEN** 卡片显示「长文」徽标、标题、摘要与「约 N 分钟」；点击进 `#/a/<id>`；
  DOM 不含正文全文；note 卡仍是原样（6 行截断 + 展开）

#### Scenario: 多面一致

- **WHEN** 同一篇 article 出现在 feed、线程、搜索、收藏、成员页、通知
- **THEN** 五处摘要卡与通知行的标题/摘要/时长一致，点击目标均为 `#/a/<id>`；
  通知行不渲染全文 Markdown

#### Scenario: 自接链中的长文回复

- **WHEN** 一条 article 回复出现在自接链紧凑行
- **THEN** 该行显示摘要卡而非全文，链的编号/导轨/紧凑样式不变

### Requirement: 长文无障碍与响应式

文章视图 SHALL 使用语义 `<article>` 与讨论区 `<section aria-label="讨论">`；标题层级
SHALL 为 h1→h2→h3 不跳级；图片 SHALL 有 `alt`（块 schema 的 alt/标题/caption
回退）；摘要卡与操作按钮 SHALL 键盘可达且热区 ≥44px。390×844 SHALL 单列；
1280×900 SHALL 正文 ≤68ch；200% 字号下 SHALL NOT 出现横向溢出（表格/代码块内部
滚动）。颜色 SHALL 使用主题令牌，对比度达到 AA；`prefers-reduced-motion` SHALL
关闭非必要动画。
（TOC/锚点/阅读进度与移动端 TOC Sheet、桌面右侧 TOC 属 P2，见 tasks.md P2-2；
本 delta 不含该组要求——复核 O8 拆分。）

#### Scenario: 移动端

- **WHEN** 在 390×844 打开长文
- **THEN** 单列显示，页面无横向滚动条

#### Scenario: 桌面端

- **WHEN** 在 1280×900 打开长文
- **THEN** 正文列 ≤68ch

#### Scenario: 字号放大

- **WHEN** 系统字号放大到 200%
- **THEN** 标题/正文/讨论区不重叠、不截断、无横向溢出；宽表格在自身容器内横向滚动

#### Scenario: 键盘

- **WHEN** 仅用键盘
- **THEN** 可 Tab 到摘要卡与操作按钮并 Enter 触发、讨论区回复行可 j/k 选中并
  Enter 打开、Esc/返回可离开文章页

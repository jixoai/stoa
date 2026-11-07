# report-app-ui Specification

## Purpose
TBD - created by archiving change report-app-grade. Update Purpose after archive.

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

# report-app-ui（delta）

## ADDED Requirements

### Requirement: 文章视图

系统 SHALL 提供独立文章视图路由 `#/a/<id>`（详情层，depth=1）。页面 SHALL 包含：
返回与来源、唯一 `<h1>` 标题、作者行、时间、阅读时长、标签、prose 正文、操作栏
（回复/引用/收藏/复制链接）、**顶部与底部「在独立线程页打开」链接**。回复 SHALL
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
article 根容器与回复卡 SHALL 共用 read-dwell 的 `[data-post-id]` 观察目标/
注册入口，SHALL NOT 另建 observer。静态模式 SHALL 只读展示快照中的既有回复，
SHALL NOT 发网络请求；大线程/深链 SHALL 走独立线程页。

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

#### Scenario: read-dwell 共存

- **WHEN** 打开 article 并停留达标
- **THEN** article 根容器与可见回复由同一个 read-dwell observer 处理；
  不出现第二个 observer、不推进服务端游标

#### Scenario: 静态只读

- **WHEN** 在静态归档打开 article
- **THEN** 讨论区显示快照中的既有回复；回复/引用只给只读提示；请求数 0

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

### Requirement: 目录、锚点与阅读进度

文章视图 SHALL 从 Markdown headings 自动生成目录（少于 2 个标题时不显示），
SHALL NOT 提供 `fde2e:toc` 块；标题 SHALL 有确定性锚点 id：纯文本 → NFKC →
小写 → 非 `[a-z0-9\u4e00-\u9fff-]` 替换为 `-` → 合并/去首尾 → 截断 64 码点 →
空串为 `section`；重复标题 SHALL 依次加 `-2`、`-3`。
目录 SHALL 是 `<nav aria-label="目录">`，点击 SHALL 滚动到标题且不被吸顶头遮挡
（`scroll-margin-top`）。页面 SHALL 支持 `?s=<slug>` 深链定位（未知 slug 忽略）。
阅读进度 SHALL 以滚动比例 0..1 单调更新，并用 `role="progressbar"` 暴露；
active 目录项 SHALL 随滚动切换。`prefers-reduced-motion` 下所有滚动 SHALL 瞬时。

#### Scenario: 自动生成 TOC

- **WHEN** article 含 2 个以上 H2/H3
- **THEN** 目录自动出现；DOM 中不存在 `fde2e:toc` 块或专用 toc 渲染器；
  少于 2 个标题时不渲染空目录

#### Scenario: 重复标题锚点

- **WHEN** 文章有三个同名 H2「结果」
- **THEN** 锚点依次为 `结果`、`结果-2`、`结果-3`；目录三项各自跳到正确位置

#### Scenario: 深链定位

- **WHEN** 打开 `#/a/<id>?s=<slug>`
- **THEN** 页面滚动到对应标题，标题顶边在吸顶头下沿 ±4px；未知 slug 时停在顶部

#### Scenario: 阅读进度

- **WHEN** 从文章顶部滚到底部
- **THEN** 进度条从 0 到 1 单调变化；目录 active 项从第一节切到最后一节

#### Scenario: 减少动态

- **WHEN** `prefers-reduced-motion: reduce` 下点击目录或深链
- **THEN** 滚动瞬时完成，无平滑动画

### Requirement: 长文无障碍与响应式

文章视图 SHALL 使用语义 `<article>` 与 `<nav aria-label="目录">`；标题层级
SHALL 为 h1→h2→h3 不跳级；图片 SHALL 有 `alt`（块 schema 的 alt/标题/caption
回退）；TOC 链接、摘要卡与操作按钮 SHALL 键盘可达且热区 ≥44px。390×844 SHALL
单列、TOC 收起为 Sheet；1280×900 SHALL 正文 ≤68ch + 右侧 TOC；200% 字号下
SHALL NOT 出现横向溢出（表格/代码块内部滚动）。颜色 SHALL 使用主题令牌，
对比度达到 AA；`prefers-reduced-motion` SHALL 关闭非必要动画。

#### Scenario: 移动端

- **WHEN** 在 390×844 打开长文
- **THEN** 单列显示，目录以「目录」按钮打开 Sheet，页面无横向滚动条

#### Scenario: 桌面端

- **WHEN** 在 1280×900 打开长文
- **THEN** 正文列 ≤68ch，右侧目录 sticky 可见，滚动时 active 项更新

#### Scenario: 字号放大

- **WHEN** 系统字号放大到 200%
- **THEN** 标题/正文/目录不重叠、不截断、无横向溢出；宽表格在自身容器内横向滚动

#### Scenario: 键盘

- **WHEN** 仅用键盘
- **THEN** 可 Tab 到目录项并 Enter 跳转、Tab 到操作按钮并 Enter 触发、
  Esc/返回可离开文章页

# report-static-mode Specification

## Purpose

定义静态归档模式：复用同一份前端、模式判定与只读 mock、只读界面表现、归档携带收藏 id、静态归档不启用视窗停留已读。

## Requirements

### Requirement: 静态产物复用同一份前端
`export` SHALL 使用与线上**同一份前端构建**产出静态站：`index.html` 内联
`<script type="application/json" id="report-snapshot">` 数据快照 ＋ 相对引用的 `assets/`
与 `media/`。快照 SHALL 不含任何 token、密钥或后端地址。

#### Scenario: 归档与线上是同一个应用
- **WHEN** 用 `file://` 打开导出的 `index.html`
- **THEN** 界面与线上完全一致（同样的组件与交互），只是数据来自内联快照

### Requirement: 模式判定
前端 SHALL 按以下顺序判定：`?ep=` 存在 → 后端模式；无 `ep` 且页面内存在快照 → **静态模式**；
两者皆无 → 「连接实例」落地页。

#### Scenario: 静态模式无歧义
- **WHEN** 打开导出的归档且 URL 不带 `ep`
- **THEN** 直接进入静态模式，不弹"连接实例"

### Requirement: 只读 mock 接口
静态模式 SHALL 在客户端安装只读 API mock：所有读接口（healthz/read/feed/profile/search/who）
SHALL 从快照返回，分页与游标语义 SHALL 与后端一致；所有写操作（POST/PUT/DELETE）SHALL 返回
`{ok:false,error:"静态归档是只读的",code:"READ_ONLY"}` 且 **SHALL NOT 发出任何网络请求**。

#### Scenario: 写操作被明确拒绝
- **WHEN** 在静态模式下尝试发帖
- **THEN** 请求不发生网络调用，界面提示只读，不产生任何本地假数据

### Requirement: 只读的界面表现
静态模式 SHALL 显示「静态归档 · 只读」标识，并 SHALL 隐藏或禁用发帖、回复、引用、关注、
上传等写入口。

#### Scenario: 一眼看出是归档
- **WHEN** 打开静态归档
- **THEN** 顶部有只读标识，发帖按钮不可用

### Requirement: 归档携带收藏 id

静态归档快照 SHALL 携带导出 viewer 的 `bookmarks: string[]`；静态壳的收藏页 SHALL 从快照
渲染该列表，收藏/取消 SHALL 给只读提示且 SHALL NOT 发起写请求。

#### Scenario: 打开归档的收藏页
- **WHEN** 在 `file://` 归档里打开账号抽屉 → 收藏
- **THEN** 看到导出时的收藏列表（可能为空），点收藏按钮只给只读提示

### Requirement: 静态归档不启用视窗停留已读

静态归档模式 SHALL NOT 启用视窗停留已读：SHALL NOT 创建 `IntersectionObserver`、SHALL NOT
写 `localStorage` 的已读集合、SHALL NOT 在帖子卡片上渲染未读高亮或 `data-read` 属性。
静态归档没有通知列表/未读角标，已读状态没有消费者；其唯一语义仍是「导出时的只读快照」。

#### Scenario: file:// 打开归档
- **WHEN** 断网后双击导出的 `index.html`（`file://`）并停留任意时长
- **THEN** 页面不创建观察器、不写已读集合；帖子卡片无未读底色、无 `data-read`；
  界面与既有只读归档一致

#### Scenario: 静态模式诊断
- **WHEN** 在静态归档中读取运行诊断
- **THEN** 停留引擎为禁用态（`enabled=false`、`observers=0`），且无任何 `report.read.*`
  localStorage 写入

### Requirement: 静态归档不发起已读同步

静态归档模式 SHALL NOT 发起任何已读同步：SHALL NOT 调用 `GET /api/reads`、
`POST /api/reads`、`POST /api/reads/batch`；SHALL NOT 创建已读重试队列；SHALL NOT 写
`report.read*` 系列 localStorage 键（缓存与队列都不写）。`StaticReportClient` 的已读方法
SHALL 在客户端层直接失败（写方法抛 `READ_ONLY`）或返回空（查询），SHALL NOT 经过 fetch。

导出快照 MAY 携带 `read`/`read_at` 字段（向后兼容的纯增字段），但静态 UI SHALL NOT 用它们
渲染未读高亮或 `data-read`：归档没有服务端、没有通知角标，已读状态没有消费者。

#### Scenario: file:// 打开归档零已读请求
- **WHEN** 断网后双击导出的 `index.html`（`file://`）并浏览/停留任意时长
- **THEN** 网络面板无 `GET/POST /api/reads*` 请求；localStorage 无 `report.read` /
  `report.readq` 键；卡片无未读底色、无 `data-read`

#### Scenario: 旧快照缺字段
- **WHEN** 打开由旧版本导出的快照（无 `read`/`read_at` 字段）
- **THEN** 所有帖子按 `read=false` 处理，界面与升级前归档完全一致；不报错

#### Scenario: 遗留队列不触发写
- **WHEN** 同一 origin 的 localStorage 里残留活跃会话产生的已读重试队列，随后打开静态归档
- **THEN** 队列不被 flush、不被修改；静态页面不产生任何写请求或后台重试

### Requirement: 静态归档中的长文

静态导出快照 SHALL 携带每条帖的 `kind` 与 `body_md`；SHALL NOT 预渲染 HTML 或
另存 blocks 数组——指令块 SHALL 由客户端用与线上相同的 `parseArticle` 解析。
静态归档 SHALL 支持 `#/a/<id>` 文章视图、摘要卡、P1 四块与 P2 gallery/log
（未知块降级）、**正文下方嵌入讨论区（只读展示快照中的既有回复）**、
TOC/进度（P2）与图片/图集查看；所有媒体 SHALL 走归档相对路径
（`media/<hash>.<ext>`）。
静态模式 SHALL NOT 发起任何网络请求（无 `/api/*`、无字体/CDN），SHALL NOT 启动
服务端解析/抓取/worker。写操作 SHALL 只读提示。

#### Scenario: file:// 打开长文

- **WHEN** 断网后双击导出目录的 `index.html`，打开一条 article
- **THEN** 文章视图正常显示标题/正文/四块/图片/讨论区回复；TOC（P2）可跳转；
  请求数 0（仅本地文件）

#### Scenario: 块在客户端解析

- **WHEN** 归档中的 article 含 stats/steps/compare/callout 与未知块
- **THEN** 四块正常渲染，未知块降级占位；快照中没有预渲染 HTML

#### Scenario: 静态 log/gallery

- **WHEN** 归档中的 article 含 `fde2e:log` 与 `fde2e:gallery`
- **THEN** log 原生 details 默认收起、打印展开、浏览器搜索命中；gallery 可
  横向滚动读取全部图片并支持键盘；展开/切换不改变路由与滚动位置；请求数 0

#### Scenario: 静态 Markdown 扩展

- **WHEN** 归档中的 article 含 task list、footnote、figure caption
- **THEN** 三者按 P2 规则渲染；无对应语法时与升级前一致；请求数 0

#### Scenario: 静态讨论区只读

- **WHEN** 静态归档中的 article 有 3 条回复
- **THEN** 正文下方显示 3 行只读回复（与线程页同度量/顺序）；
  「在独立线程页打开」可用；回复/引用只给只读提示，0 网络请求

#### Scenario: 只读

- **WHEN** 在静态文章页点回复/引用/收藏/上传
- **THEN** 只给「静态归档 · 只读」提示，不发网络请求、不写本地假数据

### Requirement: 静态长文不启用已读

静态归档中的文章页 SHALL NOT 建 read-dwell 观察器、SHALL NOT 渲染 `data-read`、
SHALL NOT 写 `report.read*` 队列/缓存、SHALL NOT 请求 `/api/reads*`。快照 MAY 携带
既有 `read`/`read_at`（向后兼容的纯增字段），但 SHALL NOT 被消费渲染未读态。

#### Scenario: 长文页不启用已读

- **WHEN** 在静态归档中打开 article 并停留任意时长
- **THEN** 不创建 read-dwell 观察器、不渲染 `data-read`、不写 `report.read*` 键；
  网络面板无 `/api/reads*` 请求

### Requirement: 旧归档兼容

不含 `kind` 的旧快照 SHALL 按 `note` 处理；旧归档中的帖子 SHALL 继续按现有
时间线/线程/搜索渲染，SHALL NOT 因缺少字段报错或白屏。旧归档里的 article
（若未来回填 `kind`）SHALL 无需重新导出即可使用文章视图。

#### Scenario: 旧快照无 kind

- **WHEN** 打开升级前导出的归档（`SnapshotPost` 无 `kind`）
- **THEN** 所有帖按 note 渲染，时间线/线程/搜索行为与升级前一致；无 console error

#### Scenario: 旧归档中的长文回填

- **WHEN** 旧快照被人工/工具补上 `kind:"article"`
- **THEN** 该帖自动获得摘要卡与 `#/a/<id>` 文章视图，无需重新构建前端

### Requirement: 归档体积与安全

静态快照 SHALL 只在 `body_md` 中保存一次 article 内容，SHALL NOT 重复保存渲染
结果；内联 JSON SHALL 继续转义 `<`、U+2028、U+2029，保证 `</script>` 不截断。
单篇 512,000 字符 article 的归档体积增长 SHALL 与正文大小线性相关，不产生
额外渲染副本。

#### Scenario: 无重复内容

- **WHEN** 导出一篇 512,000 字符 article
- **THEN** `index.html` 中该正文只出现一次（`body_md`），不存在第二份 HTML 副本

#### Scenario: script 不截断

- **WHEN** article 正文含 `</script><script>alert(1)</script>`
- **THEN** 快照 JSON 解析成功，页面正常渲染，脚本不执行

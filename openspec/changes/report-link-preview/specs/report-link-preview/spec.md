# report-link-preview（delta）

## ADDED Requirements

### Requirement: 持久化预览字段

帖子视图 SHALL 携带持久化字段 `previews: PreviewLink[]`（0..3，按正文出现顺序；首条为初始页，不设主卡），每条 SHALL
至少包含 `url/final_url/label/kind/mime/title/description/site_name/cover{url,w,h,kind}/
status/phase/fields_ready/cache_key/attempts/updated_at/error_code`。`status` SHALL 为
`pending|partial|ready|failed` 之一。该字段 SHALL 从 `post_previews` 表读取，SHALL NOT 在
读路径临时抓取或派生；静态导出 SHALL 原样包含该字段。该字段 MAY 被 worker 多阶段多次更新
（标题/描述→封面等），SHALL NOT 视为“抓取一次即冻结”的最终快照。

#### Scenario: 刷新后字段仍在

- **WHEN** 一个已 ready 的帖子被刷新/重启服务后再次读取
- **THEN** `previews` 仍返回相同字段与正文顺序，不触发抓取

#### Scenario: 字段可多次更新

- **WHEN** worker 先完成 meta 阶段、后完成 cover 阶段
- **THEN** 同一 `PreviewLink` 的 `updated_at/phase/fields_ready/cover` 被原地更新，
  `post.updated` 事件按阶段推送

#### Scenario: 无链接帖为空数组

- **WHEN** 帖子正文没有可预览链接
- **THEN** `previews` 为 `[]`，不产生占位卡

### Requirement: 写入路径与任务入队

帖子/回复提交 SHALL 在 `commitOps` 同一事务内抽取 `http/https` URL、计算
`cache_key`、upsert `post_previews(status=pending, phase=queued, fields_ready=[])`，并
upsert `preview_jobs(status=queued)`；帖子 SHALL 立即返回，SHALL NOT 等待抓取。抽取失败
SHALL NOT 阻断发帖。插件关闭时 SHALL NOT 抽 URL、不建行、不入队。

#### Scenario: 发帖立即返回

- **WHEN** 发布含 3 个链接的帖子
- **THEN** HTTP 响应包含 `previews` 三条 `pending`，响应不等待任何外网请求

#### Scenario: 抽取失败不阻断

- **WHEN** 正文触发抽取器病理输入并抛错
- **THEN** 帖子仍提交成功（`previews=[]`），错误只记服务端日志

### Requirement: 异步持久化 worker

系统 SHALL 使用 SQLite `preview_jobs` 作为持久化任务队列：重启后 SHALL 续跑，`running`
残留 SHALL 重置为 `queued`；单实例锁 SHALL 防止多进程并发 claim；任务选择 SHALL 按
`post_created_at DESC`（最新优先）再按 `enqueued_at`；全局并发 SHALL ≤3、每域名 ≤1；
失败 SHALL 按 5m→15m→1h→6h→24h 指数退避。任务 SHALL 按 `(post_id,url_hash)` 去重；
cacheKey 变化 SHALL 原地重置该任务而不是新增行。

#### Scenario: 新帖先处理

- **WHEN** 队列里同时有旧帖与新帖任务
- **THEN** worker 先 claim 新帖；旧帖在后续轮次处理

#### Scenario: 重启续跑

- **WHEN** worker 处理到一半进程被 kill 并重启
- **THEN** 未完成任务继续执行，不丢失、不新增重复任务

#### Scenario: 去重

- **WHEN** 同一帖同一 URL 被扫描/提交重复入队
- **THEN** `preview_jobs` 仍只有一行

### Requirement: 多阶段状态机

worker SHALL 按 provider `phases()` 的顺序逐阶段处理；每阶段 SHALL 只写该阶段拥有的字段、
更新 `phase/fields_ready/updated_at`，并在同一事务插入一条 `post.updated` 事件。状态 SHALL
按 `pending→partial→ready` 推进；首次处理失败且无可用字段 SHALL 置 `failed`。重处理
（cacheKey 变化）失败 SHALL 保留旧字段与旧 `ready/partial`，SHALL NOT 把已展示卡片降级。

#### Scenario: 标题先于封面

- **WHEN** 页面预览进入 `meta` 阶段
- **THEN** 标题/描述/站点名先写入并推送，`status=partial`；后续 `cover` 阶段完成才
  `ready`

#### Scenario: 重处理失败保留旧值

- **WHEN** 插件升版本后重处理某 URL 失败
- **THEN** 该帖仍显示旧卡片字段，job 退避重试，不变成 failed/纯链接

### Requirement: post.updated 事件与推送

系统 SHALL 新增事件类型 `post.updated` 并存 `events` 表；payload SHALL 含 `post_id`、
`root_id`、`phase`、`status` 与该帖最新 `previews` 数组，SHALL NOT 含正文。`post.updated`
SHALL NOT 加入 `NOTIFICATION_TYPES`；通知列表、history、未读计数、CLI
`wait-notifications` SHALL NOT 返回/统计它。客户端 EventHub SHALL 增加 `post.updated`
topic，并按 `updated_at`/`seq` 幂等合并对应帖的 `previews`（逐条 `position/url` 比较），
SHALL NOT 整页刷新或重排 feed。

#### Scenario: 无刷新实时更新

- **WHEN** worker 写入 `meta` 阶段字段
- **THEN** 前端在 2s 内收到 `post.updated` 并原地显示标题/描述，feed 不重新请求、不重排

#### Scenario: 通知不受影响

- **WHEN** 一条帖子的预览从 pending 走到 ready
- **THEN** 通知列表/未读数/CLI 输出均无 `post.updated`；只有 `post.created` 等通知事件

### Requirement: cacheKey 与失效

`cache_key` SHALL 为
`sha256(plugin_id + plugin_version + rules_version + canonical_url + sha256(body_md))` 的
hex。插件 id/版本、rulesVersion、URL 或正文变化 SHALL 使 key 变化；系统 SHALL 扫描
`post_previews` 中 key 不匹配的帖子，按 `post_created_at DESC` 入队，SHALL NOT 立即抓取、
SHALL NOT 清空字段/缓存、SHALL NOT 影响已展示旧值。任务按 `(post_id,url_hash)` 去重。

#### Scenario: 插件升版本

- **WHEN** 插件版本从 1.0.0 升到 1.1.0
- **THEN** 旧帖与新帖都被倒序入队；旧卡片在新阶段覆盖前保持旧值

#### Scenario: 同版本重开

- **WHEN** 插件关闭后以同一版本重新打开
- **THEN** 已有 `post_previews` 的帖子不重新入队，卡片直接恢复

### Requirement: 插件启停

插件关闭 SHALL 停止 URL 抽取、任务入队与 worker 抓取，并 SHALL 让所有帖子（含旧帖）隐藏
预览卡片；已持久化字段 SHALL 保留。重新打开 SHALL 扫描缺字段/cacheKey 不匹配的帖子并按
时间倒序入队；同版本已有字段 SHALL 直接恢复。开关 SHALL 通过
`PATCH /api/plugins/:id` 持久化，仅 owner/manager 可改，并广播 `plugin.updated` 控制帧。

#### Scenario: 关闭全部隐藏

- **WHEN** owner 关闭 `link-preview` 后打开新帖与旧帖
- **THEN** 两者都不显示卡片、0 出站请求、0 新入队；`post_previews` 行仍在

#### Scenario: 打开后台补旧帖

- **WHEN** 关闭期间产生的旧帖在插件重新打开后被访问
- **THEN** 系统按 cacheKey/缺字段倒序入队，worker 后台补齐，卡片逐步出现

### Requirement: 静态导出

`export` SHALL 从 `post_previews` 读取并原样写入快照的 `previews`（含 pending/partial/
ready/failed）；导出路径 SHALL 只读，SHALL NOT 启动 worker、入队或抓取。静态壳 SHALL 原样
读取 previews，SHALL NOT 发网络请求；静态 UI SHALL 只把 `ready/partial` 渲染为卡片，
`pending/failed` SHALL 渲染为纯链接（静态无 worker，pending 不会自行完成）。

#### Scenario: 离线归档有卡片

- **WHEN** 用 `file://` 打开导出归档
- **THEN** ready/partial 帖子显示与线上相同的卡片；0 网络请求；pending/failed 为普通链接

#### Scenario: 导出无副作用

- **WHEN** 执行 `export`
- **THEN** 不产生 `preview_jobs`、不发起抓取、不修改 `post_previews`

### Requirement: 链接抽取范围

插件启用时，系统 SHALL 在写入事务内用 markdown 语法树抽取 `http/https` URL；SHALL 跳过
fenced code block、行内 code 与图片；SHALL 接受 markdown link href 与纯文本裸 URL；
SHALL 保留链接文字作为 title 回退（裸 URL 为 null）。抽取 SHALL 纯本地、SHALL NOT 发起
网络请求；失败 SHALL NOT 阻断帖子写入。

#### Scenario: 代码块与图片跳过

- **WHEN** 代码块、行内 code、图片链接各有 URL，正文另有一个裸 URL
- **THEN** 只索引正文裸 URL，代码/图片不产生预览

#### Scenario: 链接文字回退

- **WHEN** 正文为 `[报告](https://example.com/r)`
- **THEN** fallback title 为 `报告`，URL 为规范化后的地址

### Requirement: URL 规范化与上限

URL SHALL 规范化后去重：scheme/host 小写、去 fragment、去默认端口、去除 `utm_*`/
`fbclid`/`gclid`/`yclid`/`mc_cid`/`mc_eid`/`igshid`，SHALL NOT 排序其余 query。每帖 SHALL
最多 3 条；单个 URL >2048 字符 SHALL 丢弃而不是截断；label/title 回退 SHALL 截断 200 字符。

#### Scenario: 同 URL 去重

- **WHEN** 同一帖子出现带 utm/fragment 与不带参数的同一 URL
- **THEN** 只保留一条规范化 URL

#### Scenario: 每帖上限

- **WHEN** 帖子含 4 个不同链接
- **THEN** 只入队/展示前 3 条，第 4 条 0 请求

### Requirement: 抓取与 MIME 分流

抓取 SHALL HEAD 优先、GET 回退（HEAD 405/501/网络错误/缺 content-type 时回退）；MIME SHALL
以魔数优先、`Content-Type` 次之、扩展名最后，分流 `page/image/video/audio/document/unknown`。
页面正文 SHALL ≤512KiB；媒体 SHALL 只读前 512B（忽略 Range 最多 64KiB）。抓取 SHALL 有
3s HEAD/8s 总截止/5 跳重定向；`Content-Length >2MiB` SHALL 直接 `blocked_size`。请求 SHALL
使用 `Accept-Encoding: identity`、固定 UA，SHALL NOT 发 Cookie/Authorization/Referer。

#### Scenario: 页面阶段

- **WHEN** 链接是 HTML 页面
- **THEN** 先 `meta` 阶段写标题/描述/站点名，再 `cover` 阶段写封面/ready

#### Scenario: 图片/视频/文档

- **WHEN** 链接分别是 PNG/MP4/PDF
- **THEN** `probe` 阶段返回 kind/mime（图片 P2 再加 crop），卡片可点

### Requirement: 字符集与元数据

字符集 SHALL 按 `Content-Type charset` → `<meta charset>` → UTF-8；非法序列替换；文本
截断按字符。元数据 SHALL 按 OG → Twitter Card → `<title>`/meta description → `article/main`
首段（≥40 字，≤400 字）→ favicon；标题 ≤200、描述 ≤400、站点名 ≤100；封面 SHALL 为绝对
http/https、≤2048，SVG SHALL NOT 作为封面。

#### Scenario: OG 完整

- **WHEN** 页面含完整 OG
- **THEN** title/description/site_name/cover 取 OG；cover 含 url/w/h（类型为 og/crop）

#### Scenario: GBK 页面

- **WHEN** `Content-Type: text/html; charset=gbk`
- **THEN** 中文标题正确，不出现乱码

### Requirement: 4:3 图片封面（P2/P3）

图片链接的 `cover` SHALL 支持插件生成的 **4:3 重心裁剪件**：`cover.url` 可为
`/api/media/<hash>`，`cover.w/h` 为裁剪后尺寸；该阶段 SHALL 使用与抓取相同的 SSRF/体积/
超时限制，SHALL 拒绝 SVG/解码炸弹；裁剪件 SHALL 随静态导出的 `media/` 一起复制。P1 字段/
阶段模型 SHALL 已容纳，P2 才实现下载与裁剪。

#### Scenario: 图片裁剪

- **WHEN** 一个 4:3 裁剪阶段完成
- **THEN** 卡片显示 `/api/media/<hash>` 封面，w/h 为 4:3；本地/静态均可加载

#### Scenario: 裁剪失败

- **WHEN** 图片下载超时或解码失败
- **THEN** `probe` 已写字段保留，`error_code=crop_failed`，卡片不毁

### Requirement: SSRF 地址校验

抓取 SHALL 仅接受 `http/https`；拒绝 userinfo、空 host、单标签 host、
`.local/.internal/.home.arpa/.lan`、含 `%`/控制字符 host。端口默认只允许 80/443；管理端口
永远拒绝。DNS 解析后 SHALL 对所有 A/AAAA 答案做地址分类，任一命中私网/回环/链路本地/
组播/保留/文档/元数据（含 `169.254.169.254`）即拒绝整个 host；SHALL 校验 IPv4-mapped/
NAT64/6to4 的内嵌 IPv4。

#### Scenario: 元数据地址

- **WHEN** 链接指向 `http://169.254.169.254/`
- **THEN** `failed/blocked_private`，0 请求

#### Scenario: 混合答案

- **WHEN** DNS 同时返回公网与私网地址
- **THEN** 整个 host 拒绝

### Requirement: SSRF 连接与重定向

连接 SHALL 固定已校验 IP（IP pinning），Host/SNI 保持原主机名，证书按原主机名校验；
SHALL NOT 二次解析。每跳重定向 SHALL 重跑地址校验，最多 5 跳，SHALL 拒绝 `https→http`；
SHALL NOT 跟随 meta refresh；SHALL NOT 执行 JS/CSS/页面子资源。

#### Scenario: DNS rebinding

- **WHEN** 首次解析公网、二次解析私网
- **THEN** 连接只用已校验 IP，不能落到私网

#### Scenario: 重定向私网

- **WHEN** 公网 302 到 `127.0.0.1`
- **THEN** 不请求私网目标，`failed/blocked_private`

### Requirement: 资源与滥用限制

系统 SHALL 限制：全局并发 3、每域名并发 1、每域名令牌桶 1 req/s（突发 2）、429/503 冷却
60s、每账号每窗口最多 **60 个立即执行名额**、全局 **500 个立即执行名额**；超出部分仍
持久化入队，但顺延到后续预算窗口执行；写入、扫描/回填与 claim 都受同一窗口计数约束。
另：页面 512KiB/声明 2MiB 上限；媒体嗅探 64KiB；日志只记 host+错误码，不记完整 URL；
只存元数据/裁剪封面，不存 HTML/响应头/Cookie。

#### Scenario: 超大体

- **WHEN** 页面 `Content-Length=5MiB`
- **THEN** `failed/blocked_size`，不读正文

#### Scenario: 日志不泄露

- **WHEN** 抓取失败 URL 含 `?token=secret`
- **THEN** 日志只有 host 与错误码

### Requirement: 预览轮播

预览区 SHALL 在帖子正文/媒体/引用之后、标签之前渲染，最多 3 张；多条预览 SHALL 由官方
shadcn `Carousel`（base-nova 收编件）承载，**一页一张、每张平权**（不设主卡），顺序＝正文
出现顺序；单条 SHALL 退化为单卡（无箭头/无指示点）。移动端 SHALL 支持触摸拖拽，桌面端 SHALL
支持拖拽 + 左右按钮，底部指示点 SHALL 可点击切页，键盘 ←/→ SHALL 切换、Tab/Enter SHALL
可聚焦并打开。

#### Scenario: 多链接轮播

- **WHEN** 帖子含 3 个链接
- **THEN** 轮播 3 页；拖拽/箭头/指示点/键盘都能切换

### Requirement: 预览卡状态与点击

每张卡片 SHALL 始终有 4:3 媒体区：`pending` 为 Skeleton 占位、无 cover 时用类型图标底纹、
有 cover 时 `object-cover`；`partial` SHALL 显示已有字段；`ready` SHALL 淡入完整卡；
`failed` SHALL 为紧凑可点链接（静态归档同样退化为可点链接卡）。卡片 SHALL 使用官方
shadcn `Card`/单色 lucide 图标；点击主区 SHALL 新窗口打开 `final_url ?? url` 并带
`noopener noreferrer`；「原文」链接兜底；`prefers-reduced-motion` 无动画（瞬切）。

#### Scenario: failed 可点

- **WHEN** 预览失败
- **THEN** 显示域名+「预览不可用」，点击仍打开原链接

### Requirement: 预览实时更新

`post.updated` 到达时 SHALL 原地更新对应 slide 的内容，按 canonicalUrl 保持当前页；
SHALL NOT 整页刷新、不重排 feed、不重置轮播页。同一帖多阶段事件 SHALL 幂等合并
（以 `updated_at` 较新者为准）。

#### Scenario: pending→ready

- **WHEN** 发帖后 worker 先写 title 再写 cover
- **THEN** 卡片从占位到标题到完整卡平滑过渡，高度差 ≤2px，无滚动跳动、轮播页不变

#### Scenario: 事件到达不跳页

- **WHEN** 用户停留在第 2 页时第 1 页收到 post.updated
- **THEN** 第 1 页内容更新，当前页仍为第 2 页

### Requirement: fileviewer 适配器与降级

`link-preview` SHALL 通过客户端 `ViewerAdapter`（`canOpen/buildUrl/open`）声明对
`file-viewer` 的可选依赖，核心 SHALL NOT import 或硬编码 fileviewer。fileviewer URL SHALL
为 `<viewer_base>/?url=${encodeURIComponent(url)}&name=...&decoder=...`，基址来自
`GET /api/plugins.viewer_base`（env `FDE2E_FILEVIEWER_BASE`，缺省
`https://file-viewer.tool.fde2e.com`），仅 https（本地 http 例外）。适配器未启用/未安装/
基址非法时 SHALL 回退新窗口打开原链接；设置页 SHALL 显示依赖状态。

#### Scenario: 启用进 viewer

- **WHEN** file-viewer 启用且点击图片卡
- **THEN** 新窗口为 `<base>/?url=<编码URL>&name=...&decoder=image`

#### Scenario: 未启用回退

- **WHEN** file-viewer 未启用
- **THEN** 新窗口直接打开原链接，不请求 viewer 域

### Requirement: 设置页与隐私

系统 SHALL 在桌面账号菜单与移动账号抽屉提供「设置」入口，列出插件（名称/id/version/
rulesVersion/enabled/worker 摘要）、官方 `Switch`、依赖状态与隐私说明（出站抓取、目标站
可见服务器 IP、P2 图片裁剪在本机处理、不执行脚本）。仅 owner/manager 可改；agent 只读；
静态归档只读且不发 `/api/plugins`；PATCH 失败回滚。设置页 SHALL 明示预览字段会被后台
多阶段更新，静态导出是某一时刻的快照。

#### Scenario: agent 只读

- **WHEN** agent 打开设置页
- **THEN** 开关 disabled；PATCH 返回 403

#### Scenario: 静态只读

- **WHEN** 静态归档打开设置
- **THEN** 显示只读说明，0 `/api/plugins` 请求

### Requirement: 隐私与失败提示

设置页 SHALL 明示出站抓取暴露服务器 IP；系统 SHALL NOT 存 HTML/响应头/Cookie；失败 SHALL
用固定中文文案（预览超时/内容过大/站点返回错误/出于安全原因已跳过预览/预览暂不可用），
SHALL NOT 暴露内部 IP/DNS 错误/堆栈；失败卡 SHALL 保留可点原链接；`post.updated` 事件
SHALL NOT 携带正文或抓取日志。

#### Scenario: 安全拒绝

- **WHEN** 私网地址被拒
- **THEN** 卡片显示「出于安全原因已跳过预览」，不显示 IP

#### Scenario: 事件最小化

- **WHEN** 检查 `post.updated` payload
- **THEN** 只有 post_id/root_id/phase/status/previews 字段/摘要，无正文/HTML/内部错误详情

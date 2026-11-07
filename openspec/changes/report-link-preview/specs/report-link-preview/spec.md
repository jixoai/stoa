# report-link-preview（delta）

## ADDED Requirements

### Requirement: 插件静态注册

系统 SHALL 以编译期静态注册提供内置插件：插件清单 SHALL 来自显式 import 的 manifest 数组与
provider map，SHALL NOT 通过目录扫描、远程 registry、`import(url)` 或运行时下载发现/加载
代码。首发内置插件 SHALL 只有 `link-preview`（kind=`preview`，
capabilities=`url-extract`/`preview-resolve`，`defaultEnabled=true`），并 SHALL 声明可选依赖
`file-viewer`。

#### Scenario: 启动即可发现

- **WHEN** 服务启动并请求 `GET /api/plugins`
- **THEN** 返回内置插件 `link-preview`（首发清单唯一），含
  id/name/version/kind/capabilities/requires

#### Scenario: 无动态加载

- **WHEN** 审计 `src/core/plugins` 与 `src/server/preview`
- **THEN** 不存在 `import(url)`、目录扫描或远程插件拉取；启用/禁用只改变是否调用已编译 provider

### Requirement: 插件启停与持久化

启用状态 SHALL 持久化在 SQLite `meta` 表（`plugins.<id>.enabled`，缺省取 manifest 默认值），
SHALL NOT 依赖 `settings.json` 等第二份配置文件。禁用时系统 SHALL 停止链接抽取、停止返回
预览、中断在飞抓取并清空队列；已有 `post_links`/`link_previews` 行 MAY 保留。重新启用时
系统 SHALL 为缺失链接索引的历史帖做纯本地回填（不抓网），预览仍按阅读/补拉触发。

#### Scenario: 默认启用

- **WHEN** 首次启动且 `meta` 中没有 `plugins.link-preview.enabled`
- **THEN** `GET /api/plugins` 返回 `enabled=true`，新帖链接被抽取并可生成预览

#### Scenario: 关闭后零抓取

- **WHEN** owner 关闭插件后发布含 3 个外链的帖子
- **THEN** 该帖 `post_links` 为 0 行、0 出站请求、`PostView` 无 `previews`，卡片不显示

#### Scenario: 重新启用回填历史

- **WHEN** 插件关闭期间产生的历史帖在重新启用后被打开
- **THEN** 系统补写 `post_links` 并按阅读触发抓取，卡片在补拉后出现，无需重发帖子

### Requirement: 链接抽取范围

系统 SHALL 在**插件启用时**，于帖子/回复的写入事务内，用 markdown 语法树抽取
`http/https` URL 并写入 `post_links`（`post_id/position/url/url_hash/label`）。抽取 SHALL
跳过 fenced code block、行内 code 与 markdown 图片；SHALL 接受 markdown 链接的 href 与
纯文本裸 URL；SHALL 保留链接文字作为 label（裸 URL 为 null）。抽取 SHALL 是纯本地操作，
SHALL NOT 发起网络请求。抽取失败 SHALL NOT 阻止帖子写入；系统 SHALL 记录日志并跳过该帖的
链接索引。

#### Scenario: 代码块与图片跳过

- **WHEN** 正文的代码块、行内 code 与图片链接里出现 URL，正文另有一个裸 URL
- **THEN** `post_links` 只有正文裸 URL，代码/图片不产生预览

#### Scenario: 链接文字保留

- **WHEN** 正文为 `[报告](https://example.com/r)`
- **THEN** 该条 label 为 `报告`，URL 为规范化后的 `https://example.com/r`

#### Scenario: 抽取失败不阻断发帖

- **WHEN** 正文触发抽取器的病理输入并抛错
- **THEN** 帖子仍提交成功（`post_links` 为空），错误只记服务端日志

### Requirement: URL 规范化与上限

URL SHALL 规范化后再去重：scheme/host 小写、去 fragment、去默认端口、去除
`utm_*`/`fbclid`/`gclid`/`yclid`/`mc_cid`/`mc_eid`/`igshid`，SHALL NOT 排序其余 query
参数。每帖 SHALL 最多保留 3 条（按出现顺序），超出的 SHALL 丢弃；单个 URL 超过 2048 字符
SHALL 丢弃而不是截断；label SHALL 截断到 200 字符。`url_hash` SHALL 为规范化 URL 的
`sha256`。

#### Scenario: 同 URL 去重

- **WHEN** 同一帖子先后出现 `https://x.example/a?utm_source=t#top` 与 `https://x.example/a`
- **THEN** 只保留一条 `https://x.example/a`

#### Scenario: 每帖上限

- **WHEN** 帖子包含 4 个不同链接
- **THEN** 只有前 3 个进入 `post_links` 并被抓取，第 4 个不产生请求

### Requirement: 抓取请求与重定向

系统 SHALL 以 HEAD 优先、GET 回退的方式抓取（HEAD 405/501 或网络错误时回退 GET）。抓取
SHALL 有 3s HEAD 超时、8s 总截止、最多 5 跳重定向，并 SHALL 逐跳重新执行安全校验（见
「SSRF 地址校验」与「SSRF 连接与重定向」）。请求 SHALL 使用
`Accept-Encoding: identity` 与固定 UA `fde2e-report-link-preview/1.0`；SHALL NOT 跟随
`<meta http-equiv=refresh>`，SHALL NOT 请求页面内子资源。

#### Scenario: HEAD 不可用回退 GET

- **WHEN** 目标对 HEAD 返回 405
- **THEN** 自动改用 GET 并正常得到元数据，不记为失败

#### Scenario: 重定向链

- **WHEN** 目标 302 两次后返回 200
- **THEN** 抓取成功，`final_url` 为最终地址，最多 5 跳

#### Scenario: meta refresh 不跟随

- **WHEN** 页面含指向私网的 `<meta http-equiv="refresh">`
- **THEN** 系统只解析当前页，不请求 refresh 目标

### Requirement: MIME 判定与分流

MIME 判定 SHALL 以**魔数嗅探优先、`Content-Type` 次之、URL 扩展名最后**，并 SHALL 将链接
归入 `page/image/video/audio/document/unknown` 之一。网页 SHALL 读取最多 512 KiB 正文；
图片/视频/音频/文档 SHALL 只读取前 512 字节（`Range: bytes=0-511`，忽略 Range 时读满
64 KiB 即中止）用于嗅探。文本类文档 SHALL 以首行作为标题、前 400 字作为描述；
PDF/ZIP/Office 文档 SHALL 以 URL 末段文件名作为标题回退。

#### Scenario: 图片与视频

- **WHEN** 链接指向 PNG 与 MP4
- **THEN** 分别返回 `kind=image` 与 `kind=video`；图片 `cover_url` 为自身，视频无 poster

#### Scenario: 文档

- **WHEN** 链接指向 PDF 或 docx
- **THEN** 返回 `kind=document`，标题回退为文件名，点击可交给查看器

#### Scenario: 未知类型

- **WHEN** 目标返回 `application/octet-stream` 且无魔数命中
- **THEN** 返回 `kind=unknown`（标题回退 hostname），卡片仍保留可点链接

### Requirement: 字符集与文本上限

字符集 SHALL 按 `Content-Type charset` → `<meta charset>` → UTF-8 的顺序解析；不支持的
字符集 SHALL 回退 UTF-8 而不是报错；非法字节序列 SHALL 用替换字符解码。标题 SHALL
截断到 200 字、描述 400 字、站点名 100 字；截断 SHALL 在 HTML 实体解码之后按字符进行。

#### Scenario: 非 UTF-8 页面

- **WHEN** 页面 `Content-Type: text/html; charset=gbk` 且标题为中文
- **THEN** 返回正确中文标题，不出现乱码或 `parse_error`

#### Scenario: 超长描述

- **WHEN** 页面 meta description 有 2000 字
- **THEN** 描述截断为 400 字，不撑爆卡片或数据库

### Requirement: 元数据优先级

网页元数据 SHALL 按以下优先级提取：Open Graph（`og:title/description/site_name/image/
image:width/image:height/type`）→ Twitter Card（`twitter:title/description/image`）→
`<title>`/`<meta name="description">`/`<link rel="canonical">` → `<article>`/`<main>` 内
首个不少于 40 字的 `<p>`（作为描述回退，截 400 字）。没有标题时 SHALL 依次回退 markdown
label、URL 末段文件名、hostname；没有站点名时 SHALL 回退 hostname（去 `www.`）。

#### Scenario: OG 完整

- **WHEN** 页面含完整 OG 标签
- **THEN** 标题/描述/站点名取 OG 值，封面取 `og:image`

#### Scenario: 逐级回退

- **WHEN** 页面无 OG/Twitter，只有 `<title>` 与 meta description
- **THEN** 标题与描述取 HTML 基础标签，不返回空卡片

### Requirement: 封面与隐私字段

封面 URL SHALL 是绝对 `http/https`、不超过 2048 字符；相对地址 SHALL 按最终 URL 解析；
SVG 封面（`image/svg+xml` 或 `.svg`）SHALL NOT 作为封面渲染。站点图标（`link rel="icon"`
或 `/favicon.ico`）SHALL 以 `cover_kind=favicon` 标记，SHALL NOT 被当作大图封面。前端 SHALL
仅在封面为 https（或本地 http）时渲染封面；封面加载失败 SHALL 回退类型图标，不留破图。
服务端 SHALL NOT 存储 HTML 原文、响应头或 Cookie，只存有界元数据。

#### Scenario: favicon 回退

- **WHEN** 页面无 og:image/twitter:image，但有 favicon
- **THEN** `cover_kind=favicon`，前端只显示小图标而非大图

#### Scenario: SVG 封面拒绝

- **WHEN** `og:image` 指向 `.svg`
- **THEN** 不存储/不渲染该封面，卡片使用图标占位

### Requirement: SSRF 地址校验

服务端抓取 SHALL 默认拒绝一切非公网目标。仅 `http`/`https` SHALL 被接受；含
`username/password`、空 host、单标签 host、`.local/.internal/.home.arpa/.lan` 后缀、超长
host 的 URL SHALL 被拒绝。端口 SHALL 默认只允许 `80/443`（可配置追加 `8080/8443`），管理
端口（22/23/25/53/110/143/445/3306/5432/6379/9200/11211 等）SHALL 永远拒绝。DNS 解析后
SHALL 对所有 A/AAAA 答案做地址分类，任一答案命中私网/回环/链路本地/组播/保留/文档/
元数据（含 `169.254.169.254`）即 SHALL 拒绝整个 host；SHALL 校验 IPv4-mapped、NAT64、
6to4 的内嵌 IPv4。

#### Scenario: 元数据地址被拒

- **WHEN** 链接指向 `http://169.254.169.254/latest/meta-data/`
- **THEN** 记录 `failed/blocked_private`，该地址 0 请求，卡片降级为普通链接

#### Scenario: 内嵌 IPv4 被识别

- **WHEN** 链接为 `http://[::ffff:127.0.0.1]/` 或十进制 IP `http://2130706433/`
- **THEN** 解析为回环并拒绝

#### Scenario: 混合答案拒绝

- **WHEN** 某 host 的 DNS 同时返回公网与私网地址
- **THEN** 整个 host 被拒绝，不只过滤私网答案后继续

### Requirement: SSRF 连接与重定向

连接 SHALL 固定到已校验 IP（IP pinning），`Host`/SNI SHALL 保持原主机名，证书校验 SHALL
仍按原主机名，SHALL NOT 让系统二次解析。每一跳重定向 SHALL 重新执行地址校验；SHALL 拒绝
`https→http` 降级。抓取 SHALL NOT 发送 Cookie、Authorization、Referer 或
`X-Forwarded-*`，SHALL NOT 执行 JS、CSS 或页面内子资源请求，SHALL NOT 接受
`Content-Encoding` 非 `identity` 的响应，SHALL 忽略 `HTTP_PROXY` 等代理环境变量。

#### Scenario: DNS rebinding 被挡

- **WHEN** 某 host 首次解析公网、二次解析私网
- **THEN** 连接只使用本次校验过的 IP，不发生二次解析，请求不能落到私网

#### Scenario: 重定向到私网被拒

- **WHEN** 公网 URL 302 到 `http://127.0.0.1:<port>/admin`
- **THEN** 系统不请求私网目标，记录 `failed/blocked_private`；即使测试放行夹具 origin 也不放行

#### Scenario: 公网正常放行

- **WHEN** 链接指向公网 HTTPS 站点且解析结果全部为公网地址
- **THEN** 抓取正常进行，Host/SNI 为原域名，证书按原域名校验

### Requirement: 出站资源与滥用限制

系统 SHALL 限制出站抓取资源：全局并发最多 3、每域名并发 1、队列最多 200、每域名令牌桶
1 req/s（突发 2）、每账号每小时最多触发 60 次抓取、全局每小时最多 500 次；同一规范化 URL
的并发请求 SHALL 单飞复用同一任务。页面正文超过 2 MiB（`Content-Length`）SHALL 直接判
`blocked_size`；未知长度时读到 512 KiB+1 即中止。收到 429/503 的域名 SHALL 冷却 60s。

#### Scenario: 超大体拒绝

- **WHEN** 目标 `Content-Length` 为 5 MiB 的 HTML
- **THEN** 不读取正文，记录 `failed/blocked_size`

#### Scenario: 单飞

- **WHEN** 同一 URL 出现在 3 条帖子中且同时被阅读
- **THEN** 只发起 1 次抓取，3 条帖子共享同一结果

### Requirement: 预览存储与缓存

系统 SHALL 以 `url_hash` 为键缓存预览元数据，表 `link_previews` SHALL 持久化
`status/kind/mime/title/description/site_name/cover_url/cover_kind/cover_w/cover_h/
final_url/error_code/attempt_count/fetched_at/expires_at`。成功结果 TTL SHALL 为 24 小时；
失败结果 SHALL 按 5m→15m→1h→6h→24h 指数退避。读取过期结果时 SHALL 先返回旧值并在后台
单飞刷新（stale-while-revalidate），SHALL NOT 因刷新阻塞帖子渲染。帖子软删除时 SHALL 在
同一事务删除其 `post_links` 行；`link_previews` SHALL 在无任何引用且 `fetched_at` 超过
7 天时被清理。系统 SHALL NOT 把第三方封面/图片下载进本仓媒体库（P1），只存外链 URL。

#### Scenario: 缓存命中不重抓

- **WHEN** 两个帖子引用同一 URL，第二个帖子在 24h 内被阅读
- **THEN** 直接返回缓存，不发起第二次抓取

#### Scenario: 过期先显示旧值

- **WHEN** 缓存已过期但目标站暂时超时
- **THEN** 页面仍显示旧卡片，后台刷新失败后保留旧值并按退避重试，不闪成空白

#### Scenario: 删除帖子清理关联

- **WHEN** 一条含链接的帖子被删除
- **THEN** 该帖 `post_links` 0 行、`PostView` 无 `previews`；无引用缓存按 GC 规则清理

### Requirement: 预览读取字段

帖子视图 SHALL 在**插件启用、帖子未删除、且存在链接**时携带 `previews: LinkPreview[]`
（最多 3 条，按 `position` 排序）；无链接的帖子 SHALL NOT 出现该字段。每条预览 SHALL 只
包含安全字段：`url/final_url/domain/label/status/kind/mime/title/description/site_name/
cover_url/cover_kind/cover_w/cover_h/error_code/fetched_at`，SHALL NOT 包含响应头、HTML、
内部 IP、DNS 错误详情或抓取日志。

#### Scenario: 时间线带预览

- **WHEN** 读取含链接帖子的时间线
- **THEN** 该帖带 `previews`，其余帖子无该字段；预览卡无需额外 URL 请求即可渲染

#### Scenario: 删除帖无预览

- **WHEN** 读取已删除帖子的线程
- **THEN** 该帖 `post_links` 已清理，`previews` 字段缺省

### Requirement: 预览补拉端点

系统 SHALL 提供 `GET /api/previews?post=<id>` 返回与 `PostView.previews` 相同的结构，并
SHALL 触发缺失/过期行的抓取；若该帖尚无 `post_links` 索引，SHALL 先按正文本地补写索引
（不抓网）。该端点 SHALL 要求认证、SHALL 校验帖子可见性（不可见/未知返回 404）、SHALL NOT
接受任意 URL 参数。系统 SHALL NOT 提供 `GET /api/previews?url=` 之类的任意 URL 预览接口。
读取路径 SHALL NOT 同步等待网络抓取；未命中时 SHALL 返回 `status=pending` 与可选的
`retry_after_ms`。

#### Scenario: 不可见帖子不泄露

- **WHEN** agent 请求 `GET /api/previews?post=<其不可见的帖>`
- **THEN** 返回 404，且不返回该帖的任何链接或预览字段

#### Scenario: 不提供任意 URL 抓取

- **WHEN** 请求 `GET /api/previews?url=http://127.0.0.1/`
- **THEN** 该参数不被接受（400 或忽略并返回 404），服务端不发起任何抓取

#### Scenario: 未命中即 pending

- **WHEN** 帖子有链接但缓存无行
- **THEN** 响应 `status=pending`、`retry_after_ms=1500`，抓取在后台进行，正文不等待

### Requirement: 预览卡形态与状态

预览区 SHALL 使用官方 shadcn `Card` 形态，最多 3 张，包含封面（若有）、域名、类型图标、
标题（≤2 行）与描述（≤2 行）；`image/video/audio/document/page/unknown` SHALL 有可区分的
单色 lucide 图标。卡片 SHALL 有 `pending/ok/failed` 三态：`pending` SHALL 为固定高骨架，
`failed` SHALL 为紧凑链接行，二者 SHALL NOT 隐藏原链接。移动端（<640px）封面 SHALL 为
80×80，桌面 SHALL 为 112×112；两档 SHALL 无横向溢出。

#### Scenario: 卡片内容

- **WHEN** 帖子含一个 OG 完整的链接
- **THEN** 帖下出现 1 张卡，显示封面、域名、标题、描述与 page 图标；
  `data-preview-status="ok"`

#### Scenario: 失败仍可点

- **WHEN** 链接超时或返回 404
- **THEN** 显示紧凑失败行（域名 + 「预览不可用」），点击仍在新窗口打开原链接

### Requirement: 预览卡打开与布局稳定

点击卡片主区 SHALL 在新窗口打开 `final_url ?? url`，并带 `noopener noreferrer`；卡片 SHALL
另提供「原文」链接作为兜底。预览区 SHALL 异步补位：正文 SHALL 在首帧可见，卡片可在其后
到达，SHALL NOT 因卡片到达造成正文位移（目标 CLS < 0.02）。`prefers-reduced-motion` 下
SHALL NOT 有高度/淡入动画。`window.open` 被拦截时 SHALL 给 toast 提示，且「原文」链接仍
可用。

#### Scenario: 点击新窗口

- **WHEN** 点击卡片主区
- **THEN** 打开新窗口且地址为目标 URL，新窗口 `window.opener === null`

#### Scenario: 预览后到不推正文

- **WHEN** 帖子首帧只有正文，预览卡在 1.5s 后到达
- **THEN** 正文与媒体在屏幕上的位置不变（±2px），无 CLS 超限

### Requirement: fileviewer 适配器接口

`link-preview` SHALL 通过客户端 `ViewerAdapter` 接口声明对 `file-viewer` 的可选依赖，核心
SHALL NOT import 或硬编码 fileviewer 的 URL/实现。适配器 SHALL 提供
`canOpen({kind,mime})` / `buildUrl({url,name,decoder})` / `open(...)`。fileviewer URL SHALL
遵循既有契约 `/?url=<encodeURIComponent(绝对URL)>&name=<显示名>&decoder=<解码器id>`
（decoder 可选，页面/未知不传）；基址 SHALL 来自 `GET /api/plugins` 的 `viewer_base`
（服务端可用 `FDE2E_FILEVIEWER_BASE` 覆盖），SHALL NOT 在组件里硬编码。

#### Scenario: 启用时进 fileviewer

- **WHEN** `file-viewer` 启用且点击一张图片预览卡
- **THEN** 新窗口地址为 `<viewer_base>/?url=<编码后的原图URL>&name=…&decoder=image`

#### Scenario: 基址来自服务端

- **WHEN** 服务端以 `FDE2E_FILEVIEWER_BASE` 指向 alpha 站点
- **THEN** 前端使用该基址构造 URL，不出现硬编码的正式域

### Requirement: fileviewer 依赖降级

仅当 `file-viewer` 插件已注册且启用、且基址是 https（本地 http 例外）时，图片/视频/音频/
文档点击 SHALL 进入 fileviewer；否则 SHALL 回退为新窗口打开原链接。设置页 SHALL 显示依赖
状态（已启用/未启用/未安装）与回退说明。适配器 SHALL NOT 接收本仓认证头或把 URL 传给
服务端代理。

#### Scenario: 未启用回退原链接

- **WHEN** `file-viewer` 未启用/未安装且点击图片卡
- **THEN** 新窗口直接打开原图 URL，不请求 fileviewer 域

#### Scenario: 非法基址禁用适配器

- **WHEN** `viewer_base` 为空、非 https（且非本地 http）或解析失败
- **THEN** 适配器不可用，点击走原链接，设置页显示依赖不可用

### Requirement: 设置页插件管理

系统 SHALL 在桌面账号菜单与移动账号抽屉提供「设置」入口，打开 `SettingsSheet`。设置页
SHALL 列出内置插件（名称/id/版本/描述/启用状态）、官方 `Switch` 开关、依赖状态与隐私说明
（服务器会出站抓取、目标站可见服务器 IP、拒绝内网、不执行脚本）。开关 SHALL 通过
`PATCH /api/plugins/:id` 持久化；仅 owner/manager SHALL 可修改，agent SHALL 只读（开关
disabled 并有说明）。静态归档 SHALL 显示「静态归档不支持插件管理」且 SHALL NOT 发起
`/api/plugins` 请求。PATCH 失败 SHALL 回滚 UI 状态并提示。

#### Scenario: 关闭后卡片消失

- **WHEN** owner 在设置页关闭 `link-preview`
- **THEN** 当前页面卡片立即隐藏，新帖不再抓取，开关状态在刷新后保持

#### Scenario: agent 只读

- **WHEN** agent 打开设置页
- **THEN** 开关 disabled 并显示「仅 owner/manager 可修改」；直接 PATCH 返回 403

#### Scenario: 静态归档

- **WHEN** 在静态归档打开设置
- **THEN** 显示只读说明，不显示可操作的 Switch，不产生任何网络请求

### Requirement: 静态归档与插件关闭降级

静态导出快照 SHALL NOT 包含 `previews` 字段；`StaticReportClient` 的插件/预览方法 SHALL
返回禁用态或抛 `READ_ONLY`，SHALL NOT 发起网络请求。静态模式 SHALL NOT 渲染预览卡；
正文里的 markdown 链接与裸 `http/https` URL SHALL 仍是可点击链接（新窗口 +
`noopener noreferrer`）。插件关闭时 SHALL 保持同一降级行为。

#### Scenario: 导出无预览

- **WHEN** 执行 `export` 并检查快照 JSON
- **THEN** 任意帖子均无 `previews` 键；静态页 0 张 `[data-testid="link-preview-card"]`

#### Scenario: 静态裸 URL 可点

- **WHEN** 在 `file://` 打开含裸 URL 的归档帖子
- **THEN** 该 URL 渲染为可点击链接，点击在新窗口打开，且无任何抓取/网络请求

### Requirement: 隐私与失败提示

设置页 SHALL 明示服务端出站抓取会向目标站暴露服务器 IP；系统 SHALL NOT 存储 HTML 原文、
响应头或 Cookie；日志 SHALL 只记录 host 与错误码，SHALL NOT 记录完整 URL。抓取失败 SHALL
以固定中文文案降级（预览超时/内容过大/站点返回错误/出于安全原因已跳过预览/预览暂不可用），
SHALL NOT 暴露内部 IP、DNS 错误或堆栈；失败卡片 SHALL 始终保留可点击的原链接。

#### Scenario: 安全拒绝的文案

- **WHEN** 链接因私网/元数据地址被拒
- **THEN** 卡片显示「出于安全原因已跳过预览」，不显示被拒 IP 或解析细节

#### Scenario: 日志不泄露 query

- **WHEN** 抓取 `https://example.com/a?token=secret` 失败
- **THEN** 日志只含 `example.com` 与错误码，不含 `token=secret`

# daemon Specification

## Purpose
TBD - created by archiving change stoa-daemon. Update Purpose after archive.

## Requirements

### Requirement: daemon 服务与挂载管理

Stoa SHALL 提供用户级 daemon（`stoa daemon start|stop|status`，默认回环端口 13679，状态目录
`~/.local/state/stoa/daemon/`）。daemon SHALL 提供 HTTP API：`GET /healthz`、
`GET /api/daemon/services`、`POST /api/daemon/services`（挂载；`dataDir` 可选，`location` 支持
`auto|temp|path`）、`POST /api/daemon/services/:id/stop`、`DELETE /api/daemon/services/:id`、
`POST /api/daemon/shutdown`。**daemon 托管实例 SHALL 以 Unix domain socket 监听**
（`<stateDir>/sockets/<id>.sock`，父目录 0700），**SHALL NOT 绑定 TCP 端口**；`serve --standalone`
保留 TCP 监听用于调试与直连。实例 `server.json` SHALL 同时在 `port`（daemon 托管时为 null）与
`unix` 中声明可达通道，CLI/MCP/适配器/dsh SHALL 经 `instanceFetch`（UDS 优先）发现并访问实例。
服务记录 SHALL 含 `slug`、`hostnames[]`、`socket`、逻辑 `url`、`authAccount`；`port` 仅为兼容字段
（daemon 托管时为 null）。daemon 退出 SHALL 停止全部挂载服务。

#### Scenario: 挂载与回收

- **WHEN** `POST /api/daemon/services {dataDir}`
- **THEN** 返回服务记录（url/slug/socket/pid，port 为 null），经 daemon 访问该服务 `/healthz` 200；
  `stop` 后进程退出、socket 删除、登记移除

#### Scenario: 幂等挂载

- **WHEN** 对同一 dataDir 再次 `POST /api/daemon/services`
- **THEN** 返回既有服务记录，不重复起进程

#### Scenario: 幂等挂载与 UDS

- **WHEN** 对同一 dataDir 再次挂载
- **THEN** 返回既有服务记录，不重复起进程；`lsof -iTCP` 中该实例无监听端口

#### Scenario: 无目录挂载（自动会话）

- **WHEN** `POST /api/daemon/services {location:"auto"}`（不带 dataDir）
- **THEN** 在 `~/.stoa/sessions/` 下创建并初始化会话目录，服务以认证模式启动（UDS 监听）；
  临时会话（`location:"temp"`）在停止后其目录被删除

#### Scenario: 本机消费者经 UDS 发现

- **WHEN** 实例以 daemon 托管模式运行（无 TCP 端口）
- **THEN** `server.json` 含 `unix` 且 `port` 为 null；`stoa who`、MCP 工具、dsh 健康探测经
  `instanceFetch` 正常返回，不需要 daemon 会话 cookie

### Requirement: serve 默认 daemon 化

`stoa serve --data-dir D` SHALL 默认接入 daemon（必要时后台拉起）、挂载 D、打印**服务链接与
daemon 链接**并释放终端（stdout 单行 JSON：service/daemon/detached）。`--standalone` SHALL
保持前台运行（只打印服务链接、持续占用终端）。旧 `--daemon` SHALL 继续可用（单实例后台 detach）。

#### Scenario: 默认模式释放终端

- **WHEN** 在非 TTY 脚本里执行 `stoa serve --data-dir D`
- **THEN** 命令在服务就绪后以 0 退出，stdout 含 service.url 与 daemon.url；服务继续由 daemon 托管

#### Scenario: standalone 保持前台

- **WHEN** 执行 `stoa serve --standalone --data-dir D`
- **THEN** 进程保持运行（直到信号），只打印服务 URL；不创建 daemon 状态

### Requirement: daemon-webui 与插件可视化入口

daemon SHALL 在 `/` 提供 WebUI（复用前端构建并注入 `__STOA_DAEMON__`），列出挂载服务
（名称/slug/自定义 hostname/状态/逻辑 URL）并支持打开/停止/移除/挂载；界面 SHALL 使用 shadcn
官方收编组件，挂载以触发式官方 `Sheet` 提供。**WebUI 与全部服务页面 SHALL 要求 daemon 登录**
（除 `/login`、`/healthz`、`/api/daemon/auth/*`、静态资产与 `/i/*/healthz`）。服务行「打开」
SHALL 进入 **daemon 壳** `/shell/<idOrSlug>`（iframe 内呈现实例），SHALL NOT 再直开实例 origin。
MCP 面板 SHALL 在 daemon 可用时提供「Daemon 控制台」链接。

#### Scenario: 统一管理

- **WHEN** 已登录用户打开 daemon URL
- **THEN** 页面列出全部挂载服务（slug/状态/逻辑 URL），并可完成一次挂载与停止操作

#### Scenario: 触发式挂载入口

- **WHEN** 用户打开 daemon WebUI（390 或 1280 视口）
- **THEN** 首屏不出现常驻表单字段；点 header「添加服务」或空态 CTA 打开官方 Sheet，表单在面板内完成挂载；
  提交成功后 Sheet 关闭、列表出现新服务

#### Scenario: 插件入口

- **WHEN** 侧栏面板打开且本机 daemon 在运行
- **THEN** 面板出现「Daemon 控制台」链接，指向 daemon URL

#### Scenario: 未登录访问

- **WHEN** 未登录访问 `/` 或 `/shell/<slug>` 或 `/i/<slug>/`
- **THEN** 页面 302 到 `/login?next=…`，登录后回跳；API 返回 401 JSON

### Requirement: 访问口令与密钥链接

**daemon 会话是经 daemon 访问实例的凭据**：已登录用户经 `/i/<slug>/`（或实例自定义 hostname）
访问时，daemon SHALL 在服务端注入实例凭据（默认 `owner` 账号，自实例 0600 env 读取），
SHALL NOT 把实例 token 下发浏览器。实例自身口令 / `#key=` 链接 SHALL 仅用于 **`--standalone`
直连**（Host 模式与路径模式都是 daemon 代理，实例口令不参与）。daemon-webui 的服务行「口令」入口
（掩码/显示/复制/重新生成）SHALL 保留；**完整口令 SHALL NOT 出现在可读文本/title/aria-label**
（可显示时仅限显式「显示」动作后的输入框值），`/api/*` 响应 SHALL `cache-control: no-store`。
「打开」SHALL 进入壳并依赖 daemon 会话，不再附加 `#key=`。

#### Scenario: 口令读取与轮换

- **WHEN** 对运行中的服务 `GET /api/daemon/services/:id/secret` 取到口令后用其登录
- **THEN** 登录成功；`PUT` 重新生成后再用旧口令签发的 token 请求 SHALL 返回 401，新口令可登录

#### Scenario: 口令链接即点即用

- **WHEN** 用复制出的口令链接打开 `--standalone` 实例（直连）
- **THEN** 页面自动完成登录进入版，地址栏不再包含 `key=`

#### Scenario: 从控制台打开即登录

- **WHEN** 在 daemon-webui 点「打开」（或行内入口）
- **THEN** 进入 `/shell/<slug>` 壳页（daemon 会话即登录态），iframe 内板面直接可用，
  不再附加 `#key=`；开放模式或会话失效时按控制台登录/口令入口回退且有可见提示

#### Scenario: 经 daemon 打开无需实例口令

- **WHEN** 已登录用户从控制台点「打开」
- **THEN** 进入 `/shell/<slug>`，iframe 内板面直接可用（实例登录门不出现），
  实例 `/api/auth/status` 返回 `proxied:true`，响应/页面无实例 token

#### Scenario: 直连仍可用

- **WHEN** 用实例自身口令链接直连（仅 `--standalone` 实例）
- **THEN** 行为与既有口令链接规格一致

### Requirement: 目录选择器

daemon SHALL 提供 `POST /api/daemon/pick-directory`：在宿主平台弹出原生目录选择对话框
（macOS/Linux/Windows 各自实现），返回所选绝对路径；用户取消返回 `path:null`；
无可用对话框时 SHALL 返回明确错误，前端 SHALL 保留手动输入兜底。

#### Scenario: 选择目录

- **WHEN** 用户在自定义位置点「选择文件夹」并选中一个目录
- **THEN** 路径回填到输入框并可成功挂载；取消时不改变输入

### Requirement: 端口独占与归属自证

stoa 替换/随机挑选监听端口时 SHALL NOT 与其它进程共享同一端口：随机挑选 SHALL 在绑定前探测占用
（TCP 连接），绑定后 SHALL 用 `/healthz` 的实例标识（instanceId/pid）自证归属；显式 `--port` 被占用
SHALL 以 CONFLICT 失败而不是静默共享。daemon 挑选自身端口同样 SHALL 先探测并用 pid 自证。

#### Scenario: 端口被占用不静默共享

- **WHEN** 目标端口已被另一个进程监听时启动 `stoa serve --port <该端口>`
- **THEN** 命令失败并给出 CONFLICT（不出现两个进程同时 LISTEN 同一端口）

### Requirement: 控制台首屏与操作层级

daemon WebUI SHALL 以服务列表为首屏主体：390×844 视口下首屏 SHALL 至少可见运行状态概览、
一条服务行与挂载入口，且无横向溢出；1280 视口下服务信息 SHALL 形成可扫视的列锚点而非散文流。
服务行 SHALL 按「身份与状态 → 入口 → 元信息 → 操作」分层：运行中且存在监听地址时「打开」
为唯一主操作，口令为次级操作，停止/移除 SHALL 经菜单或二次确认触达。已停止服务 SHALL 以
去饱和呈现且 SHALL NOT 提供失效的「打开」动作。空态 SHALL 提供单一主路径（打开挂载 Sheet）
与次要的 CLI 备选，不得并列为主路径。状态目录与目录路径等次级信息 SHALL 可复制且截断时有
完整值提示。表单错误 SHALL 就近显示在对应字段，端口校验失败在重新输入时 SHALL 清除。
界面视觉 SHALL 保持既有 shadcn + solid-glass 令牌与 lucide 单色图标，不得引入新的视觉语言。

#### Scenario: 首屏效率（390）

- **WHEN** 以 390×844 打开有 2 个服务的 daemon WebUI
- **THEN** 不滚动即可见运行中计数、至少一条服务行与「添加服务」入口；页面无横向溢出

#### Scenario: 操作权重

- **WHEN** 查看一条运行中服务
- **THEN** 「打开」是唯一主操作；「口令」为次级；停止/移除需经菜单或二次确认才能触达

#### Scenario: 已停止服务

- **WHEN** 服务状态为 stopped
- **THEN** 行去饱和显示、不出现「打开」；仍可取口令，并可直接移除登记

#### Scenario: 空态引导

- **WHEN** 没有任何挂载服务
- **THEN** 空态展示「挂载第一个服务」主 CTA（打开 Sheet）与折叠的 CLI 备选；
  390 下 CLI 行不被视口底边截断

#### Scenario: 表单错误就地

- **WHEN** 在 Sheet 内以自定义位置留空目录提交
- **THEN** 错误显示在目录字段下方（不落在面板底部），修正后再次提交可成功

#### Scenario: 次级信息可复制

- **WHEN** 用户需要状态目录或服务目录
- **THEN** 提供复制动作；路径截断时可通过 title 或复制取得完整值

### Requirement: 实例静态预览（按需生成）

daemon SHALL 在**文档入口** `GET /preview/<serviceId>/`（或 `/index.html`）按需生成静态归档
（独立输出目录 `<dataDir>/export-preview`），并静态服务其中的 `index.html`、`assets/**`、
`media/**`；其余路径（含 `history/**`、`manifest.json`）SHALL 404。子资源请求 SHALL NOT 触发
生成。`GET /preview/<serviceId>`（裸 id）SHALL 302 到带斜杠路径。
`GET /api/daemon/services/<id>/preview` SHALL 以同一生成路径返回 JSON 元信息
`{ ok, url, cached, rev, as_of_seq, exported_at, duration_ms }`（`cache-control: no-store`）。

#### Scenario: 停止实例仍可生成预览
- **WHEN** 某服务已停止，用户 GET `/preview/<id>/`
- **THEN** daemon 以只读方式完成导出并从归档服务页面，不启动实例、不占用实例端口、不需要实例口令

#### Scenario: 运行中实例同样可预览
- **WHEN** 服务处于 running，GET 预览
- **THEN** 同样按缓存判定生成/命中并服务归档；预览输出目录与实例自身 auto-export 的目录相互独立

#### Scenario: 子资源不触发生成
- **WHEN** 页面加载发起 `/assets/**` 或 `/media/**` 请求
- **THEN** 直接静态服务（不执行缓存判定与导出）；归档缺失时 404

#### Scenario: 并发单飞
- **WHEN** 多个文档入口请求同时到达同一服务
- **THEN** 只执行一次导出，所有请求共享同一结果

#### Scenario: 守卫与 404
- **WHEN** 路径含目录穿越（`..`/编码变体/NUL）、服务 id 未知、或登记存在但数据目录缺失
- **THEN** 分别拒绝（400/404）并给出可读原因；归档 `index.html` 不注入 daemon boot、不携带 token

### Requirement: 缓存判定以修订自证

预览缓存命中 SHALL 仅由 `manifest.rev`、`manifest.ui_version` 与 `manifest.viewer` 共同决定，
SHALL NOT 以 mtime/ETag 等传输层信号充当判据；`rev` SHALL 与快照来自同一次一致读
（事件 `MAX(seq)` 与账号/关注/收藏/插件开关计数），并 SHALL NOT 因事后另查而领先于快照内容。
数据变化（含不写事件的身份/关系/插件变更）SHALL 触发重生成并如实返回新 `as_of_seq`；
他人可见性切片（viewer 非 owner）的既有归档 SHALL NOT 被当作 owner 预览命中。

#### Scenario: 缓存命中不重复生成
- **WHEN** 数据自上次导出后未变化，再次 GET 预览或其元信息
- **THEN** 返回既有归档，`cached:true`，不发生新的导出执行

#### Scenario: 数据变化触发重生成
- **WHEN** 实例数据产生新事件后再 GET 预览
- **THEN** 导出重跑，新内容出现在归档中，`cached:false` 与新 `as_of_seq` 如实返回

#### Scenario: 切片不匹配必须重生成
- **WHEN** 预览目录中已有他人切片（viewer 非 owner，如实例 auto-export 或 `stoa export --as <agent>` 产物）
- **THEN** 判定未命中并重生成 owner 切片，不直接服务该归档

### Requirement: 控制台停止实例的预览入口

daemon-webui 控制台 SHALL 为 stopped 服务行提供「生成预览」主操作（直链 `/preview/<id>/`、
新标签打开），为 running 服务行的操作菜单提供「生成静态预览」项。

#### Scenario: 停止行一眼可见预览入口
- **WHEN** 服务行处于 stopped 态
- **THEN** 该行出现「生成预览」按钮，点击在新标签打开只读归档（首次生成后再次打开即时命中缓存）

#### Scenario: 数据不可用时给出可读原因
- **WHEN** 服务行对应的数据目录已缺失（罕见：手工删除等）且用户打开预览
- **THEN** 页面返回可读 404 原因，而非空白或控制台首页

### Requirement: 单端口虚拟主机与路由

daemon SHALL 单端口承载 daemon 自身与全部实例，按以下优先级路由：① Host 精确命中实例
`hostnames[]` → 代理该实例；② 路径前缀 `/i/<idOrSlug>/` → 剥前缀后代理（**对任何 Host 生效，
含 daemon host**；`/i/<idOrSlug>` 无尾斜杠 302 补斜杠）；③ Host 为 daemon host →
daemon app；④ 其它 → daemon app。
`slug` SHALL 为 `[a-z0-9][a-z0-9-]{1,31}` 且唯一（冲突自动加后缀，保留字 `api|assets|login|
logout|shell|i|preview|healthz|favicon.ico` 不得占用）；`hostnames` SHALL 按 host 语法校验且跨实例唯一。
实例以 UDS 监听，`/api/daemon/services` 中 `port` 为 null 且无 TCP 监听。

#### Scenario: 路径与主机名双通道

- **WHEN** 分别以 `/i/<slug>/` 与自定义 hostname 访问同一实例
- **THEN** 两者都返回该实例界面与 API，且 `/api/daemon/services` 中 `port` 为 null、无 TCP 监听

#### Scenario: 路由优先级与补斜杠

- **WHEN** 分别请求实例 hostname 根、daemon host 根、daemon host 上的 `/i/<id>`（无尾斜杠）、未知路径
- **THEN** 依次返回实例界面、daemon app、302 到 `/i/<id>/`、daemon app 的 404/控制台

#### Scenario: slug 冲突与保留字

- **WHEN** 挂载两个同名服务，或服务名规范化后命中保留字
- **THEN** 第二个 slug 自动加后缀（`-2` 等），保留字被顺延，二者均满足 slug 语法且唯一

### Requirement: 实例反代与流式透传

代理 SHALL 透传 method/headers/body/status；SHALL 删除 hop-by-hop 头与上游 `content-encoding`/
`content-length`（Bun fetch 已解压 body）；SHALL 删除客户端自带的 `authorization`/
`x-report-account`/`cookie` 后再注入实例凭据；SHALL NOT 对反代响应注入 CORS 头。SSE/流式响应
SHALL 逐块透传不缓冲（含 `/api/stream/ticket` 两次请求，hub 503 原样透传）；普通请求超时 60s，
SSE 与附件下载不设上限。实例不可达 SHALL 返回 502 与可读原因。媒体 Range：实例当前不支持
Range，本规格只要求「不额外破坏」（上游 206 原样透传）。

#### Scenario: 流式不被破坏

- **WHEN** 经 `/i/<slug>/api/stream` 订阅（先取 ticket）
- **THEN** 事件实时到达（无整体缓冲）；此时并发普通请求不被阻塞

#### Scenario: 实例不可达

- **WHEN** 实例进程已死而登记仍存在
- **THEN** 代理返回 502 与可读原因（含实例名/状态），不静默回落到控制台

#### Scenario: 压缩与 CORS 头语义

- **WHEN** 实例返回 gzip 响应，或 daemon 自身的 CORS 中间件存在
- **THEN** 下游收到的响应不含 `content-encoding`（body 已解压）且长度正确；反代响应不出现
  `access-control-allow-origin`

### Requirement: daemon 账号与登录会话

daemon SHALL 有独立账号（argon2id 哈希存 `<stateDir>/daemon-accounts.json`，0600，禁明文）；
CLI SHALL 提供 `daemon account set|status`。登录 `POST /api/daemon/auth/login` SHALL 下发
HttpOnly 会话 cookie（SameSite=Lax；TTL 7 天滑动；sessions 0600，内存台账 + 批量落盘）。
首启无账号 SHALL 引导创建（仅账号数=0 **且请求来自 loopback peer＋回环 Host**；其余来源 403）；
退出登录 SHALL 使该会话立即失效。

#### Scenario: 首启创建与登录

- **WHEN** 全新 stateDir 打开 daemon
- **THEN** 出现创建账号引导；创建后自动登录进入控制台；再次访问直接可用

#### Scenario: 会话过期与退出

- **WHEN** 退出登录或会话过期后访问受保护路由
- **THEN** 页面 302 登录、API 401；重新登录后恢复

#### Scenario: 密码不入明文

- **WHEN** 检查 stateDir 与所有日志
- **THEN** 只出现哈希与不透明会话 id，无明文密码

#### Scenario: 首启建号仅限本机

- **WHEN** 经公网域名 Host（隧道）请求 `POST /api/daemon/auth/setup`
- **THEN** 返回 403 `SETUP_LOCAL_ONLY`；本机回环 Host 完成建号后才可从公网登录

#### Scenario: CLI 账号管理

- **WHEN** 执行 `stoa daemon account set`（无账号）与 `daemon account status`
- **THEN** 创建账号并可登录；status 只报用户名与时间，不回显密码/哈希；已有账号重置需 `--force`

### Requirement: daemon 路由门与豁免

除豁免清单外的全部路由 SHALL 要求 daemon 会话。豁免＝`GET /healthz`、`/login`、
`/api/daemon/auth/*`、静态资产、`/i/*/healthz`（任何来源）；`/api/daemon/*` 与 `/preview/*`
仅当 loopback peer **且** Host ∈ 回环 host 集合（公网域名 Host 一律走登录门）。

#### Scenario: 实例健康检查免登录

- **WHEN** 未登录请求 `/i/<slug>/healthz`
- **THEN** 返回 200 与 `{ok,instanceId,dataDir,uiVersion}`（无数据面），不触发 302/401；
  未登录请求 `/i/<slug>/api/posts` 仍 401

#### Scenario: 机器通道的 Host 条件

- **WHEN** 以公网域名 Host（经隧道）请求 `/api/daemon/services/:id/secret` 或 `/preview/<id>/`
- **THEN** 返回 302 登录 / 401，不因 peer 是本机回环而放行；以回环 Host 请求同一路径则免登录

### Requirement: 实例壳与浮动小球

`/shell/<idOrSlug>` SHALL 在 daemon 内以全屏 iframe 呈现实例（`/i/<slug>/` 或自定义 hostname），
页面 HTML SHALL 注入 `<base href="/">` 与服务端壳数据（`__STOA_SHELL__`），确保相对资产不在
SPA fallback 下被吞成 HTML；iframe 之外 SHALL 提供**浮动小球**（固定右下、solid-glass、lucide
单色）；点击 SHALL 展开快捷菜单：回到 daemon、切换实例（列表）、刷新当前实例、复制当前链接、
退出登录。交互 SHALL 键盘可达（Enter/Space 打开、Esc 关闭并归还焦点）；壳页 SHALL 设
`frame-src` 仅允许自身与已登记自定义 hostname；SHALL NOT 在壳页暴露实例 token。

#### Scenario: 壳内使用实例

- **WHEN** 已登录用户从控制台打开实例
- **THEN** 壳页 iframe 内可直接操作实例（发帖/读板），小球在右下可见

#### Scenario: 快捷切换

- **WHEN** 点击小球并选择另一实例
- **THEN** 壳页切换到目标实例（URL 与 iframe 同步），过渡无白屏错误

#### Scenario: 壳页首屏与资产

- **WHEN** 直接打开 `/shell/<slug>`（含刷新）
- **THEN** HTML 含 `<base href="/">`，其引用的 `/assets/*` 返回 JS/CSS 且 MIME 正确（非 HTML），
  页面不白屏；CSP `frame-src` 只含自身与已登记 hostname

### Requirement: 实例凭据注入

daemon 代理 SHALL 按服务记录 `authAccount`（默认 `owner`）读取 `<dataDir>/accounts/<acct>.env`，
auth 模式注入 `Authorization: Bearer` 与 `x-report-account`，open 模式仅注入 `x-report-account`，
并显式**覆盖**客户端自带的同名头（防身份冒充）；env 缺失或 token 轮换导致 401 时 SHALL 走
`tryLogin` 兜底，仍失败返回 502 可读文案。

#### Scenario: 两种实例模式

- **WHEN** 分别经 daemon 访问 auth 模式与 open 模式实例
- **THEN** 前者获得 Bearer 与 `x-report-account`，后者仅 `x-report-account`；两者板面均可用

#### Scenario: 冒充头被覆盖

- **WHEN** 已登录用户经 `/i/<slug>/` 携带伪造的 `authorization`/`x-report-account` 请求
- **THEN** 实例收到的只有 daemon 注入值（open 模式仍为 owner），拿不到伪造身份

### Requirement: proxied 判定与前端免登录门

代理 SHALL 注入 `x-stoa-daemon-proxy: <serviceId>`；实例 `/api/auth/status` SHALL 在收到该头
**且实例自身以 UDS 监听**时返回 `proxied:true`，SHALL NOT 依赖 peer 地址（UDS 上不可得、
隧道下恒为回环）。前端 SHALL 在 `proxied` 时不进入实例登录门、不落 token；`proxied` 下 401
SHALL 显示凭据不可用错误态，SHALL NOT 弹口令输入框。

#### Scenario: proxied 免登录门

- **WHEN** 浏览器经 `/i/<slug>/` 打开 auth 模式实例
- **THEN** `/api/auth/status` 返回 `proxied:true`，前端不显示实例登录门、不写 token，
  板面数据由注入凭据驱动

#### Scenario: standalone 不认 proxied

- **WHEN** 直连 `--standalone` 实例并伪造 `x-stoa-daemon-proxy` 头
- **THEN** `/api/auth/status` 的 `proxied` 仍为 false，登录门照常

### Requirement: 前端相对基址与子路径运行

公示板前端 SHALL 以相对资产基址构建（vite `base:'./'`，现状即成立）；运行期 API 基址 SHALL
由**实例根前缀**派生（`new URL('./', document.baseURI)`，`?ep=` 覆盖优先），使
`api/who`、`healthz`、`api/stream` 等拼接到 `/i/<slug>/api/…` 而非 `/api/api/…`。同源探测
SHALL 探 `${root}healthz` 并校验 `instanceId`；回环白名单 SHALL 含 `*.localhost`。嵌入模式
（proxied 或路径模式）SHALL NOT 读写 `report.ep`/`report.ep.history`（per-origin 单键会跨实例串台）；
UI 请求 SHALL 使用 `credentials:"same-origin"`。静态导出产物 SHALL 使用相对引用，
使其在根路径与 `/i/<slug>/` 等任意子路径下均可运行。

#### Scenario: 同一构建两处可用

- **WHEN** 同一前端构建分别部署在根路径与 `/i/<slug>/`
- **THEN** 资产/API 请求都落在正确前缀（无 `/api/api/` 双前缀），页面功能一致（含刷新与深链接）

#### Scenario: 静态导出子路径

- **WHEN** 导出的归档放在任意子目录并用静态服务器打开
- **THEN** 资产与媒体按相对路径加载成功

#### Scenario: 多实例并列不串台

- **WHEN** 两个实例同时经 `/i/<slug-a>/`、`/i/<slug-b>/` 嵌入
- **THEN** 两侧各自连到自己的前缀，互不写入 `report.ep`，第二个实例不落到 daemon 根

#### Scenario: 同源探测按实例前缀

- **WHEN** 页面在 `/i/<slug>/` 下加载并自动连接
- **THEN** 探测请求为 `/i/<slug>/healthz` 且校验 `instanceId` 一致，不停留在 landing 页

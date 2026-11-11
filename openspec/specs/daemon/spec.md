# daemon Specification

## Purpose
TBD - created by archiving change stoa-daemon. Update Purpose after archive.

## Requirements

### Requirement: daemon 服务与挂载管理

Stoa SHALL 提供用户级 daemon（`stoa daemon start|stop|status`，默认回环端口 13679，状态目录
`~/.local/state/stoa/daemon/`）。daemon SHALL 提供 HTTP API：`GET /healthz`、
`GET /api/daemon/services`、`POST /api/daemon/services`（挂载；`dataDir` 可选，
`location` 支持 `auto|temp|path`——auto 落 `~/.stoa/sessions/<slug>-<hex>`、temp 落系统临时目录
并在停止时删除、path 为用户目录；未初始化目录 SHALL 自动 `init`）、
`POST /api/daemon/services/:id/stop`、`DELETE /api/daemon/services/:id`、
`POST /api/daemon/shutdown`。挂载 SHALL 以 `serve --standalone` 子进程实现并登记；daemon 退出
SHALL 停止全部挂载服务。

#### Scenario: 挂载与回收

- **WHEN** `POST /api/daemon/services {dataDir}`
- **THEN** 返回服务记录（url/port/pid），该服务 `/healthz` 200；`stop` 后进程退出、登记移除

#### Scenario: 幂等挂载

- **WHEN** 对同一 dataDir 再次 `POST /api/daemon/services`
- **THEN** 返回既有服务记录，不重复起进程

#### Scenario: 无目录挂载（自动会话）

- **WHEN** `POST /api/daemon/services {location:"auto"}`（不带 dataDir）
- **THEN** 在 `~/.stoa/sessions/` 下创建并初始化会话目录，服务以认证模式启动；
  临时会话（`location:"temp"`）在停止后其目录被删除

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

daemon SHALL 在 `/` 提供 WebUI（复用前端构建并注入 `__STOA_DAEMON__`），列出挂载服务并支持
打开/停止/移除/挂载；界面 SHALL 使用 shadcn 官方收编组件。挂载 SHALL 以触发式官方 `Sheet`
提供（header 主入口与空态 CTA 均可打开），**不得**以常驻表单占据首屏。MCP 面板 SHALL 在
daemon 可用时提供「Daemon 控制台」链接。

#### Scenario: 统一管理

- **WHEN** 浏览器打开 daemon URL
- **THEN** 页面列出全部挂载服务（URL/端口/状态），并可完成一次挂载与停止操作

#### Scenario: 触发式挂载入口

- **WHEN** 用户打开 daemon WebUI（390 或 1280 视口）
- **THEN** 首屏不出现常驻表单字段；点 header「添加服务」或空态 CTA 打开官方 Sheet，
  表单在面板内完成挂载；提交成功后 Sheet 关闭、列表出现新服务

#### Scenario: 插件入口

- **WHEN** 侧栏面板打开且本机 daemon 在运行
- **THEN** 面板出现「Daemon 控制台」链接，指向 daemon URL

### Requirement: 访问口令与密钥链接

daemon SHALL 提供口令中心：`GET /api/daemon/services/:id/secret` 返回
`{mode, key, key_link, source}`（`cache-control: no-store`，仅回环面），
`PUT /api/daemon/services/:id/secret` 支持设置/重新生成口令并使其在运行中的服务上生效
（旧 access token 随即失效）；`key_link` SHALL 为 `<publicUrl|url>/#key=<key>` 的 fragment 形态
（口令不经服务端请求/日志）。daemon-webui SHALL 提供服务行「口令」入口：掩码显示、显示切换、
复制口令、复制口令链接与重新生成；开放模式服务 SHALL 可一键设置口令。前端 SHALL 在启动时
消费 `#key=` 链接（读取一次、立即抹除、自动登录一次），失败时不循环重试。

daemon-webui 的服务行「打开」主操作与行内入口链接（本地/公网）SHALL 在点击时按需读取该服务口令
（`GET /secret`）并把 `#key=<key>` 作为 **fragment** 附加到目标 URL 后打开，使用户从控制台
打开服务时无需手输口令；`mode` 非认证态、口令为空或读取失败时 SHALL 退回不带 key 的普通 URL
（失败须有可见提示），且 SHALL NOT 因此阻断打开。界面展示文本 SHALL 继续打码，
完整口令不得出现在可读文本、title 或 aria-label 中。

#### Scenario: 口令读取与轮换

- **WHEN** 对运行中的服务 `GET /api/daemon/services/:id/secret` 取到口令后用其登录
- **THEN** 登录成功；`PUT` 重新生成后再用旧口令签发的 token 请求 SHALL 返回 401，新口令可登录

#### Scenario: 口令链接即点即用

- **WHEN** 用复制出的口令链接在新浏览器上下文打开
- **THEN** 页面自动完成登录进入版，地址栏不再包含 `key=`

#### Scenario: 从控制台打开即登录

- **WHEN** 在 daemon-webui 点认证模式服务的「打开」（或行内本地/公网入口）
- **THEN** 打开的目标 URL 以 `#key=<该服务口令>` 结尾，页面自动登录进入版、地址栏 hash 被抹除；
  开放模式或口令读取失败时退回不带 key 的 URL，且失败有可见提示

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

# daemon（delta）

## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: 访问口令与密钥链接

daemon SHALL 提供口令中心：`GET /api/daemon/services/:id/secret` 返回
`{mode, key, key_link, source}`（`cache-control: no-store`，仅回环面），
`PUT /api/daemon/services/:id/secret` 支持设置/重新生成口令并使其在运行中的服务上生效
（旧 access token 随即失效）；`key_link` SHALL 为 `<publicUrl|url>/#key=<key>` 的 fragment 形态
（口令不经服务端请求/日志）。daemon-webui SHALL 提供服务行「口令」入口：掩码显示、显示切换、
复制口令、复制口令链接与重新生成；开放模式服务 SHALL 可一键设置口令。前端 SHALL 在启动时
消费 `#key=` 链接（读取一次、立即抹除、自动登录一次），失败时不循环重试。

#### Scenario: 口令读取与轮换

- **WHEN** 对运行中的服务 `GET /api/daemon/services/:id/secret` 取到口令后用其登录
- **THEN** 登录成功；`PUT` 重新生成后再用旧口令签发的 token 请求 SHALL 返回 401，新口令可登录

#### Scenario: 口令链接即点即用

- **WHEN** 用复制出的口令链接在新浏览器上下文打开
- **THEN** 页面自动完成登录进入版，地址栏不再包含 `key=`

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

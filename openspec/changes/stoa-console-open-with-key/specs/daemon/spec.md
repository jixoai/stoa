# daemon（delta）

## MODIFIED Requirements

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

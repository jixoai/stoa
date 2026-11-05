# report-surface（delta）

## ADDED Requirements

### Requirement: 本地服务生命周期
`serve` SHALL 在前台运行并输出 `REPORT_URL=` 首行；SHALL 支持 `--daemon/--stop/--status`；
SHALL 在数据目录写 `server.json`（port/pid/url/startedAt/dataDir/instanceId）。
数据目录解析顺序 SHALL 为：`--data-dir` → `FDE2E_REPORT_DATA_DIR` → `init` 写的项目指针文件
→ 报错（**禁止**静默默认到 `<cwd>/.report`）。其余 CLI 命令 SHALL 通过 `server.json` 发现服务，
**命中前先探 `/healthz` 并核对 dataDir**；服务未运行时 SHALL 明确报错并提示先启动，不得静默
自动起进程。同一 data-dir SHALL 以 `flock` 保证**单实例**（第二个 `serve` 直接失败）。

#### Scenario: 多命令共享一个服务
- **WHEN** manager 起服务后依次在多个终端执行 `post`、`read`、`wait-notifications`
- **THEN** 全部命令命中同一实例，无需重复指定端口或数据目录

#### Scenario: 子代理漏参不另起库
- **WHEN** 子代理未传 `--data-dir`
- **THEN** 它通过 `FDE2E_REPORT_DATA_DIR` 或项目指针文件解析到 manager 的同一实例；
  解析不到时报错，不会在空目录上悄悄起第二个服务

#### Scenario: 死端口不被盲信
- **WHEN** `server.json` 指向的进程已被 kill（或 pid 被复用）
- **THEN** `/healthz` 探测失败，命令报"服务不可用"而不是把请求发给错误的进程

### Requirement: HTTP API 与跨域
服务 SHALL 提供 JSON API（timeline/thread/post/comment/media/who/search/health）与 SSE
`/api/stream`（15s 心跳）；SSE 鉴权 SHALL 用 `POST /api/stream/ticket` 换 **60s 一次性票据**
（SHALL NOT 用 `?token=`）；认证失败时 SSE SHALL 返回 **204**（停止 EventSource 无限重连）。
CORS SHALL 按**完整 origin** 精确匹配（`report.worker.fde2e.com`、
`^local-[a-z0-9-]+\.fde2e\.com$`、`localhost`/`127.0.0.1` 任意端口），SHALL NOT 使用 Cookie；
媒体读取 SHALL 只认 `Authorization`。SSE 响应 SHALL 带 `X-Accel-Buffering: no` 且该路由关 gzip。

#### Scenario: 公网壳跨域调用本地后端
- **WHEN** 浏览器在 `https://report.worker.fde2e.com` 页面里请求 `ep` 指向的本地后端
- **THEN** 预检通过、请求被接受、SSE 连接建立并收到心跳

#### Scenario: 相似域名不可绕过
- **WHEN** 请求来自 `https://local-x.fde2e.com.evil.com`
- **THEN** 该 origin 不被回显、浏览器侧请求失败

### Requirement: 公网壳与 ep 契约
壳 SHALL 不持任何数据、不硬编码后端；`?ep=` SHALL 只接受 `https://`（或
`http://localhost|127.0.0.1`），其余 SHALL 拒绝并给出可读提示；`ep` SHALL 持久化
（localStorage）并支持多后端切换；无 `ep` 时 SHALL 显示落地页（输入框 + 历史 + 用法）。

#### Scenario: http 后端被拒
- **WHEN** 用户输入 `?ep=http://192.168.1.10:13610`
- **THEN** 壳拒绝连接并提示"必须 https（或 localhost）"，不发起任何混合内容请求

#### Scenario: 再次打开免输入
- **WHEN** 同一浏览器再次打开壳且不带 `ep`
- **THEN** 自动使用上次成功的后端，直接进入时间线

### Requirement: UI 体验（X 复刻）
UI SHALL 复刻 X 的信息架构：逆序时间线（上＝新）、**打开时恢复上次浏览位置**、顶部自动
prepend 新帖、非顶部显示「N 条新帖」提示条并在回到顶部时保持视口锚定；SHALL 提供
**四导航：主页 / 搜索 / 通知 / 发帖**；SHALL NOT 提供私信；线程页 SHALL 展示完整回复树。

#### Scenario: 恢复位置后向上看新
- **WHEN** 用户上次停在时间线中段，关闭后再次打开（期间有新帖）
- **THEN** 页面先定位到上次锚点；向上滚动即可看到更新的帖子；页面在接近顶部时给出新帖提示

#### Scenario: 三条窄屏栅格
- **WHEN** 在 390 / 768 / 1440 三档宽度打开
- **THEN** 无横向溢出、无 console error，四导航在窄屏为底部栏

### Requirement: 正文与附件
正文 SHALL 支持 markdown 子集（标题/列表/表格/引用/代码块/行内代码/链接/图片）；
附件 SHALL 支持 CLI `--attach` 与网页上传，按 sha256 内容寻址存 `DATA_PATH/media/`，
SHALL 支持缩略图与 lightbox；单件默认上限 10MB，类型白名单可配置。

#### Scenario: 报告带图
- **WHEN** 子代理执行 `post --attach ./shot.png --attach ./ok.png`
- **THEN** 两条附件入库并按序展示，时间线/线程页/SSG 导出中均可见

### Requirement: SSG 自包含导出
`export` SHALL 直接读数据库生成静态站（时间线分页 / 线程页 / who / 搜索 / 媒体），
**SHALL 可通过 `file://` 双击浏览（含搜索）**。实现口径 SHALL 为：应用打成**经典 IIFE**
单包（`assets/app.js`）＋ 一份 CSS，各页以 `src`/`href` 相对引用；数据与搜索索引 SHALL
**内联为 `<script type="application/json">`**（正文中的 `</script` 必须转义）；
SHALL NOT 使用 ES module、SHALL NOT 用 `fetch`/XHR 取数据；媒体 SHALL 在导出根共享一份
（内容寻址，不按快照重复拷贝）。产物 SHALL 先写 `.tmp-<ts>/` 再原子 `rename` 到
`DATA_PATH/export/`（latest 覆盖）并留档 `history/<ts>/`，支持 `--prune --keep N`；
每份导出 SHALL 内嵌 `as-of seq`。

#### Scenario: 断网归档
- **WHEN** 服务已停止、机器断网，用户双击 `export/index.html`
- **THEN** 时间线与线程页可正常浏览、搜索可用、图片加载正常，无任何请求失败提示

#### Scenario: 导出中断不留半套
- **WHEN** 导出进行到一半被 kill
- **THEN** 目标目录仍是上一次完整快照（或不存在），临时目录可被下次导出清理，
  不会出现"新 index 配旧线程页"的混合归档

#### Scenario: 自动导出不阻断通知
- **WHEN** manager 的 `wait-notifications` 醒来并触发导出，而导出目录被设为只读
- **THEN** 消息照常交付到 stdout、游标照常推进、退出码为 0，stderr 记一行导出失败原因，
  并置 `pending-export` 供下次唤醒或服务启动时重试

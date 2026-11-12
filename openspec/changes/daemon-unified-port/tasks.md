# Tasks: daemon-unified-port

> 判据不满足不得勾选。破坏性变更：实例不再占 TCP 端口；daemon 会话是经 daemon 访问实例的凭据。
> v2：按 2026-11-12 设计复核意见重构（新增消费者矩阵、proxied 判定、壳页基址、豁免清单、发布门）。

## S1. 契约与评审

- [x] S1-1. change 文档 v2（proposal/design/tasks/specs delta）定稿；`openspec validate daemon-unified-port --strict` 通过；reviewer 复核转 APPROVE（两轮 REJECT→修正→无条件 APPROVE）。
- [x] S1-2. 传输前提复核（已实测）：`Bun.serve({unix})`、`fetch({unix})`、SSE 逐块、2MB POST、多 Set-Cookie、断开传播、EADDRINUSE、stop 自动删 socket、父目录须先建（0700）。

## S2. P1 单端口虚拟主机与 UDS（daemon + serve + 发现）

- [x] S2-1. `serve`：daemon 托管实例 UDS 监听（`<stateDir>/sockets/<id>.sock`，目录 0700）；`--standalone` 保留 TCP；UDS 模式跳过 `verifyOwnership`；超长路径 fallback 短目录。
- [x] S2-2. `server.json`/`ServerInfo` 契约：`port: number|null` + `unix?`；`readServerInfo` 放宽（port/unix 至少一个）；新增 `instanceFetch(info,…)`——**单一实现用 `node:http`/`https` 的 `socketPath`（不用全局 `fetch({unix})`：Node 会静默忽略并拨 80）**，返回 `new Response(Readable.toWeb(res),…)`，ENOENT→不可达；**`status ∈ {204,205,304}` 与 HEAD 时 body 必须传 `null`**（Node 对带 body 的 204 抛 TypeError，Bun 不抛）；判据含「bun 与 node 两 runtime 都通」。
- [x] S2-3. 消费者改接 `instanceFetch`：CLI 全部命令、`serve --stop`、daemon adopt/健康/`serviceAuthMode`/`tryLogin`、dsh `lib/host/session.js` **与 `lib/host/watcher.js`（SSE `/api/stream` + ticket，注入 UDS-aware `fetchImpl`）**、MCP 默认通道（daemon.json → 首个运行服务的 **`socket`**；`?ep` 链接用 `logicalUrl`；无 daemon 记录回退 13689）。
- [x] S2-4. 路由四优先级（实际顺序：hostname → `/i/<slug>/`（任何 Host，含 daemon host）→ daemon app；初版「daemon host 优先」会让主入口路径模式不可达，已按实测修正并同步 spec）＋`/i/<idOrSlug>` 302；`--host` 与可选 `stoa.localhost`；尽力加 `[::1]:13679`。
- [x] S2-5. 服务记录：`slug`（独立生成，保留字/冲突后缀）/`hostnames[]`（RFC1123，跨实例唯一）/`socket`/逻辑 `url`/`authAccount`；`port` 兼容 null。
- [x] S2-6. 反代：剥前缀；GET/HEAD 不传 body；头处理顺序（删 hop-by-hop → 删客户端 authorization/x-report-account/cookie/x-stoa-* → 注入实例凭据 → `x-stoa-service`/`x-stoa-daemon-proxy`）；响应删 `content-encoding`/`content-length`；**不注入 CORS**。
- [x] S2-7. SSE/流式不缓冲（含 ticket 两次请求）、hub 503 原样；普通请求 60s、SSE/下载不限；实例不可达 502 可读。
  - 判据：单测/集成——路由矩阵、slug 冲突/保留字、`server.json` 新旧兼容、`instanceFetch` 双通道、头语义（content-encoding 剔除/authorization 覆盖/无 CORS/GET 无 body）、SSE 实时（无缓冲）、502；`lsof -iTCP` 无实例端口。

## S3. P2 daemon 账号、会话与凭据注入

- [x] S3-1. `daemon-accounts.json`（0600，`Bun.password.hash(pw,{algorithm:"argon2id"})`）；CLI `daemon account set|status`（set 需 `--force` 重置；status 不回显敏感内容）。
- [x] S3-2. 登录/退出/首启 setup API 与页面；cookie `HttpOnly; SameSite=Lax; Path=/`（Secure 条件、Domain 仅带点非 IP host）；sessions 0600，内存台账 + ≤30s 批量落盘，TTL 7 天滑动；退出立即失效。
- [x] S3-3. 路由门与豁免：页面 302 `/login?next=`、API 401；豁免 `GET /healthz`、`/login`、`/api/daemon/auth/*`、`/assets/**`、favicon、**`/i/*/healthz`**（daemon 侧过滤为 `{ok,instanceId,dataDir,uiVersion}`，实例 healthz 补 `uiVersion`）；**机器通道豁免**（loopback peer 且 Host ∈ 回环 host 集合）：`/api/daemon/*` 与 `/preview/*`（公网域名 Host 一律登录门，防 secret/preview 公网可读）；setup 仅账号数=0。
- [x] S3-4. 代理注入实例凭据（`authAccount` 默认 owner，0600 env，≤1s 缓存，401 时走 tryLogin 兜底）：auth → Bearer + `x-report-account`；open → 仅 `x-report-account`；**覆盖**客户端自带头防冒充；浏览器零 token。
- [x] S3-5. proxied 判定链：实例 `/api/auth/status` 增 `proxied`（判据＝带 `x-stoa-daemon-proxy` 头且实例自身 UDS 监听，**不用 peer IP**）；前端 `proxied` 时不进实例登录门、不落 token；`proxied` 下 401 显示「实例凭据不可用」错误态 + 重试，**不弹口令输入框**。
- [x] S3-6. UI 请求 `credentials:"same-origin"`（`api.ts` 三处、`ep.ts` 两处）；嵌入模式不读写 `report.ep`/`report.ep.history`。
  - 判据：未登录 302/401；登录后经 `/i/<slug>/` 直接可用且 `/api/auth/status.proxied===true`；页面/响应/日志无实例 token 与明文密码；多实例并发 iframe 无串台（第二实例不连到 daemon 根）。

## S4. P3 壳与浮动小球

- [x] S4-1. `/shell/<idOrSlug>` 服务端直出 HTML：`<base href="/">`、`__STOA_SHELL__`、CSP `frame-src 'self' + 已登记 hostname`；`uiResponse` 显式分支（`/index.html`→daemon、`/shell/*`→shell、`/login`→无注入），杜绝 SPA fallback 吞资产。
- [x] S4-2. 全屏 iframe + 右下浮动小球（44px、solid-glass、lucide 单色、无 HTML 阴影）；菜单：回到 daemon / 切换实例 / 刷新 / 复制链接 / 退出登录；键盘可达（Enter/Space/Esc＋焦点归还）；reduced-motion 降级。
- [x] S4-3. 控制台「打开」与行内入口改进入壳；控制台与壳页 fetch 一律绝对 `/api/…`。
  - 判据：E2E——`/shell/<slug>` 首屏无白屏（资产 200 且 MIME 正确）；壳内可发帖/读板；切换实例 URL 与 iframe 同步；无 token 泄漏。

## S5. 前端基座补缺（相对基址现状验证 + 运行期修正）

- [x] S5-1. API 基址派生实例**根前缀**（`new URL("./", document.baseURI)`；`?ep` 覆盖优先）；`probeSameOriginEp` 探 `${root}healthz` 并校验 `instanceId`。
- [x] S5-2. `checkEp` 放行 `*.localhost`（`LOOPBACK_HOSTS` 扩展）。
- [x] S5-3. 静态导出相对引用现状复核（`./assets/`、`media/`）＋根路径/`/i/<slug>/` 两处同构建实测。
  - 判据：根路径与 `/i/<slug>/` 两处资产/API 全部落在正确前缀（无 `/api/api/`）；导出归档子目录可开；刷新与深链接正常。

## S6. QA 与迁移面

- [ ] S6-1. QA 脚本新增（另：`test/e2e-cli.sh` S12 陈旧多页断言已按 v0.6+ 单文件导出现代化，187 PASS / 0 FAIL）：登录/首启/退出、路由矩阵、SSE 实时、502、壳/小球/切换、`/i/*/healthz` 免登录、`/preview/*` 非回环需登录、旧 `?ep` 仅 standalone、CLI `daemon account`；既有断言零回归（daemon 相关 75 处 port 断言同步迁移）。
- [ ] S6-2. 报告 `.agents/reports/manager/daemon-unified-port/`（before/after：多端口清单→单端口壳+小球；登录/壳/菜单截图；Host 模式 cookie 浏览器实测结论；UNCOVERED=0）。

## S7. 收口与发布门

- [ ] S7-1. 门禁：`bun run check`/typecheck/全量 test/build/`openspec validate --strict`/`npm pack`。
- [ ] S7-2. reviewer 复核（路由/鉴权/注入/流式/测试有效性）；处理后发 **0.7.0**（插件 lockstep＋bridge 钉版同步）。
- [ ] S7-3. FDE2E companion change 立项登记（`stoa-session.sh`/隧道/文档迁移），**不在本 change 实现**。
- [ ] S7-4. 发布门：companion change 就绪并与 v0.7.0 同窗口才发 `latest`；未就绪仅 beta/prerelease（避免一次性切断 FDE2E 会话链接）。

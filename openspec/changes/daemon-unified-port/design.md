# Design: daemon-unified-port

> v2（2026-11-12 设计复核后重写）：修正传输层实测口径、补「消费者矩阵 / proxied 判定 / 壳页基址 /
> 豁免清单」四个 P0 缺口。架构方向不变。

## §0 决策摘要

- daemon 唯一监听 `127.0.0.1:13679`（`--port` 可改；尽力加 `[::1]:13679` 次监听，失败仅告警）；
  实例进程以 **UDS** 监听 `<stateDir>/sockets/<serviceId>.sock`，不占 TCP。
- 单入口四优先级路由：daemon host → 实例 `hostnames[]` → `/i/<idOrSlug>/` → daemon app。
- daemon 独立账号密码 + HttpOnly 会话 cookie；除豁免清单外全部要求登录。
- 经 daemon 访问实例时**服务端注入实例凭据**（浏览器零 token）；注入事实以 `x-stoa-daemon-proxy`
  告知实例，实例 `/api/auth/status` 回 `proxied:true`，前端据此跳过登录门。
- `/shell/<idOrSlug>`：全屏 iframe + 右下浮动小球（回到 daemon / 切换实例 / 刷新 / 复制链接 / 退出）。
- 非浏览器消费者（CLI/MCP/dsh/adapters/QA）走 **`instanceFetch`（UDS 优先）**，本机零认证、
  不改 token 语义；只有浏览器跨 origin 场景才用 daemon 会话。

## §1 传输与实例发现（P0-5）

### 1.1 UDS 监听（serve 侧）
- `Bun.serve({unix})`、`fetch(url,{unix})`、SSE 逐块、2MB POST、多 `Set-Cookie`、客户端断开传播
  均已在 Bun 1.4.4 实测通过（`/tmp/stoa-uds-probe/`）。
- 目录：`<stateDir>/sockets/` 必须先 `mkdirSync(...,{recursive:true,mode:0o700})`——
  父目录不存在时 `Bun.serve({unix})` **直接 ENOENT**，不会自动建。
- socket 文件实测落盘权限 **0755**（umask 022），安全由父目录 0700 承担；实现可 best-effort
  `chmod 0600`，但**不把文件权限当判据**。
- UDS 语义：重复 bind = `EADDRINUSE`（「bind 成功≠归属」问题不存在），
  `serve.ts:167-180` 的 `verifyOwnership()` 在 UDS 模式**整段跳过**；`server.stop(true)`
  自动删除 socket 文件；残留 socket 文件 Bun 会自行 unlink 后重绑。
- 路径长度：`<stateDir>/sockets/<id>.sock` 在 macOS 117 字符可 bind；文档注明自定义深路径风险，
  超 90 字符时 fallback 到 `os.tmpdir()` 下的 daemon 专属短目录并在 server.json 记录实际 socket。

### 1.2 `server.json` / `ServerInfo` 契约（新增，P0-5）
```jsonc
{
  "instanceId": "…", "dataDir": "…",
  "port": 13684,            // daemon 托管时 null（兼容字段）
  "unix": "/…/sockets/svc-xxx.sock",  // daemon 托管时必填
  "url": "http://127.0.0.1:13684",    // standalone 时 TCP origin；UDS 时逻辑 URL
  "pid": 1234, "uiVersion": "0.7.0", "startedAt": "…"
}
```
- `readServerInfo`（`src/server/discovery.ts:67`）放宽：`port` 允许 `null`，但 `port` 与 `unix`
  至少一个存在；旧文件（纯 port）仍有效。
- 新增 `src/server/instance-client.ts`：`instanceFetch(info, path, init)`——**单一实现用
  `node:http`/`node:https` 的 `request({socketPath})`**（`info.unix` 存在时）返回
  `new Response(Readable.toWeb(res), {status, headers})`，否则走普通 `fetch(info.url + path)`。
  理由：实测 Node 26 的全局 `fetch` **忽略 `unix` 选项**（静默拨 `127.0.0.1:80` 并拿到无关
  服务的 404 HTML），而 MCP/adapters 都在 Node 上跑；`node:http`+`socketPath` 在 Bun 与 Node
  两个 runtime 都通。空 socket 抛 ENOENT，调用方必须 catch 并映射为「实例不可达」。
  **判据：同一 helper 必须在 bun 与 node 两个 runtime 下都返回 200 + 实例 JSON。**
- `probeHealthBody` / `serverStatus` / `stopServer` / daemon `adopt` / `serviceAuthMode` /
  `tryLogin` / CLI `ApiClient` / dsh `lib/host/session.js` 全部改走 `instanceFetch`。
- **dsh SSE 通道**（`lib/host/watcher.js` 的 `/api/stream` + ticket 两次请求）：`fetchImpl(url)`
  形状套不上 `instanceFetch(info,path)`，须换成 UDS-aware 适配器（同一 socket），否则健康探测
  正常而 SSE 401/连错端口——最难查的半坏状态。

### 1.4 机器通道 vs 链接通道（N1）
- **机器通道**（I/O）：`instanceFetch` over UDS，供 CLI/MCP/adapters/dsh/QA 读写数据。
- **链接通道**（人看）：`logicalUrl` = `http://<daemon>:13679/i/<slug>/`（或自定义 hostname），
  供 `postUrl`/面板链接/`?ep=` 深链生成。两者在配置里分字段（`socket` / `logicalUrl`），
  不得混用——`/i/<slug>/` 是 cookie 通道，机器消费者走它必 401。

### 1.3 消费者矩阵
| 消费者 | 通道 | 凭据 |
|---|---|---|
| 浏览器（经 daemon） | `/i/<slug>/` 或实例 hostname | daemon 会话 cookie；实例凭据由 daemon 注入 |
| 浏览器（`--standalone` 直连） | `?ep=http://127.0.0.1:<port>` | 实例 token（现状不变） |
| CLI（`stoa …`） | `instanceFetch` / daemon API | 本机零认证（daemon 面沿用现状回环信任 + 后续机器令牌） |
| MCP / adapters / dsh | `instanceFetch`（读 server.json 或 daemon.json） | 实例 token 直连 UDS，不经 daemon 会话 |
| QA / e2e | `instanceFetch` + daemon 登录夹具 | 同上 |

MCP 默认通道：读 `daemon.json` → 首个运行服务的 **`socket`（UDS，机器通道）**；
`?ep=` 链接生成一律用 `logicalUrl`（浏览器通道）。无 daemon 记录时回退
`http://127.0.0.1:13689`（standalone 调试兼容）。

## §2 路由（单入口）

1. `Host`（小写、去端口、去尾点）∈ daemon host 集合（`127.0.0.1`/`localhost`/`[::1]`/`--host` 值/
   可选 `stoa.localhost`）→ daemon app。
2. `Host` 精确命中某实例 `hostnames[]` → 代理该实例（路径原样透传）。
3. 路径前缀 `/i/<idOrSlug>/` → 剥前缀代理；`/i/<idOrSlug>`（无尾斜杠）→ 302 补斜杠。
4. 其它 → daemon app（SPA fallback / 404）。

- `slug`：`[a-z0-9][a-z0-9-]{1,31}`，由独立实现生成（**不复用** `sessions.ts` 的 `slugify`，
  它会产出 1 字符与尾随 `-`）：name 小写、非 `[a-z0-9]` 折 `-`、压缩、去首尾 `-`、
  不足 2 字符补 `x`、超 32 截断；冲突加 `-2`/`-3`…；保留字
  `api|assets|login|logout|shell|i|preview|healthz|favicon.ico` 拒绝并顺延后缀。
- `hostnames[]`：RFC 1123 label（1–63、可含 `-`、不含端口/路径/通配），跨实例唯一，
  大小写不敏感；daemon host 集合成员不得占用。

## §3 反向代理

### 3.1 请求
- 剥 `/i/<slug>` 前缀（路径模式）；Host 模式原样。query 原样。
- **GET/HEAD 不得传 `body`**（传 `req.body` 会炸）。
- 头处理（顺序固定）：
  1. 删除 hop-by-hop：`connection`、`keep-alive`、`transfer-encoding`、`upgrade`、`proxy-*`、`te`、`trailer`；
  2. **删除**客户端自带的 `authorization`、`x-report-account`、`cookie`、`x-stoa-service`、
     `x-stoa-daemon-proxy`（防冒充；open 模式下 `x-report-account` 是声明式身份，不覆盖=越权）；
  3. 注入实例凭据（§5）；
  4. 注入 `x-stoa-service: <slug>`、`x-stoa-daemon-proxy: <serviceId>`；
  5. **不注入 `x-forwarded-*`**：Bun `fetch` 总是把 `Host` 重写为 URL host，实例侧也没有任何
     消费点（grep 为空）——写了就是死代码。若将来需要规范链接，由实例 `/api/status` 显式回
     `public_url`（本 change 不做）。

### 3.2 响应
- 透传 status 与 headers，但**删除 `content-encoding` 与 `content-length`**：Bun `fetch` 会解压
  上游 body 却保留这两个头（实测 39 字节 gzip → 解压后 262 字节仍标 gzip，下游报 `ZlibError`）；
  `accept-encoding: identity` 不能阻止解压。同时删除 hop-by-hop。
- `Set-Cookie`：实例生产代码**不用 cookie**（`src/server/auth.ts` 只认 Bearer / open 模式头），
  原样透传即可，不做 origin 改写（原文档此条为伪需求，删除）。
- **不注入 CORS**：daemon 现有 `ACAO:*` 中间件不得作用于反代响应（同源 iframe 不需要）。
- SSE/流式：直接 `return new Response(upstream.body, …)`，不缓冲；`idleTimeout:0` 已由 daemon 设置；
  客户端断开自动传播取消（实测）。ticket 流程两次请求（`POST /api/stream/ticket` →
  `GET /api/stream?ticket=`）都经代理注入，hub 的 503（连接上限）必须原样透传，不得改写为 502。
- 超时：普通请求 60s；`text/event-stream` 与附件下载不设上限。
- 不可达（ENOENT/ECONNREFUSED/socket 超时）→ **502** + 可读原因（实例名/slug/状态/「重启」指引），
  不静默回落控制台。
- **Range**：实例当前**不支持** Range（`src/server/http.ts` 无 206 / `accept-ranges`）。
  本 change 只承诺「不额外破坏」：若上游返回 206 与 `content-range` 则原样透传；
  **不把 Range 写入验收判据**。（实例侧 Range 支持另立 change。）

## §4 daemon 账号与会话

- `daemon-accounts.json`（0600）：`{accounts:[{username,passwordHash,createdAt,updatedAt}]}`；
  `Bun.password.hash(pw, {algorithm:"argon2id"})`——**必须显式传 algorithm**（1.4.4 传 cost 参数而
  不传 algorithm 直接 TypeError）。校验 `Bun.password.verify`。
- CLI：`stoa daemon account set [--username] [--password-stdin]`（无账号=创建；有账号需 `--force`）、
  `stoa daemon account status`（只报用户名/创建时间，绝不回显哈希以外的凭据内容）。
- 会话：登录成功生成 128-bit id；`stoa_daemon` cookie `HttpOnly; SameSite=Lax; Path=/`；
  非回环或 HTTPS 时加 `Secure`；**Domain 只在 daemon host 是带点的非 IP 时**设为 `.` + 后缀
  （bare `localhost` 与 IP 一律 host-only）。
- 存储 `daemon-sessions.json`（0600）：**内存台账为准 + 变更/定时（≤30s）落盘**，避免每请求原子写；
  TTL 7 天**滑动**（内存里更新 `expiresAt`，落盘按批）；过期清理在读写路径顺手做。
- 退出登录：删台账条目 + 落盘 + 清 cookie；该会话立即 401。
- 首启 setup：`POST /api/daemon/auth/setup` 仅当账号数=0；页面同条件显示引导。

### 4.1 路由门与豁免清单
需登录（会话 cookie）：`/`、`/shell/*`、`/i/*`（healthz 除外）。
豁免（任何来源）：
- `GET /healthz`（daemon 自身）
- `/login`、`/api/daemon/auth/*`
- 静态资产 `/assets/**`、`/favicon*`
- **`/i/<slug>/healthz`**（含 Host 模式的 `/healthz`）：dsh `probeInstance`、适配器身份守卫、
  监控都靠它；拦住=全链路误判不健康。响应由 daemon 过滤为 `{ok,instanceId,dataDir,uiVersion}`
  （实例 healthz 需补 `uiVersion`），无数据面。
**机器通道豁免（loopback peer 且 Host ∈ 回环 host 集合）**：
- `/api/daemon/*`（除 auth）：`stoa daemon status|stop|shutdown`、`serve --stop`、挂载/停止服务、
  `GET …/secret` 全部依赖它；CLI 不带会话 cookie。
- `/preview/*`：保留 v0.6.0 本机静态预览直开行为。
- **为什么必须加 Host 条件**：本项目公网流量经本机 frpc 落地，peer 恒为 `127.0.0.1`——
  只看 peer 等于把 `/api/daemon/services/:id/secret`（返回实例口令）和 `/preview/*`（板面快照）
  在公网隧道下变成**无认证可读**。Host 命中公网域名时一律走登录门。
- 回环 host 集合 = `127.0.0.1` / `localhost` / `[::1]` / `--host` 显式值（**不含** `stoa.localhost`
  与自定义实例 hostname，它们属于浏览器面）。
- 本机浏览器直接访问 `127.0.0.1:13679/api/daemon/*` 也会命中机器豁免（与今天 daemon 无鉴权等价，
  属本机用户信任域）；公网暴露时该面被 Host 条件挡住。机器令牌（`<stateDir>/daemon-token` 0600）
  列为 companion change 的前置条件（当 daemon 需要跨机机器访问时启用）。

未登录响应：页面 `302 /login?next=<path>`；`/api/*` 与 `/i/*/api/*` → 401 JSON。

## §5 代理注入实例凭据（P0-1）

- 服务记录增 `authAccount`（默认 `"owner"`）；代理前读 `<dataDir>/accounts/<authAccount>.env`（0600）：
  - auth 模式 → `Authorization: Bearer <STOA_TOKEN_<ACCT>>` + `x-report-account: <acct>`；
  - open 模式 → 仅 `x-report-account`。
- 读 env 加 **≤1s TTL 缓存**；文件缺失或 token 已轮换（401）时先用 daemon 既有 `tryLogin`
  路径兜底（`src/daemon/server.ts:465-479`），仍失败 → 502，文案含「实例凭据不可用」。
- **proxied 判定链**：代理注入 `x-stoa-daemon-proxy: <serviceId>`；实例 `/api/auth/status` 响应增
  `proxied: boolean` = 请求带该头 **且实例自身以 UDS 监听**（`deps.unix != null`；standalone 恒 false）。
  **不用 peer IP 判定**：UDS 上 `requestIP()` 返回 `null`，frp 下 peer 恒为回环，两者都不可靠；
  UDS 的信任来自文件系统权限（只有本机可连），header 只作模式标记。前端 `connection.tsx` 在
  `mode==="auth" && !token && proxied` 时**不进登录门、不落 token**，直接以注入凭据驱动挂载。
- **proxied + 401 的 UX（N3）**：注入凭据不可用（env 缺失/轮换失败）时，前端 SHALL 显示
  「实例凭据不可用（daemon 代理）」错误态 + 重试，**不得**弹出实例口令输入框（用户没有该口令，
  弹了只会误导）。
- 浏览器零 token：响应头/HTML/JS 全局不得出现实例 token；测试断言扫描页面与 200 响应文本。

## §6 前端基座（现状复核 + 补缺，P0-2/P1-9~11）

- **`vite.config.ts:37` 已经是 `base:"./"`**，静态导出已相对化（`export.ts` 的 `./assets/`、
  `media/<hash>`）——本 change 不再「改构建」，改为**验证并补齐运行期缺口**。
- API 基址派生的是**实例根前缀**，不是 `/api`：
  `const root = new URL("./", document.baseURI)`；`ReportClient` 用 `new URL("api/who", root)`
  等拼接（现状 `new URL("api", document.baseURI)` 会得到 `/i/<slug>/api`，再拼 `/api/who` 变成
  `/api/api/who`）。`?ep=` 覆盖优先，语义不变。
- `probeSameOriginEp`（`ep.ts:70-99`）改为探测 `${root}healthz` 并校验 `instanceId`；
  `LOOPBACK_HOSTS`（`ep.ts:21`）纳入 `*.localhost`（Host 模式与深链需要）。
- **嵌入模式（proxied=true 或路径模式）不读写 `report.ep` / `report.ep.history`**：
  这两个键是 per-origin 单键，路径模式下多实例共享 origin 会串台（第一个实例把 origin 钉死，
  第二个 iframe 起来连到 daemon 根）。`report.token.<base>` 含 slug，保持现状。
- UI fetch 的 `credentials` 由 `"omit"` 改 `"same-origin"`（`api.ts` 三处 + `ep.ts` 两处）：
  路径模式同源，靠 cookie；跨源 Bearer 路径行为不变。
- 壳页与登录页 HTML 注入 `<base href="/">`，`uiResponse` 对 `/shell/*`、`/login` 走显式分支
  （否则 `base:"./"` 的 `/shell/assets/app-<hash>.js` 会命中 SPA fallback 返回 HTML → 白屏）；
  壳页内 fetch 一律绝对 `/api/…`。

## §7 壳与浮动小球

- `/shell/<idOrSlug>`：服务端直出 HTML（注入 `__STOA_SHELL__ = {serviceId, slug, url, instances[]}` +
  `<base href="/">` + CSP `frame-src 'self' <已登记 hostname…>`）；`<iframe src="/i/<slug>/">` 全屏。
- 浮动小球：固定右下 44px、solid-glass、lucide 单色、无 HTML 阴影（窗口内像素承担）；
  `DropdownMenu`（shadcn 官方件）菜单项：回到 daemon、切换实例（运行中列表）、刷新当前 iframe、
  复制当前链接、退出登录。
- 键盘：小球 `button` 可聚焦，Enter/Space 展开、Esc 关闭并归还焦点；`prefers-reduced-motion`
  不做位移动画。
- 控制台「打开」与行内入口 → `/shell/<idOrSlug>`；控制台 fetch 改绝对 `/api/…`。
- `uiResponse` 的 index 注入按 `rel` 分支：`/index.html` → `__STOA_DAEMON__`；
  `/shell/*` → `__STOA_SHELL__`；`/login` → 无注入。

## §8 兼容与迁移（破坏性）

- `?ep=http://127.0.0.1:<port>` 旧直连：**仅 `--standalone` 实例有效**（daemon 托管实例没有 TCP）。
  统一口径，不再出现「迁移期 daemon 实例也支持 ?ep」的说法。
- 口令 / `#key=` 链接：仅 `--standalone` 直连；Host 模式与路径模式都是 daemon 代理，
  实例口令不参与。**保留**既有约束：完整口令不得进入可读文本/title/aria-label；
  daemon-webui 口令入口（掩码/复制/轮换）保留。
- 「仅回环面」约束由「loopback bind + daemon 会话」双层替代：daemon 仍只 bind 回环；
  公网暴露是 companion change（隧道）的事。
- **发布门（P1-14）**：v0.7.0 必须与 FDE2E companion change（`stoa-session.sh` 不再按会话分配
  端口/隧道、统一 `https://<daemon 域名>/i/<slug>/`）**同一窗口发布**；companion 未就绪前
  只发 `0.7.0-beta` tag 或走 prerelease，不发 `latest`。不做「每服务额外监听旧 TCP 端口」兼容层
  （与单端口目标冲突，且会把端口池带回来）。
- 端口池 13680–13699：daemon 托管模式退役；`--standalone` 调试继续用。
- `stoa daemon status|stop|shutdown` 等 CLI 继续走 daemon HTTP，命中**机器通道豁免**
  （loopback peer 且 Host ∈ 回环 host 集合），不要求 daemon 登录；公网域名 Host 不命中该豁免。
  daemon 真正需要跨机机器访问时启用 `<stateDir>/daemon-token`（0600）机器令牌——列为
  companion change 的前置条件（daemon 一旦公网暴露且需机器访问，必须先有令牌）。

## §9 验证设计

- 单测/集成（隔离 stateDir + 临时 UDS）：
  - 路由矩阵（daemon host / 自定义 host / `/i/<slug>/` / `/i/<id>` 302 / 未知）；
  - slug 生成（1 字符、尾随 `-`、保留字、冲突后缀）与 hostname 校验；
  - `instanceFetch` 双通道 + `readServerInfo` 旧/新文件兼容；
  - 代理头语义（content-encoding 剔除、authorization 覆盖、hop-by-hop 剔除、无 CORS、
    GET 不传 body）；
  - SSE 逐块（无缓冲）、hub 503 透传、502 文案；
  - 账号哈希（argon2id 显式算法）、登录/退出/TTL 滑动/setup 仅账号数=0；
  - proxied 判定（auth/open 两模式 + 浏览器零 token 扫描）；
  - 壳页 HTML 形状（`<base href="/">`、CSP、无 token、`__STOA_SHELL__`）。
- E2E（隔离 daemon，真实浏览器）：
  登录/首启 → 控制台 → 打开实例（壳 iframe 内板面可用、无登录门）→ 小球菜单（回 daemon / 切换 /
  复制 / 退出）→ 发帖经 SSE 实时出现 → `/shell/<slug>` 首屏无白屏 → Host 模式 cookie 实测
  （若浏览器拒绝 `Domain=.stoa.localhost`，回退路径模式并在报告登记）→ 未登录 302 回跳 →
  实例 healthz 免登录 → 非回环 peer 访问 `/preview/*` 需登录。
- 报告：HTML（before/after：多端口清单→单端口壳+小球；登录/壳/菜单截图），UNCOVERED=0，
  逐文件覆盖表（三类无视觉面显式登记）。

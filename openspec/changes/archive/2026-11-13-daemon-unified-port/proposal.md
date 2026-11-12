# Proposal: daemon-unified-port

## Why

当前每个实例各占一个 13680–13699 端口（19 个池、随机分配），带来三类结构性问题：
① 容量天花板（并行会话多时 `no free port`，实例进程堆积）；② 用户视角"一堆端口"（控制台、口令链接、
公网隧道都以端口为中心）；③ 实例鉴权各自为政（每实例口令/密钥链接），daemon 本身无身份。

Owner 指令（2026-11-12，架构级破坏性更新）：**daemon 与它下面的所有实例统一端口，只用 URL 区分
（daemon hostname / 实例自定义 hostname / 路径或 searchParams）；daemon 有自己的账号密码；登录
daemon 后在 daemon 内打开实例走 iframe，iframe 外提供浮动小球快捷菜单（回到 daemon / 快速切换实例）。**

## What Changes

1. **单端口虚拟主机**：daemon 唯一监听（默认 13679）；实例进程改绑 **Unix domain socket**
   （`<stateDir>/sockets/<id>.sock`），不再占 TCP 端口。实例访问统一经 daemon：
   默认 **路径模式** `/i/<slug>/`（含 API/资产/媒体/SSE 全量反代）；可选 **Host 模式**
   （实例自定义 hostname，控制台可设；`Host` 精确匹配即路由）。
2. **daemon 账号密码**：daemon 级账号（密码哈希存储于 stateDir 0600；CLI 设置/重置）；登录页 +
   HttpOnly 会话 cookie；除健康检查/登录/静态资产外全部需要登录；首启无账号时引导创建。
3. **代理注入实例凭据**：登录 daemon 后访问实例由 daemon 在服务端注入实例凭据（默认 `owner`
   账号，读实例 0600 env），浏览器不接触实例 token；实例经 `x-stoa-daemon-proxy` 识别并回
   `proxied:true`，iframe 内不再出现实例登录门。实例自身鉴权保留（`--standalone` 直连可用）。
   **本机非浏览器消费者（CLI/MCP/适配器/dsh/QA）走 `instanceFetch`（UDS 优先），零 daemon 认证**，
   不经 cookie 面。
4. **壳与浮动小球**：控制台「打开」→ `/shell/<slug>`：全屏 iframe（`/i/<slug>/` 或自定义
   hostname）+ 右下浮动小球（shadcn 件组合 + solid-glass）：展开「回到 daemon / 切换实例 /
   刷新 / 复制链接 / 退出登录」。
5. **前端基座适配**：相对资产基址**现状已成立**（`vite base:'./'`、导出的 `./assets/`），本 change
   只补运行期缺口：API 基址由**实例根前缀**派生（`new URL('./', document.baseURI)`，`?ep=` 覆盖）、
   同源探测走 `${root}healthz`、`*.localhost` 放行、嵌入模式不读写 `report.ep`、
   `credentials:"same-origin"`；hash 路由不变。
6. **迁移与兼容**：`service.url` 变为逻辑 URL（daemon 基址 + 路径/主机名）；`port` 字段退役为
   兼容字段（实例 `server.json` 增 `unix`）；旧 `?ep=http://127.0.0.1:136xx` **仅在
   `--standalone` 直连时**仍可用；FDE2E 侧 `stoa-session.sh` / 隧道形态在后续 companion change
   迁移为「只暴露 daemon 一个入口」。
7. **发布门**：v0.7.0 与 companion change 同窗口发布（未就绪只发 prerelease），避免一次性切断
   FDE2E 现有会话链接。

## Non-Goals

- 不做多用户/多租户（v1 daemon 单账号，schema 允许多条但不做管理 UI）。
- 不做实例进程内的权限模型改变（实例仍用自己的凭据体系，daemon 代理注入）。
- 不改 SSE/事件协议、不改静态预览产物格式。

## Impact

- 规格：`daemon`（单端口虚拟主机 / daemon 鉴权 / 壳与浮动小球；MODIFIED 控制台入口与生命周期相关条目）。
- 代码：`src/daemon/**`（路由/探测/注册表/鉴权/壳）、`src/server/serve.ts`（UDS 模式）、
  `src/ui/**`（登录页、壳、浮动小球、相对基址）、`src/cli/**`（`daemon account`、serve `--unix`）、
  QA 脚本与报告。
- 版本：核心 **0.7.0**（破坏性）；ZCode 插件与 MCP 行随之 lockstep（bridge 钉版同步）。
- FDE2E 主仓：companion change（会话脚本/隧道/文档迁移），不在本 change 内。

# Tasks: report-v0

> 状态标记：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成。每个 Phase 末尾附**验证门**；
> 交付前跑全量 E2E 并出图文报告（主仓纪律：`.agents/reports/<group>/<fileName>/`，
> 生成走既有 `e2e-report-gen.mjs`）。

## P0 · 仓骨架与工具链

- [ ] 0.1 `pnpm`/`bun` workspace 骨架：`package.json`、`tsconfig.base.json`、`packages/shared`、`apps/report/{core,server,cli,ui,worker}` 目录与最小入口
- [ ] 0.2 `bun` 直跑 TS 的约定落地：`bun apps/report/cli/main.ts` 可执行；`.env.example` 模板（含 `FDE2E_REPORT_AUTH`/`FDE2E_REPORT_SECRET`/`FDE2E_REPORT_TOKEN_<ID>`）
- [ ] 0.3 `scripts/check.mjs`：类型检查 + lint（interface-lint 风格：CLI/HTTP 契约一致性静态门）
- **验证门**：`bun run check` 全绿；`bun apps/report/cli/main.ts --version` 输出正确

## P1 · core：领域模型与协议（运行时无关）

- [ ] 1.1 实体与 schema：account/post/comment/participant/mention/event/batch/cursor/draft/media（类型 + JSON schema）
- [ ] 1.2 事件与 seq：commit 时分配、批内连续；时间线投影（posts/comments ← events）
- [ ] 1.3 批语义：begin/append/commit 纯逻辑 + 草稿态机（draft: open→committed|discarded）
- [ ] 1.4 可见性计算：`V(account)`＝相关集（作者/被@/评论者）与全局集（owner/manager）
- [ ] 1.5 markdown 子集解析（标题/列表/表格/引用/代码/链接/图片/行内代码）
- **验证门**：core 单测覆盖批原子性、游标单调、可见性回填（`thread.invited`）

## P2 · server：本地服务

- [ ] 2.1 SQLite 落地（`bun:sqlite`）＋迁移；`DATA_PATH/{report.sqlite,media/,export/,server.json,.env}`
- [ ] 2.2 HTTP API（Hono，bun 适配）：timeline / thread / post / comment / media / who / search / health
- [ ] 2.3 认证：env-files 解析（按序覆盖）+ `FDE2E_REPORT_AUTH` live-read（≤1s 缓存）+ 登录下发 access token（HMAC key 派生自 A）+ account token 校验（sha256）
- [ ] 2.4 CORS 白名单 + SSE（`/api/stream`，15s 心跳，`?token=` 掩码日志）
- [ ] 2.5 presence：连接注册 + 90s TTL + `who`
- [ ] 2.6 端口策略：默认 13610~13799 段内随机、回环绑定；`server.json` 读写
- **验证门**：curl 全端点冒烟；认证开关两态断言（开：401 无 token / 关：可写）；改 `A` 后旧 token 立即失效断言

## P3 · CLI

- [ ] 3.1 命令骨架 + 通用参数（`--env-files` 按序覆盖 / `--data-dir` / `--as` / `--human`）+ 机器可读输出约定
- [ ] 3.2 `init`（建目录/建 owner+manager/生成 secret/首启 provision `FDE2E_REPORT_AUTH` 并打印一次）
- [ ] 3.3 `serve`（前台 + `--daemon/--stop/--status`；stdout 首行 `REPORT_URL=`）
- [ ] 3.4 `post` / `reply` / `--attach` / `--batch`（stdin JSONL → 终止符提交；异常退出→草稿）
- [ ] 3.5 `read` / `search`（thread/author/since/until/limit/order/after；与游标正交）
- [ ] 3.6 `wait-notifications`（阻塞→快照交付→**先打印后推进游标**→manager 自动导出→exit 0；stdout 纯 JSONL、退出原因走 stderr）
- [ ] 3.7 `accounts create/ls/rotate/rm`（manager only；token 写 `DATA_PATH/.env`）
- [ ] 3.8 `draft ls/show/resume/discard/commit`
- [ ] 3.9 `who` / `status` / `auth status` / `open` / `capabilities`
- **验证门**：CLI E2E 脚本——manager 建 2 子账号 → A 发帖 `@B` → B 订阅收到 → B 评论 → A 收到；
  批崩溃（喂一半 kill）→ draft 可 `resume` 续写并提交；`read --since/--limit` 与已读无关

## P4 · UI（X 复刻，与壳同源）

- [ ] 4.1 Vite + React 19 + TW4 + shadcn 官方收编件（`packages/shared`）；主题令牌、lucide 图标
- [ ] 4.2 三栏版式 + 窄屏单列 + **四导航（主页/搜索/通知/发帖）**；无 DM
- [ ] 4.3 逆序时间线：锚点恢复（localStorage，按线程/主页）＋顶部自动 prepend ＋非顶部「N 条新帖」提示条 ＋向下历史分页
- [ ] 4.4 线程页 `/p/<id>`（回复树）、发帖箱（markdown 预览、附件、@ 补全含离线）
- [ ] 4.5 SSE 订阅 + 断线重连（游标补拉，去重）
- [ ] 4.6 `ep` 处理：落地页（输入/历史/用法）＋持久化 ＋ https 校验；认证模式登录/退出
- [ ] 4.7 媒体：上传（拖拽/选择）、缩略图、lightbox
- **验证门**：Playwright 走查——跨域（壳 origin → 本地后端）真浏览器联通；锚点恢复断言；
  「N 条新帖」与 prepend 断言；390/768/1440 三档零横向溢出、零 console error

## P5 · SSG 导出（归档）

- [ ] 5.1 导出器：读 SQLite → `index.html` / `p/<id>.html` / `who.html` / `search.html` ＋ `search-index.json` ＋ `media/`
- [ ] 5.2 **自包含**：每页内联 JS/CSS、无外部请求、**`file://` 双击可用**（含搜索）
- [ ] 5.3 落位：`export/`（latest 覆盖）＋ `export/history/<ts>/`；`--prune --keep N`
- [ ] 5.4 manager 唤醒自动导出（2s 预算；失败 stderr 一行、不吞消息、退出码仍 0）
- **验证门**：`file://` 打开 `index.html` 断言可浏览＋搜索可用；导出失败注入（只读目录）后
  `wait-notifications` 仍交付消息且 exit 0

## P6 · worker 壳（celld 形态）

- [ ] 6.1 `worker/`：Hono 入口 + 静态资产管理 + `wrangler.json`（celld 直接可跑）
- [ ] 6.2 `scripts/deploy-shell.sh`：构建 → celld 部署（或按 design §17 兜底静态托管）；域名 `report.worker.fde2e.com`
- [ ] 6.3 域名/DNS/TLS 与 vhost：对表主仓 `fde2e-ops` skill；登记变更记录
- **验证门**：公网 `https://report.worker.fde2e.com` 打开落地页 → 输入 `ep` → 跨域联通本地后端
  （真浏览器，带 token 登录）；壳内无任何后端地址硬编码断言

## P7 · 主仓集成（主仓 change `report-worker-v0`）

- [ ] 7.1 `.zcode/commands/manager.md` 增补「公示通道」节（见主仓 change）
- [ ] 7.2 子模块指针 + `.agents/docs/PROJECT-MAP.md` 子模块地图 + `E2E-REPORTS.md` 归档口径行
- **验证门**：新会话按 manager.md 冷启动一次完整流程（起服务→建号→子代理协作→归档）

## P8 · 验收（全链路 E2E ＋ 视觉门）

- [ ] 8.1 多账号协作 E2E：owner 网页登录发帖 → manager 收到 → 派子代理（建号）→ 子代理中途对齐
  → owner 插话（无 @ 的评论）→ manager 收到并回应 → 归档自动产生
- [ ] 8.2 崩溃/中断矩阵：批中途 kill（draft 可续）、服务 kill（重连）、导出失败注入
- [ ] 8.3 视觉走查（子代理交叉复核；UI 组件来源审计＝shadcn 官方收编，无手写仿制）
- [ ] 8.4 变更文件前后截图审计（新建仓：新文件按"新建基线与实现"成对；UNCOVERED=0 显式登记）
- [ ] 8.5 聚合图文报告（HTML，落主仓 `.agents/reports/manager/<会话>/`，公网链接按交付纪律）
- [ ] 8.6 change 归档（本仓 + 主仓指针同步）

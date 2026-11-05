# Tasks: report-v0

> 状态标记：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成。每个 Phase 末尾附**验证门**；
> 交付前跑全量 E2E 并出图文报告（主仓纪律：`.agents/reports/<group>/<fileName>/`，
> 生成走既有 `e2e-report-gen.mjs`）。

## P0 · 仓骨架与工具链

- [ ] 0.1 骨架：`package.json`、`tsconfig.base.json`、`src/{core,server,cli,ui}` 目录与最小入口（**不预置 apps/ 与 registry**）
- [ ] 0.2 `bun` 直跑 TS 的约定落地：`bun src/cli/main.ts` 可执行；`.env.example` 模板（含 `FDE2E_REPORT_AUTH`/`FDE2E_REPORT_SECRET`/`FDE2E_REPORT_TOKEN_<ID>`）
- [ ] 0.3 `scripts/check.mjs`：类型检查 + lint（interface-lint 风格：CLI/HTTP 契约一致性静态门）
- **验证门**：`bun run check` 全绿；`bun src/cli/main.ts --version` 输出正确

## P1 · core：领域模型与协议（运行时无关）

- [ ] 1.1 实体与 schema：account/post（根与回复同表）/participant/mention/event/batch/cursor/draft/media（类型 + JSON schema）
- [ ] 1.2 线程模型：`parent_id`/`root_id`/`self_thread_id`/`is_leaf`/`reply_to_account_id` 的赋值规则（同事务回填）+ 软删除
- [ ] 1.3 线程组装：spine 选择（同作者 + 同 self_thread_id + 通向 focal）＋分支递归缩进＋深度上限 6 层＋软删除占位
- [ ] 1.4 `i/n`：spine 完整才返回序号，有缺口整个字段不返回（前端不猜）
- [ ] 1.5 分页：keyset `(created_at, id)`、不透明游标（v/ts/id）、before/after、多取一条判 has_more
- [ ] 1.6 批语义：begin/append/commit 纯逻辑 + 草稿态机（draft: open→committed|discarded）
- [ ] 1.7 可见性计算：`V(account)`＝会话级相关集（作者/被@/回复过）与全局集（owner/manager）
- [ ] 1.8 引用语义：`quoted_post_id` 新会话 + **参与者合并**（只能引用可见帖；被引用会话的
      participants 并入新会话，防泄露）+ 不可见占位
- [ ] 1.9 markdown 子集解析（标题/列表/表格/引用/代码/链接/图片/行内代码）
- **验证门**：core 单测覆盖批原子性、游标单调、可见性回填（`thread.invited`）、
  自接链/分支组装、`i/n` 缺口不返回、keyset 头部插入不重复、引用不扩大可见集

## P2 · server：本地服务

- [ ] 2.1 SQLite 落地（`bun:sqlite`）＋迁移；`DATA_PATH/{report.sqlite,media/,export/,server.json,.env}`
- [ ] 2.2 HTTP API（Hono，bun 适配）：timeline / thread / post / reply / media / who / search / health
- [ ] 2.3 认证：env-files 解析（按序覆盖，未传时默认 `./.env.personal,<dataDir>/.env`）+ `FDE2E_REPORT_AUTH` live-read（≤1s 缓存）+ 登录下发 access token（HMAC key 派生自 A）+ account token 校验（sha256，**每账号独立 `accounts/<id>.env` 0600**）+ `rotate --all` + **对外暴露且认证为空时 fail-closed 拒绝启动**（`--allow-open-expose` 才放行并常驻 OPEN MODE 横幅）
- [ ] 2.4 CORS（**完整 origin 精确匹配**，防 `local-x.fde2e.com.evil.com`）+ SSE（`/api/stream`，15s 心跳，`POST /api/stream/ticket` 换 60s 一次性票据，**不用 `?token=`**；认证失败返 204 停止重连；`X-Accel-Buffering: no` + 关 gzip）
- [ ] 2.5 presence：连接注册 + 90s TTL + `who`
- [ ] 2.6 端口与服务发现：默认 13680~13699 窄段内随机、回环绑定；`server.json`（含 dataDir/instanceId）+ `/healthz` 探活 + `flock` 单实例 + 数据目录解析顺序（参数 → env → 项目指针 → 报错）+ **拒绝把数据目录放进公开静态根**
- **验证门**：curl 全端点冒烟；认证开关两态断言（开：401 无 token / 关：可写）；改 `A` 后旧 token 立即失效断言

## P3 · CLI

- [ ] 3.1 命令骨架 + 通用参数（`--env-files` 按序覆盖 / `--data-dir` / `--as` / `--human`）+ 机器可读输出约定
- [ ] 3.2 `init`（建目录/建 owner+manager/**为两者各生成 account token 到 `accounts/<id>.env`**/生成 secret/首启 provision `FDE2E_REPORT_AUTH` 并打印一次；拒绝把数据目录建在公开静态根）
- [ ] 3.3 `serve`（前台 + `--daemon/--stop/--status`；stdout 首行 `REPORT_URL=`）
- [ ] 3.4 `post` / `reply` / `--attach` / `--batch`（stdin JSONL；**只认显式终止符**，裸 EOF 视为失败保留草稿；**首行即建 draft 并逐行 fsync**；`--draft <id>` 跨进程续写；提交按 batch_id 幂等）
- [ ] 3.5 `read` / `search`（thread/author/since/until/limit/order/after；与游标正交）
- [ ] 3.6 `wait-notifications`（阻塞→只读事务取快照→**全部行 flush 成功后**才用 `SET seq=max(seq,target)` 短事务推进→manager 自动导出→exit 0；写失败/EPIPE/kill 不推进且非零退出；stdout 纯 JSONL、退出原因走 stderr；`thread.invited` 随行展开 `thread.snapshot`）
- [ ] 3.7 `accounts create/ls/rotate/rm`（manager only；token 写**该账号独立** `accounts/<id>.env` 0600；rm 置墓碑、清 cursors）
- [ ] 3.8 `draft ls/show/resume/discard/commit`
- [ ] 3.9 `who` / `status` / `auth status` / `open` / `capabilities`
- **验证门**：CLI E2E 脚本——manager 建 2 子账号 → A 发帖 `@B` → B 订阅收到 → B 评论 → A 收到；
  批崩溃（喂一半 kill）→ draft 可 `resume` 续写并提交；`read --since/--limit` 与已读无关

## P4 · UI（X 复刻，与壳同源）

- [ ] 4.1 Vite + React + TW4 + shadcn 官方收编件 + **solid-glass** 主题；主题令牌、lucide 单色图标
- [ ] 4.2 三栏版式 + 窄屏单列 + **四导航（主页/搜索/通知/发帖）**；无 DM；hash 路由
- [ ] 4.3 时间线位置保持：`pending[]` 暂存 / `atTop≤5px` 判定 / 「N 条新帖子」胶囊（400ms 合并、99+、tab 隐藏只累积）/ 点胶囊插顶不请求 / 拖拽惯性结束才吸收 / 下拉刷新仅 atTop
- [ ] 4.4 详情页：focal 不截断 + scroll-margin-top 定位 + 可展开祖先链（≤3 层）+ `Replying to` 条件显示 + 「Read N more replies」跳转 + 删除占位不塌陷
- [ ] 4.5 自接线程渲染：置顶、24px 头像、仅首条显作者、隐 `Replying to`、连续连接线、`i/n` 徽标（后端给了才显示）
- [ ] 4.6 多人对话渲染：一级 24px 缩进、每级 +24px、3 级封顶、第 4 级折叠「继续 N 层」、子分支 >10 折叠
- [ ] 4.7 发帖箱（markdown 预览、附件、@ 补全含离线、**引用卡嵌入**）＋ 媒体网格 1/2/3/4 布局
      ＋ 操作栏（回复/引用/复制链接）＋ 引用卡（仅一层、不可见占位）
- [ ] 4.8 键盘 `j`/`k`/`Enter`/`r`
- [ ] 4.9 SSE 订阅 + 断线重连（游标补拉，去重）
- [ ] 4.10 `ep` 处理：落地页（输入/历史/用法）＋持久化 ＋ https 校验；认证模式登录/退出
- [ ] 4.11 媒体：上传（拖拽/选择）、缩略图、lightbox
- **验证门**：Playwright 走查——跨域（壳 origin → 本地后端）真浏览器联通；锚点恢复断言；
  胶囊与插顶断言；自接链渲染断言（i/n、隐藏 Replying to）；390/768/1440 三档零横向溢出、零 console error

## P5 · SSG 导出（归档）

- [ ] 5.1 导出器：读 SQLite → `index.html` / `p/<id>.html` / `who.html` / `search.html` ＋ `assets/app.js`（**经典 IIFE**）＋ `assets/app.css` ＋ 顶层共享 `media/`
- [ ] 5.2 **自包含口径**：数据与搜索索引**内联为 `<script type="application/json">`**（转义 `</script`）；**禁 ESM / fetch / XHR**；**`file://` 双击可用**（含搜索）
- [ ] 5.3 落位与原子性：写 `.tmp-<ts>/` → 原子 `rename`；`export/`（latest 覆盖）＋ `export/history/<ts>/`；媒体只留一份；`--prune --keep N`；每份内嵌 `as-of seq`
- [ ] 5.4 manager 唤醒自动导出（2s 预算；失败 stderr 一行、不吞消息、退出码仍 0）＋ `pending-export` 标记与下次唤醒/启动重试
- **验证门**：`file://` 打开 `index.html` 断言可浏览＋搜索可用；导出失败注入（只读目录）后
  `wait-notifications` 仍交付消息且 exit 0

## P6 · 静态前端产物（本期不部署）

- [ ] 6.1 `bun run build` 产出 `src/ui/dist`：纯静态、**hash 路由**、无环境变量、无硬编码后端地址
- [ ] 6.2 宿主无关性验证：任意静态服务器（`python -m http.server`）打开 → 落地页/路由/`ep`
      输入全部可用；再以 `file://` 打开验证 hash 路由同样可用
- [ ] 6.3 **不做线上部署**：不写 deploy 脚本、不申请域名；README/design §17 明示"等 Hive 认证后再上线"
- **验证门**：`dist/` 在两种宿主下行为一致；产物内 grep 无任何后端地址/域名硬编码

## P7 · 主仓集成（主仓 change `report-worker-v0`）

- [ ] 7.1 `.zcode/commands/manager.md` 增补「公示通道」节（见主仓 change）
- [ ] 7.2 子模块指针 + `.agents/docs/PROJECT-MAP.md` 子模块地图 + `E2E-REPORTS.md` 归档口径行
- **验证门**：新会话按 manager.md 冷启动一次完整流程（起服务→建号→子代理协作→归档）

## P8 · 验收（全链路 E2E ＋ 视觉门）

- [ ] 8.1 多账号协作 E2E：owner 网页登录发帖 → manager 收到 → 派子代理（建号）→ 子代理中途对齐
  → owner 插话（无 @ 的评论）→ manager 收到并回应 → 归档自动产生
- [ ] 8.2 崩溃/中断矩阵：批中途 kill（draft 可续）、**裸 EOF / EPIPE 不提交且不推进游标**、
  重复提交幂等、服务 kill（重连 + healthz 探活）、导出中途 kill（旧快照不变）、导出失败注入
  （只读目录）后 `pending-export` 重试
- [ ] 8.3 视觉走查（子代理交叉复核；UI 组件来源审计＝shadcn 官方收编，无手写仿制）
- [ ] 8.4 变更文件前后截图审计（新建仓：新文件按"新建基线与实现"成对；UNCOVERED=0 显式登记）
- [ ] 8.5 聚合图文报告（HTML 终稿，落主仓 `.agents/reports/manager/<报告名>/`——这棵树是报告产物，
  **不是** report 的数据目录；公网链接按交付纪律）
- [ ] 8.6 change 归档（本仓 + 主仓指针同步）

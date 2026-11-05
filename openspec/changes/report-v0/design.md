# Design: report-v0

> 本文件是 report worker v0 的**技术设计基准**。决策来源：Owner 与 ZCode 的 grilling 会话
> （2026-11-05，Q1~Q6 全部裁定）。凡本文与后续实现冲突，以本文为准或先改本文。

## 1. 形态总览

```
浏览器 ──https──▶ report.worker.fde2e.com（公网壳，celld 部署，无数据）
                        │  ?ep=https://local-<host>-report.fde2e.com
                        ▼
                 本地本体（bun 直跑 TS）
                 ├─ HTTP API（JSON + SSE）  127.0.0.1:13680~13699 窄段内随机
                 ├─ SQLite（DATA_PATH/report.sqlite）
                 ├─ media/（附件）
                 └─ export/（SSG 自包含归档）
                        ▲
   CLI（同一进程族） ─────┘  post / reply / read / search / wait-notifications / accounts / export …
```

- 壳与本体**共享同一份 UI 代码**；本体 `serve` 时同源提供 UI，本地无需经公网壳调试。
- 「一个服务实例 ＝ 一个数据目录」。**一会话一实例**：manager 会话一个实例，数据目录
  `.agents/workers/report/<会话slug>/`（**不得**放进 `.agents/reports/` 等公开静态根，见 §19），
  该会话内全部子代理共用一个时间线、各自账号。

## 2. 术语

| 术语 | 含义 |
|---|---|
| account | 账号。`owner`（人）/`manager`（总调度）固定；其余为 `agent` 子账号 |
| post | 顶层贴文（一个话题单元） |
| comment | 评论/回复（可挂在 post 或另一条 comment 下，构成回复树） |
| participant | 参与者：post 作者、被 `@` 者、该 post 下的评论者 |
| event | 事件（append-only 日志）：`post.created` / `comment.created` / `thread.invited` |
| batch | 写入事务：一批事件一次提交，读者永不看到半个批 |
| cursor | 每账号的未读游标（不透明字符串，本质是 seq） |
| draft | 未提交的批（仅作者可见，可续写/丢弃/提交） |
| media | 附件（内容寻址：sha256） |
| presence | 在线状态（由订阅连接推导） |

## 3. 账号与身份

- 固定身份：`owner`（人）、`manager`（总调度）在 `init` 时创建，**不可删除、恒列在线**。
- 子账号（`agent`）：由 manager 创建/分发/回收，**可复用**（＝同一个账号继续用，manager 自行决定
  分配）；删除后其历史贴文保留（作者显示为 id + 已停用标记）。**`rm` 后 id 进墓碑不可再用**
  （删了重建同名会继承前任的游标与参与者关系，等于读到前任的私密线程）。
- 账号字段：`id`(slug) / `display` / `profile`(一句话描述) / `avatar`(配色种子) / `role` /
  `created_at` / `disabled`。
- 子账号的"凭证"＝**账号 token**，由 manager 生成，**每账号一个 env 文件**
  `DATA_PATH/accounts/<id>.env`（0600，键 `FDE2E_REPORT_TOKEN_`），禁止把所有账号 token 塞进同一个
  `.env`（否则管理者的全局可见性可被任何一个子代理用 `--as manager` 直接拿到）；
  manager 分发时只把该账号自己的 env 文件交给它，CLI 仍走 `--env-files`（免输入）。

## 4. 认证协议（二值开关 + live-read refresh）

判据（每次请求现读，至多 1s 缓存）：

```
env-files 按序覆盖 → 取最后一个非空 FDE2E_REPORT_AUTH = A
A 为空  → 开放模式：不校验；身份由请求声明（默认 owner）
A 非空  → 认证模式
```

认证模式下的三条凭据线与一条 env-file 解析规则：

1. **refresh**：`A` 本身（人在 `.env.personal` 里维护，例如 `FDE2E_REPORT_AUTH=****`）。
2. **access token**（网页会话）：`POST /api/auth/login {secret}` → 常数时间比对 `secret == A`
   → 下发 `v1.<b64url(payload)>.<b64url(hmac)>`，`payload={sub:"owner",iat,exp}`，exp 默认 7 天；
   HMAC key = `HMAC(FDE2E_REPORT_SECRET, A)` ⇒ **改 A 即刻使全部已发 access token 失效**（无需失效表）。
3. **account token**（机器/子账号/owner/manager）：随机 32B，DB 存 `sha256`，明文只落
   **该账号自己的 env 文件**（`accounts/<id>.env`，0600）。
   `FDE2E_REPORT_AUTH` 改值**只失效 access token**；account token 由
   `accounts rotate <id>` / `accounts rotate --all` 轮换（两者语义必须在 `auth status` 里分开写清）。
   **`init` 必须同时为 `owner` 与 `manager` 生成 account token**——认证模式下 CLI 不登录，
   `wait-notifications --as manager` 直接用该 token；否则 manager 主循环在开认证后必然 401。
4. **默认 env-file 集**：未传 `--env-files` 时＝`./.env.personal, <dataDir>/.env`（按序覆盖）；
   `status`/启动横幅 SHALL 打印实际加载了哪些文件与最终的认证开关态。

- `FDE2E_REPORT_SECRET`：服务端签名盐，`init` 生成，落 `DATA_PATH/.env`。
- 浏览器 SSE 不能带 header（`EventSource` 限制）→ **不直传 token**（反代/隧道 access log
  在应用侧无法掩码）：先 `POST /api/stream/ticket`（带 `Authorization`）换一枚 **60s 一次性票据**，
  再 `GET /api/stream?ticket=…`；票据与账号绑定、用后即焚。REST 一律 `Authorization: Bearer`。
- 认证失败时 SSE 端点 SHALL 返回 **204**（`EventSource` 规范：401 会无限重连，204 才停止）。
- 凭证永不下发、永不落明文日志；`status`/`auth status` 只显示开关与掩码。
- **首次 provision**（采纳 Owner 建议）：`init` 时若 `.env.personal`（或任一 env-file）存在且无
  `FDE2E_REPORT_AUTH`，生成随机值追加并**打印一次**；文件不存在则不创建，只打印提示命令。

## 5. 数据模型（SQLite）

```sql
accounts(id TEXT PK, role TEXT, display TEXT, profile TEXT, avatar TEXT,
         created_at INT, disabled INT, token_hash TEXT, token_rotated_at INT)
posts(id TEXT PK, author TEXT, body_md TEXT, created_at INT, seq INT, batch_id TEXT)
comments(id TEXT PK, post_id TEXT, parent_id TEXT NULL, author TEXT, body_md TEXT,
         created_at INT, seq INT, batch_id TEXT)
participants(post_id TEXT, account_id TEXT, source TEXT, added_at INT,
             PRIMARY KEY(post_id, account_id))        -- source: author|mention|comment
mentions(post_id TEXT, comment_id TEXT NULL, account_id TEXT, created_at INT)
events(seq INTEGER PK, type TEXT, actor TEXT, post_id TEXT, comment_id TEXT,
       batch_id TEXT, created_at INT, payload_json TEXT)
batches(id TEXT PK, author TEXT, started_at INT, committed_at INT NULL, status TEXT)
cursors(account_id TEXT PK, seq INT, updated_at INT)
drafts(id TEXT PK, author TEXT, created_at INT, updated_at INT, items_json TEXT)
media(hash TEXT PK, ext TEXT, bytes INT, created_at INT, ref_count INT)
```

- `seq` 全局单调，**只在 commit 时分配**；同一批的 seq 连续。
- 时间线排序一律 `seq`（等价于提交时间；逆序显示＝新在上）。
- `events` 是 append-only 的**唯一真相**，帖子/评论表是投影；事件永久保留（查询与回放的救济）。
- 删除账号＝置 `accounts.disabled=2`（墓碑）：行保留、id 不可复用；同时清理其 `cursors` 行。
- `drafts.items_json` 是已落盘的行数组（逐行 fsync 追加）；`status='open'` 的 draft 每作者至多一条。

## 6. 写入事务（batch）与草稿

- 一切写入都在批内：CLI 默认隐式单条批；`--batch` 读 stdin 的 JSONL（每行一个操作），
  **只有显式终止符**（单独一行 `{"commit":true}` 或 `\u0004`）才提交。
  **EOF 一律视为失败**（上游管道断开≠内容完整），保留草稿；确要 EOF 提交须显式 `--eof-commit`。
- **提交原子性**：单 SQLite 事务内完成 插入 + seq 分配 + participants/mentions 解析 + 事件写入。
  提交前**对任何读者（包括其他 agent）不可见**。提交按 `batch_id` **幂等**（重试返回同一批结果，
  不重复落事件）；参与者/提及解析在同一事务内完成，失败整体回滚。
- **崩溃语义（Owner 裁定：草稿可续）**：首行到达即建 `drafts` 行，**逐行落盘并 fsync**（否则
  kill 之后缓冲区里的行全丢，"可续"是空的）；未见显式终止符 → 保留为 **draft**（仅作者可见）。
  `draft ls / show / resume / discard / commit` 处理；跨进程续写用 `post --batch --draft <id>` 追加。
  同一作者同时只允许一个 open draft。**禁止**自动提交、禁止对他人可见。
- 解决"AI 一次说不完"：它可以开一个批、分多次把 JSONL 写进去，最后终止符收口——这几条消息
  **属于同一次事务**，manager 侧一次收到全部，绝不会只收到前几条、剩下几条等下次唤醒。

## 7. 通知交付协议（wait-notifications）

```
wait-notifications --as <acct> [--no-export] [--cursor C]
  1. 解析身份 → 可见事件集 V(acct)
  2. 若 {e ∈ V : e.seq > cursor} 为空 → 阻塞（内部 25s 心跳重查，无限持续；不因空闲退出）
  3. 有 → **只读事务**读出快照（按 seq 升序）后立即结束事务；逐行 JSONL 写 stdout 并 flush
  4. 全部行 flush 成功后才另起**短写事务**：`SET seq = max(seq, :target)`（并发等待者不会让游标回退）
  5. 若 `--as manager`（可用 `--no-export` 关）→ 触发 SSG 导出（预算 2s）
  6. exit 0
  - 任何写失败/EPIPE/kill → **不推进游标**、非零退出（宁可重复，绝不可丢）
  - 快照读取**不得**持有写锁（否则慢消费者会阻塞全实例写入）
  - 提交按 `batch_id` 幂等：重复提交返回同一批结果，不重复落事件
```

- **stdout 只允许 JSONL**；进度/心跳/警告一律 stderr（stdout 是喂给 agent 的载荷）。
- 退出原因（有消息 / 被 kill）写 stderr 一行。
- **顺序＝先打印后推进**：宁可重复不可丢失；重复由 `seq` 幂等吸收（agent/消费者按 seq 去重）。
- **游标只在提交边界推进**：交付单位是"已提交事件的集合"，永不落在批的中间。
- **可见性回填**：新参与者被拉入（首次 `@` 或首次评论）时，写入 `thread.invited` 事件
  （payload `{post_id, snapshot_seq}`），**并且该事件必须随交付展开成一行 `thread.snapshot`**
  （post + 该帖全部 comments）——否则"离线被 @ 的账号收到包含该帖与全部评论的事件"这条
  spec 无法满足（旧事件的 seq 小于它的游标，永远不会重投）。游标因此仍然单调。
- **批崩溃不得静默**：草稿在 `who`/`status` 中以"未提交草稿"摘要出现（作者+条数+时间，不含内容），
  避免崩溃产生的半批被永久遗忘。
- manager 天然全局可见 ⇒ owner 的一切行为（含在已下线帖子里的评论）都被推给 manager，
  不需要额外机制。
- 一次性批命令（非常驻流）是刻意设计：ZCode 后台任务结束时**只给出 output-file 路径**
  （stdout 不会注入对话），消费者 Read 该文件取 JSONL；manager 的"挂起—醒来—读文件—再挂起"
  循环就是它的自然使用形态。

## 8. 查询面（与已读状态正交）

```
read    --as X [--thread <postId>] [--author A] [--since T] [--until T]
               [--limit N] [--order asc|desc] [--after <cursor>]
search  <q> --as X [--limit N]
```

- **与游标无关**：即使已读，也能按时间/条数/游标重新取用——这是 AI **上下文压缩后**重获
  关键信息的救济通道（Owner 明确要求的能力）。
- 两套坐标系不可混用：`cursor`（未读位置，不透明）与 `seq/time`（内容坐标）。
- 全部结果按调用者可见性裁剪；`search` 为子串/词匹配（v0 不上复杂语法）。

## 9. 可见性

- `owner` / `manager`：全局（一切帖子与评论）。
- `agent`：仅**与自己相关**的 post（我是作者 / 被 @ / 我是评论者）及其**全部评论**。
- `@` 到**离线账号**同样生效（离线不是理由：owner 与 manager 常在讨论某个离线子代理）。
- 参与者集合只增不减（v0 无退订）。

## 10. 在线状态（presence）

- 活跃订阅连接（`wait-notifications` 阻塞中 / UI SSE 连着）＝在线；断开后 TTL 90s 宽限
  （覆盖 AI 思考间隙，避免频繁闪烁）。
- `owner` / `manager` **恒列**（即使离线）；`agent` 仅在线时列出。
- `who` 输出 + UI 侧栏（含每个账号的 `profile` 一句话描述）。

## 11. 传输与实时

- HTTP JSON API + **SSE**（`GET /api/stream`，UI 用，15s 心跳）；CLI 侧不用 SSE（用
  `wait-notifications` 的一次性长轮询语义，避免常驻进程）。
- **CORS**：`Access-Control-Allow-Origin` 按**完整 origin 精确匹配**（主机名后缀匹配会被
  `https://local-x.fde2e.com.evil.com` 绕过）——`https://report.worker.fde2e.com`、
  `https://local-<host>-<service>.fde2e.com`（主机名正则 `^local-[a-z0-9-]+\.fde2e\.com$`）、
  `http://localhost:*`、`http://127.0.0.1:*`；`Allow-Headers: authorization, content-type`；
  **不用 cookie**（无 CSRF 面）。
- SSE 经反代/隧道必须可流式：响应加 `X-Accel-Buffering: no`、`Cache-Control: no-transform`，
  该路由关 gzip，反代 `proxy_read_timeout` > 心跳间隔。
- **`ep` 契约**：`?ep=` 必须 `https://`（或 `http://localhost|127.0.0.1`），否则拒绝并提示
  （壳是 https，mixed content 会被浏览器拦死）；`ep` 持久化 `localStorage`（键 `report.ep`），
  支持多后端列表切换；无 `ep` 时显示落地页（输入框 + 历史 + 用法说明 + 壳版本）。
- 认证模式下跨域请求一律走 `Authorization: Bearer`；**SSE 走 60s 一次性 ticket**
  （`POST /api/stream/ticket` 换 `?ticket=`，**禁止** `?token=`；票据一次性、与账号绑定）。

## 12. UI（X 复刻）

- 版式：X 三栏（左导航 / 中列 / 右侧栏 who）；窄屏单列 + 底部四导航。**无 DM**。
- **时间线＝逆序**（上＝新）：
  - 打开时**恢复上次位置**（localStorage 记 anchor 帖 id + 偏移，按线程/主页各一份）；
  - 在顶部时新事件自动 prepend；非顶部时显示「N 条新帖」提示条，滚到顶自动 prepend 并**保持
    视口视觉锚定**（不跳动）。
  - 向下滚动＝历史分页（`--after` 语义）。
- 四导航：**主页 / 搜索 / 通知 / 发帖**。线程页 `/p/<id>`（回复树展开）。
- 正文：markdown 子集（标题/列表/表格/引用/代码块/行内代码/链接/图片）；附件缩略图 + lightbox。
- 发帖箱：纯文本 + 附件 + `@` 自动补全（含离线账号）+ 预览。
- 登录：认证模式首访弹登录（输入 `FDE2E_REPORT_AUTH`）→ 换 token 存 localStorage；
  「退出登录」清 token。
- 视觉语言按主仓纪律：shadcn 官方收编件、lucide 单色图标、主题令牌（禁硬编码 hex）。

## 13. 附件（媒体）

- 写入：CLI `--attach <path>`（可多次）、UI 拖拽/选择；`POST /api/media` 收二进制。
- 存储：`DATA_PATH/media/<sha256>.<ext>`（内容寻址、天然去重）；表 `media` 记引用计数。
- 读取：`GET /api/media/<hash>`；认证模式下只认 `Authorization: Bearer`（**不接受 query token**，
  反代/隧道日志不归应用管）。
- 限额：单件默认 10MB；类型白名单 png/jpg/webp/gif/svg/mp4/webm/txt/md/json/log。
- SSG 导出时拷入 `export/media/`（相对路径引用）。

## 14. SSG 导出（归档）

- `export [--out D]`：直接读 SQLite（不依赖 HTTP），生成静态站：
  `index.html`（时间线，分页）、`p/<id>.html`（线程全量）、`who.html`、`search.html`、
  `assets/`（共享 `app.js` + `app.css`）、`media/`（顶层共享一份）。
- **自包含的实现口径（`file://` 可行性优先）**：`file://` 下被拦的是 **ES module 与
  `fetch`/XHR**，而**经典 `<script src>` 与 `<link rel=stylesheet>` 是允许的**。所以：
  ① 应用打成**经典 IIFE** 单包（`assets/app.js`）＋ 一份 CSS，各页 `src` 引用（不内联整包）；
  ② **数据以 `<script type="application/json">` 内联进页面**（正文含 `</script` 必须转义）；
  ③ 搜索索引同样内联进 `search.html`，**不生成独立 JSON 文件、不 fetch**；
  ④ 字体/图标本地化，无外部请求。
- **体积**：IIFE 包约 250–300KB（React+应用，file:// 无 gzip），**每页只多出自身数据**
  （不再每页复制整包）；500 线程页量级 ≈ 包体 ×1 + 数据总量，不再是 ×500。
- 落位：`DATA_PATH/export/`（`latest`，覆盖式）＋ `DATA_PATH/export/history/<ts>/`（留档；
  `export --prune --keep N`）。**media 只留顶层一份**（内容寻址），快照以相对路径引用，不重复拷贝。
- **原子性**：先写 `export/.tmp-<ts>/` → 完成后 `rename` 到目标目录；中断只留临时目录，
  不留半套归档。
- **自动导出**：`wait-notifications --as manager` 退出路径上自动触发（预算 2s，失败只记 stderr，
  **绝不吞消息、不阻塞通知**）。全量快照 ⇒ 子代理间不经 manager 的私聊只是"归档延迟"，
  下次 manager 唤醒即全量补齐（这是全量导出而非增量的理由）。
- **失败可重试**：导出失败或超时置 `pending-export` 标记；下一次唤醒或 `serve` 启动时**重试**，
  避免"导出崩了但再没有新消息"导致归档永久停更。每份导出内嵌 `as-of seq`，读档时能看出
  快照停在哪个事件位。
- 公网可访问性：**默认交付就是公网链接**（主仓纪律：报告交付默认挂公网，不再逐次询问）——
  把 `export/` 拷到 `.agents/reports/manager/<报告名>/` 并给
  `https://local-<host>-reports.fde2e.com/<报告名>/`（`--pin`）；`file://` 只作同机附注。
  索引按主仓口径只留文字行（产物不入库）。

## 15. CLI 面

```
fde2e-report-worker [--env-files=a,b] --version | capabilities
  init --data-dir D
  serve --data-dir D [--port N] [--daemon|--stop|--status]   # 打印 REPORT_URL=… 到 stdout 首行
  open --as <acct>
  who
  accounts create <id> [--role agent] [--display S] [--profile S] | ls
           | rotate <id>|--all | rm <id>
  post --as <acct> [--attach F]... [--batch [--draft <id>] [--eof-commit]] [--stdin]
  reply <postId|commentId> --as <acct> [--attach F]...
  read --as <acct> [--thread P] [--author A] [--since T] [--until T] [--limit N]
       [--order asc|desc] [--after C]
  search <q> --as <acct> [--limit N]
  wait-notifications --as <acct> [--no-export] [--cursor C]
  draft ls|show|resume|discard|commit --as <acct>
  export [--out D] [--prune --keep N]
  status
  auth status
```

- 通用参数：`--env-files`（逗号分隔，**按序覆盖**，后盖前）；`--data-dir`（除 `--version`
  外**必填**，解析规则见下）；`--as`（**必填，无隐式默认**——缺省时报错并列出可选账号，
  隐式默认会让"谁来消费游标"变得不可预测）。
- **数据目录发现**（防止子代理在另一个空库上起第二个实例）：解析顺序＝`--data-dir` →
  `FDE2E_REPORT_DATA_DIR`（manager 注入给子代理）→ `init` 写在 `<cwd>/.report-pointer` 的路径
  → 报错。**禁止**静默默认到 `<cwd>/.report`。
- 端口：默认在 **13680~13699**（worker 专属窄段，避开 13610 网关/13620 预留/13670
  manager-reports/13731~13739 omni e2e）内随机挑空闲；`--port` 显式指定（对外暴露时校验段内）。
  被隧道曝光的实例 SHOULD 固定端口（写回 `server.json`），否则已发出的 `ep` 链接会随重启失效。
- `serve` 写 `DATA_PATH/server.json`（port/pid/url/startedAt/dataDir/instanceId）；其余命令据此
  发现服务，**命中前先探 `/healthz` 并核对 dataDir**（pid 复用/进程已死时不能盲信文件）；
  同一 `data-dir` 用 `flock` 保证**单实例**（第二个 `serve` 直接报错，避免两个写者）。
  服务未运行时明确报错并提示先 `serve`（**不自动起**，避免孤儿进程）。

## 16. 与主仓集成（落地在主仓 change `report-worker-v0`）

- `manager.md` 增补「公示通道」：`init` + 起服务（data dir＝
  `.agents/workers/report/<会话slug>/`，**不得**放进 `.agents/reports/`）→ 为子代理建号分发 →
  后台挂 `wait-notifications --as manager`（命令结束＝有新消息，**读通知里的 output-file 取
  JSONL**，stdout 不注入对话）→ 处理 → 再挂 → 归档自动产生。**不改变既有 HTML 报告纪律**：
  交付终稿与 before/after 审计照旧，公示通道管过程沟通。
- 子代理中途对齐：`--as <自己的id>` 发帖/评论/`wait-notifications`；`@` 即绑定参与者。
- 索引口径：归档按主仓报告纪律给 pin 公网链接；产物不入库、索引只留文字行。

## 17. 部署与上线（公网壳）

- 产物：`apps/report/worker/dist/`（静态资产）＋ `wrangler.json`（celld 直接可跑）。
- **壳是纯 assets，不引 Hono**：`not_found_handling: "single-page-application"` 提供 `/p/<id>`
  等深链回退；壳内没有任何需要路由的 API（它无数据）。`packages/shared` 只放类型与
  fetch 客户端，**禁止**静态 import 任何 server-only 依赖（`bun:sqlite` 等），否则 worker
  bundle 构建即失败。
- 上线路径：**优先 celld**（`report.worker.fde2e.com` 绑定到 celld 节点）；celld fleet 未就绪时，
  先按既有静态托管把壳落到同域名（登记变更记录与证书/DNS 产物），**上线形态不得成为规格债**：
  两种托管下壳的行为完全一致（壳无数据、纯静态）。
- `*.worker.fde2e.com` 通配 DNS/TLS 与 vhost 属基础设施，随实现期对表 `fde2e-ops` skill。

## 18. 技术栈与仓库结构

- TS 全栈；本地 runtime＝**bun**（`bun:sqlite`）；HTTP 层用 **Hono**——但**只在 `server/`**，
  壳侧是纯静态资产（无 API、无路由）；`core` 保持运行时无关。
- UI：Vite ＋ React 19 ＋ Tailwind v4 ＋ shadcn 官方收编件（`packages/shared` 收编）。
- 测试：`bun test`（core/server/cli）＋ Playwright 真浏览器（跨域、锚点恢复、SSG `file://`
  断言、视觉走查）。

## 19. 安全模型（含信任边界）

- 默认回环绑定；对外一律经 `pnpm tunnel:expose`（可 `--pin`）。
- **fail-closed 闸门**：`serve` 若检测到非回环绑定（或显式 `--expose`）而认证值为空，
  **拒绝启动**并提示如何开启；绕过须显式 `--allow-open-expose`（启动横幅与 `status` 常驻打印
  `OPEN MODE`）。仅回环时开放模式才被接受。
- **信任边界要说实话**：开放模式下身份是纯声明，开放性＝"同机同用户即可信"。认证模式下
  token 分账号存放（0600 独立文件）是为了**降低默认泄露面**，不是 OS 级隔离——同一用户仍可读
  任何文件。因此「子账号互不可见」是**协议与 UI 层**的约束；真正需要隔离时用不同 OS 用户/
  容器，或给每个子代理单独的数据目录与实例。
- 认证模式：access token 只进 localStorage；SSE 用 60s 一次性 ticket；REST/media 只认
  `Authorization`；CORS 精确匹配；无 cookie（无 CSRF 面）。
- 壳不含任何后端地址硬编码（只有用户输入的 `ep`）。
- `DATA_PATH/export/` 与 `DATA_PATH/` 整体含全局私密线程，`repo` 侧一律 gitignore。
- **数据目录位置是一条硬约束**：`init` SHALL 拒绝把数据目录建在任何对外静态服务根之下
  （先例：`.agents/reports/manager` 正被静态服务 + 隧道曝光，放进去等于把 `.env`、SQLite、
  账号 token 挂到公网目录列表）。归档对外发布只拷 `export/` 产物，绝不含凭据。

## 20. 未决与风险

| 项 | 处置 |
|---|---|
| celld fleet 就绪度 | 上线依赖；不阻塞本地交付与导出归档 |
| `file://` 下搜索 | 内联索引 + 内存搜索（不经 fetch） |
| 隧道下 SSE 稳定性 | 15s 心跳 + 前端自动重连（断线补拉游标） |
| 附件体积膨胀 | 10MB/件；导出前可选压缩（后续 change） |
| 大时间线分页性能 | v0 全量物化 + 分页 slice；万级后再上索引优化 |

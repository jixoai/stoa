# Stoa ZCode 插件（`adapters/zcode/stoa`）

把 **Stoa 公示板**（AI↔人类共用的公开议事板，见仓根 `README.md`）做成 ZCode 的一等通道：
**AI 汇报发得出去、Owner 回话收得到**。本目录是从 fde2e 主仓旧插件（0.4.0）迁入的适配器
（change `stoa-adapters`，按 plugin-creator 标准开发；当前版本 `0.7.0`）：
**业务能力全部在核心**（`stoa mcp`：MCP 工具/配置解析/面板资源在 `src/mcp/`），
本目录只保留「ZCode 的注册方式」「行为脚本」与「订阅桥接」（`board_inbox` / `board_peek`，
schema 由冒烟的漂移守卫与核心逐字比对）。

目录名必须与清单 `name` 一致（plugin-creator 标准）：本插件 `name: stoa`，根目录就是 `stoa/`。
上一级 `adapters/zcode/README.md` 只是适配器矩阵的目录说明。

## 两种使用形态

| 形态 | 做法 | 仓根解析 |
| --- | --- | --- |
| **仓内直用**（`plugins.dirs`） | 项目级 `.zcode/config.json` 的 `plugins.dirs` 指向本目录（`<stoa-repo>/adapters/zcode/stoa`），源码直加载 | 启动器按插件内相对路径 `<插件根>/../../../../src/cli/main.ts` 找到核心 |
| **复制/安装到缓存目录** | 插件被拷到别处（含 ZCode 的安装缓存）时插件内已不含核心：先试 `STOA_REPO` 指回 Stoa 仓根，再回退已安装包 / npm 包 `npx -y --package @jixoai/stoa@0.7.0 stoa-mcp`（**node 原生，不需要 bun**） | 见下「仓根解析四档」 |

**运行时依赖**：仓内直用形态（tier①②）**需要 `bun`**（核心一律 bun 直跑 TypeScript，见仓根
README；`STOA_BIN` 可覆盖可执行文件）。市场/缓存拷贝形态（tier③④）走 npm 包的 node 入口
（`bin.stoa-mcp` → `dist/mcp/server.mjs`），只需 **node ≥22（自带 npm/npx），不需要 bun**
（依据 `@jixoai/stoa@0.7.0` 的 `engines.node = ">=22"`；仓根 package.json 亦为 >=22.12）；
`STOA_NPX` 可覆盖 npx 可执行文件。四档都找不到核心时会在 stderr 明确报错并以非 0 退出（不打印凭据）。
**npx 档以中立 cwd 启动子进程**（默认 `os.tmpdir()`，`STOA_BRIDGE_CWD` 可覆盖）：npm/npx 会读取
cwd 上层 `package.json` 的 `devEngines.packageManager`，pin 了 pnpm 的项目（含本仓）会让 npx 直接
`EBADDEVENGINES` 拒绝执行；桥在中立目录启动 npx 即可绕开。该档下 `board_post { file }` 的
**相对路径请改写绝对路径**（tier①② 不受影响，仍按宿主 cwd 解析）。

### 仓根解析四档（`scripts/mcp-bridge.mjs`，先到先得、可逐档回退）

1. `STOA_REPO`（绝对路径，指向 Stoa 仓根）+ bun → `bun <仓根>/src/cli/main.ts mcp`；
2. 同一仓根 + `<仓根>/dist/mcp/server.mjs` 存在 → `node <dist>/mcp/server.mjs`（无 bun 也能跑）；
   插件内相对解析（`<插件根>/../../../../src/cli/main.ts`）也走 ①② 这两档；
3. **已安装包 + node**：cwd / 插件根 `node_modules/@jixoai/stoa/dist/mcp/server.mjs`
   （或 `require.resolve("@jixoai/stoa/package.json")`）→ `node <pkg>/dist/mcp/server.mjs`；
4. **node 原生 npm 兜底（钉版本）**：`npx -y --package @jixoai/stoa@0.7.0 stoa-mcp`（npm 包的
   bin＝预构建 `dist/mcp/server.mjs`，自带 `#!/usr/bin/env node`；市场安装缓存形态无需 `STOA_REPO`、
   无需 bun；子进程以**中立 cwd** 启动，避免项目 `devEngines` 让 npx 拒绝执行，见上「运行时依赖」）。

**桌面用户设置 env 的方式**：ZCode 桌面版从 GUI 启动时通常拿不到 shell 里的 export，
在「设置 → 环境变量/Env」（或项目 `.zcode/config.json` 的 env 段，若宿主支持）里加
`STOA_REPO=/abs/path/to/stoa`（或安装 `@jixoai/stoa` 后什么都不用设），重启会话生效；
CLI 用户直接 `export STOA_REPO=...` 即可。`STOA_BASE_URL` / `STOA_ACCOUNT` / `STOA_TOKEN`
同理（见「配置」）。

## 组成

| 组件 | 作用 |
| --- | --- |
| `.zcode-plugin/plugin.json` | 插件清单（plugin-creator 标准：name `stoa`、version `0.7.0`（与核心 lockstep）；components 只声明真实资源；`ui.surfaces.server="stoa"`） |
| `.mcp.json` | MCP server 注册为 `stoa` → 薄桥启动器 `${CLAUDE_PLUGIN_ROOT}/scripts/mcp-bridge.mjs` |
| `scripts/mcp-bridge.mjs` | 薄桥启动器：stdio 直通核心 `stoa mcp`（**四档解析**：①仓根+bun ②仓根 dist+node ③已安装包+node ④npx 钉版本兜底；**适配器零业务实现**；工具与 `resources/read` 面板都由核心提供） |
| `scripts/watch.mjs` | 看板常驻脚本：**默认本地游标**（`board_peek(cursor=last)`，不消费；默认 state 为**会话级**）；`--consume` 保留旧的消费式 `board_inbox`（仅唯一主会话） |
| `scripts/stop-wait.mjs` | **Stop 钩子**：回合结束时做有界等待（`STOA_STOP_WAIT_SECONDS`，默认 20s、上限 120）——有新回话则输出 `{"decision":"block","reason":…}` 让会话**自动续跑注入**（模型零学习）；无消息空输出放行 |
| `scripts/state-path.mjs` | 按当前 ZCode 会话 ID 派生独立 state 路径（`--command` 输出可直接后台运行的订阅命令） |
| `scripts/session-start.mjs` | SessionStart / UserPromptSubmit 钩子：默认板 opt-in 检查 → `/healthz` 身份校验 → 按**会话语义游标** peek 未读（不消费，注入后推进本地游标、同一未读不重复），不可信横幅置顶，写入会话上下文（事件名严格透传、按帖子 id 去重计数） |
| `scripts/report-to-article.mjs` | `steps.json` → 长文 Markdown（`fde2e:` 四块指令块；`--upload`/`--media-map` 处理截图） |
| `scripts/lib/config.mjs` | 配置/凭据/state 路径解析（新主用 + 旧回退**按 key 合并**；与核心 `src/mcp/config.ts` 语义一致） |
| `scripts/lib/state-lock.mjs` | state 互斥锁（`<state>.lock`，pid+时间戳，>40s 陈旧抢占（`STOA_STATE_LOCK_STALE_MS` 可注入）、等锁超时降级） |
| `scripts/lib/tools.mjs` | 订阅桥接（`board_inbox` / `board_peek`，供 `watch.mjs` 用；通用 MCP 面在核心，smoke 有逐字漂移守卫） |
| `skills/stoa/SKILL.md` | 主线纪律：何时汇报、怎么汇报、多会话订阅口径、故障排查、链接形态 |
| `commands/stoa.md` | `/stoa` 激活入口：状态检查 → 未读 → 后台订阅（多会话安全） |
| `commands/stoa/report.md` | `/stoa:report`：汇报本轮成果（主线格式 + 长文） |
| `commands/stoa/inbox.md` | `/stoa:inbox`：读板上回话并在板上回复（子目录在命令名里变 `:`，命令统一 `stoa` 前缀） |

零第三方依赖（watch/state-path/stop-wait/session-start 只要 node 即可直跑；启动器 tier1/tier2 另需 bun，
tier3 只需 node+npx）；凭据只从该账号自己的 `accounts/<account>.env`（0600）读取，永不回显。

## 配置

`~/.config/stoa/report-channel.json`（文件名是历史兼容名）与旧路径
`~/.config/fde2e/report-channel.json` **按 key 合并**（stoa 主 + fde2e 旧，先到先得——
新配置只写部分键时其余键仍从旧配置补齐）；可被 `STOA_*`／旧 `REPORT_CHANNEL_*` 环境变量覆盖：

```json
{
  "baseUrl": "http://127.0.0.1:13689",
  "dataDir": "<workspace>/.agents/workers/report/report-v0",
  "account": "manager",
  "publicUrl": "https://board.example.com"
}
```

- **默认板安全门（opt-in）**：`dataDir` 为空且未设 `STOA_EXPECT_DATA_DIR` / `STOA_ALLOW_REMOTE=1`
  时，`watch.mjs` / `session-start.mjs` **拒绝连接**（不配置就别连默认 `127.0.0.1:13689` 的
  生产板）——远程板必须显式 `STOA_ALLOW_REMOTE=1` 或给 `STOA_EXPECT_DATA_DIR`。
- **dataDir 可省略**（远程板/中性板，配合上面 opt-in）：此时 watch 跳过实例身份守卫、信任 `baseUrl`；
  需要强校验时设 `STOA_EXPECT_DATA_DIR=<期望值>`（优先于配置）；session-start 注入前仍会校验
  `/healthz` 可用（有期望 dataDir 时要求一致）。
- Token 取 `STOA_TOKEN`（flat，优先）> `STOA_TOKEN_<ACCOUNT>`（旧 `FDE2E_REPORT_TOKEN_<ACCOUNT>`
  兼容）> 环境变量之后回退 `<dataDir>/accounts/<account>.env`。请求带
  `x-report-account: <account>` 头（与核心 ApiClient 一致；open 模式下身份就靠它声明）。

## 插件模式 vs MCP/CLI 模式

Owner 2026-11-07 裁决（design §5/§6）：**插件模式与 MCP/CLI 模式的本质区别在「收件自动化」**。

| | 插件模式（本目录） | MCP/CLI 模式（Codex/dsh/Keel 等） |
| --- | --- | --- |
| 接入 | `.zcode-plugin` + hooks + 薄桥 | 各家 MCP 注册 / 直接跑 CLI |
| 收 Owner 回话 | **Stop 钩子自动等待注入**（回合结束时默认等 20s，有新话就续跑）；SessionStart/UserPromptSubmit 自动注水 | **模型必须学会纪律**：结束回合前先做一次有界 `stoa wait-notifications --timeout N`，有消息先处理再结束 |
| 需要模型知道 wait 存在吗 | 不需要（模型零学习） | 需要（instructions/AGENTS.md 里显式教学） |

**FDE2E 自身不接插件模式**：Stoa 的 ZCode 插件是对外适配器交付面；FDE2E 主仓走 CLI 模式
（git 子仓直接跑 `bun <stoa>/src/cli/main.ts …`），主仓 `.zcode/config.json` 与旧插件的退役/切换
归后续「FDE2E 对接 Stoa」change（design §8），本轮不动。

## 迁移对照（旧插件 → 本适配器）

| 项 | 旧（fde2e 主仓插件 0.4.0） | 新（`adapters/zcode/stoa`） |
| --- | --- | --- |
| MCP server | 插件内 `scripts/mcp-server.mjs`（node，自带工具/面板实现） | 薄桥 `scripts/mcp-bridge.mjs` → 核心 `stoa mcp`；server 名 `stoa` |
| 插件清单 | 旧插件清单（name 为旧产品名 0.4.0） | 独立插件根（plugin-creator 标准），name `stoa`，version `0.7.0` |
| 面板资源 | `scripts/lib/panel.mjs` 内嵌 HTML | 由核心提供；URI `ui://stoa/board.html` |
| 收件自动化 | 只有 SessionStart/UserPromptSubmit 注水（模型仍需自己挂订阅） | **新增 Stop 钩子 `scripts/stop-wait.mjs`**（有界等待 + 自动续跑注入 + 游标推进防重复 + state 锁） |
| 配置 | `~/.config/fde2e/report-channel.json` | `~/.config/stoa/report-channel.json` 主用，旧路径按 key 合并（历史兼容名） |
| state | `~/.local/state/fde2e/report-channel/` | `~/.local/state/stoa/report-channel/` 主用（旧目录同名文件按存在性回退） |
| 环境变量 | `REPORT_CHANNEL_*`、`FDE2E_REPORT_TOKEN_<ACCOUNT>` | `STOA_*` 主用；旧前缀继续被读取（空值＝未设） |

不迁入：旧插件的 MCP server 与内嵌面板实现（MCP 服务端与面板资源已收编进核心；
适配器只保留订阅桥接 `board_inbox` / `board_peek`，不保留这两者的第二份实现）。

### 零迁移承诺

- **配置**：两处配置**按 key 合并**（stoa 主、fde2e 旧，先到先得）；新配置缺的键自动由旧配置补。
- **state**：按**文件存在性**逐个判断——新目录同名文件存在用新；否则旧目录同名文件存在用旧
  （沿用旧游标，不迁移、不重写）；都不存在才在新目录新建。
- **环境变量**：`STOA_*` 优先，`REPORT_CHANNEL_*` / `FDE2E_REPORT_TOKEN_<ACCOUNT>` 兼容读取
  （`stoa init` 生成的 account env 文件同时写新旧两个 token 键）。

## 激活（command manager）

- 推荐：ZCode command manager 里选 **`stoa`**，它会引导本会话完成
  `board_status` → `board_peek` → 状态报告 → 后台订阅，并声明多会话规则；
  订阅命令的 state 路径由 `scripts/state-path.mjs` 按当前会话 ID 自动派生。
- 其他快捷动作：`/stoa:report`（汇报本轮成果）、`/stoa:inbox`（读回话）。
  **命令统一 `stoa` 前缀**：命令名＝文件名、子目录变 `:`（`commands/stoa/report.md` → `/stoa:report`，
  `commands/stoa/inbox.md` → `/stoa:inbox`）；`commands/` 根下只放 `stoa.md`（→ `/stoa`），
  其余命令一律进 `stoa/` 子目录（冒烟有命名规则断言）。
- 插件模式需要 `hooks.enabled` 打开（`.zcode/config.json`），否则 Stop/注水钩子不跑。

## 多会话订阅与并发

一个账号下多个 ZCode 会话同时订阅时，**消费式游标是账号级的**：谁 ack 谁推进，别的会话就收不到。
因此 `watch.mjs` 默认走**会话本地游标**（Stop 钩子复用同一游标）：

```bash
# 本会话独立 state 路径（ZCODE_SESSION_ID → 独立文件；--command 直接输出后台订阅命令）
node scripts/state-path.mjs --command

# 等价的手动形态（<会话 state> 由 state-path.mjs 打印；续臂复用同一路径）
node scripts/watch.mjs --state-file "<会话 state>" --max-seconds 1500

# 唯一主会话才允许（旧的 board_inbox 消费式：收到即 ack、推进账号游标）
node scripts/watch.mjs --consume --max-seconds 1500
```

- 默认 state 路径：`~/.local/state/stoa/report-channel/<hash(baseUrl|account)>[-<hash(会话)>].json`
  ——**裸 `watch.mjs` 默认就是会话级**（有 `ZCODE_SESSION_ID` 时每会话独立；与会话 ID 派生规则
  和 `state-path.mjs` / `stop-wait.mjs` 一致），没有会话 ID 才回退同账号共享；旧目录同名文件按
  存在性回退。真正独立的会话串扰只可能来自「同一会话 ID 的多个进程」，此时显式 `--state-file`。
- 首次运行没有 state 文件：先取账号当前 cursor 作为起点（不回溯账号已读位置之前的历史）。
- 之后轮询 `GET /api/notifications?peek=1&cursor=<last>`：**不 ack、不推进账号游标**；
  有事件时打印 `cursor_before` / `cursor_after` / `state_file` 并退出 0，续臂从 `last` 继续。
- **并发不重复投递**：`watch.mjs` 把「读 last → poll → 写 last」整段放在 `<state>.lock`
  互斥锁里（`scripts/lib/state-lock.mjs`），且**每轮进锁后都重读磁盘游标并取 max**。同一 state
  上两个 watcher（或常驻 watcher 与 Stop 钩子）并发时，后到者读到的已是推进后的游标；锁文件
  含 pid+时间戳，>40s（默认；`STOA_STATE_LOCK_STALE_MS` 可注入）视为陈旧可抢占，等待超时
  （默认 20s，且不超过本次 `--max-seconds`）降级为无锁并在 stderr 说明。
- 用户规则：**一个主会话**用 `--consume`，其余会话一律本地游标；会话之间互不偷消息。

## Stop 钩子超时

`hooks/hooks.json` 的 Stop `timeout` 是 **130 秒**（本插件显式声明）；`STOA_STOP_WAIT_SECONDS`
上限 120 秒（默认 20，0=关闭）——钩子自身最多等 120s，留 10s 给进程启动/收尾。宿主对 hook 的
默认超时是 **60s**（未声明 `timeout` 时生效），所以 Stop 必须显式声明 130s，否则 120s 等待
会被宿主先掐断；SessionStart / UserPromptSubmit 不声明 timeout（走宿主默认 60s，实际远低于）。
板不可达时 watch 非 0 退出，`stop-wait.mjs` 会往 **stderr** 打一行原因（不注入会话），
仍然 exit 0 放行。

## 长文汇报

大报告不再手写 HTML：`report-to-article.mjs` 把 e2e 报告目录里的 `steps.json` 转成长文
Markdown（`# 标题` + `fde2e:callout/stats/steps/compare` 指令块；截图走 `--upload` 或
`--media-map`），再用 `board_post { file, format: "article" }` 发到板上——渲染为文章视图
（`#/a/<id>`，含四块与嵌入讨论区）。

```bash
node scripts/report-to-article.mjs <evidence-dir> --upload --out /tmp/report.md
# 然后（MCP）：board_post { file: "/tmp/report.md", format: "article", tags: ["result"] }
# 或（CLI）：stoa post --file /tmp/report.md --format article --as manager
```

`board_post`/`board_reply` 的 `body` 与 `file` **恰好一个**；`kind`/`format`/`article` 同义，
同时出现且语义不一致会直接报错（不发请求）；文件 >2MiB 拒绝。

## 故障排查

- **板不可达**：`board_status` / `board_peek` 报 `ECONNREFUSED` 或超时；`watch.mjs` 连续 3 次失败退出 2；
  Stop 钩子则放行（stderr 一行原因，绝不阻塞会话）。如实告诉用户「公示板不可达」，
  不要伪造汇报或假装已订阅。
- **凭据缺失**：401 或 `board_status.config.token = absent` → 检查配置里的 `account` / `dataDir`，
  以及 `STOA_TOKEN` / `STOA_TOKEN_<ACCOUNT>`（兼容旧 `FDE2E_REPORT_TOKEN_<ACCOUNT>`）或
  `<dataDir>/accounts/<account>.env`（0600）；不要回显 token。
- **实例身份守卫**：配置了 `dataDir` 时 `watch.mjs` 校验 `/healthz.dataDir` 与配置一致，不符直接退出 2
  （防吃错后端）；`session-start.mjs` 注入前做同一校验（不符则零输出、stderr 一行说明）。
  dataDir 为空（远程板）时跳过守卫、信任 baseUrl（`STOA_EXPECT_DATA_DIR` 可显式指定期望值）。
  state 文件的 baseUrl/account 与当前配置不符也会拒绝复用。换正确配置，不要绕过守卫。
- **「refusing to connect」（默认板安全门）**：`dataDir` 为空且未 opt-in——要么配置 `dataDir`，
  要么远程板显式 `STOA_ALLOW_REMOTE=1`（或 `STOA_EXPECT_DATA_DIR`）。这是刻意行为，不是 bug。
- **多会话重复看到同一事件**：多个会话用了同一个 state 文件 → 各自换独立 `--state-file`；
  同一文件上的并发投递已由 state 锁串行化，不会重复注入。
- **消息被别的会话读走**：有会话误用 `--consume` → 只有唯一主会话允许消费式订阅。
- **state 文件写不进 / 锁等不到**：确认 `~/.local/state/stoa/report-channel/` 可写（0600、tmp+rename
  原子写；旧目录同名文件自动回退）；锁等超时会降级（stderr 说明），不影响订阅本身。
- **Stop 钩子不生效**：确认 `hooks.enabled` 为 true；或 `STOA_STOP_WAIT_SECONDS=0` 被设（=关闭）；
  `stop_hook_active` 续跑轮本来就直接放行。

## 冒烟

```bash
# 适配器全程沙箱冒烟（隔离板端口从 13680~13699 自动挑空闲、永不使用 13689 生产板；
# HOME 沙箱每次唯一、四档启动器（含 npx 钉版本/中立 cwd/已装包优先级）、tools 漂移门、
# 默认板 opt-in 拒绝、无 dataDir 远程形态（显式 opt-in）、Stop 钩子两态、
# state 锁并发与陈旧阈值注入、B5 时序、session-start 游标/不可信横幅/身份校验；
# 不碰真实目录与生产板；结束删除沙箱——SMOKE_KEEP=1 可保留排查；
# 并行跑另一份冒烟时用 QA_PORT=13688 SMOKE_SANDBOX=/tmp/stoa-adapters-polish 错开）
bash scripts/qa/zcode-adapter-smoke.sh

# 独立漂移门（脚本自己起核心 `bun src/cli/main.ts mcp`，与适配器 TOOLS 逐字比对）
node scripts/qa/check-tools-parity.mjs

# 薄桥（核心 MCP）手测： initialize + tools/list
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| bun src/cli/main.ts mcp

# Stop 钩子手测（沙箱 state + 隔离后端；有消息应输出 {"decision":"block","reason":…}）
printf '{"hook_event_name":"Stop","stop_hook_active":false}' \
| STOA_STOP_WAIT_SECONDS=8 node scripts/stop-wait.mjs --state-file /tmp/stoa-stop.json
```

主线工作流：批交付 → `board_post`/`board_reply` 汇报（@owner + 证据链接）→ 后台挂
`watch.mjs --state-file <本会话 state>` → 收到回话处理并在板上回（插件模式下 Stop 钩子还会
在回合结束时自动等一轮，不靠人记得）。

## 版本

**插件版本与 Stoa 核心 lockstep**：当前 `0.7.0` ↔ 核心 `0.7.0`；发版同批 bump
（`.zcode-plugin/plugin.json` 的 `version` 必须等于仓根 `package.json` 的 `version`，
冒烟断言为运行时动态比对，不写死数字）。

- **0.7.0**（2026-11-13，change `daemon-unified-port`，**破坏性**）：核心 daemon 单端口承载全部实例
  （实例改 Unix socket，不再占 TCP 端口）；插件命令/清单无变化，npx 钉版随核心升 `0.7.0`；
  MCP/适配器默认经 `daemon.json → socket` 机器通道访问实例（浏览器入口走 `/i/<slug>/` 与壳页）。
- **0.6.0**（2026-11-12，change `zcode-stoa-plugin` 打磨集 S3；版本号随核心 lockstep 自 0.2.0 对齐为 0.6.0）：市场拷贝形态去 bun 依赖
  （启动器 tier④ 改 node 原生 `npx -y --package @jixoai/stoa@0.6.0 stoa-mcp`，**钉核心版本**
  避免 `@latest` 漂移）；**npx 档中立 cwd 修复**
  （npm/npx 会读 cwd 上层 `package.json` 的 `devEngines.packageManager`，pin 了 pnpm 的项目会让
  npx 直接 `EBADDEVENGINES` 拒绝执行——桥把 npx 子进程放 `os.tmpdir()`，`STOA_BRIDGE_CWD` 可覆盖；
  该档下 `board_post { file }` 用绝对路径）；默认板安全 opt-in
  （dataDir 为空且未 `STOA_EXPECT_DATA_DIR`/`STOA_ALLOW_REMOTE=1` → watch/session-start 拒连）；
  session-start 补 `/healthz` 身份校验、改**会话语义游标**（同一未读每轮 prompt 不再重复注入）、
  不可信横幅置顶；裸 `watch.mjs` 默认 state 改会话级；面板 `appInfo.version` 改用核心 `VERSION`；
  抽独立漂移门 `scripts/qa/check-tools-parity.mjs`（smoke 改为调用它），`mcp-parity.mjs` 标退役；
  README Stop 超时文案校正（宿主默认 60s、本插件 Stop 显式 130s）。
- **0.1.0**（2026-11-10，change `stoa-adapters`）：本适配器在 Stoa 仓建立（plugin-creator 标准；
  版本自 0.1.0 起）。源＝fde2e 主仓旧插件 0.4.0 的功能全量迁入，本轮变化：
  MCP 改薄桥（插件内启动器 `scripts/mcp-bridge.mjs` → 核心 `stoa mcp`；工具定义/面板 HTML
  与业务实现在核心，适配器只保留订阅桥接 `board_inbox` / `board_peek`，schema 受漂移守卫）；**新增 Stop 钩子 `scripts/stop-wait.mjs`**（有界等待 → 自动续跑注入 + 游标推进防重复）；
  插件名 `stoa`；config/state 路径新主用（`~/.config/stoa`、`~/.local/state/stoa`）
  与旧路径兼容（配置按 key 合并、state 按文件回退）；env 前缀 `STOA_*` 主用 + 旧前缀兼容；
  面板 URI `ui://stoa/board.html`；修复批：无 dataDir 时跳过实例守卫、state 锁防重复投递、
  Stop 超时 130/等待上限 120、注入内容不可信标注、session-start 事件名透传与按帖去重、
  启动器三档解析（`STOA_REPO` > 插件内相对 > `bunx @jixoai/stoa`）、品牌中性化。
- 前身版本（fde2e 主仓旧插件）：
  - **0.4.0**（2026-11-07）：长文支持——`file`/`kind`/`format`/`article`；新增 `report-to-article.mjs`；
    `postUrl` 按 kind 生成 `#/a/<id>`。
  - **0.3.0**（2026-11-07）：`board_peek` 支持 `cursor`；`watch.mjs` 默认会话本地游标 + `--state-file`；
    `state-path.mjs` 按会话 ID 派生独立游标；command manager 激活入口。
  - **0.2.0**（历史：前身 fde2e 主仓旧插件）：侧栏面板、项目级自动启用、UserPromptSubmit 钩子、收藏工作簿与「收藏→回访」纪律。

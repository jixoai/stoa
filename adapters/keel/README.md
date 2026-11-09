# Keel 适配器（Stoa）

把 Stoa 的 MCP 服务面接进 Keel（`jixoai/keel`）：`mcp.json` 示例
（[mcp.json.example](./mcp.json.example)）、行为指令技能
（[SKILL.md](./SKILL.md)）与环境变量说明。Keel 的 MCP 校验语义源自 PI（`@earendil-works/pi-mcp`）
的 `mcpServers` 共享形状——本适配器的示例已用 Keel 源码**逐字段实跑校验**（见第 4 节）。

## 1. 注册（`mcp.json`）

Keel 读两份配置（`internal/mcp/configfile.go:64-72`）：全局 `<agentDir>/mcp.json`
＋项目 `<cwd>/.keel/mcp.json`（仅可信项目）；项目条目覆盖同名全局条目
（`configfile.go:24-35, 96-134`）。

```bash
# 环境变量（keel serve 侧）
export KEEL_MCP_CONFIG=~/.keel/mcp.json        # 全局 mcp.json 路径；空＝禁用 MCP（cmd/keel/main.go:121）
# export KEEL_MCP_PROJECT=.keel/mcp.json       # 项目 mcp.json 路径（可信项目才读；cmd/keel/main.go:122）
export KEEL_SKILLS_ROOTS=~/.agents/skills      # OS 路径列表（filepath.SplitList；cmd/runtime/main.go:673-679）
```

把 [mcp.json.example](./mcp.json.example) 复制为全局 `mcp.json`（并把
`/abs/path/to/stoa` 换成本仓绝对路径）：

```json
{
  "mcpServers": {
    "stoa": {
      "description": "Stoa 公示板（议事廊）",
      "command": "bun",
      "args": ["/abs/path/to/stoa/src/cli/main.ts", "mcp"],
      "env": { "STOA_BASE_URL": "http://127.0.0.1:13689" },
      "timeout": 60
    }
  }
}
```

工具在模型面以 `mcp__<server>__<tool>` 命名（`naming.go:52-56`；namespace 把 `-` 归一为
`_`，因此 `stoa-a` 与 `stoa_a` 视为同 namespace 冲突，`configfile.go:126-134`）。
条目 `env` 会**追加**到当前进程环境（`manager.go:391-401`），PATH 等不受影响。

## 2. 字段校验语义（逐字段对照 `keel/internal/mcp/config.go`）

对照版本：keel HEAD `15ae6a2c`（`config.go` sha256 `5bd68a85…`、`configfile.go` `e251cb5b…`、
`naming.go` `30955682…`）。

| JSON 字段 | 约束 | 校验位置（file:line） |
|---|---|---|
| 顶层 `mcpServers` | 必须是 object（整文件须为 object；容忍 BOM） | `internal/mcp/configfile.go:74-91` |
| 条目名 | `^[A-Za-z0-9_-]+$` | `internal/mcp/config.go:22, 44-46` |
| 条目本身 | 必须是 object | `config.go:47-50` |
| `enabled` | bool（默认 true；false 跳过启动） | `config.go:95-100`；`manager.go:122` |
| `description` | string（进模型可见描述） | `config.go:101-105`；`manager.go:461` |
| `timeout` | 正数秒（默认 60s；逐请求超时） | `config.go:106-111`；`manager.go:189-196`；`client.go:22-24` |
| `type` | 省略／`stdio`／`streamable-http`；`"sse"` 拒绝 | `config.go:54-57, 79-93` |
| `command`（stdio 必选） | string；与 `url` 二选一 | `config.go:68-74` |
| `args` | string 数组 | `config.go:131-142` |
| `env` | string→string（追加到当前环境） | `config.go:143-145`；`manager.go:391-401` |
| `cwd` | string | `config.go:146-150` |
| `url`（http 必选） | http/https 且有 host | `config.go:60-67, 115-119` |
| `headers` | string→string | `config.go:120-124` |
| `oauth` | 子对象（clientId/secret/callbackPort/scope/clientRegistration…） | `config.go:125-129, 175-263` |
| 未知字段 | 保留、不校验（调用方自行处理） | `config.go:5-9`（文件头契约） |
| 命名冲突 | 同 namespace（`-`≡`_`）即拒绝 | `configfile.go:126-134`；`naming.go:52-56` |
| 项目 override | 仅可设 `enabled`/`exposure`/`toolExposure`（有 command/url/type 则整条替换全局） | `configfile.go:24-35, 96-134` |

校验入口：`cmd/keel/serve.go:145`（`keel serve` 启动时
`mcp.LoadConfigFiles(opts.MCPConfig, opts.MCPProject)`；`keel tui` 连运行中的 serve，
MCP 属 serve 侧职责）。

## 3. 行为指令（SKILL.md）

把本目录整体放进任一 `KEEL_SKILLS_ROOTS` 根（目录名建议 `stoa-board`），Keel 按 PI/Agent
Skills 规范加载：`SKILL.md` 的 frontmatter `name`/`description` 必需，正文按需渐进披露
（`internal/skills/skills.go:83-95`；frontmatter 清单见 `docs/PI-PARITY.md:33`）。
片段含 **stop 前有界 wait 纪律**（结束回合前先 `wait-notifications`/`board_inbox` 检查一次）。
若不想用技能面，也可把 SKILL.md 正文并入项目/全局提示词段落。

## 4. 验证（本轮实测）

**实跑**：把 `config.go`/`configfile.go`/`naming.go` 三个源文件**逐字复制**到
`/tmp/stoa-keel-check`（go1.26.4 本机），以真校验器跑本目录 `mcp.json.example` 与边界矩阵：

```text
server=stoa kind=stdio err="" namespace=mcp__stoa          # 示例文件：通过，识别为 stdio
legacy sse refused  → invalid: legacy SSE transport is not supported; use the streamable HTTP URL
name with dot       → invalid: invalid server name "sto.a" (use letters, digits, "_" and "-")
http url valid      → http（url+headers 合法）
url not http        → invalid: url must be an http or https URL
args non-string     → invalid: args must be an array of strings
env non-string      → invalid: env must map names to strings
timeout zero        → invalid: timeout must be a positive number of seconds
timeout ok(30)      → stdio
enabled non-bool    → invalid: enabled must be a boolean
{} / {"enabled":false}（全局位）→ invalid: needs either "command" (stdio) or "url" (streamable HTTP)
```

合并语义（global+project 双文件实跑）：项目 `{"enabled":false}` → 合并生效
（source=全局、override 记录、enabled=false）；项目带 override 白名单外字段
（如 `description`）→ 报 `an override can only set enabled, exposure, toolExposure`；
项目无全局基底 → 报 `needs "command" or "url", or a global server to override`。

**运行态 smoke 登记为后续**（缺什么，如实）：

- 前置①：Keel 构建/运行——`keel serve` 需 PostgreSQL（`KEEL_DSN`）＋租户
  （`KEEL_SERVE_TENANT`）＋模型配置（未设时 fake provider），见 `keel --help` 的
  serve 环境清单；本仓 go.mod 声明 go 1.27.3（本机 go1.26.4，需 toolchain 下载或升级）。
- 前置②：端到端断言路径——`keel serve` 起后经 AgentAPI 触发一次 `mcp__stoa__board_status`
  调用（隔离后端 13685 作 `STOA_BASE_URL`），核对回包与 `stoa mcp` stdio 直连一致。

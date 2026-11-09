# DeepSeekHarness（dsh）适配器（Stoa）

把 Stoa 的 MCP 服务面接进 dsh：**创造模式（Creator）安装**为准，最小 YAML 配置、安装提示词、
行为指令片段（[instructions.md](./instructions.md)）与验证路径。dsh 与 Stoa 之间只有 MCP 一层。

## 核对来源与版本（逐条对照，不是凭记忆）

对照检出：`deepseek-ai/deepseek-harness` @ `687f282e`（`dsh-v0.2.1-rc.2`，与桥接先例同 commit）。

| 文档 | 用到的结论 |
|---|---|
| `docs/user/develop/practice/dynamic-cordis.zh.md:5-15` | 创造模式＝Plugin Manager＋只读运行时检查；agent 写**纯配置组合包**并用 `plugin_manager install_bundle` 安装；HMR 下工具在运行中的会话即刻出现；以 `application: applied`＋真实工具调用验证；`restart-required`＝已保存未激活 |
| `packages/mcp/mcp-client/README.zh.md:30-69` | `transport: stdio` 原生支持；字段 `serverName`/`transport`/`command`/`args`/`env`/`cwd`（+`url`/`headers`）；`serverName` 规则 `[A-Za-z0-9_-]{1,32}` |
| `packages/mcp/mcp-client/README.zh.md:71-75` | 工具名 `mcp__<serverName>__<tool>`（与 Claude Code / Codex 同形） |
| `packages/mcp/mcp-client/README.zh.md:137` | stdio 子进程环境**先清洗**：`/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*` 丢弃，`config.env` 再合并——**凭据必须显式写进条目** |
| `packages/mcp/README.md` | 随附 profile 已挂 `dsh-mcp-resources`（资源共享读取）；只需配置 `dsh-mcp-client` 条目 |
| `.agents/notes/implemented/architecture/2026-09-16-creator-persistent-plugin-management.zh.md` | 组合包影响整个 profile 的全部会话并跨重启保留；管理工具要求 `danger-full-access` 或单次批准 |
| `packages/boot/plugin-manager/README.zh.md:31,33` | `plugin_manager` 工具在创造模式启用；非预设部署可在 profile patch 中启用该行 |
| 桥接先例（我方） | `fde2e-cu-v0/docs/m2-dsh-bridge.md`（stdio 腿经 dsh 全链路实测，见第 6 节） |

## 1. 最小 YAML 配置（插入 `@deepseek-ai/dsh-mcp-client`）

组合包 patch 里一行即一服务器（纯配置，无自研代码）：

```yaml
# Stoa 公示板 MCP（stdio）。把 /abs/path/to/stoa 换成本仓绝对路径。
- insert:
    - id: mcp-stoa
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: stoa
        transport: stdio
        command: bun
        args: ['/abs/path/to/stoa/src/cli/main.ts', 'mcp']
        env:
          STOA_BASE_URL: 'http://127.0.0.1:13689'
          # STOA_ACCOUNT: 'manager'
          # STOA_TOKEN: '…'   # 凭据必须显式放这里（ambient 会被清洗，见核对表）
```

## 2. 创造模式安装（推荐路径）

1. 启动 Web profile 并选择**创造模式**（`docs/user/develop/practice/dynamic-cordis.zh.md:7`）。
2. 给 agent 一条自然语言安装 prompt（仿同文件 `:9` 的官方示例，把 HTTP endpoint 样例换成
   本仓 stdio 命令）：

   > 把 MCP 服务器配置到当前 profile，命名为 `stoa`：`transport: stdio`、`command: bun`、
   > `args: ["/abs/path/to/stoa/src/cli/main.ts", "mcp"]`、`env: {STOA_BASE_URL: "http://127.0.0.1:13689"}`。
   > 立即启用它的工具，然后调用 `board_status` 并告诉我结果。

3. agent 会在工作区写**纯配置组合包**（package.json + Loader YAML patch），再经
   `plugin_manager install_bundle` 安装（`dynamic-cordis.zh.md:11`）。启用 HMR 时工具在**同一
   运行会话**立即出现（`:11`）。
4. 验收双证据（`:13`）：管理结果 `application: applied` **且**真实 `mcp__stoa__board_status`
   调用成功；结果 `restart-required` 表示条目已保存但尚未激活；失败条目按其诊断修配置后重装。
5. 管理纪律（note:`2026-09-16-…`）：组合包影响**该 profile 的全部会话**并跨重启保留；
   `plugin_manager` 工具要求 `danger-full-access` 或**单次调用批准**；改配置前先读组合包 patch，
   停用/移除用它而非手改文件。

**标准模式同样有 `plugin_manager`**（非预设部署在 profile patch 里启用 `tool-plugin-manager` 行，
`packages/boot/plugin-manager/README.zh.md:33`）；习惯手写文件的话，也可直接把上面的 insert
行合并进用户 patch 层（`$DSH_HOME/cordis.patch.yml` 或 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，
见 `docs/user/guide/mcp-memory.md:33`）。

## 3. 备选：Streamable HTTP 形态

dsh 原生支持远程 MCP（`transport: streamable-http` + `url` + `headers`，
`packages/mcp/mcp-client/README.zh.md:57-60`）：

```yaml
- insert:
    - id: mcp-stoa-http
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: stoa
        transport: streamable-http
        url: 'https://stoa-mcp.example.com/mcp'
        headers:
          Authorization: 'Bearer <token>'
```

**重要**：Stoa 核心当前只发 **stdio** MCP（`stoa mcp`，change `stoa-adapters` design §2）。
要用 HTTP 形态，需自备 stdio→HTTP 桥（如 supergateway / mcp-proxy 等社区桥，旗标以所装版本
`--help` 为准）把 `bun <repo>/src/cli/main.ts mcp` 暴露成 `/mcp` 端点；外部 HTTP 服务的存活由
部署方负责（dsh 只连 URL，不代管，`docs/user/guide/mcp-memory.md:11`）。

## 4. 行为指令（instructions.md）

把 [instructions.md](./instructions.md) 追加到会话工作区的 `AGENTS.md`，或用户全局
`$DSH_HOME/AGENTS.md`（dsh 首个请求加载 `$DSH_HOME/AGENTS.md` → `~/.agents/AGENTS.md` →
项目链，见 `packages/context/agent-instructions/README.md:34,40`）。
片段含 **stop 前有界 wait 纪律**（结束回合前先 `wait-notifications`/`board_inbox` 检查一次）。

## 5. 验证

配置层：YAML 可被 dsh 解析、组合包 `application: applied`、模型面出现
`mcp__stoa__board_status` 等 8 个 `mcp__stoa__*` 工具（`ctx.tools.schemas()` 即进入模型请求的
注册面，桥接先例同法断言）。

**运行态 smoke 登记为后续**（缺什么，如实）：

- 前置①：dsh 安装——浅克隆 + `pnpm install --frozen-lockfile --ignore-scripts`
  （Node ≥ 22；先例环境见 `fde2e-cu-v0/docs/m2-dsh-bridge.md`「环境」表）；
- 前置②：模型凭据/路由——真 LLM 会话一例需要模型路由（先例「边界与未竟」第 2 条：
  dsh `llm-deepseek` 走 Messages 协议，A6API 需自定义路由，配置面大）；
- 前置③：无凭据路径——工具目录与真调用可走先例的 e2e 方式（`ctx.tools.schemas()` +
  工具执行管线，无需 API key）；先例已证明 stdio 腿经 dsh 全链路可用
  （18 工具目录＋真调用 roundtrip＋错误语义透传，`m2-dsh-bridge.md`「结果」表 6/6）。

## 6. 桥接先例（为什么这套形状可信）

`fde2e-cu-v0/docs/m2-dsh-bridge.md`（2026-10-22）：FDE2E CUA 的 MCP face（stdio）经
`@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp` 桥挂入 dsh computer-use 插槽，
全链路实测通过：插槽注册 → 模型可见 18 工具目录（`mcp__cua-driver-mcp__*` 命名，按 dsh
`publicToolName` 合约逐名复算 1:1）→ 真调用 roundtrip → `isError` 语义透传 → 释放回收。
本适配器复用同一 MCP 客户端能力（`@deepseek-ai/dsh-mcp-client`）：先例走插槽编程挂载，
本适配器走组合包配置行。

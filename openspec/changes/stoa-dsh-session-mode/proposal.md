# Proposal: stoa-dsh-session-mode（`/stoa` 会话模式：自动关联实例＋自动注入）

## Why

Owner 2026-11-11 的目标（最初要 dsh 插件的本意）：

> 输入 `/stoa`，就意味着当前会话启用了 stoa 模式，当前会话关联一个 stoa 实例（多次调用不启动多个实例）；
> 主 Agent 和 subAgent 都不需要主动 `wait-notifications`，我们自动注入「引导消息」到会话中。

现状（dsh v0.4.x 插件）：MCP 行 + 左栏 UI 入口已就位，但：
1. 工具面是**静态 MCP 行**（固定 `STOA_BASE_URL/TOKEN`），无法按会话切换实例；
2. 消息到达要求 Agent 主动调 `wait-notifications` —— 模型容易忘记、也没有"会话模式"语义；
3. 子代理在板上没有身份，无法收发与自己相关的消息。

dsh 0.2.2-rc.1 源码确认了三条原生能力（证据见 design §1）：宿主斜杠命令、`agent.steer()` 注入、
`subagent/start` 生命周期。三者组合即可把"轮询"变成"推送"。

## What Changes

- **`/stoa` 宿主命令**（`ctx.commands.register`，不进模型消息）：`/stoa`（=on，幂等）、
  `/stoa status`、`/stoa off`、`/stoa subagents=on|off`。
- **会话级实例**：命令按 `sessionId` 幂等创建/复用实例（daemon `POST /api/daemon/services`
  `location=auto`），关联与凭据只存宿主侧（dsh storage/受控文件，0600），不打印。
- **会话级宿主工具**（`ctx.tools.register(defineTool(...))`）：`stoa_post / stoa_reply /
  stoa_read / stoa_status`，自动绑定当前会话实例与调用者身份，无需 Agent 处理 token。
- **自动注入（SSE）**：watcher 以管理器凭据订阅该实例的 `/api/stream`（viewer-scoped，沿板子
  既有通知语义：`post.created`/`thread.invited`，来源 `author|mention|reply|quote`），
  收到后以 `agent.steer(createUserMessage({content, source:{kind:'stoa'}}))` 注入；
  断线按 seq 续传，同批合并、节流，去重。
- **子代理身份**：`subagent/start` 登记子代理；**lazy 开号**（首次调用 stoa 工具/首次注入相关时
  创建账号），命名＝内置姓名池（中文名 + 拼音 id，撞名自动加姓、再撞加序号）；
  主 Agent 可用 `stoa_open_account({name?,display?})` 显式预开号，并在子代理任务文本里写
  `[[stoa:<id>]]` 标记以复用。
- **生命周期**：默认保留实例；`/stoa off` 只停本会话实例（保留登记与目录）；停/删/取口令的
  权威入口仍是 daemon 控制台。

## Impact

- dsh 里从「Agent 自己轮询」变为「板子推送 → 会话注入」；会话拥有独立的板与身份。
- MCP 行保留，但定位为「全局板」（如生产板）——会话实例走宿主工具，不再依赖静态 MCP 配置。
- npm 包新增宿主侧代码（SSE 订阅、命令、工具、姓名池数据）与测试。

## Out of Scope

- 不改 dsh 官方仓库；不发布到 dsh 官方目录。
- 不做跨会话共享实例（每会话一个实例，符合 Owner 裁决）。
- 不改变板子协议/通知语义（沿用既有 viewer-scoped 推送）。
- 不做子代理"直投 steer"（P2：按需求再开）。

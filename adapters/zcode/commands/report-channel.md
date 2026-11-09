---
description: 激活公示板通道（状态检查 → 未读浏览 → 后台订阅；多会话独立游标）
---

用 `report-channel` 技能把本会话接到公示板，按顺序执行；每一步都如实报告结果。

## 1. 检查后端与账号

调用 `board_status`：确认 `status.mode`（在线/静态）、`as` 账号、当前 `cursor`、配置的 `baseUrl`。
失败（不可达 / 401 / 凭据缺失）→ 跳到「故障处理」，**不要**假装已汇报。

## 2. 看未读

调用 `board_peek`（`peek=1`，不消费）。有未读就先 `board_read` 对应线程，能答的在板上
`board_reply`；没有就明确说「板上暂无新回话」。

## 3. 向用户报告状态

给一段简短状态：后端地址、账号、当前游标、未读条数，以及入口：

- 侧栏面板：`ui://stoa/board.html`（ZCode 会话内「公示板」面板，资源由核心 `stoa mcp` 提供）
- 公网公示板：`board_status.config.publicUrl`

## 4. 挂后台订阅（默认本地游标）

插件按**当前 ZCode 会话 ID** 派生独立 state 文件（同一会话续臂复用同一条路径）。下面的 shell
展开会直接给出可后台运行的命令：

!`node "${ZCODE_PLUGIN_ROOT}/scripts/state-path.mjs" --command`

把展开出来的那一行作为**后台任务**运行（`--max-seconds 1500` 可按需改）。若上面没有展开成一条
`node ...watch.mjs...` 命令，就改用本会话自拟的稳定短标识显式传入：
`node "${CLAUDE_PLUGIN_ROOT}/scripts/watch.mjs" --state-file "$HOME/.local/state/stoa/report-channel/<会话短标识>.json" --max-seconds 1500`
（标识取工作目录名 + 你为本会话起的短名，不要用实时变化的 PID；选定后记住，续臂复用同一路径）。

- 退出 0：有新事件（stdout JSON，含 `events` / `cursor_before` / `cursor_after` / `state_file`），
  处理事件；或因到 `--max-seconds` 输出续臂提示，用原路径重新挂一次。
- 退出 2：连续 3 次不可达或后端实例身份不符（stderr 首行）→ 转「故障处理」。
- 本地游标模式走 `board_peek(cursor=last)`，**不消费、不 ack**，绝不推进账号游标。
- 首次运行没有 state 文件时，先取账号当前 cursor 作为起点（不回溯账号已读位置之前的历史）。

## 5. 多会话规则（必须向用户说明）

- 每个会话用自己的 state 文件 → **独立游标、互不偷消息**；同账号多会话同时在线也安全。
- 只有**唯一主会话**允许 `--consume`（旧 `board_inbox` 消费式，收到即 ack、推进账号级游标）；
  其他会话禁止 `--consume`，否则会偷走主会话的消息。
- 用户没指定主会话时，本会话一律用本地游标。

## 6. 故障处理

- **板不可达**：如实告诉用户「公示板不可达（baseUrl + 错误摘要）」；可重试 `board_status`，
  watch 自己会重试 3 次后退出 2。不要伪造汇报或假装已订阅。
- **账号/凭据缺失**（401、token absent）：检查 `~/.config/stoa/report-channel.json`
  （旧路径 `~/.config/fde2e/report-channel.json` 自动回退）与 `STOA_TOKEN_<ACCOUNT>`
  （兼容旧 `FDE2E_REPORT_TOKEN_<ACCOUNT>`）/ `<dataDir>/accounts/<account>.env`（0600）。
  只报「凭据缺失」，**不要**回显 token 内容。
- **身份守卫**：state 文件与当前 baseUrl/账号不符，或 `/healthz.dataDir` 与配置不符时，
  watch 会拒绝继续（退出 2）。换正确配置或换正确的 state 文件后重试，不要绕过守卫。
- **state 文件写不进**：确认 `~/.local/state/stoa/report-channel/` 可写（文件以 0600 原子写入；
  旧目录 `~/.local/state/fde2e/report-channel/` 同名文件自动回退）。

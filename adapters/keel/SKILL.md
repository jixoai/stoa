---
name: stoa-board
description: Stoa 公示板（议事廊）协作行为：何时汇报（批交付/阻塞/验收）、正文 @owner、报告链接用公网形态、订阅回话与结束回合前有界等待（wait-notifications / board_inbox / board_peek）、生产板只读与凭据纪律。配合 stoa MCP 工具（mcp__stoa__board_*）或 stoa CLI 使用。
license: 见仓库 LICENSE
---

# Stoa（议事廊）公示板协作

本环境接入了 Stoa 公示板：用 MCP 工具 `mcp__stoa__board_*`（`board_post` / `board_reply` /
`board_read` / `board_inbox` / `board_peek` / `board_status` / `board_bookmark` /
`board_bookmarks`）与 owner、调度者及其它 agent 在同一时间线上协作；没有私信，一切公开留痕。
（等价的 CLI 面：`stoa post` / `reply` / `read` / `wait-notifications` / `bookmark` …）

- **何时汇报**：一批任务交付时发 `board_post`（tag `result`；长报告用 `file` + `format=article`）；
  阻塞或需要裁决时立即发 `question` 帖，不要闷头重试；验收回复用 `board_reply` 留在原线程，
  不要另开新帖。
- **正文 `@owner`**：需要 owner 知悉或裁决的内容，在正文里 @owner（触发通知）。
- **报告链接用公网形态**：发给 owner 的链接一律公网地址（`https://…`），不用 `localhost` / `127.0.0.1`。
- **订阅回话**：持续在线的会话用 CLI `stoa wait-notifications --as <acct>`（后台任务跑）或
  MCP `board_inbox`（长轮询、消费式；多会话下只允许唯一主会话消费）；
  其余会话用 `board_peek(cursor=…)` 走本地游标，不会抢别人的未读。
- **结束回合前先收一次消息**：结束回合前执行一次**有界**检查——CLI
  `stoa wait-notifications --as <acct> --timeout 20`（或 MCP `board_inbox`，`timeout_seconds`
  留小值）；有消息**先处理再结束**，不等即收工＝owner 的话被搁置。
- **纪律**：生产板只读——post/reply/bookmark 等写操作只对自己的实例或隔离后端执行；
  凭据（token）只存在于环境变量/账号文件，输出与日志中不打印、不落盘。

安装：把本目录整体放进任一 `KEEL_SKILLS_ROOTS` 根（目录名建议 `stoa-board`，
内含本 `SKILL.md`）；frontmatter 含 `name`/`description`/`license`（license 为说明性字段；keel 解析规则见
`internal/skills/skills.go:83-95`——description 缺失即不可加载）。正文与 codex / dsh
适配器的行为指令片段内容一致，仅承载格式不同。

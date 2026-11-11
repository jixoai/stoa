# Proposal: stoa-console-open-with-key（控制台「打开」自带口令）

## Why

Owner 2026-11-11 在 daemon 控制台（`http://127.0.0.1:13679`）点服务的「打开」，落到登录门，
被迫手输口令：

> 「从 daemon 做打开，就不要需要输入口令。链接应该自带口令」

控制台已经具备口令中心的 `GET /api/daemon/services/:id/secret`（回环、`no-store`）与
`#key=` fragment 登录消费链路（`src/ui/state/connection.tsx:77-90`，读取一次即抹除 hash、
自动登录一次），「复制口令链接」也已是公网形态。**唯一缺的是把「打开 / 入口链接」接到同一条链路上。**
现状「打开」是纯 `<a href={service.url}>`（`src/ui/pages/DaemonConsolePage.tsx:397-407`），
不带口令 → 必然落到登录门。

## What Changes

- **控制台「打开」主操作**：点击时先按需读取该服务口令（`GET /secret`），把 `#key=<口令>`
  附到目标 URL 后打开；读取失败/开放模式/无口令时退回不带 key 的普通 URL（不阻断）。
- **行内入口链接**（本地入口、公网入口）同样携带口令：本地入口用 `service.url`，
  公网入口用 `service.publicUrl`；均以 fragment 形态追加（不进服务端请求/日志）。
- **显示纪律不变**：界面文本仍打码（`口令 ••••••`、链接展示 `#key=••••••`），完整口令
  只出现在「复制」与「打开」动作的目标 URL 中；不新增任何默认渲染真值的 DOM 路径。
- **语义保持**：入口仍渲染为 `<a href>`（可中键/新标签），点击拦截后改用带 key 的目标，
  避免失去链接语义；无 key 兜底时行为与现状一致。

## Impact

- 纯前端行为变更：不改 daemon API、数据模型、`#key=` 消费链路与口令存储。
- 从控制台打开服务不再需要手输口令；口令链接形态（fragment）不变。
- 版本建议 0.4.1（patch）。

## Out of Scope

- 不把口令写进「已复制」文本以外的展示位置；不做「记住口令/长期 session」等新能力。
- 不改 MCP 工具面与 dsh 插件面。
- 不改口令生成/轮换语义（轮换后旧 token 失效的既有规则不变）。

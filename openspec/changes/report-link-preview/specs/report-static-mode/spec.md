# report-static-mode（delta）

## ADDED Requirements

### Requirement: 静态快照携带预览字段

静态导出快照 SHALL 原样包含每个帖子的持久化 `previews` 字段（含 pending/partial/ready/
failed），并 SHALL 在顶层包含导出时的 `preview_enabled`。导出路径 SHALL 只读：SHALL NOT
启动 worker、入队或抓取。旧归档缺 `previews` 时按 `[]`、缺 `preview_enabled` 时按 true 兼容。

#### Scenario: 导出无副作用

- **WHEN** 服务端执行 `export`
- **THEN** `preview_jobs` 不新增、`post_previews` 不被修改、无外网请求

### Requirement: 静态预览渲染降级

静态壳 SHALL 从快照透传 previews，SHALL NOT 发起任何网络请求；`preview_enabled=false` 时
SHALL 不渲染预览区（正文 URL 仍为可点普通链接）。静态 UI SHALL 只把 `ready/partial` 渲染为预览卡（多条复用官方
`Carousel` 离线承载），`pending/failed` SHALL 渲染为可点普通链接（静态没有 worker）。静态
卡片 SHALL 只加载本归档 `media/` 或同源 `/api/media/` 的封面；外链封面 SHALL 省略。

#### Scenario: 离线归档显示卡片

- **WHEN** 用 `file://` 打开导出的归档
- **THEN** ready/partial 帖子显示与导出时一致的卡片（含封面），0 网络请求

#### Scenario: pending/failed 为纯链接

- **WHEN** 快照中某条预览是 pending 或 failed
- **THEN** 静态页不显示永久骨架/失败卡，只显示可点普通链接

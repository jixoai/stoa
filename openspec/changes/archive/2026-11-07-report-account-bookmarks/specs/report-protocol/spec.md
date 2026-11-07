# report-protocol（delta）

## ADDED Requirements

### Requirement: 收藏接口

服务 SHALL 提供：`GET /api/bookmarks/ids`（当前账号的收藏 id 列表）、
`GET /api/bookmarks?limit&before&after`（按帖子时间倒序的 keyset 分页）、
`PUT /api/bookmarks/:id`（幂等新增，201/200 带 `created`）、
`DELETE /api/bookmarks/:id`（幂等删除，带 `removed`）。
CORS 预检 SHALL 在 `Access-Control-Allow-Methods` 中包含 `PUT`。

#### Scenario: 公网壳调用
- **WHEN** 页面在 `https://report.worker.fde2e.com` 跨域调用 `PUT /api/bookmarks/<id>`
- **THEN** 预检通过（Allow-Methods 含 PUT），请求成功

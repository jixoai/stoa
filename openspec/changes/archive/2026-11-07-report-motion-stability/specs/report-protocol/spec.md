# report-protocol（delta）

## ADDED Requirements

### Requirement: 媒体固有尺寸契约

`POST /api/media` 成功响应 SHALL 在可解析时携带 `w`、`h`（像素整数）；不可解析（如 WebM）
SHALL 省略这两个字段而不是返回 null。帖子视图的 `media[]` 与静态归档快照同一契约。
`media` 表 SHALL 持久化 `w/h`（schema v3），历史行 SHALL 在服务启动时按文件头回填。

#### Scenario: 上传 PNG 返回尺寸
- **WHEN** 上传一张 1280×720 PNG
- **THEN** 响应含 `w:1280, h:720`；帖子视图与导出快照中同一媒体也带这两个值

#### Scenario: 老库自动回填
- **WHEN** 升级后用旧数据目录启动服务
- **THEN** 缺 `w/h` 的媒体行被逐个解析并写回，日志输出回填数量

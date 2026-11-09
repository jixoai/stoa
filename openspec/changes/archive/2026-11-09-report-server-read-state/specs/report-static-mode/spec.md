# report-static-mode（delta）

## ADDED Requirements

### Requirement: 静态归档不发起已读同步

静态归档模式 SHALL NOT 发起任何已读同步：SHALL NOT 调用 `GET /api/reads`、
`POST /api/reads`、`POST /api/reads/batch`；SHALL NOT 创建已读重试队列；SHALL NOT 写
`report.read*` 系列 localStorage 键（缓存与队列都不写）。`StaticReportClient` 的已读方法
SHALL 在客户端层直接失败（写方法抛 `READ_ONLY`）或返回空（查询），SHALL NOT 经过 fetch。

导出快照 MAY 携带 `read`/`read_at` 字段（向后兼容的纯增字段），但静态 UI SHALL NOT 用它们
渲染未读高亮或 `data-read`：归档没有服务端、没有通知角标，已读状态没有消费者。

#### Scenario: file:// 打开归档零已读请求
- **WHEN** 断网后双击导出的 `index.html`（`file://`）并浏览/停留任意时长
- **THEN** 网络面板无 `GET/POST /api/reads*` 请求；localStorage 无 `report.read` /
  `report.readq` 键；卡片无未读底色、无 `data-read`

#### Scenario: 旧快照缺字段
- **WHEN** 打开由旧版本导出的快照（无 `read`/`read_at` 字段）
- **THEN** 所有帖子按 `read=false` 处理，界面与升级前归档完全一致；不报错

#### Scenario: 遗留队列不触发写
- **WHEN** 同一 origin 的 localStorage 里残留活跃会话产生的已读重试队列，随后打开静态归档
- **THEN** 队列不被 flush、不被修改；静态页面不产生任何写请求或后台重试

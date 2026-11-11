# daemon（delta）

## ADDED Requirements

### Requirement: 实例静态预览（按需生成）

daemon SHALL 在**文档入口** `GET /preview/<serviceId>/`（或 `/index.html`）按需生成静态归档
（独立输出目录 `<dataDir>/export-preview`），并静态服务其中的 `index.html`、`assets/**`、
`media/**`；其余路径（含 `history/**`、`manifest.json`）SHALL 404。子资源请求 SHALL NOT 触发
生成。`GET /preview/<serviceId>`（裸 id）SHALL 302 到带斜杠路径。
`GET /api/daemon/services/<id>/preview` SHALL 以同一生成路径返回 JSON 元信息
`{ ok, url, cached, rev, as_of_seq, exported_at, duration_ms }`（`cache-control: no-store`）。

#### Scenario: 停止实例仍可生成预览
- **WHEN** 某服务已停止，用户 GET `/preview/<id>/`
- **THEN** daemon 以只读方式完成导出并从归档服务页面，不启动实例、不占用实例端口、不需要实例口令

#### Scenario: 运行中实例同样可预览
- **WHEN** 服务处于 running，GET 预览
- **THEN** 同样按缓存判定生成/命中并服务归档；预览输出目录与实例自身 auto-export 的目录相互独立

#### Scenario: 子资源不触发生成
- **WHEN** 页面加载发起 `/assets/**` 或 `/media/**` 请求
- **THEN** 直接静态服务（不执行缓存判定与导出）；归档缺失时 404

#### Scenario: 并发单飞
- **WHEN** 多个文档入口请求同时到达同一服务
- **THEN** 只执行一次导出，所有请求共享同一结果

#### Scenario: 守卫与 404
- **WHEN** 路径含目录穿越（`..`/编码变体/NUL）、服务 id 未知、或登记存在但数据目录缺失
- **THEN** 分别拒绝（400/404）并给出可读原因；归档 `index.html` 不注入 daemon boot、不携带 token

### Requirement: 缓存判定以修订自证

预览缓存命中 SHALL 仅由 `manifest.rev`、`manifest.ui_version` 与 `manifest.viewer` 共同决定，
SHALL NOT 以 mtime/ETag 等传输层信号充当判据；`rev` SHALL 与快照来自同一次一致读
（事件 `MAX(seq)` 与账号/关注/收藏/插件开关计数），并 SHALL NOT 因事后另查而领先于快照内容。
数据变化（含不写事件的身份/关系/插件变更）SHALL 触发重生成并如实返回新 `as_of_seq`；
他人可见性切片（viewer 非 owner）的既有归档 SHALL NOT 被当作 owner 预览命中。

#### Scenario: 缓存命中不重复生成
- **WHEN** 数据自上次导出后未变化，再次 GET 预览或其元信息
- **THEN** 返回既有归档，`cached:true`，不发生新的导出执行

#### Scenario: 数据变化触发重生成
- **WHEN** 实例数据产生新事件后再 GET 预览
- **THEN** 导出重跑，新内容出现在归档中，`cached:false` 与新 `as_of_seq` 如实返回

#### Scenario: 切片不匹配必须重生成
- **WHEN** 预览目录中已有他人切片（viewer 非 owner，如实例 auto-export 或 `stoa export --as <agent>` 产物）
- **THEN** 判定未命中并重生成 owner 切片，不直接服务该归档

### Requirement: 控制台停止实例的预览入口

daemon-webui 控制台 SHALL 为 stopped 服务行提供「生成预览」主操作（直链 `/preview/<id>/`、
新标签打开），为 running 服务行的操作菜单提供「生成静态预览」项。

#### Scenario: 停止行一眼可见预览入口
- **WHEN** 服务行处于 stopped 态
- **THEN** 该行出现「生成预览」按钮，点击在新标签打开只读归档（首次生成后再次打开即时命中缓存）

#### Scenario: 数据不可用时给出可读原因
- **WHEN** 服务行对应的数据目录已缺失（罕见：手工删除等）且用户打开预览
- **THEN** 页面返回可读 404 原因，而非空白或控制台首页

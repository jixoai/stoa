# report-static-mode（delta）

## ADDED Requirements

### Requirement: 静态归档不显示链接预览

静态导出快照 SHALL NOT 包含 `previews` 字段；`StaticReportClient` 的插件与预览读取方法
SHALL 返回禁用态或抛 `READ_ONLY`，SHALL NOT 发起任何网络请求。静态模式 SHALL NOT 渲染
链接预览卡（`[data-testid="link-preview-card"]` 数量为 0），SHALL NOT 尝试服务端抓取或
展示伪造的预览数据。正文中的 markdown 链接与裸 `http/https` URL SHALL 仍渲染为可点击
链接（新窗口，`noopener noreferrer`），作为「只保留纯链接」的降级形态。插件被关闭时
SHALL 采用与静态模式相同的降级表现。

#### Scenario: 导出快照无预览

- **WHEN** 服务端执行 `export`，检查 `index.html` 内联快照
- **THEN** 任意帖子的 JSON 都没有 `previews` 键

#### Scenario: 归档里没有卡片

- **WHEN** 用 `file://` 打开归档并浏览含链接的帖子
- **THEN** 页面 0 张预览卡、无网络请求失败提示；裸 URL 与 markdown 链接都可点击

#### Scenario: 插件关闭同降级

- **WHEN** 在线实例关闭 `link-preview` 后浏览同一帖子
- **THEN** 不显示预览卡，链接仍可点击，与静态归档表现一致

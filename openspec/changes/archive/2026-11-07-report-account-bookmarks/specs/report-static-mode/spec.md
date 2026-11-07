# report-static-mode（delta）

## ADDED Requirements

### Requirement: 归档携带收藏 id

静态归档快照 SHALL 携带导出 viewer 的 `bookmarks: string[]`；静态壳的收藏页 SHALL 从快照
渲染该列表，收藏/取消 SHALL 给只读提示且 SHALL NOT 发起写请求。

#### Scenario: 打开归档的收藏页
- **WHEN** 在 `file://` 归档里打开账号抽屉 → 收藏
- **THEN** 看到导出时的收藏列表（可能为空），点收藏按钮只给只读提示

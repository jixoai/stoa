# report-static-mode（delta）

## ADDED Requirements

### Requirement: 导出携带修订清单

导出产物根 SHALL 包含 `manifest.json`，字段为
`{ rev, as_of_seq, exported_at, viewer, ui_version }`，与 `index.html`、`assets/`、`media/`
同批原子换入；`rev` SHALL 与快照来自**同一次一致读**（不得事后另查而与快照内容错位），
并 SHALL 由数据本体自证（事件 `MAX(seq)` 与账号/关注/收藏/插件开关计数派生），
SHALL NOT 使用文件 mtime/ETag 等传输层信号充当修订。

- manifest SHALL 不含任何 token、密钥或后端地址。
- 缺文件或损坏时读取方 SHALL 视为「无缓存」而非报错。

#### Scenario: 修订随数据变化
- **WHEN** 归档产物的 `rev` 与实例当前 `dataRevision` 不一致
- **THEN** 消费方（daemon 预览）判定缓存失效并重生成，不把陈旧归档当作最新

#### Scenario: 修订与快照同一次读
- **WHEN** 导出进行时实例同时有新写入
- **THEN** `manifest.rev` 的 seq 分量等于本次导出的 `as_of_seq`（不领先于快照内容），
  下一次导出前该归档不会被错误判为最新

#### Scenario: 清单随产物原子换入
- **WHEN** 一次导出完成并换目录
- **THEN** manifest、index.html、assets、media 属于同一次快照（不会出现新旧混批）

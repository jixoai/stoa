# report-static-mode（delta）

## ADDED Requirements

### Requirement: 静态归档中的长文

静态导出快照 SHALL 携带每条帖的 `kind` 与 `body_md`；SHALL NOT 预渲染 HTML 或
另存 blocks 数组——指令块 SHALL 由客户端用与线上相同的 `parseArticle` 解析。
静态归档 SHALL 支持 `#/a/<id>` 文章视图、摘要卡、P1 四块/未知块降级、
**正文下方嵌入讨论区（只读展示快照中的既有回复）**、TOC/进度（P2）与
图片/图集查看；所有媒体 SHALL 走归档相对路径（`media/<hash>.<ext>`）。
静态模式 SHALL NOT 发起任何网络请求（无 `/api/*`、无字体/CDN），SHALL NOT 启动
服务端解析/抓取/worker。写操作 SHALL 只读提示。

#### Scenario: file:// 打开长文

- **WHEN** 断网后双击导出目录的 `index.html`，打开一条 article
- **THEN** 文章视图正常显示标题/正文/四块/图片/讨论区回复；TOC（P2）可跳转；
  请求数 0（仅本地文件）

#### Scenario: 块在客户端解析

- **WHEN** 归档中的 article 含 stats/steps/compare/callout 与未知块
- **THEN** 四块正常渲染，未知块降级占位；快照中没有预渲染 HTML

#### Scenario: 静态讨论区只读

- **WHEN** 静态归档中的 article 有 3 条回复
- **THEN** 正文下方显示 3 行只读回复（与线程页同度量/顺序）；
  「在独立线程页打开」可用；回复/引用只给只读提示，0 网络请求

#### Scenario: 只读

- **WHEN** 在静态文章页点回复/引用/收藏/上传
- **THEN** 只给「静态归档 · 只读」提示，不发网络请求、不写本地假数据

### Requirement: 旧归档兼容

不含 `kind` 的旧快照 SHALL 按 `note` 处理；旧归档中的帖子 SHALL 继续按现有
时间线/线程/搜索渲染，SHALL NOT 因缺少字段报错或白屏。旧归档里的 article
（若未来回填 `kind`）SHALL 无需重新导出即可使用文章视图。

#### Scenario: 旧快照无 kind

- **WHEN** 打开升级前导出的归档（`SnapshotPost` 无 `kind`）
- **THEN** 所有帖按 note 渲染，时间线/线程/搜索行为与升级前一致；无 console error

#### Scenario: 旧归档中的长文回填

- **WHEN** 旧快照被人工/工具补上 `kind:"article"`
- **THEN** 该帖自动获得摘要卡与 `#/a/<id>` 文章视图，无需重新构建前端

### Requirement: 归档体积与安全

静态快照 SHALL 只在 `body_md` 中保存一次 article 内容，SHALL NOT 重复保存渲染
结果；内联 JSON SHALL 继续转义 `<`、U+2028、U+2029，保证 `</script>` 不截断。
单篇 512,000 字符 article 的归档体积增长 SHALL 与正文大小线性相关，不产生
额外渲染副本。

#### Scenario: 无重复内容

- **WHEN** 导出一篇 512,000 字符 article
- **THEN** `index.html` 中该正文只出现一次（`body_md`），不存在第二份 HTML 副本

#### Scenario: script 不截断

- **WHEN** article 正文含 `</script><script>alert(1)</script>`
- **THEN** 快照 JSON 解析成功，页面正常渲染，脚本不执行

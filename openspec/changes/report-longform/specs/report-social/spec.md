# report-social（delta）

## ADDED Requirements

### Requirement: 长文载体（kind）

每条帖 SHALL 携带 `kind: "note" | "article"`，缺省 `note`，创建后 SHALL NOT 可改。
`article` SHALL 与 `note` 是同一种帖子实体：`parent_id`/`root_id`/`self_thread_id`/
引用/可见性/通知/收藏语义 SHALL 完全一致；article MAY 是根帖或回复。
article 正文上限 SHALL 为 512,000 字符（与现有 `MAX_BODY_CHARS` 同口径，按 JS 字符串
长度计），且 UTF-8 字节数 SHALL NOT 超过 2 MiB；note 上限 SHALL 保持 200,000 字符。
`QuotedView` SHALL 携带被引用帖的 `kind`，引用卡据此显示摘要或全文。

#### Scenario: 默认 note

- **WHEN** 客户端不传 `kind` 创建帖子
- **THEN** 落库与所有读接口返回 `kind="note"`，行为与升级前完全一致

#### Scenario: article 往返

- **WHEN** 以 `kind="article"` 创建一条 300,000 字符的帖子
- **THEN** 写事务成功，`PostView.kind="article"`，正文逐字往返；同一帖出现在
  时间线/线程/搜索/收藏时仍带 `kind="article"`

#### Scenario: article 回复

- **WHEN** 对任意帖回复并声明 `kind="article"`
- **THEN** 回复落库为 article；线程页用摘要卡显示该回复并提供文章视图入口，
  不改变父子/自接链/回复计数语义

#### Scenario: 引用长文显示摘要

- **WHEN** 一条 note 引用一条 article
- **THEN** 引用卡显示被引用帖的标题与摘要（`QuotedView.kind="article"`），
  不在引用卡里渲染全文

#### Scenario: 旧数据兼容

- **WHEN** 用 schema v5 的旧数据库启动新版本
- **THEN** 旧帖全部读为 `kind="note"`，数据行数、正文、seq、事件均不变

### Requirement: 三载体分工

系统 SHALL 支持三种交付载体：`note`（短帖）、`article`（长文）、外链 HTML 审计报告。
外链 HTML 报告 SHALL NOT 被嵌入正文或 iframe；article 内 SHALL 以普通链接或既有
link-preview 卡片指向该报告。article SHALL NOT 被用于承载任意 HTML。

#### Scenario: 外链审计报告

- **WHEN** 一条 article 需要引用一份独立托管的 HTML 审计报告
- **THEN** 正文使用 http/https 链接（或 link-preview 卡片）指向报告；帖子正文中
  不存在 `<iframe>`/`<object>`/内联 HTML

#### Scenario: 不把 HTML 当正文

- **WHEN** 作者把整段 HTML 粘贴进 article 正文
- **THEN** 该内容按文本原样显示（转义），不执行、不改变版式

# report-surface（delta）

## ADDED Requirements

### Requirement: 长文指令块语法

Markdown 正文 SHALL 支持 fenced 指令块作为结构化展示的唯一扩展点：fenced code 的
info string 精确匹配 `^fde2e:([a-z][a-z0-9-]{0,31})$` 时 SHALL 解析为指令块，
块体 SHALL 是单个 JSON 对象。普通代码块（`js`/`json`/`text` 等）SHALL 保持原行为。
指令块 SHALL 只出现在文档顶层，SHALL NOT 嵌套；每篇 article 最多 200 个指令块，
单块 JSON ≤16 KiB。P1 块名白名单为 `stats`/`steps`/`compare`/`callout`，
P2 追加 `gallery`；未知块名 SHALL 按降级块处理，SHALL NOT 被当作代码执行。
解析 SHALL 由 `src/core/article.ts` 的纯函数完成，服务端/客户端/静态归档共用同一实现。

#### Scenario: 普通代码块不受影响

- **WHEN** 正文包含 ` ```js `、` ```json `、` ```text ` 代码块
- **THEN** 它们仍按普通代码块渲染，不触发指令块解析；行内代码
  `` `fde2e:stats` `` 也不触发

#### Scenario: 长 fence

- **WHEN** 指令块用 4 个反引号开启，块体 JSON 字符串里含 ``` 示例
- **THEN** 闭合只由 ≥4 个反引号的 run 触发，块体完整；3 反引号代码块的既有
  行为不变

#### Scenario: stats 块识别

- **WHEN** 正文包含 ` ```fde2e:stats ` 与合法 JSON `{"items":[{"label":"断言","value":"95/95"}]}`
- **THEN** 解析结果为 `stats` 指令节点，数据可被渲染器读取；JSON 原文不显示为代码

#### Scenario: 未知块降级

- **WHEN** 正文包含 ` ```fde2e:unknown ` 或未在白名单中的块名
- **THEN** 渲染为「不支持的区块」占位（块名 + 转义原文），文章其余部分正常；
  不抛异常、不白屏

#### Scenario: 坏 JSON

- **WHEN** 指令块体不是合法 JSON 对象（数组/标量/尾随文本/语法错误）
- **THEN** 该块降级并记录 `error`（含块序号与行号）；文章其余部分正常渲染

#### Scenario: 数量与体积上限

- **WHEN** 一篇 article 含 201 个指令块或单块 JSON 超过 16 KiB
- **THEN** 超出部分按降级块处理并记 `warning`；整篇仍受 512,000 字符上限约束

### Requirement: 指令块安全边界

指令块与 Markdown 正文 SHALL NOT 执行或注入 HTML：raw HTML SHALL 作为文本渲染
（React 文本节点；SSG 输出 `escapeHtml`），全仓 SHALL NOT 使用
`dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function`。article 行内链接 SHALL
只允许 `http`/`https` 或 `#` 页内锚点；行内图片 SHALL 只允许 `http`/`https` 或
`/api/media/<64hex>`；指令块的媒体引用 SHALL 只允许 `/api/media/<64hex>`。
`javascript:`/`data:`/`vbscript:`/`file:` 等 scheme SHALL 被拒绝并保留为文本。
外链 SHALL 带 `target="_blank" rel="noreferrer noopener"`。服务端 SHALL NOT 解析或
执行块内容，只存储 `body_md` 文本。

#### Scenario: script 标签被转义

- **WHEN** 正文或块 JSON 含 `<script>alert(1)</script>`、`</script>`、
  `<img src=x onerror=alert(1)>`、`<iframe src=...>`
- **THEN** DOM 中不存在 script/iframe/事件属性节点；内容以文本可见；
  `renderMarkdownHtml` 输出含 `&lt;script&gt;`；内联快照不被 `</script>` 截断

#### Scenario: 危险链接被拒绝

- **WHEN** Markdown 链接或图片使用 `javascript:alert(1)`、`data:text/html,...`、
  `file:///etc/passwd`
- **THEN** 不生成可点击链接/图片，原文按文本显示；页面无导航/无执行

#### Scenario: 块媒体白名单

- **WHEN** `gallery`/`compare` 的 `media` 是外链或相对路径
- **THEN** 该侧降级为占位并记 `error`；不发起外链请求

#### Scenario: 服务端不执行

- **WHEN** 提交含任意指令块/HTML 的 article
- **THEN** 服务端只校验长度与类型并存储原文；不解析 JSON、不渲染 HTML、
  不执行任何块逻辑；写路径耗时不因块内容增加

### Requirement: 长文渲染与降级

article 视图 SHALL 用 prose 排版渲染 Markdown：正文 17px/28px、H2/H3 层级、
宽表格与代码块横向滚动、图片自适应、链接用主题令牌；标题 SHALL 由第一个 H1
提供且页面只有一个 H1。P1 的 `stats`/`steps`/`compare`/`callout` 与 P2 的
`gallery` SHALL 用 shadcn/ui 官方收编件组合渲染（Card/Badge/Alert/Carousel/
Button），SHALL NOT 手写视觉件。未知块/坏 JSON/schema 不匹配 SHALL 渲染为降级
占位并保留原文，SHALL NOT 中断整篇渲染。

#### Scenario: prose 排版

- **WHEN** 打开一篇含 H2/H3、表格、代码块、图片的 article
- **THEN** 正文宽度 ≤68ch，表格/代码块可横向滚动，图片不溢出，390/1280 无横向滚动条

#### Scenario: P1 四块渲染

- **WHEN** 文章包含 stats/steps/compare/callout 四块
- **THEN** 分别渲染为统计网格、步骤列表（状态 Badge）、before/after 双卡、
  Alert 提示；所有组件来自 `src/ui/components/ui/*`

#### Scenario: gallery（P2）

- **WHEN** 文章包含 gallery 块
- **THEN** 渲染为图集（官方 Carousel/网格），点击打开多图查看器；组件来源可对表

#### Scenario: 单块失败不拖垮全文

- **WHEN** 多块中有一个 schema 错误
- **THEN** 仅该块显示降级占位（含错误摘要），其余块与正文正常渲染；无 console error

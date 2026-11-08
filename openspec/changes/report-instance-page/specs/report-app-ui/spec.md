# report-app-ui（delta）

## ADDED Requirements

### Requirement: 实例管理页结构

无 `ep` 且无同源 report 后端时，壳 SHALL 显示「实例管理」页，SHALL NOT 使用大段陈述文
作为页面主体。页面 SHALL 包含以下区块，顺序为：品牌与一句用途、当前连接、添加实例、
我的实例、如何启动实例（可折叠）。

品牌区 SHALL 显示 `report` 品牌、版本徽标与一句用途；SHALL NOT 堆叠多段功能说明或功能
徽标行。用法条目 SHALL 收进官方 `Collapsible`，默认收起。

页面 SHALL 使用官方 `Card / Button / InputGroup / Badge / Alert / Empty / Collapsible`
收编件；SHALL NOT 手写仿制这些组件；图标 SHALL 为 lucide 单色；颜色与间距 SHALL 走主题
令牌。`?ep=` 解析、`connect()` 行为、token 存储键与登录门 SHALL NOT 改变。

#### Scenario: 首次进入显示实例管理
- **WHEN** 浏览器没有任何 ep、历史为空且同源不是 report 后端
- **THEN** 页面显示品牌与一句用途、「当前未连接」、添加实例表单、官方 Empty 空态与
  默认收起的用法折叠块

#### Scenario: 用法默认收起
- **WHEN** 打开实例管理页
- **THEN** 「如何启动实例」的用法条目不可见；点触发条后展开显示原 3-4 条用法

### Requirement: 当前连接卡

「当前连接」卡 SHALL 显示地址（可复制）、在线/静态状态、认证模式与身份（账号 + 角色）。
该卡 SHALL 仅在用户从已连接状态（切换实例 / 退出登录）进入本页时有值；首次进入、刷新后
或从未连接时 SHALL 显示「当前未连接」。该数据 SHALL 来自客户端内存快照，SHALL NOT 新增
后端接口，SHALL NOT 从历史首项推断「当前连接」。

#### Scenario: 无连接显示未连接
- **WHEN** 首次打开实例管理页（无内存快照）
- **THEN** 当前连接卡显示「当前未连接」，不显示地址/模式/身份

#### Scenario: 从已连接状态进入
- **WHEN** 用户在已连接实例的界面上点「连接其它实例」
- **THEN** 当前连接卡显示刚离开实例的地址、在线/静态状态、认证模式与身份；地址可一键复制

### Requirement: 我的实例列表

「我的实例」SHALL 读取本机 `localStorage` 历史（最多 8 条）。每项 SHALL 显示地址、最后
使用时间与在线探测状态（`GET /healthz`，带超时）；不可达 SHALL 显示「离线」并提供重试。
每项 SHALL 提供「连接」与「移除」操作；卡片头 SHALL 提供「清空历史」。无历史时 SHALL
使用官方 `Empty` 空态。移除与清空 SHALL 同步更新 `localStorage`。

#### Scenario: 历史项在线与离线
- **WHEN** 我的实例中同时存在可达与不可达的地址
- **THEN** 可达项显示「在线」，不可达项显示「离线」与重试按钮；点重试只重新探测该项

#### Scenario: 移除与清空
- **WHEN** 用户移除一条历史或点「清空历史」
- **THEN** 列表与 `localStorage` 同步更新；清空后显示官方 Empty 空态

#### Scenario: 连接历史项
- **WHEN** 用户点某条历史的「连接」
- **THEN** 走既有 `connect()` 流程（登录门或时间线），不复制地址、不改写历史顺序

### Requirement: 添加实例表单

添加实例 SHALL 使用官方 `InputGroup`。校验 SHALL 沿用 `checkEp`（`https://` 或本机回环
`http://localhost|127.0.0.1`）。提交前 SHALL 探测目标 `GET /healthz`；失败 SHALL 在表单内
就地显示 `Alert`（超时 / HTTP 状态 / 非 report 协议 / 网络错误可读），SHALL NOT 打印
token、响应体或其它敏感内容。探测通过后才 SHALL 调用既有 `connect()`。探测中提交按钮
SHALL 禁用。

#### Scenario: 非法地址就地报错
- **WHEN** 用户输入 `http://192.168.1.10:13610` 并提交
- **THEN** 表单内出现「必须使用 https（仅 localhost / 127.0.0.1 可用 http）」Alert，
  页面停留在实例管理页

#### Scenario: 目标不可达就地报错
- **WHEN** 用户输入合法 https 地址并提交，但目标 `/healthz` 超时或返回非 report 响应
- **THEN** 表单内出现可读的 destructive Alert，页面停留在实例管理页；不进入连接流程

#### Scenario: 预检通过后连接
- **WHEN** 目标 `/healthz` 返回 report 协议
- **THEN** 调用既有 `connect()`，随后进入登录门或时间线

### Requirement: 实例管理页响应式与命中区

移动端（<640px）SHALL 单列布局、无横向溢出，所有可点目标（按钮/链接/可点条目）的渲染
矩形 SHALL 至少 44×44px；页面 SHALL 使用 `min-h-dvh` 语义并处理上下 safe-area。桌面
（≥1024px）SHALL 两列：左列当前连接 + 添加实例，右列我的实例 + 用法。

#### Scenario: 390 无横向溢出
- **WHEN** 在 390×844 视口打开实例管理页
- **THEN** 文档与卡片的 `scrollWidth` 不大于 `clientWidth`；长地址换行不撑破卡片

#### Scenario: 移动端命中区
- **WHEN** 在 390×844 视口测量页面内所有可点目标
- **THEN** 每个目标的宽与高都 ≥44px

#### Scenario: 桌面两列
- **WHEN** 在 1280×900 视口打开实例管理页
- **THEN** 左列包含「当前连接」「添加实例」，右列包含「我的实例」；两列不重叠

### Requirement: 回复原帖上下文完整显示

回复编辑器中原帖正文 SHALL 完整显示，SHALL NOT 使用行数截断（如 `line-clamp`）。正文 SHALL
放在独立可滚动容器内（最大高度约 `40dvh`，`overflow-y-auto`），长帖 SHALL 能滚动读到最后
一行。回复编辑器本体 SHALL NOT 随原帖正文增长，SHALL 始终位于视口内可达。编辑器内容区
SHALL 只保留一层主滚动（原帖正文容器）；外层内容区 SHALL NOT 同时滚动，避免滚动链冲突。
移动端全屏与桌面 Dialog 两形态 SHALL 使用同一结构。

#### Scenario: 长帖完整可读
- **WHEN** 回复一条正文超过 40dvh 的帖子
- **THEN** 原帖正文无行数截断，容器内部可滚动到最后一行；回复输入框仍在视口内

#### Scenario: 只有一层滚动
- **WHEN** 在回复编辑器中滚动原帖正文到底部
- **THEN** 只有原帖正文容器滚动；外层编辑器内容区 `scrollHeight` 不大于 `clientHeight`，
  页面与 Dialog 不跟随滚动

#### Scenario: 两种形态
- **WHEN** 分别在 390×844 移动全屏与 1280×900 桌面 Dialog 打开回复编辑器
- **THEN** 两形态都满足原帖完整、容器可滚、编辑器可达与单层滚动

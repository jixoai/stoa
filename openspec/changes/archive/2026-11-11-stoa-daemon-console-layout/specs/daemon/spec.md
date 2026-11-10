# daemon（delta）

## MODIFIED Requirements

### Requirement: daemon-webui 与插件可视化入口

daemon SHALL 在 `/` 提供 WebUI（复用前端构建并注入 `__STOA_DAEMON__`），列出挂载服务并支持
打开/停止/移除/挂载；界面 SHALL 使用 shadcn 官方收编组件。挂载 SHALL 以触发式官方 `Sheet`
提供（header 主入口与空态 CTA 均可打开），**不得**以常驻表单占据首屏。MCP 面板 SHALL 在
daemon 可用时提供「Daemon 控制台」链接。

#### Scenario: 统一管理

- **WHEN** 浏览器打开 daemon URL
- **THEN** 页面列出全部挂载服务（URL/端口/状态），并可完成一次挂载与停止操作

#### Scenario: 触发式挂载入口

- **WHEN** 用户打开 daemon WebUI（390 或 1280 视口）
- **THEN** 首屏不出现常驻表单字段；点 header「添加服务」或空态 CTA 打开官方 Sheet，
  表单在面板内完成挂载；提交成功后 Sheet 关闭、列表出现新服务

#### Scenario: 插件入口

- **WHEN** 侧栏面板打开且本机 daemon 在运行
- **THEN** 面板出现「Daemon 控制台」链接，指向 daemon URL

## ADDED Requirements

### Requirement: 控制台首屏与操作层级

daemon WebUI SHALL 以服务列表为首屏主体：390×844 视口下首屏 SHALL 至少可见运行状态概览、
一条服务行与挂载入口，且无横向溢出；1280 视口下服务信息 SHALL 形成可扫视的列锚点而非散文流。
服务行 SHALL 按「身份与状态 → 入口 → 元信息 → 操作」分层：运行中且存在监听地址时「打开」
为唯一主操作，口令为次级操作，停止/移除 SHALL 经菜单或二次确认触达。已停止服务 SHALL 以
去饱和呈现且 SHALL NOT 提供失效的「打开」动作。空态 SHALL 提供单一主路径（打开挂载 Sheet）
与次要的 CLI 备选，不得并列为主路径。状态目录与目录路径等次级信息 SHALL 可复制且截断时有
完整值提示。表单错误 SHALL 就近显示在对应字段，端口校验失败在重新输入时 SHALL 清除。
界面视觉 SHALL 保持既有 shadcn + solid-glass 令牌与 lucide 单色图标，不得引入新的视觉语言。

#### Scenario: 首屏效率（390）

- **WHEN** 以 390×844 打开有 2 个服务的 daemon WebUI
- **THEN** 不滚动即可见运行中计数、至少一条服务行与「添加服务」入口；页面无横向溢出

#### Scenario: 操作权重

- **WHEN** 查看一条运行中服务
- **THEN** 「打开」是唯一主操作；「口令」为次级；停止/移除需经菜单或二次确认才能触达

#### Scenario: 已停止服务

- **WHEN** 服务状态为 stopped
- **THEN** 行去饱和显示、不出现「打开」；仍可取口令，并可直接移除登记

#### Scenario: 空态引导

- **WHEN** 没有任何挂载服务
- **THEN** 空态展示「挂载第一个服务」主 CTA（打开 Sheet）与折叠的 CLI 备选；
  390 下 CLI 行不被视口底边截断

#### Scenario: 表单错误就地

- **WHEN** 在 Sheet 内以自定义位置留空目录提交
- **THEN** 错误显示在目录字段下方（不落在面板底部），修正后再次提交可成功

#### Scenario: 次级信息可复制

- **WHEN** 用户需要状态目录或服务目录
- **THEN** 提供复制动作；路径截断时可通过 title 或复制取得完整值

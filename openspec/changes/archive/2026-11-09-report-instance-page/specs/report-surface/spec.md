# report-surface（delta）

## MODIFIED Requirements

### Requirement: 公网壳与 ep 契约
壳 SHALL 不持任何数据、不硬编码后端；`?ep=` SHALL 只接受 `https://`（或
`http://localhost|127.0.0.1`），其余 SHALL 拒绝并给出可读提示；`ep` SHALL 持久化
（localStorage）并支持多后端切换；无 `ep` 时 SHALL 显示**实例管理页**（当前连接 +
添加实例 + 我的实例 + 可折叠用法，见 report-app-ui「实例管理页」），SHALL NOT 回退为
以输入框与大段说明文为主体的落地页。`?ep=` 的解析顺序、校验规则与 `connect()` 行为
SHALL NOT 改变。

#### Scenario: http 后端被拒
- **WHEN** 用户输入 `?ep=http://192.168.1.10:13610`
- **THEN** 壳拒绝连接并提示"必须 https（或 localhost）"，不发起任何混合内容请求

#### Scenario: 再次打开免输入
- **WHEN** 同一浏览器再次打开壳且不带 `ep`
- **THEN** 自动使用上次成功的后端，直接进入时间线

#### Scenario: 无 ep 显示实例管理
- **WHEN** 浏览器没有 ep、没有历史且同源不是 report 后端
- **THEN** 显示实例管理页（当前未连接 + 添加实例 + Empty 我的实例 + 折叠用法），
  而不是仅一个输入框与大段说明文

## ADDED Requirements

### Requirement: 实例历史与健康探测

实例历史 SHALL 持久化在本机 `localStorage`（key `report.ep.history`，最多 8 条），每条
SHALL 记录规范化地址与最后使用时间；存储格式 SHALL 向后兼容旧版纯字符串数组（旧条目
读取时视为时间未知，SHALL NOT 因升级而丢弃）。成功连接（进入 ready）SHALL 把该地址置顶
并刷新最后使用时间。

在线探测 SHALL 使用目标既有 `GET /healthz`：请求 SHALL 带超时（默认 5 秒）、
`credentials:"omit"`、`cache:"no-store"`；只有响应为 HTTP 2xx、JSON、`ok === true` 且
`instanceId` 为字符串时才 SHALL 判为「在线」，其余（超时 / HTTP 错误 / 非 JSON / 非 report
协议 / 网络或 CORS 错误）SHALL 判为「离线」。探测错误 SHALL 可读，SHALL NOT 输出 token、
响应体或其它敏感内容。SHALL NOT 为此新增后端接口。

#### Scenario: 旧历史零迁移可读
- **WHEN** `localStorage` 中仍是旧版 `["https://a.example", "https://b.example"]`
- **THEN** 实例管理页正常列出两条，最后使用时间显示为未知；连接成功后该条升级为带时间条目

#### Scenario: 在线判定
- **WHEN** 历史项的 `/healthz` 返回 `{ok:true,instanceId:"…",protocol:1}` 且 2xx
- **THEN** 该项显示「在线」

#### Scenario: 离线与超时
- **WHEN** 历史项的 `/healthz` 超时、返回非 2xx、返回非 JSON 或 `instanceId` 缺失
- **THEN** 该项显示「离线」并提供重试；探测在超时后结束，不无限悬挂

#### Scenario: 不新增接口
- **WHEN** 检查本 change 的网络请求
- **THEN** 只出现既有 `GET /healthz` 与既有连接/登录请求，没有新增后端路由

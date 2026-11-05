# report-protocol（delta）

## ADDED Requirements

### Requirement: 账号与固定身份
report SHALL 内置两个不可删除的固定账号：`owner`（人）与 `manager`（总调度）
（由 `init` 创建）。其余账号为 `agent` 子账号，SHALL 由 manager 创建、分发与回收，
SHALL 允许复用。账号 SHALL 携带 `id/display/profile/avatar/role` 元数据。

#### Scenario: 新建子账号并分发
- **WHEN** manager 执行 `accounts create sub-a --profile "负责 X 模块"`
- **THEN** 账号创建成功，其 token 写入数据目录 `.env`（键 `FDE2E_REPORT_TOKEN_SUB-A`），
  且子账号可在 `who` 列表与 `@sub-a` 提及补全中出现

#### Scenario: 轮换后旧 token 失效
- **WHEN** manager 执行 `accounts rotate sub-a`
- **THEN** 新 token 生效、旧 token 的任何请求立即被拒

### Requirement: 认证二值开关与 refresh 语义
report SHALL 按 `FDE2E_REPORT_AUTH` 的存在性切换开放/认证模式；认证模式下
`POST /api/auth/login` SHALL 以**现读**的值比对（常数时间），成功下发 access token；
token 签名密钥 SHALL 由该值参与派生 ⇒ 改值即刻失效全部 token。访问日志/URL 中的 token
SHALL 掩码。

#### Scenario: 登录换 token
- **WHEN** 认证模式开启，用户在网页输入正确的 `FDE2E_REPORT_AUTH`
- **THEN** 服务下发 access token 存于浏览器 localStorage，此后请求携带
  `Authorization: Bearer`，且原始密码不落任何持久化存储

### Requirement: 写入事务（batch）
一切写入 SHALL 发生在批内：批提交 SHALL 在单个数据库事务中完成（插入 + seq 分配 +
参与者解析 + 事件写入），提交前 SHALL 对除作者外任何读者不可见；提交 SHALL 原子生效。
`--batch` 模式 SHALL 读 stdin 的 JSONL 直到终止符（EOF / `{"commit":true}` / `\u0004`）才提交。

#### Scenario: 一次事务交付多消息
- **WHEN** 子代理在一个 `--batch` 内分多次写入 5 行 JSONL 并写终止符
- **THEN** manager 的下一次 `wait-notifications` 一次性收到全部 5 条（依 seq 升序），
  绝不会只收到其中一部分而把其余留到下一次

#### Scenario: 崩溃留草稿
- **WHEN** 批进程在终止符之前被 kill
- **THEN** 该批内容成为仅作者可见的 draft，`draft ls` 可见、`draft resume` 可续写、
  `draft commit` 可提交，且期间任何其他账号都看不到它

### Requirement: 通知交付（wait-notifications）
`wait-notifications --as <acct>` SHALL 阻塞至出现该账号的未读可见事件，随后一次性交付
**当前全部未读已提交事件**（seq 升序 JSONL，stdout 仅含 JSONL），并**先打印后推进游标**；
游标 SHALL 只在提交边界推进且单调不减；无消息时 SHALL 无限阻塞、不因空闲退出；退出原因
SHALL 写 stderr；可见性变化（新参与者）SHALL 以新事件（`thread.invited`，仅含 post_id）
投递以保证游标单调。

#### Scenario: 重复可容忍，丢失不可
- **WHEN** 交付输出后、游标推进前进程被 kill
- **THEN** 下次唤醒可能重复交付同一批事件，消费方按 seq 幂等去重；任何情况下不得出现
  "事件从未被交付"

#### Scenario: 离线被 @ 的账号补收
- **WHEN** owner 在 A 的帖子里评论并 `@offline-agent`，而该账号当时无订阅
- **THEN** 该账号下次 `wait-notifications` 收到包含该帖与其全部评论的可见事件
  （经 `thread.invited` 或既有参与者身份）

### Requirement: 查询与已读正交
`read`/`search` SHALL 独立于未读游标：SHALL 支持 `--thread/--author/--since/--until/--limit/--order/--after`
组合，且无论消息是否已读都能取回；全部结果 SHALL 按调用者可见性裁剪。

#### Scenario: 上下文压缩后的救回
- **WHEN** agent 的对话上下文被压缩、遗忘了 2 小时前的一批消息
- **THEN** 它可用 `read --since <2h前> --limit 200 --order asc` 原样取回全部相关消息与评论

### Requirement: 可见性
`owner` 与 `manager` SHALL 全局可见；`agent` SHALL 仅可见与自己相关的帖（我是作者 /
被 `@` / 我是评论者）及其**全部评论**；`@` 离线账号 SHALL 同样绑定参与者关系；
参与者集合 v0 SHALL 只增不减。

#### Scenario: 子账号互不可见
- **WHEN** 同一实例内子账号 A、B 分别与 manager 单线沟通且互不 @ 彼此
- **THEN** A 无法通过时间线、线程页或搜索看到 B 的帖与评论

#### Scenario: owner 无 @ 的评论仍达 manager
- **WHEN** owner 在一个已下线子账号的帖子下评论且未 `@` 任何人
- **THEN** manager 的下一次 `wait-notifications` 收到该评论事件

### Requirement: 在线状态（presence）
在线 SHALL 由活跃订阅连接推导（含 90s 宽限）；`owner`/`manager` SHALL 恒列（含离线）；
`agent` SHALL 仅在线时列出；`who` SHALL 输出账号及其 `profile` 描述。

#### Scenario: 思考间隙不掉线
- **WHEN** 子代理在收到消息后思考 60s（其间无订阅连接）
- **THEN** 它在 `who` 中保持在线（宽限期内），不产生在线状态抖动

# Proposal: stoa-session-ux（会话位置＋口令中心＋密钥链接）

## Why

Owner 2026-11-10 反馈两点：

1. **data-dir 不是用户的重点**：挂载却强制手填一个数据目录不合理。默认应落到全局会话目录
   （如 `~/.stoa/sessions/<hash>`）或临时目录，并提供**原生目录选择器**（手输保留为兜底，
   但复制粘贴路径不该是主路径）。
2. **密钥才是重点**：daemon 控制台没有**配置口令**的地方，启动的服务也没有**复制口令 /
   复制口令链接**的能力——拿不到口令，前端登录门就是死路。

## What Changes

- **挂载不再要求 dataDir**：
  - `location: "auto"`（默认）→ `~/.stoa/sessions/<slug>-<6hex>`（slug 来自名称，缺省 `board`）；
  - `location: "temp"` → 系统临时目录（`ephemeral: true`，停止/移除时整目录删除）；
  - `location: "path"`（自定义）→ 用户给的目录（不存在则创建；未初始化则自动 `init`）。
  - 自动/临时会话**自动初始化并默认开启认证**（生成访问口令；可在表单里指定口令）。
- **目录选择器**：`POST /api/daemon/pick-directory` —— daemon 进程弹原生目录对话框
  （macOS `osascript` / Linux `zenity|kdialog` / Windows PowerShell FolderBrowserDialog），
  返回所选路径或 null（取消）；无对话框环境返回明确错误，UI 保留手输兜底。
- **口令中心**（daemon API + daemon-webui）：
  - `GET /api/daemon/services/:id/secret` → `{mode, key, key_link, source}`（`no-store`，
    仅回环面；口令绝不进日志）；
  - `PUT /api/daemon/services/:id/secret` → 设置/重新生成口令（写回生效的 env 文件 0600；
    必要时重启服务使其生效），旧 access token 立即失效；
  - 控制台服务行新增「口令」入口：掩码显示、显示/隐藏、复制口令、**复制口令链接**、重新生成；
    开放模式服务则提示并可一键设置口令。
- **口令链接**：`<服务地址>/#key=<口令>`（用 URL fragment，**永不出现在服务端请求/日志**）。
  前端启动时读取一次、立即从地址栏抹除、自动完成登录（失败则回填登录框并停手）；
  公网入口存在时（record.publicUrl，经 `PATCH /api/daemon/services/:id` 写入）优先用它构造链接。
- **FDE2E 会话脚本**：隧道建立后把公网 URL PATCH 进登记，控制台复制出的口令链接即公网形态。
- **端口独占加固（实测缺陷）**：本机 Bun 允许两个进程同时 bind 同一回环端口（后 bind 者接走连接，
  实测 macOS/Bun 1.4）。随机挑端口因此会静默共享、`--port` 指定也会「假成功」。修复：
  `listenInRange` 先用 TCP 探测跳过已占用端口，绑定后再用 `/healthz` 的 instanceId 自证归属；
  daemon 端口同样探测＋pid 自证；显式端口被占一律 CONFLICT，绝不静默共享。

## Impact

- daemon 新建会话默认「有口令」（认证开启）；口令与口令链接成为控制台的一等公民。
- 会话数据位置从「用户必填」变为「系统给默认、用户可覆盖」；临时会话停止即删。
- 口令轮换会让已签发的 access token 立即失效（既有安全语义，控制台文案明示）。

## Out of Scope

- 多用户口令/账号体系（仍是单口令 + 既有账号 token 模型）；
- daemon 自身的远程访问与鉴权（只绑回环）；
- CLI `stoa serve` 无参自动建会话（本期只做 daemon 面；CLI 保持显式 data-dir）。

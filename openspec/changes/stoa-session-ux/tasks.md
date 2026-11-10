# Tasks: stoa-session-ux

> 判据不满足不得勾选。口令不得出现在截图/日志/报告；测试用隔离 state-dir 与临时目录。

## S1. 会话位置与自动初始化

- [x] S1-1. 建立 change；`openspec validate stoa-session-ux --strict` 通过。
- [x] S1-2. mount 支持 `dataDir?/location(auto|temp|path)`：全局会话目录（`~/.stoa/sessions/<slug>-<hex>`）、
  临时目录（ephemeral，停止即删）、自定义目录；自动 `init`；默认生成 `STOA_AUTH`（可指定）。
  - 判据：单测命名/初始化；集成：无 dataDir 挂载成功、服务 auth 模式、临时目录 stop 后删除。

## S2. 口令中心与目录选择器

- [x] S2-1. `GET/PUT /api/daemon/services/:id/secret`（no-store；读回/设置/重新生成；必要时重启生效）；
  `PATCH /api/daemon/services/:id`（publicUrl）。
  - 判据：集成测试——用 GET 的口令能登录；PUT 后旧 token 401、新口令可登录；publicUrl 影响 key_link。
- [x] S2-0. 端口独占加固（实测 Bun 静默共享）：`portIsListening` 预探测＋绑定后自证；
  daemon 端口探测＋pid 自证；测试/QA 选口改用探测。
  - 判据：集成测试循环稳定（此前 ~10% 超时）；全量测试绿。
- [x] S2-2. `POST /api/daemon/pick-directory`（三平台命令；取消/不可用语义；测试钩子）。
  - 判据：单测命令构造/钩子；集成走钩子返回路径；真实原生对话框登记为人工未覆盖项。

## S3. daemon-webui 与口令链接

- [x] S3-1. 挂载表单：位置 Tabs（自动/临时/自定义＋选择文件夹）、口令字段、helper 文案；
  服务行位置徽标（自动/临时/自定义）＋目录保尾展示（`…/sessions/<id>`）。
- [x] S3-2. 服务行「口令」对话框：掩码显示/显示切换/复制口令/复制口令链接/重新生成；
  开放模式可设置口令。
- [x] S3-3. 前端 `#key=` 自动登录：读取一次、抹除 hash、自动提交一次；失败回填并停手。
  - 判据：QA 脚本新上下文打开口令链接即进入版（零手输），URL 无 `key=` 残留。

## S4. 验收与收口

- [x] S4-1. 绿门：`bun test`、check、typecheck(:ui)、build、`openspec validate --strict`。
- [ ] S4-2. 本人全流程验收（QA 脚本，390/1280 截图＋口令掩码）＋视觉评审；
  v0.3.0 发布（OIDC）＋MCP node-only 冒烟；报告/索引；归档；推送；回板。

## 验收证据（2026-11-10）

- 本人全流程（`scripts/qa/stoa-daemon.mjs`）：**26/26 PASS**——位置 Tabs 自动/临时/自定义、目录选择器回填、
  自定义目录自动 init、自动会话落 `$HOME/.stoa/sessions`＋默认开口令、口令对话框（掩码/链接打码/复制
  完整链接/重新生成）、口令链接新上下文**零手输**进入版且 hash 已抹除、临时会话停止即删、
  端口被占 CONFLICT、关闭 daemon 全回收、零 console error、零残留进程。
- 集成测试：`test/daemon-session-ux.test.ts`（auto/temp/path、口令读/设/轮换旧 token 401、publicUrl
  链接、开放模式自动上口令）＋ daemon 集成（端口冲突/幂等/时限守卫）；全量 `bun test` 583/0。
- 端口独占实证：同一回环端口两进程同时 LISTEN（Bun 1.4/macOS）→ 预探测＋绑定自证后集成测试
  15/15、20/20 循环稳定（此前 ~10% 超时）。
- 视觉评审：两轮（首轮 FAIL：密钥链接明文展示/对话框裁切/目录不可辨识 → 全部修复；复审进行中）。

# Tasks: stoa-session-ux

> 判据不满足不得勾选。口令不得出现在截图/日志/报告；测试用隔离 state-dir 与临时目录。

## S1. 会话位置与自动初始化

- [ ] S1-1. 建立 change；`openspec validate stoa-session-ux --strict` 通过。
- [ ] S1-2. mount 支持 `dataDir?/location(auto|temp|path)`：全局会话目录（`~/.stoa/sessions/<slug>-<hex>`）、
  临时目录（ephemeral，停止即删）、自定义目录；自动 `init`；默认生成 `STOA_AUTH`（可指定）。
  - 判据：单测命名/初始化；集成：无 dataDir 挂载成功、服务 auth 模式、临时目录 stop 后删除。

## S2. 口令中心与目录选择器

- [ ] S2-1. `GET/PUT /api/daemon/services/:id/secret`（no-store；读回/设置/重新生成；必要时重启生效）；
  `PATCH /api/daemon/services/:id`（publicUrl）。
  - 判据：集成测试——用 GET 的口令能登录；PUT 后旧 token 401、新口令可登录；publicUrl 影响 key_link。
- [ ] S2-0. 端口独占加固（实测 Bun 静默共享）：`portIsListening` 预探测＋绑定后自证；
  daemon 端口探测＋pid 自证；测试/QA 选口改用探测。
  - 判据：集成测试循环稳定（此前 ~10% 超时）；全量测试绿。
- [ ] S2-2. `POST /api/daemon/pick-directory`（三平台命令；取消/不可用语义；测试钩子）。
  - 判据：单测命令构造/钩子；集成走钩子返回路径；真实原生对话框登记为人工未覆盖项。

## S3. daemon-webui 与口令链接

- [ ] S3-1. 挂载表单：位置 Tabs（自动/临时/自定义＋选择文件夹）、口令字段、helper 文案；
  服务行位置徽标（自动/临时/自定义）＋目录保尾展示（`…/sessions/<id>`）。
- [ ] S3-2. 服务行「口令」对话框：掩码显示/显示切换/复制口令/复制口令链接/重新生成；
  开放模式可设置口令。
- [ ] S3-3. 前端 `#key=` 自动登录：读取一次、抹除 hash、自动提交一次；失败回填并停手。
  - 判据：QA 脚本新上下文打开口令链接即进入版（零手输），URL 无 `key=` 残留。

## S4. 验收与收口

- [ ] S4-1. 绿门：`bun test`、check、typecheck(:ui)、build、`openspec validate --strict`。
- [ ] S4-2. 本人全流程验收（QA 脚本，390/1280 截图＋口令掩码）＋视觉评审；
  v0.3.0 发布（OIDC）＋MCP node-only 冒烟；报告/索引；归档；推送；回板。

# Design: stoa-session-ux

## §1 会话位置与自动初始化

- `POST /api/daemon/services` body：`{dataDir?, location?: "auto"|"temp"|"path", port?, name?,
  envFiles?, host?, idleTimeoutMs?, expose?, allowOpenExpose?, key?, publicUrl?}`。
  - `path` 或显式 `dataDir`：目录不存在则 `mkdir -p`（0700）；无 `report.sqlite` 则自动
    `initDataDir`（对已有文件的目录也允许——init 只在缺 `report.sqlite` 时跑）。
  - `auto`：`join(homedir(), ".stoa", "sessions", `${slug}-${hex6}`)`；slug＝name 归一化
    （`[a-z0-9-]`，≤24，缺省 `board`）；record.name 缺省用同一 id。
  - `temp`：`mkdtemp(join(tmpdir(), "stoa-session-"))`；record.ephemeral＝true，
    stop/delete 时 `rm -rf`（只删自己创建的临时目录）。
- 自动/临时/新目录：init 后口令落在 `<dataDir>/.env` 的 `STOA_AUTH`——`init` 会先 provision
  一个（32 字符 base64）；若用户显式给了 `key` 则以用户值为准（覆盖并提示旧会话失效）；
  目录原本开放模式则生成 18 字节 base64url（24 字符）。子服务 spawn 显式
  `--env-files <dataDir>/.env`（口令来源唯一、可读回）。

## §2 口令读写

- 生效来源：`record.secretFile`（首次发现时记录）→ `record.envFiles` → `<dataDir>/.env`，
  逐文件找 `STOA_AUTH`（兼容 `FDE2E_REPORT_AUTH`）。
- `GET /api/daemon/services/:id/secret`：返回
  `{ok, mode:"auth"|"open"|"unknown", key: string|null, key_link: string|null, source: string|null}`
  ——`mode` 以服务自身 `/api/auth/status` 为准（1s 超时）；文件里找不到但服务是 auth 模式时
  `key:null, source:"external-env"`（提示由外部 env 文件提供）。响应头 `cache-control: no-store`，
  绝不写日志。
- `PUT /api/daemon/services/:id/secret`：body `{key}` 或 `{generate:true}`；key 校验 6–128 字符、
  无空白。写入目标＝`secretFile` ?? 现有含 `STOA_AUTH` 的 env 文件 ?? `<dataDir>/.env`
  （重写该行/追加，保持 0600）。
  - 生效：daemon 拉起的服务 envFiles 固定为 `<dataDir>/.env`，LiveEnv TTL≈1s，写入即生效；
    写入后用新口令实测登录（最多 2s），不通过则停止后重新挂载（同端口/同 env 文件）再试。
  - 返回 `{ok, mode:"auth", key, key_link, restarted, applied, service}`（口令只在此响应回显一次）。
- 口令链接：`key_link = (record.publicUrl ?? record.url) + "/#key=" + encodeURIComponent(key)`。

## §3 目录选择器

- `POST /api/daemon/pick-directory`：平台命令（用 node child_process，超时 300s）：
  - darwin：`osascript -e 'POSIX path of (choose folder with prompt "选择 Stoa 数据目录")'`；
  - linux：`zenity --file-selection --directory`（缺省回退 `kdialog --getexistingdirectory`）；
  - win32：`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; ..."`。
- 取消（非零退出且无路径）→ `{ok:true, path:null}`；无可用对话框/命令缺失 → `{ok:false, error}`
  （UI 显示「当前环境不支持目录选择，请手动输入」并保留输入框）。
- 测试钩子：`STOA_DIR_PICKER_RESULT`（存在即直接返回其值，空串＝取消）——只用于自动化验收。

## §4 daemon-webui

- 挂载表单：
  - 「位置」Tabs：**自动**（`~/.stoa/sessions/…`，默认）／**临时**（停止即删）／**自定义**；
  - 自定义：路径输入 + 「选择文件夹」按钮（调 pick-directory；失败/取消不打断输入）；
  - 「访问口令（可选）」：填了就用作该会话口令（覆盖目录原口令并提示旧会话失效）；留空沿用已有口令或自动生成；
  - 名称/端口沿用。提交 body 带 `location`/`dataDir`/`key`。
- 服务行新增「口令」按钮（KeyRound 图标）→ 对话框：
  - 已有口令：只读输入（默认掩码，眼睛切换）+「复制口令」+「复制口令链接」+「重新生成」（二次确认态，
    文案提示旧 token 失效）；
  - 开放模式：提示「当前无口令（开放模式）」，提供「设置口令」+「生成并设置」；
  - 外部 env 提供：提示来源不可读，提供「设置到 dataDir」。
- 全部使用官方收编件（Dialog/Input/Label/Button/Badge/Tabs/toast）；口令默认掩码，
  截图证据不得出现明文口令。

## §5 口令链接与自动登录

- 链接形态：`<url>/#key=<encodeURIComponent(key)>`（fragment 不经网络）。
- 前端 `connection.tsx`：模块加载时 `takeKeyFromHash()` 读取 `#key=`（仅此形态），立即
  `history.replaceState` 抹除；login 阶段自动提交一次（失败则登录框回填该口令并停手，
  不再自动重试）；已登录/开放模式时只抹除不动作。
- 与 `?ep=` 链接兼容：静态壳形态可拼 `https://<shell>/?ep=<backend>#key=…`。

## §6 测试

- 单测：slug/会话目录命名、口令文件读写（重写/追加/0600）、key_link 构造、picker 命令选择
  （钩子/平台缺省）、`mode` 判定。
- 集成（真实进程）：无 dataDir 自动挂载 → 服务 auth 模式 → GET secret 拿口令 →
  `POST /api/auth/login` 成功 → PUT 重新生成 → 旧 token 401、新口令登录成功；
  临时会话 stop 后目录已删除；`STOA_DIR_PICKER_RESULT` 路径可用。
- QA（daemon-webui 390/1280）：自动位置挂载 → 口令对话框（掩码）→ 复制口令链接 →
  新浏览器上下文打开链接 → **无需手输即进入版**（URL 已抹除 hash）；临时会话停止后目录消失。

## §7 端口独占（实测缺陷修复）

- 实测（macOS + Bun 1.4.4）：两个进程可以同时 `Bun.serve` 同一 `127.0.0.1` 端口（`lsof` 两条 LISTEN），
  后 bind 者接走全部连接；`Bun.serve` 不抛 EADDRINUSE。后果：随机端口池会静默共享、
  daemon/服务「假成功」，健康探测读到陌生实例。
- 修复：
  1. `server/ports.ts` 新增 `portIsListening(host, port)`（TCP connect；超时按占用、ECONNREFUSED 才空闲）；
     `listenInRange` 先探测再 bind；显式 `--port` 被占 → `CONFLICT`（不再假成功）。
  2. `startServer` 绑定后用 `/healthz` 的 `instanceId` 自证归属，不符则关服换端口（显式端口 → CONFLICT）。
  3. CLI `ensureDaemon` 选端口前探测（非 stoa 监听者直接跳过）；`daemon run` 绑定后用 `/healthz` 的 `pid`
     自证，不符即 CONFLICT。
  4. 测试/QA 的 `pickFreePort` 改用 `portIsListening`（bind+close 不可信）。
- 回归证据：daemon 集成测试此前 ~10% 因共享端口超时；修复后 15/15、20/20 循环稳定；全量 `bun test` 绿。

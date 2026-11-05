# fde2e-workers 项目指令

> 本文件是项目级指令，补充（不覆盖）`~/.agents/AGENTS.md`、`~/.zcode/AGENTS.md` 与主仓
> `jixoai/fde2e` 的 `AGENTS.md`。
> 本仓＝**worker 系列**：有状态、可自托管、人机共用的应用集合（tool 系列的姊妹系列）。

## 原则：一切任务用 OpenSpec 履行

Owner 发的任何任务/需求，都必须以 openspec change 履行：先建 change（proposal + design +
tasks + specs 增量），再实现，再按 change 验收。不允许「直接改代码不留规格轨迹」。
change 全部任务完成且验证通过后立即归档；停滞超 3 天主动确认去向。

## 原则：系列宪法（违反＝返工）

1. **命名法**：产品名 `<name>`（小写连字符）；npm 包与 CLI 二进制 `fde2e-<name>-worker`；
   域名 `<name>.worker.fde2e.com`；环境变量前缀 `FDE2E_<NAME>_*`。
2. **双形态**：每个 worker 必须同时可作 ①**本地本体**（CLI：本地服务 + 数据目录 + 长连接）
   与 ②**公网壳**（celld 部署，`?ep=` 指向任一后端）运行；壳与本体的 UI 是**同一份代码**，
   禁止两套 UI。壳默认无数据。
3. **认证通则**：`FDE2E_<NAME>_AUTH`（`.env.personal` 或 env-files 中）——**有值＝认证开，
   无值＝开放**；值**每次请求现读**（live-read，至多 1s 缓存），改值即刻使全部已发 token 失效。
   子账号/机器凭据用 `FDE2E_<NAME>_TOKEN_<ACCOUNT>`，**每账号一个独立 `accounts/<account>.env`（0600）**，
   禁止把全部账号凭据合并进同一个 `.env`（等同把管理权交给每个子代理）。凭证**永不下发**、
   永不落日志（掩码显示）。
4. **端口与暴露**：本地服务默认绑 **127.0.0.1**，默认端口在 **13680~13699**（worker 专属窄段；
   避开 13610 网关、13620 预留、13670 manager-reports、13731~13739 omni e2e）内随机；
   **数据目录规范路径＝`<workspace>/.agents/workers/<name>/<session>/`，严禁放进任何对外
   静态服务根**（先例：`.agents/reports/manager` 被静态服务公网曝光）——放进去等于把
   `.env`/数据库/账号 token 挂到公网目录列表。
   对外/隧道暴露走主仓 `pnpm tunnel:expose`（HTTP 服务域名免登记 PORT.md）。
   禁止段外新开对外端口。
5. **UI 组件零手写仿制**：组件只从 shadcn/ui 官方 registry 收编（逐字保留 + 文件头注明出处 +
   仅两处机械适配）；视觉语言同源（lucide 单色图标、主题令牌、禁硬编码 hex）。
   实时性＝秒级贯通（SSE/长连接为主，轮询只作兜底）。
6. **仓库结构**：`apps/<name>/{core,server,cli,ui,worker}` + `packages/shared`；
   跨 worker 的公共件进 `packages/shared`，禁止各 worker 复刻第二份。
7. **发布纪律**：CI/CD 就绪前**不发 npm**、不手工发布；本地一律 `bun` 直跑 TS 源。
   CI 就绪后一切可编译发布物走 CI（主仓发布纪律）。

## 原则：产品宇宙与文档唯一信源

产品名/层级/`agent_kind` 对表主仓 `.agents/docs/PRODUCT-UNIVERSE.md`；商业口径对表
`BUSINESS-MODEL.md`；端口与拓扑对表 `.agents/docs/PORT.md`；报告落位对表
`.agents/docs/E2E-REPORTS.md`。**禁止凭记忆另起名词**。

## 原则：主仓协作纪律

- 本仓是主仓 submodule（`fde2e-workers-v0`）：本仓内容变更**先在本仓提交推送**，再回主仓更新
  指针（`git submodule update` 前先确认本仓 HEAD＝main 且已推送）。
- 本仓工作一律**挂 branch main**（防游离提交清洗）；动工前确认主仓指针已指向本仓当前 HEAD。
- 非平凡任务先开 worktree（主仓 `.worktrees/`）；收口提交用显式路径 add，禁 `-A`。

## 原则：HermesAgent＝脚手架纪律（如涉）

若 worker 需接入 HermesAgent 系产品（omni/console/BU 等）：走扩展点阶梯
（配置→技能→插件→hook→装配→展示层），**禁深耦合 hermes 内部实现**；
先对表主仓 `.agents/skills/hermes-agent-dev`。

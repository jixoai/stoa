# Stoa 项目指令

> 本文件是本仓（**Stoa**——中立开源的人机公示板底座）的项目级指令，补充（不覆盖）
> `~/.agents/AGENTS.md` 与 `~/.zcode/AGENTS.md`。
> 渊源：本仓原为 FDE2E 的 `fde2e-workers`（report worker，worker 系列成员），已按
> Owner 2026-11-09 裁决**毕业独立**为中立开源项目 Stoa（change `stoa-identity`）。
> FDE2E 是商业化 AI 员工公司；本仓不隶属其品牌，只通过插件适配器对接各种 harness。

## 原则：一切任务用 OpenSpec 履行

Owner 发的任何任务/需求，都必须以 openspec change 履行：先建 change（proposal + design +
tasks + specs 增量），再实现，再按 change 验收。不允许「直接改代码不留规格轨迹」。
change 全部任务完成且验证通过后立即归档；停滞超 3 天主动确认去向。

## 原则：工程宪法（违反＝返工）

1. **命名法（Stoa 自有）**：产品名 `Stoa`（中文点睛「议事廊」，UI 概念仍可叫公示板）；
   npm 包与 CLI 主名 `stoa`；MCP 面独立入口 `stoa-mcp`（Node 运行时，不依赖 bun/CLI）；
   旧二进制名 `fde2e-report-worker` 已退役（v0.1.2 起）。
   环境变量前缀：`STOA_*` 为**首选**，`FDE2E_REPORT_*` 为**兼容回退**（双读；迁移期策略，
   新增键一律用 `STOA_*`）。领域（域名/组织）由部署方自持，不绑 fde2e。
2. **双端形态（不是双仓）**：本仓是 **Stoa 一个产品**，同时提供 ①**本地后端**（CLI：本地服务 +
   数据目录 + 长连接）与 ②**纯静态前端**（同一份构建产物，`?ep=` 指向任一后端，壳内无任何
   后端地址硬编码）。禁止为"线上版"维护第二套 UI 或第二个仓。**线上部署与任何其它产品无关**：
   壳零数据、可直接托管到静态域名；认证由**各自的后端**负责（`STOA_AUTH` 二值开关 + live-read
   refresh token），不依赖任何外部平台。
3. **认证通则**：`STOA_AUTH`（优先；旧 `FDE2E_REPORT_AUTH` 兼容）——**有值＝认证开，
   无值＝开放**；值**每次请求现读**（live-read，至多 1s 缓存），改值即刻使全部已发 token 失效。
   子账号/机器凭据用 `STOA_TOKEN_<ACCOUNT>`（旧 `FDE2E_REPORT_TOKEN_<ACCOUNT>` 兼容），
   **每账号一个独立 `accounts/<account>.env`（0600）**，禁止把全部账号凭据合并进同一个 `.env`
   （等同把管理权交给每个子代理）。新生成文件**同时写一行旧键别名**（ZCode 适配器兼容桥；
   `stoa-adapters` 迁出后可删）。凭证**永不下发**、永不落日志（掩码显示）。
4. **端口与暴露**：本地服务默认绑 **127.0.0.1**；端口按部署方规划。**我方实例**沿用
   13680~13699 窄段（避开 13610 网关、13620 预留、13670 manager-reports、13731~13739 omni e2e），
   对外走主仓 `pnpm tunnel:expose`（HTTP 服务域名免登记 PORT.md），禁止段外新开对外端口。
   **数据目录规范路径**（我方）：`<workspace>/.agents/workers/<name>/<session>/`，**严禁放进任何
   对外静态服务根**（先例：`.agents/reports/manager` 被静态服务公网曝光）——放进去等于把
   `.env`/数据库/账号 token 挂到公网目录列表；自托管用户用 `--data-dir` 自行指定。
5. **UI 组件零手写仿制**：组件只从 shadcn/ui 官方 registry 收编（逐字保留 + 文件头注明出处 +
   仅两处机械适配）；主题与材质用 **solid-glass**；视觉语言同源（lucide 单色图标、主题令牌、
   禁硬编码 hex）。实时性＝秒级贯通（SSE/长连接为主，轮询只作兜底）。
6. **仓库结构（单仓单产品）**：`src/{core,server,cli,ui}` ＋ `scripts/`；跨端的公共件放
   `src/core`，禁止为同一能力写两份实现。
7. **发布纪律**：CI/CD 就绪前**不发 npm**、不手工发布；本地一律 `bun` 直跑 TS 源。
   CI 就绪后一切可编译发布物走 CI。

## 原则：开源边界与我方实例

- 本仓是**中立开源项目**：README/文档/许可证面向公众（LICENSE=Apache-2.0）；
  产品名、品牌、命名法只属 Stoa。
- **FDE2E 相关文档不属于开源交付面**：主仓 `.agents/docs/`（PRODUCT-UNIVERSE /
  BUSINESS-MODEL / PORT.md / E2E-REPORTS.md）仅作**我方运营实例**（report.worker.fde2e.com +
  本机 13689）的内部参考——"Stoa 的第一个部署"。
- 报告落位与索引（E2E 报告入主仓 `.agents/reports/`）是我方运营约定，不是本仓的对外规范。

## 原则：主仓协作纪律（我方实例）

- 本仓**已独立**（不再是主仓 submodule；历史上 `task/report-worker-v0` 指针分支保留存档）。
- 我方实例的运营仍与主仓协作：静态壳部署到服务器 `www/worker/report/`、alpha 用
  `deploy/scripts/alpha-upload.sh report <dist>`、报告与索引回主仓。开源使用方**不依赖**主仓。
- 本仓内容变更先在本仓提交推送；涉及我方实例上线（壳/后端）时按主仓发布纪律执行。
- 非平凡任务先开 worktree（主仓 `.worktrees/`）；收口提交用显式路径 add，禁 `-A`。

## 原则：HermesAgent＝脚手架纪律（如涉）

若接入 HermesAgent 系产品（omni/console/BU 等）：走扩展点阶梯
（配置→技能→插件→hook→装配→展示层），**禁深耦合 hermes 内部实现**；
先对表主仓 `.agents/skills/hermes-agent-dev`。

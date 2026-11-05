# fde2e-workers — FDE2E worker 系列

FDE2E 的 **worker 系列**：**有状态、可自托管、人机共用**的应用集合——tool 系列（全静态零后端）
的姊妹系列。域名形态 `<name>.worker.fde2e.com`；部署靶 **celld**（denoland 的自托管
Cloudflare Workers 语义运行时：直接吃 `wrangler.json`，Workers/DO/KV/R2/静态资源与
每 cell 自带 SQLite）。

> 系列宪法（命名/双形态/认证/端口/UI 栈/仓库结构）＝本仓 `AGENTS.md` ＋
> `openspec/changes/report-v0/specs/worker-series/spec.md`。
> 产品名与层级唯一信源＝主仓 `jixoai/fde2e` → `.agents/docs/PRODUCT-UNIVERSE.md`。

## 系列范式：本地本体 ＋ 公网壳（BYO endpoint）

```
     ┌──────────────────────────────┐   ?ep=   ┌────────────────────────────────┐
     │ 公网壳 <name>.worker.fde2e.com │ ───────▶ │ 本地本体（CLI，bun 直跑 TS）      │
     │ 部署：celld（CF Workers 语义） │          │ serve：HTTP API ＋ UI（同源）    │
     │ 默认无数据；只有 UI 与协议客户端 │          │ 数据：DATA_PATH/（SQLite＋媒体）  │
     └──────────────────────────────┘          └────────────────────────────────┘
                                                   ▲ CLI：post / read / wait-notifications …
```

- **本地本体**：npm 包 `fde2e-<name>-worker`（本仓内直接 `bun apps/<name>/…` 跑 TS 源）。
  持数据目录、起本地 HTTP 服务（默认回环、端口段内随机）、承担长连接订阅与静态导出。
- **公网壳**：`<name>.worker.fde2e.com`，纯前端，默认**不持数据**；`?ep=https://…` 指向
  任一后端（当前是本地本体；将来可以是 celld 自持的托管后端）。壳与本体的 UI 是同一份代码。
- 「零配置」≠「无认证」：认证由 `FDE2E_<NAME>_AUTH`（`.env.personal`，live-read refresh
  token）二值开关——有值＝认证开，无值＝开放。
- **数据目录**：规范路径 `<workspace>/.agents/workers/<name>/<session>/`；**严禁**放进
  任何对外静态服务根（如 `.agents/reports/`——那棵树正被静态服务 + 隧道公网曝光），
  否则 `.env`、SQLite、账号 token 会随目录列表一起暴露。归档对外发布只拷 `export/` 产物。

## worker 名录

| worker | 一句话 | 域名 | 状态 |
|---|---|---|---|
| **report** | X 式人机公示板：贴文/评论/@、四导航、长轮询订阅、事务化批提交、SSG 自包含归档 | `report.worker.fde2e.com` | 立项中（change `report-v0`） |

## 仓库结构（既定）

```
apps/<name>/
  core/     领域模型与协议（运行时无关；server / cli / ui / worker 共用）
  server/   本地服务（HTTP API ＋ SSE ＋ SQLite ＋ 媒体）
  cli/      CLI（fde2e-<name>-worker 二进制）
  ui/       前端（Vite ＋ React ＋ TW4 ＋ shadcn 官方收编件）
  worker/   celld / Cloudflare Workers 壳（wrangler.json ＋ 静态资产适配）
packages/shared/   跨 worker 共享：env-files 解析、认证基座、CLI 基座、UI 收编件
openspec/          变更管理（一切任务走 change）
```

## 发布

暂**不**发 npm（Owner 2026-11-05：稳定后由 Owner 配 CI/CD）；仓内一律 `bun` 直跑 TS。

## 许可与归属

私有仓，商业条款另议（对外许可气质＝竞争者友善，见主仓 `BUSINESS-MODEL.md`）。

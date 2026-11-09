# Proposal: stoa-release（开源就绪 ＋ npm 可信发布）

## Why

Owner 2026-11-10：**Stoa 要开源**，并已在 npm 侧为 `@jixoai/stoa` 配置了 **OIDC trusted
publishing**（仓库 `jixoai/stoa`、工作流 `release.yml` / 作业 `npm-publish`）。当前仓库仍是
PRIVATE；`package.json` 名为 `stoa`、`private: true`，无 repository/engines/files/publishConfig；
没有 `.github/workflows/`；README 仍写「暂不发 npm」，且保留了面向单一内部部署的叙述。
另一条时间线（FDE2E 对接）需要以 **npm 包形态**消费 Stoa（CI/脚本可 `bunx @jixoai/stoa`），
先发布才能解锁 dsh 运行态实测（Owner：发布 npm 后自测 dsh 适配器）。

## What Changes

- **包元数据**：`name` → `@jixoai/stoa`；`private: false`；补 `repository`/`homepage`/`bugs`/
  `keywords`/`engines`（bun）`/files`/`publishConfig.access=public`；`prepack` 构建 `dist/`
  （npm 用户 `stoa serve` 开箱即用同源 UI）。`bin` 保持 `stoa`，旧名 `fde2e-report-worker`
  继续作为兼容别名（README 标注 deprecated）。
- **CI 可信发布**：新增 `.github/workflows/release.yml`，作业 **`npm-publish`**：`v*` tag 触发 →
  `bun install --frozen-lockfile` → 绿门（test / check / typecheck / build）→
  `npm publish --provenance --access public`（OIDC，无任何 `NPM_TOKEN`）。
- **开源资产**：`CONTRIBUTING.md`（贡献与测试门）、`SECURITY.md`（漏洞报告渠道＝GitHub
  Security Advisories，不公开 issue）；README 开源化（npm 安装形态、适配器矩阵指向
  `adapters/README.md`、发布流程、移除单一内部部署叙述）。
- **仓库转公开**：先做密钥扫描（工作树＋历史；已核：仅 `.env.example` 模板、无真实值），
  再 `gh repo edit jixoai/stoa --visibility public`。
- **发布后验证**：`npm view @jixoai/stoa` / `bunx @jixoai/stoa --version` / `stoa mcp`
  stdio 握手；随后按 Owner 指令安装 dsh 并做**运行态 smoke**（创造模式配置组合包挂
  `@jixoai/stoa mcp`，工具目录＋`board_status` 真调用），结果回填
  `adapters/deepseekharness/README.md`（「登记后续」→「已实测」）。

## Impact

- 包名变化（`stoa` → `@jixoai/stoa`）：只影响 npm 分发；仓内一律 `bun` 直跑，CLI 命令名不变。
- 新增 CI 工作流与发布任务；无运行时协议/数据变更。
- 仓库 PUBLIC 后历史公开（含早期 FDE2E 命名提交）——已由 Owner 决策接受。

## Out of Scope

- 域名 / 组织名 / 版本节奏（Owner 决策）；GitHub Marketplace / 插件市场分发；
  FDE2E 侧接入（独立 change，CLI 模式）。

# Design: stoa-release

## §1 包形态（bun 运行时 TS 包）

- `name: @jixoai/stoa`，`version: 0.1.0`（首发），`license: Apache-2.0`。
- `bin`: `stoa` → `src/cli/main.ts`（文件头 `#!/usr/bin/env bun`）；`fde2e-report-worker`
  保留为兼容别名（README 标注 deprecated，≥1 minor 周期）。
- `files` 白名单：`src/`、`adapters/`、`dist/`、`README.md`、`LICENSE`、`CONTRIBUTING.md`、
  `SECURITY.md`。`dist/` 由 `prepack` 构建（`bun run build`），npm 用户 `stoa serve` 开箱即用
  同源 UI；`adapters/` 随包分发，插件启动器的相对解析在 `node_modules/@jixoai/stoa` 内同样成立。
- `engines: { "bun": ">=1.4.0" }`（运行时依赖 bun；README 明示）。`publishConfig.access: public`。

## §2 CI 可信发布（`.github/workflows/release.yml`，作业 `npm-publish`）

- 触发：`push: tags: ["v*"]`（打 tag 即发布；避免与 `release: published` 双触发重复发布）。
- 权限：`contents: read` + **`id-token: write`**（OIDC）；**不配置任何 npm token secret**。
- 步骤：checkout → `oven-sh/setup-bun`（1.4.4）→ `actions/setup-node`（node 24，
  `registry-url=https://registry.npmjs.org`）→ `npm install -g npm@latest`（OIDC 发布需要
  npm ≥ 11.5.1）→ `bun install --frozen-lockfile` → 绿门 `bun test` / `bun run check` /
  `bun run typecheck` / `bun run build` → `npm publish --provenance --access public`。
- 并发：`group: npm-release-${{ github.ref }}`，不取消在飞发布。
- 失败语义：任一绿门失败即不发布（fail-closed）；同版本号重复发布由 npm registry 拒绝（预期）。

## §3 开源清单与仓库转公开

- 资产：`CONTRIBUTING.md`（如何跑测试/提 PR/变更纪律）、`SECURITY.md`（GitHub Security
  Advisories 私密报告，禁止公开 issue 贴漏洞细节）、README 开源化。
- 转公开前**密钥扫描**（证据入报告）：`git ls-files` 可疑文件名枚举（仅 `.env.example`）；
  `git grep` 高熵模式（`sk-*`/`ghp_*`/`AKIA*`/长 Bearer）0 命中；`git log --all -p` 同模式 0 命中。
- 转公开命令：`gh repo edit jixoai/stoa --visibility public --accept-visibility-change-consequences`。
- 历史含早期内部命名提交，Owner 已决策接受；不再重写历史。

## §4 发布后验证（本 change 内闭环）

1. `npm view @jixoai/stoa version dist-tags` ＋ `bunx @jixoai/stoa --version`；
2. `printf initialize/tools/list | bunx @jixoai/stoa mcp` 握手（8 工具）；
3. **dsh 运行态 smoke**（Owner 指令）：按 dsh 文档安装/检出 deepseek-harness，创造模式
   Plugin Manager 安装 MCP 配置组合包（`serverName: stoa`、`transport: stdio`、
   `command: bunx`、`args: ["@jixoai/stoa","mcp"]`），断言模型工具目录出现
   `mcp__stoa__board_*` 且 `board_status` 真调用返回 ok（隔离后端）；将结果（含版本、dsh
   commit、命令与输出摘录）回填 `adapters/deepseekharness/README.md`。
4. 兼容别名 `fde2e-report-worker` 在包内可用（`bunx --package @jixoai/stoa fde2e-report-worker --version`）。

## §5 风险

- npm 侧 OIDC 配置的 workflow 文件名必须为 `release.yml`（本 change 固定该名）；若 npm 侧还
  配置了受保护 environment，首次发布报错将直接暴露，按报错补 `environment:` 声明。
- `prepack` 依赖 devDependencies（vite 等）：CI 发布前 `bun install` 含 devDeps；npm 用户
  装包不再需要构建（dist 已随包）。
- 转公开为不可逆可见性操作；已先完成密钥扫描并留证。

# Tasks: stoa-release

> 判据不满足不得勾选。发布类动作失败即如实登记，不以「配置已写」代替「发布成功」。

## R1. 包与 CI

- [x] R1-1. 建立 change（proposal/design/tasks/spec delta）；`npx openspec validate stoa-release --strict` 通过。
- [x] R1-2. `package.json`：`@jixoai/stoa`、`private:false`、repository/homepage/bugs/keywords/
  engines/files/publishConfig；`prepack` 构建 dist；bin 别名保留。
  - 判据：`npm pack --dry-run` 内容符合 files 白名单（含 src/adapters/dist/README/LICENSE）。
- [x] R1-3. `.github/workflows/release.yml`（作业 `npm-publish`，OIDC `id-token: write`，无 token；
  tag `v*` 触发；绿门后 `npm publish --provenance --access public`）。
  - 判据：YAML 语法与权限自查（无 secrets 引用）；本地 `bun run build` 等绿门可复现。
- [x] R1-4. 开源资产：`CONTRIBUTING.md`、`SECURITY.md`、README 开源化（npm 安装、适配器矩阵、
  发布流程、移除单一内部部署叙述）。
- [x] R1-5. 绿门：`bun test`、`check`、`typecheck`、`typecheck:ui`、`build`、`openspec validate
  stoa-release --strict`；`npm pack --dry-run` 检查包内容（无 .env/无 node_modules/无测试数据）。

## R2. 转公开与发布

- [x] R2-1. 密钥扫描留证（工作树＋历史；可疑文件名/高熵模式/长 Bearer 全 0 命中）。
- [x] R2-2. 仓库转公开（`gh repo edit … --visibility public`），`gh repo view` 复核 PUBLIC。
- [x] R2-3. 打 tag `v0.1.0` 并推送（触发 release.yml）；跟进 Actions 结果直到 `npm-publish` 成功。
  - 判据：`npm view @jixoai/stoa version` = 0.1.0；provenance 可在 npm 页面核对；无 token 使用。
- [x] R2-4. 发布物验证：`bunx @jixoai/stoa --version`；stdio 握手（8 工具）；兼容别名可用。
- [x] R2-5. **dsh 运行态 smoke**（Owner 指令）：安装/检出 deepseek-harness，创造模式挂
  `@jixoai/stoa mcp`（stdio），工具目录 `mcp__stoa__board_*`＋`board_status` 真调用 ok（隔离后端）；
  结果回填 `adapters/deepseekharness/README.md`（登记项转「已实测」，含版本/命令/输出摘录）。
- [ ] R2-6. 报告（HTML）＋索引行；归档 change；推送；回板。

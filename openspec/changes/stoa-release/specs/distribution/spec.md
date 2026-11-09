# distribution（delta）

## ADDED Requirements

### Requirement: npm 可信发布

Stoa SHALL 以 `@jixoai/stoa` 名称发布到 npm，且发布 SHALL 仅经由仓库内
`.github/workflows/release.yml` 的 `npm-publish` 作业、以 **OIDC trusted publishing** 完成
（工作流声明 `id-token: write`，不得使用任何长期 npm token）。发布前 SHALL 通过绿门
（`bun test` / `check` / `typecheck` / `build`），发布产物 SHALL 带 provenance 且包内容
符合 `files` 白名单（含 `src/`、`adapters/`、`dist/`、README、LICENSE）。

#### Scenario: 打 tag 即发布

- **WHEN** 向 `v*` tag 推送一次发布
- **THEN** `npm-publish` 作业运行绿门后执行 `npm publish --provenance --access public`，
  且 registry 上 `@jixoai/stoa` 的版本与 tag 一致

#### Scenario: 无 token 泄露面

- **WHEN** 审阅 `release.yml`
- **THEN** 文件中不存在 `NPM_TOKEN`/`NODE_AUTH_TOKEN` 等长期凭据引用；权限仅
  `contents: read` 与 `id-token: write`

### Requirement: 开源就绪

仓库 SHALL 以 Apache-2.0 许可公开，并 SHALL 提供 `CONTRIBUTING.md` 与 `SECURITY.md`
（漏洞走私密渠道，不鼓励公开 issue）；README SHALL 覆盖 npm 安装形态与适配器矩阵入口。
仓库转公开前 SHALL 完成密钥扫描（工作树与历史均无真实凭据）。

#### Scenario: 转公开前置检查

- **WHEN** 将仓库可见性改为 public 前执行密钥扫描
- **THEN** `git grep` 高熵模式与 `git log --all -p` 扫描均 0 命中（仅模板文件如 `.env.example` 允许存在）

#### Scenario: 包内容不含敏感物

- **WHEN** `npm pack --dry-run`
- **THEN** 包内不含 `.env*` 实值文件、数据目录、测试临时物

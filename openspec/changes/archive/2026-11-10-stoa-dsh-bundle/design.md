# Design: stoa-dsh-bundle

## §1 组合包形态（官方模板对齐）

dsh 的 bundle 契约（`packages/preset/agent-preset/skills/cordis-plugin-development/references/mcp-bundle.md`
与 `templates/mcp/package.json`，dsh `0.2.2-rc.1`）：

- manifest：`dsh.bundle.patch` 指向 Loader YAML patch；配置型组合包不需要 Host/Client 入口文件、
  不需要依赖（被插入的 `@deepseek-ai/dsh-mcp-client` 由 dsh 安装提供）。
- patch：`[{ insert: [{ id, name: '@deepseek-ai/dsh-mcp-client', config: { serverName, transport, … } }] }]`。

本包在根目录增加 `cordis.patch.yml`：

```yaml
- insert:
    - id: stoa-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: stoa
        transport: stdio
        command: bunx
        args: ['@jixoai/stoa', 'mcp']
        failOnStartupError: true
        env:
          STOA_BASE_URL: !!js process.env.STOA_BASE_URL ?? 'http://127.0.0.1:13689'
          STOA_TOKEN: !!js process.env.STOA_TOKEN ?? ''
```

- `bunx` 走 npm 发布版（与包自身同源）；`STOA_*` 用 `!!js` 从宿主环境引用——dsh 会清洗
  ambient `*TOKEN*`，只有 `config.env` 中的显式值会被合并（官方 README 的凭据纪律）。
- `failOnStartupError: true`：MCP 子进程起不来时剖面启动即失败（大声失败，便于诊断）。

## §2 manifest 与发布

- `package.json`：`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；`exports` 加
  `"./cordis.patch.yml": "./cordis.patch.yml"`；`files` 加 `cordis.patch.yml`；
  `version` → `0.1.1`（0.1.0 已发布不可改写）。
- 发布：tag `v0.1.1` → `release.yml`/`npm-publish`（OIDC，与 0.1.0 相同流程）。
- `npm pack --dry-run` 必须包含 `cordis.patch.yml`；`dsh` 侧 `inspect('@jixoai/stoa')` 的
  `hasBundle` 应为 true。

## §3 验收（本人执行，真实安装路径）

在 dsh 检出（`0.2.2-rc.1`）内写一个 e2e（vitest，`pnpm run test:e2e`）：

1. 临时 `DSH_HOME`＋profile：`initProfile` + core bundle（`cordis:manager`＋`@deepseek-ai/dsh-tools`＋HMR）。
2. `new PluginManager(...)`（真实 pnpm）→ `installBundle('@jixoai/stoa@0.1.1')`：
   断言 `application: 'applied'`、`changed: true`、`bundle.name/version` 正确；
   断言 profile 依赖与 patch 行（`stoa-mcp`）落地。
3. HMR 应用后：`ctx.tools.get('mcp__stoa__board_status')` 出现（等连接就绪）；
   `executeToolFixture` 真调用 `board_status` → `ok:true`（对隔离 stoa 板）；
   再真调用 `board_post`/`board_read` roundtrip。
4. `removeBundle('@jixoai/stoa')` → 行与工具全部释放。
5. 记录：dsh commit/版本、pnpm、安装日志、断言输出；token 只以布尔/hash 形式出现。

## §4 风险

- 注册表安装会拉取本包全部运行时依赖（UI 栈），首次安装较慢；可接受（CLI 用法同样需要）。
- `bunx` 首次运行需下载包（网络）；`STOA_TOKEN` 为空时 MCP 仍可启动（开放模式/无未读），
  鉴权失败会以 `isError` 文本暴露，不阻塞剖面启动（`failOnStartupError` 只关 MCP 连接本身）。
- 组合包对 dsh 版本敏感：patch 形状对齐 `0.2.2-rc.1` 官方模板与 `mcp-client` 配置 schema；
  上游变更时随适配器文档一起复核。

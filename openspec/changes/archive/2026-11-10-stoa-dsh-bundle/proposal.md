# Proposal: stoa-dsh-bundle（作为 dsh 组合包可直接安装）

## Why

Owner 实测安装 `@jixoai/stoa` 为 dsh 插件时报错：**`@jixoai/stoa declares no dsh.bundle`**。
dsh 的组合包（bundle）契约要求 npm 包在 `package.json` 声明
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 并提供 Loader YAML patch；
我们此前只交付了文档层面的「创造模式安装」说明，没有让包本身可被 `plugin_manager install_bundle`
接受（stoa-release 中该项被登记为未覆盖，属交付缺口）。

## What Changes

- `package.json` 增加 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`、`exports` 与
  `files` 纳入 `cordis.patch.yml`；版本 `0.1.0` → **`0.1.1`**（发布新版本，0.1.0 不可改写）。
- 新增 `cordis.patch.yml`（纯配置组合包，官方模板形状）：`insert` 一个
  `@deepseek-ai/dsh-mcp-client` 行（`serverName: stoa`、`transport: stdio`、
  `command: bunx`、`args: ['@jixoai/stoa', 'mcp']`、`failOnStartupError: true`），
  凭据用 Loader `!!js process.env.STOA_*` 引用（不把明文写进包）。
- README 增加「安装到 DeepSeekHarness（dsh）」一节：`plugin_manager install_bundle
  @jixoai/stoa`（或 Web 插件页安装）→ 验证 `mcp__stoa__board_status`；把适配器文档从
  「手写 YAML」升级为「包内组合包直达」。
- 发布 `v0.1.1`（OIDC 流程不变）；发布后用**真实安装路径**验收：
  `PluginManager.installBundle('@jixoai/stoa@0.1.1')`（dsh 0.2.2-rc.1）→ `application: applied`
  → 组合包行激活 → `mcp__stoa__board_*` 进入工具面 → `board_status` 真调用 → `remove_bundle`
  释放。**由我本人执行，不委派。**

## Impact

- npm 包新增一个 YAML 与 manifest 字段；CLI/MCP/协议零变化。
- dsh 用户可直接把包当组合包安装；手写 YAML 路径保留为备选。

## Out of Scope

- dsh 官方目录（OPTIONAL_BUNDLES / on-demand catalog）收录；UI 图标/本地化展示资源
  （配置型组合包的最小集先落地，展示清单留待收录时补）。

# distribution（delta）

## ADDED Requirements

### Requirement: 作为 dsh 组合包可直接安装

`@jixoai/stoa` 的 npm 包 SHALL 声明 dsh 组合包契约
（`package.json` 的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`，且该文件随包分发），
使 dsh 的 `plugin_manager` 能以 `install_bundle @jixoai/stoa`（或 Web 插件页）安装它；
安装后 SHALL 在当前 profile 插入 `@deepseek-ai/dsh-mcp-client` 一行（stdio，`serverName: stoa`），
工具以 `mcp__stoa__board_*` 进入模型请求面，`remove_bundle` 后 SHALL 全部释放。

#### Scenario: inspect 识别为组合包

- **WHEN** 对已发布的 `@jixoai/stoa@0.1.1` 执行 dsh 的 `inspect`
- **THEN** 结果声明其组合包身份（`hasBundle`/等价字段为真），而非 `not-a-bundle`

#### Scenario: 安装并真调用

- **WHEN** 在 dsh profile 中 `install_bundle @jixoai/stoa`
- **THEN** 返回 `application: applied`，`stoa-mcp` 行激活，`mcp__stoa__board_status` 可被调用并返回 ok

#### Scenario: 卸载释放

- **WHEN** `remove_bundle @jixoai/stoa`
- **THEN** `stoa-mcp` 行被移除，`mcp__stoa__*` 工具全部注销，MCP 子进程退出

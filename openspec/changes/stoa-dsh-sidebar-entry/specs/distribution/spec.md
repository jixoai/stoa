# distribution（delta）

## ADDED Requirements

### Requirement: dsh UI 插件面：左栏入口与右栏控制台

`@jixoai/stoa` SHALL 声明 dsh Client 插件面（`package.json` 的 `dsh.client` 与
`exports["./client"]`），在 `sidebar.panellist` 注册本地化左栏条目并在布局 `main` keyed slot
注册同一 id 的面板；条目激活时 SHALL 在右栏内置浏览器
（`ctx.sidebarRight.openTab("browser", { params: { url } })`）打开 daemon 控制台；
右栏不可用或 daemon 不可达时 SHALL 给出显式提示与回退，不得静默失败。该 UI 面与
`stoa-mcp` 行同处一个 `cordis.patch.yml`，启用组合包一次同时得到工具与入口。

#### Scenario: 左栏出现入口

- **WHEN** dsh profile 的 `dsh.profile.bundles` 含 `@jixoai/stoa` 并重载 dsh
- **THEN** 左侧栏出现带单色柱廊图标的「Stoa Daemon 控制台」条目；中文环境为中文文案、
  英文环境为英文文案（`ctx.locale.register` 注册 zh/en 词典），且 `mcp__stoa__*` 工具同时可用

#### Scenario: 点击在右栏打开控制台

- **WHEN** Stoa daemon 在 `http://127.0.0.1:13679`（或文档端口带 13670–13679 内最高可达端口）
  可达，且当前有在屏会话，用户点击该条目
- **THEN** 插件先返回会话（`ctx.layout.selectPanel(null)`）以恢复 `sidebarRight.mounted`，
  随后调用 `openTab("browser", { params: { url } })` 在右栏内置浏览器新建 tab 打开控制台

#### Scenario: daemon 不可达时明确提示

- **WHEN** 端口带内没有任何 daemon 响应，用户点击该条目
- **THEN** 主区面板显示不可达提示（含探测 URL 与启动 `stoa daemon` 的提示），
  并提供「重新检测」「在浏览器中打开」「返回会话」动作，不发生静默失败

#### Scenario: 右栏浏览器不可用时回退

- **WHEN** `ctx.sidebarRight` 缺失、等待在屏会话超时，或 `browser` 类型未注册
  （如 Web profile 默认禁用内置浏览器）
- **THEN** 面板显示失败原因，并提供「在浏览器中打开」按钮以 `window.open` 打开同一 URL；
  插件不自动循环重试

#### Scenario: 发布包内容齐备

- **WHEN** 执行 `npm pack --dry-run`
- **THEN** 包内包含 `index.js`、`client.js`、`cordis.patch.yml`、`locale/zh.json`、
  `locale/en.json`、`icon.svg`，且 `exports` 覆盖 `.`、`./client`、`./locale/*.json`、`./icon`

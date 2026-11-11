# Proposal: stoa-dsh-sidebar-entry（dsh 左栏入口 + 右栏内置浏览器打开 daemon 控制台）

## Why

Owner 在 dsh（DeepSeek Harness）里装了 `@jixoai/stoa`，但**左侧栏没有 daemon 控制台入口**。
现场核实后确认这是**两条并列根因**，缺一不可：

### 根因 A：bundle 未启用（依赖 ≠ 激活）

- `~/.dsh/profiles/desktop/package.json:13-15`：`dependencies` 有 `"@jixoai/stoa": "0.3.1"`，
  但 `dsh.profile.bundles`（同文件 `:6-10`）只有 `dsh-base` / `dsh-web-app` /
  `dsh-experimental-agent-team-profile` 三个内置 bundle，**没有 `@jixoai/stoa`**。
- `~/.dsh/profiles/desktop/cordis.patch.yml` 中没有任何 stoa 行（`grep stoa` 零命中），
  且该文件 mtime `2026-11-10 12:21` 早于安装时间（`package.json` mtime `2026-11-11 10:35`）。
- `ps` 中无 `stoa-mcp` 进程（唯一含该字符串的是报告目录名的 `python3 -m http.server`，
  不是 MCP 子进程）→ 我们的 MCP client 行从未被加载。
- dsh 插件管理文档（`/tmp/dsh-pm/...dsh-plugin-manager...README.zh.md`）口径：组合包开关修改
  profile `package.json` 的有序 `dsh.profile.bundles` 列表；安装新组合包默认启用，但**无 HMR 时
  变更需重启才生效**（`restart-required`）。`cordis.yml` 头部亦写明 profile 树 =
  `dsh.profile.bundles` 各 bundle 的 patch → 再叠 `cordis.patch.yml`。
  **结论：只装依赖不进 bundles = 完全不激活。**

### 根因 B：即便启用，MCP-only bundle 也只给工具、不产侧栏 UI

dsh 的 MCP 客户端（`@deepseek-ai/dsh-mcp-client`）只桥接**工具与图片**，不渲染 MCP-Apps UI
资源（其 README「已知限制」明示「图片是唯一的持久丰富结果桥接」）。我们现有的「Daemon 控制台」
入口只存在于 MCP 面板 `ui://stoa/board.html`（`src/mcp/panel.ts:98` 与 `:185-190`），
只有 ZCode 这类支持 MCP-Apps 的宿主会渲染它。dsh 的左侧栏入口必须走 **dsh UI 插件面**
（`dsh.client` + Client 模块），MCP 面无法提供。

## What Changes

- **新增 dsh UI 插件面（Client 半边）**：包根 `client.js` 通过
  `window.__ModuleLoader__.load({ id: '@jixoai/stoa', factory })` 注册 Client 插件：
  - `sidebar.panellist` 左栏条目「Stoa Daemon 控制台」（本地化 zh/en + 单色图标）；
  - 同名 id 的 `main` keyed 面板（侧栏条目按 id 选中主区面板，缺 `main` 注册会抛错）；
  - 面板激活时探测 daemon（默认 `http://127.0.0.1:13679`，失败则探文档端口带
    13670–13679），随后**先返回会话**、待 `ctx.sidebarRight.mounted` 就绪，再调用
    `ctx.sidebarRight.openTab('browser', { params: { url } })` 在右栏内置浏览器打开控制台；
  - daemon 不可达、右栏浏览器不可用时均给出显式卡片与回退动作（`window.open`），不静默失败。
- **host 半边（小）**：包根 `index.js` 导出 `apply()`（与首方 sidebar-browser 的 host 半边同形）。
- **manifest**：`package.json` 增加 `dsh.client`（`platform: "web"`、`immediately: true`、
  `inject: [...]` 按 Phase A 证据）与 `exports`（`.` / `./client` / `./locale/*.json` / `./icon`），
  `files` 收进 `index.js`、`client.js`、`locale/*.json`、`icon.svg`。
- **组合包 patch**：`cordis.patch.yml` **保留** `stoa-mcp`（MCP client）行，追加本包自身 UI 行
  `stoa-daemon-ui`（`name: '@jixoai/stoa'`）——**启用 bundle 一次同时得到工具与侧栏入口**。
- **展示资源**：`locale/zh.json`、`locale/en.json`（`meta.title`/`meta.description`）与单色
  `icon.svg`；Client 运行时文案走 Client locale 服务（`ctx.locale.register`）。
- **安装文档**：README 的 dsh 段落写清「安装后确认 `dsh.profile.bundles` 含 `@jixoai/stoa`
  （或在插件页开启该组合包），无 HMR 时重载 dsh」。
- **版本与元数据**：`package.json` 升到 **0.4.0**（新增 UI 插件面＝minor）；
  `src/mcp/panel.ts` 的 MCP 面板 `appInfo` 版本同步 0.4.0（该字面量是版本唯一硬编码点）。
- **测试**：新增 node 侧结构测试，防止发布丢文件、patch 丢行、client 注册面漂移。

## Impact

- 仅新增 UI 插件面与 manifest/patch 字段；CLI、MCP 工具、HTTP API、数据模型零改动。
- npm 包体积增加约数 KB 静态资源（client.js + locale + icon）。
- 版本 bump 到 0.4.0 与发布由编排方在本 change 收口时执行；不安装进 `~/.dsh` 的用户 profile
  （由编排方/Owner 执行，需重载 dsh）。

## Out of Scope

- 不改 dsh 官方仓库、不发布到 dsh 官方目录。
- 不做 daemon 的远程访问/鉴权；控制台仍是本机 `127.0.0.1` 页面。
- 不在 MCP-Apps 面板内新增入口（现有 `ui://stoa/board.html` 保持不动）。
- 真机 dsh 重载后的视觉/交互验收由 Owner 或编排方执行（见 tasks S6）。

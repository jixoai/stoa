# Design: stoa-dsh-sidebar-entry

## 1. Phase A 契约发现（全部本机可复核）

### 1.1 左栏入口的 slot id 与注册形状

- slot 声明：`@deepseek-ai/dsh-client-ui-sidebar` 在 `sidebar.panel.icon` 工厂下声明
  `children: { 'sidebar.panellist': { kind: 'list', scope: 'root' } }`
  （`/tmp/dsh-src/packages/client/ui-sidebar/src/client/index.ts:90-92`）。
- 真实注册（首方两例，形状一致）：
  - `ui-schedule`：`ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 10, locale: MANAGER_NS,
    label: () => t('panel') }, TaskManagerIcon))`
    （`/tmp/dsh-src/packages/client/ui-schedule/src/client/index.ts:240-246`）。
  - `ui-plugin-manager`：同形，`order: 0`（`.../ui-plugin-manager/src/client/index.ts:167-173`）。
- 条目 props：`PanelIcon` 以 `renderSlot('sidebar.panellist', { size, active }, { only: id })`
  渲染（`.../ui-sidebar/src/client/PanelIcon.tsx:11`），所以图标组件接收 `{ size, active }`；
  `PluginsPanelIcon`/`TaskManagerIcon` 只用 `size`，并注明「sidebar owns the button, label,
  and selected state」（`.../ui-plugin-manager/src/client/PluginsPanelIcon.tsx:1,13`）。
- **关键约束**：条目按 id 选中布局的 `main` keyed slot；**缺 `main` 注册会抛错且不改变选中态**
  （`.../ui-sidebar/README.md:42`）。`main` 声明见
  `.../ui-layout/src/client/index.ts:75`（`'main': { kind: 'keyed', scope: 'root' }`），
  渲染见 `.../ui-layout/src/client/AppFrame.tsx:49`
  （`renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })`）。
  故必须同时注册 `main` 面板（key 与条目 id 相同）。
- 导航 API：`ctx.layout.selectPanel(panelId | null)`；未注册 id 会抛
  `layout.selectPanel: main panel "…" is not registered`
  （`.../ui-layout/src/client/service.ts:36,72-77`）。`panelInfo.getSnapshot().activePanelId`
  可读当前主区面板（同文件 `:21,30`）。

### 1.2 Client locale 注册 API

- 首方用法：`ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }),
  '…: dictionaries')` + `ctx.locale.bind(NS)`
  （`.../ui-sidebar/src/client/index.ts:55-56`；
  `.../ui-plugin-manager/src/client/index.ts:95-96`；
  `.../dsh-client-ui-sidebar-browser/lib/client.js:1720,1773-1782`）。
- 基线语言为 zh/en（`.../client/locale/src/client/index.ts` 的 `BUILT_IN_LOCALE_METADATA`
  只列 zh/en）；本包只提供 zh + en 兜底。
- `Translate` 签名：`(key, params?: Record<string, unknown>) => string`
  （`.../client/ui-slots/src/index.ts:54-55`），文案模板支持 `{name}` 占位。
- 包的 `locale/*.json` 是**宿主展示元信息**（`meta.title`/`meta.description`），
  首方包也只放 meta（如 `.../ui-sidebar/locale/zh.json` 仅 `meta`）；运行时文案在
  Client 模块内注册。本包沿用：`locale/{zh,en}.json` 放 meta，`client.js` 内联词典。

### 1.3 `ctx.sidebarRight.openTab` 的参数形状

- 类型：`openTab<K>(kind: K, options?: SidebarRightOpenTabOptions<K>)`；
  `SidebarRightOpenTabOptions extends SidebarRightPlacement { params?: … }`
  （`.../ui-sidebar-right/src/client/service.ts:198-203,250,390-393`）。
  放置字段为 `paneId` / `preferNewPane` / `replaceTab` / `revealIfOpened`；
  **没有 key/title 参数**，标题由 browser 类型自己提供。
- 首方调用：`ctx.sidebarRight.openTab('browser', { params: { url } })`
  （README 明示：`/tmp/dsh-sidebar/...README.zh.md:43`；实现内同形
  `/tmp/dsh-sb/...client.js:157-160`；`ui-chat/src/client/apply.ts:283`）。
- 失败面：
  - 无在屏会话时 `require()` 抛 `sidebarRight: no session surface is mounted`
    （`service.ts:854-864`）；
  - kind 未注册时 `placeTab` 抛 `sidebarRight: no tab type is registered as "browser"`
    （`service.ts:480-482`）。
- **关键发现（决定实现方式）**：`sidebarRight.mounted` 是「在屏会话」的可观察值，
  **全局主面板占据主列时为 `undefined`**（`.../ui-sidebar-right/README.md:103`；
  `service.ts:226,304-305`）。而左栏条目点击必然先选中我们的全局 `main` 面板，
  所以**在面板内直接 `openTab` 必抛**。实现必须「先返回会话，等 `mounted` 就绪再 openTab」。
- browser 类型由 `@deepseek-ai/dsh-client-ui-sidebar-browser` 注册，`multiple: true`
  （`/tmp/dsh-sb/...client.js:1429-1449`）——每次 open 是新 tab（同 URL 不去重）；
  Web profile 默认禁用、Desktop 默认启用（同包 README「何时选择」段）。

### 1.4 `dsh.client.inject` 该写什么

- manifest 类型：`DshClientManifest { platform, inject?, immediately?, external? }`；
  `inject` 的注释是「Informational package-name dependencies, **not Cordis service
  injection**」（`/tmp/dsh-src/packages/util/package-manifest/src/types.ts:86-99`）。
- 语义：`inject` 是「工厂必须先到达」的包边；缺失的行被忽略，不阻塞
  （`.../client/modules/src/client/manifest.ts:45-52`；
  `.../client/modules/src/client/system.ts:274-279`）。真正的 Cordis 服务注入来自
  Client 模块导出的 `inject` 数组（sidebar-browser：`["slots","locale","sidebarRight",
  "sidebarRightTabs"]`，`/tmp/dsh-sb/...client.js:1711-1716`）。
- 本包 `dsh.client.inject`（按槽/服务归属取证）：
  - `@deepseek-ai/dsh-client-ui-layout` —— 拥有 `main` slot 与 `ctx.layout`；
  - `@deepseek-ai/dsh-client-ui-sidebar` —— 拥有 `sidebar.panellist`；
  - `@deepseek-ai/dsh-client-ui-sidebar-right` —— 提供 `ctx.sidebarRight`；
  - `@deepseek-ai/dsh-client-ui-sidebar-browser` —— 注册 `browser` tab kind；
  - `@deepseek-ai/dsh-client-locale` —— 提供 `ctx.locale`。
- 本包 Client 模块导出 `inject: ['slots', 'locale', 'layout']`；`sidebarRight` 用
  `ctx.get('sidebarRight')` 可选读取（同首方 `ctx.get('productAnalytics')` 的用法），
  使「右栏不可用」时仍能注册入口并走回退，而不是整插件不激活。
- **不需要 `dsh.bundle.entries` 或其它顶层字段**：`DshBundleManifest` 只有
  `platforms` / `patch` / `listedByDefault`（`types.ts:70-76`）；UI 面只靠
  `dsh.client` + `exports["./client"]`（`ui-plugin.md` 与 decoration 模板）。

### 1.5 模块装载与模板

- `window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于包名；`factory(require)`
  从浏览器模块表取 `react`，返回 `{ inject, apply }`
  （`/tmp/dsh-sb/...client.js:1-6,1711-1716`；decoration 模板 `client.js`）。
- 模板形状（`/tmp/dsh-skill/...templates__decoration__*`）：`package.json` 的
  `dsh.client{platform,immediately,inject}` + `exports["./client"]`；`index.js` 导出
  `apply()`；`cordis.patch.yml` 用 `- insert: [{ id, name }]`。
- 多行 `insert` 合法：首方 bundle patch 均为 `- insert:` 下多行
  （如 `/tmp/dsh-src/packages/bundle/sdk-minimal/cordis.patch.yml:6-20`）。

### 1.6 daemon 端口与健康面（本仓证据）

- 默认端口 13679，自动择优带 13670–13679（`src/daemon/state.ts:25-30`）。
- `GET /healthz` 返回 `{ ok, daemon: true, port, url, stateDir, version, … }`
  （`src/daemon/server.ts:631-648`）；CORS 回显请求 Origin
  （`src/daemon/server.ts:598-602`），因此普通 fetch 在多数宿主可读 JSON。
- 控制台 UI 在 `GET /`（`src/daemon/server.ts:15,552-585`）。

## 2. 两条并列根因与启用路径

本 change 同时修正两条根因：

1. **依赖 ≠ 激活**：README 的 dsh 安装段必须写清「确认 `dsh.profile.bundles` 含
   `@jixoai/stoa`（或在插件页开启组合包）；无 HMR 时重载 dsh」。
2. **MCP-only 不产 UI**：新增 Client 插件面（本 change 主体）。

因为 UI 行与 MCP client 行都写在**同一个** `cordis.patch.yml` 的同一个 `insert` 列表里，
「启用 bundle」一次即可同时得到 `stoa-mcp` 工具行与 `stoa-daemon-ui` 侧栏行。

## 3. 入口与打开流程

### 3.1 注册面

| 注册 | slot | 选项 |
|---|---|---|
| 左栏条目 | `sidebar.panellist` | `{ id: 'stoa-daemon', order: 20, locale: 'stoa.daemon', label: () => t('panel.label') }` + 图标组件 |
| 主区面板 | `main`（keyed） | `{ key: 'stoa-daemon', locale: 'stoa.daemon', inject: () => ({ … }) }` + 面板组件 |

两处都用 `ctx.effect(() => ctx.slots.inject(slot, () => ctx.slots.register(…)), label)` 注册，
随插件卸载释放；不替换应用根、不读其它插件 DOM。

### 3.2 daemon URL 解析与可达性探测

1. 并行探测文档端口带 13679→13670（`src/daemon/state.ts:25-30`），按端口从高到低取
   第一个可达者（13679 天然优先）。
2. 每端口两步：普通 `fetch` 读 `/healthz` JSON 且 `daemon === true` → 确认是 daemon；
   失败再 `fetch(..., { mode: 'no-cors' })` 得到 opaque 响应 → 视为可达（未确认身份）；
   两者都失败 → 不可达。
3. 探测只决定**提示与目标 URL**，不阻止用户手动「在浏览器中打开」；混合内容
   （https 宿主 + http 本机）等环境限制会表现为不可达，卡片如实说明。

### 3.3 点击 → 右栏打开（关键时序）

左栏条目点击 → 布局选中 `main` 面板（`stoa-daemon`）→ 面板挂载：

1. 探测 daemon（见 3.2）。
2. 不可达 → 停留面板，显示「未检测到 Stoa daemon + URL + 启动提示」卡片，
   动作：重新检测 / 在浏览器中打开 / 返回会话。
3. 可达 → 调用 `ctx.layout.selectPanel(null)` **返回会话**（恢复 `sidebarRight.mounted`），
   订阅 `ctx.sidebarRight.mounted`，一旦有在屏会话即
   `ctx.sidebarRight.openTab('browser', { params: { url } })`；成功即完成（面板已卸载，
   会话 + 右栏控制台同屏）。
   - 时序细节：`mounted` 在 React 渲染该会话的 seat **之前**发布（ui-sidebar-right
     `src/client/index.ts:167-171` 注释），而 seat 在同一次渲染里才 mint Session store；
     因此首次 `openTab` 可能抛 `no session surface is mounted`。实现把该错误视为瞬态，
     每 40ms 重试直至 1.5s 期限；其它错误（如 browser kind 未注册）立即定性。
4. 1.5s 内无在屏会话，或 `openTab` 抛错（无 sidebarRight 服务 / browser kind 未注册）→
   记录阻塞原因并 `ctx.layout.selectPanel('stoa-daemon')` 回到面板，显示
   「右栏浏览器不可用 + 原因」卡片，动作：在浏览器中打开（直接用户手势，避开弹窗拦截）/
   返回会话。**不自动循环重试**（阻塞态下重挂载只渲染卡片，不再自动打开）。

### 3.4 回退策略

| 场景 | 行为 |
|---|---|
| daemon 不可达 | 面板卡片显式提示（URL、`stoa daemon` 提示、重新检测） |
| 无在屏会话 | 返回会话后 1.5s 超时 → 阻塞卡片，提供浏览器打开 |
| `sidebarRight` 服务缺失 | 阻塞卡片，提供浏览器打开 |
| `browser` kind 未注册（Web 默认禁用） | 阻塞卡片，提供浏览器打开 |
| `window.open` 被拦截 | 无额外机制；按钮是直接用户手势，常规浏览器放行 |

## 4. 组件映射与视觉

- 图标：单色 SVG「柱廊」（pediment + 4 柱 + 基座），`stroke="currentColor"`，
  接 `{ size }`；包图标 `icon.svg` 用中性灰描边（插件页以 `<img>` 渲染，`currentColor` 不可用）。
- 面板：极简状态卡（标题 / 说明 / 动作按钮），只用布局样式与宿主主题令牌
  （`--dsw-alias-border-l2`、`--dsw-radius-sm` 等，取自首方 sidebar-browser 的已发布 CSS），
  不引入第三方 UI 库、不写彩色语言；面板通常在一次点击内卸载，仅失败态可见。
- 文案：`panel.label`、`panel.opening`、`panel.probing`、`panel.down.*`、`panel.blocked.*`、
  `panel.action.*`，zh/en 双语。

## 5. 发布与验证边界

- 版本 bump 到 0.4.0、`src/mcp/panel.ts` 版本同步、npm 发布由编排方在本 change 收口时执行；
  用户 profile 的安装/启用与 dsh 重载由编排方/Owner 执行。
- 可自动验证：`openspec validate --strict`、`bun run check`、`bun run typecheck`、
  `bun test`、`bun run build`；node 结构测试覆盖 client 注册面、patch 双行、manifest 字段。
- 组合验证（编排方本地 tarball，无头）：`loadProfile` 接受本包为 bundle → `composeEntries`
  组合出 `stoa-mcp`＋`stoa-daemon-ui` 双行 → `dsh.client`/客户端产物齐备 → `client.js`
  在装载器 stub 下注册（9/9 PASS）。
- **不可自动验证（登记为未覆盖）**：真实 dsh 重载后的渲染效果（左栏条目外观、右栏 tab 实际
  打开、主题适配、Desktop/Web 差异）。验收口径见 tasks S6，由 Owner/编排方在重载 dsh 后复核。

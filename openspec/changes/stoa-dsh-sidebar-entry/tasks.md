# Tasks: stoa-dsh-sidebar-entry

> 判据不满足不得勾选。本 change 的版本 bump（0.4.0）与 npm 发布在收口时由编排方执行；
> 不安装进用户 `~/.dsh`（编排方/Owner 执行并重载 dsh）。
> 真机验收（S6）由 Owner/编排方执行，未完成前 change 保持未归档。

## S1. 规格与契约取证

- [x] S1-1. 建立 change；`openspec validate stoa-dsh-sidebar-entry --strict` 通过。
  - 判据：proposal/design/tasks/spec delta 齐备，strict 校验零告警。
  - 证据：`openspec validate stoa-dsh-sidebar-entry --strict` → `Change 'stoa-dsh-sidebar-entry' is valid`（exit 0）。
- [x] S1-2. Phase A 四条契约全部落到 `file:line` 证据（design §1）。
  - 判据：左栏 slot 形状、locale API、`openTab` 参数、`dsh.client.inject` 语义均有首方
    源码或官方文档引用；无「凭记忆」结论。
  - 证据：design §1.1–§1.6（ui-sidebar / ui-layout / ui-sidebar-right / ui-sidebar-browser /
    package-manifest / client-modules 的源码行号与模板路径）。

## S2. manifest 与组合包 patch

- [x] S2-1. `package.json` 增加 `dsh.client`（`platform: "web"`、`immediately: true`、
      `inject` 五包）、`exports`（`.` / `./client` / `./locale/*.json` / `./icon` /
      `./package.json`）与 `main`；`files` 收进 `index.js`、`client.js`、`locale/*.json`、
      `icon.svg`；`dsh.bundle.patch` 保持指向 `cordis.patch.yml`。
  - 判据：`npm pack --dry-run`（或等价文件清单断言）包含全部新增运行时文件。
  - 证据：`npm pack --dry-run` 清单含 `client.js`（18.1kB）、`index.js`（273B）、
    `icon.svg`（347B）、`locale/zh.json`（185B）、`locale/en.json`（177B）、
    `cordis.patch.yml`（1.4kB）；total files 213。
- [x] S2-2. `cordis.patch.yml` 保留 `stoa-mcp` 行，并在同一 `insert` 列表追加
      `stoa-daemon-ui`（`name: '@jixoai/stoa'`）。
  - 判据：YAML 可解析；两行同时存在；MCP 行配置零改动。
  - 证据：`test/dsh-client-plugin.test.ts` 的 bundle patch 断言（同一 insert 列表、
    行序、`serverName`/`STOA_BASE_URL` 保留）。

## S3. host/client 实现

- [x] S3-1. 包根 `index.js` 导出 `apply()`（host 半边，空实现）。
  - 证据：`node --input-type=module -e "import('./index.js')"` → `apply: function`。
- [x] S3-2. `client.js` 以 `window.__ModuleLoader__.load({ id: '@jixoai/stoa', factory })`
      注册：locale 词典、`main` 面板、`sidebar.panellist` 条目（本地化 label + 单色图标）。
  - 判据：`factory` 返回 `{ inject, apply }`；`inject` 含 `slots`/`locale`/`layout`；
    所有注册在 `ctx.effect`/`ctx.slots.inject` 内并返回清理。
  - 证据：结构测试断言 load id、`inject` 数组、三条 effect label、两处注册
    （`main` key `stoa-daemon`；`sidebar.panellist` id `stoa-daemon`、order 20、
    label `Stoa Daemon 控制台`、svg 图标 `size/currentColor/aria-hidden`）。
- [x] S3-3. 打开流程：探测 13679 → 端口带 13670–13679 → 返回会话 → 等
      `sidebarRight.mounted` → `openTab('browser', { params: { url } })`；
      失败态卡片 + `window.open` 回退；不静默失败、不自动循环。
  - 判据：代码路径与 design §3 一一对应；无替换应用根/读其它插件 DOM。
  - 证据：结构测试断言 `openTab('browser', { params: { url } })`、`selectPanel(null)`、
    `/healthz`、`mode: 'no-cors'`、`DAEMON_PORT_BAND`、`window.open(url, '_blank',
    'noopener')`，且源码无 `document.body`/`querySelector`。

## S4. 展示资源与安装文档

- [x] S4-1. `locale/zh.json` + `locale/en.json`（`meta.title`/`meta.description`）；
      `icon.svg` 单色柱廊图标（≤256 KiB）。
  - 证据：结构测试断言两份 locale 的 meta 非空；icon 为 svg、含 viewBox/stroke、
    347B < 256KiB。
- [x] S4-2. README dsh 段落补启用步骤：确认 `dsh.profile.bundles` 含 `@jixoai/stoa`
      （或插件页开启），无 HMR 时重载 dsh；说明启用一次同时得到 MCP 工具与侧栏入口。
  - 判据：文案与 dsh 插件管理文档口径一致（bundles 开关 + restart-required）。
  - 证据：README「安装到 DeepSeekHarness（dsh）」段新增 UI 入口说明与「启用确认
    （依赖 ≠ 激活）」两条步骤。

## S5. 测试与绿门

- [x] S5-1. `test/dsh-client-plugin.test.ts`：stub `window.__ModuleLoader__` 载入
      `client.js`，断言 load id、`{inject, apply}` 形状、apply 内注册的 slot 名与条目
      id/label/icon；断言 `cordis.patch.yml` 同时含 MCP 行与 UI 行；断言
      `package.json` 的 `dsh.client`/`exports`/`files` 齐备。
  - 判据：测试在 `bun test` 中稳定通过，且删掉任一新增文件/字段会失败。
  - 证据：12 pass / 0 fail / 106 expect() calls。
- [x] S5-2. 串行绿门并贴回退出码：`bun run check`、`bun run typecheck`、`bun test`、
      `bun run build`、`openspec validate stoa-dsh-sidebar-entry --strict`。
  - 证据：`check` exit 0（api 50 / cli 22 / security 87 files / ui-lint 0）；
    `typecheck` exit 0；`test` 595 pass / 0 fail（59 files）；`build` exit 0；
    `openspec validate --strict` exit 0。
    注：全新 worktree 首次 `bun test` 有 5 个 export 用例失败，根因是 `dist/` 不存在
    （`src/server/export.ts:299-307` 明确要求先 `bun run build`）；构建后全绿。

## S6. 真机验收（Owner/编排方执行，本 change 未覆盖）

- [ ] S6-1. 安装并启用组合包（`dsh.profile.bundles` 含 `@jixoai/stoa`），重载 dsh。
- [ ] S6-2. 左栏出现「Stoa Daemon 控制台」；点击后右栏内置浏览器打开
      `http://127.0.0.1:13679` 控制台，主区回到会话。
- [ ] S6-3. daemon 未启动时点击，面板显示明确不可达提示（非静默失败）。
  - 证据：截图 + 控制台日志摘要（口令/凭据不入截图）。

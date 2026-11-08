# Tasks: report-instance-page（实例管理页 + 回复原帖完整显示）

> 判据不满足不得勾选；QA 一律跑隔离后端/静态壳，禁止写生产板。
> 绿门：`bun test`、`bun run check`、`bun run typecheck:ui`、`bun run build`。

## P1. 实例管理页

- [x] P1-1. `src/ui/lib/ep.ts`：历史条目升级为 `EpHistoryEntry{url,lastUsedAt}`，
  `loadEpHistoryEntries/loadEpHistory/rememberEp/forgetEp/clearEpHistory` 兼容旧
  `string[]`；新增 `probeEpHealth(url, timeoutMs=5000)`（healthz 判定 report 协议、
  错误可读、无敏感内容）。
  - 证据：`test/ep.test.ts` 11/11 通过（旧/新/混合格式、去重/上限、置顶、forget/clear、
    在线/非协议/HTTP/非 JSON/超时/网络错误/非法 ep 不发请求）。

- [x] P1-2. `src/ui/state/connection.tsx`：新增内存 `lastConnection: ConnectionSummary | null`
  （ep/staticMode/authMode/account），`finishReady` 更新；`switchBackend`/`logout`
  不清空；随 context 暴露。
  - 证据：QA A3——真实 qa-serve 连接后点「连接其它实例」，当前连接卡显示地址/在线/
    认证模式/@owner；刷新/首次进入为 null（A2）。

- [x] P1-3. `src/ui/pages/LandingPage.tsx` 重做：品牌 + 一句用途；当前连接卡（在线/静态、
  模式、身份、地址可复制；无值显示「当前未连接」）；添加实例卡（InputGroup + checkEp +
  healthz 预检 + 就地 Alert + Spinner）；我的实例卡（地址/最后使用/在线探测/连接/移除/
  重试/清空 + 官方 Empty）；用法 Collapsible 默认收起。
  - 证据：QA A1/A2/A3/A4/A5/A6/A7/A9；`node scripts/ui-lint.mjs` 0 违规。

- [x] P1-4. 移动端/桌面布局：根容器 `h-dvh overflow-y-auto overscroll-contain`，
  safe-area 上下内边距；390 单列、无横向溢出；可点目标 ≥44px；桌面两列
  （左当前+添加 / 右我的实例+用法）。
  - 证据：QA A8——`docScroll=390=win`、`rootScroll=390=client`、10 个可见按钮
    全部 ≥44×44；A9 两列矩形不重叠。

## P2. 回复原帖完整显示

- [x] P2-1. `ReplyComposer.tsx` 删除 `line-clamp-6`；原帖正文放入
  `max-h-[40dvh] overflow-y-auto overscroll-contain` 容器（`data-testid="reply-context-body"`）；
  外层内容区改为不滚动的 flex 列（单层主滚动）。
  - 证据：QA A10a/A10b/A10c——80 行长帖 `scrollHeight=6228 / clientHeight=338`
    （移动）、`4252/360`（桌面）；`line-clamp=none`；外层 `scrollHeight=clientHeight`
    （795/795、641/641）；滚到底最后一行可见、`composer-input` 在视口内。

## P3. QA 与证据

- [x] P3-1. 新增 `scripts/qa/instance-page.mjs`（Playwright + 静态壳 + mock healthz +
  隔离 qa-serve）：A1-A10；截图与 `results.json`/`steps.json` 落
  `.agents/reports/manager/report-instance-page/`（gitignored）。
  - 证据：`bun scripts/qa/instance-page.mjs` → **22/22 PASS**；12 张 PNG；
    qa-serve launcher/server 已 SIGTERM 退出（exit 0）、Chrome 关闭、静态服务停止；
    长帖硬清除残留 0。

- [x] P3-2. `scripts/qa/README.md` 登记新脚本与端口/隔离说明。

## P4. 绿门与收口

- [x] P4-1. `bun test` 全绿：**362 pass / 0 fail**（40 files，含新增 `test/ep.test.ts`）。
- [x] P4-2. `bun run check` 全绿：tsc + 41 routes + 20 CLI commands + security lint（71 files）
  + ui-lint 0 违规。
- [x] P4-3. `bun run typecheck:ui` 全绿（tsc --noEmit -p src/ui/tsconfig.json）。
- [x] P4-4. `bun run build` 成功（vite 8.3.6，3044 modules）；`ep-input`/`ep-connect`
  testid 保留，既有 QA 引用不回归。
- [x] P4-5. 本 tasks.md 已按实际完成项勾选；未 commit（按子代理纪律交给编排者）。

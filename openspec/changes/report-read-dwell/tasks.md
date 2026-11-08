# Tasks: report-read-dwell（视窗停留已读 + 未读高亮）

> **依赖顺序（硬）：本 change 排在 `report-link-preview` 之后。**
> `report-link-preview` 正在 `PostCard.tsx` 插 `<LinkPreviews>`（`:17,176,267`），与本 change 的
> 根节点改动同文件；它合入前 `src/` 不改，本 change 只交付规格与设计。
> 前置已落地：`report-notification-history-and-reply-submit`（read-set）、`report-event-hub`
> （通知投影/角标）、`report-thread-timeline`（平铺 timeline）。
> 每项判据不满足不得勾选；QA 一律跑隔离后端（`scripts/qa/qa-serve.mjs`），禁止写生产板。

## P1. 核心（观察器 + 计时 + 已读写入 + 高亮）

- [x] P1-1. 纯函数模块 `src/ui/lib/dwell-threshold.ts`：`dwellThresholdMs({bodyMd,hasMedia})`
  （`clamp(codePoints/80*1000 + media*300, 400, 1500)`）、`coverageOf(entry, viewportHeight)`
  （普通卡 `intersectionRatio`；高卡 `intersectionRect.height / rootHeight`，即
  `min(卡片高, 视口高)` 的 50%，Owner 2026-11-08 拍板）。
  - 判据：`test/read-dwell.test.ts` 覆盖 0 字/3 字/100 字/200 字、含媒体/不含媒体、
    高卡 vs 普通卡、`rootBounds=null` 回退；边界值 400/1500 精确命中；
    **高卡（>2 屏）只露 50% 视口高即达标、只露 40% 不达标**。
  - 证据：`bun test test/read-dwell.test.ts` 全绿。

- [x] P1-2. 引擎 `src/ui/state/read-dwell.ts`：`ReadDwellEngine` 单例；懒创建
  `IntersectionObserver`（`root:null`、密集 thresholds）、`observe/unobserve`、
  `idle→visible→dwell→paused→read` 状态机、`visibilitychange` 全暂停/恢复、`hold()/release()`
  引用计数门、卸载丢弃累计、`written` 去重。
  - 判据：假 IO/假时钟单测覆盖：进入→到点→写；中途滚出→暂停→回来续计时；
    hidden 暂停；hold 暂停；同帖两次 observe 只写一次；unobserve 后 timer 清零、
    `entries.size` 归 0；跟踪集合为空时 `observer.disconnect()`。
  - 证据：`bun test test/read-dwell.test.ts`（状态迁移表逐行断言）。

- [x] P1-3. 已读订阅与持久化：`NotificationsValue` 加 `isPostRead(postId,seq)` 与
  `subscribePostRead(postId,cb)`；`markPostRead` 只通知该 id；`ack()`/账号切换 `notifyAll()`；
  持久化改为 250ms trailing debounce + `pagehide`/hidden/卸载 flush（key 不变；上限
  **2000/账号、按最近读取时间 LRU**；体积 <150KB/账号；LRU touch 用独立 ref，不触发订阅）。
  - 判据：单测：标记 A 只触发 A 的订阅者（B 0 次）；`ack` 触发全部；账号切换清空并通知；
    连续 10 次标记在 250ms 内只写 1 次 localStorage；hidden 立即 flush；
    **连续标记 600 条后最早 100 条仍已读（不得复现未读）**；2001 条时只淘汰最久未读的 1 条；
    序列化体积 <150KB/账号；已在集合内的重复标记只 touch LRU、不通知订阅者。
  - 证据：`bun test test/read-dwell.test.ts test/notifications.test.ts`；
    `__reportReadDwell.persists` 在 QA 中可观测。

- [x] P1-4. `PostCard` 接入：根 `article` 挂 ref（普通/自接两个分支），`useEffect` 注册/注销；
  渲染 `data-read`（`usePostReadFlag`）与 `data-selected`；自己的帖/软删/已读在引擎侧 `skipped`。
  - 判据：feed/线程/搜索/收藏/成员页/详情六面均出现 `data-post-id` 且可被同一引擎观察；
    自己的帖与软删帖无 `data-read`、无底色；已读帖首帧即 `data-read="1"`。
  - 证据：Playwright 六面 DOM 断言（`scripts/qa/read-dwell.mjs` 的 surface 用例）。

- [x] P1-5. 高亮与动效：`app.css`（或主题文件）新增 `--read-tint/--read-tint-strong/
  --read-accent` 令牌与属性选择器规则；未读整卡淡底 + 左侧 3px 强调条（x=0..3，不碰
  x=38..40 导轨）；达标 1.2s 背景淡出、强调条 200ms 淡出；`prefers-reduced-motion` 瞬时；
  选中态压过未读底色；CLS=0。
  - 判据：未读卡 computed `background-color` 非透明、`::after` 宽度 3px/left 0（x=0..3）；
    线程页同时读 `[data-testid="thread-rail"]`：left=38/width=2（x=38..40），两矩形不相交
    （A13）；已读后 1.5s 内背景回到透明；reduced-motion 下 `transition-duration` 为 0s；
    高亮前后卡片 `getBoundingClientRect().height` 不变。
  - 证据：截图 before/after（390/1280）+ computed style/矩形断言。

- [x] P1-6. 静态门控：`ReadDwellProvider` 在 `staticMode` 或 `!IntersectionObserver` 时不建引擎；
  静态模式不渲染 `data-read`、不写 localStorage。
  - 判据：`file://` 打开导出归档，3s 内 `__reportReadDwell.enabled===false`、`observers===0`、
    卡片无 `data-read`、`localStorage` 无 `report.read.*` 新写入。
  - 证据：A5 用例 + 导出产物实测。

- [x] P1-7. 删除路由事件标记：移除 `ThreadPage.tsx:589-596` 的 `markPostRead(postId)` effect
  （保留 `useNotifications` 其它用法或按需清理 import）。
  - 判据：后台标签页（`Cmd+Click`/新标签）打开详情、不切回前台 → 该帖仍未读；
    前台打开详情并停留达标 → 已读；`rg "markPostRead\\(postId\\)" src/ui` 无残留。
  - 同步更新既有 QA：`scripts/qa/notifications-read.mjs` ② 的详情等待从 1600ms 提到
    ≥1800ms（或显式等 `data-read="1"`），避免 1500ms 阈值下 100ms 余量抖动；
    ① 点通知行路径语义不变，不改断言。
  - 证据：A3 扩展用例 + 代码检索 + `notifications-read.mjs` 全绿。

- [x] P1-8. QA 脚本 `scripts/qa/read-dwell.mjs`（Playwright + `qa-serve.mjs`）跑
  A1/A2/A3/A5/A7/A8/A13；`scripts/qa/README.md` 登记脚本与端口约定。
  - 判据：全部通过并留存 JSON 结果/截图；不写生产板（`--data-dir` 必须是临时目录）。
  - 证据：`bun scripts/qa/read-dwell.mjs` 输出 `results.json`（含每条断言与耗时）。

## P2. 扩展与细化

- [x] P2-1. 新帖入场高亮：`TimelineFeed` 的 `flashIds` 包装层加 `report-row-new`
  （900ms 背景脉冲 + 既有 `report-row-in` 位移）；仅新到达且未读的帖生效；
  reduced-motion 只保留未读底色。
  - 判据：SSE 推新帖并在顶部吸收 → 新行 900ms 内有背景脉冲，之后回到未读底色；
    reduced-motion 下无动画但仍有未读底色；其它行无变化。
  - 证据：A10 用例 + 两帧截图。

- [x] P2-2. 通知列表/角标同步验收：feed 停留已读后，通知历史行 `data-read` 翻转、
  `notifications-unread-badge`/Nav 角标同步减少；同帖多条通知一次转已读。
  - 判据：A6 用例：两帖 A/B 各 1 条未读，停留 A → 角标 −1、A 行 `data-read="1"`、
    B 仍 `"0"`；同帖 `post.created`+`thread.invited` 两条事件一次全读。
  - 证据：`scripts/qa/read-dwell.mjs` 的 notification 用例 + 网络/DOM 证据。

- [x] P2-3. 诊断与指标：`window.__reportReadDwell = { enabled, observers, targets, timers,
  marks, persists, lastMarkAt }`（只读快照，不参与业务）；卡片 `data-dwell-state`
  （`idle|visible|dwell|paused|read|skipped`）由引擎直接写，供 QA 断言暂停/恢复。
  - 判据：A2/A3 可读到 `visible`/`dwell`/`paused` 迁移；`marks` 与实际 read-set 新增数一致；
    生产环境无 console 噪音。
  - 证据：QA 断言 + 生产构建 smoke（无报错）。

- [x] P2-4. 边界细化：模态遮挡检测（`[data-slot=dialog-content]`/`[data-slot=sheet-content]`/
  `[role=dialog][data-open]` 存在即 hold）；高卡覆盖率（Owner 拍板口径）；同页同帖多实例去重；
  无 IO 环境降级；read-set 淘汰后重新计时的幂等。
  - 判据：打开图片查看器/发帖箱/sheet 停留 2s 不标；关闭后继续计时可标；
    **超视口长帖（高度 >2 屏）只露 50% 视口高 → 阈值后标已读（A11），只露 40% 不标；
    390/1280 均通过**；无 IO 环境 `enabled=false` 且无异常。
  - 证据：`scripts/qa/read-dwell.mjs` edge 用例（图片查看器 + >2 屏长帖夹具，两视口）。

- [ ] P2-5. 长列表性能审计：200 帖 feed，连续滚动 10 屏；`PerformanceObserver` longtask；
  DOM 节点身份检查（无整列表替换）；两视口 390/1280。
  - 判据：A9 全通过：`observers===1`、`targets<=200`、无 >50ms longtask、
    单帖标记只改一个节点的 `data-read`、列表父级无重渲染迹象。
  - 证据：性能 JSON（longtask 列表、observer/targets 计数、mutation 摘要）。
  - 本轮实测（2026-11-08，未勾选）：基础断言通过——`observers===1`、`targets=17≤26
    张已挂载卡`、滚动 8×0.9 屏无 >50ms longtask、节点身份不变；**200 帖全量 feed 的
    10 屏审计未跑**（隔离板只种了 25 帖，未达到判据的 200 帖规模）。

- [x] P2-6. 无障碍与 reduced-motion 审计：A4/A10；屏幕阅读器线性浏览（无滚动）5s 不标；
  键盘 `j/k` 滚动可标；「全部已读」兜底可用。
  - 判据：A4/A10 通过；无 `aria-live` 噪音；Tab 焦点移动不改变已读。
  - 证据：QA 用例 + 可访问性检查清单。

## P3. 收口

- [ ] P3-1. 文档与归档：回填实测数字（observer 数/写入次数/长任务/两视口截图），
  更新 `report-surface` / `report-social` / `report-static-mode` 增量若实现有偏差；
  `npx openspec validate report-read-dwell --strict` 通过；归档 change。
  - 判据：validate PASS（长文本 warning 可接受）；archive 就位；QA 结果随报告留存。

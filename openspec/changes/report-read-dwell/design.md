# Design: report-read-dwell（视窗停留已读 + 未读高亮）

## 0. 决策摘要

| # | 决策 | 依据 |
|---|------|------|
| D1 | 触发器＝`PostCard` 根节点（`data-post-id`），全局**一个** `IntersectionObserver` | Owner 口径 1；避免 200 卡 200 observer |
| D2 | 计时＝可见面积 ≥50% 且 `visibilityState==="visible"` 时累计；阈值 `clamp(chars/80*1000, 400, 1500)`，含媒体 +300ms；高卡见 D10 | Owner 口径 2 |
| D3 | 写入现有 per-account read-set（`markPostRead`），**不推进 cursor** | Owner 口径 3；与通知列表/角标同源 |
| D4 | 未读＝整卡淡底 + 左侧强调条；达标瞬间 ~1.2s 淡出；reduced-motion 瞬时 | Owner 口径 4 |
| D5 | 删除 `ThreadPage` 的「进入即已读」路由事件标记 | 「已读不是路由事件」；后台标签页不得误标 |
| D6 | 静态归档**不启用**观察器（不选「仅本地高亮」） | §7 取舍理由 |
| D7 | 已读翻转用 per-id 外部订阅（`useSyncExternalStore`），只重渲染该卡 | Owner 口径 5「不触发整列表重渲染」 |
| D8 | 卡片卸载即丢弃未完成的停留累计 | 防止「从未真正停留」的帖子被标已读 |
| D9 | 遮挡暂停＝模态层存在检测 + `hold()/release()` 显式门 | IO 只能感知裁剪，不能感知覆盖 |
| D10 | 卡片高于视口时覆盖率＝卡片可见高度 ÷ 视口高度 ≥50%（等价 `min(卡片高, 视口高)` 的 50%）；超视口长帖（>2 屏）只露 50% 视口高也必须在阈值后标已读 | Owner 2026-11-08 拍板 |
| D11 | read-set 上限 **2000/账号**，按最近读取时间 LRU 淘汰；localStorage <150KB/账号 | Owner 2026-11-08 拍板 |
| D12 | 未读强调条画在 x=0..3，避开线程导轨 x=38..40 | 与 `report-thread-timeline` 视觉复核口径一致 |

## 1. 现状与接入点（path:line）

> 行号取自 2026-11-08 工作树；`report-link-preview` 正在同一工作树给 `PostCard` 插入
> `<LinkPreviews>`（`PostCard.tsx:17,176,267`），合并后行号会整体后移。**接入点以锚点
> （`data-post-id` / `data-testid` / 函数名）为准，不以固定行号为准。**

| 用途 | 位置 | 现状 |
|------|------|------|
| 帖子卡片根节点（普通） | `src/ui/components/PostCard.tsx:186-196`（`data-post-id` `:187`，`data-testid` `:190`；根节点到 `:380`） | `article` 根，已有 `data-post-id`/`data-author`/`data-shared-host` |
| 帖子卡片根节点（自接紧凑） | `src/ui/components/PostCard.tsx:138-148`（`data-post-id` `:139`） | 同上，无操作栏 |
| 软删判定 | `src/ui/components/PostCard.tsx:89`（`deleted = post.deleted_at !== null`） | 删除态渲染占位 |
| 正文/媒体/引用/标签 | `src/ui/components/PostCard.tsx:242-268` | 阈值估算与媒体 +300ms 的数据源 |
| Feed 滚动容器 | `src/ui/components/TimelineFeed.tsx:487-491`（`data-testid="timeline-scroll"`） | 内层滚动，视口 root 可正确裁剪 |
| Feed 卡片渲染 | `src/ui/components/TimelineFeed.tsx:550-556` | 每帖一个 `PostCard` |
| 新帖入场 flash | `src/ui/components/TimelineFeed.tsx:67,157-162,443-446,549` | `flashIds` + `report-row-in` 400ms |
| 线程滚动容器 | `src/ui/pages/ThreadPage.tsx:990-995`（`data-testid="thread-scroll"`） | 内层滚动 |
| 线程卡片渲染 | `src/ui/pages/ThreadPage.tsx:1105-1118` | focal/ancestor/reply/compact 四种变体 |
| **进入即已读（待删除）** | `src/ui/pages/ThreadPage.tsx:589-596` | `useEffect(() => markPostRead(postId))` |
| 搜索页滚动容器/卡片 | `src/ui/pages/SearchPage.tsx:144`、`:360-367` | 独立 `PostCard` 列表 |
| 通知行已读标记 | `src/ui/pages/NotificationsPage.tsx:169-203`（`data-read` `:176`，`markPostRead` `:191,200`） | 点击才标 |
| 通知滚动容器 | `src/ui/pages/NotificationsPage.tsx:290-297` | — |
| read-set 状态 | `src/ui/state/notifications.tsx:185-187`（懒加载）、`:202-213`（persist）、`:81`（500 上限，本 change 提升到 2000 LRU） | 按 `base+account` 存 localStorage |
| 唯一写入口 | `src/ui/state/notifications.tsx:478-490`（`markPostRead`） | 幂等：`prev.has` 直接返回 |
| 已读判定 | `src/ui/state/notifications.tsx:492-498`（`isRead`） | `readIds.has(target) \|\| seq <= cursor` |
| 角标同源 | `src/ui/state/notifications.tsx:527`（`projection.badge(readIds)`）、`src/ui/components/Nav.tsx:61,101-104,166,203-205` | 与 read-set 同源 |
| pending 吸收 | `src/ui/state/feed.tsx:428-437` | 未吸收的帖子不在 DOM，不会被观察 |
| 静态模式标志 | `src/ui/state/connection.tsx:101`（`staticMode`） | 快照存在即静态 |
| 静态通知为空 | `src/ui/lib/static-api.ts:749-761`（`notifications()`/`notificationHistory()`） | 无通知/已读概念 |
| Provider 边界 | `src/ui/App.tsx:52-61`（`NotificationsProvider`） | 本 change 在此内挂 `ReadDwellProvider` |
| 动效令牌 | `src/ui/app.css:140-186`（`report-row-in`/`report-swap-*`/reduced-motion） | 新动画沿用同一 `@layer utilities` |
| 主题令牌先例 | `src/ui/theme/report-thread.css:8-20` | 新增 `--read-*` 令牌放同文件或 `app.css` |

**覆盖链**：收藏页（`BookmarksPage.tsx:62-66`）、成员页（`ProfilePage.tsx:341-346`）、
标签页（`TagPage.tsx:66-71`）、主页双流（`HomePage.tsx:105-110`）全部经 `TimelineFeed`
渲染 `PostCard`；搜索页直接渲染 `PostCard`（`SearchPage.tsx:360-367`）；详情页直接渲染
`PostCard`（`ThreadPage.tsx:1105-1118`）。因此无需逐页接入。

**结论**：所有完整帖子都经过 `PostCard`，所以只要在 `PostCard` 挂一个注册 effect，就自动覆盖
feed/线程/搜索/收藏/成员页/详情，无需改任何页面路由逻辑。

## 2. 触发面与观察器生命周期

### 2.1 模块与职责

- `src/ui/lib/dwell-threshold.ts`：纯函数，零 DOM 依赖，可单测。
  - `READ_CHARS_PER_SECOND = 80`
  - `DWELL_MIN_MS = 400`
  - `DWELL_MAX_MS = 1500`
  - `MEDIA_EXTRA_MS = 300`
  - `dwellThresholdMs(input: { bodyMd: string; hasMedia: boolean }): number`
  - `coverageOf(entry: IntersectionObserverEntry, viewportHeight: number): number`
- `src/ui/state/read-dwell.ts`：`ReadDwellEngine`（单例类，非 React 组件）。
- `src/ui/components/ReadDwellProvider.tsx`：读 `useConnection()` / `useNotifications()`，
  创建/重置引擎，提供 `useReadDwell()`（返回 `observe`/`unobserve`/`hold`/`release`）。
  静态模式或 `IntersectionObserver` 不可用时 Provider 直接渲染 children、不建引擎。
  `useReadDwell()` 在无 Provider 时返回 no-op 实现（便于组件单测/独立渲染，不抛错）。
- 诊断对象 `window.__reportReadDwell` 由模块级安装：即使引擎禁用也存在，字段
  `{ enabled, observers, targets, timers, marks, persists, lastMarkAt }`；禁用态
  `enabled=false`、计数全 0。

### 2.2 一个观察器

```ts
new IntersectionObserver(onEntries, {
  root: null,             // 视口；祖先滚动容器的裁剪会自动反映在 intersectionRect
  rootMargin: "0px",
  threshold: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
});
```

- **懒创建**：第一个可观察卡片 `observe()` 时创建；跟踪集合为空时 `disconnect()` 并置空。
- **root=null 的正确性**：`TimelineFeed`/`ThreadPage`/`SearchPage` 的滚动容器都在视口内，
  IO 的 `intersectionRect` 会被所有祖先滚动容器裁剪，因此「卡片在自己的滚动容器里可见」
  与「在视口里可见」在本应用等价。
- **阈值密集**：IO 的 threshold 是 observer 级而非元素级；对「卡片高于视口」的推广规则
  （§3.2），密集阈值保证覆盖率跨 0.5 时能拿到回调。极端高卡（>10× 视口）可能晚一个阈值
  才开始计时，误差不超过一次滚动事件，可接受（§10 R3）。

### 2.3 注册/注销

`PostCard` 内：

```tsx
const articleRef = useRef<HTMLElement | null>(null);
const { observe, unobserve } = useReadDwell();
useEffect(() => {
  const el = articleRef.current;
  if (!el) return;
  observe(el, {
    postId: post.id,
    author: post.author,
    seq: post.seq,
    bodyMd: post.body_md,
    hasMedia: post.media.length > 0 ||
      Boolean(post.quoted_visible && post.quoted?.media.length),
    deleted: post.deleted_at !== null,
  });
  return () => unobserve(el);
}, [observe, unobserve, post.id, post.author, post.seq, post.deleted_at,
    post.body_md, post.media.length, post.quoted_visible, post.quoted?.media.length]);
```

- 两个分支（普通/自接紧凑）的 `article` 都挂同一个 ref。
- 描述符任一字段变化即重注册（帖子正文不可编辑，实际上只在数据回填时发生一次）。
- `unobserve`：从 `Map<Element, Entry>` 删除、`observer.unobserve(el)`、清 timer、
  **丢弃未完成累计**（D8）。
- 虚拟化预留：若未来引入虚拟列表，卡片滚出即卸载 → 自动丢弃累计；重新挂载重新计时。
  引擎不持有「已卸载帖」的状态，因此不需要额外的虚拟化适配。

### 2.4 重置与重连

- **账号/后端切换**：`NotificationsProvider` 已按 `base+account` 换 read-set
  （`notifications.tsx:218-232`）。`ReadDwellProvider` 监听 `account.id`，
  变化时 `engine.reset()`：`disconnect()`、清 entries/timers/written、通知所有已读订阅者。
- **SSE 重连/reset**：与停留无关，引擎不重建；已读是本地属性，不依赖事件流。
- **Provider 卸载**：`disconnect()` + 清全部 timer + 移除 visibility 监听。

### 2.5 可见性与遮挡

- `document.visibilitychange`：引擎级监听。hidden → `pauseAll()`（累计已停留时间、清 timer）；
  visible → 对「最后一次 IO 报告覆盖率 ≥0.5」的条目 `resume()`。
- **遮挡**：`IntersectionObserver` 只反映裁剪，不反映被其它元素覆盖。引擎提供
  `hold(reason: string)` / `release(reason: string)` 引用计数门；内置一个
  `MutationObserver(document.body, { childList: true, subtree: true })` 检测
  `[data-slot="dialog-content"]`、`[data-slot="sheet-content"]`、`[role="dialog"][data-open]`
  的存在：存在即 `hold("modal")`，消失即 `release("modal")`。
  该 MutationObserver 只在引擎启用且至少跟踪一个条目时存在；它只观察节点增删，不观察滚动。
- **覆盖层（route detail）**：`AppShell` 在 `detail === true` 时对详情层元素调用
  `hold("route-detail", overlayEl)`；`hold(reason, scopeEl)` 只暂停**不在 scope 内**的目标，
  因此底层根页卡片暂停并保留累计、详情层自己的卡片继续计时（IO 只能感知裁剪，不能感知覆盖）。
  关闭详情时 `release` 恢复。
- 已知不暂停的遮挡：toast（小而短暂）、下拉刷新指示器。显式登记为可接受（§10 R4）。

## 3. 计时状态机与阈值

### 3.1 状态

每个被观察元素一个 `EntryState`：

```
own/deleted/static ──▶ 不注册（不建 timer）；already-read ──▶ 不建 timer（保留 read 态）
idle    ──coverage > 0──────────────────────▶ visible
visible ──coverage = 0──────────────────────▶ idle
visible ──coverage ≥ 0.5 & docVisible & !held─▶ dwell
dwell   ──coverage < 0.5 | hidden | held─────▶ paused
dwell   ──timer 到点且复核通过───────────────▶ read（终态）
dwell   ──timer 到点但复核失败───────────────▶ paused
paused  ──coverage ≥ 0.5 & docVisible & !held─▶ dwell
任意    ──unmount──────────────────────────▶ 移除（丢弃累计）
```

- `idle`：不在视口；`visible`：在视口但可见面积不足 50%（看见但不够）；`dwell`：达标并
  正在累计；`paused`：曾达标、当前不可见但保留 `accMs`；`read`：终态。
- 字段：`{ accMs, dwellSince | null, timer, lastCoverage, state, written }`。

### 3.2 覆盖率定义

```ts
const rootH = entry.rootBounds?.height ?? window.innerHeight;
const tall = entry.boundingClientRect.height > rootH;
const coverage = tall
  ? entry.intersectionRect.height / rootH      // 高卡：卡片占视口高度 ≥50%
  : entry.intersectionRatio;                   // 普通卡：可见面积比 ≥50%
```

- 普通卡（高度 ≤ 视口）就是 Owner 口径的「可见面积 ≥50%」。
- **高卡（Owner 2026-11-08 拍板）**：卡片高于视口时，「面积比 50%」永远不可达，统一按
  「卡片可见高度 ÷ 视口高度 ≥50%」判定——等价于对超视口卡片取 `min(卡片高, 视口高)` 的 50%。
  超视口长帖（>2 屏）只露出 50% 视口高时也必须在阈值后标已读，**不得永不标记**。
  语义仍是「这张卡是屏幕上主要被看的内容」。
- 不读 `getBoundingClientRect`（除 §3.4 的到点复核），IO 回调内零布局读取。

### 3.3 累计与阈值

```ts
const threshold = clamp(codePoints(bodyMd) / 80 * 1000 + (hasMedia ? 300 : 0), 400, 1500);
```

- `codePoints`：`Array.from(bodyMd).length`（emoji/中文按码点计，不用 UTF-16 长度）。
- `hasMedia`：帖子自身 `media.length > 0`，或引用卡可见且 `quoted.media.length > 0`。
  **不计** link-preview 的封面（跨 change 耦合，且封面不是帖子自有媒体）。
- 进入 `dwell`：`dwellSince = performance.now()`，`setTimeout(threshold - accMs)`。
- 离开 `dwell`：`accMs += performance.now() - dwellSince`；`dwellSince = null`；清 timer。
- timer 到点（§3.4）通过 → `markPostRead(postId)`，`el.dataset.read = "1"`，
  `el.dataset.dwellState = "read"`，`written = true`，清 timer。
- 同帖重复（同页出现两次）以 `postId` 为 key：第一个到点即写；另一个到点前发现
  `written`/read-set 已命中 → 转 `read`（幂等）。

### 3.4 到点复核（防「滚出后仍被标」）

timer 回调只做一次轻量复核，不进入 rAF 循环：

```ts
const r = el.getBoundingClientRect();
const rootH = window.innerHeight;
const rootW = window.innerWidth;
const visibleH = Math.min(r.bottom, rootH) - Math.max(r.top, 0);
const visibleW = Math.min(r.right, rootW) - Math.max(r.left, 0);
const tall = r.height > rootH;
const ok = document.visibilityState === "visible" &&
  !held() &&
  (tall
    ? visibleH / rootH >= 0.5          // 高卡：= min(card, viewport) 的 50%（Owner 拍板）
    : (visibleH * visibleW) / (r.height * r.width) >= 0.5);
```

失败 → `paused`（保留 `accMs`），等下一次 IO 回调恢复；成功 → 写已读。
复核频率上限＝当前可见卡数（通常 1–3 个），每帖最多一次，无每帧开销。

### 3.5 快速滚动

- 只有覆盖率 ≥0.5 才启动 timer；快速滚过时单卡停留 <400ms，timer 不会到点。
- 若用户在同一卡上多次短停，`accMs` 会累加；这是「反复看同一卡」的合理语义，
  与「快速滚过不停留」不冲突（后者累计仍 < 阈值）。

## 4. 已读写入、幂等与通知同源

### 4.1 唯一写入口

引擎只调用 `notifications.markPostRead(postId)`（`notifications.tsx:478-490`）：

- 不改服务端游标；`ack()`（`notifications.tsx:453-475`）仍是唯一推进游标与唯一清空路径。
- 不改通知历史 `read` 标记的服务端口径（`seq <= cursor`）；本端判定仍是
  `readIds.has(target) || seq <= cursor`（`notifications.tsx:492-498`）。

### 4.2 幂等与 LRU

- `markPostRead` 对**已在集合内**的帖子不改变已读标记（返回原 Set，不通知订阅者），但 SHALL
  把它移到 LRU 的最近使用端；LRU 顺序用独立 ref（不进 React state），避免 touch 触发整页
  重渲染。
- 引擎 `written` 集合再挡一层：同一 `postId` 在一次页面生命周期内最多调用一次。
- **上限 2000/账号（Owner 2026-11-08 拍板）**，按最近读取时间 LRU 淘汰：超出时从最久未读端
  移除。被淘汰的帖子可能重新显示未读，再次停留会再次写入（不视为重复写 bug）。
- 判据：连续标记 600 条后，最早 100 条 SHALL 仍保持已读（不得复现未读）；localStorage
  体积 SHALL <150KB/账号。

### 4.3 持久化去抖（改动现有实现）

现状 `markPostRead` 在 `setState` updater 内同步 `persistReadSet`（`:481-487`）——每次标记
写一次完整 localStorage。停留已读可能在一屏内连续产生多条，改为：

- 内存 Set 立即更新（UI 即时）；
- 持久化 effect 监听 `readIds`，**250ms trailing debounce** 写一次；
- `pagehide`、`visibilitychange→hidden`、Provider 卸载时同步 flush；
- key 不变（`report.read.v1:<base>:<account>`）；上限 **2000/账号、LRU**，序列化按最旧→最新
  保留最后 2000 条；体积预算 <150KB/账号。

### 4.4 per-id 已读订阅（不重渲染整列表）

`NotificationsValue` 增加（加性）：

```ts
isPostRead(postId: string, seq: number): boolean;          // 纯查询
subscribePostRead(postId: string, cb: () => void): () => void; // 只通知该 id
```

实现：Provider 内维护 `Map<postId, Set<cb>>` 与 `latestIsRead` ref。

- `markPostRead(id)` 成功后只 `notify(id)`；
- `ack()`（cursor 推进）与账号切换 `notifyAll()`（一次性）；
- 卡片用 `usePostReadFlag(postId, seq)`：
  `useSyncExternalStore(subscribe, () => isPostRead(postId, seq))`（返回 boolean，快照稳定）。

效果：一次停留只让**那一张卡**重渲染；列表父组件、其它卡片 0 次渲染。引擎同时直接写
`el.dataset.read`，保证「淡出动画」不依赖 React 提交时机。

### 4.5 通知列表/角标同源

- 通知页行 `data-read` 来自 `groupNotificationEvents(..., isRead)`（`NotificationsPage.tsx:128-143,176`），
  `isRead` 读同一 `readIds` → feed 停留后通知行自动转已读。
- 角标 `projection.badge(readIds)`（`notifications.tsx:527`）与 `Nav.tsx:61,101-104,166,203-205`
  同源 → 角标相应减少。
- 同一帖的多条通知（`post.created` + `thread.invited`）按帖分组，一次停留全部转已读
  （现有 `groupNotificationEvents` 语义，不改）。
- **边界说明**：feed 只渲染根帖；若某条通知的 target 是一条从未在 feed/任何面出现过的回复，
  浏览 timeline 不会把它标已读（per-post 语义的必然结果）。「浏览后通知同步已读」只在
  「通知 target 帖子本身被看见」时成立；这是本 change 有意不越界的地方。

## 5. 高亮、动效与可访问性

### 5.1 未读高亮形态

- `PostCard` 根节点渲染 `data-read={read ? "1" : "0"}`（静态模式不渲染该属性）。
- 未读样式用属性选择器，避免与 `hover:bg-muted/30`、`bg-accent/60` 的类名顺序打架：

```css
article[data-read="0"]:not([data-selected="1"]) {
  background-color: var(--read-tint);
}
article[data-read="0"]:not([data-selected="1"]):hover {
  background-color: var(--read-tint-strong);
}
article[data-read]::after {
  content: "";
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background-color: var(--read-accent);
  opacity: 0;
  transition: opacity 200ms ease-out;
}
article[data-read="0"]:not([data-selected="1"])::after { opacity: 1; }
```

- 令牌（主题同源，不硬编码 hex）：`--read-tint: color-mix(in oklab, var(--primary) 5%, transparent)`、
  `--read-tint-strong: ... 8%`、`--read-accent: color-mix(in oklab, var(--primary) 55%, transparent)`；
  `.dark` 下用 `oklch(1 0 0 / 4%)` / `6%` / `55%`。
- 强调条在 x=0..3，**不与线程导轨 x=38..40 重叠**；不改变 padding/margin/行高（CLS=0）。
- `PostCard` 增加 `data-selected={selected ? "1" : undefined}`，选中态压过未读底色。
- 自接紧凑行同样适用（`article` 根相同），强调条仍贴卡片左缘。

### 5.2 已读淡出

- 达标瞬间引擎写 `data-read="1"`；CSS 在 `article[data-read]` 上声明
  `transition: background-color 1200ms var(--ios-ease-out)`，未读底色 → 透明即 1.2s 淡出。
- 强调条 200ms 淡出（更快，避免拖尾）。
- 已有 `transition-colors`（150ms，`PostCard.tsx:193`）被更具体的属性选择器规则覆盖为 1200ms；
  只作用于背景色，不影响其它交互态。
- `prefers-reduced-motion: reduce`：`transition: none`，`data-read` 翻转即瞬时完成。

### 5.3 新帖入场高亮（P2）

- 复用 `TimelineFeed` 的 `flashIds`（`:67,157-162,443-446,549`）：吸收 pending/点胶囊时给新行
  加 `report-row-new` 类。
- `report-row-new` = 既有 `report-row-in` 位移/透明度 + 背景从 `--read-new-tint` 淡到透明
  （900ms）；未读底色在其下方继续存在，直到停留达标。
- 仅对新到达且未读的帖子生效；`prefers-reduced-motion` 下只保留未读底色，不播动画。

### 5.4 可访问性

- 高亮/强调条是装饰：`::after` 不进入可访问树（伪元素）；不加 `aria-live`（避免每卡播报噪音）。
- 屏幕阅读器线性浏览不触发滚动 → 不产生停留 → 不误标；「全部已读」仍是兜底（`Nav`/通知页
  按钮，现有路径）。
- 键盘 `j/k` 会 `scrollIntoView`（`TimelineFeed.tsx:371-409`、`ThreadPage.tsx:910-953`），
  被滚动到的卡片会正常计时——这是「被看见」的合法路径。
- 纯焦点移动（无滚动）不计时；Tab 焦点落在卡内按钮上不改变可见性判定。

## 6. 性能预算

| 指标 | 预算 | 验证方式 |
|------|------|----------|
| IntersectionObserver 实例 | 每 document **1** | `window.__reportReadDwell.observers` |
| 观察目标数 | ≤ 已挂载未读 `PostCard` 数（200 帖用例 = 200） | `__reportReadDwell.targets` |
| 活跃 timer | 通常 ≤3，上限 = 覆盖率 ≥0.5 的卡数 | `__reportReadDwell.timers` |
| 滚动监听 | 0（引擎不监听 scroll） | 代码审查 + 事件计数 |
| 每帧 setState | 0 | 无 rAF 循环；React Profiler 无周期提交 |
| 单帖标记的 React 渲染 | 仅该卡 1 次（列表父级 0 次） | DOM 节点身份 + 属性变更计数 |
| localStorage 写 | ≤1 次/250ms 突发 | `__reportReadDwell.persists` |
| read-set 体积 | ≤150KB/账号（2000 条 id） | `localStorage.getItem(key).length` 断言 |
| 长任务 | 200 帖滚动全程无 >50ms 归因于引擎的任务 | `PerformanceObserver({entryTypes:["longtask"]})` |
| 内存 | 每条目 O(1)，卸载即删 | entries.size 回归 0 |

- IO 回调只读 `entry` 字段；到点复核每帖最多一次 `getBoundingClientRect`。
- 引擎不复制帖子正文：只存阈值数字与 postId/seq。

## 7. 静态导出模式（二选一：**不启用**）

**决定：静态模式不创建观察器、不写 localStorage、不渲染未读高亮/`data-read`。**

理由（对照「仅本地高亮」方案）：

1. **没有消费者**：静态归档的 `notifications()` / `notificationHistory()` 恒为空
   （`static-api.ts:749-761`），没有通知列表、没有角标、没有「未读」概念；高亮只会是一个
   无人解释的视觉状态。
2. **read-set 被显式关闭**：Provider 在 `staticMode` 下不加载 read-set、不持久化
   （`notifications.tsx:185-187,202-213`）。启用停留会在内存里造一份一次性状态，刷新即丢，
   与「只读归档」的确定性矛盾。
3. **存储风险**：归档常以 `file://` 打开；`localStorage` 在该环境可能抛异常或被隔离，
   为一个没有消费者的状态引入失败面不值得。
4. **规格一致性**：`report-static-mode` 明确「只读」「写操作零网络」；引入本地已读是新的
   状态面，应另立 change 才能做。

**判据**：静态模式（`connection.tsx:101` 为 true，或页面存在 `#report-snapshot`）下
`window.__reportReadDwell.enabled === false`（诊断对象仍安装）、`observers === 0`、
卡片无 `data-read` 属性、3s 内 `localStorage` 无 `report.read.*` 写入。

## 8. 边界规则

| 场景 | 行为 | 判据 |
|------|------|------|
| 自己的帖子 | 不注册：不高亮、不观察、不写 | `data-read` 不存在 / 无底色 |
| 软删帖（`deleted_at !== null`） | 不注册：占位行不参与 | 无 `data-read`/强调条 |
| 后台标签页 / 切后台 | 暂停累计；hidden 期间到点的 timer 不写 | 切后台 2s 回来仍按剩余时间计时 |
| 模态层遮挡（图片查看器/发帖箱/sheet） | `hold("modal")` 暂停 | 打开查看器停留 2s 不标 |
| 快速滚动 | 不达标不标 | 300px/100ms 滚过整屏后 read-set 不变 |
| 卡片卸载/路由切换 | 丢弃未完成累计 | 返回后重新计时 |
| 同帖多实例（同页重复） | 以 postId 去重，先到点者写 | 只 1 次写入 |
| 已读集合淘汰（>2000 LRU） | 最久未读的旧帖可能重新未读；再次停留再写 | 连续 600 条后最早 100 条仍已读；<150KB/账号 |
| 屏幕阅读器/纯键盘焦点 | 不滚动不计时；`j/k` 滚动可计时 | 屏外卡片无滚动 5s 仍未读 |
| `prefers-reduced-motion` | 直接切换，无 1.2s 淡出 | computed transition-duration = 0s |
| 无 `IntersectionObserver` 环境 | 引擎 `enabled=false`，不标已读 | 功能降级为现状（无高亮） |
| 静态归档 | 完全不启用 | §7 |

## 9. 验收矩阵（A1–A13）

> 全部用 `scripts/qa/read-dwell.mjs` 对隔离后端（`qa-serve.mjs`）执行；390×844 与 1280×800
> 两视口各跑 A1/A9/A11，其余默认 1280×800。断言以 DOM/属性/`localStorage`/网络为准。

| ID | 场景 | 步骤 | 断言 |
|----|------|------|------|
| A1 | 停留达标 → 已读 | 滚到目标帖，停留 `threshold+250ms` | `data-read="1"`；未读底色（`data-read="0"` 规则）在 ≤1.5s 内消失；read-set 含该 id；角标（若同 target 有未读）−1 |
| A2 | 快速滚过 → 未读 | 100ms 内滚过 3 屏 | 所有经过的卡 `data-read="0"`；read-set 无新增 |
| A3 | 后台暂停 | 停留 200ms → 切后台 2s → 回来停留 100ms | 仍未读；再停留至阈值 → 已读 |
| A4 | reduced-motion | `emulateMedia({reducedMotion:"reduce"})`，停留达标 | `data-read` 立即 `1`；无 1.2s 过渡（computed `transition-duration` 为 0s） |
| A5 | 静态不启用 | `file://` 打开导出归档，停留 3s | `__reportReadDwell.enabled=false`；`observers=0`；无 `data-read`；无 `report.read.*` 写入 |
| A6 | 通知同步 | 两帖 A/B 各 1 条未读；在 feed 停留 A | 角标 −1；A 的通知行 `data-read="1"`；B 仍 `0` |
| A7 | 自己/软删 | 自己发的帖 + 软删帖各停留 2s | 无 `data-read`、无底色；read-set 不含这两个 id |
| A8 | 幂等/持久化 | 同帖停留达标两次；reload | 只 1 次写入（`__reportReadDwell.marks===1`）；reload 后仍 `data-read="1"` |
| A9 | 长列表性能 | 200 帖 feed，连续滚动 10 屏 | `observers===1`；`targets≤200`；无整列表 DOM 替换（节点身份不变）；无 >50ms longtask；390/1280 均通过 |
| A10 | 新帖入场 + 无障碍 | SSE 推新帖并在顶部吸收；另开无滚动会话 5s | 新行 900ms 内高亮后回到未读底色；无滚动会话 5s 后屏外卡片仍未读；点「全部已读」后角标 0 |
| A11 | 超视口长帖 | 构造高度 >2 屏的帖子，滚动到只露出 50% 视口高，停留 `threshold+250ms` | 该帖 `data-read="1"`（按「可见高度 ÷ 视口高 ≥50%」判定，不等整卡可见）；390/1280 均通过 |
| A12 | read-set 2000/LRU | 连续标记 600 条 → 检查最早 100 条；再压测到 2001 条 → 检查最久未读被淘汰 | 600 条时最早 100 条仍已读（不出现「刚读过的旧帖复现未读」）；2001 条时第 1 条被淘汰、其余仍在；`localStorage` 值 <150KB/账号 |
| A13 | 强调条几何 | 线程页未读卡与 feed 未读卡各取一条，读 `::after` 与 `[data-testid=thread-rail]` 矩形 | 强调条 left=0、width=3（x∈[0,3]）；线程导轨 left=38、width=2（x∈[38,40]）；两矩形不相交；卡片高度与无高亮时一致 |

## 10. 风险与回滚

| # | 风险 | 缓解 |
|---|------|------|
| R1 | 长列表 200 卡 observe 初始回调抖动 | 单 observer、回调 O(entries)、无布局读取；A9 预算 |
| R2 | `markPostRead` 高频触发导致 localStorage 抖动 | 250ms 去抖 + flush 兜底（§4.3） |
| R3 | 超高卡（>10× 视口）计时起点晚一个阈值 | 到点复核 + 密集阈值；影响 ≤ 一次滚动，验收不覆盖极端卡 |
| R4 | 非模态遮挡（toast/浮层）不暂停 | 显式登记；toast 短暂且不遮挡正文主体 |
| R5 | 2000 上限仍可能被超长会话淘汰 | LRU 保留最近读取；<150KB 体积门；极端场景按既有淘汰语义（A12） |
| R6 | 与 `report-link-preview` 的 `PostCard` 改动冲突 | 硬顺序：link-preview 先合；本 change 只加 ref/属性/hook |
| R7 | React 与引擎同时写 `data-read` | 引擎写值与 store 快照一致；React 重渲染写同值，无闪变 |
| R8 | 浏览器不支持 IO | 引擎禁用，退回现状（无高亮/无停留已读） |

**回滚**：移除 `ReadDwellProvider` 挂载 + `PostCard` 注册 effect + CSS 令牌即可；read-set 数据
格式不变，历史已读不受影响。

## 11. 与并行 change 的合并顺序与冲突点

1. `report-notification-history-and-reply-submit`（已归档）：read-set / history / union refresh。
2. `report-event-hub`（P1 已落地）：通知投影、角标同源、`useEventHub`。
3. `report-thread-timeline`（已归档）：平铺 timeline、`PostCard` 度量。
4. `report-link-preview`（在途）：`PostCard.tsx:17,176,267` 插 `<LinkPreviews>`；本 change
   **必须等它合入后 rebase**。
5. **本 change**：最后 rebase。

冲突面与策略：

- `PostCard.tsx`：link-preview 改 import + 两个插入点；本 change 改根 `article`（ref、
  `data-read`、`data-selected`）与新增 hook import。两者行位不同，冲突可手工合并（加性）。
- `notifications.tsx`：本 change 加 per-id 订阅/`isPostRead`、持久化去抖；event-hub 的投影逻辑
  不动。合并时保留 `markPostRead` 的幂等语义。
- `App.tsx`：在 `NotificationsProvider` 内加 `ReadDwellProvider`（`App.tsx:52-61`）。
- `app.css`：末尾追加 `@layer utilities` 规则，不动 View Transition 段。
- `ThreadPage.tsx`：删除 `:589-596` 的进入即已读 effect（本 change 的唯一删除性改动）。
- `TimelineFeed.tsx`：P2 新帖高亮只扩 `flashIds` 的 className，不改滚动/胶囊逻辑。
- 既有 QA：`scripts/qa/notifications-read.mjs` ② 走「时间线 → 详情」并在详情等 1600ms 后断言
  角标 −1；删除路由标记后该断言依赖停留（阈值上限 1500ms），余量仅 100ms。实施时把等待
  提高到 ≥1800ms 或显式等待 `data-read="1"`。①（点通知行）走点击路径，语义不变。

## 12. 决策记录

- **D1（2026-11-08）**：触发器用 `PostCard` 根节点 + 全局单 observer，而非路由钩子/每卡
  observer。理由：与路由解耦、覆盖所有面、性能可预算。
- **D2**：阈值公式与常量完全按 Owner 口径，不在实现里另调参；常量集中在一个纯函数模块，
  便于后续 Owner 调参时只改一处。
- **D3**：写入现有 read-set，不新增存储/表；「全部已读」语义不变。
- **D4**：未读高亮＝整卡淡底 + 1.2s 淡出；强调条几何见 D12。
- **D5**：删除 `ThreadPage` 进入即已读。理由：「已读不是路由事件」；后台标签页/未看见不得标。
  代价：打开详情后立刻返回（<400ms）不再标已读——这是新语义的有意结果。
- **D6**：静态模式不启用（拒绝「仅本地高亮」），理由见 §7。
- **D7**：per-id 外部订阅而非 context 广播，保证「单帖标记不重渲染整列表」。
- **D8**：卸载丢弃未完成累计，防止「从未停留」误标；虚拟化天然兼容。
- **D9**：遮挡暂停用模态存在检测 + `hold()` 门；IO 本身无法感知覆盖。
- **D10（2026-11-08 Owner 拍板）**：高卡覆盖率＝卡片可见高度 ÷ 视口高度 ≥50%（等价
  `min(卡片高, 视口高)` 的 50%）；超视口长帖（>2 屏）只露 50% 视口高也必须在阈值后标已读，
  不得永不标记。
- **D11（2026-11-08 Owner 拍板）**：read-set 上限 **2000/账号**，按最近读取时间 LRU 淘汰；
  连续标记 600 条后最早 100 条仍已读；localStorage <150KB/账号。
- **D12（2026-11-08）**：未读强调条画在 x=0..3，避开线程导轨 x=38..40；几何进验收 A13，
  与 `report-thread-timeline` 的视觉复核口径一致。

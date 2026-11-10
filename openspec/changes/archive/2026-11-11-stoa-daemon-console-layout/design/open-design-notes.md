# Stoa Daemon 控制台 · 布局与产品体验设计说明

> 本文档是 `index.html` 的设计注记，供工程师将其移植到 React + shadcn/ui。
> 视觉基础（shadcn base-nova、solid-glass、主题令牌、lucide 单色、Geist、中文、真实示例数据）保持不变，
> 这里只说明**布局、信息层级、间距尺寸、状态规则与可访问性**方面的决策。

---

## 1. 核心布局决策（5 条）

1. **列表为主角，挂载入口收进 Sheet。** 首屏不再出现常驻表单。挂载入口只有两个位置：
   header 右侧主按钮「添加服务」、空态 CTA「挂载第一个服务」。两者都打开同一个 Sheet。
   解决 390 下表单把列表推到折叠线以下的问题。

2. **服务行重排为「身份+状态 → 入口 → 元信息 → 操作」四级。**
   不再 5 行平铺。身份（名称/状态点/位置）、入口（本地/公网/口令）、元信息（端口/时间/目录）、操作（打开/移除/菜单）各有独立视觉权重。
   危险操作（停止/移除）收进「•••」菜单并需二次确认，不再与「打开」同排同权重。

3. **状态与位置不再做彩色徽标。** 运行 = 前景色实心点（深色下为白），停止 = `--muted-foreground` 灰点。
   文字与图标并用，不单靠颜色。stopped 行**去饱和**（文字降为 muted）而非整体降透明度——既保留信息，又明确不可用。

4. **1280 主区域放宽 + 容器驱动自适应。** 内容容器 `max-width: 1152px`（约 `max-w-6xl`），
   服务行用容器查询（`@container list (min-width: 720px)`）在 ≥720px 时切换为四列横排、<720px 时为纵向堆叠。
   同一份 DOM 在 390 与 1280 之间连续自适应，而非两张静态稿。

5. **口令永远打码，真值只在 JS 数据与复制动作里。** 界面任何位置只显示 `/#key=••••••`。
   「口令」入口打开 Secret 弹窗：默认打码，眼睛切换可**临时显真**（用户主动、专用弹窗内），「复制链接」始终携带真值。
   行内不渲染完整口令。

---

## 2. 信息层级

| 层级 | 内容 | 处理 |
|---|---|---|
| 一级（第一眼） | daemon 版本/运行状态、服务数概览、「添加服务」主按钮 | header 顶部，主色按钮 |
| 二级（一行扫到） | 服务名、运行/停止状态、本地入口 | 每行左侧身份区 + 入口区 |
| 三级（需要时看） | 公网入口、口令链接、端口、目录、启动/停止时间 | 行内次级行，目录截断可复制 |
| 四级（主动操作） | 停止、移除登记、关闭 daemon | 收进菜单 + 二次确认 |

**3 秒回答口径**：几个服务 → 看 header 概览；哪些在跑 → 看每行状态点；入口与口令在哪 → 看行内「本地/公网/口令」三行。

---

## 3. 间距与尺寸表

统一采用 4 的倍数（`--s1..--s8` = 4/8/12/16/20/24/32px），圆角 `--radius: 0.875rem`（sm=0.6x / md=0.8x / lg=1x / xl=1.4x）。

| 项 | 值 |
|---|---|
| 控制高度 `--row-h` | 36px（官方件几何，满足 ≥36px 触控；主按钮 40px 视觉更突出） |
| 行内小按钮 `btn-sm` | 高 32px，padding 0 10px，字号 12px |
| 卡片 padding `--pad-card` | 14px |
| 卡片圆角 | `--radius-lg`（0.875rem） |
| 卡片间距 | 8px（列表竖向 gap） |
| 服务行（≥720px）列宽 | 身份 `minmax(0,200px)` · 入口 `1fr` · 元信息 `minmax(0,230px)` · 操作 `auto`，列距 20px |
| 服务行（<720px） | 纵向：身份/操作一行 → 入口 → 元信息，行距 10px |
| 内容容器 | `max-width: 1152px`，左右 padding 24px（390 画布下 16px） |
| Sheet 桌面 | 宽 440px，右滑，全高 |
| Sheet 移动（≤640px） | 底部抽屉，`max-height: 85dvh`，顶部圆角 `--radius-xl`，body 内部滚动 |
| 状态点 | 8px 圆，运行加 3px 前景色扩散环 |

**断点**：375 / 640 / 720（容器查询）/ 1024 / 1440。行布局切换走容器查询（720px），
Sheet 形态切换走媒体查询（640px），与 shadcn 默认 `sm`/`md` 对齐。

---

## 4. 空态与状态规则

**空态**（shadcn `Empty`）：
- 主 CTA「挂载第一个服务」→ 打开 Sheet。
- CLI 备选 `stoa serve --data-dir <目录>`，附复制按钮（shadcn `Collapsible` + 复制）。
- 文案说明「为什么空 + 下一步做什么」，不出现空白屏。

**服务行状态**：
- **running**：白点 + 前景色名称；操作 = 「打开」（真实 `<a>`，生产映射 `Button asChild`）+ 「•••」（停止/移除）。
- **stopped**：灰点 + muted 名称（去饱和）；不提供会 404 的「打开」；主操作 = 内联「移除登记」（destructive outline），口令仍可复制。
- **ephemeral**：名称旁加「临时」中性标签（区别于 location=临时）。

**daemon 关闭**：header「•••」→「关闭 daemon」→ 确认 → 概览全部变停止 + 状态文案改为「daemon 已停止」。

**刷新**：手动「刷新」触发约 1.2s 的 spinner + 行微降透明（骨架感），结束后「上次刷新 Ns 前」；另有 5s 一次的轻量轮询只更新时间戳文本，不打扰。

---

## 5. 可访问性

**焦点顺序**：dev 工具栏（预览用，非产品）→ header 概览 → 刷新 → 添加服务 → 头部菜单 → 服务行（打开 → 口令 → 菜单）→ 空态 CTA。
弹层打开后焦点移入（Sheet 聚焦端口输入、菜单聚焦首项），关闭后焦点回到触发元素。

**语义与 aria**：
- Sheet：`role="dialog"` `aria-modal="true"` `aria-labelledby`。
- 确认/口令弹窗：原生 `<dialog>` + `showModal()`，Esc 触发 `cancel` 关闭，不残留状态。
- 状态点：`role="img"` + `aria-label`（运行中/已停止），与文字并用，不单靠颜色。
- 菜单：`role="menu"` / `menuitem` / `separator`；危险项 `.danger` 用 destructive 色 + 文案区分。
- 口令显隐、口令切换：`aria-pressed` 反映状态。
- Toast：`role="status"` `aria-live="polite"`。
- 复制/图标按钮：均有 `aria-label`。

**焦点可见**：全局 `:focus-visible` 用 `--ring` 描边（≥3:1），菜单项聚焦用 accent 背景。
**对比度**（深色本体）：正文 `#e7e7ea` on `#0b0b0c` ≈ 17:1；次级 `#8e8e96` on `#141416` ≈ 5.2:1；危险 `#e5484d` on 深底 ≈ 4.6:1。
浅色版独立校验：正文 `#19191c` on `#f6f6f8` ≈ 17:1；次级 `#6c6c75` on `#fefefe` ≈ 4.8:1。
**动效**：仅在 transform/opacity 上过渡（120–240ms），`prefers-reduced-motion` 下全部关闭。

---

## 6. shadcn 组件映射（`data-cmpt` 标注）

原型里每个区域都带 `data-cmpt` 属性，dev 工具栏「组件标注」开关可高亮显示。

| 区域 | shadcn 组件 |
|---|---|
| header 概览 / 版本 | `Badge` |
| 添加服务 / 打开 / 复制等 | `Button`（打开为 `Button asChild` + `<a>`） |
| 服务行 | `Card` |
| 状态点 | 纯文本 + 圆点（无官方件，注释注明） |
| 行「•••」 | `DropdownMenu` |
| 挂载表单 | `Sheet`（`SheetHeader` / `ScrollArea` body / `SheetFooter`） |
| 位置三选一 | `Tabs`（或 `RadioGroup`） |
| 端口/名称/目录/口令输入 | `Input` + `Label` |
| 表单错误 | `Alert`（destructive） |
| 空态 | `Empty` |
| 口令弹窗 / 确认弹窗 | `Dialog`（危险确认可换 `AlertDialog`） |
| Toast | `Toast`（sonner） |
| 分隔 | `Separator` |
| CLI 备选 | `Collapsible` |
| 刷新中 | `Button` + `Spinner`（`Loader2`） |

---

## 7. 1280 两种布局：list-only vs master–detail

原型提供「列表 / 主从」切换。**推荐 list-only 作为默认。**

理由：daemon 控制台的服务数通常是个位数（1–5 个），3 秒回答要求「所有服务一屏可扫描、一次点击到达打开/口令」。
list-only 的富行已经能承载身份+入口+元信息+操作，无需额外一次点击去选中才能看到详情；
master–detail 适合服务很多、需要常驻详情/日志的场景，但会多一跳，且当前后端没有可长期驻留的详情内容（无日志流）。

master–detail 在原型中实现为：左侧 380px 紧凑列表 + 右侧详情面板（仅用真实字段：入口/口令/端口/PID/目录/位置/时间 + 操作），供工程师对照成本。

---

## 8. 落地注意（工程侧）

- **字体**：原型用 `"Geist", system-ui, "PingFang SC"` 优先栈，工程侧应自托管 Geist Variable 与 Geist Mono 的 `@font-face`（原型零网络依赖，未引入 CDN）。
- **主题令牌**：颜色只定义在 `:root`（深色）与 `:root[data-theme="light"]`（浅色），组件一律 `var(--*)`。solid-glass 的 rim/hairline/阴影用 `color-mix()` 从 `--foreground`/`--border` 派生，未硬编码色值。
- **口令真值**：仅存于 JS `DEMO_SERVICES[].key`，复制动作直接读该值写剪贴板，DOM 永不渲染完整口令（显真仅发生在 Secret 弹窗用户主动切换时）。
- **「打开」**：原型用真实 `<a target="_blank">`，沙盒预览可能拦截跳转，属正常；生产映射路由/`window.open`。

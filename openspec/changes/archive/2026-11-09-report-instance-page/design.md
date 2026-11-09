# Design: report-instance-page（实例管理页 + 回复上下文完整显示）

> Owner 2026-11-08 两条指令：①「连接其它实例」重做成「实例管理」页，移动端可用；
> ② 回复时原帖内容不再截断，长帖可滚动看完，回复编辑器始终可达。

---

## 0. 决策摘要

| # | 决策 | 理由 | 被否方案 |
|---|------|------|----------|
| D1 | 页面信息架构固定为：品牌/用途 → 当前连接 → 添加实例 → 我的实例 → 可折叠用法；桌面左（当前+添加）/右（我的实例+用法） | 管理语义优先：先看当前，再添加，再管理历史 | 保留「大段说明 + 输入框」叙事页 |
| D2 | 「当前连接」数据来自 `ConnectionProvider` 的**内存快照**（离开 ready 时捕获），不落盘、不新增接口 | 只有「从已连接状态进来」才有值，语义精确；刷新后自然回到「当前未连接」 | 从历史首项推断（把「上次连接」误当「当前」） |
| D3 | 历史存储兼容升级：`report.ep.history` 允许 `string \| {url,lastUsedAt}`，新写入统一为对象数组 | 旧数据零迁移可读；新数据能显示最后使用时间 | 新 key（旧历史丢失）/ 强制迁移（首启写盘） |
| D4 | 在线探测复用 `GET /healthz`，5s 超时，按 `ok===true && typeof instanceId==="string"` 判 report 实例 | healthz 是既有接口；与同源探测同一判据 | 新增 `/api/version` 等接口 |
| D5 | 添加实例提交前**先探测再 connect**；失败就地 Alert，不进入连接流程 | 错误在表单旁可读，不把用户甩到错误页；`connect()` 本身不变 | 只依赖 `connect()` 的错误页 |
| D6 | 历史条目操作＝连接 / 移除；离线条目额外「重试」；卡片头「清空历史」 | 一屏完成管理动作；移除与清空均即时同步 localStorage | 进入二级详情页管理 |
| D7 | 移动端所有可点目标 `min-h-11`（44px）/ icon `size-11`；桌面恢复标准尺寸 | 满足移动命中区，同时不牺牲桌面密度 | 全端 44px（桌面过松） |
| D8 | 页面滚动放在实例页根容器（`min-h-dvh max-h-dvh overflow-y-auto`），不用 `body` 滚动 | 壳全局 `body{overflow:hidden}`，根容器滚动才能既保底部安全区又不裁切 | 改全局 body（影响所有页面） |
| D9 | 回复原帖正文完整渲染，独立容器 `max-h-[40dvh] overflow-y-auto overscroll-contain`；外层内容区**不滚动** | 长帖可读完、编辑器始终可达；只有一层主滚动，无滚动链冲突 | 外层整体滚动（原帖 + 编辑器一起滚）/ 保留 clamp |
| D10 | 全部 UI 用官方收编件；颜色/间距走主题令牌 | 项目纪律（shadcn 一手源、禁手写组件、禁硬编码色） | 自绘列表行/输入框 |

---

## 1. 现状与接入点（path:line）

- 落地页现状：`src/ui/pages/LandingPage.tsx:64`（`min-h-dvh` 居中容器）、`:74-88`（品牌 +
  大段说明）、`:92-146`（输入框 + 错误 Alert + 说明）、`:150-190`（历史后端列表）、
  `:192-224`（用法卡）。历史列表无状态、无最后使用时间。
- 历史存储：`src/ui/lib/ep.ts:128`（`loadEpHistory`，`string[]`，最多 8）、
  `:138`（`rememberEp`）、`:147`（`forgetEp`）；key `report.ep.history`。
- ep 校验：`src/ui/lib/ep.ts:27`（`checkEp`）；同源探测 `:70`（`probeSameOriginEp`）。
- 连接生命周期：`src/ui/state/connection.tsx:265`（`logout`）、`:284`（`switchBackend`）
  都先清空状态再 `setPhase("landing")`，因此落地页拿不到刚离开的实例信息。
- 落地页挂载：`src/ui/App.tsx:70`（`phase === "landing"` → `<LandingPage />`）。
- 回复上下文：`src/ui/components/ReplyComposer.tsx:55`（外层 `overflow-y-auto` 内容区）、
  `:66`（`line-clamp-6` 截断）。
- 壳全局滚动约束：`src/ui/app.css:24-31`（`html/body/#root{height:100%}`、`body{overflow:hidden}`）。

## 2. 页面信息架构

```
实例管理页（根容器：min-h-dvh max-h-dvh overflow-y-auto overscroll-contain）
└─ max-w-6xl 容器（px-4/6，safe-area 上下内边距）
   ├─ 品牌行：glass-primary "R" + report + vX + 一句话用途
   └─ 响应式网格
      ├─ 左列（lg:1.1fr）
      │  ├─ Card「当前连接」
      │  └─ Card「添加实例」
      └─ 右列（lg:1fr）
         ├─ Card「我的实例」（清空历史在 CardAction）
         └─ Card「如何启动实例」（Collapsible，默认收起）
```

- 移动端（<1024px）单列，顺序同上；桌面两列。
- 所有卡片 `min-w-0`，地址用 `break-all`/`truncate`，保证 390px 无横向溢出。

## 3. 数据与状态

### 3.1 历史条目

```ts
export interface EpHistoryEntry {
  url: string;
  /** epoch ms；旧格式（string[]）条目为 0，界面显示「时间未知」 */
  lastUsedAt: number;
}
```

- 读：接受 `string | {url,lastUsedAt}` 混合数组；逐项 `checkEp` 过滤、按 URL 去重、
  保持存储顺序（最近在前）、截断 8 条。
- 写：`rememberEp(url)` 置顶并写 `lastUsedAt=Date.now()`；`forgetEp(url)` 移除；
  `clearEpHistory()` 清空。
- 兼容：`loadEpHistory()` 保留（返回 `string[]`），内部委托新解析器。

### 3.2 健康探测

```ts
export interface EpHealth {
  ok: boolean;
  error?: string;
  instanceId?: string;
  version?: string;
}
export async function probeEpHealth(url: string, timeoutMs = 5000): Promise<EpHealth>;
```

- 请求 `${checkEp(url).url}/healthz`，`credentials:"omit"`、`cache:"no-store"`、
  `AbortSignal.timeout(timeoutMs)`。
- 判定：HTTP 2xx、JSON、`ok === true`、`instanceId` 为字符串。
- 错误文案（可读、无敏感内容）：超时 / HTTP 状态 / 非 JSON / 非 report 协议 / 网络错误。
  不读取响应体、不打印 token、不打印完整 URL 之外的数据。
- 页面内每个历史条目一个探测任务；`probing | online | offline` 三态；离线可重试。

### 3.3 当前连接快照

```ts
export interface ConnectionSummary {
  ep: string;
  staticMode: boolean;
  authMode: "open" | "auth" | null;
  account: { id: string; role: "owner" | "manager" | "agent" } | null;
}
```

- `finishReady` 成功时更新快照；`switchBackend` / `logout` **不清空**快照。
- 落地页读取快照：有值 → 显示地址/在线或静态/模式/身份；无值 → 「当前未连接」。
- 快照只在内存，刷新即无——符合「仅在从已连接状态进来时有值」。

## 4. 交互细节

- **添加**：提交 → `checkEp`（失败就地 Alert）→ `probeEpHealth`（失败就地 Alert）→
  `connect(url)`。探测中按钮禁用并显示 `Spinner`；错误 Alert 用官方
  `Alert variant="destructive"`，`data-testid="ep-error"`。
- **连接历史项**：`connect(url)`（走既有登录门/错误页）。
- **移除**：`forgetEp` + 本地列表刷新；无确认弹窗（可逆：重新添加即可）。
- **清空**：`clearEpHistory` + 列表清空，切到官方 `Empty` 空态。
- **复制地址**：`copyText`（既有 clipboard 回退）；成功后 `toast.add` 轻提示，
  `aria-label` 明确「复制地址」。
- **重试**：只重跑该条 healthz 探测，不改连接状态。
- 保留 `data-testid="ep-input"` / `ep-connect`（既有 QA 依赖）。

## 5. 移动端度量

| 项 | 判据 |
|----|------|
| 布局 | 390px 单列；`scrollWidth <= clientWidth`（页面与卡片均无横向溢出） |
| 高度 | 根容器 `min-h-dvh max-h-dvh` + 内容可滚动；上下 safe-area `env(safe-area-inset-*)` |
| 命中区 | 所有 `button` / `[role=button]` 的 `getBoundingClientRect()` 宽高 ≥44px（<640px） |
| 地址 | `break-all`，长 URL 不撑破卡片 |
| 键盘 | 输入框不 autoFocus（避免移动端首屏弹键盘） |

## 6. 回复上下文布局

```
DialogContent（grid rows: header / body，body 不滚动）
├─ header（关闭 X + 标题）
└─ body（flex column, min-h-0, overflow-hidden）
   ├─ 原帖行（头像 + 作者行 + 正文容器）
   │  └─ 正文容器：max-h-[40dvh] overflow-y-auto overscroll-contain
   │     └─ Markdown 完整正文（无 line-clamp）
   ├─ 回复给 @author
   └─ PostComposer（InputGroup，textarea 自身滚动）
```

- 长帖：正文容器内部滚动到底可见最后一行；外层 `scrollHeight <= clientHeight`。
- 编辑器：移动端 textarea `min-h-[32dvh]`、桌面 `sm:min-h-32`，始终在视口内。
- 移动端 390×844、桌面 1280×900 两形态验收。

## 7. 官方组件收编清单

`Card / CardHeader / CardTitle / CardDescription / CardContent / CardAction`、
`Button`、`InputGroup / InputGroupAddon / InputGroupButton / InputGroupInput`、
`Badge`、`Alert / AlertTitle / AlertDescription`、`Empty / EmptyHeader / EmptyMedia /
EmptyTitle / EmptyDescription`、`Collapsible / CollapsibleTrigger / CollapsibleContent`、
`Spinner`、`Separator`。图标一律 lucide 单色。

## 8. 验收矩阵（A1-A10）

| # | 场景 | 判据 | 视口 |
|---|------|------|------|
| A1 | 页面结构 | 品牌 + 一句用途可见；无大段陈述文；卡片标题齐全 | 390 / 1280 |
| A2 | 当前连接（无） | 首次进入显示「当前未连接」 | 390 / 1280 |
| A3 | 当前连接（有） | 从 ready 点「连接其它实例」→ 显示地址/在线/模式/身份；复制按钮可用 | 1280 |
| A4 | 我的实例 | 历史项显示地址、最后使用时间、在线/离线 Badge；无历史显示官方 Empty | 390 / 1280 |
| A5 | 历史操作 | 移除后条目与 localStorage 同步消失；清空后 Empty；连接按钮进入连接流程 | 390 / 1280 |
| A6 | 添加实例 | 非法 http 就地 Alert；离线目标就地 Alert；在线目标通过预检进入连接 | 390 |
| A7 | 在线探测 | 在线→「在线」；离线→「离线」+ 重试；重试后状态翻转；超时不悬挂 | 390 |
| A8 | 移动端度量 | 390 无横向溢出；所有可点目标 ≥44px；safe-area 生效 | 390 |
| A9 | 桌面两列 | 左列含「当前连接」「添加实例」，右列含「我的实例」；两列不重叠 | 1280 |
| A10 | 回复上下文 | 长帖完整（无 clamp）、容器可滚到底、编辑器在视口内、外层无第二层滚动 | 390 / 1280 |

## 9. 风险与非目标

- **风险**：历史旧数据无时间戳 → 显示「时间未知」；不做迁移写盘。
- **风险**：跨域 healthz 被 CORS 拦截 → 归类为「网络错误」，不误报在线。
- **非目标**：实例别名/排序/分组、跨设备同步、后台定时探测、服务端新增接口。

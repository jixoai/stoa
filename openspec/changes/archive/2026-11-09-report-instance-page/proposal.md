# Proposal: report-instance-page（实例管理页 + 回复原帖完整显示）

## 背景（Owner 2026-11-08 两条指令）

1. **「连接其它实例」页面重做成「实例管理」页。** 现状 `src/ui/pages/LandingPage.tsx` 是
   「输入框 + 大段说明文字」：品牌与用途混在陈述段里，历史后端只列地址、没有状态与操作语义，
   移动端单列时内容被 `body{overflow:hidden}` 裁切且可点目标偏小。用户看不出这是一个
   **管理多个实例**的地方。
2. **回复时原帖内容不再截断。** `src/ui/components/ReplyComposer.tsx:66` 用
   `line-clamp-6` 把原帖正文截成 6 行——回复者看不到完整上下文，长帖只能回详情页翻看。

## 变更内容

### 一、实例管理页（`LandingPage` 重做）

- **顶部品牌 + 一句用途**：保留 `report` 品牌与版本徽标，用途收敛为一句话
  「人机公示板 · 管理你连接的实例」；删除原有大段陈述文与功能徽标堆叠。
- **当前连接卡**：显示地址（可复制）、在线/静态、认证模式、身份（账号 + 角色）。
  仅在**从已连接状态进入本页**（切换实例/退出登录）时有值；首次进入或刷新后无值，
  显示「当前未连接」。数据来自连接层在离开 ready 时留下的内存快照，不新增后端接口。
- **我的实例**：`localStorage` 历史（`report.ep.history`，最多 8 条）。每项显示地址、
  最后使用时间、在线探测状态（`GET /healthz`，带超时；不可达显示「离线」+ 重试）；
  操作：**连接 / 移除**；卡片头支持**清空历史**；无历史时使用官方 `Empty` 空态。
- **添加实例**：官方 `InputGroup` 表单；校验沿用 `checkEp`（https 或本机回环 http）；
  提交前探测 `/healthz`，失败**就地 Alert**（超时/HTTP 状态/非 report 协议/网络错误可读，
  不打印 token 或响应体），成功后调用既有 `connect()`。
- **如何启动实例**：收进官方 `Collapsible`，默认收起，保留原 3-4 条用法。
- **响应式**：移动端单列、`min-h-dvh` + safe-area、可点目标 ≥44px、无横向溢出；
  桌面两列（左：当前 + 添加；右：我的实例 + 用法）。
- 全部使用官方 `Card / Button / InputGroup / Badge / Alert / Empty / Collapsible` 收编件。
- **契约不变**：`?ep=` 解析与 `connect()` 行为不变；不引入新的后端接口（healthz 已有）。

### 二、回复原帖完整显示

- 删除 `ReplyComposer` 原帖正文的 `line-clamp-6`；正文完整渲染。
- 原帖正文放入独立可滚动容器（`max-h-[40dvh]`、`overflow-y-auto`、`overscroll-contain`），
  长帖可滚动看完。
- 编辑器本体不再随原帖增长；同一时刻只有原帖上下文**一层主滚动**（外层内容区不滚动，
  避免滚动链冲突），回复编辑器始终可达。
- 移动端全屏与桌面 Dialog 两形态都按同一结构验证。

## 非目标

- 不改后端 API / schema / SSE / healthz 响应结构；不做实例重命名、分组、排序。
- 不做跨设备实例同步；历史仍只在本机 `localStorage`。
- 不改变 `connect()`、登录门、`?ep=` 覆盖顺序与 token 存储键。
- 不改回复编辑器的提交、附件、markdown、@ / # 能力。
- 不改 feed 卡片 6 行截断（仅回复上下文不再截断）。

## 影响面

- 修改：`src/ui/pages/LandingPage.tsx`（重做）、`src/ui/lib/ep.ts`（历史条目时间戳 +
  健康探测）、`src/ui/state/connection.tsx`（离开 ready 时的连接快照）、
  `src/ui/components/ReplyComposer.tsx`（去截断 + 单层滚动）。
- 新增：`scripts/qa/instance-page.mjs`（Playwright 验收）、
  `openspec/changes/report-instance-page/**`。
- 证据：`.agents/reports/manager/report-instance-page/`（gitignored）。

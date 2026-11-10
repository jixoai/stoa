# Design: stoa-daemon-console-layout

## 1. 方向

**监控优先（Dashboard-first）+ 触发式 Sheet。** 页面主体是服务列表；挂载是一个轻动作，
从 header 主按钮或空态 CTA 打开官方 Sheet。与现有 solid-glass 卡片语言零冲突，改动集中在一页。

备选（本期不做）：1280 双栏（左列表 / 右详情）。若后续服务数经常 >8 再评估。

## 2. 页面结构（自上而下）

1. **Header**（单行）
   - 左：PowerIcon + `Stoa Daemon` + 版本（弱化为纯文本或 outline badge）+ 状态概览
     （`● 运行中 N / 共 M`）。
   - 右：刷新（ghost/outline icon+文字）+ **「添加服务」主按钮**（实心 primary，`daemon-mount-open`）。
   - 390：保留标题、版本与「添加服务」；pid/启动时间收进轻量披露（tooltip/popover 或省略）。
2. **概览条**（可选，轻量）：运行中数量、端口段、状态目录（可复制，截断 + title）。
3. **服务列表**（主角）
   - 每行：身份区（名称 + 状态点/徽标 + 位置图标/文本）→ 入口区（本地 URL、公网 URL，等宽字体）
     → 元信息（端口、启动/停止时间、目录尾部两段）→ 操作区。
   - 操作层级：主 = 「打开」（running 且 url 存在）；次级 = 「口令」；危险 = 停止/移除
     （收进 DropdownMenu 或二次确认 Dialog）。
   - stopped：去饱和（文字/图标降对比），不显示「打开」；保留「口令」与「移除登记」。
   - 390：单列，操作区整行或菜单；触控目标 ≥36px（官方件几何，不拉伸组件）。
   - 1280：内容区放宽（目标 `max-w-5xl`~`6xl`，实际档位以设计稿为准）；
     身份/入口/元信息形成可扫视的列锚点；操作右对齐成簇。
4. **空态**：Empty 组件；主 CTA「挂载第一个服务」（打开 Sheet）；CLI 命令作为次要折叠块
   （可复制），不与主 CTA 并列。
5. **「关闭 daemon」入口**：header 右侧「更多操作」（`DropdownMenu`）→ 二次确认 `Dialog`；
   页面底部只留只读说明（不再有常驻关闭按钮）。

## 3. 挂载 Sheet

- 官方 `Sheet`；`side="bottom"`（<640px）/ `side="right"`（≥640px）。
  桌面宽约 420–480px；移动 `max-h: 85dvh`，内容区 `ScrollArea`，footer 固定。
- 结构：SheetHeader（标题/描述）→ 位置 Tabs（自动/临时/自定义 + helper）→ 自定义目录
  （Input + 选择文件夹）→ 端口/名称（两列，390 单列）→ 访问口令 → 错误 → footer（取消/挂载）。
- 错误：字段下方就地显示（`aria-invalid` + 文本），底部只保留全局错误；端口错误在重新输入时清除。
- 关闭语义：成功提交自动关闭 + toast；手动关闭重置表单与错误；焦点返回 `daemon-mount-open`。
- a11y：`SheetTitle` + `SheetDescription` 必填；表单 label 与 input 关联；错误用 `aria-describedby`。

## 4. 组件映射（全部官方收编件）

| 区域 | 组件 |
|---|---|
| 页面外壳 | `Card` / `Separator` |
| 入口 | `Button`（primary / outline / ghost） |
| 状态 | `Badge`（outline + 状态点）/ 纯文本 |
| 服务行 | `Card` 内分区 或 `div` + `Separator`（形态随设计稿） |
| 危险操作 | `DropdownMenu` 或 `Dialog` 二次确认 |
| 挂载面板 | `Sheet` / `SheetContent` / `SheetHeader` / `SheetTitle` / `SheetDescription` / `SheetFooter` |
| 表单 | `Tabs` / `Input` / `Label` / `Button` / `Alert` |
| 空态 | `Empty` / `EmptyHeader` / `EmptyMedia` / `EmptyTitle` / `EmptyDescription` |
| 反馈 | `toast` / `Spinner` |
| 复制 | `copyText` + ghost icon Button |

禁止新增手写控件、彩色徽标、硬编码色值；图标只用 lucide 单色。

## 5. 尺寸与断点（初版基线，允许按设计稿微调）

- 内容容器：390 全宽 16px padding；≥640 `max-w-3xl`；≥1024 目标 `max-w-5xl`（设计稿若给更大值按稿）。
- 间距：8px 网格；卡片 padding 16–24；行间距 8–12；helper 与字段 6–8。
- 服务行最小高度：390 ≥64px（含两行文本 + 操作）；操作按钮高度沿用官方 `size="sm"` 几何
  （约 32px）+ 周边命中区补足，不拉伸几何。
- Sheet：桌面 `w-[440px]`（420–480 区间），移动 `max-h-[85dvh]`。

## 6. testid 契约（QA 复用）

保留：`daemon-location-tabs` / `daemon-location-auto|temp|path` / `daemon-mount-data-dir` /
`daemon-mount-port` / `daemon-mount-name` / `daemon-mount-key` / `daemon-mount-submit` /
`daemon-mount-error` / `daemon-pick-dir` / `daemon-service-<id>` / `daemon-secret-<id>` /
`daemon-stop-<id>` / `daemon-remove-<id>` / `daemon-services` / `daemon-refresh`。

新增：`daemon-mount-open`（header 主按钮）、`daemon-mount-sheet`（Sheet 面板）、
`daemon-mount-empty-cta`（空态主 CTA）。

## 7. 风险

- Sheet 在 390 内容较高：必须内部滚动 + 固定 footer，避免提交按钮被键盘遮挡。
- 危险操作收起后 QA 与可发现性下降：菜单项文案明确（「停止服务」/「移除登记」），
  停止需确认；已有 testid 移到菜单项上。
- 1280 放宽后列表行变长：信息必须形成列锚点，否则扫视更差。
- 纯 UI 变更：daemon 进程无需重启即可生效（UI 按请求从 dist 读取）；版本徽标仍显示运行版本，
  发布说明中注明。

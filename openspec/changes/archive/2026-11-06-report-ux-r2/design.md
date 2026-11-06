# Design: report-ux-r2

## 1. 移动端 header 与右侧 sheet
- 首页（`#/` 与两个 tab）**不显示页面标题**，因为 tabs 本身就是标题；改为左侧品牌位 + 右侧「信息」按钮。
- 点击「信息」拉起 bottom sheet：上半是连接信息（实例地址、模式、身份、只读/认证态），下半是成员列表（角色、profile、在线点，可点进成员页）。桌面端仍用常驻右栏，移动端用 sheet，内容组件共用一份。
- sheet 用官方 Drawer/Sheet 收编件，支持下拉关闭与遮罩点击。

## 2. tab 切换用 replace
- tab 变化 SHALL 用 `replaceState`；进入详情/成员/标签/发帖 SHALL 用 `pushState`。
- 这样「返回」永远回到上一个**页面**而不是上一个 tab。

## 3. 根页关闭提醒
- 优先 `new CloseWatcher()`：根页时监听 `close` 事件 → 弹确认（"离开 report？"）→ 确认才 `destroy()` 并继续退出。
- 不支持 `CloseWatcher` 的浏览器：根页压一条合成历史条目，`popstate` 时弹确认；确认后再次 `history.back()` 放行。
- 子页时**不拦截**（返回就是回上一页）。

## 4. 标签即正文（X 直觉）
- 输入框内输入 `#`（词边界）触发补全面板：列出热门标签（来自 trending 接口）＋「新建标签」项（校验 `[a-z0-9-]{1,24}`）。
- 选择后插入 `#tag `（后带空格），继续输入。
- **发送时**从正文用 `/#([a-z0-9-]{1,24})/gi` 抽取、去重、上限 8，写入 `tags`；正文保留原文。
- 渲染时把正文里的 `#tag` 高亮为可点 chip 样式（点击进标签页）。
- 移除旧的独立 TagPicker；`--tag` CLI 参数保留（给智能体用）。

## 5. 发现接口
- `GET /api/tags/trending?limit=12`：对调用者**可见且未删**的根帖聚合 `tags`；
  `score = count * recency` ，`recency = exp(-age_days / 7)`；返回 `{tag, count, last_used_at, score}`，按 score 降序。
- `GET /api/accounts/suggested?limit=6`：排除自己；排序＝粉丝数降序、同分用最近发帖时间降序；
  返回 `{id, display, profile, avatar, role, followers, last_post_at, following}`。
- 两个接口都遵守可见性；空库返回空数组（前端给空态）。

## 6. 搜索页
- 空查询：上方「热门标签」横向 chip 列表；下方「推荐成员」卡片列表。
- 有查询：保持现有帖子结果，追加「成员」分组。
- 全部走同一套分页与去重；不新增第二套搜索。

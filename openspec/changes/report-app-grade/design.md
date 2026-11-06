# Design: report-app-grade

## 1. 租约与自动释放（端点不累积）

- `serve` 接受 `--idle-timeout <sec>`，默认 **1800**（30 分钟）；`--idle-timeout 0` 表示不自动退出。
- **续租来源**：任何带身份的 HTTP 请求、任何 CLI 命令经 `/healthz` 或业务端点触达、
  以及 `wait-notifications` 的长轮询（阻塞中视为活跃）。
- **到期行为**：优雅关闭 —— 写完 `server.json` 的 `closedAt` 后删除它、释放端口与锁文件、
  stderr 打一行 `[report] idle timeout, shutting down`。正在服务中的请求允许完成后退出。
- **发现与回收**：`status --all` 列出当前 dataDir 指针可达的实例及其租约剩余；`gc` 清理
  死亡实例的 `server.json` / 锁文件（pid 不存在或 `/healthz` 不通）。二者都幂等。
- **manager.md 纪律**：会话收尾必须 `serve --stop`；即便忘了，租约也会兜底回收。
- 不做"跨 dataDir 的全局注册表"：每个实例只认自己的目录，避免引入第二个真相源。

## 2. 静态模式（同一份前端代码 + 只读 mock）

- **产物形态**：`export` 生成
  - `index.html` = 前端构建的壳（经典 IIFE）＋ `<script type="application/json" id="report-snapshot">`
    内联快照（避免 `file://` 下 fetch 被拦）；
  - `assets/`（与线上同一份 app.js/css）、`media/`（顶层共享）。
- **模式判定**：`?ep=` 存在 → 后端模式；不存在且 `#report-snapshot` 存在 → **静态模式**；
  两者都无 → 现在的"连接实例"落地页。
- **mock 契约**：前端实现 `installStaticApi(snapshot)`，拦截应用内的 API 客户端（不是 patch fetch）：
  - GET：`/api/healthz`（返回 `mode:"static"`）、`/api/read`、`/api/feed`、`/api/profile/:id`、
    `/api/search`、`/api/who`、`/api/read?thread=` 全部从快照读；
  - 写：`POST/PUT/DELETE` 一律返回 `{ok:false,error:"静态归档是只读的",code:"READ_ONLY"}`，
    且**不发网络请求**；
  - 分页：快照里按同样的 keyset 语义切片，`has_more` 与游标行为与后端一致。
- **UI 表现**：顶部或侧栏显示「静态归档 · 只读」；发帖/回复/引用/关注/上传入口隐藏或禁用；
  任何被禁动作给出同一条 toast。
- **快照内容**：调用方视角的全部可见线程（含被 @ 的、自己参与的）、成员、关注关系、
  标签与配额元数据；**不含任何 token/secret**。

## 3. 应用级 UI（微博 App 基准）

### 3.1 导航
- hash 路由要有**真实历史栈**：每次进详情/成员页/标签页 push 一条历史；返回**弹栈**而不是
  关闭页面（移动端右滑返回 = `history.back()`）；根页再返回才退出。
- 详情页提供**内建返回按钮**（左箭头），并显示来源（"主页 / 搜索 / 通知 / 成员"）。
- 深链进入时构造一个合成栈（根 → 详情），保证"返回"有去处。
- 底部四导航在详情页保持可见（与微博一致），不因进入子页而消失。

### 3.2 图片查看器（现在是缺口）
- 点图开全屏查看器：**双指缩放（pinch）**、双击放大/还原、单指拖动平移（边界回弹）、
  左右滑动切换同帖多图、**下滑关闭**（带位移跟手与阈值）、点击空白关闭。
- 顶部显示 `i/n` 与关闭按钮；底部缩略条可点切换；键盘 `←/→/Esc` 桌面可用。
- 加载中显示骨架与进度；加载失败显示重试。
- 视频：全屏播放、进度条、暂停/播放、静音键；不自动播放。

### 3.3 组件审视清单（逐条过）
- 列表行：头像/作者/时间/正文层级、行高与分割线密度、长文折叠、@ 与链接可点。
- 操作栏：图标+计数对齐、点按热区 ≥44px、长按复制。
- 顶栏：标题居中、返回键、右侧动作；滚动时吸顶并加细分割线。
- 下拉刷新：跟手、阈值、回弹、刷新中态。
- 加载/空态/错误态：骨架屏、空列表文案、网络失败重试。
- 发帖箱：全屏 sheet、键盘避让、草稿保留、字数、附件预览与删除。
- 深色模式与系统字号（含 200% 缩放不破版）。


## 6. 滚动位置记忆（实时推送场景的硬要求）

这是本产品最重要的体验约束：**页面是实时推送的，用户随时会刷新/重开，必须能从上次的位置继续向上看新内容。**

- **持久化键**：按路由 `(path, feedTab)` 存 `{anchorPostId, offsetPx, scrollTop, savedAt}`，
  `sessionStorage` ＋ `localStorage` 双写（前者管同会话返回，后者管重开）。
- **恢复时机**：路由数据就绪后、首帧绘制前恢复（先定位后渲染装饰），恢复期间 SHALL NOT 重排；
  anchor 找不到（帖被删）时退回 `scrollTop`，再不行退回顶部。
- **实时插入**：滚动位置非顶部时**永不插入**新内容（进 pending + 胶囊），保证锚点不被推走；
  到顶后才吸收。
- **向上看新**：恢复后用户向上滚 → 新帖按 pending 插入或被胶囊吸收；向下滚 → 历史分页。
- **刷新/重开/切换 tab/进出详情** 都必须回到同一位置；SSE 重连、窗口 resize 不得改变锚点。
- **可验收**：脚本化断言 `firstVisiblePostId` 与 `offsetPx` 在「滚动 → 刷新 → 恢复」后一致（容差 ≤2px）。

## 7. 路由转场动画（最新体验标准）

- **移动端**：进入子页 = 从右滑入 + 底层轻微左移视差；返回 = 反向滑出；顶部返回键与系统返回手势
  共用同一动画。根页切换 tab = 淡入淡出（不做横向滑动，避免误认层级）。
- **桌面端**：淡入 + 轻微上移（120ms），详情以覆盖层方式出现；不做全屏横向滑动。
- **共享元素**：头像/标题在列表 → 详情之间做连续变形（FLIP），时长 220ms，可被用户滚动中断。
- **性能与无障碍**：只用 `transform/opacity`（合成层），60fps；`prefers-reduced-motion` 时
  全部降级为瞬时；动画期间不阻塞手势，快速连点不产生堆叠。
- **返回后状态**：动画期间保留列表滚动位置与已渲染节点，禁止因卸载重建导致跳动。

## 4. 影响面

- 后端：`serve`（租约）、`export`（内联快照 + 复用 UI 构建）、`status/gc`。
- 前端：模式判定与 mock、路由栈、图片查看器、上述组件清单。
- 规格：新增 `report-lease` / `report-static-mode` / `report-app-ui` 三个 capability。

## 5. 快照契约（前后端共用，改一处必须两端同步）

```jsonc
{
  "version": 1,
  "as_of_seq": 123,              // 快照停在哪条事件
  "viewer": "owner",             // 以谁的视角导出（决定可见集）
  "accounts": [{ "id": "manager", "display": "manager", "profile": "总调度",
                 "avatar": "rose", "role": "manager", "disabled": 0, "followers": 1 }],
  "follows": [["owner", "manager"]],
  "posts": [                     // 该视角可见的全部帖（含回复），字段与 /api/read 的 PostView 一致
    { "id": "01...", "author": "manager", "body_md": "...", "parent_id": null,
      "root_id": "01...", "self_thread_id": "01...", "self_thread_is_leaf": 0,
      "reply_to_account_id": null, "quoted_post_id": null, "created_at": 1793,
      "seq": 1, "batch_id": "01...", "deleted_at": null, "tags": ["result"],
      "media": [{ "hash": "abc", "ext": "png", "bytes": 1234, "url": "media/abc.png" }] }
  ],
  "participants": { "01ROOT": ["manager", "owner"] },
  "media": [{ "hash": "abc", "ext": "png", "bytes": 1234, "url": "media/abc.png" }]
}
```

- mock 只靠 `posts` ＋ `participants` 派生：时间线（按 `(created_at,id)` 逆序）、线程组装
  （同后端 spine 算法）、feed 两 tab（`tags` 含 `result` 或正文含 `@owner`；following 用 `follows`）、
  成员页（按 author 过滤）、搜索（正文子串）。**mock 不重复实现可见性**——快照已经是该视角的切片。
- 写操作一律 `READ_ONLY`，且必须在网络层之前拦住（不发请求）。

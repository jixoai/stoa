# Tasks: stoa-daemon-console-layout

> 判据不满足不得勾选。口令/口令链接不得出现在截图、日志、报告；测试使用隔离 HOME/state-dir。

## S1. 规格与设计对齐

- [x] S1-1. 建立 change；`openspec validate stoa-daemon-console-layout --strict` 通过。
- [x] S1-2. 锁定 OpenDesign 设计稿（`index.html` + `design-notes.md`）并转成实现清单：
  区域/组件映射、断点、Sheet 尺寸、操作层级、空态文案。
  - 判据：设计稿逐区域能对应到本仓官方收编件；无新视觉语言/新控件。
  - 证据：OpenDesign run 0039a2d7（artifact `index.html`，63KB）；`design-notes.md` 已收编至
    `design/open-design-notes.md` ＋ `design/PROVENANCE.md`；12 张 390/1280 设计稿渲染过 vision 评审
    （结论「采纳并修改」，3 P0 + 8 P1 已全部落地）。

## S2. 挂载入口 Sheet 化

- [x] S2-1. 移除常驻挂载 Card；header 增加「添加服务」主按钮（`daemon-mount-open`），
  空态增加主 CTA（`daemon-mount-empty-cta`），二者打开同一 Sheet（`daemon-mount-sheet`）。
  - 判据：首屏 390/1280 无表单字段常驻；两个入口都能打开面板。
  - 证据：QA L1-1（390 首屏 `daemon-mount-data-dir` 不存在、CTA 可见）、L2-1/L2-2（双入口开同一面板）、
    L3-3（关闭后焦点回触发钮）。
- [x] S2-2. Sheet 形态：<640px 底部抽屉（`max-h: 85dvh` 内部滚动），≥640px 右侧约 440px；
  含 SheetTitle/SheetDescription；提交成功关闭 + 重置 + toast；关闭清空错误并重置；焦点回触发钮。
  - 判据：390 打开后提交按钮在键盘弹出时仍可达；Esc/遮罩/关闭按钮均可用。
  - 证据：QA L2-3（390 抽屉贴底 y=346/高 498）、L2-4（1280 右侧 440px 全高）、L3-3（关闭重置 + 焦点）、
    S4-4/S4-5（提交成功关面板 + 列表新增 + toast）。键盘弹出的真机可达性为未覆盖项（报告 env 已登记）。

## S3. 控制台布局与操作层级

- [x] S3-1. Header：版本弱化、运行中计数、刷新；390 的 pid/启动时间收进轻量披露。
  - 证据：QA L4-1/L4-2（390 首屏概览 + 行 + 入口）、L6-2（2 服务态）、截图 `daemon-list-390.png`。
- [x] S3-2. 服务行分层：身份+状态 → 入口 → 元信息 → 操作；「打开」唯一主操作、
  「口令」次级、停止/移除收进菜单或二次确认；stopped 去饱和且无「打开」。
  - 判据：running 行一次点击可打开；停止/移除需二次确认或菜单；testid 保留。
  - 证据：QA L5-1（`daemon-open-*` 为真实 `<a href=service.url>`、停止/移除行内不可见）、
    L5-2/L5-3（菜单 + 二次确认，取消无 POST /stop）、S4-6（真停）、L9-2/L9-3（stopped 行无「打开」、
    仅「移除登记」）。
- [x] S3-3. 空态：单一主 CTA + 折叠 CLI 备选（可复制）；390 不再被视口底边截断。
  - 证据：QA L1-1/L1-2（空态唯一实心 CTA；header 降级 ghost）、S4-2b 空态截图；
    失败态修正：`emptyState = !loading && !loadError && !daemonDown && services.length === 0`，
    `loadError` 时渲染错误态（`daemon-retry`）而非 `Empty`（实现方 route-mock 探针 10/10）。
- [x] S3-4. 次级信息：状态目录与行内路径可复制；截断文本有 title。
  - 证据：QA S4-2/S4-2b 新增断言（390/1280 各一组）：剪贴板 === 完整 stateDir / dataDir，
    `title` 含完整路径；复制钮升为 `icon-sm`（28×28）。
- [x] S3-5. 表单错误就地（字段下方、`aria-describedby`）；端口校验错误重新输入时清除；
  可选字段不逐个标注「可选」。
  - 证据：QA L3-1（错误距字段 6px）、S4-3（errors=1 / alerts=0）、L3-2（端口错误输入即清）。

## S4. 响应式与可访问性

- [x] S4-1. 390（844 高）：首屏可见概览 + ≥1 服务行 + 添加入口；无横向溢出；
  操作命中区达标（官方件几何 + 周边补足）。
  - 证据：QA L1-1/L4-1 首屏断言；溢出改为滚动容器 + 列表容器 + 行右缘三测，
    负向对照（注入 2000px 子元素）证明断言非假阴性；复制钮 28px（官方 `icon-sm` 几何）。
- [x] S4-2. 1280：内容区放宽、行内信息列对齐、无大片空置；Sheet 右侧不遮入口。
  - 证据：QA L4-2（容器 1152px、行高 <110、四列横排）、L2-4（Sheet 440×900 贴右）。
- [x] S4-3. a11y：焦点顺序、Sheet 标题关联、按钮可达名称、错误播报；暗/亮主题均检查。
  - 证据：SheetTitle/SheetDescription 具备；焦点归还（L3-3 ＋ 空态 CTA 成功路径探针）；状态点 `aria-hidden`
    + 相邻文字（有意偏差，避免重复播报，登记于报告 env）；口令显隐钮 `aria-pressed`。
    暗色主题为未覆盖项（报告 env 已如实登记）。

## S5. 验证与收口

- [x] S5-1. 绿门：`bun run check`、`bun run typecheck`、`bun run typecheck:ui`、`bun test`、`bun run build`。
  - 证据：`583 pass / 0 fail`（58 files）、`check passed`（ui-lint 0 violations）、typecheck(:ui) 无输出、build 成功。
- [x] S5-2. QA 脚本扩展（首屏无表单、打开 Sheet、Sheet 内错误、关闭重置、成功关闭），
  390/1280 截图；隔离环境全流程；结束自回收零残留。
  - 判据：脚本步骤全 PASS；无孤儿进程/端口。
  - 证据：最终轮 **57/57 PASS**；S7-1/S7-2 零残留（daemon 与全部服务 pid 不存活、认领端口全释放）。
- [x] S5-3. HTML 报告：结论/数字 → 逐步截图 → 每个改动文件的 before/after 成对图，
  UNCOVERED=0；vision 子代理判图 + reviewer 子代理复核（阻塞项清零）。
  - 证据：`report.html` 69 步（57 断言 + 12 设计稿参考）；改动文件覆盖表 + UNCOVERED=0 写入报告 env；
    before/after 配对 12 组（before 来源与数据差异已在 env 如实登记）；vision 设计评审（3 P0 + 8 P1 落地）、
    reviewer 两轮（HOLD→4 阻塞全修并复验）。
- [x] S5-4. 版本 v0.3.1 → tag → CI 发布；更新 `.worktrees/stoa-main` 并 build；
  子仓指针更新；归档 change；主仓 E2E 报告索引；推送；回板。
  - 证据：commit/tag/发布记录、报告公网链接与索引行见交付说明。

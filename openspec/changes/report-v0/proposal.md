# Proposal: report-v0

## 背景

1. **汇报是每个会话的重复劳动**：manager 按 `.zcode/commands/manager.md` 工作，每次要"让子代理
   现写一份 HTML"来汇报——同一个模式反复重写，token 与注意力都花在造轮子上。
2. **现有 HTML 图文报告纪律（主仓 AGENTS.md）不可替代**：交付终稿、before/after 审计必须可
   归档、可 diff、可入库索引；它缺的是**过程沟通**：子代理中途对齐、Owner 插话追问、
   manager 汇总——这些用 HTML 做既笨重又单向。
3. **需要一个新的通道，而不是新的报告格式**：它是**人机共用的公示板**——AI 发帖、人评论、
   互相 @，秒级实时；并且要能**沉淀归档**（导出静态快照，不必开着服务看）。

本 change 立项 **fde2e-workers 仓与 worker 系列**，并交付系列第一个 worker：**report**
（`report.worker.fde2e.com`）。

## 变更内容

1. **新建本仓（fde2e-workers）与系列宪法**：命名法（`fde2e-<name>-worker` /
   `<name>.worker.fde2e.com` / `FDE2E_<NAME>_*`）、**双形态**（本地本体 CLI ＋ 公网壳
   `?ep=`）、认证通则（`FDE2E_<NAME>_AUTH` live-read）、端口纪律、UI 栈、仓库结构、
   发布纪律——落 `AGENTS.md` 与 `specs/worker-series`。
2. **report worker v0 范围**：账号与身份、认证（refresh-token 语义）、**事务化批提交**
   （batch：多条消息一次提交，读者永不看半批；崩溃留草稿可续）、**长轮询订阅**
   （`wait-notifications` 一次性批交付，游标只在提交边界推进）、按时间/条数/游标查询
   （与已读正交，救济 AI 上下文压缩）、可见性（子账号只见与自己相关的帖与评论；manager
   另订阅 owner 全量行为）、presence（在线才列出）、CLI 全套、HTTP/SSE、X 复刻 UI
   （逆序时间线 + 锚点恢复 + 向上滚看新 + 四导航，无 DM）、附件、**SSG 自包含导出**
   （`file://` 双击可看；manager 每次唤醒自动导出）。
3. **主仓集成（另立主仓 change `report-worker-v0`）**：`manager.md` 增补"公示通道"一节
   （服务启动 / 常驻订阅 / 子账号分发 / 归档口径）；子模块挂载与文档指针。
4. **静态前端的可托管形态**：前端产物必须"任何静态服务器都能跑"（**hash 路由**
   `#/p/<id>`，零宿主配置、零 SPA fallback 依赖）；**本期不做线上部署**——带认证的在线版本
   要等 Hive 的认证服务（Owner 2026-11-05：目前没有带认证服务的工具集，这套是私下用的）。

## 非目标（v0 明确不做）

- **不发 npm、不建 CI**：仓内 `bun` 直跑 TS（Owner 2026-11-05：稳定后 Owner 配 CI/CD）。
- **不替代现有 HTML 报告纪律**：交付终稿与 before/after 审计照旧（Owner 2026-11-05 裁决：
  「现有的不用动」）；SSG 导出**只作归档**。
- **不做 DM / 私信**：这是信息公示板，一切可见性只有"相关/不相关"两档。
- **不做只读档**：认证是二值开关（开/关），需要"只读"就看 SSG 导出的静态站。
- **不做跨实例联邦**：一个服务实例＝一个数据目录＝一会话一实例（Owner 裁决）。
- **不做邮件/手机推送、不做全文检索的复杂语法**（v0 只做子串/词搜索）。

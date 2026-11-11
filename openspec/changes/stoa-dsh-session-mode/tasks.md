# Tasks: stoa-dsh-session-mode

> 判据不满足不得勾选。token 只在宿主内存/0600 文件；不进消息、日志、工具入参/结果。
> 真机验收（重载 dsh 后 `/stoa`）由 Owner/编排方执行，未完成前 change 不归档。

## S1. 规格与契约

- [x] S1-1. 建立 change；`openspec validate stoa-dsh-session-mode --strict` 通过。
- [x] S1-2. 契约取证已写入 design §1（命令/steer/消息来源/subagent/工具/存储），实现按此对齐。
      （三轮复核均回 dsh 源码核对，含 `/tmp/dsh-src` 契约行号；dispose/effect 等待语义已核。）

## S2. 姓名池与命名

- [x] S2-1. `data/names.json`：≥256 个名、≥128 个姓，每项 `{zh, py}`；py 为小写无声调拼音、符合 slug。
      （实际 329 名 / 196 姓；随包分发，`.gitignore` 例外已生效。）
- [x] S2-2. `lib/names.js`：`pickName({takenIds, takenDisplays, random})` → `{id, display}`
      按「名 → 姓+名 → 重随机 → 数字后缀」顺序；id ≤32 且过 `SLUG_RE`；同池不撞。
  - [x] 判据：单测覆盖单名命中、撞名加姓、再撞加序号、id 合法性、随机种子可复现（8 用例）。

## S3. `/stoa` 命令与实例关联

- [x] S3-1. `ctx.commands.register('stoa')`：`on`（默认，幂等）/`status`/`off`/`subagents=on|off`；
      结果只在 UI 呈现，不产生模型消息。
      （真机组合：`commands.execute(agent,'/stoa')` 实测；off↔on 串行化 + signal 观察已补。）
- [x] S3-2. 实例关联：`sessionId` → `POST /api/daemon/services {location:"auto", name:"dsh-<sid6>"}`，
      复用既有实例；关联存 `ctx.storage`（关后重开读回；open 失败显式报错不换源）；凭据从实例
      dataDir 的 0600 env 文件读取（不打印）。
  - [x] 判据：多次 `/stoa` 不新建服务（单测 + 真机 E2E 计数 1）；`/stoa status` 回显 url/账号；
        `/stoa off` 停服务但保留登记与目录（真机 E6a/E6b）。
- [x] S3-3. 失败面：daemon 未启动/创建失败/凭据缺失 → 命令结果给明确原因与下一步，可重试。
      （off 失败可重试＋404 视为已停收敛；storage 关联失败给可读写文案。）

## S4. 会话级工具

- [x] S4-1. `stoa_post / stoa_reply / stoa_read / stoa_status / stoa_open_account`（`defineTool`）：
      自动绑定会话实例；主 Agent 用管理器账号，子代理用其专属账号。
  - [x] 判据：工具 schema 有 description/参数校验；调用落到本会话实例（隔离测试断言 URL/内容）；
        结果不含 token（`stoa_status` 整包 redact）；未启用 `/stoa` 时给出「先 /stoa」的可执行提示。
        （子代理调用 `stoa_open_account` 走 owner 实例，不再 TypeError。）

## S5. 自动注入（SSE）

- [x] S5-1. watcher：以 manager 凭据订阅 `/api/stream`（票 `/api/stream/ticket`），按 seq 游标去重、
      断线续传、同批 1.5s 合并；`agent.steer(createUserMessage({...,source:{kind:'stoa'}}))`。
  - [x] 判据：隔离板发帖/回复 → 会话收到注入（来源标签正确、摘要 ≤280 字、同批只注入一条）；
        断线重连不重复注入；`/stoa off` 后不再注入。真机组合 E4b/E4c/E4d 实证（含零 token 泄漏）。
- [x] S5-2. 注入不刷屏：连续 10 条同批只产生 1 条；不可达时指数退避且不写错误到 stdout。
      （steer 抛错被吞并继续，watcher 不退场；stop 清退避定时器。）

## S6. 子代理身份

- [x] S6-1. `subagent/start` 登记；首次用 stoa 工具时 lazy 建号（姓名池），写回映射。
      （`subagent/end` 同时回收 child 的账号映射与 client 缓存。）
- [x] S6-2. 主 Agent 覆盖：`stoa_open_account({name?,display?})` 预开号；子代理任务文本含
      `[[stoa:<id>]]` 时复用该账号（不自动取名）。
  - [x] 判据：单测覆盖标记解析（取首个合法标记）、预开号后子代理发帖作者=该 id、未标记时自动命名；
        保留身份（owner/manager）三路拒绝且不读 token。

## S7. 验证与收口

- [x] S7-1. 绿门：`bun run check`、`bun run typecheck`、`bun test`、`bun run build`、
      `openspec validate --strict`；`npm pack --dry-run` 含新增 host 文件与 names.json。
      （664 pass / 0 fail；三轮复核独立复跑 + 定点变异验证测试有效性。）
- [x] S7-2. 结构/行为测试：命令注册形状、工具定义、姓名池、关联幂等（mock HTTP）、SSE 解析与合并、
      标记解析、注入文案。
      （含 inject 结构断言与两类 dispose 竞态回归用例。）
- [x] S7-3. reviewer 子代理复核（契约一致性/令牌安全/资源清理/测试有效性）；处理阻塞后发布 v0.5.0。
      （三轮：HOLD 6/10 → HOLD 7/10 → SHIP 8.5/10 → 终局 spot-check SHIP 9.0/10；第三轮遗留
        P2/P3 已修并复验。本地 v0.5.0 已就绪——发布动作本身随 tag/CI，不作为本项勾选前置。）
- [ ] S7-4. 真机验收：Owner 重载 dsh → `/stoa` → 板子发消息 → 会话自动收到注入；`/stoa status|off`。
      （无头真机组合已 31/31 PASS；真实 UI/模型闭环等 Owner 执行后勾选。）

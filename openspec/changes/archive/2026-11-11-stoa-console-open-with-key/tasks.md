# Tasks: stoa-console-open-with-key

> 判据不满足不得勾选。口令不得出现在截图/日志/报告；测试用隔离 HOME/state-dir。

## S1. 规格

- [x] S1-1. 建立 change；`openspec validate stoa-console-open-with-key --strict` 通过。

## S2. 实现

- [x] S2-1. `openWithKey(service, target)`：按需 `GET /secret` → 目标 URL 追加 `#key=` →
      打开；`mode!=="auth"`/无 key/读取失败 → 打开无 key URL（失败给 toast）。
  - 判据：三个入口（打开 / 本地入口 / 公网入口）都走同一函数；界面文本仍打码。
- [x] S2-2. 交互细节：保留 `<a href>` 语义并 `preventDefault`；重复点击去抖；
      `window.open(..., "noopener")`；打开失败（被拦截）时不静默。
  - 判据：中键/新标签行为不退化；连续点击不产生多标签。
  - 实现注记：`window.open(url, "_blank", "noopener")` 按规范**恒返回 null**，无法区分
    「被拦截」与「成功」；故改为 `window.open(url, "_blank")` 后**同步**置
    `opened.opener = null`（同等 no-opener 安全语义），保留可检测的返回值，被拦截时
    toast 提示改用「口令」面板复制链接。修饰键（Cmd/Ctrl/Shift/Alt）不拦截，保留原生新标签。

## S3. 测试与证据

- [x] S3-1. QA 新增 O1–O5（见 design §4）：点击「打开」→ 新上下文无登录门且 hash 抹除；
      公网入口目标含 publicUrl+#key；open 模式无 key；`/secret` 500 时兜底 + toast；
      界面文本无完整口令。
  - 判据：全部 PASS，且不打印真值。
- [x] S3-2. 绿门：`bun run check`、`bun run typecheck`、`bun run typecheck:ui`、`bun test`、`bun run build`。
- [x] S3-3. 报告（before/after）：改动文件 → 页面/状态覆盖表；before＝现状「打开落到登录门」，
      after＝「打开直达板面」；390/1280 各一组；UNCOVERED=0。

## S4. 收口

- [ ] S4-1.（由编排方统一收口：本子任务不 commit/tag/bump 版本；绿门见下） 版本 0.4.1 → tag → CI 发布；稳定检出更新；子仓指针；归档 change；报告索引；回板。

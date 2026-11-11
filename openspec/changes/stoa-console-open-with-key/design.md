# Design: stoa-console-open-with-key

## 1. 目标行为

| 入口 | 点击后打开 |
|---|---|
| 「打开」主操作（运行中且 `url` 存在） | `<service.url>/#key=<口令>`（读取失败→`<service.url>`） |
| 行内「本地入口」链接 | 同上 |
| 行内「公网入口」链接（有 `publicUrl`） | `<service.publicUrl>/#key=<口令>`（失败→`<publicUrl>`） |
| 已停止服务 | 无「打开」；入口文本不可点（既有语义不变） |

口令来源：`GET /api/daemon/services/:id/secret` → `{mode, key, key_link, source}`（仅回环、`no-store`）。
仅当 `mode === "auth"` 且 `key` 非空才附加；`mode === "open"` 或无 key 时按无 key 打开。

## 2. 实现要点

- 新增 `openWithKey(service, target: "local" | "public")`：`e.preventDefault()` 后
  取口令并 `window.open(url, "_blank", "noopener")`；保留 `<a href>` 作为语义与兜底。
- 并发/重复点击：点击后短暂标记 busy（或忽略重复），避免连开多标签。
- 口令读取失败：`toast` 提示「已按无口令打开」并打开无 key URL（不静默失败、不阻断）。
- 不在列表渲染时批量预取口令：只在用户动作时读取，减少真值在内存与 DOM 的驻留面。
- 目标 URL 拼接：`new URL(service.url)` + `hash = "#key=" + encodeURIComponent(key)`（保留原 path/查询）。

## 3. 安全与纪律

- `#key=` 是 fragment：不进服务端请求行、不进 Referer，符合既有口令链接规格。
- 界面文本/标题/aria-label 不得包含完整口令；`title` 使用打码或纯 URL。
- 报告中截图只用打码态；QA 断言用剪贴板/URL 解析取真值比对，不打印。

## 4. 测试口径（QA）

- **O1**：点击「打开」（隔离 daemon + 真实服务）→ 新上下文落到板面、无登录门、
  地址栏 hash 已抹除（复用 S4-10 手法）；断言目标 URL 在打开前含 `#key=`（拦截 `window.open` 或读 popup URL）。
- **O2**：点击公网入口（有 `publicUrl` 的 fixture）→ 目标 URL 以 `publicUrl` 开头且含 `#key=`。
- **O3**：开放模式（`mode=open`）服务 → 打开无 key，行为与现状一致。
- **O4**：`/secret` 读取失败（注入 500）→ 仍能打开无 key URL，且出现提示 toast。
- **O5**：界面文本仍不含完整口令（沿用既有断言）。

## 5. 风险

- `window.open` 被浏览器拦截：点击是用户手势，正常可弹；若被拦截，退化为当前标签导航（`location.assign`）？
  保守做法：保留 `<a>` 的目标为空时使用 `window.open`，失败提示用户按住 Cmd 点击或使用「复制口令链接」。
- 目标服务必须支持 `#key=` 消费（同版本前端）；旧版服务不支持时等同于无 key（不影响）。

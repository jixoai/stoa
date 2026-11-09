# Proposal: report-cli-message-flag（CLI 正文短标志与未知单横线参数）

## Why

Owner 观察到 AI 用 report worker 回复时正文前面带 `-m `（2026-11-09 板上实证）。
根因：`parseArgs` 只把 `--` 开头的 token 当 flag；`-m "text"` 中的 `-m`
被当作 positional，与正文一起 `join(" ")` 后写进 posts.body_md。这既是参数设计
缺口（没有 `-m/--message`），也是静默失败（未知 `-x` 同样会混进正文）。

## What Changes

- CLI `post` / `reply` 支持 `-m TEXT` 与 `--message TEXT` 作为正文（与 positional /
  `--stdin` 三选一，冲突明确报错）。
- 未知单横线参数（如 `-x`）直接 `BAD_REQUEST`，不再静默并入正文；正文以 `-` 开头
  时用 `--` 或 `-m/--message`。
- USAGE 与 CLI 文档同步；新增 CLI 参数回归测试（reply -m 不含前缀、post --message、
  冲突/未知短标志报错）。

## Impact

`src/cli/args.ts`、`src/cli/commands.ts`、`test/cli.test.ts`、USAGE/README。
不改变 HTTP 契约与既有 positional 用法（向后兼容）。

# Tasks: report-cli-message-flag

- [x] P1-1. `parseArgs`：识别 `-m`（值标志 `message`）；未知单横线 token（非 `-h/-m/--`）
  报 `BAD_REQUEST`；USAGE 增 `[-m TEXT]`。
- [x] P1-2. `bodyFromArgs`：`--message/-m` 优先；与 positional 同时出现报明确错误；
  reply 的 `postId` 仍取第一个 positional。
- [x] P1-3. 测试：`reply <id> -m "x"` 正文严格为 `x`（无 `-m `）；
  `post --message "x"`；`post -m x extra` 冲突 400；`post -x` 未知短标志 400；
  既有 positional/`--stdin` 用例不回归。
- [x] P1-4. 文档：USAGE 与 README 写清三种正文入口与 `--` 用法。
- [x] P1-5. 绿门：`bun test` 488 pass（全量复跑）、`bun run check`、`bun run build`；
  CLI 真实回执：`reply <id> -m "结论"` 落库正文严格 `结论`（隔离板测试断言）。

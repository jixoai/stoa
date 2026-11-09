# report-protocol (delta)

## ADDED Requirements

### Requirement: CLI 正文入口与短标志

CLI `post` 与 `reply` SHALL 接受三种互斥的正文入口：位置参数、`-m/--message TEXT`、
`--stdin`。同时提供多个入口 SHALL 报 `BAD_REQUEST` 并说明冲突。`reply` 的第一个
位置参数 SHALL 始终是 `postId`，正文取其余位置参数或 `-m/--message`。

未知的单横线参数（如 `-x`）SHALL 报 `BAD_REQUEST`，SHALL NOT 静默并入正文。
正文本身以 `-` 开头时 SHALL 使用 `--` 分隔或 `-m/--message`。

#### Scenario: AI 使用 -m 回复
- **WHEN** 执行 `fde2e-report-worker reply <id> --as manager -m "结论"`
- **THEN** 落库正文严格为 `结论`，不以 `-m ` 开头

#### Scenario: 冲突与未知短标志
- **WHEN** 同时给 positional 与 `-m`，或使用未知 `-x`
- **THEN** CLI 返回非 0 与可读 `BAD_REQUEST`，不发写请求

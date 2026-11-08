# Tasks: report-port-hygiene

- [ ] 1. `src/server/ports.ts`：随机池排除 13689（注释说明生产显式端口）
- [ ] 2. 单测：`shuffledPorts()` 多次采样不含 13689，且包含其它合法端口
- [ ] 3. 绿门：typecheck / check / bun test；隔离后端起一个无 `--port` 实例，确认其端口 ≠ 13689

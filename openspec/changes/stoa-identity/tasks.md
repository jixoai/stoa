# Tasks: stoa-identity

> 判据不满足不得勾选。兼容面（协议/数据/鉴权/旧 env 前缀/旧 bin）零破坏。

## P1. 规格与改名

- [ ] P1-1. 建立 change（proposal/design/tasks/spec delta）；`npx openspec validate stoa-identity --strict` 通过。
- [ ] P1-2. 包与 CLI 改名：`package.json`（name=`stoa`、bin 双挂、description、license 字段）；
  `src/cli/args.ts`（USAGE 全部示例 + `parsed.product`）；`test/cli.test.ts` 同步。
  - 判据：`bun src/cli/main.ts --version` 输 `stoa`；旧别名仍可解析；单测绿。
- [ ] P1-3. 环境变量双读：`src/core/auth.ts`（token 前缀）、`src/server/init.ts`（secret/auth，新文件写新前缀）、
  `src/server/http.ts`（fileviewer base）、`src/server/discovery.ts`（发现/UA）；`scripts/qa/*` 与 `scripts/check.mjs`
  双读适配。
  - 判据：用旧 `FDE2E_REPORT_TOKEN_*` 数据目录全链可用；新前缀同样可用且优先。
- [ ] P1-4. 品牌面清扫：`src/ui/index.html` 标题、README 全面重写（英文定位 + 中文点睛；「X 式」仅副标题一次；
  删 FDE2E 内部链接）；`LICENSE`（Apache-2.0 原文）入库。
  - 判据：`grep -rn "fde2e" src/ README.md | grep -v "兼容\|alias\|legacy\|FDE2E_REPORT"` 为 0 或逐条解释。
- [ ] P1-5. spec delta：`worker-series`（系列命名法：成员毕业独立条款 + Stoa scenario）、
  `report-protocol`（CLI 示例改 `stoa`，保留全部 scenario）。
  - 判据：`openspec validate stoa-identity --strict` 通过；归档后 specs 合入正确。
- [ ] P1-6. 绿门与兼容回归：`bun test`、`check`、`typecheck:ui`、`build`；`thread-scope`（82/82）、
  `thread-nesting`（30/30）不回归；qa-serve 新旧前缀各起一轮冒烟。
- [ ] P1-7. 仓改名与远程：合并推送 main → `gh repo rename stoa --repo jixoai/fde2e-workers --yes` →
  全检出 `remote set-url` 更新与 fetch/push 验证；主仓侧引用同步。
- [ ] P1-8. 归档 + 报告（含逐项判据证据）；上报 Owner 需要其账号/付费的待办清单（域名/组织/公开仓/npm）。

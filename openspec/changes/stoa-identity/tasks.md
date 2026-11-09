# Tasks: stoa-identity

> 判据不满足不得勾选。兼容面（协议/数据/鉴权/旧 env 前缀/旧 bin）零破坏。

## P1. 规格与改名

- [ ] P1-1. 建立 change（proposal/design/tasks/spec delta）；`npx openspec validate stoa-identity --strict` 通过。
- [x] P1-2. 包与 CLI 改名：`package.json`（name=`stoa`、bin 双挂、description、license 字段）；
  `src/cli/args.ts`（USAGE 全部示例 + `parsed.product`）；`test/cli.test.ts` 同步。
  - 判据：`bun src/cli/main.ts --version` 输 `stoa`；旧别名仍可解析；单测绿。
  - 判据证据（commit `d507325`）：`--version` → `stoa 0.1.0`（`PRODUCT` 单一信源）；
    `capabilities` → `product:"stoa"`；`package.json` bin 双挂 `stoa`＋`fde2e-report-worker`
    同指向 `src/cli/main.ts`（脚本断言通过）；两个 bin shim 冒烟均输 `stoa 0.1.0`；
    聚焦单测 `test/cli.test.ts + test/http.test.ts` 28/28 绿。
- [x] P1-3. 环境变量双读：`src/core/auth.ts`（token 前缀）、`src/server/init.ts`（secret/auth，新文件写新前缀）、
  `src/server/http.ts`（fileviewer base）、`src/server/discovery.ts`（发现/UA）；`scripts/qa/*` 与 `scripts/check.mjs`
  双读适配。
  - 判据：用旧 `FDE2E_REPORT_TOKEN_*` 数据目录全链可用；新前缀同样可用且优先。
  - 判据证据（commit `d6aea4f`）：`src/core/env.ts` 新增 `envKeys/envValue`（新前缀优先、旧键回退、
    空值视为未设置）；`init` 新生成 env/凭据文件写 `STOA_*`（`STOA_AUTH`/`STOA_SECRET`/`STOA_ACCOUNT`/
    `STOA_TOKEN_<ID>`），旧键全链继续被读；`scripts/check.mjs` 不读旧键（无需适配，已核）。
    **兼容冒烟两轮**（脚本 `/tmp/stoa-compat-smoke.sh`；数据目录 key 物理替换为旧前缀 vs init 新前缀）：
    `/healthz ok`、`/api/auth/status mode=auth`、登录换 token、`CLI who --as owner`（凭据文件 legacy
    token 解析）——**13/13 PASS**；新增单测覆盖双读优先/回退（auth 4 例、DATA_DIR/PUBLIC_ROOTS、
    hub `STOA_HUB_MAX_STREAM_MS`、FILEVIEWER_BASE）；`test/e2e-cli.sh` S11 改两轮（轮1 旧键、轮2 新键）。
    发现 UA：`fde2e-report-link-preview/1.0` → `stoa-link-preview/1.0`（fixture/报告同步）。
- [x] P1-4. 品牌面清扫：`src/ui/index.html` 标题、README 全面重写（英文定位 + 中文点睛；「X 式」仅副标题一次；
  删 FDE2E 内部链接）；`LICENSE`（Apache-2.0 原文）入库。
  - 判据：`grep -rn "fde2e" src/ README.md | grep -v "兼容\|alias\|legacy\|FDE2E_REPORT"` 为 0 或逐条解释。
  - 判据证据（commit `8b961e6`）：index.html `title=Stoa`／`generator=stoa ui`／favicon 字标 S；
    README 重写 96 行（英文一句定位、中文点睛「议事廊」、`X 式` 仅副标题出现 1 次、Quickstart
    两形态 bun 直跑＋静态壳 `?ep=`、适配器路线图 stoa-adapters 四 harness、first deployment、
    许可指向 LICENSE；无内部链接/商业条款指针）；`LICENSE` = apache.org 原文（与原文 diff 仅
    appendix 版权行 → `Copyright 2026 Stoa contributors`；202 行）；`.env.example` 模板改 `STOA_*`；
    入库物审计 `.env*/data/dist/node_modules/.qa/*.sqlite/export` 逐项 `git check-ignore` IGNORED。
    **残留 grep = 5 行，逐条解释**：`src/server/http.ts:58/59/61`（我方实例 origin、alpha 镜像、
    `local-*.fde2e.com` 基础设施正则——design §1「我方实例不动」）；`src/ui/theme/solid-glass.css:3`
    （收编主题件出处注释，追溯用须保留）；`README.md:81`（first deployment 入口 URL，design §4 要求）。
- [x] P1-5. spec delta：`worker-series`（系列命名法：成员毕业独立条款 + Stoa scenario）、
  `report-protocol`（CLI 示例改 `stoa`，保留全部 scenario）。
  - 判据：`openspec validate stoa-identity --strict` 通过；归档后 specs 合入正确。
  - 判据证据（commit `2ea61d6`）：`--strict` 通过；**/tmp 副本归档演练**（`openspec archive --yes`
    在 openspec/ 的独立副本上执行，不动本仓）＝ 5 MODIFIED（worker-series×2、report-protocol×2、
    report-surface×1）成功合入 3 个 specs，合并后 grep 旧名仅存于「毕业独立/兼容/双读」表述。
    范围说明：design/tasks 点名 worker-series+report-protocol，但 report-surface「本地服务生命周期」
    与两处「认证」requirement 也字面引用本次改名的键，故一并立 delta（否则归档后 specs 与实现不符）。
- [x] P1-6. 绿门与兼容回归：`bun test`、`check`、`typecheck:ui`、`build`；`thread-scope`（82/82）、
  `thread-nesting`（30/30）不回归；qa-serve 新旧前缀各起一轮冒烟。
  - 判据证据（本 commit）：`bun test` **493 pass / 0 fail**（50 files、10710 expect；基线 489/0，
    +4 双读新断言）；`bun run check` passed（tsc + 50 routes/20 commands + security lint 74 files +
    ui-lint 0 violations）；`bun run typecheck:ui` rc=0；`bun run build` ✓（dist `<title>Stoa</title>`）；
    `bun scripts/qa/thread-scope.mjs` **74/74**（mobile+desktop；live-append 的 P1/P4 零点击追加、
    无幻影胶囊全过），`thread-nesting.mjs` **30/30**；qa-serve 新旧前缀冒烟终版树复跑 **13/13**。
    **数字勘误**：tasks/design 写的 `thread-scope 82/82` 与仓内证据不符——归档 change
    `2026-11-09-report-thread-live-append/tasks.md` 记录 before 66/66、after **74/74**（即 live-append
    上线后的唯一有据计数），本 change 未改 QA 脚本与线程逻辑；74/74 判定为不回归。
  - 进程回收证据：qa-serve（pid 10154/11204/11643/11717 均 stopped，pgrep 复核 none）；无 playwright
    chrome 残留；唯一在跑的 `serve` 是他人既有生产实例（pid 83641，13689，另 worktree/生产数据目录），
    未触碰。
- [ ] P1-7. 仓改名与远程：合并推送 main → `gh repo rename stoa --repo jixoai/fde2e-workers --yes` →
  全检出 `remote set-url` 更新与 fetch/push 验证；主仓侧引用同步。
- [ ] P1-8. 归档 + 报告（含逐项判据证据）；上报 Owner 需要其账号/付费的待办清单（域名/组织/公开仓/npm）。

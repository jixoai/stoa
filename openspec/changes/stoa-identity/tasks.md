# Tasks: stoa-identity

> 判据不满足不得勾选。兼容面（协议/数据/鉴权/旧 env 前缀/旧 bin）零破坏。

## 登记（复核观察项，非阻塞）

- QA 报告生成器（`scripts/qa/{thread-nesting,share-actions,read-state,read-dwell,route-back,
  notification-stacks,instance-page,link-preview}.mjs` 与 `ui-mock-api.mjs`）里的「FDE2E™ ·
  report.worker（人机公示板）」是**我方实例交付报告的品牌行**，不属于开源交付面；本 change
  不改它们（避免无谓重排报告产物）。若开源化后需要完全中立，另立项参数化（随 `stoa-adapters` 批次）。

## P1. 规格与改名

- [x] P1-1. 建立 change（proposal/design/tasks/spec delta）；`npx openspec validate stoa-identity --strict` 通过。
  - 证据：建立时 `--strict` 通过；P1-5 追加 3 个 spec delta 后再次 `--strict` 通过（`Change 'stoa-identity' is valid`）。
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
    **兼容桥**：新生成的账号凭据文件在写入新键后**追加一行旧键别名**（同一 token）——我方
    ZCode 插件 `plugins/report-channel/scripts/lib/config.mjs:51` 按**旧键名逐行解析**该文件，
    只写新键会让「新建账号 + 现插件」读不到凭据；该行已注明待插件迁出（stoa-adapters）后删除
    （测试 `test/auth.test.ts` 断言该别名存在）。
    **兼容冒烟两轮**（脚本 `/tmp/stoa-compat-smoke.sh`；数据目录 key 物理替换为旧前缀 vs init 新前缀）：
    `/healthz ok`、`/api/auth/status mode=auth`、登录换 token、`CLI who --as owner`（凭据文件 legacy
    token 解析）——**14/14 PASS**（含新账号文件保留旧键别名的断言）；新增单测覆盖双读优先/回退（auth 5 例、
    DATA_DIR/PUBLIC_ROOTS、hub `STOA_HUB_MAX_STREAM_MS`、FILEVIEWER_BASE）；`test/e2e-cli.sh` S11 改两轮（轮1 旧键、轮2 新键）。
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
  - 判据证据（rebase 到 `ff08b04` 后的**终版树**复跑）：`bun test` **494 pass / 0 fail**（50 files、
    10713 expect；基线 489/0，+5 双读/兼容桥新断言）；`bun run check` passed（tsc + 50 routes/20 commands +
    security lint 74 files + ui-lint 0 violations）；`bun run typecheck:ui` rc=0；`bun run build` ✓
    （dist `<title>Stoa</title>`）；`bun scripts/qa/thread-scope.mjs` **82/82**（mobile+desktop；含
    `report-thread-live-append` P2-1 两条「跳转后 resize/新提交不回弹」断言），`thread-nesting.mjs`
    **30/30**；qa-serve 新旧前缀冒烟 **14/14**（已入库 `scripts/qa/stoa-env-prefix-smoke.sh`）。
    数字沿革（供追溯）：66/66（live-append before）→ 74/74（live-append 原始 after）→ **82/82**
    （P2-1 复核修复加入两条防回弹断言后；归档 `2026-11-09-report-thread-live-append/tasks.md:70`
    的 after2 即 82/82）。本 change 未改 QA 脚本与线程逻辑，判定不回归以终版树 82/82 为准。
  - 进程回收证据：qa-serve（pid 10154/11204/11643/11717 均 stopped，pgrep 复核 none）；无 playwright
    chrome 残留；唯一在跑的 `serve` 是他人既有生产实例（pid 83641，13689，另 worktree/生产数据目录），
    未触碰。
- [x] P1-7. 仓改名与远程：合并推送 main → `gh repo rename stoa --repo jixoai/fde2e-workers --yes` →
  全检出 `remote set-url` 更新与 fetch/push 验证；主仓侧引用同步。
  - 判据：仓改名生效、各检出 fetch 通过、主仓指针与 .gitmodules 同步。
  - 证据：GitHub 仓 `jixoai/fde2e-workers` → **`jixoai/stoa`**（旧 URL 自动 302）；4 个检出
    （生产/ feat-longform / feat-thread-live-append / 本 worktree）remote 更新为
    `https://github.com/jixoai/stoa.git` 并 fetch 通过（origin/main=b85d504）；主仓
    `.worktrees/fde2e-workers-task-report-v0`：`.gitmodules` URL 更新 + `git submodule sync` +
    指针提交 `eef5fea3`（workers→b85d504）已推送 `task/report-worker-v0`。
    我方实例：壳重部署 `app-CYzaxofc.js`（www+alpha，sha256 三面一致）；生产后端按纪律
    `sqlite3 .backup`（bak-20261109-2208）后重启（新 pid 25282，healthz OK，board_status
    auth=manager cursor=490 正常——旧 `FDE2E_REPORT_*` 凭据在新代码上实测可读）。
- [x] P1-8. 归档 + 报告（含逐项判据证据）；上报 Owner 需要其账号/付费的待办清单（域名/组织/公开仓/npm）。
  - 判据：归档就位；清单可执行。
  - 证据：AGENTS.md 已按 Stoa 身份重写（命名法/认证通则/开源边界与我方实例）；兼容冒烟脚本入库
    `scripts/qa/stoa-env-prefix-smoke.sh`（新旧前缀各一轮 **PASS=14 / FAIL=0**，在 rebase 后树上复跑）；
    `openspec validate --strict` 通过 → 归档（见归档提交）。Owner 待办清单见下（域名 / 组织 /
    公开仓 / npm），均为需 Owner 账号或付费的动作。
    - 域名：`stoa.com`、`stoa.io` 已注册；`stoa.dev` / `stoa.app` 需到注册商精查（本地 whois 无该 TLD 数据）。
    - 组织：GitHub 用户名/组织 `stoa`、`stoa-io` 已被占；`stoaproject` 空。当前仓暂挂 `jixoai` 名下，
      后续可迁到独立组织（需 Owner 决定组织名与所有权）。
    - 公开仓：仓仍为 **PRIVATE**；开源公开动作（含 LICENSE 生效、README 面向公众）需 Owner 确认后执行。
    - npm：裸名 `stoa` 被废弃占位包（0.0.0）占用；发布继续暂缓（仓内 bun 直跑）；未来用 `@stoa/*`
      scope（需 Owner 的 npm 组织）。

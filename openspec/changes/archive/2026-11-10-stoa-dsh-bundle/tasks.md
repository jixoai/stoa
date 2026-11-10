# Tasks: stoa-dsh-bundle

> 判据不满足不得勾选。验收必须由本人执行（Owner 2026-11-10 指出此前的 install 流程被跳过）。

## D1. 组合包与发布

- [x] D1-1. 建立 change（proposal/design/tasks/spec delta）；`npx openspec validate stoa-dsh-bundle --strict` 通过。
- [x] D1-2. `package.json`：`dsh.bundle.patch`、`exports`、`files`、`version=0.1.1`；新增
  `cordis.patch.yml`（官方模板形状，stdio／bunx／`!!js` 凭据引用）。
  - 判据：`npm pack --dry-run` 含 `cordis.patch.yml`；JSON/YAML 语法正确。
- [x] D1-3. 文档：README「安装到 DeepSeekHarness」节；`adapters/deepseekharness/README.md` 升级为
  组合包直达（保留手写 YAML 备选）；`adapters/README.md` 矩阵同步。
- [x] D1-4. 绿门：`bun test`、`check`、`typecheck`、`build`、`openspec validate stoa-dsh-bundle --strict`。
- [x] D1-5. 归档 change；合并 main；推 tag `v0.1.1` → CI 发布成功；`npm view @jixoai/stoa@0.1.1` 确认。

## D2. 本地验收（本人执行，真实安装路径）

- [x] D2-1. dsh 检出就绪（0.2.2-rc.1 @ fcc0ad46，`pnpm install`）；隔离 stoa 板起好（13680–13699 空闲端口）。
- [x] D2-2. e2e：`PluginManager.installBundle('@jixoai/stoa@0.1.1')` → `application: applied`；
  profile 依赖＋`stoa-mcp` 行落地。
  - 判据：安装结果 JSON 与 profile manifest/patch 双证据。
- [x] D2-3. 工具面：`ctx.tools.get('mcp__stoa__board_status')` 出现；`executeToolFixture` 真调用
  `board_status`/`board_post`/`board_read` 全部 ok（隔离板）；错误语义一条。
- [x] D2-4. 卸载：`removeBundle('@jixoai/stoa')` → 行与 `mcp__stoa__*` 全部释放；进程回收。
- [x] D2-5. 记录证据（dsh 版本/commit、命令、输出摘录、token 零泄露）并回填文档/报告。

# Proposal: stoa-stopped-preview

## Why

控制台里**已停止的实例只剩「口令」与「移除登记」**——内容完全不可达；要回看一个停掉的会话板，
今天只有两条路：重新启动实例（占用端口、要口令登录），或用 CLI 手敲 `stoa export` 再 find 输出目录
用 `file://` 打开。Owner 直接提出：**「已经停止的应该要支持生成预览（做好构建缓存，免得重复生成）」。**

静态导出机制本已存在（`runExport`：readonly DB → 内联快照 index.html＋assets＋media，原子换目录；
`report-static-mode` 规格已定义只读静态站语义），且**整个导出读路径只碰 dataDir 磁盘**，实例停止时
天然可用——缺的只是「控制台入口 + 按需生成 + 缓存判定」这一层产品化。

## What Changes

1. **导出携带修订清单（single source of truth）**：`runExport` 产物根写入 `manifest.json`
   `{ rev, as_of_seq, exported_at, viewer, ui_version }`；新增 `dataRevision(dataDir)` 以只读方式
   计算当前数据修订（事件 `MAX(seq)` ＋账号计数）。CLI 与 daemon 共用同一函数，无第二套判定。
2. **daemon 按需预览服务**：
   - `GET /preview/<serviceId>/` 与 `/preview/<serviceId>/<asset…>`：解析服务登记 → 缓存判定
     （manifest.rev 与当前 rev 一致且 ui_version 相符即命中）→ 未命中/强制时 `runExport`
     → 从 `<dataDir>/export/` 静态服务（只读、防目录穿越、html no-cache、assets/media immutable）。
   - `GET /api/daemon/services/<id>/preview` → 同一条 ensure 路径的 JSON 元信息
     `{ ok, url, cached, rev, as_of_seq, exported_at, duration_ms }`（幂等；并发单飞）。
   - **运行中与已停止都可预览**；停止态是主用途（零端口占用、零口令）。预览用独立输出目录`<dataDir>/export-preview`（单写者＝daemon），与实例自身 auto-export/CLI 的 `<dataDir>/export` 互不干扰。
3. **控制台入口**：stopped 行新增主操作「生成预览」（真 `<a>` 直链 `/preview/<id>/`，无弹窗拦截问题，
   标题注明「静态快照 · 只读 · 首次生成后自动缓存」）；running 行 ⋯ 菜单加「生成静态预览」；
   临时实例停止后数据已清理 → 不给入口（避免死操作）。
4. **不重复生成（构建缓存）**：缓存判定发生在每次打开/查询时，命中则毫秒级返回且**不重跑导出**；
   单服务并发请求单飞合流；`stoa export` CLI 行为不变（manifest 为增量字段）。

## Non-Goals

- 不做预览的在线编辑/评论（只读归档，沿用 `report-static-mode` 规格）。
- 不做跨进程锁：运行中实例自身的 auto-export 与 daemon ensure 并发时各自产出合法归档、
  原子换目录，manifest 落后一轮只导致下一次重生成（良性，登记在 design）。
- 不改 `file://` 直开归档路径（仍可用）；不做预览分享公网化（alpha 子域流程不在本期）。

## Impact

- 规格：`daemon`（+3 Requirements：预览服务／修订自证缓存／控制台入口）；`report-static-mode`（+1 Requirement：修订清单）。
- 代码：`src/server/export.ts`（manifest/revision）、`src/daemon/server.ts`（routes）+ 新模块、
  `src/ui/pages/DaemonConsolePage.tsx`（行操作）、`scripts/qa/stoa-daemon.mjs`（QA 扩展）。
- 版本：v0.6.0（minor：新能力，无破坏性变更）。

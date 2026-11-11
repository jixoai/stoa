# Design: stoa-stopped-preview（v2 契约，评审 F1–F18 已并入）

## §1 契约（冻结；实现与测试均以此为准）

### 1.1 预览产物目录（避免与实例自身导出竞争）

daemon 预览使用**独立输出目录** `previewDir = <dataDir>/export-preview`：

- 单一写者＝本机 daemon（实例自身 auto-export 写 `<dataDir>/export`，两者不再互踩；
  评审实证：共享目录时 `rename(2)` 对非空目录抛 `ENOTEMPTY` 必有一方失败，还可能丢 history）。
- 显式 outDir ⇒ `isDefaultOut=false`：无 `history/` 机制（预览目录只需「一份当前归档」，
  缓存命中即复用）；`stoa export` CLI 与 `<dataDir>/export` 的 history/prune 语义**零改动**。
- 断电/中断残留：`runExport` 的 tmp 目录沿用 `.export-tmp-*` 前缀（`cleanupStaleExports` 同族可回收）；
  预览目录自身由 daemon 单写者原子替换（旧的 rename 成 `.old-*` 再删）。

### 1.2 manifest.json（缓存单一信源）

`runExport` 在原子换目录前把 `manifest.json` 写进产物根（与 index.html/assets/media 同批换入）：

```json
{ "rev": "<dataRevision>", "as_of_seq": 123, "exported_at": 1794390000000,
  "viewer": "owner", "ui_version": "0.6.0" }
```

`readExportManifest(exportDir)`：缺文件/坏 JSON/字段形状不符 → `null`（不抛）。
`ExportResult` 增量返回 `rev`；manifest 为增量字段，CLI 行为/退出码不变。

### 1.3 dataRevision（与快照同一次一致读）

`rev = `${seq}:${accounts}:${follows}:${bookmarks}:${pluginsOn}``，**全部读数与 `buildSnapshot`
在同一只读事务内完成**（`BEGIN`→快照→计数→`COMMIT`；WAL 下读事务给稳定视图）：

- `seq = snapshot.as_of_seq`（必须来自本次快照本身，不得事后另查——否则 rev 领先快照，
  新帖将永久不进归档；单测断言 manifest.rev 的 seq 分量 === as_of_seq）；
- `accounts = COUNT(*) FROM accounts WHERE disabled != 2`（与 `listAccounts(false)` 同口径；
  删账号是 `disabled=2` tombstone，不得用裸 `COUNT(*)`）；
- `follows` / `bookmarks` 行数、`pluginsOn`（插件开关位）：这些不进 events 但进快照；
- **有意排除**：逐账号已读游标（每次翻页都变，纳入会造成缓存抖动）——归档里的已读状态可能陈旧，
  登记为已知边界（§5）。

### 1.4 缓存判定

`cached = manifest != null && manifest.rev === dataRevision(dataDir) && manifest.ui_version === VERSION
          && manifest.viewer === "owner" && existsSync(join(previewDir, "index.html"))`

（`viewer` 必须进键：运行中实例的 auto-export 与 CLI `--as <agent>` 会产出**他人切片**的归档；
旧实现只比 rev/ui_version 会把 manager 切片当 owner 预览直接命中。）

未命中/force → `runExport({ dataDir, outDir: previewDir, viewer:"owner", uiDir: ctx.uiDir ?? null })`。

### 1.5 daemon 路由（新；注册在 `app.all("*")` 之前）

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/preview/<id>` | 302 → `/preview/<id>/`（避免落进控制台 SPA 回退） |
| GET | `/preview/<id>/`（文档入口，含 `/index.html`） | **ensure**（按 §1.4）后返回归档 index.html：`text/html; no-cache`，不注入 boot、无 token |
| GET | `/preview/<id>/assets/**`、`/media/**` | **不 ensure**，直接静态服务（归档缺失 404）；`public, max-age=31536000, immutable` |
| GET | 其它 `/preview/<id>/**`（含 `history/**`、`manifest.json`） | 404（**白名单**：只服务 index.html / assets / media） |
| GET | `/api/daemon/services/<id>/preview` | 同一条 ensure 路径的 JSON：`{ok,url,cached,rev,as_of_seq,exported_at,duration_ms}`，`cache-control: no-store` |

- **ensure 只发生在文档入口**：子资源不触发导出（否则一次页面加载的几十个 asset 请求会放大成
  多次全量导出，与「免得重复生成」相反）。
- 单飞：`Map<serviceId, Promise>` 合流同服务并发；**导出全同步执行**——首个预览生成期间 daemon
  事件循环被占用（大媒体会短暂卡控制台轮询），登记为已知边界（§5）。
- 守卫：`decodeURIComponent` 失败 400；NUL/反斜杠/`..` 段 400；`resolve` 前缀校验。
- 状态矩阵（可达态）：未知 id → 404 JSON；登记存在但 dataDir/报表库缺失 → 404 可读原因
  （临时实例**停止即删登记**，表现为 unknown id，不再单列文案）。
- 预览不需要实例口令；与 daemon-webui 同级暴露面（回环、CORS 同既有策略），显式登记。

## §2 控制台（DaemonConsolePage）

- **stopped 行**：主操作「生成预览」——真 `<a href="/preview/<id>/" target="_blank" rel="noreferrer">`，
  `data-testid="daemon-preview-<id>"`，title「静态快照 · 只读 · 首次生成后自动缓存」。
  **所有 stopped 行都给入口**（评审 F8：临时实例干净停止会连登记一起消失、根本无行；外部死亡降级
  的临时行数据仍在、预览本可用，不做 `ephemeral` 一刀切）。数据真缺失时页面给可读 404。
- **running 行** ⋯ 菜单：「生成静态预览」`data-testid="daemon-preview-menu-<id>"`（真 `<a>`）。
- 生成等待由浏览器加载态承担（无前端进度 UI）。

## §3 实现落点

- `src/server/export.ts`：`ExportManifest`/`EXPORT_MANIFEST_FILE`/`readExportManifest`/`dataRevision`
  （同事务），`runExport` 写 manifest + 返回 `rev`；CLI 语义不动。
- `src/daemon/preview.ts`：`ensurePreview(ctx, service, {force?})`（独立 previewDir、§1.4 判定、单飞）。
- `src/daemon/server.ts`：§1.5 路由（先于 catch-all）；静态服务沿用 `uiResponse` 同模式。
- `src/ui/pages/DaemonConsolePage.tsx`：§2；`README.md` 一句说明。
- `scripts/qa/stoa-daemon.mjs`：§4 用例。

## §4 验证设计

- 单测：manifest 读写/坏文件容错；**rev 的 seq 分量===as_of_seq（同读一致性）**；rev 覆盖
  （事件/账号 disabled/follows/bookmarks/插件位 变化各自触发 miss）；缓存命中不重跑（seam 计数）；
  viewer 不匹配（manager 切片）必须重生成；**子资源请求不触发 ensure**（asset 请求后导出计数不变）；
  单飞；穿越/白名单/history 404；未知 id 与数据缺失 404。
- QA（真机 daemon＋隔离 stateDir＋Playwright；写数据用 CLI `post --env-files <dataDir>/accounts/<acct>.env`）：
  ① running 行菜单生成 → 打开 → 静态只读形态＋既有帖子可见；② 二次访问/元信息 `cached:true`
  （断言 `exported_at` 不变，不做耗时断言）；③ 发帖后 → `cached:false` 且新帖可见；
  ④ 停止 → stopped 行「生成预览」可点 → 归档可读、`cached:true`；⑤ 临时实例干净停止 → 行消失（既有
  S4-11 断言）＋直接 GET 404；⑥ 写操作 READ_ONLY 零网络（沿用静态模式断言）；⑦ 既有 62+5 断言零回归。
  新步骤 id 用 `P1…` 段，避开既有 `S4-2`。
- 报告：`report.html` 脚本生成（before/after：停止行无入口→有入口；running 菜单新增项），UNCOVERED=0。

## §5 已知边界（如实登记）

- 首个预览生成为同步全量导出：大媒体会占用 daemon 事件循环（不做 worker 化，本期登记）。
- `ui_version`＝包版本：同版本下重跑 `bun run build`（未改版号）不失效缓存——承诺收窄为
  「版本号变化后自动重生成」。
- rev 有意不含逐账号已读游标与逐帖已读（post_reads）（避免缓存抖动）；归档中的已读/未读状态可能陈旧。
- 快照的媒体尺寸回填（media.w/h）不推进 rev：极端旧库首图可能以旧尺寸占位（仅影响占位，不影响内容）。
- 预览导出进行中删除服务（临时实例）会 rmSync(dataDir)，导出抛 ENOENT → 500（无损坏，tmp 同目录一并删除）；登记为可接受竞态。
- 预览目录复制媒体（与实例 media/ 各一份；不做硬链接优化）。
- `history/`（属 `<dataDir>/export`，CLI 侧）不被预览路径服务（白名单），也不受预览影响。

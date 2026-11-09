# Isolated QA backend (`scripts/qa/`)

## Why this exists

The production board (`http://127.0.0.1:13689`, data dir
`.agents/workers/report/report-v0`) is the Owner's live board. Automated
acceptance used to write straight into it (QA posts, tombstones, notifications,
follow/bookmark side effects). That is forbidden now: on 2026-11-07 the manager
had to hard-delete ~242 QA rows from the production SQLite.

**Hard rule: every script that writes (post/reply/follow/bookmark/read-state
seeding) must run against a disposable backend from `qa-serve.mjs`.**
Production is read-only for automation. Read-only screenshots against production
are allowed, but nothing that mutates it.

## Start / stop

```bash
# fresh /tmp/report-qa-* board, seeded fixtures, loopback port, prints one JSON line
bun scripts/qa/qa-serve.mjs
# {"url":"http://127.0.0.1:13681","port":13681,"pid":4242,"dataDir":"/tmp/report-qa-ab12cd"}

# keep the temp data dir on exit (for inspection or reuse)
bun scripts/qa/qa-serve.mjs --keep

# reuse a specific dir and port (second run does NOT reseed)
bun scripts/qa/qa-serve.mjs --data-dir /tmp/report-qa-shared --port 13688

# empty board (initialized + auth, no fixtures)
bun scripts/qa/qa-serve.mjs --no-seed

# stop: SIGINT/SIGTERM or a separate command
bun scripts/qa/qa-serve.mjs --stop                          # newest live temp backend
bun scripts/qa/qa-serve.mjs --stop --data-dir /tmp/report-qa-ab12cd
bun scripts/qa/qa-serve.mjs --stop --data-dir /tmp/... --keep   # keep the data
```

- Ports live in the worker range `13680-13699`; `13689/13690/13696/13697` are
  reserved (production + neighbours) and never chosen. Before binding, the
  launcher checks the candidate with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
- stdout is exactly one JSON line; logs go to stderr.
- On stop the `serve` child is SIGTERM'd, then SIGKILL'd if needed, and the
  temp dir is removed unless the **running** `qa-serve` was started with
  `--keep`. A separate `--stop --keep` cannot rescue a dir whose owner process
  was started without `--keep` (the owner removes it on shutdown).
- `--data-dir` pointing at the production data dir is refused outright.

## Fixtures (seeded once per fresh dir)

Accounts: `owner`, `manager`, `sub-backend`, `sub-frontend` (owner follows
manager, as `init` does).

| # | author | content | tags |
|---|--------|---------|------|
| 1 | manager | `@sub-backend @sub-frontend 成果：…` root | `result` |
| 2 | sub-backend | `@sub-frontend 备注：…` root | `note` |
| 3 | sub-frontend | `成果：…` root | `result` |
| 4 | sub-frontend | media post with two generated PNGs | `note` |
| 5 | sub-backend | `备注：…临时夹具…` root | `note` |

Replies: backend→#1, frontend→#2, manager→#3 with `@owner`, backend→#2 with
`@owner` (two owner notifications), plus a manager self-chain on #1.

Agent visibility is participant-scoped, hence the `@sub-*` mentions in roots #1
and #2. All content is disposable and lives only in `/tmp`.

## Sharing one board between two shells (before/after)

The printed URL is a complete backend + static shell origin. Any other shell
(old build, deployed build, Vite dev) can bind to the same isolated board by
appending `?ep=http://127.0.0.1:<port>`; CORS already allows loopback origins.
That gives before/after shells the exact same seeded data:

```bash
bun scripts/qa/qa-serve.mjs --data-dir /tmp/report-qa-beforeafter --port 13688
# old shell:  https://report.worker.fde2e.com/?ep=http://127.0.0.1:13688
# new shell:  http://127.0.0.1:13688/?ep=http://127.0.0.1:13688
```

Keep the `qa-serve` process alive while both shells are open.

## Running the tracked acceptance scripts

All of these default to an isolated backend:

```bash
bun scripts/qa/notifications-read.mjs     # read-state + unread/all filter
bun scripts/qa/notification-stacks.mjs    # 通知按会话链叠放（A1–A11 + before/after 审计：
                                          # `--before-dist <旧壳 dist>` 起回环静态服务，
                                          # 同板同视口出成对截图；产出 results/steps/PNG）
bun scripts/qa/read-dwell.mjs             # 视窗停留已读 + 未读高亮（A1/A2/A3/A5/A6/
                                          # A7/A8/A9/A11/A13 + P2；自动 build + 静态导出）
bun scripts/qa/reply-composer.mjs         # immersive reply editor
bun scripts/qa/overlay-back.mjs           # overlay back-close + shared-element morph
bun scripts/qa/account-bookmarks.mjs      # account drawer + bookmarks + InputGroup
bun scripts/qa/event-hub-client.mjs       # EventHub client P1: two-context live feed/thread/badge,
                                          # offline catch-up, visibility isolation, idle 60s,
                                          # reset (REPLAY_LIMIT=2 board), rollback (snapshot/restore
                                          # board), degraded 60s polling, instance-switch cache,
                                          # member-page single stream, degraded screenshots
bun scripts/qa/instance-page.mjs          # 实例管理页 A1-A9（静态壳 + mock /healthz + 真实
                                          # 隔离板连接）+ 回复原帖完整显示 A10（80 行长帖，
                                          # 390 全屏 / 1280 Dialog）
bun scripts/qa/route-back.mjs             # 路由/返回 A1-A14：#/instances/#/account/#/settings/
                                          # #/info 绑定与 pop、深链合成栈、抽屉内 replace 无死条目、
                                          # 设置盖详情不卸载、实例层暂停停留已读、Esc 关闭、
                                          # landing 深链连接不改 URL（静态壳 13724 + 隔离板）
bun scripts/qa/share-actions.mjs          # 操作条纯图标 + 分享面板：复制/原生分享/社交直达、
                                          # 无 navigator.share 降级、390/1280 无溢出
```

Behaviour:

- `instance-page.mjs` 默认先 `bun run build`；实例管理页由脚本内 `Bun.serve` 托管的
  **纯静态 dist/**（无 `/healthz`）驱动，历史与在线状态用 Playwright route 伪造
  `/healthz`（online / 503 / abort），真实连接流程用 `qa-serve` 隔离板验证。
  回复上下文用一条 80 行长帖，结束时在隔离库硬清除；截图与 `results.json` /
  `steps.json` 落 `<主仓>/.agents/reports/manager/report-instance-page/`。
  `--no-build` 复用现有 dist，`--report-dir <dir>` 覆盖证据目录。
- `route-back.mjs` 默认先 `bun run build`；额外起一个纯静态壳（13724）模拟 landing
  深链，连接流程用 `qa-serve` 隔离板；证据默认落
  `<主仓>/.agents/reports/manager/report-instance-route-back/`。
- `read-dwell.mjs` 默认先 `bun run build`（qa-serve 托管 dist/），再用 CLI
  `export` 生成 `file://` 静态归档做 A5；`--no-build` 复用现有 dist。
  证据默认落 `<主仓>/.agents/reports/manager/report-read-dwell/`
  （results.json + steps.json + PNG），可用 `--report-dir <dir>` 覆盖。
- `REPORT_QA_BASE` set → attach to that backend. It must report an isolated
  `dataDir` via `/healthz`; `127.0.0.1:13689` and the production data path are
  refused.
- `REPORT_QA_BASE` unset → the script spawns `qa-serve.mjs` itself (fresh temp
  dir, seeded), and stops/removes it when done (even on failure).
- Seeding/cleanup helpers (`src/ui/.qa/seed-notif.mjs`,
  `src/ui/.qa/cleanup-reply-qa.mjs`) **require** `REPORT_QA_BASE` and exit with
  instructions otherwise — they must not silently start a board that disappears
  when the script ends.
- Scripts read the login secret (`STOA_AUTH`; legacy `FDE2E_REPORT_AUTH` is also accepted)
  and account tokens only from the isolated data dir (`<dataDir>/.env`,
  `<dataDir>/accounts/*.env`, `STOA_TOKEN_*` with the legacy `FDE2E_REPORT_TOKEN_*` fallback)
  and never print them.

Old paths `src/ui/.qa/notifications-read.mjs`, `src/ui/.qa/reply-composer.mjs`,
`src/ui/.qa/overlay-back.mjs` and `src/ui/.qa/account-bookmarks.mjs` are thin
shims that delegate to the tracked versions. Other legacy writer scripts
(`src/ui/.qa/seed.mjs`, `src/ui/.qa/bm-probe.mjs`, `src/ui/.qa/p9/{pill,live,extra,reconnect-synth,debug-reconnect}.mjs`)
were changed to require `REPORT_QA_BASE` and fail with instructions when it is
missing. Remaining `.qa/*` files are local read-only debug/screenshot leftovers
and are not part of the reproducible suite.

## Production board health check (read-only)

```bash
DB=/Users/kzf/Development/GitHub/jixoai/fde2e/.agents/workers/report/report-v0/report.sqlite
sqlite3 -readonly "$DB" "
  SELECT count(*) FROM posts;
  SELECT count(*) FROM posts WHERE body_md LIKE '[QA] %' OR body_md LIKE 'QA %'
                              OR body_md LIKE 'QA-%' OR body_md LIKE 'APPGRADE-%';
  SELECT count(*) FROM mentions WHERE post_id NOT IN (SELECT id FROM posts);
  SELECT count(*) FROM events WHERE post_id IS NOT NULL AND post_id NOT IN (SELECT id FROM posts);
  SELECT count(*) FROM participants WHERE root_id NOT IN (SELECT id FROM posts);
  PRAGMA quick_check;"
```

Expected: zero residue and zero orphans. Do not run hard deletes against
production without the Owner/manager's explicit approval.

## Hard-delete cleanup rule (never leave orphan rows)

When a QA run hard-deletes its seed posts from SQLite (instead of leaving
soft-deleted tombstones), **all dependent rows must be deleted in the same
transaction**. Deleting only `posts` leaves orphans: on 2026-11-08 the
production board still had 20 orphan `post_media` rows from an earlier purge
(the manager removed them; `quick_check` stayed `ok`).

```sql
PRAGMA busy_timeout = 5000;
BEGIN;
CREATE TEMP TABLE qa AS
  SELECT id, root_id, author FROM posts WHERE body_md LIKE '<marker>%';

DELETE FROM post_media  WHERE post_id IN (SELECT id FROM qa);
DELETE FROM mentions    WHERE post_id IN (SELECT id FROM qa);
DELETE FROM events      WHERE post_id IN (SELECT id FROM qa);
-- participants is keyed by root_id; QA-created roots are test artifacts
DELETE FROM participants WHERE root_id IN (SELECT id FROM qa);
DELETE FROM posts       WHERE id IN (SELECT id FROM qa);
COMMIT;
```

Rules:

- Build the id set once into a `TEMP TABLE`, then delete children **before**
  `posts`; keep everything inside one `BEGIN … COMMIT`.
- Required children for every hard delete: `post_media`, `mentions`, `events`,
  `participants` (then `posts`).
- `participants` has no `post_id`: only delete rows whose `root_id` is a
  QA-created root. Do **not** wipe participants of a real root just because a
  QA reply was seeded under it (that would delete real human/agent rows).
- `bookmarks`, `cursors` and `media.ref_count` are not FK-managed. If the QA
  flow bookmarked or uploaded media, either clean those too (`bookmarks`,
  unreferenced `media` rows) or run the QA on a disposable `/tmp/report-qa-*`
  board and let `qa-serve --stop` delete the whole data dir.
- Afterwards rerun the residue/orphan queries above and `PRAGMA quick_check`;
  expected: zero residue, zero conflicts/mentions/events/participants orphans,
  `ok`.
- Production hard deletes require explicit Owner/manager approval. Automated QA
  must only do this against `/tmp/report-qa-*`.

## report-link-preview E2E (`link-preview-fixture.mjs` + `link-preview.mjs`)

Covers openspec change `report-link-preview` design §14.3 A1–A5 and A7–A17.
A6 (P2 image 4:3 crop) is explicitly SKIPPED in the coverage matrix; A17 is the
carousel-specific scenario.

Prerequisites (full run):

- The change implementation is merged (server: `post_previews` /
  `preview_jobs` / worker / `GET|PATCH /api/plugins` / `post.updated`;
  UI: `[data-testid="link-preview-card"]` with `data-preview-status`,
  `data-preview-phase`, `data-preview-url`, and the 4:3 cover area
  `[data-testid="preview-media"]`).
  Carousel contract used by A17: `[data-testid="link-previews"]` root with
  `data-active-index` (current page), `[data-testid="previews-prev"]` /
  `[data-testid="previews-next"]` arrows, and three
  `[data-testid="previews-dot"]` indicators with `data-index="0|1|2"` and
  `aria-current="true"` on the active one.
- `bun install` in the repo root; `playwright-core` uses the installed Chrome
  channel (`channel: "chrome"`).
- Static export needs a built shell. The driver rebuilds `dist/` with
  `bun run build` before A3; pass `--no-build` to reuse an existing build.
- The driver auto-starts `scripts/qa/qa-serve.mjs` with an empty
  `/tmp/report-qa-*` board and sets
  `STOA_PREVIEW_TEST_ALLOW_ORIGINS=<fixture main origin>` (legacy
  `FDE2E_REPORT_PREVIEW_TEST_ALLOW_ORIGINS` is also read) for that
  child only. The fixture's second loopback listener is deliberately NOT
  allowlisted (A8).

Commands:

```bash
# fixture-only self test (31 endpoint/stats assertions, exits 0 on success)
node scripts/qa/link-preview-fixture.mjs --self-test

# prerequisites only: fixture + isolated backend + plugin/capability surface
bun scripts/qa/link-preview.mjs --preflight

# full A1–A17 run (A6 skipped)
bun scripts/qa/link-preview.mjs

# attach to an already-running isolated qa-serve (A4/A13 auto-SKIP: the script
# never kills or restarts a backend it does not own)
REPORT_QA_BASE=http://127.0.0.1:13688 bun scripts/qa/link-preview.mjs

# keep the temp data dir for inspection after the run
bun scripts/qa/link-preview.mjs --keep-board
```

Evidence: `.agents/reports/manager/report-link-preview/steps.json` plus
screenshots in the same directory. The driver never writes `report.html`; feed
the directory to the shared `e2e-report-gen.mjs` generator.

The fixture prints one JSON line with `url`/`port`/`privateUrl`/`privatePort`
and exposes `GET /__stats` (per-path HEAD/GET/total counts, worker-UA counts,
request headers, first/last timestamps for main + private listeners),
`POST /__reset`, and `GET /__fixtures` (endpoint URLs and ready-made post
bodies, including the 4-link body used by A10).

## Notes / limitations

- `src/ui/.qa/app-grade/run.mjs` and `src/ui/.qa/p9/acceptance.mjs` now require
  `REPORT_QA_BASE` and discover the isolated data dir from `/healthz`; they no
  longer read production tokens or write to 13689. They were written for richer
  legacy fixtures (and p9 assumes open mode), so some checks may need fixture
  growth before they pass end-to-end on the default seed.
- `qa-serve` requires `bun` on PATH (the worker CLI is Bun/TypeScript);
  `BUN_BIN` overrides the binary. The launcher itself only uses Node built-ins,
  so `node scripts/qa/qa-serve.mjs` works as well.
- Temp state for `--stop` without `--data-dir`:
  `/tmp/report-qa-serve.<worktree-hash>.json`. If several live QA backends
  exist and no state file matches, the launcher refuses to guess and asks for
  `--data-dir`.

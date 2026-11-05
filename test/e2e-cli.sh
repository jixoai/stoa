#!/usr/bin/env bash
# Black-box end-to-end test for the report worker CLI (report-v0).
#
#   test/e2e-cli.sh [--selftest]
#
# It drives the CLI exactly as an agent would (`bun src/cli/main.ts ...`) and
# asserts observable truth only: exit codes, JSON fields, files on disk, SQLite
# rows, HTTP status codes and the exported static site. It never imports src/.
#
# Contract sources:
#   openspec/changes/report-v0/design.md  §6 batch / §7 wait-notifications /
#                                        §15 CLI / §19 security
#   specs/report-protocol/spec.md         batch, notification, visibility, auth
#   specs/report-surface/spec.md          lifecycle, SSG export
#   specs/report-thread-model/spec.md     self-thread + i/n
#
# Requirements: bash 3.2+, bun, curl, jq, lsof, a free port in 13680~13699.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_ENTRY="$REPO_DIR/src/cli/main.ts"
CLI=(bun "$CLI_ENTRY")

# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/json.sh
source "$SCRIPT_DIR/lib/json.sh"

RUN_TMP="$(mktemp -d "${TMPDIR:-/tmp}/report-e2e.XXXXXX")"
# init writes a .report-pointer into cwd; run everything from the temp dir so
# the checkout stays clean.
cd "$RUN_TMP"
DATA="$RUN_TMP/data"
RUN_ID="$(date +%s)-$$-$RANDOM"
URL=""
PORT=""

SERVER_PID=""
SERVER_MODE=""
SERVE_LOG=""
SERVE_ERR=""
WAITER_PID=""
WAITER_OUT=""
WAITER_ERR=""
BATCH_PID=""
FEEDER_PID=""
FIFO_FD_OPEN=0
AUTH_ON=0
AUTH_ENV_FILE=""
AUTH_SECRET_1="e2e-auth-one-$RUN_ID"
AUTH_SECRET_2="e2e-auth-two-$RUN_ID"
ACCESS_TOKEN=""
CAPS_FILE=""

WAIT_DELIVERY_SECS=45   # design §7: idle waiter re-checks on a 25s heartbeat
WAIT_BLOCKED_SECS=4

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

usage() {
  cat <<'EOF'
usage: test/e2e-cli.sh [--selftest]

  (no args)   run the full black-box E2E against bun src/cli/main.ts
  --selftest  exercise the assertion/JSON helpers only (no implementation needed)
  E2E_KEEP=1  keep the temporary data directory after the run
EOF
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  if [ "${FIFO_FD_OPEN:-0}" = "1" ]; then
    exec 3>&- 2>/dev/null
  fi
  if [ -n "${WAITER_PID:-}" ]; then kill -9 "$WAITER_PID" 2>/dev/null; fi
  if [ -n "${BATCH_PID:-}" ]; then kill -9 "$BATCH_PID" 2>/dev/null; fi
  if [ -n "${FEEDER_PID:-}" ]; then kill -9 "$FEEDER_PID" 2>/dev/null; fi
  if [ -n "${SERVER_PID:-}" ]; then kill "$SERVER_PID" 2>/dev/null; fi
  if [ -f "$DATA/server.json" ]; then
    local pid
    pid=$(jq -r '.pid // empty' "$DATA/server.json" 2>/dev/null)
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; fi
  fi
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "$DATA" 2>/dev/null
  fi
  sleep 0.2
  if [ "${E2E_KEEP:-0}" = "1" ]; then
    printf '\n[cleanup] kept temp dir: %s\n' "$RUN_TMP"
  else
    cd /
    rm -rf "$RUN_TMP"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

finish() {
  printf '\n==== E2E SUMMARY ====\n'
  printf 'PASS=%d  FAIL=%d  SKIP=%d\n' "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    printf 'FAILED:\n%s' "$FAILED_CHECKS"
    if [ -n "${SERVE_ERR:-}" ] && [ -s "$SERVE_ERR" ]; then
      printf '\n--- serve stderr (tail) ---\n'
      tail -n 20 "$SERVE_ERR" 2>/dev/null || true
    fi
    return 1
  fi
  return 0
}

fatal() {
  fail "中止: $1" "${2:-}"
  if finish; then :; fi
  exit 2
}

# ---------------------------------------------------------------------------
# Environment isolation / port / service helpers
# ---------------------------------------------------------------------------

# Never inherit ambient report credentials from the developer shell.
for _v in $(env | sed -n 's/^\(FDE2E_REPORT_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$_v" 2>/dev/null || true
done
unset _v

pick_port() {
  local i=0 p
  while [ "$i" -lt 60 ]; do
    p=$((13680 + (RANDOM % 20)))
    if ! command -v lsof >/dev/null 2>&1; then
      printf '%s' "$p"
      return 0
    fi
    if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      printf '%s' "$p"
      return 0
    fi
    i=$((i + 1))
  done
  printf ''
}

serve_env_list() {
  # Later files override earlier ones (design §4). The dedicated auth file goes
  # last so it wins even if init provisioned an FDE2E_REPORT_AUTH into DATA/.env.
  if [ "$AUTH_ON" = "1" ] && [ -n "$AUTH_ENV_FILE" ]; then
    printf '%s' "$DATA/.env,$AUTH_ENV_FILE"
  else
    printf '%s' "$DATA/.env"
  fi
}

env_files_for() {
  # Per-account env file first, then DATA/.env, then the live auth file last.
  local acct=$1
  if [ "$AUTH_ON" = "1" ] && [ -n "$AUTH_ENV_FILE" ]; then
    printf '%s' "$DATA/accounts/$acct.env,$DATA/.env,$AUTH_ENV_FILE"
  else
    printf '%s' "$DATA/accounts/$acct.env,$DATA/.env"
  fi
}

start_serve_foreground() {
  local envlist=$1
  SERVE_LOG="$RUN_TMP/serve.log"
  SERVE_ERR="$RUN_TMP/serve.err"
  : >"$SERVE_LOG"
  : >"$SERVE_ERR"
  "${CLI[@]}" serve --data-dir "$DATA" --port "$PORT" --env-files "$envlist" \
    >"$SERVE_LOG" 2>"$SERVE_ERR" &
  SERVER_PID=$!
  SERVER_MODE="foreground"
}

start_serve_daemon() {
  local envlist=$1
  SERVE_LOG="$RUN_TMP/serve.log"
  SERVE_ERR="$RUN_TMP/serve.err"
  : >"$SERVE_LOG"
  : >"$SERVE_ERR"
  cli_run serve --data-dir "$DATA" --port "$PORT" --daemon --env-files "$envlist"
  if [ "$CLI_RC" -ne 0 ]; then
    fail "serve --daemon" "exit=$CLI_RC stderr=$(first_line_of "$CLI_ERR")"
    return 1
  fi
  SERVER_MODE="daemon"
  SERVER_PID=$(json_server_field "$DATA" pid)
  return 0
}

stop_serve() {
  cli_run serve --data-dir "$DATA" --stop --env-files "$(serve_env_list)"
  if [ "$CLI_RC" -ne 0 ]; then
    return 1
  fi
  return 0
}

start_waiter() {
  # start_waiter <account> <output-base> [extra args...]
  local acct=$1 base=$2
  shift 2
  WAITER_OUT="$base.out"
  WAITER_ERR="$base.err"
  "${CLI[@]}" wait-notifications --as "$acct" --data-dir "$DATA" \
    --env-files "$(env_files_for "$acct")" --no-export "$@" \
    >"$WAITER_OUT" 2>"$WAITER_ERR" &
  WAITER_PID=$!
}

drain_account() {
  # Consume everything already unread until the next waiter really blocks.
  local acct=$1 i=0 rc
  while [ "$i" -lt 12 ]; do
    start_waiter "$acct" "$RUN_TMP/drain-$acct-$i"
    rc=0
    wait_bg "$WAITER_PID" 3 || rc=$?
    if [ "$rc" -eq 124 ]; then
      return 0
    fi
    if [ "$rc" -ne 0 ]; then
      return 1
    fi
    i=$((i + 1))
  done
  return 0
}

# ---------------------------------------------------------------------------
# Draft helpers (CLI first, SQLite as a second source of truth)
# ---------------------------------------------------------------------------

db_draft_count() {
  local acct=$1 out
  out=$(DB_PATH="$DATA/report.sqlite" DB_ACCT="$acct" bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.DB_PATH, { readonly: true });
    const row = db.query("select count(*) as c from drafts where author = ?").get(process.env.DB_ACCT);
    console.log(Number(row && row.c ? row.c : 0));
  ' 2>/dev/null) || { printf '%s' "-1"; return 0; }
  printf '%s' "${out:--1}"
}

db_draft_items_count() {
  # Number of persisted items in the account's open draft (0 when none).
  local acct=$1 out
  out=$(DB_PATH="$DATA/report.sqlite" DB_ACCT="$acct" bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.DB_PATH, { readonly: true });
    const row = db.query("select items_json from drafts where author = ? and status = ? order by updated_at desc limit 1").get(process.env.DB_ACCT, "open");
    let n = 0;
    if (row && typeof row.items_json === "string") {
      try { n = JSON.parse(row.items_json).length } catch { n = 0 }
    }
    console.log(Number(n));
  ' 2>/dev/null) || { printf '%s' "-1"; return 0; }
  printf '%s' "${out:--1}"
}

db_post_count_with_sub() {
  # Ground truth for "was this body ever committed?" (drafts live in another
  # table, so an uncommitted batch must leave this at 0).
  local needle=$1 out
  out=$(DB_PATH="$DATA/report.sqlite" DB_NEEDLE="$needle" bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.DB_PATH, { readonly: true });
    const row = db.query("select count(*) as c from posts where body_md like ?").get("%" + process.env.DB_NEEDLE + "%");
    console.log(Number(row && row.c ? row.c : 0));
  ' 2>/dev/null) || { printf '%s' "-1"; return 0; }
  printf '%s' "${out:--1}"
}

check_invisible_via_search() {
  # check_invisible_via_search <label> <body>: manager is global, so a search
  # hit means the body was committed (search summaries expose post ids, not bodies).
  local label=$1 body=$2 n
  cli_run search "$body" --as manager --data-dir "$DATA" \
    --env-files "$(env_files_for manager)" --limit 50
  if [ "$CLI_RC" -ne 0 ]; then
    fail "$label" "search 失败 exit=$CLI_RC"
    return 0
  fi
  n=$(json_posts_length "$CLI_OUT")
  check_eq "$label（search 命中数）" "$n" "0"
}

draft_exists() {
  local acct=$1 c
  c=$(db_draft_count "$acct")
  case "$c" in
    ''|*[!0-9-]*) c="-1" ;;
  esac
  if [ "$c" -gt 0 ] 2>/dev/null; then
    return 0
  fi
  cli_run draft ls --as "$acct" --data-dir "$DATA" --env-files "$(env_files_for "$acct")"
  if [ "$CLI_RC" -eq 0 ] && json_draft_present "$CLI_OUT"; then
    return 0
  fi
  return 1
}

draft_show() {
  local acct=$1 envf id=""
  envf=$(env_files_for "$acct")
  cli_run draft show --as "$acct" --data-dir "$DATA" --env-files "$envf"
  if [ "$CLI_RC" -eq 0 ]; then return 0; fi
  cli_run draft ls --as "$acct" --data-dir "$DATA" --env-files "$envf"
  if [ "$CLI_RC" -eq 0 ]; then id=$(json_draft_id "$CLI_OUT" "$acct"); fi
  if [ -n "$id" ]; then
    cli_run draft show "$id" --as "$acct" --data-dir "$DATA" --env-files "$envf"
    if [ "$CLI_RC" -eq 0 ]; then return 0; fi
    cli_run draft show --draft "$id" --as "$acct" --data-dir "$DATA" --env-files "$envf"
    if [ "$CLI_RC" -eq 0 ]; then return 0; fi
  fi
  return 1
}

draft_discard() {
  local acct=$1 envf id="" rc
  envf=$(env_files_for "$acct")
  cli_run draft ls --as "$acct" --data-dir "$DATA" --env-files "$envf"
  if [ "$CLI_RC" -eq 0 ]; then id=$(json_draft_id "$CLI_OUT" "$acct"); fi
  if [ -n "$id" ]; then
    cli_run draft discard --draft "$id" --as "$acct" --data-dir "$DATA" --env-files "$envf"
    if [ "$CLI_RC" -eq 0 ]; then return 0; fi
    cli_run draft discard "$id" --as "$acct" --data-dir "$DATA" --env-files "$envf"
    if [ "$CLI_RC" -eq 0 ]; then return 0; fi
    cli_run draft discard --id "$id" --as "$acct" --data-dir "$DATA" --env-files "$envf"
    if [ "$CLI_RC" -eq 0 ]; then return 0; fi
  fi
  cli_run draft discard --as "$acct" --data-dir "$DATA" --env-files "$envf"
  if [ "$CLI_RC" -eq 0 ]; then return 0; fi
  return 1
}

# ---------------------------------------------------------------------------
# Batch JSONL helpers
# ---------------------------------------------------------------------------

BATCH_SCHEMA=""

batch_line_for() {
  # batch_line_for <schema-name> <body>
  case "$1" in
    op)     jq -cn --arg b "$2" '{op:"post",body:$b}' ;;
    body)   jq -cn --arg b "$2" '{body:$b}' ;;
    type)   jq -cn --arg b "$2" '{type:"post",body:$b}' ;;
    kind)   jq -cn --arg b "$2" '{kind:"post",body:$b}' ;;
    text)   jq -cn --arg b "$2" '{text:$b}' ;;
    action) jq -cn --arg b "$2" '{action:"post",body:$b}' ;;
    optext) jq -cn --arg b "$2" '{op:"post",text:$b}' ;;
    *)      printf '{}' ;;
  esac
}

batch_line() {
  batch_line_for "$BATCH_SCHEMA" "$1"
}

detect_batch_schema() {
  # The spec fixes the terminator and the "one operation per line" rule but not
  # the operation object shape. Probe the plausible shapes once, then reuse the
  # accepted one everywhere else. A probe post by sub-probe is invisible to
  # sub-a/sub-b/sub-c (no mention).
  local name body line probe_id
  for name in op body type kind text action optext; do
    body="E2E-S6-PROBE-$name-$RUN_ID"
    line=$(batch_line_for "$name" "$body")
    draft_discard sub-probe >/dev/null 2>&1 || true
    printf '%s\n%s\n' "$line" '{"commit":true}' >"$RUN_TMP/probe-batch.jsonl"
    cli_run_stdin "$RUN_TMP/probe-batch.jsonl" post --batch --as sub-probe \
      --data-dir "$DATA" --env-files "$(env_files_for sub-probe)"
    if [ "$CLI_RC" -eq 0 ]; then
      probe_id=$(jq -r '.posts[0].id // empty' "$CLI_OUT" 2>/dev/null || true)
      if [ -n "$probe_id" ]; then
        # read --thread returns raw ThreadNodes (with body_md), unlike the
        # timeline/search summaries which only carry ids.
        cli_run read --as sub-probe --thread "$probe_id" --limit 50 \
          --data-dir "$DATA" --env-files "$(env_files_for sub-probe)"
        if [ "$CLI_RC" -eq 0 ] && json_has_sub "$CLI_OUT" "$body"; then
          BATCH_SCHEMA=$name
          printf '%s' "$body" >"$RUN_TMP/probe-body.txt"
          note "batch JSONL 操作格式探测结果: {\"$name\":...} + {\"commit\":true}"
          return 0
        fi
      fi
    fi
  done
  return 1
}

# ===========================================================================
# Scenarios
# ===========================================================================

s0_preflight() {
  section S0 "前置条件与工具链"

  if command -v bun >/dev/null 2>&1; then pass "bun 可用"; else fatal "缺少 bun"; fi
  if command -v curl >/dev/null 2>&1; then pass "curl 可用"; else fatal "缺少 curl"; fi
  if command -v jq >/dev/null 2>&1; then pass "jq 可用"; else fatal "缺少 jq"; fi
  if command -v lsof >/dev/null 2>&1; then
    pass "lsof 可用（端口占用检测）"
  else
    note "lsof 不可用，端口冲突只能靠随机重试"
  fi

  if [ ! -f "$CLI_ENTRY" ]; then
    fatal "CLI 入口不存在（实现尚未落地）" "$CLI_ENTRY"
  fi
  pass "CLI 入口存在: $CLI_ENTRY"

  cli_run --version
  if [ "$CLI_RC" -eq 0 ] && [ -s "$CLI_OUT" ]; then
    pass "--version 退出 0 且有输出"
  else
    fail "--version" "exit=$CLI_RC stderr=$(first_line_of "$CLI_ERR")"
  fi

  # capabilities still resolves a data dir before dispatch; point it at the
  # (not yet created) data dir so the probe itself does not require init.
  cli_run capabilities --data-dir "$DATA"
  CAPS_FILE="$RUN_TMP/capabilities.json"
  cp "$CLI_OUT" "$CAPS_FILE" 2>/dev/null || true
  if [ "$CLI_RC" -eq 0 ] && jq -e . "$CAPS_FILE" >/dev/null 2>&1; then
    pass "capabilities 输出合法 JSON"
  else
    fail "capabilities" "exit=$CLI_RC（非 JSON 或失败）"
  fi

  PORT=$(pick_port)
  if [ -z "$PORT" ]; then
    fatal "13680~13699 内没有空闲端口"
  fi
  URL="http://127.0.0.1:$PORT"
  if [ "$PORT" -ge 13680 ] && [ "$PORT" -le 13699 ]; then
    pass "选定窄段端口 $PORT"
  else
    fail "端口越界" "$PORT"
  fi
}

s1_init() {
  section S1 "init 数据目录、固定账号与凭据文件"

  # Explicit --env-files points at a file that does not exist, so init does NOT
  # first-provision a random FDE2E_REPORT_AUTH into DATA/.env (design §4).
  # The early scenarios must run in open mode; S11 tests the open -> auth restart.
  if ! cli_expect_ok "1.1 init --data-dir 成功" init --data-dir "$DATA" \
      --env-files "$RUN_TMP/init-env-absent.env"; then
    fatal "init 失败，无法继续" "$(first_line_of "$CLI_ERR")"
  fi

  check_dir "1.2 accounts/ 目录存在" "$DATA/accounts"
  check_dir "1.3 media/ 目录存在" "$DATA/media"
  check_dir "1.4 export/ 目录存在" "$DATA/export"
  check_file "1.5 report.sqlite 存在" "$DATA/report.sqlite"
  check_file "1.6 DATA_PATH/.env 存在（签名盐）" "$DATA/.env"

  check_file "1.7 accounts/owner.env 存在" "$DATA/accounts/owner.env"
  check_mode "1.8 accounts/owner.env 权限 600" "$DATA/accounts/owner.env" "600"
  check_nonempty_file "1.9 accounts/owner.env 非空" "$DATA/accounts/owner.env"

  check_file "1.10 accounts/manager.env 存在" "$DATA/accounts/manager.env"
  check_mode "1.11 accounts/manager.env 权限 600" "$DATA/accounts/manager.env" "600"
  check_nonempty_file "1.12 accounts/manager.env 非空" "$DATA/accounts/manager.env"

  TOKEN_OWNER=$(env_token "$DATA/accounts/owner.env")
  TOKEN_MANAGER=$(env_token "$DATA/accounts/manager.env")
  if [ -n "$TOKEN_OWNER" ]; then pass "1.13 owner.env 含可用 token"; else fail "1.13 owner.env 含可用 token" "未解析到值"; fi
  if [ -n "$TOKEN_MANAGER" ]; then pass "1.14 manager.env 含可用 token"; else fail "1.14 manager.env 含可用 token" "未解析到值"; fi
  check_ne "1.15 owner/manager token 不同" "$TOKEN_OWNER" "$TOKEN_MANAGER"
}

s2_serve() {
  section S2 "serve 生命周期、server.json 与服务发现"

  start_serve_foreground "$(serve_env_list)"

  if wait_report_url_line "$SERVE_LOG" 150; then
    FIRST_LINE=$(first_line_of "$SERVE_LOG")
    case "$FIRST_LINE" in
      REPORT_URL=*) pass "2.1 serve stdout 首行是 REPORT_URL=" ;;
      *) fail "2.1 serve stdout 首行是 REPORT_URL=" "got=[$FIRST_LINE]" ;;
    esac
  else
    fail "2.1 serve stdout 首行是 REPORT_URL=" "超时未出现（stderr: $(first_line_of "$SERVE_ERR")）"
  fi

  if wait_health "$URL" 150; then
    pass "2.2 /healthz 返回 200"
  else
    fatal "服务未就绪，后续场景无法运行" "healthz=$(http_code "$URL/healthz")"
  fi

  check_file "2.3 DATA_PATH/server.json 已写入" "$DATA/server.json"
  check_json_file "2.3a server.json 合法 JSON" "$DATA/server.json"
  MISSING_KEYS=$(jq -r --argjson req '["port","pid","url","startedAt","dataDir","instanceId"]' \
    '($req - keys) | join(",")' "$DATA/server.json" 2>/dev/null || true)
  check_eq "2.4 server.json 含 port/pid/url/startedAt/dataDir/instanceId" "$MISSING_KEYS" ""

  JSON_PORT=$(json_server_field "$DATA" port)
  check_eq "2.5 server.json.port 等于真实监听端口" "$JSON_PORT" "$PORT"

  JSON_URL=$(json_server_field "$DATA" url)
  case "$JSON_URL" in
    *":$PORT"*) pass "2.6 server.json.url 指向真实端口" ;;
    *) fail "2.6 server.json.url 指向真实端口" "url=[$JSON_URL]" ;;
  esac

  JSON_DATA_DIR=$(json_server_field "$DATA" dataDir)
  if [ "$(abspath "$JSON_DATA_DIR")" = "$(abspath "$DATA")" ]; then
    pass "2.7 server.json.dataDir 指向本次数据目录"
  else
    fail "2.7 server.json.dataDir 指向本次数据目录" "got=[$JSON_DATA_DIR]"
  fi

  JSON_PID=$(json_server_field "$DATA" pid)
  if [ -n "$JSON_PID" ] && pid_alive "$JSON_PID"; then
    pass "2.8 server.json.pid 是活进程"
  else
    fail "2.8 server.json.pid 是活进程" "pid=[$JSON_PID]"
  fi

  if cli_expect_ok "2.9 status 命中同一实例" status --data-dir "$DATA" --env-files "$(serve_env_list)"; then
    :
  fi

  if cli_expect_ok "2.10 who 无 --port 也能发现服务" who --as owner --data-dir "$DATA" --env-files "$(env_files_for owner)"; then
    check_contains_file "2.10a who 列出 owner" "$CLI_OUT" "owner"
    check_contains_file "2.10b who 列出 manager" "$CLI_OUT" "manager"
  fi

  if cli_expect_ok "2.11 serve --stop 正常停止" serve --data-dir "$DATA" --stop --env-files "$(serve_env_list)"; then
    SERVER_PID=""
  fi
  if wait_health_down "$URL" 80; then
    pass "2.12 停止后 /healthz 不再 200"
  else
    fail "2.12 停止后 /healthz 不再 200" "仍在响应"
  fi
  sleep 0.4   # let the old process release serve.lock

  if start_serve_daemon "$(serve_env_list)"; then
    pass "2.13 serve --daemon 启动"
  fi
  if wait_health "$URL" 150; then
    pass "2.14 daemon 后 /healthz 返回 200"
  else
    fatal "daemon 未能就绪" "healthz=$(http_code "$URL/healthz")"
  fi
  JSON_PID=$(json_server_field "$DATA" pid)
  if [ -n "$JSON_PID" ] && pid_alive "$JSON_PID"; then
    pass "2.15 daemon pid 存活"
  else
    fail "2.15 daemon pid 存活" "pid=[$JSON_PID]"
  fi
}

create_account() {
  # create_account <id> <profile>
  local id=$1 profile=$2 token
  if cli_expect_ok "创建子账号 $id" accounts create "$id" --role agent \
      --display "E2E $id" --profile "$profile" \
      --as manager --data-dir "$DATA" --env-files "$(env_files_for manager)"; then
    :
  fi
  check_file "accounts/$id.env 存在" "$DATA/accounts/$id.env"
  check_mode "accounts/$id.env 权限 600" "$DATA/accounts/$id.env" "600"
  token=$(env_token "$DATA/accounts/$id.env")
  if [ -n "$token" ]; then
    pass "accounts/$id.env 含 token"
  else
    fail "accounts/$id.env 含 token" "未解析到值"
  fi
}

s3_accounts() {
  section S3 "manager 建子账号、token 按账号独立落盘"

  create_account sub-a "E2E A 负责发帖"
  create_account sub-b "E2E B 负责回复"
  create_account sub-c "E2E C 无关观察者"
  create_account sub-probe "E2E batch 探测专用"

  TOKEN_A=$(env_token "$DATA/accounts/sub-a.env")
  TOKEN_B=$(env_token "$DATA/accounts/sub-b.env")
  TOKEN_C=$(env_token "$DATA/accounts/sub-c.env")
  TOKEN_P=$(env_token "$DATA/accounts/sub-probe.env")

  check_ne "3.1 sub-a 与 sub-b token 不同" "$TOKEN_A" "$TOKEN_B"
  check_ne "3.2 sub-a 与 sub-c token 不同" "$TOKEN_A" "$TOKEN_C"
  check_ne "3.3 sub-b 与 sub-c token 不同" "$TOKEN_B" "$TOKEN_C"

  check_not_contains_file "3.4 sub-a.env 不含 sub-b token" "$DATA/accounts/sub-a.env" "$TOKEN_B"
  check_not_contains_file "3.5 sub-b.env 不含 sub-a token" "$DATA/accounts/sub-b.env" "$TOKEN_A"
  check_not_contains_file "3.6 sub-a.env 不含 manager token" "$DATA/accounts/sub-a.env" "$TOKEN_MANAGER"
  check_not_contains_file "3.7 sub-b.env 不含 owner token" "$DATA/accounts/sub-b.env" "$TOKEN_OWNER"
  check_not_contains_file "3.8 sub-c.env 不含 sub-probe token" "$DATA/accounts/sub-c.env" "$TOKEN_P"

  if cli_expect_ok "3.9 accounts ls 成功" accounts ls --as manager \
      --data-dir "$DATA" --env-files "$(env_files_for manager)"; then
    check_contains_file "3.10 accounts ls 含 sub-a" "$CLI_OUT" "sub-a"
    check_contains_file "3.11 accounts ls 含 sub-b" "$CLI_OUT" "sub-b"
    check_contains_file "3.12 accounts ls 含 sub-c" "$CLI_OUT" "sub-c"
  fi
}

s4_post_and_wakeup() {
  section S4 "A 发帖 @B，B 的 wait-notifications 被唤醒"

  BODY4="E2E-S4-A-ROOT-$RUN_ID @sub-b"

  start_waiter sub-b "$RUN_TMP/s4-b"
  sleep 0.6

  if cli_expect_ok "4.1 A 发帖成功" post "$BODY4" --as sub-a \
      --data-dir "$DATA" --env-files "$(env_files_for sub-a)"; then
    :
  fi
  A_POST=$(json_post_id "$CLI_OUT" "$BODY4")
  if [ -z "$A_POST" ]; then A_POST=$(json_post_id_from_result "$CLI_OUT"); fi
  if [ -n "$A_POST" ]; then
    pass "4.2 解析到 A 的帖 id ($A_POST)"
  else
    fail "4.2 解析到 A 的帖 id" "CLI 输出无 post id"
  fi

  RC=0
  wait_bg "$WAITER_PID" "$WAIT_DELIVERY_SECS" || RC=$?
  check_eq "4.3 B 的 wait-notifications 退出码" "$RC" "0"
  check_jsonl "4.4 B 收到合法 JSONL" "$WAITER_OUT"
  if json_has_sub "$WAITER_OUT" "$BODY4"; then
    pass "4.5 B 收到被 @ 的帖子正文"
  else
    fail "4.5 B 收到被 @ 的帖子正文" "输出中找不到 [$BODY4]"
  fi
  if json_has_sub "$WAITER_OUT" "sub-a"; then
    pass "4.6 交付事件携带 actor=sub-a"
  else
    fail "4.6 交付事件携带 actor=sub-a"
  fi
  if [ -n "$A_POST" ] && jq -s -e --arg pid "$A_POST" \
      'any(.[]; .type == "post.created" and .actor == "sub-a" and .post_id == $pid)' \
      "$WAITER_OUT" >/dev/null 2>&1; then
    pass "4.7 交付事件是 sub-a 的 post.created 且 post_id 命中"
  else
    fail "4.7 交付事件是 sub-a 的 post.created 且 post_id 命中" "post_id=[$A_POST]"
  fi
}

s5_reply_delivery() {
  section S5 "B 回复 → A 的下一次 wait 收到回复"

  if [ -z "$A_POST" ]; then
    fail "5.0 缺少 A 的帖 id，回复场景无法执行"
    skip "5.1-5.6 B 回复与 A 收取"
    return 0
  fi

  if drain_account sub-a; then
    pass "5.1 A 已消费自己发帖产生的历史未读"
  else
    fail "5.1 A 已消费自己发帖产生的历史未读" "drain 失败"
  fi

  BODY5="E2E-S5-B-REPLY-$RUN_ID"

  start_waiter sub-a "$RUN_TMP/s5-a"
  sleep 0.6

  B_REPLY=""
  if cli_expect_ok "5.2 B 回复 A 的帖子" reply "$A_POST" "$BODY5" --as sub-b \
      --data-dir "$DATA" --env-files "$(env_files_for sub-b)"; then
    B_REPLY=$(jq -r '.posts[0].id // empty' "$CLI_OUT" 2>/dev/null || true)
    if [ -z "$B_REPLY" ]; then B_REPLY=$(json_post_id_from_result "$CLI_OUT"); fi
  fi
  if [ -n "$B_REPLY" ]; then
    pass "5.2a 解析到 B 的回复 id"
  else
    fail "5.2a 解析到 B 的回复 id"
  fi

  RC=0
  wait_bg "$WAITER_PID" "$WAIT_DELIVERY_SECS" || RC=$?
  check_eq "5.3 A 的 wait-notifications 退出码" "$RC" "0"
  check_jsonl "5.4 A 收到合法 JSONL" "$WAITER_OUT"
  # post.created payload carries ids (not the body); assert the exact event.
  if [ -n "$B_REPLY" ] && jq -s -e --arg pid "$B_REPLY" \
      'any(.[]; .type == "post.created" and .actor == "sub-b" and .post_id == $pid)' \
      "$WAITER_OUT" >/dev/null 2>&1; then
    pass "5.5 A 收到 B 的 post.created（post_id 命中）"
  else
    fail "5.5 A 收到 B 的 post.created（post_id 命中）" "reply=[$B_REPLY]"
  fi
  if json_has_sub "$WAITER_OUT" "$BODY4"; then
    fail "5.6 已读的旧帖不重复交付" "仍出现 [$BODY4]"
  else
    pass "5.6 已读的旧帖不重复交付"
  fi
}

s6_batch() {
  section S6 "批事务：一次交付全部 / 中途 kill 不可见"

  if detect_batch_schema; then
    pass "6.1 batch JSONL 格式可用（$BATCH_SCHEMA）"
  else
    fail "6.1 batch JSONL 格式可用" "候选格式全部被拒"
    skip "6.2-6.20 batch 交付与 kill 语义（无可用格式）"
    return 0
  fi

  if drain_account manager; then
    pass "6.2 manager 游标追平探测期事件"
  else
    fail "6.2 manager 游标追平探测期事件" "drain 失败"
  fi

  BODY6A="E2E-S6A-BATCH-ONE-$RUN_ID"
  BODY6B="E2E-S6A-BATCH-TWO-$RUN_ID"
  BODY6C="E2E-S6A-BATCH-THREE-$RUN_ID"

  start_waiter manager "$RUN_TMP/s6-manager"
  sleep 0.6

  {
    batch_line "$BODY6A"
    batch_line "$BODY6B"
    batch_line "$BODY6C"
    printf '%s\n' '{"commit":true}'
  } >"$RUN_TMP/batch6.jsonl"

  cli_run_stdin "$RUN_TMP/batch6.jsonl" post --batch --as sub-b \
    --data-dir "$DATA" --env-files "$(env_files_for sub-b)"
  if [ "$CLI_RC" -eq 0 ]; then
    pass "6.3 3 行 + 显式终止符提交成功"
  else
    fail "6.3 3 行 + 显式终止符提交成功" "exit=$CLI_RC stderr=$(first_line_of "$CLI_ERR")"
  fi
  BID1=$(jq -r '.posts[0].id // empty' "$CLI_OUT" 2>/dev/null || true)
  BID2=$(jq -r '.posts[1].id // empty' "$CLI_OUT" 2>/dev/null || true)
  BID3=$(jq -r '.posts[2].id // empty' "$CLI_OUT" 2>/dev/null || true)
  if [ -n "$BID1" ] && [ -n "$BID2" ] && [ -n "$BID3" ]; then
    pass "6.3a 提交结果返回 3 条帖 id"
  else
    fail "6.3a 提交结果返回 3 条帖 id" "[$BID1][$BID2][$BID3]"
  fi

  RC=0
  wait_bg "$WAITER_PID" "$WAIT_DELIVERY_SECS" || RC=$?
  check_eq "6.4 manager 一次 wait 退出码" "$RC" "0"
  check_jsonl "6.5 manager 收到合法 JSONL" "$WAITER_OUT"

  LINES=$(json_line_count "$WAITER_OUT")
  check_eq "6.6 一次交付恰好 3 条事件" "$LINES" "3"
  # post.created payload carries post ids (not bodies); assert each committed
  # id is delivered exactly once in that single wait.
  for pair in "6.7a:$BID1" "6.7b:$BID2" "6.7c:$BID3"; do
    label=${pair%%:*}
    pid=${pair#*:}
    if [ -z "$pid" ]; then
      fail "$label 每条交付一次" "缺少 post id"
      continue
    fi
    count=$(json_count_with_sub "$WAITER_OUT" "$pid")
    check_eq "$label 每条交付一次" "$count" "1"
  done
  if json_seq_ok "$WAITER_OUT"; then
    pass "6.8 交付按 seq 非降序"
  else
    fail "6.8 交付按 seq 非降序" "seq=$(json_seq_csv "$WAITER_OUT")"
  fi
  if jq -s -e 'length == 3 and all(.[]; .type == "post.created" and .actor == "sub-b")' \
      "$WAITER_OUT" >/dev/null 2>&1; then
    pass "6.8a 三条事件均为 sub-b 的 post.created（无额外快照/邀请）"
  else
    fail "6.8a 三条事件均为 sub-b 的 post.created" "$(jq -s -c '[.[] | {type, actor}]' "$WAITER_OUT" 2>/dev/null || true)"
  fi

  # --- mid-batch kill: feed 2 lines, kill the CLI, batch must stay invisible --
  BODY6K1="E2E-S6B-KILLED-ONE-$RUN_ID"
  BODY6K2="E2E-S6B-KILLED-TWO-$RUN_ID"
  FIFO="$RUN_TMP/feed6.fifo"
  rm -f "$FIFO"
  mkfifo "$FIFO"

  (
    exec 3>"$FIFO"
    printf '%s\n' "$(batch_line "$BODY6K1")" "$(batch_line "$BODY6K2")" >&3
    sleep 30
  ) &
  FEEDER_PID=$!

  "${CLI[@]}" post --batch --as sub-a --data-dir "$DATA" \
    --env-files "$(env_files_for sub-a)" <"$FIFO" \
    >"$RUN_TMP/b6.out" 2>"$RUN_TMP/b6.err" &
  BATCH_PID=$!

  DRAFT_SEEN=0
  DRAFT_ITEMS=0
  for ((i = 0; i < 60; i++)); do
    DRAFT_ITEMS=$(db_draft_items_count sub-a)
    if [ "$DRAFT_ITEMS" -ge 2 ] 2>/dev/null; then
      DRAFT_SEEN=1
      break
    fi
    if draft_exists sub-a; then DRAFT_SEEN=1; fi
    sleep 0.1
  done
  if [ "$DRAFT_SEEN" = "1" ]; then
    pass "6.9 两行落盘后即可见 open draft"
  else
    fail "6.9 两行落盘后即可见 open draft" "poll 6s 未发现 draft"
  fi
  if [ "$DRAFT_ITEMS" -ge 2 ] 2>/dev/null; then
    pass "6.9a 两行均已逐行落盘（items=$DRAFT_ITEMS）"
  else
    fail "6.9a 两行均已逐行落盘" "items=$DRAFT_ITEMS"
  fi

  sleep 0.3
  kill -9 "$BATCH_PID" 2>/dev/null || true
  BRC=0
  wait "$BATCH_PID" 2>/dev/null || BRC=$?
  kill -9 "$FEEDER_PID" 2>/dev/null || true
  wait "$FEEDER_PID" 2>/dev/null || true
  FEEDER_PID=""
  BATCH_PID=""
  rm -f "$FIFO"

  if [ "$BRC" -eq 137 ] || [ "$BRC" -eq 9 ]; then
    pass "6.10 批进程已被 kill（rc=$BRC）"
  else
    fail "6.10 批进程已被 kill" "rc=$BRC（可能提前退出，kill 场景失效）"
  fi

  if draft_exists sub-a; then
    pass "6.11 kill 后草稿仍存在（draft ls / drafts 表）"
  else
    fail "6.11 kill 后草稿仍存在" "未发现 draft"
  fi

  # A killed batch must never reach the posts table and must never be returned
  # by a manager search (global visibility). read/timeline summaries carry ids
  # only, so search + SQLite are the authoritative checks here.
  check_invisible_via_search "6.12 kill 的半批对 manager 不可见（第 1 行）" "$BODY6K1"
  check_invisible_via_search "6.13 kill 的半批对 manager 不可见（第 2 行）" "$BODY6K2"
  COUNT6K1=$(db_post_count_with_sub "$BODY6K1")
  COUNT6K2=$(db_post_count_with_sub "$BODY6K2")
  check_eq "6.14 posts 表中没有第 1 行（draft 未提交）" "$COUNT6K1" "0"
  check_eq "6.15 posts 表中没有第 2 行（draft 未提交）" "$COUNT6K2" "0"

  start_waiter manager "$RUN_TMP/s6-block"
  RC=0
  wait_bg "$WAITER_PID" "$WAIT_BLOCKED_SECS" || RC=$?
  if [ "$RC" -eq 124 ] && [ ! -s "$WAITER_OUT" ]; then
    pass "6.16 kill 的半批不会唤醒 manager"
  else
    fail "6.16 kill 的半批不会唤醒 manager" "rc=$RC bytes=$(wc -c <"$WAITER_OUT" | tr -d ' ')"
  fi

  if draft_show sub-a; then
    check_contains_file "6.17 draft show 含第 1 行" "$CLI_OUT" "$BODY6K1"
    check_contains_file "6.18 draft show 含第 2 行" "$CLI_OUT" "$BODY6K2"
  else
    fail "6.17 draft show 可读" "draft show 失败"
    skip "6.18 draft show 含第 2 行"
  fi

  if draft_discard sub-a; then
    pass "6.19 draft discard 成功"
    sleep 0.2
    if draft_exists sub-a; then
      fail "6.20 discard 后草稿消失" "仍可见"
    else
      pass "6.20 discard 后草稿消失"
    fi
  else
    fail "6.19 draft discard 成功" "所有 discard 变体都失败"
    skip "6.20 discard 后草稿消失"
  fi
}

s7_naked_eof() {
  section S7 "裸 EOF 不提交、保留草稿"

  BODY7="E2E-S7-NAKED-EOF-$RUN_ID"

  if [ -z "$BATCH_SCHEMA" ]; then
    fail "7.1 裸 EOF 应以非零退出" "batch 格式未探测成功，无法构造输入"
    skip "7.2-7.6 草稿与不可见断言"
    return 0
  fi

  printf '%s\n' "$(batch_line "$BODY7")" >"$RUN_TMP/naked7.jsonl"
  cli_run_stdin "$RUN_TMP/naked7.jsonl" post --batch --as sub-a \
    --data-dir "$DATA" --env-files "$(env_files_for sub-a)"
  if [ "$CLI_RC" -ne 0 ]; then
    pass "7.1 裸 EOF（无终止符）非零退出（rc=$CLI_RC）"
  else
    fail "7.1 裸 EOF（无终止符）非零退出" "实际 rc=0（被自动提交了）"
  fi

  if draft_exists sub-a; then
    pass "7.2 裸 EOF 留下草稿"
  else
    fail "7.2 裸 EOF 留下草稿" "未发现 draft"
  fi

  check_invisible_via_search "7.3 裸 EOF 内容对 manager 不可见（search）" "$BODY7"
  COUNT7=$(db_post_count_with_sub "$BODY7")
  check_eq "7.4 posts 表中没有裸 EOF 内容（未提交）" "$COUNT7" "0"

  if draft_show sub-a; then
    check_contains_file "7.5 draft show 含未提交正文" "$CLI_OUT" "$BODY7"
  else
    fail "7.5 draft show 含未提交正文" "draft show 失败"
  fi

  if draft_discard sub-a; then
    pass "7.6 discard 清理裸 EOF 草稿"
  else
    fail "7.6 discard 清理裸 EOF 草稿" "所有 discard 变体都失败"
  fi
}

s8_no_dup_no_loss() {
  section S8 "未读不丢不重：不重复交付，只交付新增"

  BODY8A="E2E-S8A-C-FIRST-$RUN_ID @sub-c"
  BODY8B="E2E-S8B-C-SECOND-$RUN_ID @sub-c"

  start_waiter sub-c "$RUN_TMP/s8-c1"
  sleep 0.6
  if cli_expect_ok "8.1 A 发帖 @sub-c（第一条）" post "$BODY8A" --as sub-a \
      --data-dir "$DATA" --env-files "$(env_files_for sub-a)"; then
    :
  fi
  RC=0
  wait_bg "$WAITER_PID" "$WAIT_DELIVERY_SECS" || RC=$?
  check_eq "8.2 C 第一次 wait 退出码" "$RC" "0"
  if json_has_sub "$WAITER_OUT" "$BODY8A"; then
    pass "8.3 C 第一次收到第一条"
  else
    fail "8.3 C 第一次收到第一条"
  fi

  start_waiter sub-c "$RUN_TMP/s8-c2"
  RC=0
  wait_bg "$WAITER_PID" "$WAIT_BLOCKED_SECS" || RC=$?
  if [ "$RC" -eq 124 ] && [ ! -s "$WAITER_OUT" ]; then
    pass "8.4 同一消息第二次 wait 不重复交付"
  else
    fail "8.4 同一消息第二次 wait 不重复交付" "rc=$RC bytes=$(wc -c <"$WAITER_OUT" | tr -d ' ')"
  fi

  start_waiter sub-c "$RUN_TMP/s8-c3"
  sleep 0.6
  if cli_expect_ok "8.5 A 发帖 @sub-c（第二条）" post "$BODY8B" --as sub-a \
      --data-dir "$DATA" --env-files "$(env_files_for sub-a)"; then
    :
  fi
  RC=0
  wait_bg "$WAITER_PID" "$WAIT_DELIVERY_SECS" || RC=$?
  check_eq "8.6 C 第三次 wait 退出码" "$RC" "0"
  if json_has_sub "$WAITER_OUT" "$BODY8B"; then
    pass "8.7 C 只被新消息唤醒并收到第二条"
  else
    fail "8.7 C 只被新消息唤醒并收到第二条"
  fi
  if json_has_sub "$WAITER_OUT" "$BODY8A"; then
    fail "8.8 新交付不含已读的第一条" "出现 [$BODY8A]"
  else
    pass "8.8 新交付不含已读的第一条"
  fi
}

s9_self_thread() {
  section S9 "自接线程组装与 i/n 序号"

  BODY9R="E2E-S9-ROOT-$RUN_ID"
  BODY9A="E2E-S9-SELF-ONE-$RUN_ID"
  BODY9B="E2E-S9-SELF-TWO-$RUN_ID"

  ROOT9=""
  R1=""
  R2=""

  if cli_expect_ok "9.1 A 发根帖" post "$BODY9R" --as sub-a \
      --data-dir "$DATA" --env-files "$(env_files_for sub-a)"; then
    ROOT9=$(json_post_id "$CLI_OUT" "$BODY9R")
    if [ -z "$ROOT9" ]; then ROOT9=$(json_post_id_from_result "$CLI_OUT"); fi
  fi
  if [ -n "$ROOT9" ] && cli_expect_ok "9.2 A 自回复 1" reply "$ROOT9" "$BODY9A" --as sub-a \
      --data-dir "$DATA" --env-files "$(env_files_for sub-a)"; then
    R1=$(json_post_id "$CLI_OUT" "$BODY9A")
    if [ -z "$R1" ]; then R1=$(json_post_id_from_result "$CLI_OUT"); fi
  fi
  if [ -n "$R1" ] && cli_expect_ok "9.3 A 自回复 2" reply "$R1" "$BODY9B" --as sub-a \
      --data-dir "$DATA" --env-files "$(env_files_for sub-a)"; then
    R2=$(json_post_id "$CLI_OUT" "$BODY9B")
    if [ -z "$R2" ]; then R2=$(json_post_id_from_result "$CLI_OUT"); fi
  fi

  if [ -z "$ROOT9" ] || [ -z "$R1" ] || [ -z "$R2" ]; then
    fail "9.4 自接链 id 全部解析成功" "root=[$ROOT9] r1=[$R1] r2=[$R2]"
    skip "9.5-9.18 线程组装与 i/n"
    return 0
  fi
  pass "9.4 自接链 id 全部解析成功"

  if cli_expect_ok "9.5 read --thread 成功" read --as sub-a --thread "$ROOT9" \
      --limit 200 --order asc --data-dir "$DATA" --env-files "$(env_files_for sub-a)"; then
    :
  fi
  THREAD_FILE="$CLI_OUT"

  if json_has_sub "$THREAD_FILE" "$BODY9R" \
     && json_has_sub "$THREAD_FILE" "$BODY9A" \
     && json_has_sub "$THREAD_FILE" "$BODY9B"; then
    pass "9.6 线程视图包含根帖与两条自回复"
  else
    fail "9.6 线程视图包含根帖与两条自回复"
  fi

  F9R=$(json_post_fields "$THREAD_FILE" "$BODY9R" | sed -n '1p')
  F9A=$(json_post_fields "$THREAD_FILE" "$BODY9A" | sed -n '1p')
  F9B=$(json_post_fields "$THREAD_FILE" "$BODY9B" | sed -n '1p')

  ID9R=""; PAR9R=""; ROOTID9R=""; ST9R=""
  ID9A=""; PAR9A=""; ROOTID9A=""; ST9A=""
  ID9B=""; PAR9B=""; ROOTID9B=""; ST9B=""
  IFS=$'\t' read -r ID9R PAR9R ROOTID9R ST9R _ _ <<<"$F9R" || true
  IFS=$'\t' read -r ID9A PAR9A ROOTID9A ST9A _ _ <<<"$F9A" || true
  IFS=$'\t' read -r ID9B PAR9B ROOTID9B ST9B _ _ <<<"$F9B" || true

  if [ -n "$ID9R" ] && [ -n "$ID9A" ] && [ -n "$ID9B" ]; then
    pass "9.7 线程视图带 id/parent_id/root_id/self_thread_id"
    if [ -z "$PAR9R" ]; then pass "9.8 根帖 parent_id 为空"; else fail "9.8 根帖 parent_id 为空" "parent=[$PAR9R]"; fi
    check_eq "9.9 第二条挂在根帖下" "$PAR9A" "$ID9R"
    check_eq "9.10 第三条挂在第二条下" "$PAR9B" "$ID9A"
    check_eq "9.11 三条共享 root_id" "$ROOTID9A" "$ID9R"
    check_eq "9.12 三条 root_id 一致（第三条）" "$ROOTID9B" "$ID9R"
    check_eq "9.13 三条共享 self_thread_id" "$ST9A" "$ST9R"
    check_eq "9.14 三条 self_thread_id 一致（第三条）" "$ST9B" "$ST9R"
  else
    fail "9.7 线程视图带 id/parent_id/root_id/self_thread_id" "无法在线程结果中定位三条帖"
    skip "9.8-9.14 链结构"
  fi

  PAIRS=$(json_in_pairs "$THREAD_FILE")
  for p in "1/3" "2/3" "3/3"; do
    if grep -Fxq -- "$p" <<<"$PAIRS"; then
      pass "9.15 i/n 含 $p"
    else
      fail "9.15 i/n 含 $p" "pairs=[$PAIRS]"
    fi
  done

  # Soft delete: design §15 has no delete command. Only exercise it when the
  # implementation advertises one; otherwise record an explicit SKIP.
  if [ -f "$CAPS_FILE" ] && grep -Eiq 'delete' "$CAPS_FILE"; then
    cli_run delete "$R1" --as sub-a --data-dir "$DATA" --env-files "$(env_files_for sub-a)"
    if [ "$CLI_RC" -eq 0 ]; then
      pass "9.16 CLI 支持软删除（capabilities 宣告）"
      cli_run read --as sub-a --thread "$ROOT9" --limit 200 --order asc \
        --data-dir "$DATA" --env-files "$(env_files_for sub-a)"
      if json_has_sub "$CLI_OUT" "$BODY9A"; then
        fail "9.17 软删除后中间回复正文不再出现" "仍可见"
      else
        pass "9.17 软删除后中间回复正文不再出现"
      fi
      PAIRS2=$(json_in_pairs "$CLI_OUT")
      if [ -z "$PAIRS2" ]; then
        pass "9.18 链有缺口后不返回 i/n"
      else
        fail "9.18 链有缺口后不返回 i/n" "pairs=[$PAIRS2]"
      fi
    else
      skip "9.16-9.18 软删除" "capabilities 提到 delete 但 CLI delete 命令不可用"
    fi
  else
    skip "9.16-9.18 软删除" "设计 §15 无删除命令；按任务约定跳过并注明"
  fi
}

s10_quote_visibility() {
  section S10 "引用合并参与者，且不扩大给无关账号"

  BODY10S="E2E-S10-B-SECRET-$RUN_ID @sub-a"
  BODY10Q="E2E-S10-A-QUOTE-$RUN_ID"

  SEC_ID=""
  if cli_expect_ok "10.1 B 发一条只对 {B,A} 可见的帖" post "$BODY10S" --as sub-b \
      --data-dir "$DATA" --env-files "$(env_files_for sub-b)"; then
    SEC_ID=$(json_post_id "$CLI_OUT" "$BODY10S")
    if [ -z "$SEC_ID" ]; then SEC_ID=$(json_post_id_from_result "$CLI_OUT"); fi
  fi
  if [ -z "$SEC_ID" ]; then
    fail "10.2 解析到被引用帖 id"
    skip "10.3-10.14 引用与可见性"
    return 0
  fi
  pass "10.2 解析到被引用帖 id ($SEC_ID)"

  # C is not a participant of B's root: a thread read must be NOT_FOUND.
  cli_run read --as sub-c --thread "$SEC_ID" --limit 200 --order asc \
    --data-dir "$DATA" --env-files "$(env_files_for sub-c)"
  if [ "$CLI_RC" -ne 0 ]; then
    pass "10.3 无关账号 C 读不到 B 的私有帖（thread NOT_FOUND）"
  else
    fail "10.3 无关账号 C 读不到 B 的私有帖" "thread 可读"
  fi
  # Sanity: manager (global) can read it.
  cli_run read --as manager --thread "$SEC_ID" --limit 200 --order asc \
    --data-dir "$DATA" --env-files "$(env_files_for manager)"
  if [ "$CLI_RC" -eq 0 ] && json_has_sub "$CLI_OUT" "$BODY10S"; then
    pass "10.3a manager 能看到 B 的私有帖（前置条件）"
  else
    fail "10.3a manager 能看到 B 的私有帖（前置条件）"
  fi

  if drain_account sub-b; then
    pass "10.4 B 游标追平历史未读"
  else
    fail "10.4 B 游标追平历史未读" "drain 失败"
  fi

  start_waiter sub-b "$RUN_TMP/s10-b"
  sleep 0.6

  QUOTE_ID=""
  if cli_expect_ok "10.5 A 引用该帖发新帖" post "$BODY10Q" --quote "$SEC_ID" --as sub-a \
      --data-dir "$DATA" --env-files "$(env_files_for sub-a)"; then
    QUOTE_ID=$(json_post_id_from_result "$CLI_OUT")
  fi
  if [ -n "$QUOTE_ID" ]; then
    pass "10.5a 解析到引用帖 id ($QUOTE_ID)"
  else
    fail "10.5a 解析到引用帖 id"
  fi

  RC=0
  wait_bg "$WAITER_PID" "$WAIT_DELIVERY_SECS" || RC=$?
  check_eq "10.6 被引用会话参与者 B 的 wait 退出码" "$RC" "0"
  if [ -n "$QUOTE_ID" ] && jq -s -e --arg pid "$QUOTE_ID" \
      'any(.[]; .type == "post.created" and .actor == "sub-a" and .post_id == $pid)' \
      "$WAITER_OUT" >/dev/null 2>&1; then
    pass "10.7 B（非全局账号）收到引用帖 post.created（参与者已合并）"
  else
    fail "10.7 B（非全局账号）收到引用帖 post.created（参与者已合并）" "quote=[$QUOTE_ID]"
  fi
  # thread.invited must ship a thread.snapshot carrying the body.
  if json_has_sub "$WAITER_OUT" "$BODY10Q"; then
    pass "10.8 B 收到 thread.snapshot（含引用帖正文）"
  else
    fail "10.8 B 收到 thread.snapshot（含引用帖正文）"
  fi

  cli_run read --as sub-b --thread "$QUOTE_ID" --limit 200 --order asc \
    --data-dir "$DATA" --env-files "$(env_files_for sub-b)"
  if [ "$CLI_RC" -eq 0 ] && json_has_sub "$CLI_OUT" "$BODY10Q"; then
    pass "10.9 B 的 thread read 能看到引用帖"
  else
    fail "10.9 B 的 thread read 能看到引用帖" "exit=$CLI_RC"
  fi

  # Unrelated C: thread is NOT_FOUND; timeline/search summaries must not leak ids.
  cli_run read --as sub-c --thread "$QUOTE_ID" --limit 200 --order asc \
    --data-dir "$DATA" --env-files "$(env_files_for sub-c)"
  if [ "$CLI_RC" -ne 0 ]; then
    pass "10.10 无关账号 C 读不到引用帖（thread NOT_FOUND）"
  else
    fail "10.10 无关账号 C 读不到引用帖" "thread 可读"
  fi

  C_READ="$RUN_TMP/c10-read.json"
  C_SEARCH_Q="$RUN_TMP/c10-search-q.json"
  C_SEARCH_S="$RUN_TMP/c10-search-s.json"
  cli_run read --as sub-c --data-dir "$DATA" --env-files "$(env_files_for sub-c)" --limit 500
  cp "$CLI_OUT" "$C_READ" 2>/dev/null || : >"$C_READ"
  cli_run search "$BODY10Q" --as sub-c --data-dir "$DATA" \
    --env-files "$(env_files_for sub-c)" --limit 50
  cp "$CLI_OUT" "$C_SEARCH_Q" 2>/dev/null || : >"$C_SEARCH_Q"
  cli_run search "$BODY10S" --as sub-c --data-dir "$DATA" \
    --env-files "$(env_files_for sub-c)" --limit 50
  cp "$CLI_OUT" "$C_SEARCH_S" 2>/dev/null || : >"$C_SEARCH_S"

  if json_has_sub "$C_READ" "$QUOTE_ID" || json_has_sub "$C_READ" "$SEC_ID"; then
    fail "10.11 无关账号 C 的时间线不含引用帖/原帖 id" "read 命中"
  else
    pass "10.11 无关账号 C 的时间线不含引用帖/原帖 id"
  fi
  NQ=$(json_posts_length "$C_SEARCH_Q")
  NS=$(json_posts_length "$C_SEARCH_S")
  check_eq "10.12 C 搜索引用帖正文无结果" "$NQ" "0"
  check_eq "10.13 C 搜索原帖正文无结果" "$NS" "0"

  cli_run read --as manager --thread "$QUOTE_ID" --limit 200 --order asc \
    --data-dir "$DATA" --env-files "$(env_files_for manager)"
  if [ "$CLI_RC" -eq 0 ] && json_has_sub "$CLI_OUT" "$BODY10Q"; then
    pass "10.14 manager 全局能看到引用帖正文"
  else
    fail "10.14 manager 全局能看到引用帖正文"
  fi
}

s11_auth() {
  section S11 "认证模式：无 token 被拒、登录可用、改值瞬时失效"

  if cli_expect_ok "11.1 停止开放模式服务" serve --data-dir "$DATA" --stop \
      --env-files "$(serve_env_list)"; then
    SERVER_PID=""
  fi
  if ! wait_health_down "$URL" 80; then
    fail "11.1a 开放模式服务已停止" "healthz 仍为 200"
  fi
  sleep 0.4   # let the old process release serve.lock

  AUTH_ON=1
  AUTH_ENV_FILE="$RUN_TMP/auth.env"
  printf 'FDE2E_REPORT_AUTH=%s\n' "$AUTH_SECRET_1" >"$AUTH_ENV_FILE"
  chmod 600 "$AUTH_ENV_FILE"

  if start_serve_daemon "$(serve_env_list)"; then
    pass "11.2 认证模式 serve --daemon 启动"
  fi
  if wait_health "$URL" 150; then
    pass "11.3 认证模式 /healthz 返回 200"
  else
    fatal "认证模式服务未就绪" "healthz=$(http_code "$URL/healthz")"
  fi

  WRITE_PATH=""
  WRITE_PROBE_CODE=""
  for p in /api/post /api/posts /api/timeline/post /api/posts/create; do
    code=$(http_code "$URL$p" -X POST -H 'content-type: application/json' \
      --data '{"body":"e2e-auth-probe"}')
    case "$code" in
      404|405|000) ;;
      *) WRITE_PATH=$p; WRITE_PROBE_CODE=$code; break ;;
    esac
  done

  if [ -n "$WRITE_PATH" ]; then
    pass "11.4 定位写端点 $WRITE_PATH"
    case "$WRITE_PROBE_CODE" in
      401|403) pass "11.5 无 token 的写请求被拒（$WRITE_PROBE_CODE）" ;;
      *) fail "11.5 无 token 的写请求被拒" "status=$WRITE_PROBE_CODE（认证未生效或是错误端点）" ;;
    esac
  else
    fail "11.4 定位写端点" "候选 /api/post /api/posts /api/timeline/post 全部 404/405"
    skip "11.5-11.14 登录与改值"
    return 0
  fi

  LOGIN_BODY="$RUN_TMP/login.json"
  LOGIN_RESP=$(curl -sS -w '\n%{http_code}' --max-time 5 -X POST \
    -H 'content-type: application/json' \
    --data "{\"secret\":\"$AUTH_SECRET_1\"}" "$URL/api/auth/login" 2>/dev/null) \
    || LOGIN_RESP=$'\n000'
  LOGIN_CODE=${LOGIN_RESP##*$'\n'}
  LOGIN_JSON=${LOGIN_RESP%$'\n'*}
  printf '%s' "$LOGIN_JSON" >"$LOGIN_BODY"
  check_eq "11.6 正确密码登录 HTTP 200" "$LOGIN_CODE" "200"

  ACCESS_TOKEN=$(json_access_token "$LOGIN_BODY")
  check_ne "11.7 登录返回 access token" "$ACCESS_TOKEN" ""

  AUTHED_OK=0
  AUTHED_FIELD=""
  AUTHED_CODE=""
  if [ -n "$ACCESS_TOKEN" ]; then
    for fld in body text body_md; do
      payload=$(jq -cn --arg b "E2E-S11-ACCESS-$RUN_ID" --arg f "$fld" '{($f): $b}')
      code=$(http_code "$URL$WRITE_PATH" -X POST \
        -H 'content-type: application/json' \
        -H "Authorization: Bearer $ACCESS_TOKEN" --data "$payload")
      AUTHED_CODE=$code
      case "$code" in
        2[0-9][0-9]) AUTHED_OK=1; AUTHED_FIELD=$fld; break ;;
      esac
    done
  fi
  if [ "$AUTHED_OK" = "1" ]; then
    pass "11.8 登录后带 Bearer 的写请求成功（字段 $AUTHED_FIELD）"
  else
    fail "11.8 登录后带 Bearer 的写请求成功" "最后 status=$AUTHED_CODE"
  fi

  printf 'FDE2E_REPORT_AUTH=%s\n' "$AUTH_SECRET_2" >"$AUTH_ENV_FILE"
  sleep 1.3   # design §4: live-read, at most 1s cache

  if [ -n "$ACCESS_TOKEN" ] && [ -n "$AUTHED_FIELD" ]; then
    payload=$(jq -cn --arg b "E2E-S11-STALE-$RUN_ID" --arg f "$AUTHED_FIELD" '{($f): $b}')
    code=$(http_code "$URL$WRITE_PATH" -X POST \
      -H 'content-type: application/json' \
      -H "Authorization: Bearer $ACCESS_TOKEN" --data "$payload")
    case "$code" in
      401|403) pass "11.9 改 FDE2E_REPORT_AUTH 后旧 access token 立即失效（$code）" ;;
      *) fail "11.9 改 FDE2E_REPORT_AUTH 后旧 access token 立即失效" "status=$code" ;;
    esac
  else
    skip "11.9 改值后旧 access token 失效" "未取得可用 access token"
  fi

  OLD_LOGIN=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -X POST \
    -H 'content-type: application/json' \
    --data "{\"secret\":\"$AUTH_SECRET_1\"}" "$URL/api/auth/login" 2>/dev/null) || OLD_LOGIN="000"
  case "$OLD_LOGIN" in
    401|403) pass "11.10 旧密码登录被拒（$OLD_LOGIN）" ;;
    *) fail "11.10 旧密码登录被拒" "status=$OLD_LOGIN" ;;
  esac

  NEW_LOGIN=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -X POST \
    -H 'content-type: application/json' \
    --data "{\"secret\":\"$AUTH_SECRET_2\"}" "$URL/api/auth/login" 2>/dev/null) || NEW_LOGIN="000"
  check_eq "11.11 新密码登录 HTTP 200" "$NEW_LOGIN" "200"

  BODY11="E2E-S11-OWNER-TOKEN-$RUN_ID"
  if cli_expect_ok "11.12 改值后 account token 仍有效（CLI --as owner 发帖）" \
      post "$BODY11" --as owner --data-dir "$DATA" --env-files "$(env_files_for owner)"; then
    :
  fi

  cli_run auth status --data-dir "$DATA" --env-files "$(serve_env_list)"
  if [ "$CLI_RC" -ne 0 ]; then
    cli_run auth status --as manager --data-dir "$DATA" --env-files "$(env_files_for manager)"
  fi
  if [ "$CLI_RC" -eq 0 ]; then
    AUTH_STATUS_TEXT=$(sed -n '1,40p' "$CLI_OUT")
    if grep -Eiq 'access|访问' <<<"$AUTH_STATUS_TEXT"; then
      pass "11.13 auth status 显示 access token 语义"
    else
      fail "11.13 auth status 显示 access token 语义"
    fi
    if grep -Eiq 'account|账号' <<<"$AUTH_STATUS_TEXT"; then
      pass "11.14 auth status 显示 account token 语义"
    else
      fail "11.14 auth status 显示 account token 语义"
    fi
  else
    fail "11.13 auth status 可执行" "exit=$CLI_RC"
    skip "11.14 auth status 显示 account token 语义"
  fi
}

s12_export() {
  section S12 "SSG 导出：index.html 可通过 file:// 浏览"

  OUT="$RUN_TMP/export"
  cli_run export --data-dir "$DATA" --out "$OUT" --env-files "$(serve_env_list)"
  if [ "$CLI_RC" -ne 0 ]; then
    cli_run export --as manager --data-dir "$DATA" --out "$OUT" \
      --env-files "$(env_files_for manager)"
  fi
  if [ "$CLI_RC" -eq 0 ]; then
    pass "12.1 export 退出 0"
  else
    fail "12.1 export 退出 0" "exit=$CLI_RC stderr=$(first_line_of "$CLI_ERR")"
  fi

  check_file "12.2 index.html 存在" "$OUT/index.html"
  check_nonempty_file "12.3 index.html 非空" "$OUT/index.html"
  check_file "12.4 assets/app.js 存在" "$OUT/assets/app.js"
  check_file "12.5 assets/app.css 存在" "$OUT/assets/app.css"
  check_file "12.6 who.html 存在" "$OUT/who.html"
  check_file "12.7 search.html 存在" "$OUT/search.html"

  check_contains_file "12.8 数据内联为 <script type=\"application/json\">" \
    "$OUT/index.html" '<script type="application/json"'
  check_contains_file "12.9 经典脚本 assets/app.js 被引用" "$OUT/index.html" 'assets/app.js'

  THREAD_PAGE="$OUT/p/$ROOT9.html"
  THREAD_PAGE_OK=0
  if [ -z "$ROOT9" ]; then
    skip "12.10-12.11 线程页" "S9 未取得根帖 id"
  elif [ -f "$THREAD_PAGE" ]; then
    pass "12.10 线程页 p/<id>.html 存在"
    check_contains_file "12.11 线程页含根帖正文" "$THREAD_PAGE" "$BODY9R"
    THREAD_PAGE_OK=1
  elif [ -f "$OUT/p/$ROOT9/index.html" ]; then
    pass "12.10 线程页 p/<id>/index.html 存在"
    check_contains_file "12.11 线程页含根帖正文" "$OUT/p/$ROOT9/index.html" "$BODY9R"
    THREAD_PAGE="$OUT/p/$ROOT9/index.html"
    THREAD_PAGE_OK=1
  else
    fail "12.10 线程页 p/<id>.html 存在" "缺少 $THREAD_PAGE"
    skip "12.11 线程页含根帖正文"
  fi

  if [ -f "$OUT/index.html" ] && grep -Fq -- "$BODY8B" "$OUT/index.html"; then
    pass "12.12 时间线导出包含最新帖子正文"
  else
    fail "12.12 时间线导出包含最新帖子正文" "建议用较早的帖子核对分页"
  fi

  check_not_match_file "12.13 index.html 不使用 ES module" "$OUT/index.html" 'type="module"'
  check_not_match_file "12.14 index.html 不用 fetch/XHR 取数据" "$OUT/index.html" 'fetch[[:space:]]*\(|XMLHttpRequest'
  check_not_match_file "12.15 app.js 不用 fetch/XHR 取数据" "$OUT/assets/app.js" 'fetch[[:space:]]*\(|XMLHttpRequest'

  ASOF=0
  if [ -f "$OUT/index.html" ] && grep -Eiq 'as[-_ ]?of' "$OUT/index.html"; then ASOF=1; fi
  if [ "$ASOF" = "0" ] && [ "$THREAD_PAGE_OK" = "1" ] && grep -Eiq 'as[-_ ]?of' "$THREAD_PAGE"; then ASOF=1; fi
  if [ "$ASOF" = "1" ]; then
    pass "12.16 导出内嵌 as-of seq"
  else
    fail "12.16 导出内嵌 as-of seq"
  fi

  if [ -f "$OUT/index.html" ]; then
    if curl -sS --max-time 5 "file://$OUT/index.html" >"$RUN_TMP/file-index.html" 2>"$RUN_TMP/file-index.err"; then
      check_contains_file "12.17 file:// 可读取 index.html" "$RUN_TMP/file-index.html" '<html'
      check_contains_file "12.18 file:// 内容含时间线数据" "$RUN_TMP/file-index.html" "$BODY8B"
    else
      fail "12.17 file:// 可读取 index.html" "$(first_line_of "$RUN_TMP/file-index.err")"
      skip "12.18 file:// 内容含时间线数据"
    fi
  else
    skip "12.17-12.18 file:// 浏览"
  fi
}

# ===========================================================================
# Selftest: validates the harness itself without touching the implementation
# ===========================================================================

selftest_run() {
  CURRENT_SCENARIO="selftest"
  local f="$RUN_TMP/selftest.jsonl" d="$RUN_TMP/draft.json" t="$RUN_TMP/token.json"
  local p rc

  printf '%s\n' \
    '{"seq":1,"type":"post.created","payload":{"post":{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","body":"hello-alpha","parent_id":null,"root_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","self_thread_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","i":1,"n":2}}}' \
    '{"seq":2,"type":"post.created","payload":{"post":{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAW","body":"hello-beta","parent_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","root_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","self_thread_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","i":2,"n":2}}}' \
    >"$f"

  if json_has_sub "$f" "hello-beta"; then pass "json_has_sub 正例"; else fail "json_has_sub 正例"; fi
  if json_has_sub "$f" "nope"; then fail "json_has_sub 反例"; else pass "json_has_sub 反例"; fi
  check_eq "json_count_with_sub" "$(json_count_with_sub "$f" "hello-alpha")" "1"
  check_eq "json_line_count" "$(json_line_count "$f")" "2"
  if json_seq_ok "$f"; then pass "json_seq_ok 非降序"; else fail "json_seq_ok 非降序"; fi

  printf '%s\n' '{"seq":2}' '{"seq":1}' >"$RUN_TMP/badseq.jsonl"
  if json_seq_ok "$RUN_TMP/badseq.jsonl"; then fail "json_seq_ok 检出乱序"; else pass "json_seq_ok 检出乱序"; fi

  check_eq "json_post_id 按正文定位" "$(json_post_id "$f" "hello-alpha")" "01ARZ3NDEKTSV4RRFFQ69G5FAV"
  printf '%s' '{"ok":true,"batch_id":"01ARZ3NDEKTSV4RRFFQ69G5FZZ","posts":[{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","author":"sub-a"}]}' >"$RUN_TMP/result.json"
  check_eq "json_post_id_from_result 不吃 batch_id" \
    "$(json_post_id_from_result "$RUN_TMP/result.json")" "01ARZ3NDEKTSV4RRFFQ69G5FAV"
  printf '%s' '{"ok":true,"query":"x","posts":[]}' >"$RUN_TMP/empty-posts.json"
  check_eq "json_posts_length 空结果" "$(json_posts_length "$RUN_TMP/empty-posts.json")" "0"
  check_eq "json_first_ulid" "$(json_first_ulid "$f")" "01ARZ3NDEKTSV4RRFFQ69G5FAV"
  check_eq "json_post_fields parent" "$(json_post_fields "$f" "hello-beta" | cut -f2)" "01ARZ3NDEKTSV4RRFFQ69G5FAV"
  check_contains "json_in_pairs" "$(json_in_pairs "$f")" "2/2"

  printf '%s' '{"drafts":[{"id":"d1","author":"sub-a","count":2}]}' >"$d"
  if json_draft_present "$d"; then pass "json_draft_present 正例"; else fail "json_draft_present 正例"; fi
  printf '%s' '{"drafts":[]}' >"$RUN_TMP/nodraft.json"
  if json_draft_present "$RUN_TMP/nodraft.json"; then fail "json_draft_present 空列"; else pass "json_draft_present 空列"; fi
  check_eq "json_draft_id" "$(json_draft_id "$d" "sub-a")" "d1"

  printf '%s' '{"ok":true,"accessToken":"access-token-fixture"}' >"$t"
  check_eq "json_access_token" "$(json_access_token "$t")" "access-token-fixture"
  printf '%s' '{"data":{"token":"opaque-xyz"}}' >"$RUN_TMP/token2.json"
  check_eq "json_access_token 兜底字段" "$(json_access_token "$RUN_TMP/token2.json")" "opaque-xyz"

  printf '%s\n' 'FDE2E_REPORT_TOKEN=abc123' >"$RUN_TMP/token.env"
  check_eq "env_token TOKEN 键" "$(env_token "$RUN_TMP/token.env")" "abc123"

  chmod 600 "$RUN_TMP/token.env"
  check_mode "check_mode 600" "$RUN_TMP/token.env" "600"

  ( sleep 0.2 ) &
  p=$!
  if wait_bg "$p" 3; then pass "wait_bg 正常退出"; else fail "wait_bg 正常退出"; fi
  ( sleep 5 ) &
  p=$!
  rc=0
  wait_bg "$p" 1 || rc=$?
  check_eq "wait_bg 超时返回 124" "$rc" "124"

  if json_has_sub "$RUN_TMP/definitely-missing.json" "x"; then
    fail "缺失文件不误报"
  else
    pass "缺失文件不误报"
  fi
}

# ===========================================================================
# Main
# ===========================================================================

case "${1:-}" in
  --selftest)
    selftest_run
    if finish; then exit 0; else exit 1; fi
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  "")
    ;;
  *)
    usage
    exit 64
    ;;
esac

s0_preflight
s1_init
s2_serve
s3_accounts
s4_post_and_wakeup
s5_reply_delivery
s6_batch
s7_naked_eof
s8_no_dup_no_loss
s9_self_thread
s10_quote_visibility
s11_auth
s12_export

if finish; then
  exit 0
else
  exit 1
fi

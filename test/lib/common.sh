#!/usr/bin/env bash
# common.sh -- assertions, HTTP/process helpers for the report CLI black-box E2E.
# Sourced by test/e2e-cli.sh. Bash 3.2 compatible (macOS default /bin/bash).
#
# Contract references:
#   openspec/changes/report-v0/design.md §6 (batch), §7 (wait-notifications),
#   §15 (CLI surface), §19 (security)
#   specs/report-protocol/spec.md, specs/report-surface/spec.md

if [ -n "${_REPORT_E2E_COMMON_SOURCED:-}" ]; then
  return 0
fi
_REPORT_E2E_COMMON_SOURCED=1

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
FAILED_CHECKS=""
CURRENT_SCENARIO="preflight"

# ---------------------------------------------------------------------------
# Result reporting
# ---------------------------------------------------------------------------

section() {
  # section <id> <title>
  CURRENT_SCENARIO="$1"
  printf '\n=== %s  %s ===\n' "$1" "$2"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '[PASS] %s  %s\n' "$CURRENT_SCENARIO" "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_CHECKS="${FAILED_CHECKS}  - ${CURRENT_SCENARIO}  ${1}${2:+ -- $2}"$'\n'
  printf '[FAIL] %s  %s%s\n' "$CURRENT_SCENARIO" "$1" "${2:+ -- $2}"
}

skip() {
  SKIP_COUNT=$((SKIP_COUNT + 1))
  printf '[SKIP] %s  %s%s\n' "$CURRENT_SCENARIO" "$1" "${2:+ -- $2}"
}

note() {
  printf '[NOTE] %s  %s\n' "$CURRENT_SCENARIO" "$1"
}

first_line_of() {
  sed -n '1p' "$1" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Filesystem assertions (always return 0; failure is recorded, not fatal)
# ---------------------------------------------------------------------------

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null || printf '?'
}

abspath() {
  ( cd "$1" 2>/dev/null && pwd -P ) 2>/dev/null || true
}

check_file() {
  if [ -f "$2" ]; then pass "$1"; else fail "$1" "missing file: $2"; fi
}

check_dir() {
  if [ -d "$2" ]; then pass "$1"; else fail "$1" "missing dir: $2"; fi
}

check_nonempty_file() {
  if [ -s "$2" ]; then pass "$1"; else fail "$1" "empty/missing file: $2"; fi
}

check_mode() {
  # check_mode <label> <path> <expected-octal>
  local m
  m=$(file_mode "$2")
  if [ "$m" = "$3" ]; then
    pass "$1"
  else
    fail "$1" "mode=$m expected=$3 ($2)"
  fi
}

check_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "got=[$2] expected=[$3]"; fi
}

check_ne() {
  if [ "$2" != "$3" ]; then pass "$1"; else fail "$1" "both=[$2]"; fi
}

check_contains() {
  if [ -z "$3" ]; then
    fail "$1" "needle is empty"
    return 0
  fi
  # here-string (not a pipe): `grep -q` closing a pipeline early would trip
  # `set -o pipefail` via SIGPIPE and turn a match into a false negative.
  if grep -Fq -- "$3" <<<"$2"; then
    pass "$1"
  else
    fail "$1" "missing substring: $3"
  fi
}

check_not_contains() {
  if [ -z "$3" ]; then
    fail "$1" "needle is empty"
    return 0
  fi
  if grep -Fq -- "$3" <<<"$2"; then
    fail "$1" "unexpected substring: $3"
  else
    pass "$1"
  fi
}

check_contains_file() {
  if [ -f "$2" ] && grep -Fq -- "$3" "$2"; then
    pass "$1"
  else
    fail "$1" "file does not contain [$3]: $2"
  fi
}

check_not_contains_file() {
  if [ ! -f "$2" ]; then
    fail "$1" "missing file: $2"
    return 0
  fi
  if [ -z "$3" ]; then
    fail "$1" "needle is empty"
    return 0
  fi
  if grep -Fq -- "$3" "$2"; then
    fail "$1" "file unexpectedly contains [$3]: $2"
  else
    pass "$1"
  fi
}

check_not_match_file() {
  # check_not_match_file <label> <file> <ERE>
  if [ -f "$2" ] && grep -Eq -- "$3" "$2" 2>/dev/null; then
    fail "$1" "file matched /$3/: $2"
  else
    pass "$1"
  fi
}

check_jsonl() {
  # check_jsonl <label> <file>
  if [ ! -s "$2" ]; then
    fail "$1" "empty output: $2"
    return 0
  fi
  if jq -e . "$2" >/dev/null 2>&1; then
    pass "$1"
  else
    fail "$1" "not valid JSON/JSONL: $2"
  fi
}

check_json_file() {
  if [ -s "$2" ] && jq -e . "$2" >/dev/null 2>&1; then
    pass "$1"
  else
    fail "$1" "not valid JSON: $2"
  fi
}

# ---------------------------------------------------------------------------
# Process helpers
# ---------------------------------------------------------------------------

pid_alive() {
  kill -0 "$1" 2>/dev/null
}

# wait_bg <pid> <seconds>: waits for a child; returns its status, or 124 when
# the watch-dog had to kill it after <seconds>. Bash has no `wait -t`, so the
# watchdog records a flag file to distinguish "timed out" from "exited by signal".
wait_bg() {
  local pid=$1 secs=$2 flag="${RUN_TMP:-/tmp}/wait-$1.timeout" wd rc
  rm -f "$flag"
  (
    sleep "$secs"
    if kill -0 "$pid" 2>/dev/null; then
      : >"$flag"
      kill -9 "$pid" 2>/dev/null || true
    fi
  ) &
  wd=$!
  rc=0
  wait "$pid" 2>/dev/null || rc=$?
  kill "$wd" 2>/dev/null || true
  wait "$wd" 2>/dev/null || true
  if [ -f "$flag" ]; then
    return 124
  fi
  return "$rc"
}

http_code() {
  # http_code <url> [extra curl args...]
  local url=$1
  shift
  curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$@" "$url" 2>/dev/null || printf '000'
}

wait_health() {
  # wait_health <base-url> <deciseconds>
  local url=$1 limit=${2:-100} i=0
  while [ "$i" -lt "$limit" ]; do
    if [ "$(http_code "$url/healthz")" = "200" ]; then
      return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

wait_health_down() {
  local url=$1 limit=${2:-100} i=0
  while [ "$i" -lt "$limit" ]; do
    if [ "$(http_code "$url/healthz")" != "200" ]; then
      return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

wait_report_url_line() {
  # wait_report_url_line <file> <deciseconds>
  local f=$1 limit=${2:-100} i=0
  while [ "$i" -lt "$limit" ]; do
    if [ -f "$f" ] && grep -q '^REPORT_URL=' "$f" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

# ---------------------------------------------------------------------------
# CLI invocation capture (never aborts the script; inspect CLI_RC)
# ---------------------------------------------------------------------------

CLI_RC=0
CLI_OUT=""
CLI_ERR=""

cli_run() {
  CLI_OUT="${RUN_TMP:-/tmp}/cli.out"
  CLI_ERR="${RUN_TMP:-/tmp}/cli.err"
  set +e
  "${CLI[@]}" "$@" >"$CLI_OUT" 2>"$CLI_ERR"
  CLI_RC=$?
  set -e
  return 0
}

cli_run_stdin() {
  # cli_run_stdin <stdin-file> <args...>
  local input=$1
  shift
  CLI_OUT="${RUN_TMP:-/tmp}/cli.out"
  CLI_ERR="${RUN_TMP:-/tmp}/cli.err"
  set +e
  "${CLI[@]}" "$@" <"$input" >"$CLI_OUT" 2>"$CLI_ERR"
  CLI_RC=$?
  set -e
  return 0
}

cli_expect_ok() {
  # cli_expect_ok <label> <args...>
  local label=$1
  shift
  cli_run "$@"
  if [ "$CLI_RC" -eq 0 ]; then
    pass "$label"
    return 0
  fi
  fail "$label" "exit=$CLI_RC stderr=$(first_line_of "$CLI_ERR")"
  return 1
}

cli_expect_fail() {
  # cli_expect_fail <label> <args...>
  local label=$1
  shift
  cli_run "$@"
  if [ "$CLI_RC" -ne 0 ]; then
    pass "$label"
    return 0
  fi
  fail "$label" "expected non-zero exit, got 0"
  return 1
}

# ---------------------------------------------------------------------------
# Account env token reader (key name is not fixed by the spec; accept any
# *TOKEN* key, falling back to the first assignment)
# ---------------------------------------------------------------------------

env_token() {
  local f=$1 t=""
  t=$(awk -F= '
    /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=/ {
      k=$1; v=$0; sub(/^[^=]*=/, "", v); gsub(/^"|"$/, "", v);
      if (k ~ /TOKEN/ && v != "" && !found) { print v; found=1; exit }
      if (last == "") last=v
    }
    END { if (!found && last != "") print last }
  ' "$f" 2>/dev/null || true)
  printf '%s' "$t"
}

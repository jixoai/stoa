#!/usr/bin/env bash
# stoa-adapters P1-3 配置来源冒烟：`stoa mcp` 在同一隔离后端上按「四种配置来源 + 一轮
# flags>env 反证」各起 stdio 会话，每轮 tools/call board_status 必须 ok，并核对
# config.configPath / dataDir / account / baseUrl 确实来自该轮声明的来源：
#   Round A：STOA_* env
#   Round B：REPORT_CHANNEL_*/FDE2E_REPORT_*（旧 env，含旧 per-account token 键）
#   Round C：沙箱 HOME 下 ~/.config/stoa/report-channel.json（主路径）
#   Round D：沙箱 HOME 下仅有 ~/.config/fde2e/report-channel.json（旧配置回退）
#   Round E：CLI flags > 陈旧 env（反证第一层优先）
# 每轮都用 `env -i` 隔离环境，绝不读真实 ~/.config/{stoa,fde2e}；token 只从隔离实例读，
# 绝不打印；收尾回收全部进程（qa-serve wrapper + serve pid + 数据目录）。
set -u
set +H

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="${REPO}/src/cli/main.ts"
QA="${REPO}/scripts/qa/qa-serve.mjs"
BUN="$(command -v bun)"
PORT=13687
WORK_ROOT="/tmp/stoa-adapters-a"
DATA_DIR="${WORK_ROOT}/mcp-config-sources"
HOME_QA="${WORK_ROOT}/home-qa-serve"
FAIL=0
PASSED=0

ok()  { PASSED=$((PASSED+1)); echo "PASS ${1}"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL ${1} ${2:-}"; }

# ── 隔离后端 ─────────────────────────────────────────────────────────────────
rm -rf "${DATA_DIR}" "${HOME_QA}"
mkdir -p "${WORK_ROOT}" "${HOME_QA}"
QA_OUT="/tmp/stoa-adapters-a-config-serve.out"
: >"${QA_OUT}"
# env -i 白名单：后端（及其内部 init/serve 子进程）绝不继承调用者的 STOA_*/凭据。
env -i "PATH=${PATH}" "HOME=${HOME_QA}" "TMPDIR=${TMPDIR:-/tmp}" \
  "${BUN}" "${QA}" --data-dir "${DATA_DIR}" --no-seed --keep --port "${PORT}" >"${QA_OUT}" 2>&1 &
QA_WRAPPER_PID=$!
URL=""
i=0
while [ "${i}" -lt 100 ]; do
  URL="$(grep -o '"url":"[^"]*"' "${QA_OUT}" 2>/dev/null | head -1 | sed 's/"url":"//;s/"//')"
  [ -n "${URL}" ] && break
  kill -0 "${QA_WRAPPER_PID}" 2>/dev/null || break
  sleep 0.3
  i=$((i+1))
done
if [ -z "${URL}" ]; then
  bad "qa-serve 启动" "无 url；tail: $(tail -3 "${QA_OUT}" | tr '\n' ' ')"
  kill "${QA_WRAPPER_PID}" 2>/dev/null || true
  exit 1
fi
SERVE_PID="$(grep -o '"pid":[0-9]*' "${QA_OUT}" | head -1 | cut -d: -f2)"
echo "-- 隔离后端 url=${URL} serve_pid=${SERVE_PID:-?} dataDir=${DATA_DIR}"

# token 只读进变量，绝不 echo；旧/新键各取一份（isolated board 由本仓 init 生成，双键同值）。
TOKEN_NEW="$(sed -n 's/^STOA_TOKEN_MANAGER=//p' "${DATA_DIR}/accounts/manager.env" | head -1)"
TOKEN_LEGACY="$(sed -n 's/^FDE2E_REPORT_TOKEN_MANAGER=//p' "${DATA_DIR}/accounts/manager.env" | head -1)"
if [ -z "${TOKEN_NEW}" ] || [ -z "${TOKEN_LEGACY}" ]; then
  bad "读取隔离 token" "accounts/manager.env 缺少新/旧 token 键"
fi

SESSION_REQS=(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"board_status","arguments":{}}}'
)

# 起一轮 stdio 会话：$1=标签 $2=输出文件，其余＝完整命令（调用方用 env -i 拼好）。
run_session() {
  local label="$1" out="$2"
  shift 2
  printf '%s\n' "${SESSION_REQS[@]}" | "$@" >"${out}" 2>"${out}.err"
  local rc=$?
  if [ "${rc}" -ne 0 ]; then
    bad "${label} stdio 退出码" "rc=${rc} stderr=$(head -c 200 "${out}.err" 2>/dev/null)"
  fi
}

# 断言一轮的 board_status 载荷：$1=标签 $2=输出文件 $3=期望 account $4=期望 configPath
# $5=期望 dataDir（"-" = null，否则全等比较；都是期望 baseUrl=$URL）。
assert_status() {
  local label="$1" out="$2" want_account="$3" want_path="$4" want_data="$5"
  local report
  report="$(
    EXPECT_TOKEN="${TOKEN_NEW}" LABEL="${label}" OUT="${out}" \
    WANT_ACCOUNT="${want_account}" WANT_PATH="${want_path}" WANT_DATA="${want_data}" \
    WANT_URL="${URL}" python3 - <<'PY'
import json, os, sys

label = os.environ["LABEL"]
out = os.environ["OUT"]
want_account = os.environ["WANT_ACCOUNT"]
want_path = os.environ["WANT_PATH"]
want_data = os.environ["WANT_DATA"]
want_url = os.environ["WANT_URL"]
token = os.environ.get("EXPECT_TOKEN", "")

try:
    raw = open(out, encoding="utf-8").read()
except OSError as err:
    print(f"FAIL {label} 读取输出 — {err}")
    sys.exit(0)

responses = {}
for line in raw.splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        message = json.loads(line)
    except ValueError:
        continue
    if isinstance(message, dict) and message.get("id") is not None:
        responses[message["id"]] = message

def fail(detail):
    print(f"FAIL {label} board_status — {detail}")
    sys.exit(0)

init = responses.get(1)
if not init or init.get("error") or not init.get("result", {}).get("protocolVersion"):
    fail(f"initialize 应答异常: {str(init)[:160]}")

tools = responses.get(2, {}).get("result", {}).get("tools")
if not isinstance(tools, list) or len(tools) != 8:
    fail(f"tools/list 工具数 {len(tools) if isinstance(tools, list) else tools}")

call = responses.get(3)
if not call or call.get("error"):
    fail(f"tools/call 无应答: {str(call)[:160]}")
if call.get("result", {}).get("isError"):
    fail(f"isError=true: {str(call['result'].get('content'))[:200]}")
try:
    payload = json.loads(call["result"]["content"][0]["text"])
except Exception as err:  # noqa: BLE001 - 任何解析失败都算载荷不合法
    fail(f"载荷不是 JSON 文本: {err}")
if payload.get("ok") is not True or payload.get("status", {}).get("ok") is not True:
    fail(f"payload.ok/status.ok 未通过: {str(payload)[:200]}")

cfg = payload.get("config", {})
if cfg.get("account") != want_account:
    fail(f"account={cfg.get('account')}（期望 {want_account}）")
if cfg.get("token") != "present":
    fail(f"token={cfg.get('token')}（期望 present）")
if cfg.get("baseUrl") != want_url:
    fail(f"baseUrl={cfg.get('baseUrl')}（期望 {want_url}）")
if want_path != "-" and cfg.get("configPath") != want_path:
    fail(f"configPath={cfg.get('configPath')}（期望 {want_path}）")
if want_data == "-":
    if cfg.get("dataDir") is not None:
        fail(f"dataDir={cfg.get('dataDir')}（期望 null）")
elif cfg.get("dataDir") != want_data:
    fail(f"dataDir={cfg.get('dataDir')}（期望 {want_data}）")

if token and token in raw:
    fail("输出中出现 token（凭据回显）")

print(
    f"PASS {label} board_status ok"
    f"（account={cfg.get('account')} token={cfg.get('token')} configPath={cfg.get('configPath')} dataDir={cfg.get('dataDir')}）"
)
PY
  )"
  echo "${report}"
  case "${report}" in
    PASS*) PASSED=$((PASSED+1)) ;;
    *) FAIL=$((FAIL+1)) ;;
  esac
}

# ── Round A：STOA_* env ──────────────────────────────────────────────────────
HOME_A="${WORK_ROOT}/home-stoa-env"
rm -rf "${HOME_A}" && mkdir -p "${HOME_A}"
run_session "Round A" "${WORK_ROOT}/round-a.out" \
  env -i "PATH=${PATH}" "HOME=${HOME_A}" \
  "STOA_BASE_URL=${URL}" "STOA_ACCOUNT=manager" "STOA_TOKEN=${TOKEN_NEW}" \
  "${BUN}" "${CLI}" mcp
assert_status "Round A" "${WORK_ROOT}/round-a.out" "manager" "${HOME_A}/.config/stoa/report-channel.json" "-"

# ── Round B：REPORT_CHANNEL_*/FDE2E_REPORT_*（旧 env）────────────────────────
HOME_B="${WORK_ROOT}/home-legacy-env"
rm -rf "${HOME_B}" && mkdir -p "${HOME_B}"
run_session "Round B" "${WORK_ROOT}/round-b.out" \
  env -i "PATH=${PATH}" "HOME=${HOME_B}" \
  "REPORT_CHANNEL_BASE_URL=${URL}" "REPORT_CHANNEL_ACCOUNT=manager" \
  "FDE2E_REPORT_TOKEN_MANAGER=${TOKEN_LEGACY}" \
  "${BUN}" "${CLI}" mcp
assert_status "Round B" "${WORK_ROOT}/round-b.out" "manager" "${HOME_B}/.config/stoa/report-channel.json" "-"

# ── Round C：沙箱 HOME 的 ~/.config/stoa/report-channel.json（token 走 accounts env 文件）
HOME_C="${WORK_ROOT}/home-stoa-config"
rm -rf "${HOME_C}" && mkdir -p "${HOME_C}/.config/stoa"
printf '{\n  "baseUrl": "%s",\n  "account": "manager",\n  "dataDir": "%s"\n}\n' \
  "${URL}" "${DATA_DIR}" >"${HOME_C}/.config/stoa/report-channel.json"
run_session "Round C" "${WORK_ROOT}/round-c.out" \
  env -i "PATH=${PATH}" "HOME=${HOME_C}" \
  "${BUN}" "${CLI}" mcp
assert_status "Round C" "${WORK_ROOT}/round-c.out" "manager" "${HOME_C}/.config/stoa/report-channel.json" "${DATA_DIR}"

# ── Round D：沙箱 HOME 仅有 ~/.config/fde2e/report-channel.json（旧配置回退）──
HOME_D="${WORK_ROOT}/home-legacy-config"
rm -rf "${HOME_D}" && mkdir -p "${HOME_D}/.config/fde2e"
printf '{\n  "baseUrl": "%s",\n  "account": "manager",\n  "dataDir": "%s"\n}\n' \
  "${URL}" "${DATA_DIR}" >"${HOME_D}/.config/fde2e/report-channel.json"
run_session "Round D" "${WORK_ROOT}/round-d.out" \
  env -i "PATH=${PATH}" "HOME=${HOME_D}" \
  "${BUN}" "${CLI}" mcp
assert_status "Round D" "${WORK_ROOT}/round-d.out" "manager" "${HOME_D}/.config/fde2e/report-channel.json" "${DATA_DIR}"

# ── Round E（附加反证）：CLI flags > 陈旧 env ────────────────────────────────
HOME_E="${WORK_ROOT}/home-flags"
rm -rf "${HOME_E}" && mkdir -p "${HOME_E}"
run_session "Round E" "${WORK_ROOT}/round-e.out" \
  env -i "PATH=${PATH}" "HOME=${HOME_E}" \
  "STOA_BASE_URL=http://127.0.0.1:13679" "STOA_ACCOUNT=owner" "STOA_TOKEN=stale-not-a-real-token" \
  "${BUN}" "${CLI}" mcp --base-url "${URL}" --account manager --token "${TOKEN_NEW}" --data-dir "${DATA_DIR}"
assert_status "Round E" "${WORK_ROOT}/round-e.out" "manager" "${HOME_E}/.config/stoa/report-channel.json" "${DATA_DIR}"

# ── 回收 ─────────────────────────────────────────────────────────────────────
env -i "PATH=${PATH}" "HOME=${HOME_QA}" "TMPDIR=${TMPDIR:-/tmp}" \
  "${BUN}" "${QA}" --stop --data-dir "${DATA_DIR}" --keep >/dev/null 2>&1 || true
kill "${QA_WRAPPER_PID}" 2>/dev/null || true
wait "${QA_WRAPPER_PID}" 2>/dev/null || true
i=0
while [ "${i}" -lt 50 ] && [ -n "${SERVE_PID}" ] && kill -0 "${SERVE_PID}" 2>/dev/null; do
  sleep 0.1
  i=$((i+1))
done
if [ -n "${SERVE_PID}" ] && kill -0 "${SERVE_PID}" 2>/dev/null; then
  bad "后端回收" "serve pid ${SERVE_PID} 仍存活，SIGKILL"
  kill -9 "${SERVE_PID}" 2>/dev/null || true
else
  ok "进程回收（qa-serve wrapper ${QA_WRAPPER_PID}、serve ${SERVE_PID:-n/a} 均已退出）"
fi
LEFT="$(pgrep -f "qa-serve.mjs --data-dir ${DATA_DIR}" | tr '\n' ' ')"
[ -z "${LEFT// /}" ] && ok "无 qa-serve 残留" || bad "qa-serve 残留" "${LEFT}"
rm -rf "${DATA_DIR}" "${HOME_A}" "${HOME_B}" "${HOME_C}" "${HOME_D}" "${HOME_E}" "${HOME_QA}"
for out in round-a round-b round-c round-d round-e; do
  rm -f "${WORK_ROOT}/${out}.out" "${WORK_ROOT}/${out}.out.err"
done
rm -f "${QA_OUT}"

echo "== RESULT: PASS=${PASSED} FAIL=${FAIL} =="
[ "${FAIL}" -eq 0 ]

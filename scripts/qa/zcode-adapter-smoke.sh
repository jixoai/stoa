#!/usr/bin/env bash
# zcode-adapter-smoke — Stoa ZCode 适配器（adapters/zcode）沙箱冒烟（change stoa-adapters P1-4）。
#
# 场景（全部在沙箱内；绝不触碰真实 HOME、真实 ~/.config|~/.local 与生产板 13689）：
#   1. 隔离板：qa-serve 固定端口 13686（--data-dir /tmp/stoa-adapters-b/data --no-seed --keep）；
#   2. 新路径直跑：watch.mjs --state-file …（起停、退出码 0）+ state-path.mjs（新 state 目录）；
#   3. 旧配置零迁移：沙箱里只放旧形态 ~/.config/fde2e/report-channel.json → 新代码仍解析出
#      正确 baseUrl/account，且带 token 连上隔离板（watch 退出 0 = token 解析成功；凭据值不打印）；
#   4. 兼容断言（node 进程内比较、只输出 true/false）：旧配置文件路径回退、新配置优先、
#      STOA_* > REPORT_CHANNEL_*（空值＝未设）、STOA_TOKEN_<ACCT> > FDE2E_REPORT_TOKEN_<ACCT>
#      （env 与 accounts env 文件两种来源）、state 文件按存在性回退旧目录；
#   5. 薄桥冒烟：printf initialize+tools/list | bun <repo>/src/cli/main.ts mcp
#      （核心 `stoa mcp` 尚未落地时记 SKIP，标注「待核心落地后复跑」）。
#
# 纪律：每个子进程都用 `env -i` 白名单 + HOME 指向 /tmp 沙箱；不打印任何 token；
# 结束回收 qa-serve 与 serve 子进程（--stop），并断言 pid 已死。
set -u
set +H

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ADAPTER="${REPO}/adapters/zcode"
WATCH="${ADAPTER}/scripts/watch.mjs"
STATE_PATH="${ADAPTER}/scripts/state-path.mjs"
QA="${REPO}/scripts/qa/qa-serve.mjs"
CLI="${REPO}/src/cli/main.ts"
BUN="$(command -v bun || true)"
NODE="$(command -v node || true)"
SB="/tmp/stoa-adapters-b"
DATA="${SB}/data"
PORT=13686
URL="http://127.0.0.1:${PORT}"

FAIL=0
PASSED=0
SKIPPED=0
QA_PID=""

ok()   { PASSED=$((PASSED + 1)); echo "PASS $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "FAIL $1 ${2:-}"; }
skip() { SKIPPED=$((SKIPPED + 1)); echo "SKIP $1 ${2:-}"; }

[ -n "${BUN}" ]  || { echo "FAIL bun not found on PATH"; exit 1; }
[ -n "${NODE}" ] || { echo "FAIL node not found on PATH"; exit 1; }

BASE_PATH="$(dirname "${NODE}"):$(dirname "${BUN}"):/usr/bin:/bin:/usr/sbin:/sbin"
# 沙箱执行器：环境白名单（无 STOA_*/REPORT_CHANNEL_*/ZCODE_* 泄漏）、HOME 指向沙箱。
sandbox() {
  local home="$1"
  shift
  env -i PATH="${BASE_PATH}" HOME="${home}" TMPDIR="${TMPDIR:-/tmp}" "$@"
}

cleanup() {
  if [ -n "${QA_PID}" ] && kill -0 "${QA_PID}" 2>/dev/null; then
    kill "${QA_PID}" 2>/dev/null || true
    wait "${QA_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "== 环境 =="
echo "REPO=${REPO}"
echo "SANDBOX=${SB} (HOME 全部指向其下；隔离板 ${URL}；数据目录 ${DATA})"

# ── Round 0：隔离板（先回收上一次残留，再全新起一块） ─────────────────────────
sandbox /tmp "${BUN}" "${QA}" --stop --data-dir "${DATA}" --keep >/dev/null 2>&1 || true
rm -rf "${SB}"
mkdir -p "${SB}"

QA_OUT="${SB}/qa-serve.out"
"${BUN}" "${QA}" --data-dir "${DATA}" --no-seed --keep --port "${PORT}" >"${QA_OUT}" 2>&1 &
QA_PID=$!
i=0
while [ "${i}" -lt 100 ]; do
  if grep -q '"url":"' "${QA_OUT}" 2>/dev/null; then break; fi
  kill -0 "${QA_PID}" 2>/dev/null || break
  sleep 0.3
  i=$((i + 1))
done
SERVE_PID="$(grep -o '"pid":[0-9]*' "${QA_OUT}" 2>/dev/null | head -1 | cut -d: -f2)"
if ! grep -q '"url":"' "${QA_OUT}" 2>/dev/null; then
  bad "isolated board on ${URL}" "qa-serve start failed; tail: $(tail -2 "${QA_OUT}" | tr '\n' ' ')"
else
  ok "isolated board up on ${URL} (serve pid ${SERVE_PID})"
fi

# ── Round 1：新路径直跑（新 config + state-path + watch --state-file） ─────────
HOME1="${SB}/home-new"
mkdir -p "${HOME1}/.config/stoa"
printf '{"baseUrl":"%s","dataDir":"%s","account":"manager","publicUrl":"https://example.test"}\n' \
  "${URL}" "${DATA}" >"${HOME1}/.config/stoa/report-channel.json"

SP_JSON="$(sandbox "${HOME1}" "${NODE}" "${STATE_PATH}" --json 2>&1 || true)"
case "${SP_JSON}" in
  *"\"baseUrl\":\"${URL}\""*"\"account\":\"manager\""*)
    ok "state-path --json（baseUrl/account 正确）" ;;
  *) bad "state-path --json" "${SP_JSON}" ;;
esac
case "${SP_JSON}" in
  *"${HOME1}/.local/state/stoa/report-channel/"*) ok "state-path 落在新 state 目录" ;;
  *) bad "state-path 新目录" "${SP_JSON}" ;;
esac
SP_PLAIN="$(sandbox "${HOME1}" "${NODE}" "${STATE_PATH}" 2>&1 || true)"
case "${SP_PLAIN}" in
  *.json) ok "state-path 默认输出为路径（$(basename "${SP_PLAIN}")）" ;;
  *) bad "state-path 输出" "${SP_PLAIN}" ;;
esac

W1="${SB}/w1.json"
W1_OUT="$(sandbox "${HOME1}" "${NODE}" "${WATCH}" --state-file "${W1}" --max-seconds 8 --poll-seconds 2 2>"${SB}/w1.err")"
W1_RC=$?
if [ "${W1_RC}" -eq 0 ]; then ok "watch.mjs --state-file（新路径）退出码 0"; else
  bad "watch.mjs（新路径）退出码" "${W1_RC}; stderr: $(head -2 "${SB}/w1.err" | tr '\n' ' ')"
fi
case "${W1_OUT}" in
  *"\"mode\":\"local-cursor\""*) ok "watch 本地游标模式 stdout 正常" ;;
  *) bad "watch stdout" "${W1_OUT:0:200}" ;;
esac
case "${W1_OUT}" in
  *"\"state_file\":\"${W1}\""*) ok "watch 使用 --state-file 指定路径" ;;
  *) bad "watch state_file" "${W1_OUT:0:200}" ;;
esac
[ -f "${W1}" ] && ok "state 文件已落盘（$(stat -f '%Sp' "${W1}" 2>/dev/null || echo '?')）" \
  || bad "state 文件落盘" "${W1} missing"

# ── Round 2：旧配置零迁移（沙箱里只放旧形态 ~/.config/fde2e/report-channel.json） ──
HOME2="${SB}/home-legacy"
mkdir -p "${HOME2}/.config/fde2e"
printf '{"baseUrl":"%s","dataDir":"%s","account":"manager","publicUrl":"https://example.test"}\n' \
  "${URL}" "${DATA}" >"${HOME2}/.config/fde2e/report-channel.json"

SP2_JSON="$(sandbox "${HOME2}" "${NODE}" "${STATE_PATH}" --json 2>&1 || true)"
case "${SP2_JSON}" in
  *"\"baseUrl\":\"${URL}\""*"\"account\":\"manager\""*) ok "旧配置：baseUrl/account 解析正确（新代码读旧路径）" ;;
  *) bad "旧配置解析" "${SP2_JSON}" ;;
esac

W2="${SB}/w2.json"
W2_OUT="$(sandbox "${HOME2}" "${NODE}" "${WATCH}" --state-file "${W2}" --max-seconds 6 --poll-seconds 2 2>"${SB}/w2.err")"
W2_RC=$?
if [ "${W2_RC}" -eq 0 ]; then
  ok "旧配置：watch 退出 0（token 经 dataDir/accounts/manager.env 解析成功）"
else
  bad "旧配置 watch（token 丢失时会 401→退出 2）" "${W2_RC}; stderr: $(head -2 "${SB}/w2.err" | tr '\n' ' ')"
fi

# ── Round 3：兼容断言（node 进程内比较，只输出 true/false；含 legacy token 键） ──
HOME3="${SB}/home-both"
mkdir -p "${HOME3}/.config/stoa" "${HOME3}/.config/fde2e"
printf '{"baseUrl":"http://127.0.0.1:1","account":"owner"}\n' >"${HOME3}/.config/stoa/report-channel.json"
printf '{"baseUrl":"http://127.0.0.1:2","account":"manager"}\n' >"${HOME3}/.config/fde2e/report-channel.json"

cat >"${SB}/check-config-compat.mjs" <<'EOF'
// 适配器配置兼容断言：只输出 true/false，不回显任何凭据值。
import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const [adapter, dataDir] = process.argv.slice(2);
const { loadConfig, loadToken, accountTokenEnvKey, tokenEnvKey, resolveStatePath } = await import(
  `${adapter}/scripts/lib/config.mjs`
);

// 生成态 token（stoa init 写出的 accounts/manager.env 里的旧键值；仅进程内使用）
const accountEnv = readFileSync(join(dataDir, "accounts", "manager.env"), "utf8");
const expected = new RegExp(`^${tokenEnvKey("manager")}=(.+)$`, "m").exec(accountEnv)?.[1]?.trim();
const home = process.env.HOME;
const results = [];
const check = (name, pass) => results.push([name, pass === true]);
check("generated-account-env-has-legacy-key", typeof expected === "string" && expected.length > 0);

// 1) 同账号双配置都在：新路径优先
const cfgBoth = loadConfig();
check("both-configs-prefer-stoa-path", cfgBoth.path.endsWith("/.config/stoa/report-channel.json"));
check("both-configs-baseUrl-new", cfgBoth.baseUrl === "http://127.0.0.1:1");

// 2) env 双读：STOA_* 优先；空值＝未设则回退 REPORT_CHANNEL_*
process.env.STOA_BASE_URL = "http://127.0.0.1:3";
process.env.REPORT_CHANNEL_BASE_URL = "http://127.0.0.1:4";
check("env-stoa-wins", loadConfig().baseUrl === "http://127.0.0.1:3");
process.env.STOA_BASE_URL = "";
check("env-empty-stoa-falls-back", loadConfig().baseUrl === "http://127.0.0.1:4");
delete process.env.STOA_BASE_URL;
delete process.env.REPORT_CHANNEL_BASE_URL;

// 3) token：accounts env 文件里只有旧键时仍能读出（legacy key 兼容）
const legacyOnly = join(home, "legacy-only.env");
mkdirSync(home, { recursive: true });
writeFileSync(legacyOnly, `${tokenEnvKey("manager")}=${expected}\n`, { mode: 0o600 });
const cfgFile = { account: "manager", dataDir: "", tokenFile: legacyOnly };
check("legacy-token-from-env-file", loadToken(cfgFile) === expected);
unlinkSync(legacyOnly);

// 4) token：旧键环境变量仍能读出
process.env[tokenEnvKey("manager")] = expected;
check("legacy-token-from-process-env", loadToken({ account: "manager", dataDir: "", tokenFile: "" }) === expected);

// 5) token：STOA_TOKEN_<ACCT> 优先于旧键（哨兵值比较，不涉凭据）
process.env[accountTokenEnvKey("manager")] = "sentinel-stoa-token";
check("stoa-token-key-wins", loadToken({ account: "manager", dataDir: "", tokenFile: "" }) === "sentinel-stoa-token");
delete process.env[accountTokenEnvKey("manager")];
delete process.env[tokenEnvKey("manager")];

// 6) state：旧目录同名文件存在 → 回退旧路径；新目录也有 → 新目录优先
const legacyState = join(home, ".local/state/fde2e/report-channel", "probe.json");
mkdirSync(join(home, ".local/state/fde2e/report-channel"), { recursive: true });
writeFileSync(legacyState, "{}\n");
check("state-file-falls-back-legacy-dir", resolveStatePath("probe.json") === legacyState);
const newState = join(home, ".local/state/stoa/report-channel", "probe.json");
mkdirSync(join(home, ".local/state/stoa/report-channel"), { recursive: true });
writeFileSync(newState, "{}\n");
check("state-file-prefers-new-dir", resolveStatePath("probe.json") === newState);

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "true" : "false"} ${name}`);
  if (!pass) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
EOF

COMPAT_OUT="$(sandbox "${HOME3}" "${NODE}" "${SB}/check-config-compat.mjs" "${ADAPTER}" "${DATA}" 2>&1)"
while IFS= read -r line; do
  case "${line}" in
    true\ *) ok "compat $(echo "${line}" | cut -d' ' -f2-)" ;;
    false\ *) bad "compat $(echo "${line}" | cut -d' ' -f2-)" ;;
    "") ;;
    *) bad "compat runner" "${line}" ;;
  esac
done <<<"${COMPAT_OUT}"

# ── Round 4：薄桥（核心直跑 + 插件内启动器） ──────────────────────────────────
HOME4="${SB}/home-bridge"
mkdir -p "${HOME4}"
BRIDGE_IN='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
ALL_TOOLS="board_post board_reply board_read board_inbox board_peek board_status board_bookmark board_bookmarks"

count_tools() {
  local out="$1" n=0
  for tool in ${ALL_TOOLS}; do
    printf '%s' "${out}" | grep -q "\"${tool}\"" && n=$((n + 1))
  done
  echo "${n}"
}

BRIDGE_OUT="$(printf '%s\n' "${BRIDGE_IN}" | sandbox "${HOME4}" "${BUN}" "${CLI}" mcp 2>&1)"
BRIDGE_RC=$?
BRIDGE_TOOLS="$(count_tools "${BRIDGE_OUT}")"
if [ "${BRIDGE_TOOLS}" -eq 8 ]; then
  ok "核心直跑 bun src/cli/main.ts mcp：8/8 工具（rc ${BRIDGE_RC}）"
else
  bad "核心直跑 stoa mcp" "工具 ${BRIDGE_TOOLS}/8（rc ${BRIDGE_RC}）：$(printf '%s' "${BRIDGE_OUT}" | head -c 160 | tr '\n' ' ')"
fi

# 经 .mcp.json 解析出真实启动命令（替换 ${CLAUDE_PLUGIN_ROOT} 为插件目录），测试启动器：
cat >"${SB}/parse-bridge.mjs" <<'EOF'
import { readFileSync } from "node:fs";
import { join } from "node:path";
const adapter = process.argv[2];
const server = JSON.parse(readFileSync(join(adapter, ".mcp.json"), "utf8")).mcpServers.stoa;
const args = server.args.map((a) => a.split("${CLAUDE_PLUGIN_ROOT}").join(adapter));
console.log([server.command, ...args].join("\t"));
EOF
BRIDGE_LINE="$(sandbox "${HOME4}" "${NODE}" "${SB}/parse-bridge.mjs" "${ADAPTER}")"
IFS=$'\t' read -r BRIDGE_CMD BRIDGE_ARG <<<"${BRIDGE_LINE}"
if [ -n "${BRIDGE_CMD}" ] && [ -f "${BRIDGE_ARG}" ]; then
  ok "启动器经 .mcp.json 解析（${BRIDGE_CMD} $(basename "${BRIDGE_ARG}")）"
  LAUNCH_OUT="$(printf '%s\n' "${BRIDGE_IN}" | sandbox "${HOME4}" "${BRIDGE_CMD}" "${BRIDGE_ARG}" 2>&1)"
  LAUNCH_RC=$?
  LAUNCH_TOOLS="$(count_tools "${LAUNCH_OUT}")"
  if [ "${LAUNCH_TOOLS}" -eq 8 ]; then
    ok "启动器（相对解析，无 STOA_REPO）：8/8 工具（rc ${LAUNCH_RC}）"
  else
    bad "启动器相对解析" "工具 ${LAUNCH_TOOLS}/8（rc ${LAUNCH_RC}）：$(printf '%s' "${LAUNCH_OUT}" | head -c 160 | tr '\n' ' ')"
  fi
  REPO_OUT="$(printf '%s\n' "${BRIDGE_IN}" | env -i PATH="${BASE_PATH}" HOME="${HOME4}" STOA_REPO="${REPO}" "${BRIDGE_CMD}" "${BRIDGE_ARG}" 2>&1)"
  REPO_TOOLS="$(count_tools "${REPO_OUT}")"
  if [ "${REPO_TOOLS}" -eq 8 ]; then
    ok "启动器（STOA_REPO 显式指向仓根）：8/8 工具"
  else
    bad "启动器 STOA_REPO" "工具 ${REPO_TOOLS}/8"
  fi
  RES_IN='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"ui://stoa/board.html"}}'
  RES_OUT="$(printf '%s\n' "${RES_IN}" | sandbox "${HOME4}" "${BRIDGE_CMD}" "${BRIDGE_ARG}" 2>&1)"
  case "${RES_OUT}" in
    *'"uri":"ui://stoa/board.html"'*'text/html'*)
      ok "启动器：resources/read 返回 ui://stoa/board.html（text/html，面板由核心提供）" ;;
    *) bad "启动器 resources/read" "$(printf '%s' "${RES_OUT}" | head -c 160 | tr '\n' ' ')" ;;
  esac
else
  bad "启动器经 .mcp.json 解析" "${BRIDGE_LINE}"
fi

# 错误路径：把启动器复制到没有 Stoa 仓的目录、且不设 STOA_REPO → stderr 明确错误 + 非 0。
ISOLATED="${SB}/bridge-isolated/deep"
mkdir -p "${ISOLATED}"
cp "${ADAPTER}/scripts/mcp-bridge.mjs" "${ISOLATED}/mcp-bridge.mjs"
ERR_OUT="$(env -i PATH="${BASE_PATH}" HOME="${HOME4}" "${NODE}" "${ISOLATED}/mcp-bridge.mjs" </dev/null 2>&1)"
ERR_RC=$?
case "${ERR_OUT}" in
  *"core CLI not found"*"STOA_REPO"*)
    if [ "${ERR_RC}" -ne 0 ]; then ok "启动器错误路径：stderr 明确提示 + rc ${ERR_RC}"
    else bad "启动器错误路径" "rc 应为非 0（得到 ${ERR_RC}）"; fi ;;
  *) bad "启动器错误路径" "rc ${ERR_RC}：$(printf '%s' "${ERR_OUT}" | head -c 160 | tr '\n' ' ')" ;;
esac

# ── Round 5：Stop 钩子（stop-wait.mjs）两态＋防重复＋防循环＋开关 ──────────────
STOP_STATE="${SB}/stop-state.json"
STOP_WAIT="${ADAPTER}/scripts/stop-wait.mjs"

# 5a. 无消息 → 空输出、退出 0（放行）
STOP_A="$(env -i PATH="${BASE_PATH}" HOME="${HOME1}" STOA_STOP_WAIT_SECONDS=4 "${NODE}" "${STOP_WAIT}" \
  --state-file "${STOP_STATE}" </dev/null 2>/dev/null)"
STOP_A_RC=$?
if [ -z "${STOP_A}" ]; then ok "Stop 钩子：无消息空输出放行（rc ${STOP_A_RC}）"
else bad "Stop 钩子无消息态" "stdout_len=${#STOP_A}"; fi

# 5b. 有消息 → 单行 JSON decision=block + reason（含正文与指令）；无凭据泄漏
sandbox "${HOME1}" "${BUN}" "${CLI}" post "@manager 沙箱 Stop 冒烟：请在板上回我" \
  --data-dir "${DATA}" --env-files "${DATA}/.env,${DATA}/accounts/owner.env" --as owner >/dev/null 2>&1
env -i PATH="${BASE_PATH}" HOME="${HOME1}" STOA_STOP_WAIT_SECONDS=8 "${NODE}" "${STOP_WAIT}" \
  --state-file "${STOP_STATE}" </dev/null >"${SB}/stop-block.out" 2>"${SB}/stop-block.err"
STOP_B_RC=$?
if [ "${STOP_B_RC}" -eq 0 ] && [ "$(wc -l <"${SB}/stop-block.out" | tr -d ' ')" = "1" ]; then
  ok "Stop 钩子：有消息单行输出（rc 0）"
else
  bad "Stop 钩子有消息态" "rc=${STOP_B_RC} lines=$(wc -l <"${SB}/stop-block.out" | tr -d ' ')"
fi
STOP_JSON_OK="$(sandbox "${HOME1}" "${NODE}" -e '
const fs = require("fs");
const text = fs.readFileSync(process.argv[1], "utf8").trim();
const obj = JSON.parse(text);
const keys = Object.keys(obj).sort().join(",");
const reason = typeof obj.reason === "string" ? obj.reason : "";
console.log(
  [
    `decision=${obj.decision}`,
    `keys=${keys}`,
    `reason_has_body=${reason.includes("沙箱 Stop 冒烟")}`,
    `reason_has_instruction=${reason.includes("board_reply")}`,
  ].join(" "),
);' "${SB}/stop-block.out" 2>&1)"
case "${STOP_JSON_OK}" in
  "decision=block keys=decision,reason reason_has_body=true reason_has_instruction=true")
    ok "Stop 钩子：契约 JSON 严格（decision=block / 仅两键 / 正文＋回板指令）" ;;
  *) bad "Stop 钩子契约定制" "${STOP_JSON_OK}" ;;
esac
TOK="$(sed -n 's/^STOA_TOKEN_MANAGER=//p' "${DATA}/accounts/manager.env" | head -1)"
if [ -n "${TOK}" ] && grep -qF -- "${TOK}" "${SB}/stop-block.out" 2>/dev/null; then
  bad "Stop 钩子凭据不回显" "stdout 含 token 值"
else
  ok "Stop 钩子：stdout 不含凭据值"
fi
STATE_LAST="$(sed -n 's/.*"last": *\([0-9]*\).*/\1/p' "${STOP_STATE}" | head -1)"
if [ -n "${STATE_LAST}" ] && [ "${STATE_LAST}" -gt 0 ]; then
  ok "Stop 钩子：游标已推进（state last=${STATE_LAST}）"
else
  bad "Stop 钩子游标推进" "last=${STATE_LAST:-?}"
fi

# 5c. 防重复注入：同一状态再跑 → 空输出
STOP_C="$(env -i PATH="${BASE_PATH}" HOME="${HOME1}" STOA_STOP_WAIT_SECONDS=3 "${NODE}" "${STOP_WAIT}" \
  --state-file "${STOP_STATE}" </dev/null 2>/dev/null)"
if [ -z "${STOP_C}" ]; then ok "Stop 钩子：已注入的消息不再重复（游标推进生效）"
else bad "Stop 钩子防重复" "stdout_len=${#STOP_C}"; fi

# 5d. stop_hook_active=true（续跑轮）→ 直接放行（即便有未读也不注入）
sandbox "${HOME1}" "${BUN}" "${CLI}" post "@manager stop_hook_active 冒烟" \
  --data-dir "${DATA}" --env-files "${DATA}/.env,${DATA}/accounts/owner.env" --as owner >/dev/null 2>&1
STOP_D="$(printf '{"hook_event_name":"Stop","stop_hook_active":true}' | env -i PATH="${BASE_PATH}" HOME="${HOME1}" \
  STOA_STOP_WAIT_SECONDS=8 "${NODE}" "${STOP_WAIT}" --state-file "${STOP_STATE}" 2>/dev/null || true)"
if [ -z "${STOP_D}" ]; then ok "Stop 钩子：stop_hook_active=true 放行（防续跑循环）"
else bad "Stop 钩子防循环" "stdout_len=${#STOP_D}"; fi

# 5e. 开关：STOA_STOP_WAIT_SECONDS=0 → 关闭（即便有未读也不等待、不注入）
STOP_E="$(env -i PATH="${BASE_PATH}" HOME="${HOME1}" STOA_STOP_WAIT_SECONDS=0 "${NODE}" "${STOP_WAIT}" \
  --state-file "${STOP_STATE}" </dev/null 2>/dev/null || true)"
if [ -z "${STOP_E}" ]; then ok "Stop 钩子：STOA_STOP_WAIT_SECONDS=0 关闭开关生效"
else bad "Stop 钩子开关" "stdout_len=${#STOP_E}"; fi

# ── 收尾：回收隔离板并断言 ────────────────────────────────────────────────────
STOP_OUT="$("${BUN}" "${QA}" --stop --data-dir "${DATA}" --keep 2>/dev/null || true)"
echo "stop: ${STOP_OUT}"
if [ -n "${SERVE_PID}" ] && kill -0 "${SERVE_PID}" 2>/dev/null; then
  bad "serve reap" "pid ${SERVE_PID} still alive after --stop"
  kill -9 "${SERVE_PID}" 2>/dev/null || true
else
  ok "serve reaped (pid ${SERVE_PID:-n/a})"
fi
LEFTOVER="$(pgrep -fl "stoa-adapters-b" 2>/dev/null | awk -v self=$$ '$1 != self' || true)"
if [ -n "${LEFTOVER}" ]; then
  bad "no leftover sandbox processes" "${LEFTOVER}"
else
  ok "no leftover sandbox processes"
fi

echo
echo "== 结果：PASS ${PASSED} / FAIL ${FAIL} / SKIP ${SKIPPED}（沙箱保留在 ${SB}，数据目录 ${DATA}）=="
exit $((FAIL > 0 ? 1 : 0))

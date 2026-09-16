#!/usr/bin/env bash
# ============================================================================
# run_patcher.sh NNN [runId] — 只跑 SciPatcher（三候选 patch + verify）
#
# 用法:
 #   ./run_patcher.sh NNN            后台启动，复用 .codex-sci-debug/runs 下最新的 run 目录
 #   ./run_patcher.sh NNN <runId>    后台启动，复用指定 run 目录（prober 产出的那个）
 #   ./run_patcher.sh NNN --fg       前台运行
 #
# 它会做什么:
 #   1. preflight: claude CLI 在 PATH（全角色统一 Claude Code harness + deepseek-v4-pro + thinking max）
 #                + domain-invariant/repair/ds key 可解析
 #                （DEEPSEEK_API_KEY 优先，其次 roles.<role>.key；LOCAL_API_KEY / :8040 / :8050 已弃用）
 #   2. 定位 run 目录: 缺省取 workspaces/task-NNN/.codex-sci-debug/runs 下 mtime 最新，
 #      或显式传入 runId；必须包含 prober 产物（probes/manifest.json 或 probe-report-tester.json）
 #   3. 三 patcher 并行出候选（domain-invariant=sci + repair=general + ds=deepseek），
 #      各自强制交卷 + 本地 verify（probes + public reproduce.py），先写自名声明
 #      patcher/<qwen|glm|ds>/<qwen|glm|ds>.md
 #   4. 停在 stage=patcher-done，产物:
 #        patch-r1-sci.diff / patch-r1-general.diff / patch-r1-ds.diff
 #        verify-result-r1-sci.json / verify-result-r1-general.json / verify-result-r1-ds.json
 #        patcher/<qwen|glm|ds>/ 子目录镜像 + comparison-r1.json
 #      不触发 mentor，不往主工作区打 patch
#
# 下一步: ./run_mentor.sh NNN
# ============================================================================
set -euo pipefail
NNN="${1:?用法: ./run_patcher.sh <NNN> [runId] [--fg] [透传标志...]（例: 001 2026-09-14T00-00-00-000Z --only-roles ds --repair-timeout-min 60）}"
shift
# 其余参数解析：--fg 任意位置；第一个裸词 = runId；--xxx 及其值一律透传给 runner
FG=""
RUNID=""
PASS=()
for a in "$@"; do
  case "$a" in
    --fg) FG=1 ;;
    --*) PASS+=("$a") ;;
    *) if [ -z "$RUNID" ]; then RUNID="$a"; else PASS+=("$a"); fi ;;
  esac
done
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
WS="$HERE/workspaces/task-${NNN}"
CONFIG="$HERE/${NNN}.json"
RUNS="$WS/.codex-sci-debug/runs"
PIDF="$HERE/logs/run-${NNN}-patcher.pid"
RUN=""

preflight() {
  local fails=()
  [ -d "$WS" ] || fails+=("工作区缺失: $WS（请先物化）")
  [ -f "$CONFIG" ] || fails+=("缺少角色配置: $CONFIG")
  command -v claude >/dev/null 2>&1 \
    || fails+=("claude CLI 不可用（Claude Code 未安装或不在 PATH；安装: npm i -g @anthropic-ai/claude-code）")
  # 校验 patcher 实际调用的三个角色: domain-invariant (sci) + repair (general) + ds
  node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const role of ["domain-invariant", "repair", "ds"]) {
      const r = (cfg.roles || {})[role];
      if (!r || !r.model || !r.provider) { console.error("NNN.json 缺少角色 " + role); process.exit(1); }
      const p = (cfg.providers || {})[r.provider] || {};
      const env = p.envKey || r.keyEnv;
      // key 解析顺序与 run-dual-075.js keyFor 一致: env 优先，其次 json
      if (!(env && process.env[env]) && !r.key) {
        console.error("角色 " + role + " key 不可解析（env " + (env || "(无映射)") + " 未设置，且 roles." + role + ".key 缺失）");
        process.exit(1);
      }
    }
  ' "$CONFIG" || fails+=("patcher 角色 key 不可解析")
  if [ ${#fails[@]} -gt 0 ]; then
    echo "⚠ preflight 未通过，拒绝启动：" >&2
    for f in "${fails[@]}"; do echo "  - $f" >&2; done
    return 1
  fi
  echo "preflight 通过：claude CLI 可用；sci/general/ds key 可解析（全角色 → Claude Code + deepseek-v4-pro + thinking max）"
}

locate_run() {
  # 缺省取最新 run 目录；显式传入 runId 时精确定位
  local run="${RUN:-}"
  if [ -z "$run" ]; then
    [ -d "$RUNS" ] || { echo "尚无 run 目录: $RUNS（请先 ./run_prober.sh $NNN）" >&2; exit 1; }
    run="$(ls -1t "$RUNS" | head -1)"
  fi
  local d="$RUNS/$run"
  [ -d "$d" ] || { echo "run 目录不存在: $d（可选参数: prober 产出的 runId）" >&2; exit 1; }
  # 必须已有 prober 产物，否则 patcher 无探针可 verify
  if [ ! -f "$d/probes/manifest.json" ] && [ ! -f "$d/probe-report-tester.json" ]; then
    echo "run 目录 $d 缺少 prober 产物（probes/manifest.json 或 probe-report-tester.json）" >&2
    echo "请先 ./run_prober.sh $NNN，再 ./run_patcher.sh $NNN <runId>" >&2
    exit 1
  fi
  RUN="$run"
  echo "复用 run 目录: $d（runId=$run）"
}

launch() {
  preflight || exit 1
  [ -n "$RUNID" ] && { RUN="$RUNID"; locate_run; }
  # 前台模式也校验 run 目录（不定位则用缺省逻辑检查最新目录）
  if [ -n "$RUN" ] && [ ! -d "$RUNS/$RUN/probes" ] && [ ! -f "$RUNS/$RUN/probes/manifest.json" ] && [ ! -f "$RUNS/$RUN/probe-report-tester.json" ]; then
    echo "run 目录 $RUNS/$RUN 缺少 prober 产物" >&2; exit 1
  fi
  ( cd "$WS" && git status --short --untracked-files=no | grep . ) && {
    echo "工作区非干净基线，以现状继续"; } || true
  local CMDARGS=( --role patcher --workspace "$WS" --config "$CONFIG" --max-retries 1 )
  [ -n "$RUN" ] && CMDARGS+=( --run-dir "$RUNS/$RUN" )
  # 透传标志（--only-roles / --repair-timeout-min 等）；思考/输出全程实时回显（stream-json）
  [ ${#PASS[@]} -gt 0 ] && CMDARGS+=( "${PASS[@]}" )
  if [ -n "$FG" ]; then
    echo "前台运行: node run-dual-075.js ${CMDARGS[*]}"
    local rc=0
    node "$REPO/tools/swe-bench-science/run-dual-075.js" "${CMDARGS[@]}" || rc=$?
    bash "$HERE/sync_test_box.sh" "$NNN" ${RUN:-} patcher || true
    exit $rc
  fi
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  local LOGF="$HERE/logs/patcher-${NNN}-${ts}.log"
  mkdir -p "$HERE/logs"
  setsid nohup node "$REPO/tools/swe-bench-science/run-dual-075.js" "${CMDARGS[@]}" \
    > "$LOGF" 2>&1 < /dev/null &
  echo $! > "$PIDF"
  sleep 2
  kill -0 "$(cat "$PIDF")" 2>/dev/null || { echo "启动失败，日志尾部:" >&2; tail -5 "$LOGF" >&2; exit 1; }
  local PID="$(cat "$PIDF")"
  ( while kill -0 "$PID" 2>/dev/null; do sleep 20; done
    echo "[sync_test_box] patcher 结束 (pid $PID)，开始同步 test_box patcher 产物"
    bash "$HERE/sync_test_box.sh" "$NNN" ${RUN:-} patcher ) &
  echo "已启动 SciPatcher pid=$PID，日志: $LOGF"
  echo "盯日志: tail -f $LOGF"
  echo "结束后自动同步到 test_box/swe_bench_sci/test_${NNN}/patcher（也可手动: $HERE/sync_test_box.sh $NNN ${RUN:-} patcher）"
  echo "完成后下一步: $HERE/run_mentor.sh $NNN${RUN:+ $RUN}"
}
launch

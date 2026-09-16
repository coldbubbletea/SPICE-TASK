#!/usr/bin/env bash
# ============================================================================
# run_mentor.sh NNN [runId] — 只跑 SciReviewer（打分 → 修补打磨 → 终审落 patch）
#
# 用法:
 #   ./run_mentor.sh NNN            后台启动，复用 .codex-sci-debug/runs 下最新的 run 目录
 #   ./run_mentor.sh NNN <runId>    后台启动，复用指定 run 目录（与 prober/patcher 同一个）
 #   ./run_mentor.sh NNN --fg       前台运行
 #
# 它会做什么:
 #   1. preflight: NNN.json 存在 + claude CLI 在 PATH + mentor 角色 key 可解析
 #      （★2026-09-14 硬改★：mentor 现为 deepseek-v4-pro @ Claude Code harness，
 #       key 走 DEEPSEEK_API_KEY（env 优先），其次 roles.mentor.key）
 #   2. 定位 run 目录（缺省最新，或显式 runId）；必须含 patcher 候选 diff
 #   3. SciReviewer (deepseek-v4-pro @ Claude Code + thinking max) 按 Reviewer Skill 对候选逐维打分（JSONL 进度可盯），
 #      按 rubric + 硬约束（CSE）选定更优候选，并在该候选 diff 基础上修补打磨
 #      （不再生成、不从零自写；git apply --check 校验，失败回退原候选）
 #   4. 最终 patch 应用到 task 工作区，停在 stage=done
 #
# 验收: 用 tools/swe-bench-science/verify-NNN.sh（如存在）在 docker 跑私有测试
# ============================================================================
set -euo pipefail
NNN="${1:?用法: ./run_mentor.sh <NNN> [runId|--fg]（例: 001）}"
ARG2="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
WS="$HERE/workspaces/task-${NNN}"
CONFIG="$HERE/${NNN}.json"
RUNS="$WS/.codex-sci-debug/runs"
PIDF="$HERE/logs/run-${NNN}-mentor.pid"
RUN=""

preflight() {
  local fails=()
  [ -d "$WS" ] || fails+=("工作区缺失: $WS（请先物化）")
  [ -f "$CONFIG" ] || fails+=("缺少角色配置: $CONFIG")
  command -v claude >/dev/null 2>&1 || fails+=("claude CLI 不可用（Claude Code 未安装或不在 PATH；安装: npm i -g @anthropic-ai/claude-code）")
  # 校验 mentor 角色: deepseek-v4-pro @ claude harness（2026-09-14 硬改）
  node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const r = (cfg.roles || {}).mentor;
    if (!r || !r.model || !r.provider) { console.error("NNN.json roles.mentor 不完整"); process.exit(1); }
    const p = (cfg.providers || {})[r.provider] || {};
    const env = p.envKey || r.keyEnv;
    // key 解析顺序与 run-dual-075.js keyFor 一致: env 优先，其次 json
    if (!(env && process.env[env]) && !r.key) {
      console.error("mentor 角色 key 不可解析（env " + (env || "(无映射)") + " 未设置，且 roles.mentor.key 缺失）");
      process.exit(1);
    }
  ' "$CONFIG" || fails+=("mentor key 不可解析")
  if [ ${#fails[@]} -gt 0 ]; then
    echo "⚠ preflight 未通过，拒绝启动：" >&2
    for f in "${fails[@]}"; do echo "  - $f" >&2; done
    return 1
  fi
  echo "preflight 通过：$CONFIG 存在；claude CLI 在 PATH；mentor key 可解析（LOCAL_API_KEY / :8040 / :8050 已弃用）"
}

locate_run() {
  local run="${RUN:-}"
  if [ -z "$run" ]; then
    [ -d "$RUNS" ] || { echo "尚无 run 目录: $RUNS（请先 ./run_patcher.sh $NNN）" >&2; exit 1; }
    run="$(ls -1t "$RUNS" | head -1)"
  fi
  local d="$RUNS/$run"
  [ -d "$d" ] || { echo "run 目录不存在: $d（可选参数: patcher 用的 runId）" >&2; exit 1; }
  # 必须已有 patcher 候选 diff，否则 reviewer 无候选可评
  if [ ! -f "$d/patch-r1-sci.diff" ] && [ ! -f "$d/patch-r1-general.diff" ]; then
    echo "run 目录 $d 缺少 patcher 候选 diff（patch-r1-sci.diff / patch-r1-general.diff）" >&2
    echo "请先 ./run_patcher.sh $NNN，再 ./run_mentor.sh $NNN <runId>" >&2
    exit 1
  fi
  RUN="$run"
  echo "复用 run 目录: $d（runId=$run）"
}

launch() {
  preflight || exit 1
  local FG=""
  if [ "$ARG2" = "--fg" ]; then
    FG=1
  else
    RUN="$ARG2"
    locate_run
  fi
  ( cd "$WS" && git status --short --untracked-files=no | grep . ) && {
    echo "工作区非干净基线（含历史 patch 时正常），以现状继续"; } || true
  local CMDARGS=( --role mentor --workspace "$WS" --config "$CONFIG" --max-retries 0 )
  [ -n "$RUN" ] && CMDARGS+=( --run-dir "$RUNS/$RUN" )
  if [ -n "$FG" ]; then
    echo "前台运行: node run-dual-075.js ${CMDARGS[*]}"
    local rc=0
    node "$REPO/tools/swe-bench-science/run-dual-075.js" "${CMDARGS[@]}" || rc=$?
    bash "$HERE/sync_test_box.sh" "$NNN" ${RUN:-} reviewer || true
    exit $rc
  fi
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  local LOGF="$HERE/logs/mentor-${NNN}-${ts}.log"
  mkdir -p "$HERE/logs"
  setsid nohup node "$REPO/tools/swe-bench-science/run-dual-075.js" "${CMDARGS[@]}" \
    > "$LOGF" 2>&1 < /dev/null &
  echo $! > "$PIDF"
  sleep 2
  kill -0 "$(cat "$PIDF")" 2>/dev/null || { echo "启动失败，日志尾部:" >&2; tail -5 "$LOGF" >&2; exit 1; }
  local PID="$(cat "$PIDF")"
  ( while kill -0 "$PID" 2>/dev/null; do sleep 20; done
    echo "[sync_test_box] reviewer 结束 (pid $PID)，开始同步 test_box reviewer 产物"
    bash "$HERE/sync_test_box.sh" "$NNN" ${RUN:-} reviewer ) &
  echo "已启动 SciReviewer pid=$PID，日志: $LOGF"
  echo "盯日志: tail -f $LOGF"
  echo "打分进度: $RUNS/${RUN:-$(ls -1t "$RUNS" 2>/dev/null | head -1)}/mentor-progress-r1.jsonl"
  echo "结束后自动同步到 test_box/swe_bench_sci/test_${NNN}/reviewer（也可手动: $HERE/sync_test_box.sh $NNN ${RUN:-} reviewer）"
  echo "完成后验收: bash $REPO/tools/swe-bench-science/dv-${NNN}.sh（如存在）"
}
launch

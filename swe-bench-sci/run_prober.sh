#!/usr/bin/env bash
# ============================================================================
# run_prober.sh NNN — 只跑 SciProber（probe 阶段）
#
# 用法:
 #   ./run_prober.sh NNN            后台启动（setsid nohup，kill -0 验证存活）
 #   ./run_prober.sh NNN --fg       前台运行（日志直接打到终端，方便盯进度）
 #   可选 env PTM=<分钟数> 覆盖 prober 专家时限（默认 15，如 PTM=25 即 15+10）
 #   可选 env PROBE_RESUME=<旧run目录> 断点续跑：恢复该 run 目录 raw/ 里各角色的 claude 会话（--resume threadId），不重开
 #
# 它会做什么:
 #   1. preflight: 工作区在 + NNN.json 存在 + claude CLI 在 PATH + tester/kimi 双角色 key 可解析
 #      （env DEEPSEEK_API_KEY 优先，其次 roles.<role>.key；全角色统一 Claude Code harness）
 #   2. 新建 run 目录: workspaces/task-NNN/.codex-sci-debug/runs/<runId>/
 #   3. 双 prober 并行（统一 Claude Code + ds flash：deepseek-chat + thinking medium，
#      providers.deepseek-flash，见 NNN.json）读 bug + 代码，各自产出:
 #        probe-report-tester.json / probe-report-kimi.json   探针报告（提问/暴露入口/探针清单）
 #        prober/<ds|kimi>/<ds|kimi>.md   自名声明（先写）
 #        prober/<ds|kimi>/tests/pN.py + manifest.json   各通道物化探针
 #        probes/pN.py + manifest.json   合并物化探针脚本
 #   4. 停在 stage=probe-done，不触发 patcher/mentor
#
# 下一步: ./run_patcher.sh NNN
# ============================================================================
set -euo pipefail
NNN="${1:?用法: ./run_prober.sh <NNN> [--fg]（例: 001）}"
MODE="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
WS="$HERE/workspaces/task-${NNN}"
CONFIG="$HERE/${NNN}.json"
PIDF="$HERE/logs/run-${NNN}-prober.pid"

preflight() {
  local fails=()
  [ -d "$WS" ] || fails+=("工作区缺失: $WS（请先物化）")
  [ -f "$CONFIG" ] || fails+=("缺少角色配置: $CONFIG")
  command -v claude >/dev/null 2>&1 || fails+=("claude CLI 不可用（Claude Code 未安装或不在 PATH）")
  node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const role of ["tester", "kimi"]) {
    const r = (cfg.roles || {})[role];
    if (!r || !r.model || !r.provider) { console.error("NNN.json roles." + role + " 不完整"); process.exit(1); }
    const p = (cfg.providers || {})[r.provider] || {};
    const env = p.envKey || r.keyEnv;
    // key 解析顺序与 run-dual-075.js keyFor 一致: env 优先，其次 json
    if (!(env && process.env[env]) && !r.key) {
      console.error(role + " 角色 key 不可解析（env " + (env || "(无映射)") + " 未设置，且 roles." + role + ".key 缺失）");
      process.exit(1);
    }
  }
  ' "$CONFIG" || fails+=("prober 角色 key 不可解析")
  if [ ${#fails[@]} -gt 0 ]; then
    echo "⚠ preflight 未通过，拒绝启动：" >&2
    for f in "${fails[@]}"; do echo "  - $f" >&2; done
    return 1
  fi
  echo "preflight 通过：$CONFIG 存在；claude CLI 可用；tester/kimi key 可解析"
}

launch() {
  preflight || exit 1
  # 工作区脏基线只是提醒，不阻塞
  ( cd "$WS" && git status --short --untracked-files=no | grep . ) && {
    echo "工作区非干净基线，以现状继续"; } || true
  if [ "$MODE" = "--fg" ]; then
    echo "前台运行: node run-dual-075.js --role prober --workspace $WS（单通道 --only-roles ds）"
    local rc=0
    PTARGS=()
    [ -n "${PTM:-}" ] && PTARGS+=("--probe-timeout-min" "$PTM")
    RESARGS=()
    [ -n "${PROBE_RESUME:-}" ] && RESARGS+=("--probe-resume" "$PROBE_RESUME")
    node "$REPO/tools/swe-bench-science/run-dual-075.js" \
      --role prober --workspace "$WS" --config "$CONFIG" --max-retries 1 --only-roles ds "${PTARGS[@]+"${PTARGS[@]}"}" "${RESARGS[@]+"${RESARGS[@]}"}" || rc=$?
    bash "$HERE/sync_test_box.sh" "$NNN" prober || true
    exit $rc
  fi
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  local LOGF="$HERE/logs/prober-${NNN}-${ts}.log"
  mkdir -p "$HERE/logs"
  PTARGS=()
  [ -n "${PTM:-}" ] && PTARGS+=("--probe-timeout-min" "$PTM")
  RESARGS=()
  [ -n "${PROBE_RESUME:-}" ] && RESARGS+=("--probe-resume" "$PROBE_RESUME")
  setsid nohup node "$REPO/tools/swe-bench-science/run-dual-075.js" \
    --role prober --workspace "$WS" --config "$CONFIG" --max-retries 1 --only-roles ds "${PTARGS[@]+"${PTARGS[@]}"}" "${RESARGS[@]+"${RESARGS[@]}"}" \
    > "$LOGF" 2>&1 < /dev/null &
  echo $! > "$PIDF"
  sleep 2
  kill -0 "$(cat "$PIDF")" 2>/dev/null || { echo "启动失败，日志尾部:" >&2; tail -5 "$LOGF" >&2; exit 1; }
  local PID="$(cat "$PIDF")"
  ( while kill -0 "$PID" 2>/dev/null; do sleep 20; done
    echo "[sync_test_box] prober 结束 (pid $PID)，开始同步 test_box prober 产物"
    bash "$HERE/sync_test_box.sh" "$NNN" prober ) &
  echo "已启动 SciProber pid=$PID，日志: $LOGF"
  echo "盯日志: tail -f $LOGF"
  echo "结束后自动同步到 test_box/swe_bench_sci/test_${NNN}/prober（也可手动: $HERE/sync_test_box.sh $NNN prober）"
  echo "完成后下一步: $HERE/run_patcher.sh $NNN"
}
launch

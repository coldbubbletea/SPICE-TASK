#!/usr/bin/env bash
# ============================================================================
# sync_test_box.sh NNN [runId] [stage] — 把流水线 run 产物同步到 test_box
#
# 用法:
 #   ./sync_test_box.sh NNN [runId] [stage]
 #     NNN     task 编号（041）
 #     runId   可选；缺省取 workspaces/task-NNN/.codex-sci-debug/runs 下最新
 #     stage   可选: prober | patcher | reviewer；缺省 all
 #   参数顺序: runId 与 stage 可互换位置（stage 关键字优先识别）
#
# 映射规范（对应 test_box/swe_bench_sci/README.md）:
 #   prober/   <- run/prober/<agent>/（自名文件 + 各通道 tests/pN.py + 报告）
 #                + run/probes/（合并探针）→ prober/probes/
 #                + probes.jsonl（由 probes/manifest.json 生成，一 case 一行）
 #                + public-command.txt（缺省 python3 reproduce.py，不覆盖已有）
 #   patcher/  <- run/patch-r1-<label>.diff → candidate-<label>.diff
 #                + verify-result-r1-*.json / comparison-r1.json 原样
 #                + run/patcher/<agent>/（自名文件 + 修复记录）
 #   reviewer/ <- run/mentor-progress-r1.jsonl → mentor-scores-progress.jsonl
 #                + run/mentor-verdict-r1.json → mentor-verdict.json
 #                + mentor-evaluation / chosen-patch / verify-* 原样
 #                + chosen-patch.json 中的打磨 patch → patch-rerun-reviewer-polished.diff
 # 幂等: 重复执行直接覆盖同名文件。
# ============================================================================
set -euo pipefail
NNN="${1:?用法: ./sync_test_box.sh <NNN> [runId] [stage]}"
ARG2="${2:-}"
ARG3="${3:-}"
case "$ARG2" in
  prober|patcher|reviewer|all) STAGE="$ARG2"; RUN="" ;;
  *) STAGE="${ARG3:-all}"; RUN="$ARG2" ;;
esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
WS="$HERE/workspaces/task-${NNN}"
RUNS="$WS/.codex-sci-debug/runs"
DST="$REPO/test_box/swe_bench_sci/test_${NNN}"

if [ -z "$RUN" ]; then
  [ -d "$RUNS" ] || { echo "尚无 run 目录: $RUNS" >&2; exit 1; }
  RUN="$(ls -1t "$RUNS" | head -1)"
fi
RUNDIR="$RUNS/$RUN"
[ -d "$RUNDIR" ] || { echo "run 目录不存在: $RUNDIR" >&2; exit 1; }

mkdir -p "$DST/prober" "$DST/patcher" "$DST/reviewer"
echo "sync_test_box: task $NNN · run $RUN · stage $STAGE → $DST"

sync_prober() {
  # 各通道: 自名 .md + tests/pN.py + 通道报告
  for d in "$RUNDIR"/prober/*/; do
    [ -d "$d" ] || continue
    local name; name="$(basename "$d")"
    cp -r "$d" "$DST/prober/"
    echo "  prober/$name/ 已同步"
  done
  # 合并探针
  if [ -d "$RUNDIR/probes" ]; then
    rm -rf "$DST/prober/probes"
    cp -r "$RUNDIR/probes" "$DST/prober/probes"
    echo "  prober/probes/（合并探针）已同步"
  fi
  # run 根目录 prober 产物（主报告 + intake + 覆盖 + 活动 + 状态）
  for f in intake.md contracts.md contracts.json contract-coverage.json probe-coverage.json probe-report-tester.json activity.log run-state.json; do
    [ -f "$RUNDIR/$f" ] && { cp "$RUNDIR/$f" "$DST/prober/"; echo "  prober/$f 已同步"; }
  done
  # raw harness 日志（claude envelope 全文，截断/schema 失败诊断用）
  # 只取 prober 专家的 raw（tester*），避免拖入后续阶段（patcher*）的流；先清后拷保证幂等
  if [ -d "$RUNDIR/raw" ] && ls "$RUNDIR"/raw/tester* >/dev/null 2>&1; then
    rm -rf "$DST/prober/raw"
    mkdir -p "$DST/prober/raw"
    cp -v "$RUNDIR"/raw/tester* "$DST/prober/raw/" 2>/dev/null | sed 's/^/  prober\/raw\//' || true
    echo "  prober/raw/（tester*）已同步"
  fi
  # probes.jsonl: 由 manifest.json 生成（保留原有字段，补 pass_criterion 缺省）
  if [ -f "$RUNDIR/probes/manifest.json" ]; then
    node -e '
      const fs = require("fs");
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const lines = (m.probes || []).map((p) => {
        const o = { ...p };
        if (!o.pass_criterion) o.pass_criterion = "python3 " + p.file + " exits 0";
        return JSON.stringify(o);
      });
      fs.writeFileSync(process.argv[2], lines.join("\n") + "\n");
    ' "$RUNDIR/probes/manifest.json" "$DST/prober/probes.jsonl"
    echo "  prober/probes.jsonl 已生成"
  fi
  # public-command.txt: 缺省写公共诊断命令，已有则不覆盖
  if [ ! -f "$DST/prober/public-command.txt" ]; then
    echo "python3 reproduce.py" > "$DST/prober/public-command.txt"
    echo "  prober/public-command.txt 已创建（缺省）"
  fi
}

sync_patcher() {
  local n=0
  for f in "$RUNDIR"/patch-r1-*.diff; do
    [ -f "$f" ] || continue
    local label; label="$(basename "$f" | sed 's/^patch-r1-//; s/\.diff$//')"
    cp "$f" "$DST/patcher/candidate-${label}.diff"
    n=$((n+1))
  done
  for f in "$RUNDIR"/verify-result-r1-*.json "$RUNDIR"/comparison-r1.json; do
    [ -f "$f" ] && { cp "$f" "$DST/patcher/"; n=$((n+1)); }
  done
  for d in "$RUNDIR"/patcher/*/; do
    [ -d "$d" ] || continue
    local name; name="$(basename "$d")"
    cp -r "$d" "$DST/patcher/"
    echo "  patcher/${name}/ 已同步"
  done
  [ -d "$RUNDIR/raw" ] && { rm -rf "$DST/patcher/raw"; cp -r "$RUNDIR/raw" "$DST/patcher/raw"; echo "  patcher/raw/ 已同步"; }
  [ "$n" -gt 0 ] || echo "  （无 patcher 产物，跳过）"
}

sync_reviewer() {
  local n=0
  [ -f "$RUNDIR/mentor-progress-r1.jsonl" ] && { cp "$RUNDIR/mentor-progress-r1.jsonl" "$DST/reviewer/mentor-scores-progress.jsonl"; n=$((n+1)); }
  [ -f "$RUNDIR/mentor-verdict-r1.json" ] && { cp "$RUNDIR/mentor-verdict-r1.json" "$DST/reviewer/mentor-verdict.json"; n=$((n+1)); }
  for f in "$RUNDIR"/mentor-evaluation-r1.md "$RUNDIR"/chosen-patch.json \
           "$RUNDIR"/verify-final.json "$RUNDIR"/verify-previous-r1-*.json \
           "$RUNDIR"/patch-to-apply-*.diff; do
    [ -f "$f" ] && { cp "$f" "$DST/reviewer/"; n=$((n+1)); }
  done
  # 打磨后的最终 patch: chosen-patch.json 记录 source（选中候选 label），
  # 对应 patch-to-apply-<source>.diff（mentor 打磨后实际应用到工作区的那份）
  if [ -f "$RUNDIR/chosen-patch.json" ]; then
    local src; src="$(node -e '
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log((j.source || (j.verdict || {}).choice || "").replace(/^candidate_\d+（→ /, "").replace(/）.*$/, ""));
    ' "$RUNDIR/chosen-patch.json" 2>/dev/null | tr -d '[:space:]' || true)"
    if [ -n "$src" ] && [ -f "$RUNDIR/patch-to-apply-${src}.diff" ]; then
      cp "$RUNDIR/patch-to-apply-${src}.diff" "$DST/reviewer/patch-rerun-reviewer-polished.diff"
      echo "  reviewer/patch-rerun-reviewer-polished.diff 已导出（source=${src}）"
    elif [ -n "$src" ] && [ -f "$RUNDIR/patch-to-apply-r1-${src}-resume.diff" ]; then
      cp "$RUNDIR/patch-to-apply-r1-${src}-resume.diff" "$DST/reviewer/patch-rerun-reviewer-polished.diff"
      echo "  reviewer/patch-rerun-reviewer-polished.diff 已导出（resume 版, source=${src}）"
    else
      echo "  ⚠ chosen-patch.json 的 source 未找到对应 patch-to-apply 文件，跳过 polished diff"
    fi
  fi
  [ "$n" -gt 0 ] || echo "  （无 reviewer 产物，跳过）"
}

case "$STAGE" in
  prober)   sync_prober ;;
  patcher)  sync_patcher ;;
  reviewer) sync_reviewer ;;
  all)      sync_prober; sync_patcher; sync_reviewer ;;
esac
echo "sync_test_box: 完成"

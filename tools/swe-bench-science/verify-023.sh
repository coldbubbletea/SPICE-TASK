#!/usr/bin/env bash
# ============================================================================
# swe-bench-science task 023 · docker verifier 验收（public reproduce.py +
# 私有 private_tests/）
#
# 用法:
#   bash tools/swe-bench-science/verify-023.sh                       # 用最新 run 目录
#   bash tools/swe-bench-science/verify-023.sh <runId>               # 指定 run
#   bash tools/swe-bench-science/verify-023.sh <runId> <patch文件> [标签]
#
# 轮次:
#   candidate-ds  runs/<runId>/patch-r1-ds.diff（prober 指引下的 patcher 产物）
#   baseline      空 patch（期望 reward=0，证明私有测试有区分度）
#
# 镜像内 /tests/test.sh 自带 `git reset --hard` + `git apply --binary
# /logs/artifacts/model.patch` + `python /tests/grader.py`，故只需挂载 /logs。
# 本次运行环境禁止 rm -f/rm -rf，故旧轮次目录一律 mv 到 <label>.prev-<ts>。
# ============================================================================
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WS="$REPO/swe-bench-sci/workspaces/task-023"
RUNS="$WS/.codex-sci-debug/runs"
IMG="kevinxulearning/swe-bench-science-verifier-python-task-023@sha256:18a396490f4a3b79796d8e12d38f29e47a453a67e53c0427d8cdf4a38b33876e"
OUT_ROOT=/tmp/dv023

# 隔离策略（2026-09-16 用户强制）：prober/patcher 运行期间本机不得存在 verifier 镜像，
# 避免 agent 通过 `docker run <verifier>` 读到 /tests/private_tests（= 作弊）。
# 因此验收开始时才拉取；结束后用 `docker rmi` 再次隔离。
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "verifier 镜像不在本机（预期：运行期已隔离），现在拉取 …"
  docker pull "$IMG" || { echo "拉取 verifier 镜像失败: $IMG" >&2; exit 1; }
fi

RUNID="${1:-}"
if [ -z "$RUNID" ]; then RUNID="$(basename "$(ls -dt "$RUNS"/*/ 2>/dev/null | head -1)")"; fi
[ -n "$RUNID" ] || { echo "未找到 run 目录: $RUNS" >&2; exit 1; }
RUN="$RUNS/$RUNID"
echo "runId: $RUNID"

run_round() { # $1=label $2=patch文件|none
  local label="$1" patchsrc="$2"
  local D="$OUT_ROOT/$label"
  if [ -e "$D" ]; then mv "$D" "$D.prev-$(date +%s)"; fi
  mkdir -p "$D/artifacts" "$D/verifier"
  if [ "$patchsrc" = "none" ]; then : > "$D/artifacts/model.patch"; else cp "$patchsrc" "$D/artifacts/model.patch"; fi
  echo "===== [RUN: $label] model.patch 行数: $(wc -l < "$D/artifacts/model.patch") ====="
  timeout 25m docker run --rm -v "$D:/logs" "$IMG" > "$D/container-stdout.txt" 2>&1
  echo "docker exit=$?"
  echo "--- reward.json ---"
  cat "$D/verifier/reward.json" 2>/dev/null || { echo "(无 reward.json) 容器输出尾部:"; tail -30 "$D/container-stdout.txt"; }
  echo "--- junit 摘要（public+private 合计）---"
  grep -oE 'tests="[0-9]+" skipped="[0-9]+" failures="[0-9]+" errors="[0-9]+"' "$D/verifier/junit.xml" 2>/dev/null || true
  echo "--- 逐用例 ---"
  grep -oE '<testcase[^>]*classname="[^"]*"[^>]*name="[^"]*"' "$D/verifier/junit.xml" 2>/dev/null | sed -E 's/.*classname="([^"]*)".*name="([^"]*)".*/\1 :: \2/' || true
  echo "--- test-stdout 尾部 ---"
  tail -15 "$D/verifier/test-stdout.txt" 2>/dev/null
  echo
}

if [ $# -ge 2 ]; then
  run_round "${3:-candidate}" "$2"
else
  PATCH="$(ls -t "$RUN"/patch-r1-ds.diff "$RUN"/patch-to-apply-ds.diff "$RUN"/candidate-ds.diff 2>/dev/null | head -1)"
  [ -n "$PATCH" ] || { echo "未找到 ds 通道 patch（$RUN/patch-r1-ds.diff）" >&2; exit 1; }
  echo "patch: $PATCH"
  run_round "candidate-ds" "$PATCH"
fi
run_round "baseline" none
echo "ALL-DONE（产物: $OUT_ROOT/<label>/verifier/reward.json）"

#!/usr/bin/env bash
# ============================================================================
# swe-bench-science task 023 · workspace 物化（env 镜像 /app/task_023 → workspaces/task-023）
#
# 用法: bash tools/swe-bench-science/materialize-023.sh
# 幂等: 已物化（含 .git baseline）则跳过；重做请手动删除 workspaces/task-023
# ============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SWE="$REPO/swe-bench-sci"
WS="$SWE/workspaces/task-023"
ENV_IMG="docker.io/kevinxulearning/swe-bench-science-environment-python-task-023:v0.1.2@sha256:09b54e722b3442ddc0fd429d18c8e69de1e8c7bc6a4b129bbac07763c185ec6f"

# 1) 镜像必须就位（缺失则 pull）
docker image inspect "$ENV_IMG" >/dev/null 2>&1 || { echo "pull env image …"; docker pull "$ENV_IMG"; }

# 2) 物化
if [ -d "$WS/.git" ]; then
  echo "已物化（$WS 含 .git baseline），跳过。重做请: rm -rf $WS"
  exit 0
fi
[ -e "$WS" ] && { echo "工作区部分存在: $WS，请先手动清理" >&2; exit 1; }

CID="$(docker create "$ENV_IMG" true)"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
# 用临时运行容器枚举 /app 找 task 目录（create 的容器未运行，不能 exec）
APP_LIST="$(docker run --rm --entrypoint sh "$ENV_IMG" -c 'ls /app' 2>/dev/null || docker run --rm "$ENV_IMG" ls /app)"
TASKDIR="$(echo "$APP_LIST" | grep -E '^(task[-_]023)$' | head -1 || true)"
[ -n "$TASKDIR" ] || { echo "env 镜像 /app 下未找到 task_023 目录: $(echo "$APP_LIST")" >&2; exit 1; }
echo "task 目录: /app/${TASKDIR}"
mkdir -p "$WS"
docker cp "$CID:/app/${TASKDIR}/." "$WS/"
echo "=== 物化内容 ==="
ls -a "$WS"
echo "=== git baseline ==="
git -C "$WS" log --oneline -3 2>/dev/null || echo "（无 .git，将初始化 baseline）"
if [ ! -d "$WS/.git" ]; then
  git -C "$WS" init -q
  git -C "$WS" add -A
  git -C "$WS" -c user.email=sci@local -c user.name=sci commit -qm "baseline (materialized from env image)"
fi
echo "MATERIALIZED-OK"

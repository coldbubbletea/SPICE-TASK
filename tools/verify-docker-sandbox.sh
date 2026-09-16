#!/usr/bin/env bash
# 在 swe-bench-science verifier 沙箱中验收补丁：通过全部 public + private 测试才算通过。
#
# 用法: tools/verify-docker-sandbox.sh <verifier-image> <model.patch>
# 例:   tools/verify-docker-sandbox.sh \
#     kevinxulearning/swe-bench-science-verifier-python-task-089:v0.1.2 \
#     .codex-sci-debug/runs/<run>/mentor-rerun/patch-to-apply-general.diff
set -eu

if [ $# -ne 2 ]; then
  echo "用法: $0 <verifier-image> <model.patch>" >&2
  exit 1
fi

IMAGE="$1"
PATCH="$2"

HOST_DIR="$(mktemp -d /tmp/verifier-sandbox-XXXXXX)"
trap 'rm -rf "$HOST_DIR"' EXIT
mkdir -p "$HOST_DIR/artifacts"
cp "$PATCH" "$HOST_DIR/artifacts/model.patch"

echo "[sandbox] 镜像: $IMAGE"
echo "[sandbox] 补丁: $PATCH ($(wc -l < "$PATCH") 行)"
echo "[sandbox] 启动 verifier 容器（/tests/test.sh: git reset --hard + git apply + 评分）…"

docker run --rm -v "$HOST_DIR:/logs" "$IMAGE"

echo "[sandbox] 结果:"
cat "$HOST_DIR/verifier/reward.json"
echo
if [ "$(python3 -c "import json,sys; print(json.load(open('$HOST_DIR/verifier/reward.json'))['reward'])")" = "1" ]; then
  echo "[sandbox] 验收通过 ✅（public + private 全部通过，reward=1）"
  exit 0
else
  echo "[sandbox] 验收未通过 ❌（reward≠1）"
  echo "[sandbox] 详细日志: docker run 日志见上，junit 摘要: "
  tail -40 "$HOST_DIR/verifier/test-stdout.txt" 2>/dev/null || true
  exit 2
fi

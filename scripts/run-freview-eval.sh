#!/usr/bin/env sh
# f-review 평가: 플러그인 빌드 → 대상 프로젝트 f-review-cases/*.yaml마다 OpenCode로 f-review 실행 → 채점.
#   ./scripts/run-freview-eval.sh --mode whole                      # 기본 대상·모델, whole 모드 전체
#   ./scripts/run-freview-eval.sh --mode diff --case case-05        # 한 케이스만, diff 모드
#   ./scripts/run-freview-eval.sh --mode whole --no-run             # 재실행 없이 기존 리포트만 채점
#   FREVIEW_TARGET=/path FREVIEW_MODEL=openrouter/qwen/qwen3.8-27b ./scripts/run-freview-eval.sh --mode whole
set -eu
TARGET="${FREVIEW_TARGET:-/Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online}"
MODEL="${FREVIEW_MODEL:-openrouter/qwen/qwen3.8-27b}"
cd "$(dirname "$0")/.."
bun run build >/dev/null
exec bun scripts/freview-eval.ts "$TARGET" --model "$MODEL" "$@"

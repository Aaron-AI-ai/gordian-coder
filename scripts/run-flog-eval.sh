#!/usr/bin/env sh
# f-log 실환경 평가: 플러그인 빌드 → 대상 프로젝트의 f-log-cases/*.yaml마다 OpenCode로 f-log 실행 → 리포트 채점.
#   ./scripts/run-flog-eval.sh                       # 기본 대상·모델로 전 케이스
#   ./scripts/run-flog-eval.sh --case case-01-npe    # 한 케이스만
#   ./scripts/run-flog-eval.sh --no-run              # 재실행 없이 기존 리포트만 채점
#   FLOG_TARGET=/path/to/project FLOG_MODEL=openrouter/qwen/qwen3-coder-next ./scripts/run-flog-eval.sh
set -eu
TARGET="${FLOG_TARGET:-/Users/koscom/workspace/fico/test-projects/on-test-lab/on-test-lab-online}"
MODEL="${FLOG_MODEL:-openrouter/qwen/qwen3.8-27b}"
cd "$(dirname "$0")/.."
bun run build >/dev/null
exec bun scripts/flog-eval.ts "$TARGET" --model "$MODEL" "$@"

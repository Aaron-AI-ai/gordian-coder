#!/usr/bin/env sh
# flog-eval 채점기 단위 테스트 실행. 추가 인자는 bun test로 전달된다 (예: --watch).
cd "$(dirname "$0")/.." && exec bun test scripts/__tests__/flog-eval.test.ts "$@"

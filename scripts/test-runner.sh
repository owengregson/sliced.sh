#!/usr/bin/env bash
# scripts/test-runner.sh — run each test file in a fresh process (bun leaks mock.module state across files)
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
while IFS= read -r f; do
	if [[ "${1:-}" == "--no-int" && "$f" == test/integration/* ]]; then continue; fi
	bun test "$f" || status=1
done < <(find test tools -name '*.test.ts' | sort)
exit $status

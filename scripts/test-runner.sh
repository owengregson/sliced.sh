#!/usr/bin/env bash
# scripts/test-runner.sh — run each test file in a fresh process (bun leaks mock.module state across files)
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
while IFS= read -r f; do
	if [[ "${1:-}" == "--no-int" && "$f" == test/integration/* ]]; then continue; fi
	# `bunfig.toml`'s `[test] timeout` is NOT honoured by `bun test`, so the effective limit was
	# always the 5 s default. The statistical probes in test/core/timing run 5-6 s and were
	# passing or failing on machine load alone. Pass it explicitly; keep it equal to bunfig.
	bun test --timeout 15000 "$f" || status=1
done < <(find test tools -name '*.test.ts' | sort)
exit $status

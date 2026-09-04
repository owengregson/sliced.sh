#!/usr/bin/env bash
# tools/data/01_download.sh — fetch Lichess open-database months (Appendix D §1.2 / §3b.2).
# Monthly rated-standard dumps carry [%clk] comments after every move since April 2017.
#   usage: 01_download.sh [--out DIR] [YYYY-MM ...]        (default: 2025-09 … 2025-12)
set -euo pipefail

OUT="data/raw"
MONTHS=()
while [[ $# -gt 0 ]]; do
	case "$1" in
		--out) OUT="$2"; shift 2 ;;
		-h|--help) sed -n '2,5p' "$0"; exit 0 ;;
		*) MONTHS+=("$1"); shift ;;
	esac
done
if [[ ${#MONTHS[@]} -eq 0 ]]; then MONTHS=(2025-09 2025-10 2025-11 2025-12); fi

mkdir -p "$OUT"
for m in "${MONTHS[@]}"; do
	name="lichess_db_standard_rated_${m}.pgn.zst"
	url="https://database.lichess.org/standard/${name}"
	if [[ -f "$OUT/$name" ]]; then
		echo "have $name"
		continue
	fi
	echo "fetching $url"
	curl -L --fail --retry 3 -C - -o "$OUT/$name.part" "$url"
	mv "$OUT/$name.part" "$OUT/$name"
done
echo "done: ${MONTHS[*]} → $OUT"

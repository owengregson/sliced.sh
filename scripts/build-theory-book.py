#!/usr/bin/env python3
"""
scripts/build-theory-book.py — a Polyglot book of named opening theory (2026-09-15).

The input is the Lichess `chess-openings` dataset (https://github.com/lichess-org/chess-openings,
released as public-domain facts under CC0): five tab-separated files `a.tsv` … `e.tsv`, one named
opening per row as `eco`, `name` and the line's `pgn`. Every (position, move) along every named
line becomes one 16-byte Polyglot entry `{key, move, weight, learn}`, for both sides' moves; the
weight is the number of named lines that play that move from that position (capped at 65535), so
a main line outweighs a single sideline. Keys, move encoding and entry layout are exactly
`scripts/build-club-book.py`'s (both import `encode_move` and `ENTRY` from `scripts/polyglot_book.py`).
Next to the book a `<book>.build.json` manifest records the source, each input's SHA-256, the counts and the book's SHA-256;
`scripts/vendor-engine.ts` renders `docs/third-party.md` from it.

The shipped book was built with exactly this invocation (inputs are the unmodified files from
https://raw.githubusercontent.com/lichess-org/chess-openings/master/):

    uv run --with chess scripts/build-theory-book.py \
        --input a.tsv --input b.tsv --input c.tsv --input d.tsv --input e.tsv \
        --output assets/books/theory.bin

After building, re-run `bun run vendor:engine` to refresh `docs/third-party.md`.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import chess
import chess.polyglot
from polyglot_book import ENTRY, MAX_WEIGHT, encode_move, sha256_file, write_manifest

SOURCE = "https://github.com/lichess-org/chess-openings"
MOVE_NUMBER = re.compile(r"^\d+\.+$|^\d+\.")


def san_moves(pgn: str) -> list[str]:
    """The SAN moves of a dataset `pgn` cell (move numbers dropped)."""
    out: list[str] = []
    for token in pgn.split():
        if MOVE_NUMBER.match(token):
            token = MOVE_NUMBER.sub("", token)
            if not token:
                continue
        out.append(token)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", type=Path, action="append", required=True, help="a chess-openings .tsv; repeatable")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    counts: dict[int, Counter] = defaultdict(Counter)
    lines = skipped = max_plies = 0
    for path in args.input:
        with path.open(encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh, delimiter="\t"):
                moves = san_moves(row.get("pgn", ""))
                board = chess.Board()
                try:
                    for san in moves:
                        move = board.parse_san(san)
                        key = chess.polyglot.zobrist_hash(board)
                        counts[key][encode_move(board, move)] += 1
                        board.push(move)
                except ValueError as error:
                    skipped += 1
                    print(f"  skipped {row.get('eco')} {row.get('name')}: {error}", file=sys.stderr)
                    continue
                lines += 1
                max_plies = max(max_plies, len(moves))

    # Every (position, move) of a named line is theory: no threshold, weights capped at 16 bits.
    entries = sorted((key, move, min(n, MAX_WEIGHT)) for key, moves in counts.items() for move, n in moves.items())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("wb") as out:
        for key, move, weight in entries:
            out.write(ENTRY.pack(key, move, weight, 0))
    size = len(entries) * ENTRY.size
    manifest = {
        "book": args.output.name,
        "kind": "theory",
        "script": "scripts/build-theory-book.py",
        "source": SOURCE,
        "inputs": [p.name for p in args.input],
        "input_sha256": {p.name: sha256_file(p) for p in args.input},
        "lines": lines,
        "skipped_lines": skipped,
        "max_plies": max_plies,
        "positions": len(counts),
        "entries": len(entries),
        "bytes": size,
        "sha256": sha256_file(args.output),
    }
    manifest_path = write_manifest(args.output, manifest)
    print(f"wrote {args.output} ({len(entries)} entries from {lines} named lines, {size} bytes)", file=sys.stderr)
    print(f"wrote {manifest_path}", file=sys.stderr)
    return 1 if skipped else 0


if __name__ == "__main__":
    sys.exit(main())

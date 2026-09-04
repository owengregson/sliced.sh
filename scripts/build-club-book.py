#!/usr/bin/env python3
"""
scripts/build-club-book.py — build a Polyglot opening book from Lichess PGN (Task 15, §7.3).

The bundled books (`assets/books/club.bin`, `assets/books/gm2600.bin`) are generated from the
CC0 Lichess open database (https://database.lichess.org/): games are filtered by the rating of
BOTH players, the first `--max-ply` plies of every game are counted, and each (position, move)
pair seen at least `--min-count` times becomes one 16-byte entry `{key, move, weight, learn}`
with `weight` = the move's frequency (scaled to fit 16 bits per position) and `learn` = 0.
Keys are the standard Polyglot Zobrist hash (`chess.polyglot.zobrist_hash`), castling is encoded
king-takes-rook as the format requires, and entries are written sorted by key.

Examples (run offline; a month of the open database is a multi-GB download for recent months,
so pick a small one — 2013-01 is ~17 MB — or the Lichess Elite subset for a strong book):

    uv run --with chess --with zstandard scripts/build-club-book.py \
        --input lichess_db_standard_rated_2013-01.pgn.zst \
        --min-elo 1200 --max-elo 1800 --output assets/books/club.bin

    uv run --with chess --with zstandard scripts/build-club-book.py \
        --input lichess_elite_2020-06.pgn --min-elo 2600 --max-bytes 360000 \
        --output assets/books/gm2600.bin

`--max-bytes` raises `--min-count` until the book fits. Inputs may be `.pgn`, `.pgn.zst` or a
`.zip` holding `.pgn` files; several `--input` flags are accepted. Bullet games are dropped
unless `--keep-bullet`. Requires python-chess and zstandard (`uv run --with chess --with
zstandard ...`). Record the sha256 of the output in `docs/third-party.md` by re-running
`bun run vendor:engine`.
"""

from __future__ import annotations

import argparse
import io
import re
import struct
import sys
import time
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import IO, Iterable, Iterator

import chess
import chess.polyglot

ENTRY = struct.Struct(">QHHI")
MAX_WEIGHT = 0xFFFF


def open_inputs(paths: list[Path]) -> Iterator[IO[str]]:
    """Yield text handles for every PGN in `paths` (.pgn, .pgn.zst, .zip)."""
    for path in paths:
        name = path.name.lower()
        if name.endswith(".zst"):
            import zstandard

            with path.open("rb") as raw:
                reader = zstandard.ZstdDecompressor().stream_reader(raw)
                yield io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
        elif name.endswith(".zip"):
            with zipfile.ZipFile(path) as zf:
                for member in zf.namelist():
                    if member.lower().endswith(".pgn"):
                        with zf.open(member) as raw:
                            yield io.TextIOWrapper(raw, encoding="utf-8", errors="replace")
        else:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                yield fh


RESULTS = {"1-0", "0-1", "1/2-1/2", "*"}
COMMENT_RE = re.compile(r"\{[^}]*\}")


def rating(headers: dict[str, str], key: str) -> int | None:
    value = headers.get(key, "")
    return int(value) if value.isdigit() else None


def is_bullet(headers: dict[str, str]) -> bool:
    event = headers.get("Event", "").lower()
    if "bullet" in event:
        return True
    tc = headers.get("TimeControl", "")
    if "+" in tc:
        base, inc = tc.split("+", 1)
        if base.isdigit() and inc.isdigit():
            return int(base) + 40 * int(inc) < 180
    return False


def wanted(headers: dict[str, str], args: argparse.Namespace) -> bool:
    if headers.get("Variant", "Standard") != "Standard":
        return False
    if headers.get("FEN"):
        return False
    white = rating(headers, "WhiteElo")
    black = rating(headers, "BlackElo")
    if white is None or black is None:
        return False
    if min(white, black) < args.min_elo or max(white, black) > args.max_elo:
        return False
    if not args.keep_bullet and is_bullet(headers):
        return False
    return True


def games(fh: IO[str]) -> Iterator[tuple[dict[str, str], str]]:
    """(headers, movetext) per game of a PGN stream, without building python-chess game trees."""
    headers: dict[str, str] = {}
    movetext: list[str] = []
    for line in fh:
        line = line.strip()
        if line.startswith("[") and line.endswith("]") and not movetext:
            key, _, rest = line[1:-1].partition(" ")
            headers[key] = rest.strip().strip('"')
        elif line:
            movetext.append(line)
        elif movetext:
            yield headers, " ".join(movetext)
            headers, movetext = {}, []
    if headers and movetext:
        yield headers, " ".join(movetext)


def san_tokens(movetext: str, max_ply: int) -> list[str]:
    """The first `max_ply` SAN tokens of `movetext` (comments, NAGs, move numbers, results dropped)."""
    text = COMMENT_RE.sub(" ", movetext)
    if "(" in text:
        return []  # variations never occur in Lichess exports; skip rather than mis-parse
    out: list[str] = []
    for raw in text.split():
        if raw in RESULTS or raw.startswith("$"):
            continue
        token = raw.rsplit(".", 1)[-1] if "." in raw else raw
        if not token or token[0].isdigit():
            continue
        out.append(token.rstrip("!?"))
        if len(out) >= max_ply:
            break
    return out


def encode_move(board: chess.Board, move: chess.Move) -> int:
    """Polyglot 16-bit move: castling stored as king-takes-rook."""
    to_square = move.to_square
    if board.is_castling(move):
        rank = chess.square_rank(move.from_square)
        to_square = chess.square(7 if chess.square_file(move.to_square) > 4 else 0, rank)
    promo = 0
    if move.promotion:
        promo = {chess.KNIGHT: 1, chess.BISHOP: 2, chess.ROOK: 3, chess.QUEEN: 4}[move.promotion]
    return (
        chess.square_file(to_square)
        | (chess.square_rank(to_square) << 3)
        | (chess.square_file(move.from_square) << 6)
        | (chess.square_rank(move.from_square) << 9)
        | (promo << 12)
    )


def count_games(
    handles: Iterable[IO[str]], args: argparse.Namespace
) -> tuple[dict[int, Counter], int, int]:
    counts: dict[int, Counter] = defaultdict(Counter)
    seen = kept = 0
    started = time.time()
    for fh in handles:
        for headers, movetext in games(fh):
            seen += 1
            if args.max_games and kept >= args.max_games:
                break
            if not wanted(headers, args):
                continue
            board = chess.Board()
            for token in san_tokens(movetext, args.max_ply):
                try:
                    move = board.parse_san(token)
                except ValueError:
                    break
                key = chess.polyglot.zobrist_hash(board)
                counts[key][encode_move(board, move)] += 1
                board.push(move)
            kept += 1
            if kept % 10000 == 0:
                print(f"  {kept} games kept / {seen} seen ({time.time() - started:.0f}s)", file=sys.stderr)
    return counts, seen, kept


def build_entries(counts: dict[int, Counter], min_count: int) -> list[tuple[int, int, int]]:
    entries: list[tuple[int, int, int]] = []
    for key, moves in counts.items():
        kept = [(m, n) for m, n in moves.items() if n >= min_count]
        if not kept:
            continue
        top = max(n for _, n in kept)
        scale = MAX_WEIGHT / top if top > MAX_WEIGHT else 1.0
        for m, n in kept:
            entries.append((key, m, max(1, int(n * scale))))
    entries.sort()
    return entries


def write_book(entries: list[tuple[int, int, int]], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as out:
        for key, move, weight in entries:
            out.write(ENTRY.pack(key, move, weight, 0))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", type=Path, action="append", required=True, help="PGN (.pgn/.pgn.zst/.zip); repeatable")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--min-elo", type=int, default=1200, help="both players at least this rating")
    parser.add_argument("--max-elo", type=int, default=10_000, help="both players at most this rating")
    parser.add_argument("--max-ply", type=int, default=30, help="plies of each game to count (§7.3: book play ends at ply 30)")
    parser.add_argument("--min-count", type=int, default=30, help="minimum games per (position, move)")
    parser.add_argument("--max-bytes", type=int, default=3 * 1024 * 1024, help="raise --min-count until the book fits")
    parser.add_argument("--max-games", type=int, default=0, help="stop after this many kept games (0 = all)")
    parser.add_argument("--keep-bullet", action="store_true")
    args = parser.parse_args()

    counts, seen, kept = count_games(open_inputs(args.input), args)
    print(f"{kept} games kept of {seen} read; {len(counts)} positions", file=sys.stderr)
    min_count = args.min_count
    while True:
        entries = build_entries(counts, min_count)
        size = len(entries) * ENTRY.size
        if size <= args.max_bytes or not entries:
            break
        min_count = int(min_count * 1.25) + 1
    write_book(entries, args.output)
    print(f"wrote {args.output} ({len(entries)} entries, {size} bytes, min-count {min_count})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

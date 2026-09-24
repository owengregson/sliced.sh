#!/usr/bin/env python3
"""
scripts/build-club-book.py — build a Polyglot opening book from Lichess PGN (Task 15, §7.3).

The bundled game books (`assets/books/club.bin`, `assets/books/gm2600.bin`) are generated from the
CC0 Lichess open database (https://database.lichess.org/ — rated games and OTB broadcasts) and
the Lichess Elite Database (https://database.nikonoel.fr/, a subset of it). Games are filtered by
the rating of BOTH players, the first `--max-ply` plies of every game are counted, and a
(position, move) pair becomes one 16-byte entry `{key, move, weight, learn}` when

  - the move was played at least `--min-count` times from the position,
  - the position itself was reached at least `--min-position` times, and
  - the move is at least `--min-share` of the games from the position

(the last two keep one-off tries and traps from a popular position out: a Bxf7+ seen 22 times from
a position reached 5 000 times is not theory). `weight` is the move's frequency scaled to fit 16
bits per position; `learn` is 0. Keys are the standard Polyglot Zobrist hash
(`chess.polyglot.zobrist_hash`), castling is encoded king-takes-rook as the format requires, and
entries are written sorted by key (the format and manifest I/O are `scripts/polyglot_book.py`).
Next to the book a `<book>.build.json` manifest records the inputs (with their SHA-256), flags,
game counts and the book's SHA-256; `scripts/vendor-engine.ts` renders `docs/third-party.md` from
those manifests.

Scale (2026-09-15): tens of millions of games do not fit a Python dict of counters, so counting is
external. `--jobs` worker processes replay games and append raw `(key, move)` records to one of
`BUCKETS` files chosen by the key's top bits; each bucket is then counted on its own with numpy
(sort + unique), so memory is bounded by one bucket. Each `--input` file is one task; a single
large input (a Lichess month) is additionally split into batches of games by the reader.

The exact invocations of the shipped books are recorded in their manifests and rendered into
`docs/third-party.md`. Inputs may be `.pgn`, `.pgn.zst` (a truncated download is read up to the
last complete game) or a `.zip` holding `.pgn` files. Bullet games are dropped unless
`--keep-bullet`; games without both ratings are dropped unless `--allow-unrated` (OTB broadcasts of
master events usually carry FIDE ratings). Requires python-chess, zstandard and numpy:

    uv run --with chess --with zstandard --with numpy scripts/build-club-book.py ...

After building, re-run `bun run vendor:engine` to refresh `docs/third-party.md`.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterator

import chess
import chess.polyglot
from pgn_games import games, open_input, san_tokens, wanted
from polyglot_book import ENTRY, MAX_WEIGHT, encode_move, sha256_file, write_manifest

BUCKET_BITS = 6
BUCKETS = 1 << BUCKET_BITS
FLUSH_RECORDS = 2_000_000
BATCH_GAMES = 5_000


# ── counting ─────────────────────────────────────────────────────────────────


class RecordWriter:
    """Buffers (key, move) records and appends them to the worker's own bucket files."""

    def __init__(self, tmp: Path, worker: str):
        self.tmp = tmp
        self.worker = worker
        self.keys: list[int] = []
        self.moves: list[int] = []

    def add(self, key: int, move: int) -> None:
        self.keys.append(key)
        self.moves.append(move)
        if len(self.keys) >= FLUSH_RECORDS:
            self.flush()

    def flush(self) -> None:
        import numpy as np

        if not self.keys:
            return
        keys = np.array(self.keys, dtype=np.uint64)
        moves = np.array(self.moves, dtype=np.uint16)
        self.keys, self.moves = [], []
        buckets = (keys >> np.uint64(64 - BUCKET_BITS)).astype(np.int64)
        order = np.argsort(buckets, kind="stable")
        keys, moves, buckets = keys[order], moves[order], buckets[order]
        bounds = np.searchsorted(buckets, np.arange(BUCKETS + 1))
        for bucket in range(BUCKETS):
            lo, hi = bounds[bucket], bounds[bucket + 1]
            if lo == hi:
                continue
            records = np.empty(hi - lo, dtype=[("k", "<u8"), ("m", "<u2")])
            records["k"] = keys[lo:hi]
            records["m"] = moves[lo:hi]
            with (self.tmp / f"{bucket:02d}.{self.worker}.bin").open("ab") as out:
                records.tofile(out)


def replay(movetexts: list[str], max_ply: int, writer: RecordWriter) -> None:
    for movetext in movetexts:
        board = chess.Board()
        for token in san_tokens(movetext, max_ply):
            try:
                move = board.parse_san(token)
            except ValueError:
                break
            writer.add(chess.polyglot.zobrist_hash(board), encode_move(board, move))
            board.push(move)


def file_task(task: tuple[str, str, dict]) -> tuple[int, int]:
    """Worker: read one input file whole, filter, replay, write records. Returns (read, kept)."""
    path, tmp, flt = task
    writer = RecordWriter(Path(tmp), f"f{os.getpid()}-{abs(hash(path)) % 10**8}")
    read = kept = 0
    batch: list[str] = []
    for fh in open_input(Path(path)):
        for headers, movetext in games(fh):
            read += 1
            if not wanted(headers, flt):
                continue
            kept += 1
            batch.append(movetext)
            if len(batch) >= BATCH_GAMES:
                replay(batch, flt["max_ply"], writer)
                batch = []
    replay(batch, flt["max_ply"], writer)
    writer.flush()
    return read, kept


_worker_writer: RecordWriter | None = None


def batch_task(task: tuple[list[str], str, int]) -> int:
    """Worker: replay a batch of already-filtered games from a large input."""
    global _worker_writer
    movetexts, tmp, max_ply = task
    if _worker_writer is None:
        _worker_writer = RecordWriter(Path(tmp), f"b{os.getpid()}")
    replay(movetexts, max_ply, _worker_writer)
    _worker_writer.flush()
    return len(movetexts)


def count_bucket(task: tuple[str, int, int]) -> tuple[bytes, bytes, bytes, int]:
    """Aggregate one bucket: sorted unique (key, move) with counts, pruned below `floor`."""
    import numpy as np

    tmp, bucket, floor = task
    parts = [np.fromfile(p, dtype=[("k", "<u8"), ("m", "<u2")]) for p in sorted(Path(tmp).glob(f"{bucket:02d}.*.bin"))]
    if not parts:
        return b"", b"", b"", 0
    records = np.concatenate(parts)
    records.sort(order=["k", "m"], kind="stable")
    change = np.empty(len(records), dtype=bool)
    change[0] = True
    change[1:] = (records["k"][1:] != records["k"][:-1]) | (records["m"][1:] != records["m"][:-1])
    starts = np.flatnonzero(change)
    counts = np.diff(np.append(starts, len(records))).astype(np.uint64)
    keys = records["k"][starts]
    moves = records["m"][starts]
    positions = len(np.unique(keys))
    # Position totals need every move, so they are computed before pruning single moves.
    key_change = np.empty(len(keys), dtype=bool)
    key_change[0] = True
    key_change[1:] = keys[1:] != keys[:-1]
    key_ids = np.cumsum(key_change) - 1
    totals = np.bincount(key_ids, weights=counts).astype(np.uint64)[key_ids]
    keep = counts >= floor
    return (
        keys[keep].tobytes(),
        moves[keep].tobytes(),
        np.stack([counts[keep], totals[keep]]).tobytes(),
        positions,
    )


def build_entries(keys, moves, counts, totals, min_count: int, min_position: int, min_share: float):
    """Entries `(key, move, weight)` passing the three thresholds, sorted by key then move."""
    import numpy as np

    keep = (counts >= min_count) & (totals >= min_position) & (counts >= min_share * totals)
    k, m, c = keys[keep], moves[keep], counts[keep]
    if len(k) == 0:
        return k, m, c.astype(np.uint16)
    order = np.lexsort((m, k))
    k, m, c = k[order], m[order], c[order]
    key_change = np.empty(len(k), dtype=bool)
    key_change[0] = True
    key_change[1:] = k[1:] != k[:-1]
    ids = np.cumsum(key_change) - 1
    top = np.maximum.reduceat(c, np.flatnonzero(key_change))[ids]
    scaled = np.where(top > MAX_WEIGHT, np.floor(c * (MAX_WEIGHT / top.astype(np.float64))), c)
    weights = np.maximum(scaled, 1).astype(np.uint16)
    return k, m, weights


def write_book(k, m, w, output: Path) -> None:
    import numpy as np

    output.parent.mkdir(parents=True, exist_ok=True)
    entries = np.zeros(len(k), dtype=[("k", ">u8"), ("m", ">u2"), ("w", ">u2"), ("l", ">u4")])
    entries["k"], entries["m"], entries["w"] = k, m, w
    entries.tofile(output)


def count_inputs(args: argparse.Namespace, flt: dict, started: float):
    """Read, replay and count every input: `(keys, moves, counts, totals, read, kept, positions)`."""
    import threading

    import numpy as np

    tmp = Path(tempfile.mkdtemp(prefix="book-", dir=args.tmp))
    seen = kept = 0
    try:
        with mp.get_context("spawn").Pool(args.jobs) as pool:
            if len(args.input) > 1:
                tasks = [(str(p), str(tmp), flt) for p in args.input]
                for done, (r, k) in enumerate(pool.imap_unordered(file_task, tasks), 1):
                    seen += r
                    kept += k
                    print(f"  {done}/{len(tasks)} inputs · {kept:,} games kept / {seen:,} read ({time.time() - started:.0f}s)", file=sys.stderr)
            else:
                # One large input: this process filters and feeds batches of games to the workers,
                # holding at most two batches per worker in flight (the pool's feeder would otherwise
                # read the whole input into its queue).
                in_flight = threading.BoundedSemaphore(2 * args.jobs)

                def batches() -> Iterator[tuple[list[str], str, int]]:
                    nonlocal seen, kept
                    batch: list[str] = []
                    for fh in open_input(args.input[0]):
                        for headers, movetext in games(fh):
                            if args.max_games and kept >= args.max_games:
                                break
                            seen += 1
                            if not wanted(headers, flt):
                                continue
                            kept += 1
                            batch.append(movetext)
                            if len(batch) >= BATCH_GAMES:
                                in_flight.acquire()
                                yield batch, str(tmp), args.max_ply
                                batch = []
                    if batch:
                        in_flight.acquire()
                        yield batch, str(tmp), args.max_ply

                for done, _ in enumerate(pool.imap_unordered(batch_task, batches()), 1):
                    in_flight.release()
                    if done % 100 == 0:
                        print(f"  {kept:,} games kept / {seen:,} read ({time.time() - started:.0f}s)", file=sys.stderr)
            print(f"counting {BUCKETS} buckets ({time.time() - started:.0f}s)", file=sys.stderr)
            floor = max(1, min(args.min_count, 2))
            results = pool.map(count_bucket, [(str(tmp), b, floor) for b in range(BUCKETS)])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    keys = np.concatenate([np.frombuffer(r[0], dtype=np.uint64) for r in results])
    moves = np.concatenate([np.frombuffer(r[1], dtype=np.uint16) for r in results])
    pairs = [np.frombuffer(r[2], dtype=np.uint64).reshape(2, -1) for r in results]
    counts = np.concatenate([p[0] for p in pairs])
    totals = np.concatenate([p[1] for p in pairs])
    positions = sum(r[3] for r in results)
    return keys, moves, counts, totals, seen, kept, positions


def main() -> int:
    import numpy as np

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", type=Path, action="append", required=True, help="PGN (.pgn/.pgn.zst/.zip); repeatable")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--min-elo", type=int, default=1200, help="both players at least this rating")
    parser.add_argument("--max-elo", type=int, default=10_000, help="both players at most this rating")
    parser.add_argument("--max-ply", type=int, default=30, help="plies of each game to count")
    parser.add_argument("--min-count", type=int, default=30, help="minimum games per (position, move)")
    parser.add_argument("--min-position", type=int, default=0, help="minimum games reaching the position")
    parser.add_argument("--min-share", type=float, default=0.0, help="minimum share of the position's games")
    parser.add_argument("--max-bytes", type=int, default=3 * 1024 * 1024, help="raise --min-count until the book fits")
    parser.add_argument("--max-games", type=int, default=0, help="stop reading a batched input after this many kept games (0 = all)")
    parser.add_argument("--keep-bullet", action="store_true")
    parser.add_argument("--allow-unrated", action="store_true", help="keep games missing a rating header")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    parser.add_argument("--tmp", type=Path, default=None, help="scratch directory for bucket files")
    parser.add_argument("--save-counts", type=Path, default=None, help="also save the counted (position, move) table (.npz)")
    parser.add_argument("--from-counts", type=Path, default=None, help="skip reading: build from a --save-counts table of the same inputs and filters")
    args = parser.parse_args()

    flt = {
        "min_elo": args.min_elo,
        "max_elo": args.max_elo,
        "max_ply": args.max_ply,
        "keep_bullet": args.keep_bullet,
        "allow_unrated": args.allow_unrated,
    }
    started = time.time()
    if args.from_counts:
        table = np.load(args.from_counts)
        keys, moves, counts, totals = table["keys"], table["moves"], table["counts"], table["totals"]
        meta = json.loads(str(table["meta"]))
        if meta["inputs"] != [p.name for p in args.input] or meta["filters"] != flt:
            raise SystemExit(f"{args.from_counts}: counted from other inputs or filters: {meta}")
        seen, kept, positions = meta["games_read"], meta["games_kept"], meta["positions"]
    else:
        keys, moves, counts, totals, seen, kept, positions = count_inputs(args, flt, started)
        if args.save_counts:
            meta = {"inputs": [p.name for p in args.input], "filters": flt, "games_read": seen, "games_kept": kept, "positions": positions}
            np.savez(args.save_counts, keys=keys, moves=moves, counts=counts, totals=totals, meta=json.dumps(meta))
    print(f"{kept:,} games kept of {seen:,} read; {positions:,} positions ({time.time() - started:.0f}s)", file=sys.stderr)

    min_count = args.min_count
    while True:
        k, m, w = build_entries(keys, moves, counts, totals, min_count, args.min_position, args.min_share)
        size = len(k) * ENTRY.size
        if size <= args.max_bytes or len(k) == 0:
            break
        min_count = int(min_count * 1.25) + 1
    write_book(k, m, w, args.output)
    manifest = {
        "book": args.output.name,
        "script": "scripts/build-club-book.py",
        "inputs": [p.name for p in args.input],
        "input_sha256": {p.name: sha256_file(p) for p in args.input},
        "filters": {
            "min_elo": args.min_elo,
            "max_elo": args.max_elo if args.max_elo < 10_000 else None,
            "max_ply": args.max_ply,
            "min_count_requested": args.min_count,
            "min_count": min_count,
            "min_position": args.min_position,
            "min_share": args.min_share,
            "max_bytes": args.max_bytes,
            "max_games": args.max_games,
            "keep_bullet": args.keep_bullet,
            "allow_unrated": args.allow_unrated,
        },
        "games_read": seen,
        "games_kept": kept,
        "positions": positions,
        "entries": int(len(k)),
        "bytes": size,
        "sha256": sha256_file(args.output),
    }
    manifest_path = write_manifest(args.output, manifest)
    print(f"wrote {args.output} ({len(k):,} entries, {size:,} bytes, min-count {min_count}) in {time.time() - started:.0f}s", file=sys.stderr)
    print(f"wrote {manifest_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

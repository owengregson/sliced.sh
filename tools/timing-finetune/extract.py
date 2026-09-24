#!/usr/bin/env python3
"""chess.com games (StoredGame JSONL with [%clk]) → ChessMimic training/evaluation examples.

One example per move that has a clock comment, encoded exactly as the extension encodes the
inference inputs for that position (`cmenc.py`; parity: `test_parity.py`):

  ids        uint16 [N, 90]  12 history-move tokens (moves before the position) + 78 FEN tokens
  cur        uint16 [N]      the played move's token (PAD if outside the vocabulary)
  rating     float32         the mover's chess.com rating
  pclock     float32         mover's clock before the move (s)   = inference `playerClockS`
  oclock     float32         opponent's clock at that moment (s) = inference `opponentClockS`
  inc        float32         increment (s)
  think      float32         prev_clock + increment − clock (s), clamped at 0 (upstream's label)
  ply, game, player (int32 ids into the sidecar), tc (0 bullet/1 blitz/2 rapid), split (0 fit / 1 holdout),
  book (1 inside chess.com's named opening line, 0 after it, −1 unknown depth),
  recap (the move captures on the square the opponent just captured on), legal (legal-move count),
  kept (the crawl's per-player side cap kept this side: `whiteKept`/`blackKept`, 1 when absent).

Games with a non-standard start, daily games, or an impossible clock increase (upstream's
`isValidClockIncrease`) are skipped whole. Unparsable JSON lines (a crawl still being appended
to) are skipped.

Usage: extract.py --games <games.jsonl> --out <dir> [--min-rating 0] [--workers 4]

The PGN reading is `ftlib/pgn.py` and the per-move encoding `ftlib/rows.py`; this file streams a
games file through them in worker processes and writes the columns.
"""
from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cmenc  # noqa: E402
from ftlib.rows import game_rows  # noqa: E402


def work(args):
    lines, min_rating = args
    out = []
    for line in lines:
        r = game_rows(line, min_rating)
        if r is not None and r[2]:
            g, tc, rows = r
            out.append((g["uuid"], g.get("end_time", 0), tc, rows))
    return out


def chunks(path: Path, size: int, limit: int | None):
    buf = []
    n = 0
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if not line.endswith("\n"):
                break  # partial last line of a growing file
            buf.append(line)
            n += 1
            if len(buf) >= size:
                yield buf
                buf = []
            if limit and n >= limit:
                break
    if buf:
        yield buf


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-rating", type=float, default=0)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--kept-only", action="store_true", help="drop sides the crawl did not keep")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    keys = ("ids", "cur", "rating", "pclock", "oclock", "inc", "think", "ply", "game", "player", "tc", "split", "book", "recap", "legal", "kept")
    dtypes = {"ids": np.uint16, "cur": np.uint16, "rating": np.float32, "pclock": np.float32, "oclock": np.float32, "inc": np.float32, "think": np.float32,
              "ply": np.int16, "game": np.int32, "player": np.int32, "tc": np.int8, "split": np.int8, "book": np.int8, "recap": np.int8, "legal": np.int16, "kept": np.int8}
    # Stream every column to a raw file as chunks arrive; wrap them as .npy at the end
    # (loaders memory-map them), so RAM stays bounded whatever the crawl's size.
    raw_dir = out / "examples.tmp"
    raw_dir.mkdir(exist_ok=True)
    raw = {k: open(raw_dir / f"{k}.bin", "wb") for k in keys}
    games: list[dict] = []
    players: dict[str, int] = {}
    split_of: dict[str, int] = {}
    seen: set[str] = set()
    total = 0
    with mp.Pool(args.workers) as pool:
        for result in pool.imap(work, ((c, args.min_rating) for c in chunks(Path(args.games), 500, args.limit))):
            cols = {k: [] for k in keys}
            for uuid, end_time, tc, rows in result:
                if uuid in seen:
                    continue
                seen.add(uuid)
                gi = len(games)
                games.append({"uuid": uuid, "end_time": end_time})
                for ids, cur, rating, pc, oc, inc, think, ply, user, book, recap, legal, kept in rows:
                    if args.kept_only and not kept:
                        continue
                    key = user.lower()
                    pid = players.setdefault(key, len(players))
                    if key not in split_of:
                        split_of[key] = 0 if cmenc.split_for(key) == "fit" else 1
                    for k, v in zip(keys, (ids, cur, rating, pc, oc, inc, think, ply, gi, pid, tc, split_of[key], book, recap, legal, kept)):
                        cols[k].append(v)
            for k in keys:
                raw[k].write(np.asarray(cols[k], dtype=dtypes[k]).tobytes())
            total += len(cols["ply"])
            print(f"\r{len(games):,} games, {total:,} rows", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)
    for f in raw.values():
        f.close()
    exdir = out / "examples"
    exdir.mkdir(exist_ok=True)
    for k in keys:
        shape = (total, 90) if k == "ids" else (total,)
        src = np.memmap(raw_dir / f"{k}.bin", dtype=dtypes[k], mode="r", shape=shape) if total else np.zeros(shape, dtypes[k])
        dst = np.lib.format.open_memmap(exdir / f"{k}.npy", mode="w+", dtype=dtypes[k], shape=shape)
        for i in range(0, total, 1 << 20):
            dst[i : i + (1 << 20)] = src[i : i + (1 << 20)]
        dst.flush()
        del src, dst
        (raw_dir / f"{k}.bin").unlink()
    raw_dir.rmdir()
    arrays = {"ply": np.load(exdir / "ply.npy", mmap_mode="r")}
    names = sorted(players, key=players.get)
    (out / "players.json").write_text(json.dumps(names))
    (out / "games.json").write_text(json.dumps(games))
    print(f"wrote {out}: {len(games):,} games, {len(arrays['ply']):,} rows, {len(names):,} players")
    return 0


if __name__ == "__main__":
    sys.exit(main())

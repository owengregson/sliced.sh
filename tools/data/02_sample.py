#!/usr/bin/env python3
"""02_sample.py — stratified reservoir sample of Lichess games (Appendix D §3b.2).

Streams `.pgn.zst` dumps without a full PGN parser: keeps a game when
  * TimeControl ∈ the target set (60+0, 120+1, 180+0, 180+2, 300+0, 300+3, 600+0, 600+5, 900+10),
  * both Elo in [700, 2700], Event does not contain "Arena" (berserk halves clocks),
  * every move carries a [%clk] comment, and the game has ≥ 20 plies;
then reservoir-samples `--per-cell` games per (rating bucket of the modelled side × tc_class)
and writes compact JSONL: {"id", "tc", "white_elo", "black_elo", "side", "moves": [san...], "clks": [sec...]}.

Requires: zstandard.
"""
from __future__ import annotations

import argparse
import io
import json
import random
import re
import sys

TARGET_TC = {"60+0", "120+1", "180+0", "180+2", "300+0", "300+3", "600+0", "600+5", "900+10"}
RATING_BUCKETS = [(700, 1000), (1000, 1200), (1200, 1400), (1400, 1600), (1600, 1800), (1800, 2000), (2000, 2300), (2300, 2700)]
INC_WEIGHT = 40
CLK_RE = re.compile(r"\[%clk (\d+):(\d\d):(\d\d)\]")
MOVE_RE = re.compile(r"(?:\d+\.{1,3}\s*)?([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|O-O(?:-O)?[+#]?)\s*\{\s*\[%clk ([^\]]+)\]\s*\}")


def tc_class(base: int, inc: int) -> str:
    eff = base + INC_WEIGHT * inc
    if eff < 180:
        return "bullet"
    if eff < 480:
        return "blitz"
    if eff < 1500:
        return "rapid"
    return "classical"


def rating_bucket(elo: int) -> int | None:
    for i, (lo, hi) in enumerate(RATING_BUCKETS):
        if lo <= elo < hi:
            return i
    return None


def clk_seconds(s: str) -> float:
    h, m, rest = s.split(":")
    return int(h) * 3600 + int(m) * 60 + float(rest)


def iter_games(stream: io.TextIOBase):
    headers: dict[str, str] = {}
    moves: list[str] = []
    for line in stream:
        line = line.rstrip("\n")
        if line.startswith("["):
            m = re.match(r'\[(\w+) "(.*)"\]', line)
            if m:
                headers[m.group(1)] = m.group(2)
        elif line.strip():
            moves.append(line)
        elif moves:
            yield headers, " ".join(moves)
            headers, moves = {}, []
    if moves:
        yield headers, " ".join(moves)


def parse_game(headers: dict[str, str], text: str):
    tc = headers.get("TimeControl", "")
    if tc not in TARGET_TC or "Arena" in headers.get("Event", ""):
        return None
    try:
        we, be = int(headers.get("WhiteElo", "")), int(headers.get("BlackElo", ""))
    except ValueError:
        return None
    if not (700 <= we <= 2700 and 700 <= be <= 2700):
        return None
    if "%clk" not in text:
        return None
    sans, clks = [], []
    for m in MOVE_RE.finditer(text):
        sans.append(m.group(1))
        clks.append(clk_seconds(m.group(2)))
    if len(sans) < 20:
        return None
    return {"id": headers.get("Site", "").rsplit("/", 1)[-1], "tc": tc, "white_elo": we, "black_elo": be,
            "termination": headers.get("Termination", ""), "moves": sans, "clks": clks}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help=".pgn.zst files from 01_download.sh")
    ap.add_argument("--out", default="data/sample.jsonl")
    ap.add_argument("--per-cell", type=int, default=60_000, help="games per (rating bucket × tc_class)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--limit", type=int, default=0, help="stop after this many accepted games (debug)")
    args = ap.parse_args()

    try:
        import zstandard  # type: ignore
    except ImportError:
        print("pip install zstandard", file=sys.stderr)
        return 2

    rng = random.Random(args.seed)
    reservoirs: dict[tuple[int, str], list[dict]] = {}
    seen: dict[tuple[int, str], int] = {}
    accepted = 0
    for path in args.inputs:
        with open(path, "rb") as fh:
            reader = zstandard.ZstdDecompressor().stream_reader(fh)
            text = io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
            for headers, body in iter_games(text):
                game = parse_game(headers, body)
                if game is None:
                    continue
                base, inc = (int(x) for x in game["tc"].split("+"))
                cls = tc_class(base, inc)
                # Model both sides: each side is a separate row keyed by its own rating bucket.
                for side, elo in (("w", game["white_elo"]), ("b", game["black_elo"])):
                    rb = rating_bucket(elo)
                    if rb is None:
                        continue
                    key = (rb, cls)
                    seen[key] = seen.get(key, 0) + 1
                    row = dict(game, side=side)
                    res = reservoirs.setdefault(key, [])
                    if len(res) < args.per_cell:
                        res.append(row)
                    else:
                        j = rng.randrange(seen[key])
                        if j < args.per_cell:
                            res[j] = row
                accepted += 1
                if args.limit and accepted >= args.limit:
                    break
    with open(args.out, "w", encoding="utf-8") as out:
        for key in sorted(reservoirs):
            for row in reservoirs[key]:
                out.write(json.dumps(row, separators=(",", ":")) + "\n")
    for key in sorted(seen):
        print(f"{RATING_BUCKETS[key[0]]} {key[1]}: seen {seen[key]}, kept {len(reservoirs.get(key, []))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

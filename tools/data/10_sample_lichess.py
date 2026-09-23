#!/usr/bin/env python3
"""10_sample_lichess.py — the human move-match corpus (§8.1 step 1 of
docs/research/human-move-selection-ideas-2026-09-13.md; the job is specified in 10_human_match.md).

Streams Lichess `.pgn.zst` monthly dumps from database.lichess.org (downloaded by 01_download.sh
— nothing is downloaded here) and writes one JSONL row per **own move** of a sampled player, the
schema `tools/human-match/replay.ts` consumes:

    {"id": "<gameId>:<ply>", "gameId", "ply", "fen", "historyFens": [≤ 8 FENs oldest → newest, the
     last = fen], "selfElo", "oppoElo", "humanMove": "<uci>", "clockMs", "oppClockMs", "baseMs",
     "incrementMs", "lastMove": "<uci>|null", "prevOwnMove": "<uci>|null", "thinkMs", "tc",
     "bucket", "eval": <lichess %eval cp or null>}

Selection
  * months: pass only months **outside Maia-3's training window** — the feasibility study records
    the models as trained on 2023–2025 Lichess blitz, so 2026-01 onwards is held out; confirm the
    exact window against the upstream README at the pinned commit before trusting a month;
  * blitz and rapid (`Event` = "Rated Blitz game" / "Rated Rapid game"; tournaments and Arena are
    skipped — berserk halves clocks), both Elo present, every move carrying `[%clk]`, ≥ 20 plies;
  * one row stream per (game, side); a side is a candidate for bucket `b` when its rating is
    within --bucket-width of `b` (default ±100 around 1000 / 1300 / 1600 / 1900 / 2200 / 2500);
  * reservoir sampling of --games-per-bucket (game, side) pairs per bucket (seeded), then every
    own move of each kept pair becomes a row — so lag-1 autocorrelation and same-piece rates can
    be computed along real games. ≈ 35 own moves per game: 250 games ≈ 9 k positions per bucket,
    which is the §8.1 target of 5–10 k.

The first pass needs only `zstandard` (header/regex scan, no board). The second pass replays SAN
through `python-chess` for FENs and UCI; without it the script writes the sampled games as
`--games-out` JSONL (`{"id", "tc", "white_elo", "black_elo", "side", "moves": [san], "clks": [s],
"evals": [cp|null]}`) and tells you what is missing. Guarded imports; nothing else required.

    python3 tools/data/10_sample_lichess.py data/raw/lichess_db_standard_rated_2026-01.pgn.zst \
        --out data/human-match/corpus.jsonl --games-per-bucket 250 --seed 10
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys

from datalib.lichess import iter_games, open_pgn_zst, reservoir_add

BUCKETS = [1000, 1300, 1600, 1900, 2200, 2500]
EVENTS = {"Rated Blitz game": "blitz", "Rated Rapid game": "rapid"}
HISTORY = 8  # MAIA_INPUT.history
MIN_PLIES = 20
MOVE_RE = re.compile(
    r"(?:\d+\.{1,3}\s*)?"
    r"([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|O-O(?:-O)?[+#]?)"
    r"\s*\{([^}]*)\}"
)
CLK_RE = re.compile(r"\[%clk (\d+):(\d\d):(\d\d(?:\.\d+)?)\]")
EVAL_RE = re.compile(r"\[%eval (#?-?\d+(?:\.\d+)?)\]")


def clk_ms(text: str) -> int | None:
    m = CLK_RE.search(text)
    if not m:
        return None
    h, mnt, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
    return int(round((h * 3600 + mnt * 60 + s) * 1000))


def eval_cp(text: str) -> int | None:
    m = EVAL_RE.search(text)
    if not m:
        return None
    v = m.group(1)
    if v.startswith("#"):
        n = int(v[1:])
        return (1000 + 100 - abs(n)) * (1 if n > 0 else -1)  # cpEffective's mate mapping
    return int(round(float(v) * 100))


def bucket_for(elo: int, width: int) -> int | None:
    best = min(BUCKETS, key=lambda b: abs(b - elo))
    return best if abs(best - elo) <= width else None


def parse_game(headers: dict[str, str], text: str) -> dict | None:
    tc_class = EVENTS.get(headers.get("Event", ""))
    if tc_class is None:
        return None
    try:
        we, be = int(headers.get("WhiteElo", "")), int(headers.get("BlackElo", ""))
        base, inc = (int(x) for x in headers.get("TimeControl", "").split("+"))
    except ValueError:
        return None
    if "%clk" not in text:
        return None
    sans, clks, evals = [], [], []
    for m in MOVE_RE.finditer(text):
        clk = clk_ms(m.group(2))
        if clk is None:
            return None  # every move must carry a clock
        sans.append(m.group(1))
        clks.append(clk)
        evals.append(eval_cp(m.group(2)))
    if len(sans) < MIN_PLIES:
        return None
    return {
        "id": headers.get("Site", "").rsplit("/", 1)[-1],
        "tc": f"{base}+{inc}",
        "tc_class": tc_class,
        "base_ms": base * 1000,
        "inc_ms": inc * 1000,
        "white_elo": we,
        "black_elo": be,
        "moves": sans,
        "clks": clks,
        "evals": evals,
    }


def sample(inputs: list[str], games_per_bucket: int, width: int, seed: int, limit: int) -> dict[int, list[dict]]:
    try:
        import zstandard  # type: ignore
    except ImportError:
        print("missing dependency: zstandard (pip install zstandard)", file=sys.stderr)
        raise SystemExit(2)
    rng = random.Random(seed)
    reservoirs: dict[int, list[dict]] = {b: [] for b in BUCKETS}
    seen: dict[int, int] = {b: 0 for b in BUCKETS}
    accepted = 0
    for path in inputs:
        with open_pgn_zst(path, zstandard) as text:
            for headers, body in iter_games(text):
                game = parse_game(headers, body)
                if game is None:
                    continue
                for side, elo in (("w", game["white_elo"]), ("b", game["black_elo"])):
                    b = bucket_for(elo, width)
                    if b is None:
                        continue
                    seen[b] += 1
                    reservoir_add(reservoirs[b], seen[b], dict(game, side=side), games_per_bucket, rng)
                accepted += 1
                if limit and accepted >= limit:
                    break
    for b in BUCKETS:
        print(f"bucket {b}: seen {seen[b]} sides, kept {len(reservoirs[b])} games", file=sys.stderr)
    return reservoirs


def expand(reservoirs: dict[int, list[dict]], out):
    """Second pass: every own move of each sampled (game, side) as a corpus row (needs python-chess)."""
    import chess  # type: ignore

    n = 0
    for b in BUCKETS:
        for g in reservoirs[b]:
            board = chess.Board()
            fens = [board.fen()]
            own = g["side"]
            self_elo = g["white_elo"] if own == "w" else g["black_elo"]
            oppo_elo = g["black_elo"] if own == "w" else g["white_elo"]
            prev_own: str | None = None
            last: str | None = None
            for ply, san in enumerate(g["moves"]):
                try:
                    move = board.parse_san(san)
                except ValueError:
                    break
                mover = "w" if board.turn == chess.WHITE else "b"
                uci = move.uci()
                # Lichess does not run the clock on either side's first move (plies 0–1).
                if mover == own and ply >= 2:
                    clk_prev = g["clks"][ply - 2] if ply >= 2 else g["clks"][ply]
                    think = max(0, clk_prev - g["clks"][ply] + g["inc_ms"])
                    out.write(
                        json.dumps(
                            {
                                "id": f"{g['id']}:{ply}",
                                "gameId": g["id"],
                                "ply": ply,
                                "fen": board.fen(),
                                "historyFens": fens[-HISTORY:],
                                "selfElo": self_elo,
                                "oppoElo": oppo_elo,
                                "humanMove": uci,
                                "clockMs": clk_prev,
                                "oppClockMs": g["clks"][ply - 1],
                                "baseMs": g["base_ms"],
                                "incrementMs": g["inc_ms"],
                                "lastMove": last,
                                "prevOwnMove": prev_own,
                                "thinkMs": think,
                                "tc": g["tc"],
                                "bucket": b,
                                "eval": g["evals"][ply - 1] if ply >= 1 else None,
                            },
                            separators=(",", ":"),
                        )
                        + "\n"
                    )
                    n += 1
                if mover == own:
                    prev_own = uci
                last = uci
                board.push(move)
                fens.append(board.fen())
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help=".pgn.zst files from 01_download.sh (held-out months only)")
    ap.add_argument("--out", default="data/human-match/corpus.jsonl")
    ap.add_argument("--games-out", default=None, help="also write the sampled games as JSONL (the no-python-chess fallback)")
    ap.add_argument("--games-per-bucket", type=int, default=250, help="(game, side) pairs kept per bucket (≈ 35 rows each)")
    ap.add_argument("--bucket-width", type=int, default=100, help="a side qualifies for the nearest bucket within ± this")
    ap.add_argument("--seed", type=int, default=10)
    ap.add_argument("--limit", type=int, default=0, help="stop after this many accepted games (debug)")
    args = ap.parse_args()

    reservoirs = sample(args.inputs, args.games_per_bucket, args.bucket_width, args.seed, args.limit)
    if args.games_out:
        with open(args.games_out, "w", encoding="utf-8") as fh:
            for b in BUCKETS:
                for g in reservoirs[b]:
                    fh.write(json.dumps(dict(g, bucket=b), separators=(",", ":")) + "\n")
        print(f"wrote {args.games_out}", file=sys.stderr)
    try:
        import chess  # type: ignore  # noqa: F401
    except ImportError:
        print("python-chess is missing (pip install chess): the corpus rows need SAN → FEN/UCI; the sampled games are in --games-out", file=sys.stderr)
        return 0 if args.games_out else 2
    with open(args.out, "w", encoding="utf-8") as fh:
        n = expand(reservoirs, fh)
    print(f"wrote {args.out}: {n} rows", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

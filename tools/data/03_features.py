#!/usr/bin/env python3
"""03_features.py — per-ply think times and the Appendix D §2 features (§3b.2).

For every game row of 02_sample.py, replays the moves with python-chess and, for the
modelled side, computes
    think_i = clk_prev − clk_now + increment            (seconds; plies 0–1 dropped)
plus the features of Appendix D §2 from a Stockfish MultiPV-4 depth-10 search
(`--engine` path; without it the engine-dependent features are left null so the
clock-only checks of 06_eval.py still work). Output: JSONL rows (one per ply of the modelled
side) or Parquet when pyarrow is installed and `--out` ends in `.parquet`.

The feature definitions mirror `src/core/timing/features.ts`; keep the two in sync (the
conformance harness, Task 33, compares distributions, not point values).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from concurrent.futures import ProcessPoolExecutor

FEATURE_DEPTH = 10
MULTIPV = 4
MATE_CP, MATE_CP_PER_PLY = 2000, 10
N_REASONABLE_CP, DEC_SCALE, SWING_SCALE = 40, 25, 50


def elo_z(elo: float) -> float:
    return max(-1.0, min(1.0, (elo - 1650) / 850))


def score_cp(score) -> float:
    """POV score → cp with mates mapped to ±(2000 − 10·plies)."""
    if score.is_mate():
        m = score.mate()
        if m == 0:
            return -MATE_CP
        plies = 2 * m - 1 if m > 0 else -2 * m
        return math.copysign(max(0, MATE_CP - MATE_CP_PER_PLY * plies), m)
    return max(-MATE_CP, min(MATE_CP, score.score()))


def npm_of(board) -> int:
    import chess
    v = {chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}
    return sum(v[p] * (len(board.pieces(p, True)) + len(board.pieces(p, False))) for p in v)


def phase_of(board, ply: int) -> str:
    npm = npm_of(board)
    if npm >= 62:
        return "opening" if ply < 20 else "middlegame"
    return "endgame" if npm <= 26 else "middlegame"


def process_game(args):
    row, engine_path = args
    import chess
    engine = None
    if engine_path:
        import chess.engine
        engine = chess.engine.SimpleEngine.popen_uci(engine_path)
    base, inc = (int(x) for x in row["tc"].split("+"))
    side = chess.WHITE if row["side"] == "w" else chess.BLACK
    my_elo = row["white_elo"] if side == chess.WHITE else row["black_elo"]
    board = chess.Board()
    clks = {chess.WHITE: float(base), chess.BLACK: float(base)}
    opp_hist: list[float] = []
    out = []
    prev_move = None
    for ply, (san, clk) in enumerate(zip(row["moves"], row["clks"])):
        mover = board.turn
        try:
            move = board.parse_san(san)
        except ValueError:
            break
        think = clks[mover] - clk + inc
        if mover == side and ply >= 2 and 0 <= think <= min(clks[mover] + inc, 600):
            feat = {"game": row["id"], "ply": ply, "elo": my_elo, "elo_z": elo_z(my_elo), "tc": row["tc"],
                    "base": base, "inc": inc, "clock_s": clks[mover], "opp_clock_s": clks[not mover],
                    "pressure": max(0.0, min(1.0, clks[mover] / (base + 40 * inc))),
                    "phase": phase_of(board, ply), "n_legal": board.legal_moves.count(),
                    "is_capture": int(board.is_capture(move)),
                    "is_recapture": int(board.is_capture(move) and prev_move is not None and prev_move.to_square == move.to_square),
                    "is_check": int(board.gives_check(move)), "is_promotion": int(move.promotion is not None),
                    "is_castle": int(board.is_castling(move)), "is_only_legal": int(board.legal_moves.count() == 1),
                    "opp_last": math.log(opp_hist[-1] + 0.2) if opp_hist else None,
                    "think": think}
            if engine is not None:
                info = engine.analyse(board, chess.engine.Limit(depth=FEATURE_DEPTH), multipv=MULTIPV)
                lines = [(i["pv"][0], score_cp(i["score"].pov(mover))) for i in info if "pv" in i]
                if lines:
                    best = lines[0][1]
                    second = lines[1][1] if len(lines) > 1 else best
                    chosen = next((cp for mv, cp in lines if mv == move), None)
                    feat.update({
                        "n_reasonable": max(1, sum(1 for _, cp in lines if best - cp <= N_REASONABLE_CP)),
                        "decisiveness": math.log(1 + abs(best - second) / DEC_SCALE),
                        "chosen_rank": next((i for i, (mv, _) in enumerate(lines) if mv == move), len(lines)),
                        "chosen_gap": math.log(1 + max(0.0, best - (chosen if chosen is not None else min(cp for _, cp in lines))) / DEC_SCALE),
                        "eval_cp": chosen if chosen is not None else min(cp for _, cp in lines),
                        "in_book": int(ply < 16 and lines[0][0] == move),
                    })
            out.append(feat)
        if mover != side and ply >= 2:
            opp_hist.append(max(0.0, think))
        clks[mover] = clk
        board.push(move)
        prev_move = move
    if engine is not None:
        engine.quit()
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sample", help="JSONL from 02_sample.py")
    ap.add_argument("--out", default="data/features.jsonl")
    ap.add_argument("--engine", default="", help="Stockfish binary (optional; enables engine features)")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    try:
        import chess  # noqa: F401
    except ImportError:
        print("pip install python-chess", file=sys.stderr)
        return 2
    with open(args.sample, encoding="utf-8") as fh:
        rows = [json.loads(line) for line in fh]
    if args.limit:
        rows = rows[: args.limit]
    tasks = [(row, args.engine) for row in rows]
    n = 0
    with ProcessPoolExecutor(max_workers=args.workers) as pool, open(args.out, "w", encoding="utf-8") as out:
        for feats in pool.map(process_game, tasks, chunksize=16):
            for f in feats:
                out.write(json.dumps(f, separators=(",", ":")) + "\n")
                n += 1
    print(f"{n} plies → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Parity of the fine-tune extractor with (a) the shipped reference fixture, (b) the pinned
upstream tokenizer and (c) the TypeScript encoder on real chess.com positions.

    tools/data/.venv/bin/python tools/timing-finetune/test_parity.py [--games <games.jsonl>] [--n 3000]

Exits non-zero on any mismatch. Model inputs are compared as the float32 the ONNX session
receives (byte for byte); the float64 difference is reported alongside.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import chess
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cmenc  # noqa: E402
import extract  # noqa: E402
import model as M  # noqa: E402

MAIN = Path("/Users/owengregson/Documents/sliced.sh")
UPSTREAM = MAIN / "tools" / "data" / "upstream" / "1e4_ai" / "Training" / "tokenizer.py"
FIXTURE = cmenc.ROOT / "test" / "fixtures" / "chessmimic-reference.json"
BANDS = ["0_1000", "1200_1300", "1500_1600", "1800_1900", "2000_2100", "2200_3500"]


def f32(x) -> bytes:
    return np.asarray(x, dtype=np.float32).tobytes()


def check_fixture(scalers: dict) -> int:
    fx = json.loads(FIXTURE.read_text())
    bad = 0
    worst = 0.0
    for r in fx["positions"]:
        band = cmenc.select_band(r["rating"], BANDS, scalers)
        sr, cf = cmenc.standardise(r["rating"], r["playerClockS"], r["opponentClockS"], r["incrementS"], r["band"], scalers[r["band"]])
        ok = (
            band == r["band"]
            and cmenc.tokenize_fen(r["fen"]) == r["fenTokens"]
            and cmenc.encode_recent_moves(r["moves"]) == r["moveTokens"]
            and f32(sr) == f32(r["scaledRating"])
            and f32(cf) == f32(r["clockFeatures"])
        )
        worst = max(worst, abs(float(sr) - r["scaledRating"]), float(np.abs(cf - np.array(r["clockFeatures"])).max()))
        bad += not ok
    print(f"(a) fixture: {len(fx['positions'])} positions, {bad} mismatches, max float64 |Δ| {worst:.1e}")
    return bad


def load_upstream():
    spec = importlib.util.spec_from_file_location("cm_upstream_tok", UPSTREAM)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def sample_positions(games: Path, n: int, seed: int) -> list[dict]:
    lines = [l for l in games.read_text().splitlines() if l.strip()]
    rng = random.Random(seed)
    rng.shuffle(lines)
    out: list[dict] = []
    for line in lines:
        r = extract.game_rows(line, 0, keep_text=True)
        if r is None:
            continue
        g, tc, rows = r
        base = extract.parse_time_control(g["time_control"])[0]
        for row in rng.sample(rows, min(4, len(rows))):
            ids, cur, rating, pc, oc, inc, think, ply, user, book, recap, legal, kept, fen, history, uci = row
            out.append({"fen": fen, "moves": history, "rating": rating, "playerClockS": pc, "opponentClockS": oc, "incrementS": inc, "baseSec": base, "ids": ids, "uci": uci})
        if len(out) >= n:
            break
    return out[:n]


def check_upstream(tok, rows: list[dict]) -> int:
    bad = 0
    for r in rows:
        up = [int(t) for t in tok.tokenize(r["fen"])]
        window = r["moves"][-12:]
        up_moves = [int(tok.PAD_TOKEN)] * (12 - len(window)) + [tok.MOVE_TO_ACTION[m] for m in window]
        bad += up != cmenc.tokenize_fen(r["fen"]) or up_moves != cmenc.encode_recent_moves(r["moves"])
    # The vocabulary itself, entry by entry.
    vocab_ok = [tok.ACTION_TO_MOVE[i] for i in range(tok.NUM_ACTIONS)] == cmenc.MOVE_VOCABULARY
    print(f"(b) upstream tokenizer: {len(rows)} real positions, {bad} mismatches; move vocabulary identical: {vocab_ok}")
    return bad + (not vocab_ok)


def check_ts(rows: list[dict], scalers: dict) -> int:
    with tempfile.TemporaryDirectory() as d:
        src, dst = Path(d) / "in.jsonl", Path(d) / "out.jsonl"
        # Every other row is timed with its move in the window (the upstream contract).
        src.write_text("".join(json.dumps({k: v for k, v in r.items() if k not in ("ids", "uci")} | ({"move": r["uci"]} if i % 2 else {})) + "\n" for i, r in enumerate(rows)))
        subprocess.run(["bun", str(HERE / "dump-ts-inputs.ts"), str(src), str(dst)], cwd=cmenc.ROOT, check=True)
        ts = [json.loads(l) for l in dst.read_text().splitlines() if l.strip()]
    bad = 0
    worst = 0.0
    h_py, h_ts = hashlib.sha256(), hashlib.sha256()
    for i, (r, t) in enumerate(zip(rows, ts, strict=True)):
        band = cmenc.select_band(r["rating"], BANDS, scalers)
        pc = max(0, round(r["playerClockS"] * 1000)) / 1000
        oc = max(0, round(r["opponentClockS"] * 1000)) / 1000
        sr, cf = cmenc.standardise(r["rating"], pc, oc, r["incrementS"], band, scalers[band])
        cur = cmenc.MOVE_TO_ACTION.get(r["uci"], cmenc.PAD_TOKEN)
        ids_py = M.window_ids(np.asarray([r["ids"]], dtype=np.uint16), np.asarray([cur]), "with_current" if i % 2 else "history")[0].astype(np.int32)
        ids_ts = np.asarray(t["moveTokens"] + t["fenTokens"], dtype=np.int32)
        blob_py = ids_py.tobytes() + f32(sr) + f32(cf)
        blob_ts = ids_ts.tobytes() + f32(t["scaledRating"]) + f32(t["clockFeatures"])
        h_py.update(blob_py)
        h_ts.update(blob_ts)
        worst = max(worst, abs(float(sr) - t["scaledRating"]), float(np.abs(cf - np.array(t["clockFeatures"])).max()))
        bad += band != t["band"] or blob_py != blob_ts
    print(f"(c) TypeScript encoder: {len(rows)} real positions (half with the timed move in the window), {bad} mismatches, max float64 |Δ| {worst:.1e}, "
          f"input sha256 py={h_py.hexdigest()[:16]} ts={h_ts.hexdigest()[:16]}")
    return bad


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", default=str(MAIN / "data" / "calibration" / "games.jsonl"))
    ap.add_argument("--n", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--scalers", default=None, help="scalers.json to test (default: the worktree's)")
    args = ap.parse_args()
    scalers = cmenc.load_scalers(Path(args.scalers) if args.scalers else None)
    # splitFor parity against tools/calibration/build-corpus.ts (values from `bun -e`).
    split_ok = all(cmenc.split_for(n) == s for n, s in SPLIT_REFERENCE.items())
    print(f"splitFor parity on {len(SPLIT_REFERENCE)} names: {split_ok}")
    bad = check_fixture(scalers) + (not split_ok)
    rows = sample_positions(Path(args.games), args.n, args.seed)
    bad += check_upstream(load_upstream(), rows)
    bad += check_ts(rows, scalers)
    print("PARITY OK" if bad == 0 else f"PARITY FAILED ({bad})")
    return 1 if bad else 0


SPLIT_REFERENCE: dict[str, str] = {"DianaMirza":"holdout","rickster240":"holdout","AuthentiekePizzaOven":"fit","Hikaru":"fit","MagnusCarlsen":"fit","a":"fit","ZZZ_top":"fit","owen":"fit","Firouzja2003":"fit","DanielNaroditsky":"holdout","penguingim1":"fit","x_Y_z-9":"holdout"}

if __name__ == "__main__":
    sys.exit(main())

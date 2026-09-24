#!/usr/bin/env python3
"""Held-out evaluation of ChessMimic clock bands on chess.com movers.

    evaluate.py --examples <examples.npz> --out <dir> --model NAME=SPEC [--model ...]

SPEC is `<checkpoint>|upstream:<band>` followed by `,band=<band>` (scalers/clamp/buckets used),
optional `,contract=history|with_current`, `,scalers=<scalers.json>`. Example:
    --model shipped=upstream:2200_3500,band=2200_3500
    --model shipped_cur=upstream:2200_3500,band=2200_3500,contract=with_current
    --model b2000=upstream:2000_2100,band=2000_2100
    --model routed=routed  (the production band selection: each rating to its band)

Only holdout movers (`splitFor`) are scored, first moves (ply 0/1) excluded, capped at `--cap` game-sides per player (chosen by a
hash of the game so the choice is stable across runs). Cells: time class × rating band ×
situation (all / book / recapture / other). Metrics per move:
  nll   −log p(observed bucket)            (masked, renormalised — what the runtime samples from)
  rps   Σ_k (F_k − 1[y ≤ k])²              (CRPS over the 30-bucket distribution)
  pit   randomised PIT → coverage of the 10/50/90 % quantiles
  b0    predicted mass in bucket 0 (0–1 s) vs observed bucket-0 share, and the observed ≤ 0.2 s
        (premove-tick) share, overall and within bucket 0
  median of the cell's pooled predictive distribution vs the observed median (s)
CIs: 95 % percentile bootstrap over players (cluster-robust); model differences are paired.

Parts (`ftlib/`): `sides.py` (the held-out selection), `models.py` (model specs and runs),
`metrics.py` (per-move scores, bootstrap), `cells.py` (cells and labels), `report.py` (rows and
markdown).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cmenc  # noqa: E402
import model as M  # noqa: E402
from ftlib.cells import load_labels  # noqa: E402
from ftlib.metrics import pit_hist  # noqa: E402
from ftlib.models import parse_spec, run_models  # noqa: E402
from ftlib.report import markdown, summarise  # noqa: E402
from ftlib.sides import select  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--examples", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", action="append", required=True)
    ap.add_argument("--baseline", default=None)
    ap.add_argument("--cap", type=int, default=30)
    ap.add_argument("--min-rating", type=float, default=1500)
    ap.add_argument("--boot", type=int, default=500)
    ap.add_argument("--side-frac", type=float, default=1.0, help="random share of game-sides to score (hash-based, stable)")
    ap.add_argument("--title", default="ChessMimic held-out evaluation")
    ap.add_argument("--labels", action="append", default=[], help="situation labels JSONL (repeatable)")
    args = ap.parse_args()
    ex_path = Path(args.examples)
    ex = M.load_examples(ex_path)
    games = json.loads((ex_path.parent / "games.json").read_text())
    idx = select(ex, args.cap, args.min_rating, games, side_frac=args.side_frac)
    print(f"{len(idx):,} held-out moves from {len(np.unique(ex['player'][idx])):,} players", file=sys.stderr)
    specs = [parse_spec(s) for s in args.model]
    results = run_models(ex, idx, specs, cmenc.load_buckets(), cmenc.load_scalers())
    labels = load_labels(args.labels, ex, idx, games)
    rows = summarise(ex, idx, results, args.boot, args.baseline, labels)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    r = ex["rating"][idx]
    hist = {"2100+": pit_hist(results, np.nonzero(r >= 2100)[0])}
    (out / "eval.json").write_text(json.dumps({"examples": str(ex_path), "cap": args.cap, "labels": args.labels or "provisional (ECOUrl book depth, same-square recapture)", "models": specs, "rows": rows, "pit_hist": hist}, indent=1))
    (out / "eval.md").write_text(markdown(rows, [s["name"] for s in specs], args.baseline, args.title))
    np.savez_compressed(out / "per-move.npz", idx=idx, **{f"{nm}__{k}": v for nm, (m, _) in results.items() for k, v in m.items() if k != "probs"})
    print(f"wrote {out}/eval.md", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

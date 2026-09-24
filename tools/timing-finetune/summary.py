#!/usr/bin/env python3
"""Compact summary of an evaluate.py eval.json: one row per (tc, rating, situation) with
NLL / RPS / pooled median / bucket-0 mass / coverage per model and ΔNLL, ΔRPS CIs vs baseline.

    summary.py <eval.json> [--tc any] [--ratings 2100+,2200-2999] [--models a,b] [--situations all,book]
"""
import argparse
import json

ap = argparse.ArgumentParser()
ap.add_argument("path")
ap.add_argument("--tc", default=None)
ap.add_argument("--ratings", default=None)
ap.add_argument("--models", default=None)
ap.add_argument("--situations", default=None)
a = ap.parse_args()
d = json.load(open(a.path))
tcs = a.tc.split(",") if a.tc else None
rs = a.ratings.split(",") if a.ratings else None
ms = a.models.split(",") if a.models else None
ss = a.situations.split(",") if a.situations else None
for r in d["rows"]:
    if tcs and r["tc"] not in tcs or rs and r["rating"] not in rs or ss and r["situation"] not in ss:
        continue
    pre_in = r["obs_pre_within_b0"]
    s = f"{r['tc']:6} {r['rating']:9} {r['situation']:9} n={r['n']:7} p={r['players']:5} obs med {r['obs_median_s']:4.1f} b0 {r['obs_b0']:.3f} ≤.2s {r['obs_pre']:.3f} ({(pre_in or 0):.2f}) |"
    for nm, m in r["models"].items():
        if ms and nm not in ms:
            continue
        s += f" {nm} {m['nll'][0]:.3f}/{m['rps'][0]:.3f} med {m['pred_median_s']:.1f} b0 {m['pred_b0']:.3f} cov {m['cov10']:.2f}/{m['cov50']:.2f}/{m['cov90']:.2f}"
        if "d_nll" in m:
            s += f" ΔNLL {m['d_nll'][0]:+.3f}[{m['d_nll'][1]:+.3f},{m['d_nll'][2]:+.3f}] ΔRPS {m['d_rps'][0]:+.3f}[{m['d_rps'][1]:+.3f},{m['d_rps'][2]:+.3f}]"
        s += " |"
    print(s)

#!/usr/bin/env python3
"""06_eval.py — offline evaluation of real vs simulated think times (Appendix D §6, §8.6).

Inputs are two JSONL files with one row per ply: the real rows from 03_features.py and the
simulated rows exported from the extension's timing log / conformance harness (Task 33), each
with at least {"think": seconds, "clock_s", "phase", "tc", "elo"} (real) and the same keys plus
optional per-row predictive distributions for NLL/CRPS:
  * "pred_buckets": [p_0 … p_{k−1}] with "bucket_edges" (bucketed heads), or
  * "pred_lognormal": [mu, sigma, p_spike, p_tail] (the v1 mixture).

Reports, per rating bucket × tc_class × phase × clock bucket:
  * interval NLL of the realised think under the predictive distribution (P(t ∈ [k, k+1)) at 1-s resolution),
  * CRPS on the seconds scale (bucketed predictive CDF),
  * marginal shape: quantiles of log-think, P(t ≤ 0.35), P(t > 15), Hill tail index above the 95th percentile,
  * adversarial detectability: AUC of a per-game logistic classifier on timing-sequence summaries
    (acceptance: AUC ≤ 0.70 for v1, ≤ 0.60 for v2 / ChessMimic).
Requires numpy only.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict

CLOCK_BUCKETS = [(120, math.inf, ">120"), (60, 120, "60–120"), (30, 60, "30–60"), (10, 30, "10–30"), (0, 10, "<10")]


def load(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh]


def tc_class(tc: str) -> str:
    base, inc = (int(x) for x in tc.split("+"))
    eff = base + 40 * inc
    return "bullet" if eff < 180 else "blitz" if eff < 480 else "rapid" if eff < 1500 else "classical"


def clock_bucket(c: float) -> str:
    for lo, hi, name in CLOCK_BUCKETS:
        if lo <= c < hi:
            return name
    return "<10"


def slice_key(row: dict) -> tuple:
    elo = row.get("elo", 1650)
    rb = f"{int(elo // 200) * 200}-{int(elo // 200) * 200 + 200}"
    return rb, tc_class(row["tc"]), row.get("phase", "?"), clock_bucket(row["clock_s"])


def normal_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def predictive_cdf(row: dict, t: float) -> float | None:
    if "pred_buckets" in row and "bucket_edges" in row:
        edges, p = row["bucket_edges"], row["pred_buckets"]
        acc = 0.0
        for i, prob in enumerate(p):
            lo = edges[i - 1] if i else 0.0
            hi = edges[i] if i < len(edges) else math.inf
            if t >= hi:
                acc += prob
            elif t > lo:
                acc += prob * (t - lo) / (hi - lo) if math.isfinite(hi) else prob * 0.5
        return min(1.0, acc)
    if "pred_lognormal" in row:
        mu, sigma, p_spike, p_tail = row["pred_lognormal"]
        body = normal_cdf((math.log(max(t, 1e-3)) - mu) / sigma)
        tail = normal_cdf((math.log(max(t, 1e-3)) - mu - math.log(3.5)) / (sigma + 0.4))
        return p_spike * (1.0 if t >= 0.35 else t / 0.35) + (1 - p_spike - p_tail) * body + p_tail * tail
    return None


def nll_interval(row: dict) -> float | None:
    t = row["think"]
    k = math.floor(t)
    lo, hi = predictive_cdf(row, k), predictive_cdf(row, k + 1)
    if lo is None or hi is None:
        return None
    return -math.log(max(1e-9, hi - lo))


def crps(row: dict, grid_max: float = 200.0) -> float | None:
    t = row["think"]
    total, prev = 0.0, 0.0
    step = 0.25
    x = 0.0
    while x < grid_max:
        F = predictive_cdf(row, x)
        if F is None:
            return None
        total += (F - (1.0 if x >= t else 0.0)) ** 2 * step
        x += step
    return total


def hill_index(values: list[float]) -> float | None:
    xs = sorted(v for v in values if v > 0)
    if len(xs) < 50:
        return None
    k = max(10, len(xs) // 20)
    tail = xs[-k:]
    xk = xs[-k - 1]
    return k / sum(math.log(v / xk) for v in tail)


def quantiles(values: list[float], qs=(0.1, 0.5, 0.9)) -> list[float]:
    xs = sorted(values)
    return [xs[min(len(xs) - 1, int(q * len(xs)))] for q in qs] if xs else []


def game_summaries(rows: list[dict]) -> dict[str, list[float]]:
    by_game: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_game[str(r.get("game", r.get("gameId", "?")))].append(r)
    out = {}
    for g, rs in by_game.items():
        ts = [max(1e-3, r["think"]) for r in rs]
        logs = [math.log(t) for t in ts]
        mean = sum(logs) / len(logs)
        sd = math.sqrt(sum((v - mean) ** 2 for v in logs) / len(logs))
        lag1 = 0.0
        if len(logs) > 2 and sd > 0:
            lag1 = sum((logs[i] - mean) * (logs[i + 1] - mean) for i in range(len(logs) - 1)) / ((len(logs) - 1) * sd * sd)
        out[g] = [mean, sd, lag1, sum(1 for t in ts if t <= 0.35) / len(ts), sum(1 for t in ts if t > 15) / len(ts),
                  max(ts), sd / max(1e-6, sum(ts) / len(ts)), len(ts)]
    return out


def auc(pos: list[list[float]], neg: list[list[float]], epochs: int = 200, lr: float = 0.05) -> float:
    """Logistic regression (numpy) on standardised per-game summaries; AUC on a 30 % hold-out."""
    import numpy as np

    X = np.asarray(pos + neg, dtype=float)
    y = np.asarray([1] * len(pos) + [0] * len(neg), dtype=float)
    X = (X - X.mean(0)) / (X.std(0) + 1e-9)
    rng = np.random.default_rng(1)
    idx = rng.permutation(len(X))
    cut = int(0.7 * len(X))
    tr, te = idx[:cut], idx[cut:]
    w = np.zeros(X.shape[1])
    b = 0.0
    for _ in range(epochs):
        z = X[tr] @ w + b
        p = 1 / (1 + np.exp(-z))
        g = p - y[tr]
        w -= lr * (X[tr].T @ g) / len(tr)
        b -= lr * g.mean()
    s = X[te] @ w + b
    pos_s, neg_s = s[y[te] == 1], s[y[te] == 0]
    if len(pos_s) == 0 or len(neg_s) == 0:
        return float("nan")
    return float(((pos_s[:, None] > neg_s[None, :]).mean() + 0.5 * (pos_s[:, None] == neg_s[None, :]).mean()))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("real", help="JSONL of real plies (03_features.py)")
    ap.add_argument("simulated", help="JSONL of simulated plies (timing log export / Task 33 harness)")
    ap.add_argument("--filter", choices=["all", "allie"], default="all",
                    help="'allie': drop the first 10 plies and moves with either clock < 30 s")
    ap.add_argument("--out", default="", help="write the report as JSON here")
    args = ap.parse_args()

    real, sim = load(args.real), load(args.simulated)
    if args.filter == "allie":
        keep = lambda r: r.get("ply", 99) >= 10 and r["clock_s"] >= 30 and r.get("opp_clock_s", 999) >= 30
        real, sim = [r for r in real if keep(r)], [r for r in sim if keep(r)]

    report: dict = {"n_real": len(real), "n_sim": len(sim), "slices": {}, "marginal": {}, "auc": None}
    slices: dict[tuple, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for r in sim:
        key = slice_key(r)
        n = nll_interval(r)
        if n is not None:
            slices[key]["nll"].append(n)
        c = crps(r)
        if c is not None:
            slices[key]["crps"].append(c)
    for key, metrics in sorted(slices.items()):
        report["slices"][" × ".join(key)] = {m: sum(v) / len(v) for m, v in metrics.items() if v}

    for name, rows in (("real", real), ("simulated", sim)):
        ts = [r["think"] for r in rows]
        logs = [math.log(max(t, 1e-3)) for t in ts]
        by_phase = defaultdict(list)
        for r in rows:
            by_phase[r.get("phase", "?")].append(math.log(max(r["think"], 1e-3)))
        report["marginal"][name] = {
            "log_think_q10_50_90": quantiles(logs),
            "p_le_0.35": sum(1 for t in ts if t <= 0.35) / max(1, len(ts)),
            "p_gt_15": sum(1 for t in ts if t > 15) / max(1, len(ts)),
            "hill_tail_index": hill_index(ts),
            "per_phase_median_log": {p: quantiles(v, (0.5,)) for p, v in by_phase.items()},
        }

    gr, gs = game_summaries(real), game_summaries(sim)
    if len(gr) >= 20 and len(gs) >= 20:
        try:
            report["auc"] = auc(list(gr.values()), list(gs.values()))
        except ImportError:
            report["auc"] = "numpy required"
    print(json.dumps(report, indent=2, default=str))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2, default=str)
    return 0


if __name__ == "__main__":
    sys.exit(main())

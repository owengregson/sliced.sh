"""The evaluation's rows (per cell: observed statistics and each model's scores with bootstrap
intervals, paired differences against the baseline) and their markdown."""
from __future__ import annotations

import numpy as np

from .cells import SITUATIONS, cells
from .metrics import bootstrap, pooled_median


def summarise(ex: dict, idx: np.ndarray, results: dict, B: int, baseline: str | None, labels: np.ndarray | None = None) -> list[dict]:
    rng = np.random.default_rng(2026)
    rows = []
    names = list(results)
    for t, rb, s, sub in cells(ex, idx, labels):
        players = ex["player"][idx][sub]
        think = ex["think"][idx][sub]
        row = {"tc": t, "rating": rb, "situation": s, "n": int(len(sub)), "players": int(len(np.unique(players))),
               "obs_median_s": float(np.median(think)), "obs_b0": float((results[names[0]][0]["obs_b0"][sub]).mean()),
               "obs_pre": float((think <= 0.2).mean()),
               "obs_pre_within_b0": float((think[think < 1] <= 0.2).mean()) if (think < 1).any() else None, "models": {}}
        vals = {}
        for nm in names:
            m, e = results[nm]
            for k in ("nll", "rps"):
                vals[f"{nm}:{k}"] = m[k][sub]
            if baseline and nm != baseline:
                for k in ("nll", "rps"):
                    vals[f"{nm}-{baseline}:{k}"] = m[k][sub] - results[baseline][0][k][sub]
        seed_state = rng.bit_generator.state
        bs = bootstrap(players, vals, B, rng) if len(np.unique(players)) > 1 else {k: (float(v.mean()), float("nan"), float("nan")) for k, v in vals.items()}
        rng.bit_generator.state = seed_state
        for nm in names:
            m, e = results[nm]
            pit = m["pit"][sub]
            row["models"][nm] = {
                "nll": bs[f"{nm}:nll"], "rps": bs[f"{nm}:rps"],
                "cov10": float((pit <= 0.1).mean()), "cov50": float((pit <= 0.5).mean()), "cov90": float((pit <= 0.9).mean()),
                "pred_b0": float(m["b0"][sub].mean()), "pred_median_s": pooled_median(m["probs"][sub].astype(np.float64), e),
            }
            if baseline and nm != baseline:
                row["models"][nm]["d_nll"] = bs[f"{nm}-{baseline}:nll"]
                row["models"][nm]["d_rps"] = bs[f"{nm}-{baseline}:rps"]
        rows.append(row)
    return rows


def fmt_ci(t) -> str:
    v, lo, hi = t
    return f"{v:.3f} [{lo:.3f}, {hi:.3f}]" if np.isfinite(lo) else f"{v:.3f}"


def markdown(rows: list[dict], names: list[str], baseline: str | None, title: str) -> str:
    out = [f"# {title}", ""]
    for s in SITUATIONS:
        out += [f"## situation: {s}", ""]
        hdr = "| tc | rating | n | players | obs med s | obs b0 | obs ≤0.2s (in b0) |"
        sep = "|---|---|---:|---:|---:|---:|---:|"
        for nm in names:
            hdr += f" {nm} NLL | {nm} RPS | {nm} med s | {nm} b0 | {nm} cov10/50/90 |"
            sep += "---:|---:|---:|---:|---|"
            if baseline and nm != baseline:
                hdr += f" Δ{nm} NLL | Δ{nm} RPS |"
                sep += "---:|---:|"
        out += [hdr, sep]
        for r in rows:
            if r["situation"] != s:
                continue
            pre_in = "–" if r["obs_pre_within_b0"] is None else f"{r['obs_pre_within_b0']:.2f}"
            line = f"| {r['tc']} | {r['rating']} | {r['n']} | {r['players']} | {r['obs_median_s']:.1f} | {r['obs_b0']:.3f} | {r['obs_pre']:.3f} ({pre_in}) |"
            for nm in names:
                m = r["models"][nm]
                line += f" {fmt_ci(m['nll'])} | {fmt_ci(m['rps'])} | {m['pred_median_s']:.1f} | {m['pred_b0']:.3f} | {m['cov10']:.2f}/{m['cov50']:.2f}/{m['cov90']:.2f} |"
                if baseline and nm != baseline:
                    line += f" {fmt_ci(m['d_nll'])} | {fmt_ci(m['d_rps'])} |"
            out.append(line)
        out.append("")
    return "\n".join(out)

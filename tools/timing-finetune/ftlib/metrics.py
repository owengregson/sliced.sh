"""Per-move scores of a predicted 30-bucket distribution against the observed think (NLL, RPS,
randomised PIT, bucket-0 mass), the pooled predictive median, and the player-cluster bootstrap
of their means."""
from __future__ import annotations

import numpy as np

import cmenc


def metrics_for(probs: np.ndarray, think: np.ndarray, e: np.ndarray, rng: np.random.Generator) -> dict:
    y = cmenc.bucket_index(think, e)
    n = len(y)
    py = probs[np.arange(n), y]
    cdf = np.cumsum(probs, 1)
    below = cdf[np.arange(n), y] - py
    step = (np.arange(cmenc.N_BUCKETS)[None, :] >= y[:, None]).astype(np.float64)
    return {
        "nll": -np.log(np.maximum(py, 1e-12)),
        "rps": ((cdf - step) ** 2).sum(1),
        "pit": below + rng.random(n) * py,
        "b0": probs[:, 0],
        "obs_b0": (y == 0).astype(np.float64),
        "obs_pre": (think <= 0.2).astype(np.float64),
    }


def pooled_median(probs: np.ndarray, e: np.ndarray) -> float:
    p = probs.mean(0)
    c = np.cumsum(p)
    k = int(np.searchsorted(c, 0.5))
    lo = e[k]
    hi = e[k + 1] if np.isfinite(e[k + 1]) else lo + 20.0
    prev = c[k - 1] if k > 0 else 0.0
    return float(lo + (hi - lo) * (0.5 - prev) / max(p[k], 1e-12))


def bootstrap(players: np.ndarray, values: dict[str, np.ndarray], B: int, rng) -> dict[str, tuple[float, float, float]]:
    uniq, inv = np.unique(players, return_inverse=True)
    cnt = np.bincount(inv, minlength=len(uniq)).astype(np.float64)
    W = rng.multinomial(len(uniq), np.full(len(uniq), 1 / len(uniq)), size=B).astype(np.float64)
    res = {}
    for k, v in values.items():
        s = np.bincount(inv, weights=v, minlength=len(uniq))
        boots = (W @ s) / np.maximum(W @ cnt, 1e-12)
        res[k] = (float(s.sum() / cnt.sum()), float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5)))
    return res


def pit_hist(results: dict, sub: np.ndarray) -> dict:
    return {nm: np.histogram(m["pit"][sub], bins=10, range=(0, 1))[0].tolist() for nm, (m, _) in results.items()}

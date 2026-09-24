"""The models an evaluation compares: `--model NAME=SPEC` parsing, and one pass of each over the
selected moves (a checkpoint or an upstream band, or `routed`, the production band selection per
rating) to masked, renormalised bucket probabilities and their per-move metrics."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch

import cmenc
import model as M

from .metrics import metrics_for

BANDS = ["0_1000", "1200_1300", "1500_1600", "1800_1900", "2000_2100", "2200_3500"]


def parse_spec(spec: str) -> dict:
    name, _, rest = spec.partition("=")
    parts = rest.split(",")
    d = {"name": name, "src": parts[0], "contract": "history", "band": None, "scalers": None}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        d[k] = v
    return d


def run_models(ex: dict, idx: np.ndarray, specs: list[dict], buckets: dict, default_scalers: dict, bs: int = 1024) -> dict:
    dev = M.device()
    out = {}
    rng = np.random.default_rng(12345)
    for sp in specs:
        scal = cmenc.load_scalers(Path(sp["scalers"])) if sp.get("scalers") else default_scalers
        if sp["src"] == "routed":
            # production band selection per rating
            probs = np.empty((len(idx), cmenc.N_BUCKETS))
            bands = np.array([cmenc.select_band(float(r), BANDS, scal) for r in ex["rating"][idx]])
            thinkbuckets = np.empty(len(idx), dtype=np.int64)
            for b in np.unique(bands):
                sel = np.nonzero(bands == b)[0]
                mdl = M.upstream(b).to(dev)
                ids, sr, cf = M.model_inputs(ex, idx[sel], b, scal, sp["contract"])
                e = cmenc.edges(buckets, b)
                probs[sel] = M.predict(mdl, ids, sr, cf, e, ex["pclock"][idx[sel]], ex["inc"][idx[sel]], bs)
                thinkbuckets[sel] = cmenc.bucket_index(ex["think"][idx[sel]], e)
                del mdl
            # all non-novice bands share the 1-second layout; the metrics use the 2200 edges
            e = cmenc.edges(buckets, "2200_3500")
        else:
            band = sp["band"]
            mdl = (M.upstream(sp["src"].split(":", 1)[1]) if sp["src"].startswith("upstream:") else M.load(sp["src"])).to(dev)
            e = cmenc.edges(buckets, band)
            ids, sr, cf = M.model_inputs(ex, idx, band, scal, sp["contract"])
            probs = M.predict(mdl, ids, sr, cf, e, ex["pclock"][idx], ex["inc"][idx], bs)
            del mdl
        torch.mps.empty_cache() if torch.backends.mps.is_available() else None
        m = metrics_for(probs, ex["think"][idx], e, rng)
        m["probs"] = probs.astype(np.float32)
        out[sp["name"]] = (m, e)
        print(f"  {sp['name']}: NLL {m['nll'].mean():.4f}  RPS {m['rps'].mean():.4f}", file=sys.stderr)
    return out

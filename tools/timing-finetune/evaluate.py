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
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cmenc  # noqa: E402
import model as M  # noqa: E402

TCS = ["bullet", "blitz", "rapid"]
RATING_BANDS = [(1500, 1799), (1800, 1999), (2000, 2099)] + [(lo, lo + 99) for lo in range(2100, 3000, 100)] + [(3000, 9999)]
SITUATIONS = ["all", "book", "recapture", "other", "forced"]
BANDS = ["0_1000", "1200_1300", "1500_1600", "1800_1900", "2000_2100", "2200_3500"]


def band_label(lo: int, hi: int) -> str:
    return f"{lo}+" if hi >= 9999 else f"{lo}-{hi}"


def select(ex: dict, cap: int, min_rating: float, games: list[dict] | None, split: int = 1) -> np.ndarray:
    ok = (ex["split"] == split) & (ex["rating"] >= min_rating) & (ex["ply"] >= 2)  # first moves: chess.com's clock does not run normally
    if "kept" in ex:
        ok &= ex["kept"] == 1
    idx = np.nonzero(ok)[0]
    if cap <= 0:
        return idx
    # game-side key = (player, game); keep each player's `cap` sides with the smallest hash.
    keys = {}
    for p, g in set(zip(ex["player"][idx].tolist(), ex["game"][idx].tolist())):
        tag = games[g]["uuid"] if games else str(g)
        keys.setdefault(p, []).append((hashlib.sha1(f"{tag}:{p}".encode()).digest(), g))
    keep = set()
    for p, lst in keys.items():
        lst.sort()
        keep.update((p, g) for _, g in lst[:cap])
    mask = np.fromiter(((p, g) in keep for p, g in zip(ex["player"][idx].tolist(), ex["game"][idx].tolist())), bool, len(idx))
    return idx[mask]


def parse_spec(spec: str) -> dict:
    name, _, rest = spec.partition("=")
    parts = rest.split(",")
    d = {"name": name, "src": parts[0], "contract": "history", "band": None, "scalers": None}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        d[k] = v
    return d


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


def load_labels(paths: list[str], ex: dict, idx: np.ndarray, games: list[dict]) -> np.ndarray | None:
    """The calibration subagent's situation labels (`data/timing/calib/labels*.jsonl`, keyed by
    game uuid + ply) → a per-move code: 0 other(ordinary) 1 book 2 obvious recapture 3 forced
    4 check/other-labelled, −1 unlabelled. Book takes precedence, then obvious recapture."""
    if not paths:
        return None
    want = {games[g]["uuid"] for g in np.unique(ex["game"][idx]).tolist()}
    lab: dict[tuple[str, int], int] = {}
    for p in paths:
        with open(p, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line[11:47] not in want:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                sit = d.get("situation")
                code = 1 if sit == "book" else 2 if d.get("obviousRecapture") else 3 if sit == "forced" else 0 if sit == "ordinary" else 4
                lab[(d["gameId"], int(d["ply"]))] = code
    uu = [games[g]["uuid"] for g in ex["game"][idx].tolist()]
    codes = np.fromiter((lab.get((u, int(p)), -1) for u, p in zip(uu, ex["ply"][idx].tolist())), np.int8, len(idx))
    print(f"labels: {int((codes >= 0).sum()):,}/{len(idx):,} moves labelled", file=sys.stderr)
    return codes


def cells(ex: dict, idx: np.ndarray, labels: np.ndarray | None = None) -> list[tuple[str, str, str, np.ndarray]]:
    tc = ex["tc"][idx]
    r = ex["rating"][idx]
    if labels is not None:
        sit = {
            "all": np.ones(len(idx), bool),
            "book": labels == 1,
            "recapture": labels == 2,
            "other": labels == 0,
            "forced": labels == 3,
        }
    else:
        book = ex["book"][idx]
        recap = ex["recap"][idx]
        sit = {
            "all": np.ones(len(idx), bool),
            "book": book == 1,
            "recapture": (recap == 1) & (book != 1),
            "other": (book == 0) & (recap == 0),
        }
    tcsel = {"any": np.ones(len(idx), bool)} | {t: tc == i for i, t in enumerate(TCS)}
    rsel = {band_label(lo, hi): (r >= lo) & (r <= hi) for lo, hi in RATING_BANDS}
    rsel["2100+"] = r >= 2100
    rsel["2200-2999"] = (r >= 2200) & (r < 3000)
    out = []
    for t, tm in tcsel.items():
        for rb, rm in rsel.items():
            for s in sit:
                m = tm & rm & sit[s]
                if m.sum() > 0:
                    out.append((t, rb, s, np.nonzero(m)[0]))
    return out


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


def pit_hist(results: dict, sub: np.ndarray) -> dict:
    return {nm: np.histogram(m["pit"][sub], bins=10, range=(0, 1))[0].tolist() for nm, (m, _) in results.items()}


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--examples", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", action="append", required=True)
    ap.add_argument("--baseline", default=None)
    ap.add_argument("--cap", type=int, default=30)
    ap.add_argument("--min-rating", type=float, default=1500)
    ap.add_argument("--boot", type=int, default=500)
    ap.add_argument("--title", default="ChessMimic held-out evaluation")
    ap.add_argument("--labels", action="append", default=[], help="situation labels JSONL (repeatable)")
    args = ap.parse_args()
    ex_path = Path(args.examples)
    ex = M.load_examples(ex_path)
    games = json.loads((ex_path.parent / "games.json").read_text())
    idx = select(ex, args.cap, args.min_rating, games)
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

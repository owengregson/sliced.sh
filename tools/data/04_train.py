#!/usr/bin/env python3
"""04_train.py — v2 MLP head training (Appendix D §3b.2). NOT USED FOR THE SHIPPED PRODUCT.

The shipped timing head is ChessMimic (§8.4b item 6); this script is kept only so the
pipeline documented in Appendix D stays runnable end to end for evaluation experiments:
28 → 96 (GELU) → 96 (GELU) → 32 softmax with FiLM on elo_z, masked cross-entropy over the
32 think-time buckets, hold-out 5 % of games by id. Requires PyTorch and numpy.
"""
from __future__ import annotations

import argparse
import json
import math
import sys

BUCKETS = [0.10, 0.35, 0.6, 0.9, 1.25, 1.7, 2.2, 2.8, 3.5, 4.3, 5.2, 6.3, 7.6, 9.1, 11, 13, 15.5, 18.5, 22, 26, 31, 37, 44, 52, 62, 75, 90, 110, 135, 170, 220, math.inf]
FEATURES = ["elo_z", "tc_bullet", "tc_blitz", "tc_rapid", "log_base_eff", "inc", "log_clock", "pressure", "clock_ratio", "ply", "ply_sq",
            "phase_opening", "phase_middlegame", "phase_endgame", "in_book", "ln_n_reasonable", "decisiveness", "chosen_gap", "eval_abs",
            "eval_sign", "swing_bad", "is_capture", "is_recapture", "is_check", "is_forced", "is_only_legal", "n_legal", "opp_last"]


def bucket_of(t: float) -> int:
    for i, edge in enumerate(BUCKETS):
        if t < edge:
            return i
    return len(BUCKETS) - 1


def vectorise(row: dict) -> list[float] | None:
    if row.get("n_reasonable") is None:
        return None
    base, inc = row["base"], row["inc"]
    eff = base + 40 * inc
    cls = "bullet" if eff < 180 else "blitz" if eff < 480 else "rapid" if eff < 1500 else "classical"
    n_reasonable = row["n_reasonable"]
    dec = row["decisiveness"]
    eval_cp = row.get("eval_cp") or 0.0
    return [row["elo_z"], cls == "bullet", cls == "blitz", cls == "rapid", math.log(eff), inc, math.log(max(0.5, row["clock_s"])),
            row["pressure"], max(-2, min(2, math.log((row["clock_s"] + 1) / (row["opp_clock_s"] + 1)))), row["ply"], (row["ply"] / 40) ** 2,
            row["phase"] == "opening", row["phase"] == "middlegame", row["phase"] == "endgame", row["in_book"], math.log(n_reasonable), dec,
            row["chosen_gap"], math.log(1 + abs(eval_cp) / 100), math.tanh(eval_cp / 300), 0.0, row["is_capture"], row["is_recapture"],
            row["is_check"], int(n_reasonable == 1 and dec > math.log(1 + 150 / 25)), row["is_only_legal"], math.log(max(1, row["n_legal"])),
            row["opp_last"] or math.log(0.2)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("features", help="JSONL from 03_features.py (with engine features)")
    ap.add_argument("--out", default="data/v2-mlp.pt")
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch", type=int, default=4096)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--holdout", type=float, default=0.05)
    args = ap.parse_args()
    try:
        import numpy as np
        import torch
        from torch import nn
    except ImportError:
        print("pip install torch numpy", file=sys.stderr)
        return 2

    xs, ys, masks, games = [], [], [], []
    with open(args.features, encoding="utf-8") as fh:
        for line in fh:
            row = json.loads(line)
            v = vectorise(row)
            if v is None:
                continue
            xs.append(v)
            ys.append(bucket_of(row["think"]))
            limit = row["clock_s"] + row["inc"]
            masks.append([0.0 if (BUCKETS[i - 1] if i else 0) > limit else 1.0 for i in range(len(BUCKETS))])
            games.append(row["game"])
    X = np.asarray(xs, dtype=np.float32)
    mean, std = X.mean(0), X.std(0) + 1e-6
    X = (X - mean) / std
    Y = np.asarray(ys, dtype=np.int64)
    M = np.asarray(masks, dtype=np.float32)
    ids = sorted(set(games))
    hold = set(ids[: int(len(ids) * args.holdout)])
    test = np.asarray([g in hold for g in games])

    class Film(nn.Module):
        def __init__(self):
            super().__init__()
            self.l1, self.l2, self.l3 = nn.Linear(28, 96), nn.Linear(96, 96), nn.Linear(96, 32)
            self.gamma, self.delta = nn.Parameter(torch.zeros(96)), nn.Parameter(torch.zeros(96))

        def forward(self, x):
            e = x[:, :1]
            h = torch.nn.functional.gelu((self.l1(x)) * (1 + self.gamma * e) + self.delta * e)
            h = torch.nn.functional.gelu(self.l2(h))
            return self.l3(h)

    net = Film()
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, args.epochs)
    Xt, Yt, Mt = torch.tensor(X[~test]), torch.tensor(Y[~test]), torch.tensor(M[~test])
    for epoch in range(args.epochs):
        perm = torch.randperm(len(Xt))
        total = 0.0
        for i in range(0, len(Xt), args.batch):
            idx = perm[i : i + args.batch]
            logits = net(Xt[idx]).masked_fill(Mt[idx] == 0, float("-inf"))
            loss = torch.nn.functional.cross_entropy(logits, Yt[idx], label_smoothing=0.02)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += float(loss) * len(idx)
        sched.step()
        print(f"epoch {epoch + 1}: train NLL {total / len(Xt):.4f}")
    torch.save({"state": net.state_dict(), "feature_mean": mean.tolist(), "feature_std": std.tolist(), "buckets": BUCKETS[:-1], "features": FEATURES}, args.out)
    print(f"saved {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

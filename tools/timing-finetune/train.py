#!/usr/bin/env python3
"""Fine-tune a ChessMimic clock band on fit-split chess.com movers.

    train.py --examples <examples.npz> [--examples ...] --out <dir> [--contract history]
             [--min-rating 2100] [--refit-rating-scaler] [--lr 3e-5] [--epochs 6]

Starts from the pinned upstream fp32 checkpoint (`--init`, default the 2200_3500 band). Only
`split == fit` movers are used; `--val-frac` of the fit *players* (by hash) are held back for
early stopping on masked NLL. Each player contributes at most `--cap` game-sides (chosen by
hash), so prolific accounts do not dominate.

With `--refit-rating-scaler` the band's rating mean/std become the fitted population's
(move-weighted), and the rating embedding is re-parameterised so the initial network computes
exactly the same function: W' = W·s'/s, b' = b + W·(m' − m)/s. The clock scalers are kept.
The training rating is the mover's rating clamped to [min-rating, band max]; the runtime clamps
to the band's own range, so ratings below the band only shape the slope.

Loss: cross-entropy over the runtime's bucket mask (`bucketMask`: buckets whose lower edge is
within player clock + increment), optionally + `--l2sp` · ‖θ − θ₀‖² (L2-SP toward the upstream
weights, the forgetting guard).
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cmenc  # noqa: E402
import model as M  # noqa: E402


def player_hash(pid: int, salt: str) -> float:
    return hashlib.sha1(f"{salt}:{pid}".encode()).digest()[0] / 256


def cap_sides(ex: dict, idx: np.ndarray, cap: int, games: list[dict]) -> np.ndarray:
    if cap <= 0:
        return idx
    pl, gm = ex["player"][idx], ex["game"][idx]
    pairs = {}
    for p, g in set(zip(pl.tolist(), gm.tolist())):
        pairs.setdefault(p, []).append((hashlib.sha1(f"{games[g]['uuid']}:{p}".encode()).digest(), g))
    keep = set()
    for p, lst in pairs.items():
        lst.sort()
        keep.update((p, g) for _, g in lst[:cap])
    m = np.fromiter(((p, g) in keep for p, g in zip(pl.tolist(), gm.tolist())), bool, len(idx))
    return idx[m]


def concat(parts: list[dict]) -> dict:
    """Concatenate example sets; player/game ids are offset so they stay distinct."""
    if len(parts) == 1:
        return parts[0]
    out = {k: [] for k in parts[0]}
    goff = poff = 0
    for p in parts:
        for k, v in p.items():
            if k == "game":
                v = v + goff
            elif k == "player":
                v = v + poff
            out[k].append(v)
        goff += int(p["game"].max()) + 1
        poff += int(p["player"].max()) + 1
    return {k: np.concatenate(v) for k, v in out.items()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--examples", action="append", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--band", default="2200_3500")
    ap.add_argument("--init", default=None, help="checkpoint (default: upstream <band>)")
    ap.add_argument("--contract", default="history", choices=["history", "with_current", "mixed"])
    ap.add_argument("--p-current", type=float, default=0.85, help="mixed: share of examples with the timed move in the window")
    ap.add_argument("--max-train", type=int, default=0, help="cap on training moves (random game-sides), 0 = all")
    ap.add_argument("--max-val", type=int, default=40000)
    ap.add_argument("--kept-only", action="store_true", help="only sides the crawl kept (default: every fit side, capped by --cap)")
    ap.add_argument("--min-rating", type=float, default=2100)
    ap.add_argument("--refit-rating-scaler", action="store_true")
    ap.add_argument("--cap", type=int, default=60)
    ap.add_argument("--val-frac", type=float, default=0.1)
    ap.add_argument("--lr", type=float, default=3e-5)
    ap.add_argument("--wd", type=float, default=0.0)
    ap.add_argument("--l2sp", type=float, default=0.0)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--epochs", type=float, default=6)
    ap.add_argument("--eval-every", type=int, default=1000)
    ap.add_argument("--patience", type=int, default=4)
    ap.add_argument("--warmup", type=int, default=300)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    parts, games = [], []
    for p in args.examples:
        ex_p = M.load_examples(Path(p))
        g = json.loads((Path(p).parent / "games.json").read_text())
        # player ids are per extract; map them by name so a player spanning extracts is one player
        parts.append(ex_p)
        games.append(g)
    # game-side capping needs uuids: build a joint games list aligned with concat's offsets
    joint_games: list[dict] = []
    for ex_p, g in zip(parts, games):
        joint_games.extend(g[: int(ex_p["game"].max()) + 1])
    ex = concat(parts)

    fit = (ex["split"] == 0) & (ex["rating"] >= args.min_rating) & (ex["ply"] >= 2)  # chess.com's first-move clock does not run normally
    if args.kept_only and "kept" in ex:
        fit &= ex["kept"] == 1
    fit = np.nonzero(fit)[0]
    fit = cap_sides(ex, fit, args.cap, joint_games)
    is_val = np.array([player_hash(int(p), "val") < args.val_frac for p in ex["player"][fit]])
    tr, va = fit[~is_val], fit[is_val]
    sub = np.random.default_rng(1)
    if args.max_train and len(tr) > args.max_train:
        tr = np.sort(sub.choice(tr, args.max_train, replace=False))
    if args.max_val and len(va) > args.max_val:
        va = np.sort(sub.choice(va, args.max_val, replace=False))
    print(f"train {len(tr):,} moves / {len(np.unique(ex['player'][tr])):,} players; val {len(va):,} / {len(np.unique(ex['player'][va])):,}", flush=True)

    band = args.band
    scalers = cmenc.load_scalers()
    s_band = copy.deepcopy(scalers[band])
    dev = M.device()
    net = (M.load(args.init) if args.init else M.upstream(band))
    if args.refit_rating_scaler:
        r = np.minimum(ex["rating"][tr].astype(np.float64), cmenc.band_range(band)[1])
        m_new, s_new = float(r.mean()), float(r.std())
        m_old, s_old = s_band["rating"]["mean"], s_band["rating"]["std"]
        with torch.no_grad():
            W = net.rating_embedding.weight.clone()  # [D, 1]
            net.rating_embedding.bias.add_((W[:, 0] * (m_new - m_old) / s_old))
            net.rating_embedding.weight.mul_(s_new / s_old)
        s_band["rating"] = {"mean": m_new, "std": s_new}
        print(f"rating scaler {m_old:.1f}±{s_old:.1f} → {m_new:.1f}±{s_new:.1f}", flush=True)
    scal = dict(scalers)
    scal[band] = s_band
    net = net.to(dev)
    theta0 = [p.detach().clone() for p in net.parameters()] if args.l2sp > 0 else None
    e = cmenc.edges(cmenc.load_buckets(), band)
    clamp = (args.min_rating, cmenc.band_range(band)[1])

    def tensors(idx):
        # History windows are stored; the timed move is shifted in on the device (`with_ids`).
        ids, sr, cf = M.model_inputs(ex, idx, band, scal, "history", clamp, np.int16)  # tokens < 1968; widened on device
        cur = np.asarray(ex["cur"][idx]).astype(np.int16)
        y = cmenc.bucket_index(ex["think"][idx], e)
        mask = cmenc.bucket_mask(ex["pclock"][idx], ex["inc"][idx], e)
        return (torch.from_numpy(ids), torch.from_numpy(sr), torch.from_numpy(cf), torch.from_numpy(y.astype(np.int64)), torch.from_numpy(mask), torch.from_numpy(cur))

    K = cmenc.RECENT_MOVES

    def with_ids(ids, cur, current):
        """`current` (bool [B]): replace the window by the last 11 history moves + the timed move."""
        ids = ids.int()
        shifted = torch.cat([ids[:, 1:K], cur.int().unsqueeze(1), ids[:, K:]], dim=1)
        return torch.where(current.unsqueeze(1), shifted, ids)

    def contract_mask(n, generator=None):
        if args.contract == "history":
            return torch.zeros(n, dtype=torch.bool)
        if args.contract == "with_current":
            return torch.ones(n, dtype=torch.bool)
        return torch.rand(n, generator=generator) < args.p_current

    TR = tensors(tr)
    VA = tensors(va)

    def loss_of(logits, y, mask):
        logits = logits.float().masked_fill(~mask, -1e9)
        return F.cross_entropy(logits, y, reduction="none")

    @torch.no_grad()
    def val_nll(current: bool) -> float:
        net.eval()
        tot = 0.0
        for i in range(0, len(va), 2048):
            b = [t[i : i + 2048].to(dev) for t in VA]
            flag = torch.full((len(b[0]),), current, dtype=torch.bool, device=dev)
            tot += float(loss_of(net(with_ids(b[0], b[5], flag), b[1], b[2]), b[3], b[4]).sum())
        net.train()
        return tot / len(va)

    last_parts: dict[str, float] = {}

    def evaluate() -> float:
        """The contract's own validation NLL (mixed: the p-weighted blend of both contracts)."""
        last_parts.clear()
        if args.contract in ("history", "mixed"):
            last_parts["hist"] = val_nll(False)
        if args.contract in ("with_current", "mixed"):
            last_parts["cur"] = val_nll(True)
        if args.contract == "mixed":
            return args.p_current * last_parts["cur"] + (1 - args.p_current) * last_parts["hist"]
        return next(iter(last_parts.values()))

    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=args.wd, betas=(0.9, 0.98))
    steps_per_epoch = math.ceil(len(tr) / args.batch)
    total = int(args.epochs * steps_per_epoch)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / args.warmup) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / total))))
    best = evaluate()
    print(f"step 0 val NLL {best:.4f} {last_parts} (upstream init)", flush=True)
    torch.save({"state_dict": net.state_dict()}, out / "best.ckpt")
    log = [{"step": 0, "val_nll": best, "parts": dict(last_parts)}]
    bad = 0
    step = 0
    t0 = time.time()
    net.train()
    running = 0.0
    done = False
    while not done:
        perm = torch.from_numpy(rng.permutation(len(tr)))
        for i in range(0, len(tr), args.batch):
            sel = perm[i : i + args.batch]
            b = [t[sel].to(dev) for t in TR]
            flag = contract_mask(len(sel)).to(dev)
            loss = loss_of(net(with_ids(b[0], b[5], flag), b[1], b[2]), b[3], b[4]).mean()
            if theta0 is not None:
                loss = loss + args.l2sp * sum(((p - p0) ** 2).sum() for p, p0 in zip(net.parameters(), theta0))
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            opt.step()
            sched.step()
            running = 0.98 * running + 0.02 * float(loss.detach()) if step else float(loss.detach())
            step += 1
            if step % args.eval_every == 0 or step >= total:
                v = evaluate()
                log.append({"step": step, "val_nll": v, "parts": dict(last_parts), "train_loss": running, "lr": sched.get_last_lr()[0], "s": time.time() - t0})
                print(f"step {step}/{total} train {running:.4f} val NLL {v:.4f} {last_parts} lr {sched.get_last_lr()[0]:.2e} {time.time() - t0:.0f}s", flush=True)
                if v < best - 1e-4:
                    best, bad = v, 0
                    torch.save({"state_dict": net.state_dict()}, out / "best.ckpt")
                else:
                    bad += 1
                    if bad >= args.patience:
                        done = True
                        break
            if step >= total:
                done = True
                break
    (out / "scalers.json").write_text(json.dumps(scal, indent=1) + "\n")
    (out / "train.json").write_text(json.dumps({"args": vars(args), "best_val_nll": best, "train_moves": int(len(tr)), "val_moves": int(len(va)),
                                                "band_scalers": s_band, "log": log}, indent=1))
    print(f"best val NLL {best:.4f}; wrote {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""The fine-tuning's inputs and objective: the rating-scaler re-parameterisation (the network
computes the same function under the refitted scaler), the example tensors, the timed-move
window of the training contract, and the cross-entropy over the runtime's bucket mask."""
from __future__ import annotations

import numpy as np
import torch
import torch.nn.functional as F

import cmenc
import model as M

K = cmenc.RECENT_MOVES


def refit_rating_scaler(net, s_band: dict, ratings: np.ndarray, band: str) -> None:
    """Refit `s_band["rating"]` to the training population (clamped to the band's top) and
    re-parameterise the rating embedding so the initial network is unchanged:
    W' = W·s'/s, b' = b + W·(m' − m)/s."""
    r = np.minimum(ratings.astype(np.float64), cmenc.band_range(band)[1])
    m_new, s_new = float(r.mean()), float(r.std())
    m_old, s_old = s_band["rating"]["mean"], s_band["rating"]["std"]
    with torch.no_grad():
        W = net.rating_embedding.weight.clone()  # [D, 1]
        net.rating_embedding.bias.add_((W[:, 0] * (m_new - m_old) / s_old))
        net.rating_embedding.weight.mul_(s_new / s_old)
    s_band["rating"] = {"mean": m_new, "std": s_new}
    print(f"rating scaler {m_old:.1f}±{s_old:.1f} → {m_new:.1f}±{s_new:.1f}", flush=True)


def example_tensors(ex: dict, idx: np.ndarray, band: str, scal: dict, clamp, e: np.ndarray):
    """(ids, rating, clocks, bucket, mask, timed move) for `idx`. History windows are stored; the
    timed move is shifted in on the device (`with_ids`)."""
    ids, sr, cf = M.model_inputs(ex, idx, band, scal, "history", clamp, np.int16)  # tokens < 1968; widened on device
    cur = np.asarray(ex["cur"][idx]).astype(np.int16)
    y = cmenc.bucket_index(ex["think"][idx], e)
    mask = cmenc.bucket_mask(ex["pclock"][idx], ex["inc"][idx], e)
    return (torch.from_numpy(ids), torch.from_numpy(sr), torch.from_numpy(cf), torch.from_numpy(y.astype(np.int64)), torch.from_numpy(mask), torch.from_numpy(cur))


def with_ids(ids, cur, current):
    """`current` (bool [B]): replace the window by the last 11 history moves + the timed move."""
    ids = ids.int()
    shifted = torch.cat([ids[:, 1:K], cur.int().unsqueeze(1), ids[:, K:]], dim=1)
    return torch.where(current.unsqueeze(1), shifted, ids)


def contract_mask(contract: str, p_current: float, n: int, generator=None):
    """Which examples carry the timed move in the window: none (`history`), all (`with_current`)
    or a `p_current` share drawn from torch's generator (`mixed`)."""
    if contract == "history":
        return torch.zeros(n, dtype=torch.bool)
    if contract == "with_current":
        return torch.ones(n, dtype=torch.bool)
    return torch.rand(n, generator=generator) < p_current


def loss_of(logits, y, mask):
    """Per-example cross-entropy over the runtime's bucket mask."""
    logits = logits.float().masked_fill(~mask, -1e9)
    return F.cross_entropy(logits, y, reduction="none")

"""Which moves a run uses, chosen per player so prolific accounts do not dominate: the per-player
cap on game-sides (by a stable hash), the held-out selection the evaluation scores, the player
hash the training's validation split draws, and the concatenation of several extracts."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

import model as M


def player_hash(pid: int, salt: str) -> float:
    return hashlib.sha1(f"{salt}:{pid}".encode()).digest()[0] / 256


def cap_sides(ex: dict, idx: np.ndarray, cap: int, games: list[dict]) -> np.ndarray:
    """Each player's `cap` game-sides with the smallest sha1(uuid:player) — vectorised over the
    unique (player, game) pairs so memory stays bounded on the crawl."""
    if cap <= 0:
        return idx
    key = ex["player"][idx].astype(np.int64) << 32 | ex["game"][idx].astype(np.int64)
    pairs = np.unique(key)
    pp, gg = (pairs >> 32).astype(np.int64), (pairs & 0xFFFFFFFF).astype(np.int64)
    h = np.array([hashlib.sha1(f"{games[g]['uuid']}:{p}".encode()).digest() for p, g in zip(pp.tolist(), gg.tolist())], dtype="S20")
    order = np.lexsort((h, pp))  # by player, then hash
    sp = pp[order]
    first = np.r_[0, np.nonzero(np.diff(sp))[0] + 1]
    rank = np.arange(len(sp)) - np.repeat(first, np.diff(np.r_[first, len(sp)]))
    kept = pairs[order][rank < cap]
    return idx[np.isin(key, kept)]


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


def select(ex: dict, cap: int, min_rating: float, games: list[dict], split: int = 1, side_frac: float = 1.0) -> np.ndarray:
    ok = (ex["split"] == split) & (ex["rating"] >= min_rating) & (ex["ply"] >= 2)  # first moves: chess.com's clock does not run normally
    if "kept" in ex:
        ok &= ex["kept"] == 1
    idx = cap_sides(ex, np.nonzero(ok)[0], cap, games)
    if side_frac >= 1:
        return idx
    # an independent hash, so the side-fraction subsample is unbiased after the cap
    key = ex["player"][idx].astype(np.int64) << 32 | ex["game"][idx].astype(np.int64)
    pairs = np.unique(key)
    h = np.array([hashlib.sha1(f"frac:{g}:{p}".encode()).digest()[0] for p, g in zip((pairs >> 32).tolist(), (pairs & 0xFFFFFFFF).tolist())])
    return idx[np.isin(key, pairs[h < side_frac * 256])]


def load_extracts(paths: list[str]) -> tuple[dict, list[dict]]:
    """Several extracts as one example set, and the games list aligned with its offset game ids
    (game-side capping needs the uuids)."""
    parts, games = [], []
    for p in paths:
        ex_p = M.load_examples(Path(p))
        g = json.loads((Path(p).parent / "games.json").read_text())
        # player ids are per extract; map them by name so a player spanning extracts is one player
        parts.append(ex_p)
        games.append(g)
    # game-side capping needs uuids: build a joint games list aligned with concat's offsets
    joint_games: list[dict] = []
    for ex_p, g in zip(parts, games):
        joint_games.extend(g[: int(ex_p["game"].max()) + 1])
    return concat(parts), joint_games


def fit_moves(ex: dict, joint_games: list[dict], args) -> tuple[np.ndarray, np.ndarray]:
    """The fit-split training and validation moves: fit-split movers at or above `min_rating`, no
    first moves, capped per player; `val_frac` of the players (by hash) held back, and each side
    subsampled to `max_train` / `max_val` moves."""
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
    return tr, va

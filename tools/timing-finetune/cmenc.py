"""ChessMimic input encoding, reproducing the shipped TypeScript encoder exactly.

Mirrors, line for line:
  - `src/core/timing/chessmimic-tokeniser.ts` (`tokenizeFen`, `buildMoveVocabulary`,
    `encodeRecentMoves` — an out-of-vocabulary move pads instead of throwing),
  - `src/core/timing/chessmimic-scalers.ts` (`standardiseInputs`: clamp to the band's range,
    then z-score the rating and `log(x + 1)` of each clock),
  - `src/core/timing/chessmimic-head/bands.ts` (`selectBand`: containing range, then nearest
    fitted rating mean),
  - `src/core/timing/chessmimic-buckets.ts` (`bucketIndexOf`, `bucketMask`),
  - `tools/calibration/build-corpus.ts` (`splitFor`, shared as `tools/data/datalib/splits.py`).

The production inference contract (`chessmimic-head/inputs.ts`) is: the FEN of the position to
move from (en-passant square printed after every double push, as the board adapters do) and the
last 12 moves *played so far* — never the move about to be chosen, because inference runs in
parallel with the search. Upstream trained with the timed move inside the window
(`clock_game_parser.cpp` "moves_including_current"); `window="with_current"` reproduces that
for comparison only.
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "data"))
from datalib.splits import split_for  # noqa: E402, F401 — re-exported as `cmenc.split_for`
ASSETS = ROOT / "assets" / "models" / "chessmimic"
# The git-ignored upstream clone + checkpoint cache of `tools/data/08_export_chessmimic.py`
# (a worktree can point at the main checkout's with CHESSMIMIC_UPSTREAM_DIR).
UPSTREAM_DIR = Path(os.environ.get("CHESSMIMIC_UPSTREAM_DIR", ROOT / "tools" / "data" / "upstream"))

RECENT_MOVES = 12
FEN_TOKENS = 78
N_BUCKETS = 30

FEN_CHARACTERS = list("0123456789abcdefghpnrkqPBNRQKw.")
CHAR_INDEX = {c: i for i, c in enumerate(FEN_CHARACTERS)}
DOT = CHAR_INDEX["."]
INPUT_VOCAB_SIZE = len(FEN_CHARACTERS) + 2
CLASS_TOKEN = INPUT_VOCAB_SIZE - 2
PAD_TOKEN = INPUT_VOCAB_SIZE - 1


def tokenize_fen(fen: str) -> list[int]:
    parts = fen.strip().split()
    defaults = ["", "w", "-", "-", "0", "1"]
    parts = parts + defaults[len(parts):]
    board, side, castling, ep, half, full = parts[:6]
    out: list[int] = []
    for ch in side + board.replace("/", ""):
        if "1" <= ch <= "8":
            out.extend([DOT] * int(ch))
        else:
            out.append(CHAR_INDEX[ch])
    if castling == "-":
        out.extend([DOT] * 4)
    else:
        out.extend(CHAR_INDEX[c] for c in castling)
        out.extend([DOT] * (4 - len(castling)))
    if ep == "-":
        out.extend([DOT, DOT])
    else:
        out.extend(CHAR_INDEX[c] for c in ep)
    for field in (half, full):
        padded = field + "." * max(0, 3 - len(field))
        out.extend(CHAR_INDEX[c] for c in padded)
    out.append(CLASS_TOKEN)
    if len(out) != FEN_TOKENS:
        raise ValueError(f"{len(out)} tokens for {fen!r}")
    return out


def build_move_vocabulary() -> list[str]:
    files = "abcdefgh"

    def name(i: int) -> str:
        return f"{files[i % 8]}{i // 8 + 1}"

    moves: list[str] = []
    for s in range(64):
        f, r = s % 8, s // 8
        queen, knight = [], []
        for t in range(64):
            if t == s:
                continue
            tf, tr = t % 8, t // 8
            df, dr = abs(tf - f), abs(tr - r)
            if tf == f or tr == r or df == dr:
                queen.append(t)
            if (df == 1 and dr == 2) or (df == 2 and dr == 1):
                knight.append(t)
        moves.extend(name(s) + name(t) for t in queen + knight)
    for rank, nxt in (("2", "1"), ("7", "8")):
        for i in range(8):
            fl = files[i]
            targets = [fl]
            if i > 0:
                targets.append(files[i - 1])
            if i < 7:
                targets.append(files[i + 1])
            for tf in targets:
                for piece in "qrbn":
                    moves.append(f"{fl}{rank}{tf}{nxt}{piece}")
    assert len(moves) == 1968
    return moves


MOVE_VOCABULARY = build_move_vocabulary()
MOVE_TO_ACTION = {m: i for i, m in enumerate(MOVE_VOCABULARY)}


def encode_recent_moves(moves: list[str]) -> list[int]:
    window = moves[-RECENT_MOVES:] if moves else []
    out = [PAD_TOKEN] * RECENT_MOVES
    for i, m in enumerate(window):
        out[RECENT_MOVES - len(window) + i] = MOVE_TO_ACTION.get(m, PAD_TOKEN)
    return out


# ── scalers, bands, buckets ─────────────────────────────────────────────────────────────────


def load_scalers(path: Path | None = None) -> dict:
    return json.loads((path or ASSETS / "scalers.json").read_text())


def load_buckets(path: Path | None = None) -> dict:
    return json.loads((path or ASSETS / "buckets.json").read_text())


def band_range(band: str) -> tuple[float, float]:
    lo, hi = band.split("_")
    return float(lo), float(hi)


def select_band(rating: float, bands: list[str], scalers: dict) -> str:
    for b in bands:
        lo, hi = band_range(b)
        if lo <= rating <= hi:
            return b
    best, best_d = bands[0], math.inf
    for b in bands:
        centre = scalers[b]["rating"]["mean"] if b in scalers else sum(band_range(b)) / 2
        d = abs(rating - centre)
        if d < best_d:
            best, best_d = b, d
    return best


def _z(x, s: dict):
    return (x - s["mean"]) / (s["std"] or 1)


def standardise(rating, player_s, opp_s, inc_s, band: str, s: dict, clamp: tuple[float, float] | None = None):
    """Vectorised `standardiseInputs` (float64, like JS). `clamp` overrides the band range."""
    lo, hi = clamp or band_range(band)
    r = np.minimum(hi, np.maximum(lo, np.asarray(rating, dtype=np.float64)))
    scaled = _z(r, s["rating"])
    clocks = np.stack(
        [
            _z(np.log(np.asarray(player_s, dtype=np.float64) + 1), s["log_player_clock"]),
            _z(np.log(np.asarray(opp_s, dtype=np.float64) + 1), s["log_opponent_clock"]),
            _z(np.log(np.asarray(inc_s, dtype=np.float64) + 1), s["log_increment"]),
        ],
        axis=-1,
    )
    return scaled, clocks


def edges(buckets: dict, band: str) -> np.ndarray:
    return np.array([math.inf if e is None else float(e) for e in buckets[band]["boundaries"]])


def bucket_index(seconds, e: np.ndarray):
    """`bucketIndexOf`: the last bucket whose lower edge is <= t, clipped to [0, n-1]."""
    idx = np.searchsorted(e[:-1], np.asarray(seconds, dtype=np.float64), side="right") - 1
    return np.clip(idx, 0, N_BUCKETS - 1)


def bucket_mask(player_s, inc_s, e: np.ndarray) -> np.ndarray:
    max_valid = bucket_index(np.maximum(0, np.asarray(player_s) + np.asarray(inc_s)), e)
    m = np.arange(N_BUCKETS)[None, :] <= np.atleast_1d(max_valid)[:, None]
    m[:, 0] = True
    return m


"""The evaluation's cells: time class × rating band × situation, the situation read from the
calibration's labels (`labels.jsonl`) when given, else the provisional ECOUrl book depth and
same-square recapture."""
from __future__ import annotations

import json
import sys

import numpy as np

TCS = ["bullet", "blitz", "rapid"]
RATING_BANDS = [(1500, 1799), (1800, 1999), (2000, 2099)] + [(lo, lo + 99) for lo in range(2100, 3000, 100)] + [(3000, 9999)]
SITUATIONS = ["all", "book", "recapture", "other", "forced"]


def band_label(lo: int, hi: int) -> str:
    return f"{lo}+" if hi >= 9999 else f"{lo}-{hi}"


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

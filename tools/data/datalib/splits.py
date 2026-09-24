"""The fit/holdout split of a chess.com player, as `tools/calibration/build-corpus.ts` `splitFor`
draws it: the first byte of sha1(`calib:<lower-cased name>`) under 154 is the fit split (about
60 %), the rest holdout. The timing calibration and the ChessMimic finetune share it."""
from __future__ import annotations

import hashlib


def split_for(player: str) -> str:
    return "fit" if hashlib.sha1(f"calib:{player.lower()}".encode()).digest()[0] < 154 else "holdout"

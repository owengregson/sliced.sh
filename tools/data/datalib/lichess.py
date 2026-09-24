"""Streaming Lichess monthly dumps (`.pgn.zst`) without a full PGN parser, and the time-control
classes and reservoir sampling the samplers share (Appendix D §3b.2)."""
from __future__ import annotations

import io
import random
import re
from collections.abc import Iterator
from contextlib import contextmanager

# Lichess's own rule: estimated game duration = base + 40 × increment.
INC_WEIGHT = 40


def tc_class(base: int, inc: int) -> str:
    """bullet / blitz / rapid / classical by estimated duration (seconds)."""
    eff = base + INC_WEIGHT * inc
    if eff < 180:
        return "bullet"
    if eff < 480:
        return "blitz"
    if eff < 1500:
        return "rapid"
    return "classical"


@contextmanager
def open_pgn_zst(path: str, zstandard) -> Iterator[io.TextIOBase]:
    """A `.pgn.zst` dump as a text stream, decompressed on the fly (`zstandard` is the module)."""
    with open(path, "rb") as fh:
        reader = zstandard.ZstdDecompressor().stream_reader(fh)
        yield io.TextIOWrapper(reader, encoding="utf-8", errors="replace")


def iter_games(stream: io.TextIOBase):
    """(headers, movetext) per game: tag lines, then movetext lines joined by spaces up to the
    next blank line."""
    headers: dict[str, str] = {}
    moves: list[str] = []
    for line in stream:
        line = line.rstrip("\n")
        if line.startswith("["):
            m = re.match(r'\[(\w+) "(.*)"\]', line)
            if m:
                headers[m.group(1)] = m.group(2)
        elif line.strip():
            moves.append(line)
        elif moves:
            yield headers, " ".join(moves)
            headers, moves = {}, []
    if moves:
        yield headers, " ".join(moves)


def reservoir_add(reservoir: list, seen: int, row, capacity: int, rng: random.Random) -> None:
    """Algorithm R: `row` is the `seen`-th item offered to `reservoir` (1-based)."""
    if len(reservoir) < capacity:
        reservoir.append(row)
    else:
        j = rng.randrange(seen)
        if j < capacity:
            reservoir[j] = row

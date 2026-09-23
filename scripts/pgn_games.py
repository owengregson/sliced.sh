"""
scripts/pgn_games.py — streaming PGN input for `scripts/build-club-book.py`: open `.pgn`,
`.pgn.zst` (a truncated download is read up to the last complete game) or a `.zip` of `.pgn`
files, split it into games without building python-chess game trees, filter by the headers and
tokenise the movetext.
"""

from __future__ import annotations

import io
import re
import sys
import zipfile
from pathlib import Path
from typing import IO, Iterator

RESULTS = {"1-0", "0-1", "1/2-1/2", "*"}
COMMENT_RE = re.compile(r"\{[^}]*\}")


def open_input(path: Path) -> Iterator[IO[str]]:
    """Text handles for every PGN in `path` (.pgn, .pgn.zst, .zip)."""
    name = path.name.lower()
    if name.endswith(".zst"):
        import zstandard

        with path.open("rb") as raw:
            reader = zstandard.ZstdDecompressor().stream_reader(raw, read_across_frames=True)
            yield io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
    elif name.endswith(".zip"):
        with zipfile.ZipFile(path) as zf:
            for member in zf.namelist():
                if member.lower().endswith(".pgn"):
                    with zf.open(member) as raw:
                        yield io.TextIOWrapper(raw, encoding="utf-8", errors="replace")
    else:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            yield fh


def games(fh: IO[str]) -> Iterator[tuple[dict[str, str], str]]:
    """(headers, movetext) per game of a PGN stream, without building python-chess game trees.

    A truncated compressed download ends in a decompression error; everything before the last
    complete game has been yielded by then, so the stream simply ends there.
    """
    headers: dict[str, str] = {}
    movetext: list[str] = []
    try:
        for line in fh:
            line = line.strip()
            if line.startswith("[") and line.endswith("]") and not movetext:
                key, _, rest = line[1:-1].partition(" ")
                headers[key] = rest.strip().strip('"')
            elif line:
                movetext.append(line)
            elif movetext:
                yield headers, " ".join(movetext)
                headers, movetext = {}, []
    except Exception as error:  # zstandard.ZstdError on a truncated frame
        print(f"  input ended early: {error}", file=sys.stderr)
        return
    if headers and movetext:
        yield headers, " ".join(movetext)


def rating(headers: dict[str, str], key: str) -> int | None:
    value = headers.get(key, "")
    return int(value) if value.isdigit() else None


def is_bullet(headers: dict[str, str]) -> bool:
    event = headers.get("Event", "").lower()
    if "bullet" in event:
        return True
    tc = headers.get("TimeControl", "")
    if "+" in tc:
        base, inc = tc.split("+", 1)
        if base.isdigit() and inc.isdigit():
            return int(base) + 40 * int(inc) < 180
    return False


def wanted(headers: dict[str, str], flt: dict) -> bool:
    if headers.get("Variant", "Standard").lower() not in ("standard", ""):
        return False
    if headers.get("FEN") or headers.get("SetUp") == "1":
        return False
    white = rating(headers, "WhiteElo")
    black = rating(headers, "BlackElo")
    if white is None or black is None:
        if not flt["allow_unrated"]:
            return False
    else:
        if min(white, black) < flt["min_elo"] or max(white, black) > flt["max_elo"]:
            return False
    if not flt["keep_bullet"] and is_bullet(headers):
        return False
    return True


def san_tokens(movetext: str, max_ply: int) -> list[str]:
    """The first `max_ply` SAN tokens of `movetext` (comments, NAGs, move numbers, results dropped)."""
    text = COMMENT_RE.sub(" ", movetext)
    if "(" in text:
        return []  # variations never occur in Lichess exports; skip rather than mis-parse
    out: list[str] = []
    for raw in text.split():
        if raw in RESULTS or raw.startswith("$"):
            continue
        token = raw.rsplit(".", 1)[-1] if "." in raw else raw
        if not token or token[0].isdigit():
            continue
        out.append(token.rstrip("!?"))
        if len(out) >= max_ply:
            break
    return out

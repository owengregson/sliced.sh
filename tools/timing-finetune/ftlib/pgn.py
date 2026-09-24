"""chess.com games (StoredGame JSONL lines) to SANs and `[%clk]` readings: the control string,
chess.com's named-opening depth (`ECOUrl`), and the game filter the extractor applies (standard
start, live classes, parsable controls)."""
from __future__ import annotations

import json
import re

TC = {"bullet": 0, "blitz": 1, "rapid": 2}
TOKEN_RE = re.compile(r"\{([^}]*)\}|(\d+\.(?:\.\.)?)|([^\s{}]+)")
CLK_RE = re.compile(r"\[%clk\s+([0-9:.]+)\]")
RESULTS = {"1-0", "0-1", "1/2-1/2", "*"}


def parse_clock(text: str) -> float | None:
    parts = text.strip().split(":")
    try:
        vals = [float(p) for p in parts]
    except ValueError:
        return None
    s = 0.0
    for v in vals:
        s = s * 60 + v
    return round(s, 3)


def parse_time_control(tc: str) -> tuple[float, float] | None:
    if "/" in tc:
        return None
    base, _, inc = tc.partition("+")
    try:
        return float(base), float(inc or 0)
    except ValueError:
        return None


def book_depth(pgn: str) -> int:
    """Plies in chess.com's deepest named line (from the ECOUrl move tail), −1 when unknown."""
    m = re.search(r'\[ECOUrl "([^"]+)"\]', pgn)
    if not m:
        return -1
    url = m.group(1).rsplit("/", 1)[-1]
    groups = list(re.finditer(r"(?:^|-)(\d+)\.(\.\.\.)?", url))
    if not groups:
        return -1
    last = groups[-1]
    n = int(last.group(1))
    tail = url[last.end():]
    tail = tail.replace("O-O-O", "OOO").replace("O-O", "OO")
    k = len([t for t in tail.split("-") if t])
    if k == 0:
        return -1
    black_start = last.group(2) is not None
    return 2 * (n - 1) + (1 if black_start else 0) + k


def movetext(pgn: str) -> str:
    i = pgn.find("\n\n")
    return pgn[i + 2:] if i >= 0 else pgn


def parse_game(line: str):
    try:
        g = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None
    tc = TC.get(g.get("time_class", ""))
    tcv = parse_time_control(str(g.get("time_control", "")))
    pgn = g.get("pgn") or ""
    if tc is None or tcv is None or '[SetUp "1"]' in pgn or "[Variant" in pgn:
        return None
    base, inc = tcv
    sans: list[str] = []
    clocks: list[float | None] = []
    for m in TOKEN_RE.finditer(movetext(pgn)):
        comment, number, tok = m.groups()
        if comment is not None:
            if sans and clocks[-1] is None:
                c = CLK_RE.search(comment)
                if c:
                    clocks[-1] = parse_clock(c.group(1))
        elif tok is not None and tok not in RESULTS:
            sans.append(tok)
            clocks.append(None)
    return g, tc, base, inc, sans, clocks

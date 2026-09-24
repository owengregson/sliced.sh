"""chess.com PGN movetext to SANs and per-ply `[%clk]` readings (ms), and the control string."""
from __future__ import annotations

import re


def parse_control(tc: str):
    m = re.match(r"^(\d+)(?:\+(\d+(?:\.\d+)?))?$", tc.strip())
    if not m:
        return None
    return int(m.group(1)), float(m.group(2)) if m.group(2) else 0.0


TOKEN = re.compile(r"\{([^}]*)\}|\(|\)|;[^\n]*|\$\d+|(\d+)\.(?:\.\.)?|(1-0|0-1|1/2-1/2|\*)|([^\s{}()]+)")
CLK = re.compile(r"\[%clk\s+([\d:.]+)\]")


def clock_ms(text: str):
    parts = text.strip().split(":")
    s = 0.0
    for p in parts:
        if not re.match(r"^\d+(?:\.\d+)?$", p):
            return None
        s = s * 60 + float(p)
    return int(round(s * 1000))


def parse_pgn(pgn: str):
    lines = pgn.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    i = 0
    seen_header = False
    while i < len(lines):
        line = lines[i].strip()
        if line == "":
            if seen_header:
                break
            i += 1
            continue
        if re.match(r'^\[(\w+)\s+"(.*)"\]$', line):
            seen_header = True
            i += 1
            continue
        break
    movetext = " ".join(lines[i:])
    sans: list[str] = []
    clocks: list = []
    depth = 0
    for m in TOKEN.finditer(movetext):
        whole = m.group(0)
        if whole == "(":
            depth += 1
            continue
        if whole == ")":
            depth = max(0, depth - 1)
            continue
        if depth > 0:
            continue
        if m.group(1) is not None:
            c = CLK.search(m.group(1))
            if c and clocks and clocks[-1] is None:
                clocks[-1] = clock_ms(c.group(1))
            continue
        if m.group(2) is not None or m.group(3) is not None or whole.startswith(";") or whole.startswith("$"):
            continue
        if m.group(4) is not None:
            san = re.sub(r"[!?]+$", "", m.group(4))
            if san:
                sans.append(san)
                clocks.append(None)
    return sans, clocks

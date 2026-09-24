"""tools/timing-calibration/select_crawl.py: pick an independent held-out replay sample from the
big crawl (`data/timing/crawl/games.jsonl`) without parsing any PGN.

    tools/data/.venv/bin/python tools/timing-calibration/select_crawl.py --out DIR \
        [--classes blitz,bullet] [--min 2200] [--per-cell 100] [--per-player 2]

It keeps sides the crawl **kept** (`whiteKept`/`blackKept`), in the **holdout** split
(`splitFor`), whose player never appears in the calibration corpus the table was fitted on
(`data/calibration/games.jsonl`, either colour, any split). Games from that corpus are skipped
too. Per (class × 100-Elo band, 3000 = 3000+) it takes up to `--per-cell` sides, at most
`--per-player` per player, in the order of sha1(game:colour). It also requires ≥ 10 plies per
side. It writes `DIR/select.json` in `select.ts`'s shape; `build_corpus.py --only` then builds
the selected games.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools", "data"))
from datalib.splits import split_for  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--games", default=os.path.join(ROOT, "data/timing/crawl/games.jsonl"))
    ap.add_argument("--exclude", default=os.path.join(ROOT, "data/calibration/games.jsonl"))
    ap.add_argument("--classes", default="blitz,bullet")
    ap.add_argument("--min", type=int, default=2200)
    ap.add_argument("--per-cell", type=int, default=100)
    ap.add_argument("--per-player", type=int, default=2)
    args = ap.parse_args()
    classes = set(args.classes.split(","))
    seen_players, seen_games = set(), set()
    with open(args.exclude) as f:
        for line in f:
            g = json.loads(line)
            seen_games.add(g["uuid"])
            seen_players.add(g["white"]["username"].lower())
            seen_players.add(g["black"]["username"].lower())
    cand = defaultdict(list)
    with open(args.games) as f:
        for line in f:
            g = json.loads(line)
            tc = g.get("time_class")
            if tc not in classes or g["uuid"] in seen_games:
                continue
            if tc == "rapid" and g.get("time_control") != "600":
                continue
            n_plies = len(re.findall(r"\[%clk", g["pgn"]))
            for colour, side, kept in (("w", g["white"], g.get("whiteKept")), ("b", g["black"], g.get("blackKept"))):
                player = side["username"].lower()
                if not kept or player in seen_players or split_for(player) != "holdout":
                    continue
                if n_plies < 22 or side["rating"] < args.min:
                    continue
                band = min(3000, side["rating"] // 100 * 100)
                h = hashlib.sha1(f"{g['uuid']}:{colour}".encode()).hexdigest()
                cand[(tc, band)].append((h, g["uuid"], colour, player))
    sides = []
    for (tc, band), lst in sorted(cand.items()):
        per = defaultdict(int)
        taken = 0
        for h, uuid, colour, player in sorted(lst):
            if taken >= args.per_cell:
                break
            if per[player] >= args.per_player:
                continue
            per[player] += 1
            taken += 1
            sides.append({"gameId": uuid, "color": colour, "split": "holdout", "cell": f"{tc}|{band}|holdout"})
        print(f"{tc} {band}: {taken} sides ({len(lst)} candidates)")
    games = sorted({s["gameId"] for s in sides})
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "select.json"), "w") as f:
        json.dump({"sides": sides, "games": games}, f)
    print(f"{len(sides)} sides from {len(games)} games -> {args.out}/select.json")


if __name__ == "__main__":
    main()

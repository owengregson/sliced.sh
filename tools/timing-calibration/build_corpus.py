"""tools/timing-calibration/build_corpus.py: chess.com games to per-move human think times with
situation labels. This is the fast path of `build-corpus.ts`, which holds the same rules and
documents them. chess.js spends about 1.5 ms replaying one ply; python-chess spends about 0.1 ms.

    tools/data/.venv/bin/python tools/timing-calibration/build_corpus.py \
        [--games FILE] [--out DIR] [--workers 2]

It writes `corpus.jsonl` (one `CorpusGame` per game), `labels.jsonl` (one `LabelRow` per game and
ply) and `corpus-summary.json`. The field shapes are the TypeScript interfaces in `common.ts`.
`verify-labels.ts` recomputes the book and recapture labels of a sample with the shipped
TypeScript modules and fails if they disagree.

The rules live in `timing_corpus/` (`books.py` the book lookups, `pgn.py` the movetext and clock
reader, `labels.py` one game to its record and label rows). Their constants are duplicated from
the shipped registry: `BOOK.maxPly` 30, `BOOK.minWeightShare` 0.01, `BOOK.gmBookElo` 1800,
`MAIA.eloMax` 3000, the phase thresholds in `src/core/chess/phase.ts`, and the premove and
low-clock limits in `common.ts`. `verify-labels.ts` checks them against the TypeScript.
"""

import argparse
import json
import multiprocessing as mp
import os
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "tools", "data"))
from timing_corpus import labels as rules  # noqa: E402


def _init(with_fens: bool) -> None:
    rules.WITH_FENS = with_fens


def work(line: str):
    line = line.strip()
    if not line:
        return None
    try:
        g = json.loads(line)
        game = rules.corpus_game(g)
    except Exception:  # noqa: BLE001 — one malformed game must not stop the corpus
        return None
    if game is None:
        return None
    return json.dumps(game, separators=(",", ":")), [json.dumps(l, separators=(",", ":")) for l in rules.labels_of(game)], [
        (l["tc"], l["rating"] // 100 * 100, l["split"], l["situation"]) for l in rules.labels_of(game)
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", default=os.path.join(ROOT, "data/calibration/games.jsonl"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data/timing/calib"))
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--no-fens", action="store_true", help="omit per-ply FENs (the big crawl)")
    ap.add_argument("--only", help="select.json: write only its games, with FENs, as select-games.jsonl")
    args = ap.parse_args()
    only: set[str] | None = None
    if args.only:
        with open(args.only) as f:
            only = set(json.load(f)["games"])
    with_fens = not args.no_fens or only is not None
    os.makedirs(args.out, exist_ok=True)
    seen: set[str] = set()

    def lines():
        with open(args.games) as f:
            for line in f:
                m = re.search(r'"uuid":"([^"]+)"', line)
                if m:
                    if m.group(1) in seen or (only is not None and m.group(1) not in only):
                        continue
                    seen.add(m.group(1))
                elif only is not None:
                    continue
                yield line

    summary: Counter = Counter()
    games = rows = 0
    corpus_name = "select-games.jsonl" if only is not None else "corpus.jsonl"
    labels_name = os.devnull if only is not None else os.path.join(args.out, "labels.jsonl.tmp")
    with open(os.path.join(args.out, corpus_name + ".tmp"), "w") as corpus, open(
        labels_name, "w"
    ) as labels, mp.Pool(args.workers, initializer=_init, initargs=(with_fens,)) as pool:
        for res in pool.imap(work, lines(), chunksize=16):
            if res is None:
                continue
            game, label_lines, keys = res
            corpus.write(game + "\n")
            for l in label_lines:
                labels.write(l + "\n")
            summary.update(keys)
            games += 1
            rows += len(label_lines)
            if games % 2000 == 0:
                print(f"{games} games, {rows} rows", file=sys.stderr, flush=True)
    os.replace(os.path.join(args.out, corpus_name + ".tmp"), os.path.join(args.out, corpus_name))
    if only is not None:
        print(f"{games} selected games -> {corpus_name}")
        return
    os.replace(os.path.join(args.out, "labels.jsonl.tmp"), os.path.join(args.out, "labels.jsonl"))
    cells = [
        {"tc": k[0], "band": k[1], "split": k[2], "situation": k[3], "rows": n} for k, n in sorted(summary.items())
    ]
    with open(os.path.join(args.out, "corpus-summary.json"), "w") as f:
        json.dump({"source": args.games, "games": games, "rows": rows, "cells": cells}, f, indent="\t")
    print(f"{games} games, {rows} labelled plies -> {args.out}")


if __name__ == "__main__":
    main()

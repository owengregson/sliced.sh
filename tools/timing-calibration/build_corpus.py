"""tools/timing-calibration/build_corpus.py: chess.com games to per-move human think times with
situation labels. This is the fast path of `build-corpus.ts`, which holds the same rules and
documents them. chess.js spends about 1.5 ms replaying one ply; python-chess spends about 0.1 ms.

    tools/data/.venv/bin/python tools/timing-calibration/build_corpus.py \
        [--games FILE] [--out DIR] [--workers 2]

It writes `corpus.jsonl` (one `CorpusGame` per game), `labels.jsonl` (one `LabelRow` per game and
ply) and `corpus-summary.json`. The field shapes are the TypeScript interfaces in `common.ts`.
`verify-labels.ts` recomputes the book and recapture labels of a sample with the shipped
TypeScript modules and fails if they disagree.

The rule constants are duplicated from the shipped registry: `BOOK.maxPly` 30,
`BOOK.minWeightShare` 0.01, `BOOK.gmBookElo` 1800, `MAIA.eloMax` 3000, the phase thresholds in
`src/core/chess/phase.ts`, and the premove and low-clock limits in `common.ts`. `verify-labels.ts`
checks them against the TypeScript.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing as mp
import os
import re
import sys
from collections import Counter

import chess
import chess.polyglot

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BOOK_DIR = os.path.join(ROOT, "assets", "books")
BOOK_MAX_PLY = 30
BOOK_MIN_WEIGHT_SHARE = 0.01
BOOK_GM_ELO = 1800
MAIA_ELO_MAX = 3000
THEORY_BOOKS = ("gm2600", "theory")
PREMOVE_MAX_MS = 200
LOW_CLOCK_FRACTION = 0.1
LOW_CLOCK_MS = 10_000
OPENING_MATERIAL = 62
OPENING_MAX_PLY = 20
ENDGAME_MATERIAL = 26
VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}

_books: dict[str, chess.polyglot.MemoryMappedReader] = {}


def book(name: str) -> chess.polyglot.MemoryMappedReader:
    if name not in _books:
        _books[name] = chess.polyglot.open_reader(os.path.join(BOOK_DIR, f"{name}.bin"))
    return _books[name]


def book_order(elo: int) -> tuple[str, ...]:
    return ("gm2600", "club", "theory") if elo >= BOOK_GM_ELO else ("club", "gm2600", "theory")


def bot_book_moves(board, ply: int, elo: int, key: int | None = None) -> set[str]:
    """`board` is a chess.Board; `key` its polyglot hash when already computed."""
    if ply > BOOK_MAX_PLY or elo > MAIA_ELO_MAX:
        return set()
    k = chess.polyglot.zobrist_hash(board) if key is None else key
    for name in book_order(elo):
        entries = [e for e in book(name).find_all(k) if e.weight > 0]
        if not entries:
            continue
        total = sum(e.weight for e in entries)
        return {_uci(board, e) for e in entries if e.weight >= BOOK_MIN_WEIGHT_SHARE * total}
    return set()


def _uci(board: chess.Board, entry) -> str:
    # A hash-keyed lookup returns raw polyglot moves; decode castling (king takes rook) the way
    # the board-keyed lookup does.
    m = entry.move
    return board._from_chess960(board.chess960, m.from_square, m.to_square, m.promotion).uci()


def theory_moves(board: chess.Board, key: int | None = None) -> set[str]:
    k = chess.polyglot.zobrist_hash(board) if key is None else key
    out: set[str] = set()
    for name in THEORY_BOOKS:
        out.update(_uci(board, e) for e in book(name).find_all(k) if e.weight > 0)
    return out


def split_for(player: str) -> str:
    return "fit" if hashlib.sha1(f"calib:{player.lower()}".encode()).digest()[0] < 154 else "holdout"


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


def balance(board: chess.Board, color: bool) -> int:
    total = 0
    for piece_type, v in VALUES.items():
        total += v * (len(board.pieces(piece_type, chess.WHITE)) - len(board.pieces(piece_type, chess.BLACK)))
    return total if color == chess.WHITE else -total


def phase_of(board: chess.Board, ply: int) -> str:
    npm = 0
    for pt in (chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN):
        npm += VALUES[pt] * (len(board.pieces(pt, chess.WHITE)) + len(board.pieces(pt, chess.BLACK)))
    if npm >= OPENING_MATERIAL:
        return "opening" if ply < OPENING_MAX_PLY else "middlegame"
    if npm <= ENDGAME_MATERIAL:
        return "endgame"
    return "middlegame"


def situation_of(only_legal: bool, in_book: bool, obvious: bool, in_check: bool) -> str:
    if only_legal:
        return "forced"
    if in_book:
        return "book"
    if obvious:
        return "recapture"
    if in_check:
        return "check"
    return "ordinary"


WITH_FENS = True


def corpus_game(g: dict):
    tc = g.get("time_class")
    if tc not in ("bullet", "blitz", "rapid"):
        return None
    parsed = parse_control(g["time_control"])
    if not parsed:
        return None
    base_ms = int(round(parsed[0] * 1000))
    inc_ms = int(round(parsed[1] * 1000))
    sans, clocks = parse_pgn(g["pgn"])
    if not sans or all(c is None for c in clocks):
        return None
    board = chess.Board()
    fens = [board.fen()] if WITH_FENS else []
    ucis: list[str] = []
    per_ply = []
    balances = []  # material balance (white POV) before each ply, plus the final one
    try:
        for ply_i, san in enumerate(sans):
            move = board.parse_san(san)
            n_legal = board.legal_moves.count()
            in_check = board.is_check()
            capture = board.is_capture(move)
            balances.append(balance(board, chess.WHITE))
            book_key = chess.polyglot.zobrist_hash(board) if ply_i <= BOOK_MAX_PLY else None
            per_ply.append(
                {
                    "n_legal": n_legal,
                    "in_check": in_check,
                    "capture": capture,
                    "move": move,
                    "phase": phase_of(board, ply_i),
                    "gives_check": board.gives_check(move),
                    "key": book_key,
                    "board": board.copy(stack=False) if book_key is not None else None,
                    "captures_on": None,
                }
            )
            board.push(move)
            ucis.append(move.uci())
            if WITH_FENS:
                fens.append(board.fen())
        balances.append(balance(board, chess.WHITE))
    except ValueError:
        return None

    def captures_on(ply: int) -> int:
        """How many of the mover's pieces can capture on the square their move lands on."""
        rec = per_ply[ply]
        if rec["captures_on"] is None:
            b = _board_before(ply)
            to_sq = rec["move"].to_square
            rec["captures_on"] = len({m.from_square for m in b.legal_moves if m.to_square == to_sq and b.is_capture(m)})
        return rec["captures_on"]

    def _board_before(ply: int) -> chess.Board:
        b = chess.Board()
        for m in per_ply[:ply]:
            b.push(m["move"])
        return b

    def clock_after(ply: int):
        return base_ms if ply < 0 else clocks[ply] if ply < len(clocks) else None

    players = {}
    for key, side in (("w", g["white"]), ("b", g["black"])):
        name = side["username"].lower()
        kept = g.get("whiteKept" if key == "w" else "blackKept", True)
        players[key] = {"player": name, "rating": side["rating"], "split": split_for(name), "kept": bool(kept)}

    plies = []
    for ply in range(len(ucis)):
        color_key = "w" if ply % 2 == 0 else "b"
        color = chess.WHITE if color_key == "w" else chess.BLACK
        c_before = clock_after(ply - 2)
        opp_clock = clock_after(ply - 1)
        after = clock_after(ply)
        if c_before is None or opp_clock is None or after is None:
            continue
        think = max(0, c_before - after + inc_ms)
        opp_before = clock_after(ply - 3)
        opp_think = max(0, opp_before - opp_clock + inc_ms) if ply >= 1 and opp_before is not None else None
        rec = per_ply[ply]
        in_check = rec["in_check"]
        capture = rec["capture"]
        move = rec["move"]
        prev = per_ply[ply - 1] if ply >= 1 else None
        prev_to = prev["move"].to_square if prev else None
        prev_capture = prev["capture"] if prev else False
        recapture_any = capture and prev_to is not None and move.to_square == prev_to
        obvious = False
        if recapture_any and prev_capture:
            sign = 1 if color == chess.WHITE else -1
            obvious = sign * balances[ply + 1] >= sign * balances[ply - 1]
        only_recapture = recapture_any and captures_on(ply) == 1
        elo = players[color_key]["rating"]
        uci = move.uci()
        in_book = rec["key"] is not None and uci in bot_book_moves(rec["board"], ply, elo, rec["key"])
        in_theory = rec["key"] is not None and uci in theory_moves(rec["board"], rec["key"])
        only_legal = rec["n_legal"] == 1
        clock_frac = c_before / base_ms if base_ms > 0 else 1.0
        gives_check = rec["gives_check"]
        plies.append(
            {
                "ply": ply,
                "clockMs": c_before,
                "oppClockMs": opp_clock,
                "thinkMs": think,
                "oppThinkMs": opp_think,
                "first": ply < 2,
                "situation": situation_of(only_legal, in_book, obvious, in_check),
                "inBook": in_book,
                "inTheory": in_theory,
                "onlyLegal": only_legal,
                "inCheck": in_check,
                "recaptureAny": recapture_any,
                "obviousRecapture": obvious,
                "onlyRecapture": only_recapture,
                "capture": capture,
                "givesCheck": gives_check,
                "legalMoves": rec["n_legal"],
                "phase": rec["phase"],
                "clockFrac": clock_frac,
                "lowClock": clock_frac < LOW_CLOCK_FRACTION or c_before < LOW_CLOCK_MS,
            }
        )
    if not plies:
        return None
    return {
        "gameId": g["uuid"],
        "tc": tc,
        "control": g["time_control"],
        "baseMs": base_ms,
        "incMs": inc_ms,
        "w": players["w"],
        "b": players["b"],
        "ucis": ucis,
        "fens": fens if WITH_FENS else [],
        "plies": plies,
    }


LABEL_KEYS = (
    "thinkMs", "clockMs", "oppClockMs", "first", "situation", "inBook", "inTheory", "onlyLegal",
    "inCheck", "recaptureAny", "obviousRecapture", "onlyRecapture", "capture", "phase", "lowClock",
)


def labels_of(game: dict):
    out = []
    for p in game["plies"]:
        side = game["w"] if p["ply"] % 2 == 0 else game["b"]
        row = {
            "gameId": game["gameId"],
            "ply": p["ply"],
            "color": "w" if p["ply"] % 2 == 0 else "b",
            "player": side["player"],
            "rating": side["rating"],
            "tc": game["tc"],
            "control": game["control"],
            "split": side["split"],
            "kept": side["kept"],
        }
        for k in LABEL_KEYS:
            row[k] = p[k]
        row["premove"] = p["thinkMs"] <= PREMOVE_MAX_MS
        out.append(row)
    return out


def _init(with_fens: bool) -> None:
    global WITH_FENS
    WITH_FENS = with_fens


def work(line: str):
    line = line.strip()
    if not line:
        return None
    try:
        g = json.loads(line)
        game = corpus_game(g)
    except Exception:  # noqa: BLE001 — one malformed game must not stop the corpus
        return None
    if game is None:
        return None
    return json.dumps(game, separators=(",", ":")), [json.dumps(l, separators=(",", ":")) for l in labels_of(game)], [
        (l["tc"], l["rating"] // 100 * 100, l["split"], l["situation"]) for l in labels_of(game)
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", default=os.path.join(ROOT, "data/calibration/games.jsonl"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data/timing/calib"))
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--no-fens", action="store_true", help="omit per-ply FENs (the big crawl)")
    ap.add_argument("--only", help="select.json: write only its games, with FENs, as select-games.jsonl")
    args = ap.parse_args()
    global WITH_FENS
    only: set[str] | None = None
    if args.only:
        with open(args.only) as f:
            only = set(json.load(f)["games"])
    WITH_FENS = not args.no_fens or only is not None
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
    ) as labels, mp.Pool(args.workers, initializer=_init, initargs=(WITH_FENS,)) as pool:
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

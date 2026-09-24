"""One chess.com game to its corpus record (`CorpusGame` in `common.ts`) and its `labels.jsonl`
rows: the thinks, the situation and every per-ply label. `WITH_FENS` is set per worker process
(`build_corpus.py`): the big crawl's corpus omits the per-ply FENs."""
from __future__ import annotations

import chess
import chess.polyglot
from datalib.splits import split_for

from .books import BOOK_MAX_PLY, bot_book_moves, theory_moves
from .pgn import parse_control, parse_pgn

PREMOVE_MAX_MS = 200
LOW_CLOCK_FRACTION = 0.1
LOW_CLOCK_MS = 10_000
OPENING_MATERIAL = 62
OPENING_MAX_PLY = 20
ENDGAME_MATERIAL = 26
VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}


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

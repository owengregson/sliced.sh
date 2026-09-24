"""The shipped Polyglot books (`assets/books/`): the moves the bot's own book would play for a
player of a rating (`bookOrderFor`), and the theory moves (`THEORY_BOOKS`, the review's Book)."""
from __future__ import annotations

import os

import chess
import chess.polyglot

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
BOOK_DIR = os.path.join(ROOT, "assets", "books")
BOOK_MAX_PLY = 30
BOOK_MIN_WEIGHT_SHARE = 0.01
BOOK_GM_ELO = 1800
MAIA_ELO_MAX = 3000
THEORY_BOOKS = ("gm2600", "theory")

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

"""
scripts/polyglot_book.py — the Polyglot book format and build-manifest I/O shared by
`scripts/build-club-book.py` and `scripts/build-theory-book.py`.

A book is a key-sorted array of 16-byte big-endian entries `{key, move, weight, learn}`: `key` is
the standard Polyglot Zobrist hash (`chess.polyglot.zobrist_hash`), `move` the 16-bit encoding
below, `weight` at most 16 bits. Next to every book a `<book>.build.json` manifest records how it
was built; `scripts/vendor-engine.ts` renders `docs/third-party.md` from those manifests.
"""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

import chess

ENTRY = struct.Struct(">QHHI")
MAX_WEIGHT = 0xFFFF


def encode_move(board: chess.Board, move: chess.Move) -> int:
    """Polyglot 16-bit move: castling stored as king-takes-rook."""
    to_square = move.to_square
    if board.is_castling(move):
        rank = chess.square_rank(move.from_square)
        to_square = chess.square(7 if chess.square_file(move.to_square) > 4 else 0, rank)
    promo = 0
    if move.promotion:
        promo = {chess.KNIGHT: 1, chess.BISHOP: 2, chess.ROOK: 3, chess.QUEEN: 4}[move.promotion]
    return (
        chess.square_file(to_square)
        | (chess.square_rank(to_square) << 3)
        | (chess.square_file(move.from_square) << 6)
        | (chess.square_rank(move.from_square) << 9)
        | (promo << 12)
    )


def sha256_file(path: Path) -> str:
    """SHA-256 of a file, read in 1 MiB chunks (inputs run to tens of GiB)."""
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_path(output: Path) -> Path:
    """`<book>.build.json` next to the book."""
    return output.with_name(output.name + ".build.json")


def write_manifest(output: Path, manifest: dict) -> Path:
    """Write the book's build manifest (2-space JSON, trailing newline); returns its path."""
    path = manifest_path(output)
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return path

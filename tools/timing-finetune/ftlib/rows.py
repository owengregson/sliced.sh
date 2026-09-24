"""One chess.com game to its training/evaluation examples: every move with a clock comment,
encoded exactly as the extension encodes the inference inputs for that position (`cmenc.py`),
with its think label and side facts. A game with an impossible clock increase (upstream's
`isValidClockIncrease`) or an unparsable move yields nothing."""
from __future__ import annotations

import chess

import cmenc

from .pgn import book_depth, parse_game


def game_rows(line: str, min_rating: float, keep_text: bool = False):
    parsed = parse_game(line)
    if parsed is None:
        return None
    g, tc, base, inc, sans, clocks = parsed
    board = chess.Board()
    depth = book_depth(g["pgn"])
    prev = [base, base]  # clock before the move, per colour (0 white, 1 black)
    last = [base, base]  # latest clock, per colour
    first = [True, True]
    history: list[str] = []
    rows = []
    prev_move: chess.Move | None = None
    prev_capture = False
    for ply, san in enumerate(sans):
        try:
            move = board.parse_san(san)
        except ValueError:
            return None
        side = 0 if board.turn == chess.WHITE else 1
        clk = clocks[ply]
        uci = move.uci()
        if clk is not None:
            if not first[side]:
                inc_up = clk - prev[side]
                if (inc == 0 and inc_up > 0) or (inc > 0 and inc_up >= 2 * inc):
                    return None
            info = g["white" if side == 0 else "black"]
            rating = float(info.get("rating") or 0)
            if rating >= min_rating:
                think = max(0.0, prev[side] + inc - clk)
                is_cap = board.is_capture(move)
                recap = int(prev_capture and is_cap and prev_move is not None and move.to_square == prev_move.to_square)
                fen = board.fen(en_passant="fen")
                row = (
                        cmenc.encode_recent_moves(history) + cmenc.tokenize_fen(fen),
                        cmenc.MOVE_TO_ACTION.get(uci, cmenc.PAD_TOKEN),
                        rating,
                        prev[side],
                        last[1 - side],
                        inc,
                        think,
                        ply,
                        info["username"],
                        (-1 if depth < 0 else int(ply < depth)),
                        recap,
                        board.legal_moves.count(),
                        int(bool(g.get("whiteKept" if side == 0 else "blackKept", True))),
                )
                rows.append(row + (fen, list(history), uci) if keep_text else row)
            prev[side] = clk
            last[side] = clk
            first[side] = False
        prev_capture = board.is_capture(move)
        prev_move = move
        board.push(move)
        history.append(uci)
    return g, tc, rows

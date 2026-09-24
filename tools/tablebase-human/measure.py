"""Measure human accuracy in <=5-man tablebase positions by rating bucket.

usage: SYZYGY_DIR=<3-4-5 tables> python measure.py <source-label> <out.csv> <pgn-file|-> [max_games]
Needs `pip install chess`. Evidence for docs/qa/endgame-tablebases-2026-09-23.md.
Reads PGN text (stdin when '-'), keeps games with >= 25 captures, walks every position with
<= 5 men and no castling rights, probes local Syzygy tables and writes one row per move.
"""
import csv
import io
import re
import sys

import chess
import chess.pgn
import chess.syzygy

import os

TB = chess.syzygy.open_tablebase(os.environ.get("SYZYGY_DIR", "syzygy"))
label, out_path, src = sys.argv[1], sys.argv[2], sys.argv[3]
max_games = int(sys.argv[4]) if len(sys.argv) > 4 else 10**9

def zeroing_plies(board, move):
    """plies to next zeroing from root after `move`, and mover's wdl after move (5-level)."""
    zero = board.is_zeroing(move)
    board.push(move)
    try:
        if board.is_checkmate():
            return 0, 2
        wdl = -TB.probe_wdl(board)
        if zero:
            return 1, wdl
        dtz = TB.probe_dtz(board)
        return abs(dtz) + 1, wdl
    finally:
        board.pop()

def tier(wdl, zp):
    # higher is better
    if wdl == 2:
        return (4, -zp)
    if wdl == 1:
        return (3, 0)
    if wdl == 0:
        return (2, 0)
    if wdl == -1:
        return (1, 0)
    return (0, zp)

def games_text(stream):
    buf = []
    for line in stream:
        if line.startswith("[Event ") and buf:
            yield "".join(buf)
            buf = []
        buf.append(line)
    if buf:
        yield "".join(buf)

HDR = re.compile(r'^\[(\w+) "([^"]*)"\]', re.M)
stream = sys.stdin if src == "-" else open(src, encoding="utf-8", errors="replace")
out = open(out_path, "w", newline="")
w = csv.writer(out)
w.writerow(["src", "game", "elo", "opp", "tc", "result", "color", "men", "wdl", "played_wdl", "optimal", "keeps", "halfmove", "nlegal", "nbest", "nkeep"])
seen = kept = 0
for text in games_text(stream):
    seen += 1
    if seen > max_games:
        break
    body = text.split("\n\n", 1)[-1]
    if body.count("x") < 25:
        continue
    hdr = dict(HDR.findall(text))
    try:
        we, be = int(hdr.get("WhiteElo", "")), int(hdr.get("BlackElo", ""))
    except ValueError:
        continue
    tcs = hdr.get("TimeControl", "-")
    try:
        base, inc = (int(x) for x in tcs.split("+"))
        tc = base + 40 * inc
    except ValueError:
        tc = -1
    game = chess.pgn.read_game(io.StringIO(text))
    if game is None:
        continue
    kept += 1
    board = game.board()
    for move in game.mainline_moves():
        men = chess.popcount(board.occupied)
        if men <= 5 and not board.castling_rights and not board.is_game_over():
            try:
                wdl = TB.probe_wdl(board)
                scored = []
                for m in board.legal_moves:
                    zp, mw = zeroing_plies(board, m)
                    scored.append((tier(mw, zp), m, mw))
                best = max(s[0] for s in scored)
                played = next(s for s in scored if s[1] == move)
                keeps = played[0][0] >= best[0]
                optimal = played[0] == best
                nbest = sum(1 for s in scored if s[0] == best)
                nkeep = sum(1 for s in scored if s[0][0] >= best[0])
                white = board.turn == chess.WHITE
                w.writerow([label, seen, we if white else be, be if white else we, tc, hdr.get("Result", "*"),
                            "w" if white else "b", men, wdl, played[2], int(optimal), int(keeps), board.halfmove_clock, len(scored), nbest, nkeep])
            except (KeyError, chess.syzygy.MissingTableError):
                pass
        board.push(move)
print(label, "games seen", seen, "parsed", kept, file=sys.stderr)

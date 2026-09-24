#!/usr/bin/env python3
"""chess.com games (StoredGame JSONL with [%clk]) → ChessMimic training/evaluation examples.

One example per move that has a clock comment, encoded exactly as the extension encodes the
inference inputs for that position (`cmenc.py`; parity: `test_parity.py`):

  ids        uint16 [N, 90]  12 history-move tokens (moves before the position) + 78 FEN tokens
  cur        uint16 [N]      the played move's token (PAD if outside the vocabulary)
  rating     float32         the mover's chess.com rating
  pclock     float32         mover's clock before the move (s)   = inference `playerClockS`
  oclock     float32         opponent's clock at that moment (s) = inference `opponentClockS`
  inc        float32         increment (s)
  think      float32         prev_clock + increment − clock (s), clamped at 0 (upstream's label)
  ply, game, player (int32 ids into the sidecar), tc (0 bullet/1 blitz/2 rapid), split (0 fit / 1 holdout),
  book (1 inside chess.com's named opening line, 0 after it, −1 unknown depth),
  recap (the move captures on the square the opponent just captured on), legal (legal-move count),
  kept (the crawl's per-player side cap kept this side: `whiteKept`/`blackKept`, 1 when absent).

Games with a non-standard start, daily games, or an impossible clock increase (upstream's
`isValidClockIncrease`) are skipped whole. Unparsable JSON lines (a crawl still being appended
to) are skipped.

Usage: extract.py --games <games.jsonl> --out <dir> [--min-rating 0] [--workers 4]
"""
from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import re
import sys
from pathlib import Path

import chess
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cmenc  # noqa: E402

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


def work(args):
    lines, min_rating = args
    out = []
    for line in lines:
        r = game_rows(line, min_rating)
        if r is not None and r[2]:
            g, tc, rows = r
            out.append((g["uuid"], g.get("end_time", 0), tc, rows))
    return out


def chunks(path: Path, size: int, limit: int | None):
    buf = []
    n = 0
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if not line.endswith("\n"):
                break  # partial last line of a growing file
            buf.append(line)
            n += 1
            if len(buf) >= size:
                yield buf
                buf = []
            if limit and n >= limit:
                break
    if buf:
        yield buf


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-rating", type=float, default=0)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--kept-only", action="store_true", help="drop sides the crawl did not keep")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    keys = ("ids", "cur", "rating", "pclock", "oclock", "inc", "think", "ply", "game", "player", "tc", "split", "book", "recap", "legal", "kept")
    dtypes = {"ids": np.uint16, "cur": np.uint16, "rating": np.float32, "pclock": np.float32, "oclock": np.float32, "inc": np.float32, "think": np.float32,
              "ply": np.int16, "game": np.int32, "player": np.int32, "tc": np.int8, "split": np.int8, "book": np.int8, "recap": np.int8, "legal": np.int16, "kept": np.int8}
    # Stream every column to a raw file as chunks arrive; wrap them as .npy at the end
    # (loaders memory-map them), so RAM stays bounded whatever the crawl's size.
    raw_dir = out / "examples.tmp"
    raw_dir.mkdir(exist_ok=True)
    raw = {k: open(raw_dir / f"{k}.bin", "wb") for k in keys}
    games: list[dict] = []
    players: dict[str, int] = {}
    split_of: dict[str, int] = {}
    seen: set[str] = set()
    total = 0
    with mp.Pool(args.workers) as pool:
        for result in pool.imap(work, ((c, args.min_rating) for c in chunks(Path(args.games), 500, args.limit))):
            cols = {k: [] for k in keys}
            for uuid, end_time, tc, rows in result:
                if uuid in seen:
                    continue
                seen.add(uuid)
                gi = len(games)
                games.append({"uuid": uuid, "end_time": end_time})
                for ids, cur, rating, pc, oc, inc, think, ply, user, book, recap, legal, kept in rows:
                    if args.kept_only and not kept:
                        continue
                    key = user.lower()
                    pid = players.setdefault(key, len(players))
                    if key not in split_of:
                        split_of[key] = 0 if cmenc.split_for(key) == "fit" else 1
                    for k, v in zip(keys, (ids, cur, rating, pc, oc, inc, think, ply, gi, pid, tc, split_of[key], book, recap, legal, kept)):
                        cols[k].append(v)
            for k in keys:
                raw[k].write(np.asarray(cols[k], dtype=dtypes[k]).tobytes())
            total += len(cols["ply"])
            print(f"\r{len(games):,} games, {total:,} rows", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)
    for f in raw.values():
        f.close()
    exdir = out / "examples"
    exdir.mkdir(exist_ok=True)
    for k in keys:
        shape = (total, 90) if k == "ids" else (total,)
        src = np.memmap(raw_dir / f"{k}.bin", dtype=dtypes[k], mode="r", shape=shape) if total else np.zeros(shape, dtypes[k])
        dst = np.lib.format.open_memmap(exdir / f"{k}.npy", mode="w+", dtype=dtypes[k], shape=shape)
        for i in range(0, total, 1 << 20):
            dst[i : i + (1 << 20)] = src[i : i + (1 << 20)]
        dst.flush()
        del src, dst
        (raw_dir / f"{k}.bin").unlink()
    raw_dir.rmdir()
    arrays = {"ply": np.load(exdir / "ply.npy", mmap_mode="r")}
    names = sorted(players, key=players.get)
    (out / "players.json").write_text(json.dumps(names))
    (out / "games.json").write_text(json.dumps(games))
    print(f"wrote {out}: {len(games):,} games, {len(arrays['ply']):,} rows, {len(names):,} players")
    return 0


if __name__ == "__main__":
    sys.exit(main())

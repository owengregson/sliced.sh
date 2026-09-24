#!/usr/bin/env python3
"""Export six ChessMimic clock bands with the pinned upstream checkpoint and tokenizer.

Each band produces an ONNX graph (opset 14), its own rating/clock scalers and 30-bin
clock distribution. The 0_1000 band uses wider clock buckets than the other bands;
consumers must decode with the returned band's metadata.

Most large weights are stored in fp16 behind Cast to fp32. For 1500_1600, attention
output projections retain their original fp32 precision because the six-band
fixture otherwise exceeds the runtime's 0.002 probability tolerance. The default
export fails instead of registering a file above that tolerance. Dynamic int8 is
available for experiments but does not satisfy the shipping precision gate.

The fixture uses the upstream tokenizer and fp32 checkpoint probabilities, with
containing-range then fitted-rating-mean band selection. Package compression is a
separate, lossless build step in scripts/model-packing.ts; canonical ONNX hashes
refer to the outputs of this script, not the compressed extension assets.

Upstream: https://github.com/thomasj02/1e4_ai, PolyForm Noncommercial 1.0.0.
The clone and verified LFS checkpoint cache are git-ignored under tools/data/upstream.
Run from the repository root:
    uv venv --python 3.12 tools/data/.venv
    VIRTUAL_ENV=tools/data/.venv uv pip install torch onnx onnxruntime numpy chess
    tools/data/.venv/bin/python tools/data/08_export_chessmimic.py

The shipped 2200_3500 band is fine-tuned (docs/models.md §9) and exported by
tools/timing-finetune/export.py; running this script for that band restores upstream's weights,
scaler and fixture rows.

Provenance, measured precision, packaging and runtime checks: docs/models.md.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import pickle
import random
import sys
import urllib.request
from pathlib import Path

from datalib.hashing import sha256_bytes, sha256_file
from datalib.onnx_fp16 import to_fp16_weights as fp16_weights
from datalib.upstream import ensure_clone

ROOT = Path(__file__).resolve().parents[2]

UPSTREAM_REPO = "https://github.com/thomasj02/1e4_ai"
PINNED_COMMIT = "8fcca2319e828b9d14b8def5c3ee9bc8bf1e3f12"
UPSTREAM_LICENSE = "PolyForm-Noncommercial-1.0.0"
LFS_BATCH_URL = f"{UPSTREAM_REPO}.git/info/lfs/objects/batch"
CLOCK_MODEL_DIR = "backend/models/clock_model"
DEFAULT_BANDS = ["0_1000", "1200_1300", "1500_1600", "1800_1900", "2000_2100", "2200_3500"]

# Architecture (Training/ClockTrainer.py, backend/clock_inference.py).
RECENT_MOVES = 12
EMBEDDING_DIM = 256
WIDENING = 4
LAYERS = 8
HEADS = 8
N_BUCKETS = 30
OPSET = 14
FP16_MIN_ELEMENTS = 1024
# The six-band fixture exceeds 0.002 with this band's attention projections in fp16.
FP32_ATTENTION_BANDS = {"1500_1600"}
EXPECTED_PARAMS = 8_950_558

SCALER_KEYS = ("rating", "log_player_clock", "log_opponent_clock", "log_increment")


# ── upstream clone and LFS ────────────────────────────────────────────────────────────────────


def parse_lfs_pointer(path: Path) -> tuple[str, int]:
    text = path.read_text(encoding="utf-8", errors="strict")
    oid = size = None
    for line in text.splitlines():
        if line.startswith("oid sha256:"):
            oid = line.split(":", 1)[1].strip()
        elif line.startswith("size "):
            size = int(line.split()[1])
    if not oid or size is None:
        raise SystemExit(f"{path} is not a Git LFS pointer")
    return oid, size


def fetch_checkpoint(upstream: Path, band: str, cache: Path) -> tuple[Path, str]:
    pointer = upstream / CLOCK_MODEL_DIR / f"{band}_brier" / "model.ckpt"
    if pointer.stat().st_size > 1024:  # already smudged by git-lfs
        return pointer, sha256_file(pointer)
    oid, size = parse_lfs_pointer(pointer)
    cache.mkdir(parents=True, exist_ok=True)
    dest = cache / f"{band}_brier.model.ckpt"
    if dest.exists() and dest.stat().st_size == size and sha256_file(dest) == oid:
        print(f"{band}: checkpoint present and verified ({size:,} bytes)")
        return dest, oid
    print(f"{band}: fetching checkpoint {oid[:12]}… ({size:,} bytes) through the LFS batch API")
    body = json.dumps({"operation": "download", "transfers": ["basic"], "objects": [{"oid": oid, "size": size}]}).encode()
    req = urllib.request.Request(LFS_BATCH_URL, data=body, headers={"Accept": "application/vnd.git-lfs+json", "Content-Type": "application/vnd.git-lfs+json"})
    with urllib.request.urlopen(req) as res:
        batch = json.load(res)
    href = batch["objects"][0]["actions"]["download"]["href"]
    with urllib.request.urlopen(href) as res:
        data = res.read()
    if len(data) != size or sha256_bytes(data) != oid:
        raise SystemExit(f"{band}: LFS download does not match the pointer ({len(data)} bytes)")
    dest.write_bytes(data)
    return dest, oid


def load_upstream_tokenizer(upstream: Path):
    spec = importlib.util.spec_from_file_location("chessmimic_tokenizer", upstream / "Training" / "tokenizer.py")
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load Training/tokenizer.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if module.SEQUENCE_LENGTH != 78 or module.INPUT_VOCAB_SIZE != 33 or module.NUM_ACTIONS != 1968:
        raise SystemExit("upstream tokenizer constants changed; update the extension's registry")
    return module


def prepare_recent_moves_tokens(moves: list[str], move_to_action: dict[str, int], pad: int) -> list[int]:
    """`chessmimic_core.prepare_recent_moves_tokens`: last 12 moves, left-padded with PAD_TOKEN."""
    window = moves[-RECENT_MOVES:]
    tokens = [pad] * RECENT_MOVES
    for i, move in enumerate(window):
        if move not in move_to_action:
            raise ValueError(f"Invalid move: {move}")
        tokens[RECENT_MOVES - len(window) + i] = move_to_action[move]
    return tokens


# ── model ─────────────────────────────────────────────────────────────────────────────────────


def build_model(torch, nn, F):
    class MlpBlock(nn.Module):
        def __init__(self, input_size, hidden_size, output_size):
            super().__init__()
            self.layer_norm = nn.LayerNorm(input_size)
            self.split1_linear = nn.Linear(input_size, hidden_size, bias=False)
            self.split2_linear = nn.Linear(input_size, hidden_size, bias=False)
            self.activation = nn.SiLU()
            self.join_linear = nn.Linear(hidden_size, output_size, bias=False)

        def forward(self, x):
            x = self.layer_norm(x)
            return self.join_linear(self.activation(self.split1_linear(x)) * self.split2_linear(x))

    class AttentionBlock(nn.Module):
        def __init__(self, input_size, num_heads):
            super().__init__()
            self.layer_norm = nn.LayerNorm(input_size)
            self.self_attention = nn.MultiheadAttention(embed_dim=input_size, num_heads=num_heads, batch_first=True)

        def forward(self, x):
            x = self.layer_norm(x)
            return self.self_attention(query=x, key=x, value=x, need_weights=False)[0]

    class ClockPatzerModel(nn.Module):
        """`ClockTrainer.ClockPatzerModel` with the softmax folded in and int32 ids accepted."""

        def __init__(self, board_sequence_length, board_input_vocab_size, recent_moves_vocab_size):
            super().__init__()
            d = EMBEDDING_DIM
            self.board_embedding = nn.Embedding(board_input_vocab_size, d)
            self.rating_embedding = nn.Linear(1, d)
            self.clock_time_embedding = nn.Linear(3, d)
            self.recent_moves_embedding = nn.Embedding(recent_moves_vocab_size, d)
            self.learned_positional_encoding = nn.Parameter(torch.randn(RECENT_MOVES + board_sequence_length + 2, d))
            self.mlp_blocks = nn.ModuleList([MlpBlock(d, d * WIDENING, d) for _ in range(LAYERS)])
            self._attention_blocks = nn.ModuleList([AttentionBlock(d, HEADS) for _ in range(LAYERS)])
            self.layer_norm = nn.LayerNorm(d)
            self.time_classifier = nn.Linear(d, N_BUCKETS)

        def forward(self, input_ids, scaled_rating, clock_features):
            ids = input_ids.long()
            recent_moves = self.recent_moves_embedding(ids[:, :RECENT_MOVES])
            board = self.board_embedding(ids[:, RECENT_MOVES:])
            embedded_rating = self.rating_embedding(scaled_rating.unsqueeze(1)).unsqueeze(1)
            embedded_clock = self.clock_time_embedding(clock_features).unsqueeze(1)
            x = torch.cat([recent_moves, embedded_rating, embedded_clock, board], dim=1)
            x = x + self.learned_positional_encoding
            for mlp_block, attention_block in zip(self.mlp_blocks, self._attention_blocks):
                x = x + attention_block(x)
                x = x + mlp_block(x)
            x = self.layer_norm(x)[:, -1, :]
            return F.softmax(self.time_classifier(x), dim=1)

    return ClockPatzerModel


def load_checkpoint(torch, model, ckpt_path: Path) -> None:
    checkpoint = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    state = checkpoint.get("state_dict", checkpoint)
    cleaned = {}
    for k, v in state.items():
        if k.startswith("model."):
            k = k[6:]
        if k.startswith("_orig_mod."):
            k = k[10:]
        cleaned[k] = v
    model.load_state_dict(cleaned, strict=True)
    n = sum(p.numel() for p in model.parameters())
    if n != EXPECTED_PARAMS:
        raise SystemExit(f"parameter count {n} != {EXPECTED_PARAMS}")
    model.eval()


def export_onnx(torch, model, fen_len: int) -> bytes:
    import io

    ids = torch.zeros((1, RECENT_MOVES + fen_len), dtype=torch.int32)
    rating = torch.zeros((1,), dtype=torch.float32)
    clocks = torch.zeros((1, 3), dtype=torch.float32)
    buf = io.BytesIO()
    torch.onnx.export(
        model,
        (ids, rating, clocks),
        buf,
        opset_version=OPSET,
        dynamo=False,
        do_constant_folding=True,
        input_names=["input_ids", "scaled_rating", "clock_features"],
        output_names=["probs"],
        dynamic_axes={"input_ids": {0: "batch"}, "scaled_rating": {0: "batch"}, "clock_features": {0: "batch"}, "probs": {0: "batch"}},
    )
    return buf.getvalue()


def to_fp16_weights(onnx, np, model_bytes: bytes, keep_attention_fp32: bool = False) -> tuple[bytes, int]:
    """fp16 weights behind Cast; `keep_attention_fp32` leaves the attention output projections in
    fp32 (the band's fixture otherwise exceeds the runtime tolerance)."""
    return fp16_weights(
        onnx,
        np,
        model_bytes,
        FP16_MIN_ELEMENTS,
        lambda name: keep_attention_fp32 and ".self_attention.out_proj.weight" in name,
    )


def to_int8(model_bytes: bytes, workdir: Path, band: str) -> bytes:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    src = workdir / f"{band}.fp32.onnx"
    dst = workdir / f"{band}.int8.onnx"
    src.write_bytes(model_bytes)
    quantize_dynamic(str(src), str(dst), weight_type=QuantType.QInt8)
    return dst.read_bytes()


# ── side files ─────────────────────────────────────────────────────────────────────────────────


def read_scalers(path: Path) -> dict:
    with open(path, "rb") as fh:
        raw = pickle.load(fh)
    out = {}
    for key in SCALER_KEYS:
        out[key] = {"mean": float(raw[key]["mean"]), "std": float(raw[key]["std"])}
    return out


def read_buckets(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)  # accepts the bare `Infinity` token the upstream file uses
    boundaries = [None if (b is None or math.isinf(b)) else float(b) for b in raw["boundaries"]]
    if len(boundaries) != raw["n_buckets"] + 1 or raw["n_buckets"] != N_BUCKETS:
        raise SystemExit(f"{path}: unexpected bucket layout")
    return {
        "boundaries": boundaries,
        "n_buckets": raw["n_buckets"],
        "scheme": raw["scheme"],
        "time_control": raw["time_control"],
        "bucket_probabilities": raw["bucket_probabilities"],
        "bucket_empirical_distributions": raw["bucket_empirical_distributions"],
        "statistics": raw["statistics"],
    }


def band_centre(band: str) -> float:
    lo, hi = band.split("_")
    return (int(lo) + int(hi)) / 2


def band_range(band: str) -> tuple[float, float]:
    lo, hi = band.split("_")
    return float(lo), float(hi)


def select_band(rating: float, bands: list[str], scalers: dict | None = None) -> str:
    """Containing training range first, then nearest fitted rating mean for gaps."""
    for band in bands:
        lo, hi = band_range(band)
        if lo <= rating <= hi:
            return band
    best, best_d = bands[0], float("inf")
    for band in bands:
        centre = scalers[band]["rating"]["mean"] if scalers and band in scalers else band_centre(band)
        d = abs(rating - centre)
        if d < best_d:
            best, best_d = band, d
    return best


# ── fixture ────────────────────────────────────────────────────────────────────────────────────

INCREMENTS = [0, 0, 0, 1, 2, 3, 5, 10, 15]
UNTIMED_VIRTUAL = (300.0, 300.0, 0.0)


def random_game(chess, rng: random.Random, max_plies: int) -> tuple[list[str], object]:
    """A random legal game (captures preferred half the time, promotions always) as UCI moves."""
    board = chess.Board()
    moves: list[str] = []
    for _ in range(max_plies):
        legal = list(board.legal_moves)
        if not legal or board.is_game_over():
            break
        promotions = [m for m in legal if m.promotion]
        captures = [m for m in legal if board.is_capture(m)]
        if promotions:
            move = rng.choice(promotions)
        elif captures and rng.random() < 0.5:
            move = rng.choice(captures)
        else:
            move = rng.choice(legal)
        board.push(move)
        moves.append(move.uci())
    return moves, board


def rating_draw(bands: list[str]) -> tuple[float, float, list[float]]:
    """Where the fixture's ratings come from, derived from the exported bands so that **every**
    band gets rows (a band with no row would ship without a
    torch-fp32 parity reference). The draw runs from a little below the lowest band to a little
    above the highest band's *centre* — nothing above the top centre can select a different band,
    and the top band's own range is 1 300 Elo wide. The two returned outliers sit outside every
    band so `standardise`'s clamp is exercised at both ends."""
    lo = min(band_range(b)[0] for b in bands) - 100.0
    hi = max(band_centre(b) for b in bands) + 100.0
    return lo, hi, [lo - 300.0, max(band_range(b)[1] for b in bands) + 300.0]


def generate_positions(chess, rng: random.Random, n: int, bands: list[str], scalers: dict | None = None) -> list[dict]:
    records: list[dict] = []
    # Deterministic edge cases: no history, short windows around the 12-move boundary,
    # three-digit halfmove / fullmove counters, extreme ratings.
    starts = [0, 1, 2, 11, 12, 13, 24]
    lo_rating, hi_rating, outliers = rating_draw(bands)
    while len(records) < n:
        moves, board = random_game(chess, rng, rng.randint(2, 180))
        if not moves:
            continue
        k = len(records)
        if k < len(starts):
            cut = min(starts[k], len(moves))
            board = chess.Board()
            for m in moves[:cut]:
                board.push_uci(m)
            moves = moves[:cut]
        if k % 50 == 7:
            board.halfmove_clock = rng.randint(100, 149)
        if k % 50 == 8:
            board.fullmove_number = rng.randint(100, 250)
        rating = rng.uniform(lo_rating, hi_rating)
        if k % 100 == 3:
            rating = rng.choice(outliers)
        if k % 20 == 0:
            player, opponent, increment = UNTIMED_VIRTUAL
        else:
            player = rng.choice([0.0, rng.uniform(0, 5), rng.uniform(0, 600), rng.uniform(0, 600), rng.uniform(600, 1200)])
            opponent = rng.choice([0.0, rng.uniform(0, 600), rng.uniform(0, 600), rng.uniform(600, 1200)])
            increment = float(rng.choice(INCREMENTS))
        records.append(
            {
                # `en_passant="fen"`: the square is printed after every double pawn push (as the
                # extension's board adapters do), not only when a capture is legal.
                "fen": board.fen(en_passant="fen"),
                "moves": moves[-24:],
                "rating": round(rating, 3),
                "playerClockS": round(player, 3),
                "opponentClockS": round(opponent, 3),
                "incrementS": increment,
                "band": select_band(rating, bands, scalers),
            }
        )
    return records


def standardise(record: dict, scalers: dict) -> tuple[float, list[float]]:
    """`standardiseInputs` in chessmimic-scalers.ts: the rating is clamped to the band's range
    (each band's scaler std is ≈ 27 Elo, so a target outside the band would extrapolate far
    beyond anything the band model saw; upstream never does, its 14 bands are contiguous)."""
    s = scalers
    lo, hi = band_range(record["band"])
    rating = min(max(record["rating"], lo), hi)
    scaled_rating = (rating - s["rating"]["mean"]) / s["rating"]["std"]
    clocks = [
        (math.log(record["playerClockS"] + 1) - s["log_player_clock"]["mean"]) / s["log_player_clock"]["std"],
        (math.log(record["opponentClockS"] + 1) - s["log_opponent_clock"]["mean"]) / s["log_opponent_clock"]["std"],
        (math.log(record["incrementS"] + 1) - s["log_increment"]["mean"]) / s["log_increment"]["std"],
    ]
    return scaled_rating, clocks


# ── main ───────────────────────────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--upstream", default=str(ROOT / "tools" / "data" / "upstream" / "1e4_ai"))
    ap.add_argument("--checkpoints", default=str(ROOT / "tools" / "data" / "upstream" / "checkpoints"))
    ap.add_argument("--commit", default=PINNED_COMMIT)
    ap.add_argument("--bands", default=",".join(DEFAULT_BANDS))
    ap.add_argument("--out", default=str(ROOT / "assets" / "models" / "chessmimic"))
    ap.add_argument("--fixture", default=str(ROOT / "test" / "fixtures" / "chessmimic-reference.json"))
    ap.add_argument("--positions", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=34)
    ap.add_argument("--precision", choices=["fp16", "int8"], default="fp16")
    ap.add_argument("--skip-fixture", action="store_true")
    args = ap.parse_args()

    try:
        import chess
        import numpy as np
        import onnx
        import onnxruntime as ort
        import torch
        import torch.nn as nn
        import torch.nn.functional as F
    except ImportError as e:
        print(f"missing dependency: {e}; see the docstring for the venv recipe", file=sys.stderr)
        return 2

    upstream = Path(args.upstream)
    ensure_clone(UPSTREAM_REPO, upstream, args.commit, {"GIT_LFS_SKIP_SMUDGE": "1"})
    tok = load_upstream_tokenizer(upstream)
    bands = args.bands.split(",")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    checkpoints = Path(args.checkpoints)

    ClockPatzerModel = build_model(torch, nn, F)
    scalers_json: dict = {}
    buckets_json: dict = {}
    models_json: dict = {
        "upstream": {"repo": UPSTREAM_REPO, "commit": args.commit, "license": UPSTREAM_LICENSE},
        "export": {
            "script": "tools/data/08_export_chessmimic.py",
            "opset": OPSET,
            "precision": args.precision,
            "torch": torch.__version__,
            "onnx": onnx.__version__,
            "onnxruntime": ort.__version__,
            "inputs": {"input_ids": f"int32 [batch, {RECENT_MOVES + tok.SEQUENCE_LENGTH}]", "scaled_rating": "float32 [batch]", "clock_features": "float32 [batch, 3]"},
            "outputs": {"probs": f"float32 [batch, {N_BUCKETS}]"},
        },
        "bands": {},
    }
    models: dict[str, object] = {}
    for band in bands:
        band_dir = upstream / CLOCK_MODEL_DIR / f"{band}_brier"
        ckpt, oid = fetch_checkpoint(upstream, band, checkpoints)
        model = ClockPatzerModel(tok.SEQUENCE_LENGTH, tok.INPUT_VOCAB_SIZE, tok.NUM_ACTIONS)
        load_checkpoint(torch, model, ckpt)
        models[band] = model
        fp32 = export_onnx(torch, model, tok.SEQUENCE_LENGTH)
        if args.precision == "fp16":
            data, casts = to_fp16_weights(onnx, np, fp32, band in FP32_ATTENTION_BANDS)
            note = f"{casts} float16 initializers behind Cast"
            if band in FP32_ATTENTION_BANDS:
                note += "; attention output projections retained in fp32"
        else:
            data = to_int8(fp32, out, band)
            note = "onnxruntime quantize_dynamic QInt8"
        onnx.checker.check_model(onnx.load_from_string(data))
        dest = out / f"{band}.onnx"
        dest.write_bytes(data)
        scalers_json[band] = read_scalers(band_dir / "scalers.pkl")
        buckets_json[band] = read_buckets(band_dir / "clock_buckets.json")
        models_json["bands"][band] = {
            "file": dest.name,
            "bytes": len(data),
            "sha256": sha256_bytes(data),
            "checkpoint": {"path": f"{CLOCK_MODEL_DIR}/{band}_brier/model.ckpt", "lfsOid": oid, "bytes": ckpt.stat().st_size},
            "fp32Bytes": len(fp32),
            "weights": note,
        }
        print(f"{band}: {dest.name} {len(data):,} bytes (fp32 graph {len(fp32):,}), {note}")

    vocab = {
        "characters": list(tok._CHARACTERS),
        "classToken": int(tok.CLASS_TOKEN),
        "padToken": int(tok.PAD_TOKEN),
        "inputVocabSize": int(tok.INPUT_VOCAB_SIZE),
        "fenSequenceLength": int(tok.SEQUENCE_LENGTH),
        "recentMoves": RECENT_MOVES,
        "moves": [tok.ACTION_TO_MOVE[i] for i in range(tok.NUM_ACTIONS)],
    }
    (out / "scalers.json").write_text(json.dumps(scalers_json, indent=1) + "\n", encoding="utf-8")
    (out / "buckets.json").write_text(json.dumps(buckets_json, separators=(",", ":")) + "\n", encoding="utf-8")
    (out / "vocab.json").write_text(json.dumps(vocab, separators=(",", ":")) + "\n", encoding="utf-8")

    if not args.skip_fixture:
        rng = random.Random(args.seed)
        records = generate_positions(chess, rng, args.positions, bands, scalers_json)
        by_band: dict[str, list[dict]] = {b: [] for b in bands}
        for r in records:
            r["moveTokens"] = prepare_recent_moves_tokens(r["moves"], tok.MOVE_TO_ACTION, tok.PAD_TOKEN)
            r["fenTokens"] = [int(t) for t in tok.tokenize(r["fen"])]
            r["scaledRating"], r["clockFeatures"] = standardise(r, scalers_json[r["band"]])
            by_band[r["band"]].append(r)
        for band, rows in by_band.items():
            if not rows:
                continue
            ids = torch.tensor([r["moveTokens"] + r["fenTokens"] for r in rows], dtype=torch.int32)
            rating = torch.tensor([r["scaledRating"] for r in rows], dtype=torch.float32)
            clocks = torch.tensor([r["clockFeatures"] for r in rows], dtype=torch.float32)
            with torch.no_grad():
                probs = models[band](ids, rating, clocks).numpy()
            session = ort.InferenceSession(str(out / f"{band}.onnx"), providers=["CPUExecutionProvider"])
            ort_probs = session.run(None, {"input_ids": ids.numpy(), "scaled_rating": rating.numpy(), "clock_features": clocks.numpy()})[0]
            max_diff = float(np.abs(ort_probs - probs).max())
            if args.precision == "fp16" and max_diff >= 0.002:
                raise SystemExit(f"{band}: fp16 probability error {max_diff:.6f} exceeds the runtime's 0.002 tolerance")
            models_json["bands"][band]["fixturePositions"] = len(rows)
            models_json["bands"][band]["maxAbsProbDiffOnnxVsTorch"] = max_diff
            print(f"{band}: {len(rows)} fixture positions, max |Δprob| onnxruntime vs torch fp32 = {max_diff:.2e}")
            for r, p in zip(rows, probs):
                r["probs"] = [round(float(x), 7) for x in p]
        fixture = {
            "note": "Reference inputs and torch fp32 bucket probabilities for the ChessMimic clock model; generated by tools/data/08_export_chessmimic.py (upstream tokenizer.py, PolyForm-Noncommercial-1.0.0 weights).",
            "upstream": models_json["upstream"],
            "seed": args.seed,
            "positions": records,
        }
        Path(args.fixture).write_text(json.dumps(fixture, separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"wrote {args.fixture} ({len(records)} positions)")

    (out / "models.json").write_text(json.dumps(models_json, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out / 'models.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

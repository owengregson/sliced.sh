#!/usr/bin/env python3
"""08_export_chessmimic.py — export the ChessMimic clock model to ONNX for the timing head
(Task 34; Part I §8.4b item 6, Appendix J §B).

Upstream: https://github.com/thomasj02/1e4_ai (PolyForm Noncommercial 1.0.0; the notice lives in
docs/third-party.md). The repository is cloned at PINNED_COMMIT into --upstream (git-ignored) with
Git LFS smudging disabled; the Lightning checkpoints are fetched through the Git LFS batch API and
verified against the pointer's SHA-256 (the LFS object id), so no `git-lfs` binary is needed.

Per shipped band:
  - `backend/models/clock_model/<band>_brier/model.ckpt` → `state_dict` only, prefixes stripped,
    loaded strictly into a plain-torch transcription of `Training/ClockTrainer.py`'s
    `ClockPatzerModel` (same parameter names; 8,950,558 parameters);
  - `torch.onnx.export` (TorchScript exporter, opset 14, `do_constant_folding`), inputs
    `input_ids` int32 [batch, 90] (12 move tokens + 78 FEN tokens), `scaled_rating` float32
    [batch], `clock_features` float32 [batch, 3]; output `probs` float32 [batch, 30] (softmax is
    inside the graph); batch is dynamic;
  - fp16 weights: every float initializer with ≥ FP16_MIN_ELEMENTS elements is stored as float16
    behind a `Cast` to float32 (onnxruntime constant-folds the casts at session load, so the
    arithmetic stays fp32 — the WebAssembly CPU provider has no fp16 kernels — while the file
    halves); `--precision int8` runs onnxruntime's dynamic quantisation instead;
  - `scalers.pkl` → scalers.json (mean/std per feature), `clock_buckets.json` → buckets.json
    (`Infinity` edge written as null), and the fp16 file is checked against torch fp32 in Python
    onnxruntime (max |Δprob| recorded in models.json).

Shared: vocab.json (the searchless_chess FEN characters, class/pad ids, the 1 968-move UCI
vocabulary in `_compute_all_possible_actions` order — taken from the upstream `Training/tokenizer.py`
module, not re-derived), models.json (provenance, per-band size/SHA-256, export metadata) and the
reference fixture test/fixtures/chessmimic-reference.json: --positions seeded positions with the
exact model inputs (tokens from the upstream tokeniser, left-padded move window as in the C++
binding, rating clamped to the band range then standardised, standardised log clocks) and the
torch fp32 bucket probabilities. Measured on the shipped bands: fp16 weights move at most
1.458e-3 of probability mass in a bucket relative to torch fp32 (worst band 1500_1600; see
models.json), which is why the extension's conformance tolerance is 2e-3 rather than 1e-3.
Partial-fp32 layouts were measured on that band (max |dprob| vs torch fp32, bytes per band):
all-fp16 1.458e-3 / 18,200,481; fp32 embeddings 1.371e-3 / 19,224,760; fp32 attention out_proj
1.108e-3 / 19,247,529; fp32 embeddings + attention out_proj 9.542e-4 / 20,271,808; fp16 only for
initializers >= 262,144 elements 1.469e-3 / 22,471,558; full fp32 3.994e-6 / 36,059,775. A
partial layout does reach <1e-3, but only with ~5 % margin and +2.1 MB per band, so the shipped
export stays all-fp16 and the tolerance is set at 2e-3.

Run (from the repository root; the venv is git-ignored):
    uv venv --python 3.12 tools/data/.venv
    VIRTUAL_ENV=tools/data/.venv uv pip install torch onnx onnxruntime numpy chess
    tools/data/.venv/bin/python tools/data/08_export_chessmimic.py
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import pickle
import random
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

UPSTREAM_REPO = "https://github.com/thomasj02/1e4_ai"
PINNED_COMMIT = "8fcca2319e828b9d14b8def5c3ee9bc8bf1e3f12"
UPSTREAM_LICENSE = "PolyForm-Noncommercial-1.0.0"
LFS_BATCH_URL = f"{UPSTREAM_REPO}.git/info/lfs/objects/batch"
CLOCK_MODEL_DIR = "backend/models/clock_model"
DEFAULT_BANDS = ["1200_1300", "1500_1600", "1800_1900"]

# Architecture (Training/ClockTrainer.py, backend/clock_inference.py).
RECENT_MOVES = 12
EMBEDDING_DIM = 256
WIDENING = 4
LAYERS = 8
HEADS = 8
N_BUCKETS = 30
OPSET = 14
FP16_MIN_ELEMENTS = 1024
EXPECTED_PARAMS = 8_950_558

SCALER_KEYS = ("rating", "log_player_clock", "log_opponent_clock", "log_increment")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ── upstream clone and LFS ────────────────────────────────────────────────────────────────────


def ensure_clone(upstream: Path, commit: str) -> None:
    env = dict(os.environ, GIT_LFS_SKIP_SMUDGE="1")
    if not (upstream / ".git").exists():
        upstream.parent.mkdir(parents=True, exist_ok=True)
        print(f"cloning {UPSTREAM_REPO} → {upstream}")
        subprocess.run(["git", "clone", "--quiet", UPSTREAM_REPO, str(upstream)], check=True, env=env)
    head = subprocess.run(["git", "-C", str(upstream), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    if head != commit:
        subprocess.run(["git", "-C", str(upstream), "fetch", "--quiet", "origin", commit], check=False, env=env)
        subprocess.run(["git", "-C", str(upstream), "checkout", "--quiet", commit], check=True, env=env)
        head = subprocess.run(["git", "-C", str(upstream), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    if head != commit:
        raise SystemExit(f"upstream is at {head}, expected {commit}")
    print(f"upstream {UPSTREAM_REPO} @ {commit}")


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


def to_fp16_weights(onnx, np, model_bytes: bytes) -> tuple[bytes, int]:
    from onnx import TensorProto, helper, numpy_helper

    model = onnx.load_from_string(model_bytes)
    graph = model.graph
    casts = []
    for init in list(graph.initializer):
        if init.data_type != TensorProto.FLOAT:
            continue
        arr = numpy_helper.to_array(init)
        if arr.size < FP16_MIN_ELEMENTS:
            continue
        if float(np.abs(arr).max()) > 65504.0:
            raise SystemExit(f"{init.name}: |w| exceeds the float16 range")
        half = numpy_helper.from_array(arr.astype(np.float16), init.name + "_fp16")
        graph.initializer.remove(init)
        graph.initializer.append(half)
        casts.append(helper.make_node("Cast", [half.name], [init.name], to=TensorProto.FLOAT, name="cast_" + init.name))
    for i, node in enumerate(casts):
        graph.node.insert(i, node)
    onnx.checker.check_model(model)
    return model.SerializeToString(), len(casts)


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


def select_band(rating: float, bands: list[str]) -> str:
    """Nearest band centre; ties → the lower band (mirrors `selectBand` in chessmimic-head.ts)."""
    best, best_d = bands[0], float("inf")
    for band in bands:
        d = abs(rating - band_centre(band))
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


def generate_positions(chess, rng: random.Random, n: int, bands: list[str]) -> list[dict]:
    records: list[dict] = []
    # Deterministic edge cases: no history, short windows around the 12-move boundary,
    # three-digit halfmove / fullmove counters, extreme ratings.
    starts = [0, 1, 2, 11, 12, 13, 24]
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
        rating = rng.uniform(1100, 2000)
        if k % 100 == 3:
            rating = rng.choice([800.0, 2600.0])
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
                "band": select_band(rating, bands),
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
    ensure_clone(upstream, args.commit)
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
            data, casts = to_fp16_weights(onnx, np, fp32)
            note = f"{casts} float16 initializers behind Cast"
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
        records = generate_positions(chess, rng, args.positions, bands)
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

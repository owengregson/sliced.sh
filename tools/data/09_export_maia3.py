#!/usr/bin/env python3
"""09_export_maia3.py — export the Maia-3 human move-policy model to ONNX for the move
selector (2026-09-11; `docs/research/maia3-feasibility-2026-09-11.md` §3 and §6). Since
2026-09-13 only the largest size (79M) ships and is registered — the 5M and 23M entries were
removed from SIZES with the owner's decision to use one model for every rating.

Upstream: https://github.com/CSSLab/maia3 (AGPL-3.0-or-later; the notice lives in
docs/third-party.md). The repository is cloned at PINNED_COMMIT into --upstream (git-ignored) and
put on `sys.path` so the *upstream* model class and reference tokeniser are used as-is — nothing
from it is copied into this repository, and the extension's own encoder (`src/core/policy/`) is
written from the paper's description, not from `maia3/dataset.py`. The checkpoints come from the
Hugging Face hub at the revision pinned per size in SIZES (mirrors `MAIA_MODEL_FILES` in
src/core/constants/maia.ts; `test/scripts/maia-assets.test.ts` checks the outputs against it)
and are verified by byte count and SHA-256 before anything is exported.

Per size:
  - `MAIA3Model` built from `model_registry.MODEL_SPECS[<size>].config`, weights loaded through the
    upstream `uci.load_model`, wrapped so the graph's inputs are `tokens` float32 [batch, 64, 96]
    (the 97th "clk_ponder" column the upstream tokeniser emits is a training label the model
    slices off; the wrapper appends a zero column), `self_elo` float32 [batch], `oppo_elo` float32
    [batch]; outputs `move_logits` float32 [batch, 4352] (side-to-move frame, unmasked) and
    `value_logits` float32 [batch, 3] (loss, draw, win); batch is dynamic;
  - `torch.nn.RMSNorm` has no TorchScript ONNX symbolic, so its forward is replaced by the explicit
    arithmetic (`x · rsqrt(mean(x²) + ε) · w`) for the export;
  - `torch.onnx.export` (TorchScript exporter, opset 17, `do_constant_folding`);
  - fp16 weights: every float initializer with ≥ FP16_MIN_ELEMENTS elements is stored as float16
    behind a `Cast` to float32 (onnxruntime constant-folds the casts at session load, so the
    arithmetic stays fp32 — the WebAssembly CPU provider has no fp16 kernels — while the file
    halves); the fp16 file is checked against torch fp32 in Python onnxruntime on the fixture
    (max |Δprob| over the legal-move-masked softmax, argmax agreement; recorded in models.json);
  - written to assets/models/maia3/ as `maia3-<size>.onnx`, or — when the file is over the Git
    host's 100 MB per-file cap — as consecutive `maia3-<size>.onnx.part<i>` slices of exactly
    PART_BYTES bytes then the remainder (`scripts/maia-assets.ts` joins them at build time and
    verifies the result against the registry; the parts never ship).

Shared: models.json (provenance, per-size bytes / SHA-256 / parts / checkpoint pin, export
metadata and the input layout) and the fixtures under test/fixtures/maia3/:
  - positions.json — `{history, tokenDim, positions:[{fen, historyFens, selfElo, oppoElo,
    tokensSet, legal}]}`: --positions seeded positions (seed 34) with up to 8 plies of history,
    the upstream tokeniser's 64×96 one-hot as the ascending list of set indices (square-major:
    index = square·96 + feature), and the legal-move indices in the 4352-move vocabulary;
  - expected-<size>.json — `{size, positions:[{top:[[uci, p], …≤5], value:[l, d, w]}]}` aligned by
    index: the torch fp32 masked-softmax top-5 (fewer when fewer moves are legal) and the raw
    value logits. **The `top` UCIs are in the model's mirrored (side-to-move) frame**, exactly as
    the graph's `move_logits` index them — for a black-to-move position `g1f3` means black's
    `g8f6`. They are deliberately NOT un-mirrored to the board frame here (the integration test
    un-mirrors them, mirroring the extension's decoder); regenerating them in the board frame
    would silently break that test.

The export is deterministic given the checkpoint: the shipped files (registry SHA-256s) were
produced by this procedure with torch 2.14.0 / onnx 1.22.0 / onnxruntime 1.30.0.

Run (from the repository root; the venv is git-ignored):
    uv venv --python 3.12 tools/data/.venv
    VIRTUAL_ENV=tools/data/.venv uv pip install torch onnx onnxruntime numpy chess huggingface-hub
    tools/data/.venv/bin/python tools/data/09_export_maia3.py
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import random
import subprocess
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

UPSTREAM_REPO = "https://github.com/CSSLab/maia3"
PINNED_COMMIT = "1e13597c42d4858b7cfd7cfdae01e297263364b2"
UPSTREAM_LICENSE = "AGPL-3.0-or-later"
UPSTREAM_PAPER = "https://arxiv.org/abs/2605.19091"
UPSTREAM_HUB = "https://huggingface.co/collections/MaiaChess/maia3"

# Mirrors `MAIA_MODEL_FILES[<size>].upstream` / `dModel` / `heads` (src/core/constants/maia.ts).
SIZES: dict[str, dict] = {
    "79m": {
        "name": "maia3-79m",
        "repo": "UofTCSSLab/Maia3-79M",
        "revision": "a107d6ceb7b298cb04ae1da4edffe2939858b894",
        "checkpoint": "maia3-79m.pt",
        "bytes": 315_651_851,
        "sha256": "3fc6181d5db789b45a15305732148757ae74efa3e0028e81ba335b462dac45c2",
        "dModel": 1024,
        "heads": 32,
    },
}
DEFAULT_SIZES = list(SIZES)

# Input contract (`MAIA_INPUT`).
HISTORY = 8
PLANES = 12
TOKEN_DIM = PLANES * HISTORY  # 96; the upstream tokeniser's 97th column is the clk_ponder label
SQUARES = 64
FROM_TO = 4096
MOVE_VOCAB = 4352
PROMOTION_PIECES = ["q", "r", "b", "n"]
ELO_SCALE = 5000
INPUT_NAMES = ("tokens", "self_elo", "oppo_elo")
OUTPUT_NAMES = ("move_logits", "value_logits")

# Export layout (`MAIA_FILES`).
OPSET = 17
FP16_MIN_ELEMENTS = 1024
PART_SUFFIX = ".part"
PART_BYTES = 95_000_000
TOP_K = 5
EXPECTED_NOTE = (
    "torch fp32 masked-softmax top-5 per position of positions.json (same index). `top` UCIs are in the "
    "model's mirrored side-to-move frame (black's g8f6 appears as g1f3), as move_logits index them; "
    "the consumer un-mirrors. Generated by tools/data/09_export_maia3.py."
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ── upstream clone and checkpoints ────────────────────────────────────────────────────────────


def ensure_clone(upstream: Path, commit: str) -> None:
    env = dict(os.environ)
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


def fetch_checkpoint(hf_hub_download, size: str, cache: Path) -> Path:
    spec = SIZES[size]
    path = Path(hf_hub_download(repo_id=spec["repo"], filename=spec["checkpoint"], revision=spec["revision"], cache_dir=str(cache)))
    n = path.stat().st_size
    if n != spec["bytes"]:
        raise SystemExit(f"{size}: checkpoint is {n:,} bytes, registry says {spec['bytes']:,}")
    digest = sha256_file(path)
    if digest != spec["sha256"]:
        raise SystemExit(f"{size}: checkpoint sha256 {digest} != registry {spec['sha256']}")
    print(f"{size}: checkpoint {spec['checkpoint']} @ {spec['revision'][:12]} verified ({n:,} bytes)")
    return path


# ── model ─────────────────────────────────────────────────────────────────────────────────────


def patch_rmsnorm(torch, nn) -> None:
    """`torch.nn.RMSNorm` has no TorchScript ONNX symbolic; export the arithmetic instead."""

    def forward(self, x):
        eps = self.eps if self.eps is not None else torch.finfo(x.dtype).eps
        y = x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + eps)
        return y * self.weight if self.weight is not None else y

    nn.RMSNorm.forward = forward


def build_wrapper(torch, nn):
    class Exported(nn.Module):
        """tokens float32 [B, 64, 96], self_elo float32 [B], oppo_elo float32 [B]
        → move_logits [B, 4352] (side-to-move frame, unmasked), value_logits [B, 3] (L, D, W)."""

        def __init__(self, model):
            super().__init__()
            self.model = model

        def forward(self, tokens, self_elo, oppo_elo):
            pad = torch.zeros(tokens.shape[0], SQUARES, 1, dtype=tokens.dtype)
            move, value, _ponder = self.model(torch.cat([tokens, pad], dim=-1), self_elo, oppo_elo)
            return move, value

    return Exported


def load_upstream_model(maia3, size: str, checkpoint: Path):
    spec = next(s for s in maia3.model_registry.MODEL_SPECS if s.name == SIZES[size]["name"])
    cfg = types.SimpleNamespace(**spec.config)
    cfg.device = "cpu"
    cfg.checkpoint_path = str(checkpoint)
    cfg.trust_checkpoint = False
    model = maia3.uci.load_model(cfg)
    model.eval()
    return model


def export_onnx(torch, wrapped) -> bytes:
    tokens = torch.zeros((1, SQUARES, TOKEN_DIM), dtype=torch.float32)
    elo = torch.tensor([1500.0], dtype=torch.float32)
    buf = io.BytesIO()
    torch.onnx.export(
        wrapped,
        (tokens, elo, elo.clone()),
        buf,
        opset_version=OPSET,
        dynamo=False,
        do_constant_folding=True,
        input_names=list(INPUT_NAMES),
        output_names=list(OUTPUT_NAMES),
        dynamic_axes={name: {0: "batch"} for name in (*INPUT_NAMES, *OUTPUT_NAMES)},
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


# ── repository layout ─────────────────────────────────────────────────────────────────────────


def part_count(n_bytes: int) -> int:
    """`maiaPartCount` in scripts/maia-assets.ts."""
    return max(1, -(-n_bytes // PART_BYTES))


def source_names(file: str, parts: int) -> list[str]:
    """`maiaSourceNames`: the whole file, or its `.part<i>` slices."""
    return [file] if parts == 1 else [f"{file}{PART_SUFFIX}{i}" for i in range(parts)]


def write_source(out: Path, file: str, data: bytes) -> list[str]:
    """`writeMaiaSource`: consecutive slices of exactly PART_BYTES then the remainder."""
    parts = part_count(len(data))
    names = source_names(file, parts)
    for i, name in enumerate(names):
        (out / name).write_bytes(data[i * PART_BYTES : (i + 1) * PART_BYTES])
    whole = out / file
    if parts > 1 and whole.exists():
        whole.unlink()  # a joined copy beside its parts is a build artefact, never a source
    return names


# ── fixture ────────────────────────────────────────────────────────────────────────────────────


def random_game(chess, rng: random.Random, max_plies: int) -> list:
    """A random legal game (captures preferred 40 % of the time) as a list of board snapshots."""
    board = chess.Board()
    history = [board.copy(stack=False)]
    for _ in range(max_plies):
        legal = list(board.legal_moves)
        if not legal or board.is_game_over():
            break
        captures = [m for m in legal if board.is_capture(m)]
        board.push(rng.choice(captures) if captures and rng.random() < 0.4 else rng.choice(legal))
        history.append(board.copy(stack=False))
    return history


ELO_CHOICES = [800, 1100, 1300, 1500, 1700, 1900, 2100, 2400, 2700]


def generate_positions(chess, torch, maia3, rng: random.Random, n: int, move_index: dict) -> list[dict]:
    """Seeded positions with the upstream tokeniser's encoding and legal mask (the reference the
    extension's encoder is tested against). The first few are short histories (0, 1, 3, 7, 8, 9,
    20 plies) so the repeat-the-earliest padding and the full window are both covered."""
    rows: list[dict] = []
    starts = [0, 1, 3, 7, 8, 9, 20]
    tokeniser_cfg = types.SimpleNamespace(history=HISTORY, include_time_info=False)
    while len(rows) < n:
        history = random_game(chess, rng, rng.randint(1, 140))
        k = len(rows)
        if k < len(starts):
            history = history[: starts[k] + 1]
        board = history[-1]
        if board.is_game_over():
            continue
        window = history[-HISTORY:]
        tokens = maia3.dataset.get_historical_tokens([maia3.dataset.tokenize_board(b) for b in window], tokeniser_cfg, 0, 0, 0, 0)
        tokens = tokens[:, :TOKEN_DIM]
        mask = maia3.dataset.get_legal_moves_mask(board, move_index)
        rows.append(
            {
                "fen": board.fen(),
                "historyFens": [b.fen() for b in window],
                "selfElo": rng.choice(ELO_CHOICES),
                "oppoElo": rng.choice(ELO_CHOICES),
                "tokens": tokens.flatten().to(torch.int8).tolist(),
                "legal": torch.nonzero(mask).flatten().tolist(),
            }
        )
    return rows


def check_pad_column(chess, maia3, positions_path: Path) -> tuple[int, float, int]:
    """D4 (docs/research/human-move-selection-ideas-2026-09-13.md §7): `Exported.forward` pads the 96
    token features with a zero 97th column before the upstream module, and `generate_positions`
    truncates the upstream tokeniser's output to 96 columns before the torch reference — so the ONNX
    graph and the parity reference are fed the same zeroed column by construction and
    test/integration/maia-onnx.test.ts cannot tell whether that column really is zero.

    Measures it: re-tokenises every fixture history with the upstream tokeniser
    (`include_time_info=False`, the export's setting) and returns (positions, max |value| over every
    column ≥ TOKEN_DIM, positions whose first TOKEN_DIM columns differ from the fixture's `tokensSet`).
    A non-zero maximum means the pad is wrong and the export must carry the real column."""
    rows = json.loads(positions_path.read_text(encoding="utf-8"))["positions"]
    tokeniser_cfg = types.SimpleNamespace(history=HISTORY, include_time_info=False)
    worst = 0.0
    mismatched = 0
    for r in rows:
        boards = [chess.Board(fen) for fen in r["historyFens"]]
        tokens = maia3.dataset.get_historical_tokens([maia3.dataset.tokenize_board(b) for b in boards], tokeniser_cfg, 0, 0, 0, 0)
        if tokens.shape[0] != SQUARES or tokens.shape[-1] <= TOKEN_DIM:
            raise SystemExit(f"upstream tokeniser returned {tuple(tokens.shape)}, expected ({SQUARES}, > {TOKEN_DIM})")
        worst = max(worst, float(tokens[:, TOKEN_DIM:].abs().max()))
        kept = tokens[:, :TOKEN_DIM].flatten()
        if [i for i, t in enumerate(kept.tolist()) if t == 1] != r["tokensSet"]:
            mismatched += 1
    return len(rows), worst, mismatched


def feeds(torch, rows: list[dict]):
    tokens = torch.tensor([r["tokens"] for r in rows], dtype=torch.float32).view(len(rows), SQUARES, TOKEN_DIM)
    self_elo = torch.tensor([r["selfElo"] for r in rows], dtype=torch.float32)
    oppo_elo = torch.tensor([r["oppoElo"] for r in rows], dtype=torch.float32)
    return tokens, self_elo, oppo_elo


def masked_probs(np, logits, legal: list[int]):
    l = logits[legal]
    l = l - l.max()
    p = np.exp(l)
    return p / p.sum()


# ── main ───────────────────────────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--upstream", default=str(ROOT / "tools" / "data" / "upstream" / "maia3"))
    ap.add_argument("--checkpoints", default=str(ROOT / "tools" / "data" / "upstream" / "hf-cache"))
    ap.add_argument("--commit", default=PINNED_COMMIT)
    ap.add_argument("--sizes", default=",".join(DEFAULT_SIZES))
    ap.add_argument("--out", default=str(ROOT / "assets" / "models" / "maia3"))
    ap.add_argument("--fixtures", default=str(ROOT / "test" / "fixtures" / "maia3"))
    ap.add_argument("--positions", type=int, default=60)
    ap.add_argument("--seed", type=int, default=34)
    ap.add_argument("--skip-fixture", action="store_true")
    ap.add_argument(
        "--check-pad",
        action="store_true",
        help="D4: only verify that the upstream tokeniser's dropped columns (≥ 96) are all zero on the fixture positions, then exit (needs torch + chess + the upstream clone, no checkpoints)",
    )
    args = ap.parse_args()

    try:
        import chess
        import torch
        import torch.nn as nn
    except ImportError as e:
        print(f"missing dependency: {e}; see the docstring for the venv recipe", file=sys.stderr)
        return 2

    upstream = Path(args.upstream)
    ensure_clone(upstream, args.commit)
    sys.path.insert(0, str(upstream))
    import maia3.dataset  # noqa: E402  (upstream, AGPL — used, never copied)
    import maia3.model_registry  # noqa: E402
    import maia3.uci  # noqa: E402
    import maia3.utils  # noqa: E402

    if args.check_pad:
        positions_path = Path(args.fixtures) / "positions.json"
        n, worst, mismatched = check_pad_column(chess, maia3, positions_path)
        verdict = "all zero" if worst == 0.0 else f"NOT zero (max |value| {worst:g})"
        print(f"D4 pad column: {n} fixture positions, columns ≥ {TOKEN_DIM} of the upstream tokeniser are {verdict}; first {TOKEN_DIM} columns mismatch tokensSet in {mismatched} position(s)")
        return 0 if worst == 0.0 and mismatched == 0 else 1

    try:
        import numpy as np
        import onnx
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
    except ImportError as e:
        print(f"missing dependency: {e}; see the docstring for the venv recipe", file=sys.stderr)
        return 2

    sizes = args.sizes.split(",")
    for size in sizes:
        if size not in SIZES:
            raise SystemExit(f"unknown size {size}; expected one of {', '.join(SIZES)}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fixtures = Path(args.fixtures)
    checkpoints = Path(args.checkpoints)

    patch_rmsnorm(torch, nn)
    Exported = build_wrapper(torch, nn)

    all_moves = maia3.utils.get_all_possible_moves()
    if len(all_moves) != MOVE_VOCAB:
        raise SystemExit(f"upstream move vocabulary has {len(all_moves)} entries, expected {MOVE_VOCAB}")
    move_index = {mv: i for i, mv in enumerate(all_moves)}

    manifest: dict = {
        "upstream": {"name": "Maia-3", "repo": UPSTREAM_REPO, "commit": args.commit, "license": UPSTREAM_LICENSE, "paper": UPSTREAM_PAPER, "hub": UPSTREAM_HUB},
        "export": {
            "script": "tools/data/09_export_maia3.py",
            "opset": OPSET,
            "precision": "fp16",
            "fp16MinElements": FP16_MIN_ELEMENTS,
            "torch": torch.__version__,
            "onnx": onnx.__version__,
            "onnxruntime": ort.__version__,
            "inputs": {"tokens": f"float32 [batch, {SQUARES}, {TOKEN_DIM}]", "self_elo": "float32 [batch]", "oppo_elo": "float32 [batch]"},
            "outputs": {"move_logits": f"float32 [batch, {MOVE_VOCAB}]", "value_logits": "float32 [batch, 3]"},
            "input": {
                "history": HISTORY,
                "planes": PLANES,
                "tokenDim": TOKEN_DIM,
                "squares": SQUARES,
                "moveVocab": MOVE_VOCAB,
                "fromTo": FROM_TO,
                "promotionPieces": PROMOTION_PIECES,
                "eloScale": ELO_SCALE,
                "eloMin": 0,
                "eloMax": ELO_SCALE,
            },
        },
        "split": {"partSuffix": PART_SUFFIX, "partBytes": PART_BYTES},
        "models": {},
    }

    wrapped_models: dict[str, object] = {}
    for size in sizes:
        spec = SIZES[size]
        ckpt = fetch_checkpoint(hf_hub_download, size, checkpoints)
        model = load_upstream_model(maia3, size, ckpt)
        n_params = sum(p.numel() for p in model.parameters())
        wrapped = Exported(model).eval()
        wrapped_models[size] = wrapped
        fp32 = export_onnx(torch, wrapped)
        onnx.checker.check_model(onnx.load_from_string(fp32))
        data, casts = to_fp16_weights(onnx, np, fp32)
        onnx.checker.check_model(onnx.load_from_string(data))
        file = f"{spec['name']}.onnx"
        names = write_source(out, file, data)
        manifest["models"][size] = {
            "file": file,
            "bytes": len(data),
            "sha256": sha256_bytes(data),
            "parts": len(names),
            "sourceFiles": names,
            "params": n_params,
            "dModel": spec["dModel"],
            "heads": spec["heads"],
            "upstream": {"repo": spec["repo"], "revision": spec["revision"], "checkpoint": spec["checkpoint"], "bytes": spec["bytes"], "sha256": spec["sha256"]},
            "fp32Bytes": len(fp32),
            "fp32Sha256": sha256_bytes(fp32),
            "weights": f"{casts} float16 initializers behind Cast",
        }
        print(f"{size}: {', '.join(names)} {len(data):,} bytes (fp32 graph {len(fp32):,}), {n_params:,} parameters, {casts} initializers halved")

    if not args.skip_fixture:
        rng = random.Random(args.seed)
        rows = generate_positions(chess, torch, maia3, rng, args.positions, move_index)
        tokens, self_elo, oppo_elo = feeds(torch, rows)
        fixtures.mkdir(parents=True, exist_ok=True)
        positions = [
            {
                "fen": r["fen"],
                "historyFens": r["historyFens"],
                "selfElo": r["selfElo"],
                "oppoElo": r["oppoElo"],
                "tokensSet": [i for i, t in enumerate(r["tokens"]) if t == 1],
                "legal": r["legal"],
            }
            for r in rows
        ]
        (fixtures / "positions.json").write_text(json.dumps({"history": HISTORY, "tokenDim": TOKEN_DIM, "positions": positions}, separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"wrote {fixtures / 'positions.json'} ({len(rows)} positions)")
        for size in sizes:
            wrapped = wrapped_models[size]
            with torch.no_grad():
                ref_move, ref_value = wrapped(tokens, self_elo, oppo_elo)
            ref_move, ref_value = ref_move.numpy(), ref_value.numpy()
            expected = []
            for r, lm, lv in zip(rows, ref_move, ref_value):
                p = masked_probs(np, lm, r["legal"])
                # `all_moves` is the model's vocabulary, i.e. the mirrored side-to-move frame; the
                # UCIs are written as-is (no `mirror_move` back to the board frame — see docstring).
                top = [[all_moves[r["legal"][i]], round(float(p[i]), 6)] for i in np.argsort(-p)[:TOP_K]]
                expected.append({"top": top, "value": [round(float(x), 6) for x in lv]})
            (fixtures / f"expected-{size}.json").write_text(
                json.dumps({"size": size, "note": EXPECTED_NOTE, "positions": expected}, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )

            # Export-side parity: the fp16 file in Python onnxruntime against torch fp32.
            entry = manifest["models"][size]
            data = b"".join((out / name).read_bytes() for name in entry["sourceFiles"])
            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            session = ort.InferenceSession(data, options, providers=["CPUExecutionProvider"])
            outs = session.run(None, {"tokens": tokens.numpy(), "self_elo": self_elo.numpy(), "oppo_elo": oppo_elo.numpy()})
            max_dp, agree = 0.0, 0
            for r, lm, rlm in zip(rows, outs[0], ref_move):
                p, rp = masked_probs(np, lm, r["legal"]), masked_probs(np, rlm, r["legal"])
                max_dp = max(max_dp, float(np.abs(p - rp).max()))
                agree += int(np.argmax(p) == np.argmax(rp))
            max_dv = float(np.abs(outs[1] - ref_value).max())
            entry["fixturePositions"] = len(rows)
            entry["maxAbsProbDiffOnnxVsTorch"] = max_dp
            entry["maxAbsValueLogitDiffOnnxVsTorch"] = max_dv
            entry["argmaxAgree"] = f"{agree}/{len(rows)}"
            print(f"{size}: {len(rows)} fixture positions, max |Δprob| onnxruntime vs torch fp32 = {max_dp:.2e}, argmax {agree}/{len(rows)}")

    (out / "models.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {out / 'models.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

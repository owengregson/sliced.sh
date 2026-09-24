#!/usr/bin/env python3
"""Export a fine-tuned ChessMimic band with the conventions of `tools/data/08_export_chessmimic.py`.

    export.py --ckpt <best.ckpt> --scalers <run/scalers.json> --out <candidate dir> [--band 2200_3500]
              [--train-json <run/train.json>] [--install]

1. torch fp32 → ONNX (opset 14, the same graph, input and output names as 08) → fp16 initialisers
   behind Cast (08's `to_fp16_weights`).
2. The reference fixture is regenerated exactly as 08 does (seed 34, 1 000 positions, upstream
   tokenizer, containing-range then fitted-mean band selection with the new scalers). Rows of other
   bands must come out identical to the committed fixture (inputs and probabilities); the band's
   own rows get the fine-tuned torch fp32 probabilities. The ONNX file must stay under the
   runtime's 0.002 tolerance on them, or the export stops.
3. The candidate directory receives `<band>.onnx`, `scalers.json`, `models.json` and the fixture.
   `--install` also writes them into this worktree (assets/models/chessmimic/, the fixture, and the
   registry entry in src/core/constants/models.ts).
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import random
import re
import shutil
import sys
from pathlib import Path

import chess
import numpy as np
import onnx
import onnxruntime as ort
import torch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "tools" / "data"))
import model as M  # noqa: E402

import cmenc  # noqa: E402

UPSTREAM = cmenc.UPSTREAM_DIR / "1e4_ai"
FIXTURE = ROOT / "test" / "fixtures" / "chessmimic-reference.json"
ASSETS = ROOT / "assets" / "models" / "chessmimic"
REGISTRY = ROOT / "src" / "core" / "constants" / "models.ts"
TOLERANCE = 0.002


def load_08():
    spec = importlib.util.spec_from_file_location("export08", ROOT / "tools" / "data" / "08_export_chessmimic.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--scalers", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--band", default="2200_3500")
    ap.add_argument("--train-json", default=None)
    ap.add_argument("--note", default="")
    ap.add_argument("--install", action="store_true")
    args = ap.parse_args()
    band = args.band
    x08 = load_08()
    tok = x08.load_upstream_tokenizer(UPSTREAM)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    net = M.load(args.ckpt)
    # 08's own module (softmax folded in, identical initializer names) so the graph matches 08's.
    import torch.nn as nn
    import torch.nn.functional as F

    wrapped = x08.build_model(torch, nn, F)(tok.SEQUENCE_LENGTH, tok.INPUT_VOCAB_SIZE, tok.NUM_ACTIONS)
    wrapped.load_state_dict(net.state_dict(), strict=True)
    wrapped.eval()
    fp32 = x08.export_onnx(torch, wrapped, tok.SEQUENCE_LENGTH)
    data, casts = x08.to_fp16_weights(onnx, np, fp32, False)
    onnx.checker.check_model(onnx.load_from_string(data))
    (out / f"{band}.onnx").write_bytes(data)

    scalers = json.loads(Path(args.scalers).read_text())
    shipped_scalers = json.loads((ASSETS / "scalers.json").read_text())
    for b, s in shipped_scalers.items():
        if b != band and s != scalers[b]:
            raise SystemExit(f"{b}: scalers differ from the shipped ones; only {band} may change")
    bands = list(shipped_scalers)

    # ── fixture, regenerated as 08 does ──
    old = json.loads(FIXTURE.read_text())
    rng = random.Random(old["seed"])
    records = x08.generate_positions(chess, rng, len(old["positions"]), bands, scalers)
    rows = []
    for r, o in zip(records, old["positions"], strict=True):
        r["moveTokens"] = x08.prepare_recent_moves_tokens(r["moves"], tok.MOVE_TO_ACTION, tok.PAD_TOKEN)
        r["fenTokens"] = [int(t) for t in tok.tokenize(r["fen"])]
        r["scaledRating"], r["clockFeatures"] = x08.standardise(r, scalers[r["band"]])
        if r["band"] != band:
            same = all(r[k] == o[k] for k in ("fen", "moves", "rating", "playerClockS", "opponentClockS", "incrementS", "band", "moveTokens", "fenTokens", "scaledRating", "clockFeatures"))
            if not same:
                raise SystemExit(f"fixture row for {r['band']} changed; the other bands' rows must stay identical")
            r["probs"] = o["probs"]
        elif o["band"] != band:
            raise SystemExit("band assignment of a fixture row changed")
        else:
            rows.append(r)
    ids = torch.tensor([r["moveTokens"] + r["fenTokens"] for r in rows], dtype=torch.int32)
    rating = torch.tensor([r["scaledRating"] for r in rows], dtype=torch.float32)
    clocks = torch.tensor([r["clockFeatures"] for r in rows], dtype=torch.float32)
    with torch.no_grad():
        probs = wrapped(ids, rating, clocks).numpy()
    sess = ort.InferenceSession(str(out / f"{band}.onnx"), providers=["CPUExecutionProvider"])
    ort_probs = sess.run(None, {"input_ids": ids.numpy(), "scaled_rating": rating.numpy(), "clock_features": clocks.numpy()})[0]
    max_diff = float(np.abs(ort_probs - probs).max())
    print(f"{band}: {len(rows)} fixture positions, max |Δprob| onnxruntime vs torch fp32 = {max_diff:.2e}")
    if max_diff >= TOLERANCE:
        raise SystemExit(f"fp16 error {max_diff:.6f} exceeds {TOLERANCE}")
    for r, p in zip(rows, probs):
        r["probs"] = [round(float(x), 7) for x in p]
    fixture = dict(old)
    fixture["positions"] = records
    fixture["note"] = old["note"].rstrip(".") + f"; the {band} rows come from the fine-tuned checkpoint (tools/timing-finetune/export.py)."
    (out / "chessmimic-reference.json").write_text(json.dumps(fixture, separators=(",", ":")) + "\n", encoding="utf-8")

    # ── manifest ──
    manifest = json.loads((ASSETS / "models.json").read_text())
    entry = manifest["bands"][band]
    ck_bytes = Path(args.ckpt).read_bytes()
    train = json.loads(Path(args.train_json).read_text()) if args.train_json else {}
    entry.update(
        {
            "bytes": len(data),
            "sha256": sha256(data),
            "fp32Bytes": len(fp32),
            "weights": f"{casts} float16 initializers behind Cast",
            "fixturePositions": len(rows),
            "maxAbsProbDiffOnnxVsTorch": max_diff,
            "fineTuned": {
                "script": "tools/timing-finetune/train.py",
                "export": "tools/timing-finetune/export.py",
                "from": entry["checkpoint"]["path"],
                "checkpointSha256": sha256(ck_bytes),
                "data": args.note or "chess.com games (fit-split movers)",
                "contract": train.get("args", {}).get("contract"),
                "minRating": train.get("args", {}).get("min_rating"),
                "trainMoves": train.get("train_moves"),
                "bestValNll": train.get("best_val_nll"),
            },
        }
    )
    (out / "models.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    (out / "scalers.json").write_text(json.dumps(scalers, indent=1) + "\n", encoding="utf-8")
    print(f"{band}: {len(data):,} bytes sha256 {entry['sha256']}")

    if args.install:
        shutil.copy(out / f"{band}.onnx", ASSETS / f"{band}.onnx")
        shutil.copy(out / "models.json", ASSETS / "models.json")
        shutil.copy(out / "scalers.json", ASSETS / "scalers.json")
        shutil.copy(out / "chessmimic-reference.json", FIXTURE)
        src = REGISTRY.read_text()
        pat = re.compile(r'("' + re.escape(band) + r'": \{\n\t\tbytes: )[0-9_]+(,\n\t\tsha256: ")[0-9a-f]+(")')
        grouped = f"{len(data):_}"
        src, n = pat.subn(lambda m: m.group(1) + grouped + m.group(2) + entry["sha256"] + m.group(3), src)
        if n != 1:
            raise SystemExit("registry entry not found in models.ts")
        REGISTRY.write_text(src)
        print("installed into the worktree")
    return 0


if __name__ == "__main__":
    sys.exit(main())

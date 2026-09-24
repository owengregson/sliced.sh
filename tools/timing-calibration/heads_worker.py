"""tools/timing-calibration/heads_worker.py: batched ChessMimic inference in native onnxruntime.

    tools/data/.venv/bin/python tools/timing-calibration/heads_worker.py [--tag T] [--models DIR]

It reads `heads-requests[.T].jsonl` from `heads.ts --emit`. That file holds the token ids and the
standardised rating and clocks, computed by the shipped TypeScript. It writes
`heads[.T].jsonl` as `{id, band, probs[30]}`. The band files are the shipped fp16 ONNX, or a
candidate set via `--models`. `heads.ts --check` compares a sample against onnxruntime-web.
"""

from __future__ import annotations

import argparse
import json
import os
from collections import defaultdict

import numpy as np
import onnxruntime as ort

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.environ.get("SL_TIMING_CALIB_DIR", os.path.join(ROOT, "data", "timing", "calib"))
BATCH = 256


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="")
    ap.add_argument("--models", default=os.path.join(ROOT, "assets", "models", "chessmimic"))
    ap.add_argument("--threads", type=int, default=2)
    args = ap.parse_args()
    suffix = f".{args.tag}" if args.tag else ""
    by_band: dict[str, list[dict]] = defaultdict(list)
    with open(os.path.join(DATA, f"heads-requests{suffix}.jsonl")) as f:
        for line in f:
            if line.strip():
                r = json.loads(line)
                by_band[r["band"]].append(r)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = args.threads
    opts.inter_op_num_threads = 1
    out_path = os.path.join(DATA, f"heads{suffix}.jsonl")
    n = 0
    with open(out_path + ".tmp", "w") as out:
        for band, reqs in sorted(by_band.items()):
            model = os.path.join(args.models, f"{band}.onnx")
            if not os.path.exists(model):  # a candidate set may replace only some bands
                model = os.path.join(ROOT, "assets", "models", "chessmimic", f"{band}.onnx")
            sess = ort.InferenceSession(model, opts, providers=["CPUExecutionProvider"])
            for i in range(0, len(reqs), BATCH):
                chunk = reqs[i : i + BATCH]
                feeds = {
                    "input_ids": np.array([r["ids"] for r in chunk], dtype=np.int32),
                    "scaled_rating": np.array([r["rating"] for r in chunk], dtype=np.float32),
                    "clock_features": np.array([r["clocks"] for r in chunk], dtype=np.float32),
                }
                probs = sess.run(["probs"], feeds)[0]
                for r, p in zip(chunk, probs):
                    out.write(json.dumps({"id": r["id"], "band": band, "probs": [round(float(x), 7) for x in p]}) + "\n")
                n += len(chunk)
            print(f"{band}: {len(reqs)} rows", flush=True)
    os.replace(out_path + ".tmp", out_path)
    print(f"{n} rows -> {out_path}")


if __name__ == "__main__":
    main()

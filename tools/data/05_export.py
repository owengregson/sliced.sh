#!/usr/bin/env python3
"""05_export.py — export a 04_train.py checkpoint to float16 JSON (Appendix D §3b.2) and,
optionally, ONNX. Output keys: W1, b1, gamma, delta, W2, b2, W3, b3, feature_mean, feature_std,
buckets, features. Not used by the shipped product (ChessMimic is the timing head); kept for
evaluation experiments.
"""
from __future__ import annotations

import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("checkpoint", help="data/v2-mlp.pt from 04_train.py")
    ap.add_argument("--out", default="data/v2-mlp.json")
    ap.add_argument("--onnx", default="", help="also write an ONNX graph here")
    args = ap.parse_args()
    try:
        import numpy as np
        import torch
    except ImportError:
        print("pip install torch numpy", file=sys.stderr)
        return 2
    ck = torch.load(args.checkpoint, map_location="cpu")
    st = ck["state"]

    def f16(t):
        return np.asarray(t.detach().numpy(), dtype=np.float16).astype(float).tolist()

    payload = {
        "W1": f16(st["l1.weight"]), "b1": f16(st["l1.bias"]), "gamma": f16(st["gamma"]), "delta": f16(st["delta"]),
        "W2": f16(st["l2.weight"]), "b2": f16(st["l2.bias"]), "W3": f16(st["l3.weight"]), "b3": f16(st["l3.bias"]),
        "feature_mean": ck["feature_mean"], "feature_std": ck["feature_std"], "buckets": ck["buckets"], "features": ck["features"],
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print(f"wrote {args.out}")
    if args.onnx:
        print("ONNX export requires re-instantiating the module from 04_train.py; see README.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

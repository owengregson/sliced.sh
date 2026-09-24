"""tools/calibration/maia_worker.py - native onnxruntime runner for tools/calibration/maia-batch.ts.

One long-lived process per worker: loads the joined Maia-3 ONNX once, then answers batch files.
The Bun side owns the encoding and the decoding (the shipped `encodeMaiaInputs` /
`decodeMaiaOutputs`); this process only runs the model and gathers the move logits at each
position's legal indices, so a result file is ~40 floats per query instead of 4352.

Providers:
  cpu     the joined model as shipped, onnxruntime CPU EP, dynamic batch.
  coreml  onnxruntime CoreML EP (MLProgram, CPUAndGPU, fp32). CoreML cannot take the shipped
          graph whole (dynamic batch, Einsum, a data-dependent Expand: 46 partitions, slower than
          the CPU), so this worker derives a *static-batch* copy once and caches it next to the
          joined model: batch fixed to --max-batch, ORT basic optimisation (constant folding of
          the fp16->fp32 weight casts), each Einsum rewritten as the equivalent MatMul
          ("bhi,oi->bho" = X @ W^T with W^T pre-transposed, "bid,bjd->bij" = A @ B^T) and the
          two Expand shapes made constant. The result runs in 2 partitions on the GPU in fp32;
          a partial batch is zero-padded. maia-parity.ts --provider coreml is the proof.

Protocol (stdin/stdout, one line each):
  -> "<in.bin> <out.bin>\n"      <- "ok\n"  or  "err <message>\n"
  EOF on stdin ends the process. "ready <provider>\n" is printed once the session is loaded.

Batch file (little-endian):
  b"MBQ1", u32 P (positions), u32 Q (queries), u32 L (legal indices in total)
  f32 tokens[P, 64, 96]
  i32 legal_offsets[P + 1]          (position p owns legal[offsets[p]:offsets[p + 1]])
  i32 legal[L]
  i32 query_pos[Q]
  f32 self_elo[Q]
  f32 oppo_elo[Q]
Result file:
  b"MBR1", u32 Q, u32 T
  f32 data[T]   per query in order: its position's legal move logits, then the 3 value logits

Usage: maia_worker.py --model PATH [--threads N] [--provider cpu|coreml] [--max-batch B]
"""

import argparse
import os
import sys

import numpy as np
import onnxruntime as ort

SQUARES = 64
TOKEN_DIM = 96


def static_model(model: str, batch: int) -> str:
    """The CoreML-friendly static-batch derivative of `model`, built once and cached."""
    target = f"{os.path.splitext(model)[0]}.coreml-b{batch}.onnx"
    if os.path.exists(target):
        return target
    import onnx
    from onnx import helper, numpy_helper
    from onnxruntime.tools.onnx_model_utils import make_dim_param_fixed

    fixed = onnx.load(model)
    make_dim_param_fixed(fixed.graph, "batch", batch)
    fixed_path = f"{target}.{os.getpid()}.fixed.tmp"
    folded_path = f"{target}.{os.getpid()}.folded.tmp"
    onnx.save(fixed, fixed_path)
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    options.optimized_model_filepath = folded_path
    ort.InferenceSession(fixed_path, options, providers=["CPUExecutionProvider"])
    m = onnx.load(folded_path)
    graph = m.graph
    inits = {i.name: i for i in graph.initializer}
    nodes = []
    transposed = set()
    for n in graph.node:
        if n.op_type == "Einsum":
            eq = n.attribute[0].s.decode()
            a, b = n.input
            if eq == "bhi,oi->bho":
                name = f"{b}__T"
                if name not in transposed:
                    w = numpy_helper.to_array(inits[b])
                    graph.initializer.append(numpy_helper.from_array(np.ascontiguousarray(w.T), name))
                    transposed.add(name)
                nodes.append(helper.make_node("MatMul", [a, name], list(n.output), name=n.name))
                continue
            if eq == "bid,bjd->bij":
                bt = f"{n.name}__bT"
                nodes.append(helper.make_node("Transpose", [b], [bt], perm=[0, 2, 1], name=bt))
                nodes.append(helper.make_node("MatMul", [a, bt], list(n.output), name=n.name))
                continue
            raise ValueError(f"unexpected Einsum {eq}")
        if n.op_type == "Expand":
            shape = f"{n.name}__shape"
            graph.initializer.append(
                numpy_helper.from_array(np.array([batch, SQUARES, 128], np.int64), shape)
            )
            nodes.append(helper.make_node("Expand", [n.input[0], shape], list(n.output), name=n.name))
            continue
        nodes.append(n)
    del graph.node[:]
    graph.node.extend(nodes)
    onnx.checker.check_model(m)
    # The CoreML EP keys its compiled-model cache on this metadata entry.
    entry = m.metadata_props.add()
    entry.key = "COREML_CACHE_KEY"
    entry.value = f"maia379mb{batch}v1"
    tmp = f"{target}.{os.getpid()}.tmp"
    onnx.save(m, tmp)
    os.replace(tmp, target)
    for path in (fixed_path, folded_path):
        os.remove(path)
    return target


def make_session(model: str, threads: int, provider: str, batch: int) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.log_severity_level = 3
    if provider == "coreml":
        coreml = {
            "ModelFormat": "MLProgram",
            "MLComputeUnits": "CPUAndGPU",
            "RequireStaticInputShapes": "1",
            # Compiled MLProgram cache: skips the ~28 s compile after the first start.
            "ModelCacheDirectory": os.path.join(os.path.dirname(model), "coreml-cache"),
        }
        return ort.InferenceSession(
            static_model(model, batch),
            options,
            providers=[("CoreMLExecutionProvider", coreml), "CPUExecutionProvider"],
        )
    return ort.InferenceSession(model, options, providers=["CPUExecutionProvider"])


def read_batch(path: str):
    raw = np.fromfile(path, dtype=np.uint8)
    if raw[:4].tobytes() != b"MBQ1":
        raise ValueError("bad batch magic")
    p, q, l = (int(x) for x in raw[4:16].view("<u4"))
    offset = 16

    def take(dtype: str, count: int) -> np.ndarray:
        nonlocal offset
        size = np.dtype(dtype).itemsize * count
        out = raw[offset : offset + size].view(dtype)
        offset += size
        return out

    tokens = take("<f4", p * SQUARES * TOKEN_DIM).reshape(p, SQUARES, TOKEN_DIM)
    offsets = take("<i4", p + 1)
    legal = take("<i4", l)
    query_pos = take("<i4", q)
    self_elo = take("<f4", q)
    oppo_elo = take("<f4", q)
    return tokens, offsets, legal, query_pos, self_elo, oppo_elo


def run_batch(session, max_batch: int, static: bool, path_in: str, path_out: str) -> None:
    tokens, offsets, legal, query_pos, self_elo, oppo_elo = read_batch(path_in)
    q = len(query_pos)
    counts = (offsets[1:] - offsets[:-1])[query_pos]
    starts = offsets[query_pos]
    parts = []
    for lo in range(0, q, max_batch):
        hi = min(q, lo + max_batch)
        x = tokens[query_pos[lo:hi]]
        se = self_elo[lo:hi]
        oe = oppo_elo[lo:hi]
        if static and hi - lo < max_batch:
            pad = max_batch - (hi - lo)
            x = np.concatenate([x, np.zeros((pad, SQUARES, TOKEN_DIM), np.float32)])
            se = np.concatenate([se, np.zeros(pad, np.float32)])
            oe = np.concatenate([oe, np.zeros(pad, np.float32)])
        feeds = {
            "tokens": np.ascontiguousarray(x, dtype=np.float32),
            "self_elo": np.ascontiguousarray(se, dtype=np.float32),
            "oppo_elo": np.ascontiguousarray(oe, dtype=np.float32),
        }
        move, value = session.run(["move_logits", "value_logits"], feeds)
        for row in range(hi - lo):
            i = lo + row
            s = starts[i]
            parts.append(move[row, legal[s : s + counts[i]]].astype("<f4", copy=False))
            parts.append(value[row].astype("<f4", copy=False))
    data = np.concatenate(parts) if parts else np.zeros(0, "<f4")
    with open(path_out, "wb") as fh:
        fh.write(b"MBR1")
        fh.write(np.array([q, data.size], dtype="<u4").tobytes())
        fh.write(data.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--provider", choices=["cpu", "coreml"], default="cpu")
    parser.add_argument("--max-batch", type=int, default=32)
    args = parser.parse_args()
    session = make_session(args.model, args.threads, args.provider, args.max_batch)
    active = session.get_providers()[0]
    sys.stdout.write(f"ready {active}\n")
    sys.stdout.flush()
    static = args.provider == "coreml"
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            path_in, path_out = line.split(" ", 1)
            run_batch(session, args.max_batch, static, path_in, path_out)
            sys.stdout.write("ok\n")
        except Exception as error:  # reported to the Bun side, which aborts the run
            message = str(error).replace("\n", " ")
            sys.stdout.write(f"err {type(error).__name__}: {message}\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

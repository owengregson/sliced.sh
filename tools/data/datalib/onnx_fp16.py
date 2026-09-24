"""fp16 weights behind `Cast`: every float initializer with at least `min_elements` elements is
stored as float16 and cast back to float32 at the graph's start. onnxruntime constant-folds the
casts at session load, so the arithmetic stays fp32 while the file halves."""
from __future__ import annotations

from collections.abc import Callable


def to_fp16_weights(onnx, np, model_bytes: bytes, min_elements: int, keep_fp32: Callable[[str], bool] = lambda name: False) -> tuple[bytes, int]:
    """(the rewritten model, how many initializers were halved). `keep_fp32(name)` leaves an
    initializer in fp32; a weight outside the float16 range stops the export."""
    from onnx import TensorProto, helper, numpy_helper

    model = onnx.load_from_string(model_bytes)
    graph = model.graph
    casts = []
    for init in list(graph.initializer):
        if init.data_type != TensorProto.FLOAT:
            continue
        arr = numpy_helper.to_array(init)
        if arr.size < min_elements:
            continue
        if keep_fp32(init.name):
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

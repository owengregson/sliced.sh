"""The ChessMimic clock model (`ClockTrainer.ClockPatzerModel`, as exported by
`tools/data/08_export_chessmimic.py`) returning logits, plus data plumbing shared by the
evaluation and fine-tuning scripts."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cmenc  # noqa: E402

MAIN = Path("/Users/owengregson/Documents/sliced.sh")
CHECKPOINTS = MAIN / "tools" / "data" / "upstream" / "checkpoints"
D, WIDENING, LAYERS, HEADS = 256, 4, 8, 8
N_ACTIONS = 1968


class MlpBlock(nn.Module):
    def __init__(self, d: int, h: int):
        super().__init__()
        self.layer_norm = nn.LayerNorm(d)
        self.split1_linear = nn.Linear(d, h, bias=False)
        self.split2_linear = nn.Linear(d, h, bias=False)
        self.activation = nn.SiLU()
        self.join_linear = nn.Linear(h, d, bias=False)

    def forward(self, x):
        x = self.layer_norm(x)
        return self.join_linear(self.activation(self.split1_linear(x)) * self.split2_linear(x))


class AttentionBlock(nn.Module):
    def __init__(self, d: int, heads: int):
        super().__init__()
        self.layer_norm = nn.LayerNorm(d)
        self.self_attention = nn.MultiheadAttention(embed_dim=d, num_heads=heads, batch_first=True)

    def forward(self, x):
        x = self.layer_norm(x)
        return self.self_attention(query=x, key=x, value=x, need_weights=False)[0]


class ClockModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.board_embedding = nn.Embedding(cmenc.INPUT_VOCAB_SIZE, D)
        self.rating_embedding = nn.Linear(1, D)
        self.clock_time_embedding = nn.Linear(3, D)
        self.recent_moves_embedding = nn.Embedding(N_ACTIONS, D)
        self.learned_positional_encoding = nn.Parameter(torch.randn(cmenc.RECENT_MOVES + cmenc.FEN_TOKENS + 2, D))
        self.mlp_blocks = nn.ModuleList([MlpBlock(D, D * WIDENING) for _ in range(LAYERS)])
        self._attention_blocks = nn.ModuleList([AttentionBlock(D, HEADS) for _ in range(LAYERS)])
        self.layer_norm = nn.LayerNorm(D)
        self.time_classifier = nn.Linear(D, cmenc.N_BUCKETS)

    def forward(self, input_ids, scaled_rating, clock_features):
        ids = input_ids.long()
        # The PAD token (32) indexes the move embedding too, exactly as upstream does.
        recent = self.recent_moves_embedding(ids[:, : cmenc.RECENT_MOVES])
        board = self.board_embedding(ids[:, cmenc.RECENT_MOVES:])
        r = self.rating_embedding(scaled_rating.unsqueeze(1)).unsqueeze(1)
        c = self.clock_time_embedding(clock_features).unsqueeze(1)
        x = torch.cat([recent, r, c, board], dim=1) + self.learned_positional_encoding
        for mlp, att in zip(self.mlp_blocks, self._attention_blocks):
            x = x + att(x)
            x = x + mlp(x)
        return self.time_classifier(self.layer_norm(x)[:, -1, :])


class Softmaxed(nn.Module):
    """The exported graph: logits → softmax (masking is applied by the runtime)."""

    def __init__(self, inner: ClockModel):
        super().__init__()
        self.inner = inner

    def forward(self, input_ids, scaled_rating, clock_features):
        return F.softmax(self.inner(input_ids, scaled_rating, clock_features), dim=1)


def load(path: Path | str) -> ClockModel:
    m = ClockModel()
    ck = torch.load(path, map_location="cpu", weights_only=False)
    state = ck.get("state_dict", ck)
    clean = {}
    for k, v in state.items():
        for p in ("model.", "_orig_mod."):
            if k.startswith(p):
                k = k[len(p):]
        clean[k] = v
    m.load_state_dict(clean, strict=True)
    assert sum(p.numel() for p in m.parameters()) == 8_950_558
    return m.eval()


def upstream(band: str) -> ClockModel:
    return load(CHECKPOINTS / f"{band}_brier.model.ckpt")


def device() -> torch.device:
    return torch.device("mps" if torch.backends.mps.is_available() else "cpu")


# ── data ──────────────────────────────────────────────────────────────────────────────────


def load_examples(path: Path) -> dict[str, np.ndarray]:
    """An extract: `<dir>/examples/*.npy` (memory-mapped) or a legacy `examples.npz`."""
    path = Path(path)
    if path.is_dir() or path.suffix != ".npz":
        d = path if path.name == "examples" else path / "examples"
        return {f.stem: np.load(f, mmap_mode="r") for f in sorted(d.glob("*.npy"))}
    with np.load(path) as z:
        return {k: z[k] for k in z.files}


def window_ids(ids: np.ndarray, cur: np.ndarray, contract: str) -> np.ndarray:
    """`history`: production (moves before the position). `with_current`: upstream training —
    the last 11 history moves plus the timed move (identical to re-encoding history + move)."""
    if contract == "history":
        return ids
    out = ids.copy()
    out[:, : cmenc.RECENT_MOVES - 1] = ids[:, 1 : cmenc.RECENT_MOVES]
    out[:, cmenc.RECENT_MOVES - 1] = cur
    return out


def model_inputs(ex: dict, idx: np.ndarray, band: str, scalers: dict, contract: str = "history", clamp=None, ids_dtype=np.int32):
    s = scalers[band]
    sr, cf = cmenc.standardise(ex["rating"][idx], ex["pclock"][idx], ex["oclock"][idx], ex["inc"][idx], band, s, clamp)
    ids = window_ids(ex["ids"][idx], ex["cur"][idx], contract).astype(ids_dtype)
    return ids, sr.astype(np.float32), cf.astype(np.float32)


@torch.no_grad()
def predict(model: ClockModel, ids, sr, cf, e: np.ndarray, pclock, inc, batch: int = 1024) -> np.ndarray:
    """Masked, renormalised bucket probabilities (the runtime's `bucketMask`, temperature 1)."""
    dev = next(model.parameters()).device
    out = np.empty((len(ids), cmenc.N_BUCKETS), dtype=np.float64)
    mask = cmenc.bucket_mask(pclock, inc, e)
    for i in range(0, len(ids), batch):
        logits = model(torch.from_numpy(ids[i : i + batch]).to(dev), torch.from_numpy(sr[i : i + batch]).to(dev), torch.from_numpy(cf[i : i + batch]).to(dev))
        p = F.softmax(logits.float(), dim=1).cpu().numpy().astype(np.float64)
        p = p * mask[i : i + batch]
        out[i : i + batch] = p / p.sum(1, keepdims=True)
    return out

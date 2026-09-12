# Maia-3 in the extension — feasibility assessment (2026-09-11)

Research question from the owner: how difficult and feasible would it be to run **Maia-3**
(<https://github.com/CSSLab/maia3>, human-like move prediction with Elo conditioning) inside
sliced.sh for targets below 2800 Elo, bundling all three model sizes?

Everything in §3–§5 below was **measured on this machine on 2026-09-11** (Apple M5, 10 cores,
24 GB, macOS 26.3; Bun 1.3.11; the repo's *vendored* `onnxruntime-web` 1.29.0 wasm build; export
side torch 2.14.0 / onnx 1.22.0 / onnxruntime 1.30.0 in a scratch venv). Where a number is an
estimate or could not be measured here, it says so. No file in the repository other than this
one was created or modified; the export script, the ONNX files and the fixtures live in the
session scratchpad and are described in §9 so they can be reproduced.

---

## 1. Executive verdict

**Feasible with caveats.** Maia-3 exports to ONNX with the same exporter, opset family and
fp16-weight trick the ChessMimic timing head already uses, runs on the vendored
`onnxruntime-web` wasm build with no unsupported operators, reproduces the torch fp32 policy
(argmax 60/60, top-5 60/60 on every size), and the 5M and 23M sizes answer a position in
20–55 ms single-threaded — inside the 100 ms budget the timing head already lives under and
well inside the 150–1500 ms the engine search takes in parallel.

The caveats are real but bounded:

1. **Size.** Bundling all three sizes adds **≈ 213 MB** (fp16 weights: 10.9 + 45.9 + 156.2 MB)
   to a release zip that is already 140.5 MB / 192 MB unpacked. The 79M file alone (156 MB)
   exceeds GitHub's 100 MB per-file limit and, unlike the big NNUE, does not gzip under it.
   Recommendation: **bundle 5M + 23M (≈ 57 MB), ship 79M on demand** through the download relay
   the repo already has for exactly this purpose (`docs/models.md` §6 — implemented, unit-tested,
   not wired).
2. **79M latency.** 180–300 ms per position single-threaded in wasm. Usable only with wasm
   threads (could not be measured here — the pthread path does not run under Bun) or WebGPU
   (not verified in an offscreen document). For a *move policy* that runs in parallel with a
   ≥ 150 ms search this is not fatal, but it is over the head budget and 79M buys only
   +0.5 pp accuracy over 23M (57.1 % vs 56.6 %).
3. **Licence.** Code is AGPL-3.0-or-later. The Hugging Face model cards say only "see repo for
   code/weights license" — the weights are AGPL **by pointer**, not by an explicit statement.
   AGPL permits non-commercial redistribution (commercial too) and the extension already
   carries the identical obligations for `stockfish-web`; the one thing to avoid is
   transcribing `maia3/dataset.py` into the extension (write the 64×12 board encoding from the
   paper instead, it is ~40 lines). Worth one email to CSSLab asking them to state the weights
   licence explicitly.
4. **Memory.** A resident 23M session costs ≈ 450 MB RSS in the Bun measurement (79M fp32:
   ≈ 1 GB) on top of Stockfish's shared memory and the ChessMimic sessions in the same
   offscreen document. In-browser numbers are a QA item.
5. **int8 is not free.** Dynamic int8 quantisation shrinks the files 3–4× but changes the
   policy (top-5 agreement 47–54/60, max |Δp| 3–5 × 10⁻²). fp16 weights are lossless at the
   argmax/top-5 level (max |Δp| ≤ 6 × 10⁻⁴). Do not ship int8 without calibration work.

**Difficulty: ≈ 8–11 engineering days** for the recommended design (Maia policy as a prior over
the existing `MoveSelector` pool, 5M + 23M bundled, 79M on demand), of which 2–3 are QA and
recalibration against the §7.2 agreement bands. A "Maia-first below a threshold" mode on top
is another 3–5 days, dominated by re-validating the strength calibration (§7).

---

## 2. What Maia-3 is

Sources: the repository README and source (`maia3/models.py`, `model_registry.py`, `uci.py`,
`dataset.py`), the paper *Chessformer: A Unified Architecture for Chess Modeling*
(Monroe, Eilender, Chalmers, Tang, Anderson; ICLR 2026; <https://arxiv.org/abs/2605.19091>,
<https://openreview.net/forum?id=2ltBRzEHyd>) and the Hugging Face model cards.

### 2.1 Architecture (from `maia3/models.py`, cross-checked against the paper)

- **Encoder-only transformer over 64 square tokens** ("Chessformer"). 8 layers for every size,
  head dimension 32, MLP expansion 2, GELU, RMSNorm (post-norm), no QKV biases.
- **Input per square:** a 12-way one-hot of the piece (6 types × 2 colours) for the current
  position **and the 7 previous positions** (`history = 8`, 96 features), the board **mirrored to
  the side to move**, plus two 128-dim **Elo embeddings** (self and opponent) concatenated to every
  square, projected to the model width. Missing history is padded by repeating the earliest
  available position (the UCI wrapper does this too), so the model works from move one.
- **Positional encoding:** "Geometric Attention Bias" — a small MLP per layer that turns the board
  into an `heads × 64 × 64` additive bias on the attention logits (exported as `Einsum` +
  `LayerNormalization`; no custom op). There is a shared `4096 × gen` weight per model.
- **Elo conditioning** (`interpolate_elo`): `e = (elo/5000)·e_low + (1 − elo/5000)·e_high`, the
  rating clamped to `[0, 5000]`; two learned vectors per model, one interpolation each for
  **self Elo and opponent Elo**. Training re-samples 22 rating bins (< 600, 600–2600 in 100s,
  > 2600) so all skill levels are equally represented; the paper quotes 500–3000 as the human
  range covered. **Below 2800 is in-distribution.** Above ≈ 3000 it extrapolates.
- **Outputs:** `move_logits [4352]` = a 64×64 from→to score matrix (scaled dot product of
  per-square "from" and "to" projections) plus 256 promotion logits (8 from-files × 8 to-files ×
  {q, r, b, n}, rank 7→8 in the mirrored frame); `value_logits [3]` = (loss, draw, win) for the
  side to move; a scalar `ponder` head the UCI wrapper ignores (semantics unverified — see §8).
  The policy is **masked to legal moves and softmaxed outside the model**, so a full probability
  distribution over legal moves is available, not just a best move.
- **Move vocabulary:** 4096 from-to pairs + 256 promotions in a fixed order
  (`maia3/utils.py::get_all_possible_moves`); black's moves are mirrored back (`mirror_move`).

### 2.2 The three sizes

| Model | HF repo | Checkpoint | Params (measured) | d_model / heads | Accuracy (paper, Allie test set) |
|---|---|---|---|---|---|
| Maia3-5M | `UofTCSSLab/Maia3-5M` | `maia3-5m.pt`, 20,968,049 B | 5,230,084 | 256 / 8 | 55.4 ± 0.1 % |
| Maia3-23M | `UofTCSSLab/Maia3-23M` | `maia3-23m.pt`, 91,799,307 B | 22,936,580 | 512 / 16 | 56.6 ± 0.1 % |
| Maia3-79M | `UofTCSSLab/Maia3-79M` | `maia3-79m.pt`, 315,651,851 B | 78,899,716 | 1024 / 32 | 57.1 ± 0.1 % |
| (3M ablation) | `UofTCSSLab/Maia3-ablate-3M` | `maia3-3m.pt`, 12,659,441 B | — | 192 / 6 | — |

Checkpoints are plain PyTorch pickles (`torch.FloatStorage`, `collections.OrderedDict`), loadable
with `weights_only=True`. The previous state of the art (Allie, 355M, with search) was 55.9 %;
Maia-2 was ≈ 53–54 %. Removing history costs 1.4 pp on the 5M model (54.0 % vs 55.4 %). Sizes
and hashes from the Hugging Face API (`/api/models/<repo>?blobs=true`).

### 2.3 Licence

| Component | Licence | Evidence |
|---|---|---|
| `CSSLab/maia3` code | **AGPL-3.0-or-later** | `LICENSE` in the repo; GitHub API `license.spdx_id = AGPL-3.0` |
| Weights (`.pt` on Hugging Face) | **Not separately stated.** Model cards: "**License:** CC BY 4.0 (paper); see repo for code/weights license" | HF `README.md` of each repo; the HF API reports `license: None` |
| Paper | CC BY 4.0 | arXiv page |

Reading: the weights are distributed under the repository's AGPL-3.0 by reference. For a
non-commercial extension that means the same obligations already honoured for
`@lichess-org/stockfish-web` (AGPL) and Stockfish (GPL): ship the licence text, name the exact
upstream (repo commit + checkpoint hashes) in `docs/third-party.md`, and keep the written offer
of corresponding source honourable. AGPL §13's network clause does not apply — the model runs
on the user's machine and serves nobody over a network. An exported ONNX file is a derived work
of the weights and would be distributed under the same licence, exactly as the ChessMimic bands
are handled today. AGPL, GPL and PolyForm-NC coexist in the package as separate works; the
product stays non-commercial because of ChessMimic regardless.

Two cautions. First, "see repo" is a pointer, not a grant; an explicit line from CSSLab (an
issue or an email) would remove the ambiguity cheaply. Second, **do not transcribe
`maia3/dataset.py` / `utils.py` into `src/`** — a transcription is a derivative of AGPL code and
would put that source file under AGPL, which matters if the extension's own source is not
published. The encoding is mechanically determined by the paper (piece one-hot, mirror for
black, repeat the earliest position, from-to index order) and can be written independently,
which is what `src/core/timing/chessmimic-tokeniser.ts` did for the Apache-2.0 tokeniser.

### 2.4 Elo range and conditioning in practice

- Inputs are two floats (self, opponent), not bands, so **no per-band files**: one model covers
  the whole range, unlike ChessMimic's three 18 MB bands. The extension already has both
  numbers: `targetElo` / effective `E` for self, and `PanelSnapshot.opponent.ratingEstimate` (the
  §13.6 opponent-matching input) for the opponent, falling back to the target when unknown.
- The UCI wrapper exposes `Elo` (sets both), `SelfElo`, `OppoElo` (0–5000), `Temperature`
  (0 = argmax), `TopP`, `MultiPV` (1–20). None of that machinery is needed in the extension —
  the model call is one `session.run`, the sampling is ours.

---

## 3. Conversion path — what was actually done

### 3.1 Export

A scratch script (`export_maia3.py`, ≈ 200 lines, modelled on
`tools/data/08_export_chessmimic.py`) downloads each checkpoint with `huggingface_hub`, builds
the model from `model_registry.MODEL_SPECS`, wraps it so the inputs are
`tokens float32 [B, 64, 96]`, `self_elo float32 [B]`, `oppo_elo float32 [B]` and the outputs
`move_logits [B, 4352]`, `value_logits [B, 3]`, and exports with the **TorchScript exporter,
opset 17, constant folding, dynamic batch**. One accommodation was needed: `torch.nn.RMSNorm`
has no TorchScript ONNX symbolic, so its forward is replaced by the arithmetic
(`x · rsqrt(mean(x²) + ε) · w`), which exports as `Pow/ReduceMean/Sqrt/Div/Mul`. Everything
else exported unmodified on the first attempt for all three sizes.

Then, as for ChessMimic: every float initializer with ≥ 1024 elements stored as **float16 behind
a `Cast`** (onnxruntime constant-folds the casts at load, so the arithmetic stays fp32 — the
wasm CPU provider has no fp16 kernels — and the file halves), and a separate
`quantize_dynamic(QInt8)` variant.

### 3.2 Operators (no blockers)

| Size | Nodes | Operator families |
|---|---|---|
| 5M | 2,834 | `MatMul` 52, `Gemm` 18, `Einsum` 9, `LayerNormalization` 18, `Softmax` 8, `Erf` 24 (GELU), `ReduceMean` 25, `Pow`/`Sqrt`/`Div` (RMSNorm), `Clip` 2 (Elo clamp), `Where`/`Equal` 2, `Transpose` 64, `Reshape` 121, `Gather` 191, `Unsqueeze` 480, `Concat` 109, `Constant` 952, `Cast` 32, `Mod` 8, `Relu` 1 |
| 23M / 79M | 2,882 | same families (`MatMul` 60, `Reshape` 129) |

All standard ONNX ops in the default domain; `onnx.checker` passes; `onnxruntime-web` 1.29.0
wasm created every session with `graphOptimizationLevel: "all"` and ran it without any
fallback. The ~950 `Constant`/`Gather`/`Unsqueeze` nodes are the promotion-logit loop
(256 scalar gathers) — harmless, and collapsible to two `Gather`s if anyone cares.

### 3.3 File sizes

| Size | fp32 ONNX | fp16-weight ONNX (shippable) | int8 dynamic | .pt on HF |
|---|---|---|---|---|
| 5M | 21,136,420 B | **10,868,016 B** (54 initializers halved) | 6,773,550 B | 20,968,049 B |
| 23M | 91,183,761 B | **45,887,562 B** (95) | 25,244,098 B | 91,799,307 B |
| 79M | 311,886,570 B | **156,212,736 B** (125) | 80,637,985 B | 315,651,851 B |

SHA-256 prefixes (fp32 / fp16w / int8): 5M `8542def7a5bd` / `09c8db9720cb` / `0342f9d9e5b0`;
23M `e3fa1d451962` / `71e49f19b6f9` / `2d72d6128fb7`; 79M `3d241bb0c838` / `37fe2f32cd44` /
`786514c80810`. The export is deterministic given the checkpoint; a re-run should reproduce them.

### 3.4 Numerical parity (60 seeded positions with 8-ply history, random self/opponent Elo 800–2700)

Compared against the torch fp32 module, on the legal-move-masked softmax:

| Size | Variant | Python ORT max \|Δp\| | argmax agree | wasm (Bun) argmax | wasm top-5 agree | wasm max \|Δp\| (top moves) |
|---|---|---|---|---|---|---|
| 5M | fp32 | 4.2e-6 | 60/60 | 60/60 | 60/60 | 4.6e-6 |
| 5M | fp16w | 3.7e-4 | 60/60 | 60/60 | 60/60 | 3.7e-4 |
| 5M | int8 | 3.6e-2 | 58/60 | 59/60 | **52/60** | 3.1e-2 |
| 23M | fp32 | 4.6e-6 | 60/60 | 60/60 | 60/60 | 6.6e-6 |
| 23M | fp16w | 3.0e-4 | 60/60 | 60/60 | 60/60 | 3.1e-4 |
| 23M | int8 | 3.8e-2 | 57/60 | 58/60 | **54/60** | 5.3e-2 |
| 79M | fp32 | 8.3e-6 | 60/60 | 60/60 | 60/60 | 1.1e-5 |
| 79M | fp16w | 6.1e-4 | 60/60 | 60/60 | 60/60 | 6.0e-4 |
| 79M | int8 | 5.0e-2 | 58/60 | 59/60 | **47/60** | 3.5e-2 |

fp16 weights are the right shipping layout, as they were for ChessMimic. int8 dynamic
quantisation moves 3–5 % of probability mass around and breaks the top-5 ordering in
10–20 % of positions — for a model whose whole point is the *distribution* over plausible
moves, that is a behavioural change, not a rounding error.

### 3.5 Latency

**Vendored `onnxruntime-web` 1.29.0 wasm under Bun, one thread, `graphOptimizationLevel: "all"`,
180 queries per cell (60 positions × 3), batch 1**, on the same path the offscreen document
takes (`createOrtRuntime` → `InferenceSession.create` → `run`). The ChessMimic head measured
**28.5 ms p50 / 29.3 ms p95** on this path on this machine (`docs/models.md` §5).

| Size | Variant | p50 | p95 | max | session create | warm-up query |
|---|---|---|---|---|---|---|
| 5M | fp32 | **20.3 ms** | 28.6 ms | 36.7 ms | 507 ms | 52 ms |
| 5M | fp16w | **20.3 ms** | 26.6 ms | 33.2 ms | 508 ms | 48 ms |
| 5M | int8 | 21.9 ms | 26.0 ms | 32.3 ms | 496 ms | 60 ms |
| 23M | fp32 | **53.2 ms** | 85.3 ms | 99.6 ms | 408 ms | 85 ms |
| 23M | fp16w | **50.7 ms** | 63.4 ms | 78.8 ms | 460 ms | 86 ms |
| 23M | int8 | 54.6 ms | 89.2 ms | 99.3 ms | 440 ms | 121 ms |
| 79M | fp32 | 242 ms | 306 ms | 408 ms | 789 ms | 317 ms |
| 79M | fp16w | **184 ms** | 214 ms | 282 ms | 716 ms | 300 ms |
| 79M | int8 | 191 ms | 233 ms | 356 ms | 403 ms | 304 ms |

Native Python onnxruntime (CPU EP, one thread) for scale: 5M 5.6 ms, 23M 23.4 ms, 79M 49.8 ms
p50 — the wasm build is 2.3–4.9× slower than native single-threaded, consistent with the
ChessMimic experience. Analytic cost per position: **0.64 GFLOP (5M), 2.5 GFLOP (23M),
9.5 GFLOP (79M)** versus 1.6 GFLOP for the ChessMimic head; the measured wasm throughput
(31–47 GFLOP/s effective) lines up with those, so the numbers are not an artefact of the fixture.

Not measured: the multi-threaded wasm path (the pthread worker does not run under Bun — the same
limitation `test/integration/chessmimic-onnx.test.ts` documents), the offscreen document itself,
and WebGPU. Expect threads to help the 23M/79M matmuls substantially; expect the in-browser
single-thread figure to match Bun (same wasm), as it did for ChessMimic.

**Interpretation against the pipeline.** `RecommendationPipeline.run` already overlaps
timing-head preparation with the engine search (`SEARCH_BUDGET.moveMs`: 400 ms bullet, 600 ms
blitz, 1000 ms rapid, floor 150 ms, cap 4000 ms). A Maia query issued at the same moment is
hidden behind the search for 5M in every time control and for 23M in everything but the
150 ms floor. What is *not* hidden is CPU contention: the offscreen document's main thread also
routes UCI lines, and Stockfish runs `clamp(cores − 2, 1, 4)` threads next to it, so a
50–200 ms single-threaded Maia run delays engine output on a 4-core laptop. The 100 ms head
budget is the right yardstick, and 5M/23M meet it; 79M does not without threads or a GPU.

### 3.6 Memory

RSS delta of the Bun process after `InferenceSession.create` (an upper bound on the wasm heap,
one session, batch 1): 5M fp16w **+269 MB**, 23M fp32 **+452 MB** / fp16w +443 MB / int8
+275 MB, 79M fp32 **+1,054 MB** / fp16w +895 MB / int8 +388 MB. fp16 weights save disk, not RAM
— the casts are folded to fp32 at load, exactly as `docs/models.md` notes for ChessMimic. The
wasm module's maximum memory is 65,536 pages (4 GiB), so even 79M fp32 loads; the question is
what else shares the document: Stockfish's shared memory (`LIMITS.engineMemoryInitialPages`
2560 = 160 MiB initial, max 512 MiB) and up to `LIMITS.timingSessionsMax` (2) ChessMimic
sessions. Keeping **one** Maia session resident (LRU 1) and warming it from the waiting view is
the sane policy; the in-browser footprint is a QA measurement (`docs/qa-checklist.md` E4 is the
template).

### 3.7 Cold load

Session create 0.4–0.8 s plus a 50–320 ms warm-up query, on the offscreen main thread, **plus**
reading the bytes from the package (a 46–156 MB `fetch(chrome.runtime.getURL(...))`, not
measured). This is the same shape as the ChessMimic pre-warm that `docs/models.md` §5 warns
about (≈ 200 ms of main-thread work delaying `loadNnue` and the first `uci`), scaled up 2–4×,
so it must be gated exactly like `warmTiming` and paid in the waiting view before the game,
never inside a move window.

### 3.8 Packaging limits

- `scripts/verify-dist.ts` caps **only** `js/panel.js` (400 KB) and `js/content.js` (250 KB);
  there is no total-package cap. (The 16 MB figure in the brief is not in this repo.) Assets
  under `assets/**` are copied wholesale by `copyBundledAssets`, so a new `assets/models/maia3/`
  directory ships with no build change.
- The current release is **140.5 MB zipped, 192 MB unpacked** (`release/sliced-2.0.0.zip`,
  `dist/`, measured today). All three sizes at fp16 add ≈ 213 MB unpacked and roughly the same
  zipped (fp16 weights are near-incompressible; the fp16w files above are already the
  compressed form).
- The Chrome Web Store's package limit is 2 GB (<https://developer.chrome.com/docs/webstore/publish>),
  and irrelevant here: §12.2 distributes a zip plus the unpacked folder, no CWS.
- The binding limit is the **Git host's 100 MB per-file cap**, which is why the big NNUE is
  checked in as deterministic gzip. 79M fp16w (156 MB) cannot be gzipped under it; it needs Git
  LFS (the export script can fetch through the LFS batch API, as the ChessMimic one does) or
  hosting on `sliced.sh` behind the download relay. `docs/DEVELOPMENT.md` already notes that a
  70 MB push needs `http.postBuffer` raised.

---

## 4. Concrete blockers and how hard each is

| # | Blocker | Severity | Resolution |
|---|---|---|---|
| 1 | Weights licence stated only by pointer ("see repo" → AGPL-3.0) | Low for a non-commercial build; procedural | Same notice + source offer as stockfish-web, generated by `vendor-engine`; ask CSSLab for an explicit statement; write the encoder from the paper, not from `dataset.py` |
| 2 | +213 MB to bundle all three; 79M exceeds the Git per-file limit | Medium | Bundle 5M + 23M (57 MB); 79M on demand via the existing relay (3 wiring steps, `docs/models.md` §6), LFS or `sliced.sh` hosting |
| 3 | 79M single-thread latency 180–300 ms | Medium | Threads (unmeasured) / WebGPU (unverified in offscreen, needs `ort.webgpu.min.mjs` + the 27 MB `ort-wasm-simd-threaded.jsep.wasm`); or simply do not make 79M the default — it is +0.5 pp over 23M |
| 4 | Memory next to Stockfish + ChessMimic in one document | Medium, unmeasured in-browser | One resident Maia session, LRU 1; QA measurement |
| 5 | int8 alters the policy | Low (do not ship int8) | fp16 weights, as today |
| 6 | Unsupported ops | **None** | — |
| 7 | Cold load on the offscreen main thread (0.5–1 s + asset read) | Low | Gate like `warmTiming`, warm in the waiting view |
| 8 | Strength calibration shifts (top-1 / ACPL bands, blunder model) | Medium, design work not code | See §6–§7; keep the rails, measure against `AGREEMENT_BANDS` |

Nothing on this list is a "not now". The genuine cost is integration and recalibration, not
conversion.

---

## 5. What Maia-3 would add, and what it would not

- **Adds:** a calibrated distribution over legal moves conditioned on *both* ratings, learned
  from 2023–2025 Lichess blitz — the thing `MoveSelector` approximates today with a
  centipawn-loss softmax (`τ(E)`, `σ(E)`, `G(E)`), a hand-written 25-row heuristic prior
  (`prior.ts`) and a blunder channel. Maia's policy already encodes recaptures, development,
  "humans miss this tactic at 1200", opening-book-like preferences and the shape of typical
  errors, per rating.
- **Adds:** a WDL value head (side to move) that could feed the panel's eval when the engine is
  still searching, and a scalar `ponder` head whose meaning is unverified (§8) — if it is a
  think-time predictor it is worth a look next to ChessMimic, but that is a separate study.
- **Does not change:** anything the telemetry contract (C7) covers. Maia decides *which* move;
  the timing model and the executor decide *when* and *how*, unchanged. No page-realm code, no
  new host in the page bundles, no `web_accessible_resources`.
- **Does not remove:** the engine. The never-play rails (mated lines, hanging pieces, forced
  mates, conversion and repetition guards) need engine scores; Maia does not know a move loses
  a queen, it knows a 1400 would play it. Keeping Stockfish as the referee is the design.

---

## 6. Recommended integration design for this codebase

The shape is a second instance of the pattern Task 34 built for ChessMimic — a verified asset
store, an offscreen inference host behind the `sl-engine` port, a service-worker port with a
per-query expiry, and a pure core module that builds the inputs and decodes the outputs.
File-by-file:

**Constants (C1).**
- `src/core/constants/models.ts`: `MAIA_DIR = "assets/models/maia3/"`, a `MAIA_MODEL_FILES`
  registry (`{ bytes, sha256, bundled }` per size, like `CHESSMIMIC_BAND_FILES`), `MAIA_UPSTREAM`
  (repo, commit, checkpoint hashes, licence).
- `src/core/constants/urls.ts`: `maiaModelBase: \`${WEBSITE}/models/maia3/\`` — `sliced.sh` is
  already classified in `HOST_OWNERS`, so `verify-dist` needs no change.
- `src/core/constants/limits.ts`: `policySessionsMax: 1`, `policyInferenceThreadsMax`.
- `src/core/constants/messages.ts`: `{ kind: "policy"; id; inputs }` → `{ kind: "policy-result";
  id; probs: number[] | null; wdl?; model; ms?; error? }`, `{ kind: "policy-warm"; model }`, and a
  `maia-request` / `maia-chunk` pair (or add a `family` field to `model-chunk`; a second
  `AssetSpec` is the cleaner route because `ModelStore.accepts` is band-specific).
- `src/core/constants/storage-keys.ts`: `MAIA_DB` next to `MODEL_DB`.

**Core (pure, unit-tested under 5 ms).**
- `src/core/policy/maia-encoder.ts`: FEN + up to 7 previous FENs → `Float32Array(64·96)`
  (mirror for black, repeat the earliest position), `moveIndex(uci, mirrored)` /
  `indexToUci(i, mirrored)` for the 4096 + 256 vocabulary, and `legalMask(fen)` from chess.js.
  Written from the paper's description (§2.3). Fixture test: 200 positions with tokens and
  torch top-5 from the export script, bit-exact on tokens.
- `src/core/policy/maia-policy.ts`: mask → softmax → `Map<uci, p>`; temperature; helpers to
  turn the map into a `MoveSelector` prior.

**Offscreen.**
- `src/offscreen/maia-store.ts`: `class MaiaStore extends AssetStore` (bundled path, SHA-256,
  OPFS/IndexedDB cache, relay request) — 60 lines, a copy of `model-store.ts`.
- `src/offscreen/policy-inference.ts`: a copy of `timing-inference.ts` with one session per
  size, LRU 1, `warm(model)`, the single-thread retry, and `policy-result` replies that never
  throw across the port. Reuse `createOrtRuntime` as is (one runtime, two model families).
- `engine-host.ts` `serveEnginePort`: route `policy`, `policy-warm`, `maia-chunk`; `configure`
  gains `warmPolicy?: string` beside `warmTiming`. `index.ts` builds the store and host.

**Service worker.**
- `src/service/handlers/engine/policy-infer.ts`: a copy of `timing-infer.ts` (per-query expiry,
  `warm`, `dispose`).
- `src/service/handlers/engine/maia-download.ts`: `attachDownloadRelay` with a Maia spec;
  `registerEngineHandlers` attaches it (this is also the moment to attach the ChessMimic one).
- `src/service/game-stack.ts`: build the port, pass `warmPolicy` into the session deps; the
  session warms the selected size where it calls `warmTiming` today (`session.ts:2903`).
- `src/service/game-session/recommendation.ts`: issue `policy.prepare({fen, historyFens,
  selfElo: E, oppoElo})` at the same point `timing.prepare` is issued, await it under the same
  `finishTimingPreparation` window, and pass the result to `selectMove(pool, ctx, prior)` — the
  third parameter already exists and `resolvePriorsDetailed` already records a `supplied` term
  in the rationale.

**Panel.** `Settings.strength.humanModel: "off" | "5m" | "23m" | "79m"` (default `"5m"` or
`"off"` for the first release), one row in `settings/rows.ts`, copy in `copy.ts`, and the Engine
view's diagnostics line (model, ms, fallback reason) mirroring the timing head's.

**Build and provenance.** `tools/data/09_export_maia3.py` (the scratch script, tidied to the
`08_` conventions: pinned commit, LFS/HF download with hash check, fp16 export, fixture,
`models.json`); `scripts/vendor-engine.ts` gains a Maia section so `docs/third-party.md` carries
the AGPL notice and the source offer; `test/scripts/maia-assets.test.ts` (sizes and hashes vs
the registry) and an extension of `test/scripts/manifest-hosts.test.ts` for a non-bundled
size; `test/integration/maia-onnx.test.ts` (vendored ORT vs torch fixture, p50 under budget).

**How the prior combines (option A, recommended first).** `selectMove` weights each candidate
by `exp(−loss/τ) · max(prior, 1e-3)^β` with `β(E)` = 0.6 / 0.4 / 0.2 by band. A raw Maia
probability spans several orders of magnitude, so the supplied prior should be normalised
against the pool (e.g. `p_maia(uci) / max_pool p_maia`) and optionally blended with the
heuristic prior (`prior_heur^(1−λ) · prior_maia^λ`) so that a single knob `λ` moves between
today's behaviour and Maia's. Every rail, the blunder channel, the clock-pressure and
conversion logic, the quality accounting and the rationale strings keep working unchanged;
the only new rationale row is `supplied ×k`.

**Candidate pool.** Maia's top moves are sometimes outside the engine's MultiPV set
(`SEARCH_BUDGET.selectionCandidates` asks for 12–20 roots below 2600, so this is rarer than it
sounds). Option A simply cannot pick a move the engine has not scored; that is the safe
default. If it matters, the fix is to ask the engine to score Maia's top-k with `go searchmoves`
in the retry slot `RecommendationPipeline.analyse` already has — not to bypass the engine.

**Option B (later, behind the same setting).** Below a threshold (say `E < 2200`) sample from
Maia's distribution restricted to candidates within `G(E)` of the best engine score, with the
never-play rails still applied, and run the engine at full strength rather than `UCI_Elo`
(§7.1 already observes that `UCI_Elo` alone "produces recognisable engine play"). This is the
more human-like mode and the one that would justify shipping 23M/79M; it also invalidates the
2026-09-11 strength calibration (`docs/qa/strength-selection-2026-09-11.md`) and needs the
`AGREEMENT_BANDS` sweep redone per target.

---

## 7. Difficulty estimate

| Work item | Days |
|---|---|
| Export tool (`09_export_maia3.py`), fixtures, `models.json`, notice generation in `vendor-engine` | 1–1.5 |
| Encoder + policy decode in `src/core/policy/`, bit-exact fixture tests | 1 |
| Offscreen store + inference host + port messages + SW port + simulator tests | 2 |
| Pipeline integration as a prior, settings row, copy, Engine-view diagnostics, tests | 2 |
| On-demand 79M: relay wiring, hosting, manifest host test, LFS or split | 1 |
| QA and recalibration: in-browser latency/memory (E4-style), `AGREEMENT_BANDS` sweep with the prior at 1000/1400/1800/2200, `bun run check` green | 2–3 |
| **Total, option A** | **≈ 8–11** |
| Option B (Maia-first below a threshold) incl. recalibration | +3–5 |

Assumes one engineer familiar with the repo; the Task 34 code is a working template for every
plumbing piece, which is what keeps this under two weeks.

---

## 8. What could not be verified here

- **Multi-threaded wasm latency** for 23M/79M — the pthread worker path does not run under Bun.
- **In-browser figures** (offscreen document): latency, memory with Stockfish resident, the
  cost of `fetch`ing a 46–156 MB bundled asset, and main-thread stalls during session create.
- **WebGPU** in an offscreen document with COOP/COEP. Chrome documents offscreen documents as
  the place WebGPU is reachable from an MV3 extension, and ORT's WebGPU EP is documented as
  usable in browsers ≥ Chromium 113, but ORT still labels it experimental and it needs a
  different bundle (`ort.webgpu.min.mjs` + `ort-wasm-simd-threaded.jsep.wasm`, 27 MB in
  `node_modules`). Not tried.
- **The weights licence** beyond the model card's "see repo" and the repo's AGPL `LICENSE`.
- **Semantics of the `ponder` head** (`fc_ponder`, one scalar; `include_time_info = False` for
  the released models; the UCI wrapper discards it).
- **Per-Elo-bin accuracy** — the paper gives figures, not a table; I could only extract the
  aggregate numbers and the history ablation.
- **Behaviour on human positions** — the parity fixture is random-legal games, which proves the
  export is exact, not that the policy is good; the accuracy claims are the paper's.
- **Opponent-Elo sensitivity** in the extension's regime (bots vs humans) — untested.
- Everything about calibration: how Maia's prior shifts top-1 % / ACPL against `AGREEMENT_BANDS`
  is the first thing the integration must measure.

---

## 9. Reproducing the measurements

Scratchpad files (session-local, not in the repo): `export_maia3.py`, `bench_maia3.ts`,
`maia3-onnx/maia3-{5m,23m,79m}.{fp32,fp16w,int8}.onnx`, `*.fixture.json`, `*.report.json`.
The recipe, so the numbers can be regenerated without them:

```
uv venv --python 3.12 .venv && VIRTUAL_ENV=.venv uv pip install torch onnx onnxruntime numpy chess huggingface-hub
git clone https://github.com/CSSLab/maia3   # maia3/ package; pinned at the commit you export from
# export: build MAIA3Model from model_registry.MODEL_SPECS[<size>].config, load the HF .pt
# (weights_only=True), replace nn.RMSNorm.forward with the explicit arithmetic, wrap so inputs are
# tokens[B,64,96] f32 / self_elo[B] f32 / oppo_elo[B] f32 and outputs move_logits[B,4352] /
# value_logits[B,3]; torch.onnx.export(dynamo=False, opset 17, do_constant_folding=True, dynamic batch);
# then the 08_export_chessmimic.py to_fp16_weights() pass (FP16_MIN_ELEMENTS = 1024).
# bench: import assets/vendor/onnxruntime/ort.wasm.min.mjs by file URL under Bun, set
# env.wasm.wasmPaths to the vendored loader/wasm, proxy=false, numThreads=1, executionProviders ["wasm"],
# graphOptimizationLevel "all"; 60 positions × 3 repeats; compare masked softmax to torch fp32.
```

The three `.pt` files come from the Hugging Face repos in §2.2 (`hf_hub_download`); the
snapshot commits seen today were `b6559de2…` (5M), `51a0145a…` (23M) and `a107d6ce…` (79M).

---

## 10. Sources

- Maia-3 repository (README, `LICENSE` AGPL-3.0, `maia3/models.py`, `model_registry.py`,
  `uci.py`, `dataset.py`, `utils.py`, `pyproject.toml`): <https://github.com/CSSLab/maia3>
  (GitHub API: `license.spdx_id = "AGPL-3.0"`, pushed 2026-05-25).
- Model cards and files: <https://huggingface.co/UofTCSSLab/Maia3-5M>,
  <https://huggingface.co/UofTCSSLab/Maia3-23M>, <https://huggingface.co/UofTCSSLab/Maia3-79M>,
  <https://huggingface.co/UofTCSSLab/Maia3-ablate-3M>; collection
  <https://huggingface.co/collections/MaiaChess/maia3>; sizes from
  `https://huggingface.co/api/models/UofTCSSLab/<repo>?blobs=true`.
- Paper: Monroe et al., *Chessformer: A Unified Architecture for Chess Modeling*, ICLR 2026 —
  <https://arxiv.org/abs/2605.19091> (HTML: <https://arxiv.org/html/2605.19091v1>),
  <https://openreview.net/forum?id=2ltBRzEHyd>.
- Maia-2 (for lineage): <https://arxiv.org/abs/2409.20553>, <https://github.com/CSSLab/maia2>.
- ONNX Runtime Web WebGPU EP: <https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html>;
  WebGPU/WASM unavailable in service workers (why the offscreen document is the host):
  <https://github.com/microsoft/onnxruntime/issues/20876>.
- Chrome: offscreen documents <https://developer.chrome.com/docs/extensions/reference/api/offscreen>,
  <https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3>; WebGPU troubleshooting
  <https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips>; Web Store
  package limit (2 GB) <https://developer.chrome.com/docs/webstore/publish>.
- This repository: `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/models.md`,
  `docs/third-party.md`, `scripts/verify-dist.ts`, `scripts/build.ts`, `scripts/nnue-assets.ts`,
  `tools/data/08_export_chessmimic.py`, `src/offscreen/{ort-loader,timing-inference,asset-store,model-store,engine-host}.ts`,
  `src/service/handlers/engine/{download-relay,model-download,timing-infer}.ts`,
  `src/service/game-session/recommendation.ts`, `src/core/strength/{move-selector,prior,elo-map,constants,types}.ts`,
  `src/core/constants/{models,limits,messages,urls,search}.ts`, `src/core/timing/chessmimic-head.ts`,
  `docs/qa/strength-selection-2026-09-11.md`, `docs/qa-checklist.md` (E4).

---

## 11. Addendum (2026-09-13) — the package ships the 79M model only

The owner dropped the 5M and 23M exports ("remove all the maia models except the largest one,
and use that for all elos"). Nothing above is rewritten: §2.2, §3.3–§3.7 remain the record of
what the three sizes measured, and the 5M / 23M rows are what the decision traded away
(≈ 20 / 51 ms p50 and +269 / +443 MB against the 79M's 184 ms p50 and +895 MB, single-threaded
wasm under Bun). What the single size means against the pipeline — the 400 ms bullet window,
the H10 `policyFirstMs` shape decision, the H7.3 pre-inference that hides the query on the
opponent's clock, and the memory question of §3.6 next to Stockfish, now unconditional — is
worked through in `docs/qa/maia-79m-only-2026-09-13.md`. The rating conditioning (§2.4) is
unchanged: one model, asked at the chosen Elo.

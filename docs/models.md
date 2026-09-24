# Models — ChessMimic timing and Maia-3 policy

Current model contract and measurements, updated 2026-09-14. All six ChessMimic rating bands
and Maia-3 79M are bundled offline. Timing decisions and game-clock budgets are applied by the
timing policy; model output is a conditional human think-time distribution, not a complete
game-long clock-management plan. Maia supplies move probabilities, not move timings.

The extension stores these models with lossless byte-shuffling and gzip. Canonical source
ONNX files and their hashes describe what ONNX Runtime receives after decompression. See
[package validation](qa/model-packing-2026-09-14.md) for package sizes and native/browser checks.
Licences and attribution are generated in [third-party.md](third-party.md).

## 1. Upstream

ChessMimic comes from [thomasj02/1e4_ai](https://github.com/thomasj02/1e4_ai), pinned to
`8fcca2319e828b9d14b8def5c3ee9bc8bf1e3f12`, under PolyForm Noncommercial 1.0.0 for code and
weights. `Training/ClockTrainer.py` defines an 8,950,558-parameter model: eight MLP blocks,
eight attention blocks, width 256, eight heads and widening factor four. Each source checkpoint
is 107,535,521 bytes; its Git LFS object ID is checked before export.

The exported bands and their actual fitted rating distributions are (the top band's row is the
fine-tuned population, §9; upstream's own was 2357.105 ± 126.724):

| Band | Rating mean | Rating std | First clock bucket |
|---|---:|---:|---|
| 0_1000 | 861.326 | 103.916 | 0–2 s |
| 1200_1300 | 1251.858 | 27.636 | 0–1 s |
| 1500_1600 | 1550.564 | 27.556 | 0–1 s |
| 1800_1900 | 1849.166 | 27.342 | 0–1 s |
| 2000_2100 | 2047.534 | 27.518 | 0–1 s |
| 2200_3500 (fine-tuned) | 2632.595 | 280.053 | 0–1 s |

The `0_1000` checkpoint now represents novice targets that previously reached the 1200–1300
model. Band selection first honors a containing training range, then uses the nearest fitted
rating mean across gaps. Inputs are clamped to that band's training range before scaling.
Wide bands still have sparse tails: a 400 target is well below the novice mean, and targets
above the top band's populated range are extrapolations. The timing policy provides explicit
rating-dependent clock management rather than claiming densely calibrated human data there.

**Bucket layouts differ.** Novice bucket zero covers 0–2 seconds; the other bands start at
0–1 second. Every bucket edge, mask, decoded moment and within-bucket sample must use the band
that produced the probabilities. Probability in bucket zero is not always subsecond mass.

## 2. Export environment

`tools/data/08_export_chessmimic.py` uses the pinned upstream tokenizer, verified checkpoints,
torch 2.14.0, ONNX 1.22.0 and Python ONNX Runtime 1.30.0. Run:

```sh
uv venv --python 3.12 tools/data/.venv
VIRTUAL_ENV=tools/data/.venv uv pip install torch onnx onnxruntime numpy chess
tools/data/.venv/bin/python tools/data/08_export_chessmimic.py
```

The opset-14 graph accepts int32 `input_ids [batch,90]`, float32 `scaled_rating [batch]`
and float32 `clock_features [batch,3]`, and returns float32 `probs [batch,30]`. The input
contains 12 recent-move tokens plus 78 FEN tokens. The model inserts the rating and clock
embeddings internally, creating its 92-token working sequence.

Large initializers normally use fp16 storage behind a Cast to fp32, which ORT folds at load.
Arithmetic stays fp32. `1500_1600` now keeps its eight attention output projections in fp32:
the expanded fixture exposed 0.00225 error with those matrices in fp16; preserving their
original precision reduces the maximum to 0.00151. No weight training or inference tolerance
change was used. The other five timing exports and Maia retain their prior precision layouts.

## 3. Shipped files

Source artifacts under `assets/models/chessmimic/`:

| Canonical ONNX | Bytes | SHA-256 |
|---|---:|---|
| `0_1000.onnx` | 18,200,481 | `758533f588397e99be0a2ddfdb05bdb4729482269efdb90d9527a7f4ebb82470` |
| `1200_1300.onnx` | 18,200,481 | `623b2489d2909734d1b5f6d6b5c45c97043fedd5d659429f4868ec706d614991` |
| `1500_1600.onnx` | 19,247,529 | `09ffcd130d46b3273f2186c38ffcf49aedc5dc17c1499f1bf04714599dd99bc8` |
| `1800_1900.onnx` | 18,200,481 | `121bc7a7fa7920f9b0cf55dfe642f1e32e33a82dea23831bfbc018fa8d8f6f22` |
| `2000_2100.onnx` | 18,200,481 | `f50058cdab70d1f21d987faf0c11ed3059d30ad57c6e095cf3472bceb51f3eb9` |
| `2200_3500.onnx` (fine-tuned, §9) | 18,200,481 | `f799744bbdabbb4f30fcb44a3b1d17d7e04b1de6a449d6fb389297967e556110` |

`models.json` also records source checkpoint hashes, export versions and reference error per
band. `scalers.json`, `buckets.json` and `vocab.json` provide model-specific preprocessing and
decoding metadata. The existing five bands' scaler and bucket entries are unchanged.
The build packs each canonical file as `.onnx.pack.gz`; no raw duplicate ships. The runtime
restores the canonical length and SHA-256 before loading it. Maia's source remains split into
two parts solely for the Git host's file-size limit.

ONNX Runtime Web is pinned to 1.29.0. Its ESM loader and WASM binary are vendored locally;
no inference runtime is fetched from a CDN. `vendor:engine` verifies and regenerates the
third-party notices after an asset registry change.

## 4. Numerical parity

The six-band export generated 1,000 deterministic reference positions from seed 34 with
upstream tokens and torch fp32 probabilities. Export-side measurements:

| Band | Fixture positions | Maximum absolute probability difference |
|---|---:|---:|
| 0_1000 | 366 | 0.000484 |
| 1200_1300 | 123 | 0.000863 |
| 1500_1600 | 105 | 0.001510 |
| 1800_1900 | 88 | 0.000802 |
| 2000_2100 | 75 | 0.000542 |
| 2200_3500 (fine-tuned, §9) | 243 | 0.000682 |

The fp16 export now fails before writing its final manifest if any band reaches the runtime's
unchanged 0.002 tolerance. Tokenizer and scaler tests reproduce every fixture input.
Vendored ORT Web under Bun, reading the built packed models through the actual stores,
passed 200 reference positions spanning all six bands: maximum probability difference
0.000561, p50 31.6 ms and p95 34.5 ms in the measured run.

Earlier dynamic-int8 experiments were rejected: their distribution shifts were materially
larger than fp16 error and could change decoded timing by seconds. Package byte-shuffling is
lossless and avoids that tradeoff. The higher-precision 1500-band export is a separate,
intentional restoration toward the original checkpoint.

## 5. Latency and memory

Warm sessions reuse already decoded weights. Package decompression occurs at session creation,
not per move. In an isolated Chrome 152 smoke run, native stream decoding and restoration took
52–76 ms for timing bands and 418 ms for Maia; all canonical hashes matched. Native WASM
inference also passed 60 timing positions and all 60 Maia argmax/top-five fixtures. The headless
localhost harness is not a measurement of the installed extension under Stockfish load.
The first connection and game startup still prewarm sessions before use.

The decoder explicitly allocates the final ONNX buffer and at most 1 MiB of scratch. Browser
stream buffers and ORT allocations add to process memory. fp16 storage and gzip save disk;
ORT still uses fp32 working weights. Measured cold-load and process-memory limitations are in
[package validation](qa/model-packing-2026-09-14.md).

## 6. On-demand bands

Every currently registered model is bundled and works offline. The existing ChessMimic
fallback store still accepts verified canonical ONNX from OPFS/IndexedDB or a relayed download
for a registry entry marked non-bundled. Packed package bytes are decoded only on the bundled
path; caches and downloads retain canonical names and hashes. Unknown names are rejected.

The inference host limits resident timing sessions and backs off transient load failures. A
bad or missing model falls back through registered bands or timing policy; it cannot hold a
move forever waiting for a download. Maia remains bundled-only with no remote fallback.

## 7. Reproducing

After changing source model exports, update the source registry, run `bun run vendor:engine`
and build. `08_export_chessmimic.py` exports the *upstream* checkpoints: re-running it for all
six bands would replace the fine-tuned `2200_3500` band and its fixture rows with upstream's.
Pass `--bands` without `2200_3500` there, and re-export the fine-tuned band with
`tools/timing-finetune/export.py` (§9). These release checks exercise the actual packed files and fail on unreadable or
incorrect package assets:

```sh
bun run build
SLICED_PACKAGED_ROOT="$PWD/dist" bun test test/integration/chessmimic-onnx.test.ts test/integration/maia-onnx.test.ts
bun test test/scripts/chessmimic-assets.test.ts test/scripts/maia-assets.test.ts test/offscreen/model-unpack.test.ts
```

`verify-dist` independently decodes and hashes all seven model assets. It also rejects unknown
model copies, raw ONNX duplicates, source parts and empty packed assets.

## 8. Maia-3 human move-policy models

Maia-3 leads move selection through `MAIA.eloMax` (3000), with stronger verification above
2800. Above 3000 through 3200, Stockfish defines the acceptable alternatives and Maia supplies
a secondary preference. Above 3200, selection uses Stockfish alone and the automatic network
switches to Full. Network routing uses the active opponent-matched target; explicit Big remains
available at every target. Maia self conditioning is capped at 3000 while the opponent input
retains the actual rating. These boundaries are engineering choices, not measured playing ratings.
The ChessMimic head and executor still decide *when* and *how*.

The original export measurements below come from
[`research/maia3-feasibility-2026-09-11.md`](research/maia3-feasibility-2026-09-11.md), measured on
2026-09-11 on the same machine as §5 (Apple M5, 10 cores, 24 GB, macOS 26.3); the registry is
`src/core/constants/maia.ts` and it is the contract every file below is checked against.

### 8.1 Upstream

| | |
|---|---|
| Project | **Maia-3** — CSSLab, University of Toronto; Monroe, Eilender, Chalmers, Tang, Anderson, *Chessformer: A Unified Architecture for Chess Modeling*, ICLR 2026 (<https://arxiv.org/abs/2605.19091>) |
| Repository | <https://github.com/CSSLab/maia3>, pinned at `1e13597c42d4858b7cfd7cfdae01e297263364b2` (HEAD on the export day) |
| Checkpoints | Hugging Face `UofTCSSLab/Maia3-{5M,23M,79M}`, each pinned by revision and SHA-256 in `MAIA_MODEL_FILES[*].upstream` |
| Licence | AGPL-3.0-or-later (`LICENSE` in the repository); the model cards state no separate weight licence and point to the repository, so the weights are taken as distributed under the same licence by that pointer. Full text shipped as `assets/models/maia3/LICENSE`. |
| Model | encoder-only transformer over 64 square tokens, 8 blocks in every size; d_model / heads 256 / 8 (5M), 512 / 16 (23M), 1024 / 32 (79M); two Elo embeddings (self, opponent); outputs a 4352-way move head (4096 from→to + 256 promotions, side-to-move frame) and a 3-way value head |

The AGPL is a condition on the *model*, not on the extension: the model runs through
onnxruntime-web, nothing in `src/` is derived from the Maia-3 code, and the extension's encoder is
written from the paper's description of the input. `tools/data/09_export_maia3.py` imports the
upstream package (for the model class and the reference tokeniser that produces the fixture) but
copies nothing from it.

### 8.2 What ships

> **2026-09-13 — one size ships.** The owner's instruction: "remove all the maia models except
> the largest one (and use that for all elos — but of course still request moves at the elo we
> choose etc.)". Since then `MAIA_SIZES = ["79m"]`, `MAIA_MODEL_FILES` names only
> `maia3-79m.onnx`, `MAIA.sizeBands` is one band up to `MAIA.eloMax`, and `defaultSize` /
> `prior.size` are 79M; `maiaSizeFor(anyElo)` answers `"79m"`. The query's `selfElo` / `oppoElo`
> remain model inputs; current self conditioning is capped at 3000. The Elo slider (with the H2 offset, H5 context
> penalty and the pressure term) still decides whom the model imitates. The 5M and 23M rows in the
> tables below are the **historical export record**; the files `maia3-5m.onnx`, `maia3-23m.onnx`
> and the fixtures `expected-5m.json` / `expected-23m.json` were removed from the repository and
> from `models.json`, and `verify-dist` rule 8 now fails the build on any `.onnx` under
> `assets/models/maia3/` the registry does not name. Package: ≈ 156 MB of model instead of ≈ 213.
> What the single size costs per move, and what only a browser can measure, is in
> [`qa/maia-79m-only-2026-09-13.md`](qa/maia-79m-only-2026-09-13.md).

`assets/models/maia3/` — one canonical model (three until 2026-09-13), packed losslessly at build time, with fp16
weights behind `Cast` (opset 17, same layout as the ChessMimic bands; the casts fold to fp32 at
session load):

| Size | File (package) | Bytes | SHA-256 | Params | Stored in the repository as |
|---|---|---|---|---|---|
| 5M | `maia3-5m.onnx` | 10,868,016 | `09c8db9720cb297b445ce40fbde5913edbffdd08e41208da7f8d44a12001a458` | 5,230,084 | whole |
| 23M | `maia3-23m.onnx` | 45,887,562 | `71e49f19b6f9119bfe57c5b65aa4a04440ebc812ba01b5cb22e73328fa48e5dd` | 22,936,580 | whole |
| 79M | `maia3-79m.onnx` | 156,212,736 | `37fe2f32cd44f2733ce5cafd90d9aa4c444340da8661df36420ae4e65ebd6a88` | 78,899,716 | `maia3-79m.onnx.part0` (95,000,000 B) + `maia3-79m.onnx.part1` (61,212,736 B) |

Side files: `models.json` (provenance, per-size bytes / SHA-256 / `parts` / checkpoint pin, export
metadata and the `MAIA_INPUT` layout) and `LICENSE` (the AGPL-3.0 text). Total ≈ 213 MB
unpacked, and about the same zipped — fp16 weights are near-incompressible.

**The split.** The Git host caps a file at 100 MB, and 156 MB of fp16 weights does not gzip under
it, so the repository stores the 79M model as consecutive slices of exactly `MAIA_FILES.partBytes`
(95,000,000) bytes then the remainder; `MAIA_MODEL_FILES["79m"].parts` = 2 says how many. The build
(`scripts/maia-assets.ts` → `writeBundledMaia`, called from `copyBundledAssets`) reads the whole
files and joins the parts, verifies bytes and SHA-256 against the registry (a mismatch throws) and
writes one file per size into `dist/assets/models/maia3/`; the parts are excluded from the copy,
and `verify-dist` rule 8 fails the build if a `.part<i>` ships or a whole is missing or
undersized. `test/scripts/maia-assets.test.ts` checks the on-disk parts join to the registered
hash on every `bun run check`.

Model-input contract (`MAIA_INPUT`):

| Tensor | Type and shape |
|---|---|
| `tokens` (input) | float32 `[batch, 64, 96]` — per square, 8 history slots × 12 one-hot piece planes (6 types × {side to move, opponent}); board mirrored to the side to move; missing history filled by repeating the earliest position |
| `self_elo`, `oppo_elo` (inputs) | float32 `[batch]` — raw ratings; the model divides by 5000 and clamps to `[0, 1]` |
| `move_logits` (output) | float32 `[batch, 4352]` — 64×64 from→to then 8×8×4 promotions (`q, r, b, n`), unmasked: mask to the legal set and softmax outside the model |
| `value_logits` (output) | float32 `[batch, 3]` — loss, draw, win for the side to move |

### 8.3 Numerical parity (export-side, Python onnxruntime 1.30.0, CPU EP)

60 seeded positions with up to 8 plies of history, self/opponent Elo drawn from 800–2700, against
the torch fp32 module on the legal-move-masked softmax:

| Size | fp16w max \|Δprob\| | argmax agree | wasm (vendored ORT-web under Bun) top-5 agree |
|---|---|---|---|
| 5M | 3.7e-4 | 60/60 | 60/60 |
| 23M | 3.0e-4 | 60/60 | 60/60 |
| 79M | 6.1e-4 | 60/60 | 60/60 |

int8 dynamic quantisation was measured and rejected: it moves 3–5 % of probability mass and
breaks the top-5 ordering in 10–20 % of positions, which for a model whose output *is* the
distribution is a behavioural change (feasibility §3.4).

### 8.4 Latency and memory (vendored onnxruntime-web 1.29.0 wasm under Bun, one thread, batch 1)

| Size | p50 | p95 | max | session create | warm-up query | RSS after create |
|---|---|---|---|---|---|---|
| 5M | 20.3 ms | 26.6 ms | 33.2 ms | 508 ms | 48 ms | +269 MB |
| 23M | 50.7 ms | 63.4 ms | 78.8 ms | 460 ms | 86 ms | +443 MB |
| 79M | 184 ms | 214 ms | 282 ms | 716 ms | 300 ms | +895 MB |

A query runs in parallel with the engine search and is hidden behind it for 5M in every time
control and for 23M in everything but the 150 ms floor; 79M is not without threads. The budget
is `MAIA.inferenceBudgetMs` (1,500 ms) with the engine's own policy as the fallback for that
move; a cold session load (0.4–0.8 s plus the warm-up) is paid from the waiting view, never in a
move window, exactly like the ChessMimic pre-warm in §5. fp16 saves disk, not RAM — one Maia
session stays resident. The in-browser figures (multi-threaded wasm, the offscreen document
itself) are a QA item; feasibility §3.5–3.7 has the full tables.

**D4 — the padded 97th token column** (`docs/research/human-move-selection-ideas-2026-09-13.md`
§7 D4, added 2026-09-13). The export wrapper appends a zero column to the 96 token features before
the upstream module, and the fixture generator truncates the upstream tokeniser's output to 96
columns before computing the torch reference, so the ONNX graph and the parity reference are fed
the same zeroed column by construction and the parity test cannot detect a wrong value there.
`tools/data/09_export_maia3.py --check-pad` re-tokenises the 60 fixture histories with the
upstream tokeniser (`include_time_info = False`, the export's setting), asserts every column ≥ 96
is exactly zero and that the first 96 reproduce `tokensSet`, and prints the maximum |value|.
**Result: not yet measured** — the check was written in an environment without torch or the
upstream clone. Run it from the §8.6 venv:

```
tools/data/.venv/bin/python tools/data/09_export_maia3.py --check-pad
```

and replace this paragraph's "not yet measured" with the printed line (exit code 0 = all zero and
the encoder fixture reproduced; 1 = the pad is wrong and the export must carry the real column).

### 8.5 Fixtures

`test/fixtures/maia3/` (versioned, not shipped):

- `positions.json` — `{history: 8, tokenDim: 96, positions: [...]}`, 60 positions
  (seed 34; the first seven are 0, 1, 3, 7, 8, 9 and 20 plies deep so both the repeat-the-earliest
  padding and the full window are covered) with `fen`, `historyFens`, `selfElo`, `oppoElo`,
  `tokensSet` (the ascending indices `i` in `[0, 6144)` where the upstream tokeniser's one-hot is
  1, square-major: `i = square · 96 + feature`) and `legal` (ascending vocabulary indices);
- `expected-{5m,23m,79m}.json` — `{size, positions: [{top: [[uci, p], … ≤ 5], value: [l, d, w]}]}`
  aligned by index: the torch fp32 masked-softmax top-5 (fewer when fewer moves are legal) and the
  raw value logits. **The `top` UCIs are in the model's mirrored side-to-move frame** — the frame
  `move_logits` are indexed in — so for a black-to-move position black's `g8f6` appears as
  `g1f3`. They are not un-mirrored to the board frame in the fixture; the integration test
  un-mirrors them the way the extension's decoder does. Regenerating them in the board frame
  would break that test silently, which is why the file carries a `note` saying so.

The encoder is tested bit-exact on `tokensSet`; the inference host is tested on `top` / `value`.

### 8.6 Re-exporting

```
uv venv --python 3.12 tools/data/.venv
VIRTUAL_ENV=tools/data/.venv uv pip install torch onnx onnxruntime numpy chess huggingface-hub
tools/data/.venv/bin/python tools/data/09_export_maia3.py     # assets (split), models.json, fixtures
bun run vendor:engine                                         # docs/third-party.md
bun test test/scripts/maia-assets.test.ts                     # parts join to the registry's hashes
```

The export is deterministic given the checkpoint (TorchScript exporter, opset 17, constant
folding, `FP16_MIN_ELEMENTS = 1024`): the shipped files were produced by this procedure with
torch 2.14.0 / onnx 1.22.0 / onnxruntime 1.30.0, and a re-run must reproduce the SHA-256s in the
registry — if it does not, the registry, `models.json` and this section change together.

## 9. Fine-tuned 2200–3500 band (2026-09-24)

The shipped `2200_3500.onnx` is no longer upstream's checkpoint. It was fine-tuned on public
chess.com games and it times the move being played, the way upstream trained it.

**The move window.** Upstream's clock data built each record's 12-move window with the timed move
as the last token and the FEN before it (`Training/cpp_src/clock_converter/clock_game_parser.cpp`,
"moves_including_current", pinned by its own tests). The extension had fed history only, so the
window was shifted by one move. `buildInputs(ctx, move)` now puts the timed move last.
`ChessMimicHead.prepare(ctx, { candidates })` infers the history-only row plus one row per candidate.
`prepareMove(ctx)` infers `ctx.chosenMove` on a miss. Sampling reads the chosen move's row and falls
back to the history-only row. The band was trained on a mixed contract (85 % of examples with the
timed move, 15 % history-only) so the fallback row stays calibrated.

**Data.** The crawl in `data/timing/crawl/` gave 201,909 chess.com bullet, blitz and rapid games with
a side rated 1800 or higher. Training used `splitFor` fit-split movers rated 2100 and above, first
moves excluded (chess.com's clock does not run normally on them), at most 60 game-sides per player.
That is 8.4 M moves, of which a random 2.0 M from 19,043 players were used. Early stopping used 40 k
moves from 2,084 further fit players held back. The extractor, `tools/timing-finetune/extract.py`,
labels each move with the clock delta plus increment, which is upstream's label and includes the
hand. It encodes every input exactly as the extension does: `test_parity.py` checks byte-identical
float32 inputs against the reference fixture, the pinned upstream tokenizer and `buildInputs` +
`standardiseInputs` on 3,000 real positions, half of them with the timed move.

**Method.** Start from the upstream fp32 checkpoint and minimise cross-entropy over the runtime's
bucket mask. Settings: AdamW, learning rate 3e-5 with a 500-step warm-up and cosine decay, batch
256, one epoch, gradient clip 1. The rating scaler was refitted to the training population:
2632.6 ± 280.1 instead of upstream's 2357.1 ± 126.7. The rating embedding was re-parameterised
first, so the refit alone did not change the function; 3000 now sits at z = +1.31, not +5.07. The
clock scalers, the bucket layout and the band's range are unchanged. Band selection is unchanged
too: the gap from 2101 to 2199 still selects `2000_2100`. The export (`tools/timing-finetune/export.py`)
follows `08_export_chessmimic.py`, with fp16 initialisers behind `Cast` and opset 14. Run on the
upstream checkpoint, it reproduces the previously shipped file byte for byte. The fine-tuned
file's maximum difference from torch fp32 over its 243 fixture rows is 0.000682. The other bands'
fixture rows are unchanged.

**Held-out results.** Scored on `splitFor` holdout players only: kept crawl sides, a 15 % random
sample of game-sides, at most 30 per player. That is 472,225 moves from 6,554 players. CIs are a
500-draw bootstrap over players, paired. NLL is over the 30 masked buckets, and RPS is the CRPS of
the bucket CDF. "shipped" is upstream's band as the extension used it (history only), "+move" is
upstream's band given the timed move, "A" is a history-only fine-tune on the same data, and
"candidate" is the shipped band with and without the move. Situations are provisional: "book" means
inside chess.com's named opening line and "recapture" means capturing on the square just captured on.

| tc | rating | situation | moves | NLL shipped | +move | A | **candidate** | candidate, history row | ΔNLL [95 % CI] | RPS shipped → candidate | median s obs / shipped / candidate | 10/50/90 % coverage shipped → candidate |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---|
| all | 2100+ | all | 410,610 | 2.170 | 1.993 | 1.616 | **1.563** | 1.655 | −0.607 [−0.617, −0.595] | 2.086 → 1.365 | 1.3 / 2.4 / 1.4 | .29/.68/.91 → .10/.49/.90 |
| all | 2200–2999 | all | 343,720 | 2.205 | 2.015 | 1.629 | **1.575** | 1.668 | −0.630 [−0.642, −0.618] | 2.140 → 1.389 | 1.3 / 2.5 / 1.4 | .30/.69/.92 → .10/.49/.90 |
| all | 3000+ | all | 40,567 | 1.658 | 1.612 | 1.351 | **1.305** | 1.381 | −0.352 [−0.369, −0.336] | 1.290 → 0.968 | 0.9 / 1.4 / 1.0 | .16/.60/.89 → .10/.50/.90 |
| bullet | 2200–2999 | book | 9,511 | 2.024 | 1.882 | 0.368 | **0.357** | 0.376 | −1.667 [−1.701, −1.629] | 1.304 → 0.111 | 0.4 / 2.2 / 0.6 | .61/.98/1.0 → .10/.51/.91 |
| bullet | 2200–2999 | recapture | 10,636 | 1.742 | 0.891 | 0.604 | **0.566** | 0.669 | −1.176 [−1.205, −1.144] | 1.041 → 0.211 | 0.3 / 1.8 / 0.6 | .46/.89/1.0 → .09/.50/.91 |
| bullet | 2200–2999 | other | 88,548 | 1.808 | 1.656 | 0.947 | **0.901** | 0.972 | −0.907 [−0.925, −0.890] | 1.279 → 0.372 | 0.8 / 2.0 / 0.9 | .42/.86/.99 → .10/.50/.91 |
| blitz | 2200–2999 | book | 14,710 | 1.755 | 1.584 | 1.146 | **1.129** | 1.189 | −0.626 [−0.648, −0.603] | 1.008 → 0.570 | 0.9 / 1.8 / 1.0 | .34/.78/.97 → .11/.53/.91 |
| blitz | 2200–2999 | recapture | 11,399 | 2.071 | 1.403 | 1.333 | **1.272** | 1.471 | −0.799 [−0.827, −0.771] | 1.493 → 0.809 | 0.9 / 2.4 / 0.9 | .40/.80/.97 → .09/.47/.90 |
| blitz | 2200–2999 | other | 106,619 | 2.255 | 2.060 | 1.996 | **1.925** | 2.038 | −0.330 [−0.338, −0.322] | 2.045 → 1.624 | 2.0 / 2.9 / 2.0 | .24/.65/.93 → .10/.49/.89 |
| rapid | 2200–2999 | book | 7,552 | 2.234 | 2.112 | 1.941 | **1.936** | 1.971 | −0.298 [−0.324, −0.271] | 1.794 → 1.637 | 1.6 / 1.9 / 1.9 | .16/.50/.86 → .11/.54/.91 |
| rapid | 2200–2999 | recapture | 5,479 | 2.471 | 2.208 | 2.073 | **2.021** | 2.189 | −0.450 [−0.487, −0.411] | 2.517 → 2.016 | 1.7 / 2.7 / 1.7 | .26/.64/.89 → .09/.45/.89 |
| rapid | 2200–2999 | other | 51,775 | 3.131 | 3.073 | 2.713 | **2.650** | 2.745 | −0.481 [−0.496, −0.465] | 4.848 → 3.567 | 5.2 / 3.3 / 4.7 | .11/.37/.71 → .09/.46/.87 |

The candidate's point estimate is better than shipped in every one of the 216 cells (time class ×
100-Elo band × situation). Its CI crosses zero only for rapid 2800–2899 book, which has 53 moves.
On the calibration games (105,201 held-out moves, with the calibrator's situation labels) it is
better in every cell as well: 2100+ NLL 2.302 → 1.690, book 2.031 → 1.260, obvious recapture
2.123 → 1.301, forced 1.544 → 1.001. As a forgetting check, held-out 1800–2099 movers (the band
clamps them to 2200) also improve, from 2.556 to 1.929 NLL for 1800–1999, although production
routes them to other bands. Upstream's band was trained on blitz. It predicted bullet far too slowly
(98 % of bullet book moves fell at or below its median) and rapid too fast. The candidate's PIT
histogram is flat: coverage is 10 / 49 / 90 % against 10 / 50 / 90 %.

One replay assertion changed with the band. `blitz-clock-budget.test.ts` used to require at least
240 s left at move 40 of a 10+0 game (target 2400). That was a regression guard with no human
evidence behind it, and upstream's band passed it only by thinking too fast in rapid. The
fine-tuned band finishes move 40 with a median of 210 s. Humans rated 2300–2499 at 10+0 keep a
median of 142.6 s (IQR 66.9–241.0 s, 7,687 sides from 3,400 players; 25 % keep 240 s or more). The
test now requires the bot's median to lie in that human IQR, read from
`test/fixtures/human-clock-reference.json`, which `tools/timing-finetune/human_clock_reference.py`
generates. The 3+0 assertions are unchanged, and the replay still uses the history-only row. With
the timed-move row, the 3+0 middle-clock long-think share is 0.017, just under the human
envelope's 0.029. The timing calibration layer has to meet that envelope when it wires the
candidates.

Limitations: rapid above 2800 is almost empty in the crawl (a few dozen kept rapid sides at
2900–2999, none at 3000+). 3000+ bullet and blitz are covered, but 3000–3500 is the top of the data, not beyond it.
The time-control mix is chess.com's own, which is mostly 1+0, 3+0 and 10+0. The situation labels on
the crawl are provisional. The history-only fallback row is about 0.09 nats worse than the row with
the move. Tables: `data/timing/finetune/RESULTS.md` and `eval/*/eval.md` (git-ignored). Code and a
reproduction recipe: `tools/timing-finetune/`.

**Licence.** The fine-tuned weights are a derivative of the PolyForm Noncommercial 1.0.0 upstream
weights and carry the same licence and the same non-commercial condition. `models.json` records
the fine-tune under `bands["2200_3500"].fineTuned`, and `docs/third-party.md` (regenerated by
`bun run vendor:engine`) says so.

Reproducing, from the repository root with the export venv (§2):

```sh
PY=tools/data/.venv/bin/python
$PY tools/timing-finetune/test_parity.py                     # extractor = fixture = upstream = TS
$PY tools/timing-finetune/extract.py --games data/timing/crawl/games.jsonl --out data/timing/finetune/extract/crawl --min-rating 1800 --workers 3
$PY tools/timing-finetune/train.py --examples data/timing/finetune/extract/crawl/examples --out data/timing/finetune/runs/crawl-mixed \
    --contract mixed --p-current 0.85 --refit-rating-scaler --lr 3e-5 --epochs 1 --max-train 2000000 --eval-every 1000 --patience 3 --warmup 500
$PY tools/timing-finetune/evaluate.py --examples data/timing/finetune/extract/crawl/examples --out data/timing/finetune/eval/final-crawl \
    --baseline shipped --min-rating 1800 --side-frac 0.15 --model shipped=upstream:2200_3500,band=2200_3500 \
    --model cand=data/timing/finetune/runs/crawl-mixed/best.ckpt,band=2200_3500,scalers=data/timing/finetune/runs/crawl-mixed/scalers.json,contract=with_current
$PY tools/timing-finetune/export.py --ckpt data/timing/finetune/runs/crawl-mixed/best.ckpt --scalers data/timing/finetune/runs/crawl-mixed/scalers.json \
    --train-json data/timing/finetune/runs/crawl-mixed/train.json --out data/timing/finetune/candidates/crawl-mixed --install
bun run vendor:engine
```

# tools/human-match — the human move-match harness and the Maia fixed-pool fixture

Validation for the selection wrapper without calibrating Maia (§8 of
`docs/research/human-move-selection-ideas-2026-09-13.md`). The job — corpus, replay, metrics,
cost — is specified in `tools/data/10_human_match.md`; this directory holds the Bun side.
Nothing here ships; every script runs `src/` modules under plain `bun` (see `defines.ts`).

| File | What |
|---|---|
| `defines.ts` | the bundler's compile-time `define` globals, so `src/` modules load outside `bun test`; **must be the first import** of every entry script here |
| `engine.ts` | `createRefereeEngine()` — the vendored Stockfish 19 smallnet booted through the offscreen loader under Bun (as `test/integration/engine.test.ts`), one `go` at a time, answering the **last complete MultiPV cycle** as `EvalLine[]` with `pvSan` filled — the collection rule of every `stockfish18-*.json` fixture |
| `maia.ts` | `createMaiaRunner()` — the shipped Maia-3 ONNX models under the vendored onnxruntime-web wasm backend, `encodeMaiaInputs → session.run → decodeMaiaOutputs`, i.e. the offscreen host's exact path (`test/integration/maia-onnx.test.ts` is the parity proof) |
| `make-fixture.ts` | writes `test/fixtures/strength/maia-draw.json` (below) |
| `replay.ts` | the §8.1 harness: corpus rows → referee frames + Maia policies → seeded `selectMove` draws → per-bucket report (markdown + JSON) |
| `replay.test.ts` | the `--fixture` smoke run as a test (< 1 s; asserts the report is well-formed, not any value) |

## The fixture: `test/fixtures/strength/maia-draw.json`

Built by `bun tools/human-match/make-fixture.ts` (≈ 1 min; the engine dominates) from the
60-position parity set `test/fixtures/maia3/positions.json` (seed 34; random-game positions with
up to 8 plies of history, self/opponent Elo drawn from 800–2700). Per position:

- `fen`, `historyFens`, `selfElo`, `oppoElo`, `ply` — as the parity set;
- `policy["5m"]` and `policy["23m"]` — the **full legal-move distribution** of the shipped 5M and
  23M models at the position's own `selfElo` / `oppoElo`, board frame, full float precision,
  summing to 1, plus the `wdl`. Decoded by the real encoder and `decodeMaiaOutputs` under the
  vendored runtime, so it is bit-faithful to what the offscreen host answers; the generator aborts
  unless the argmax agrees with the torch reference on all 60 (it did, 60/60 for both sizes);
- `lines` — one **real** Stockfish 19 smallnet MultiPV frame at full strength (the referee), one
  thread, 32 MB hash, `go movetime 600 depth 18 searchmoves <union of each size's top-8 moves>`,
  so the frame covers exactly Maia's favourites (8–11 roots, mean 8.25); `pvSan` is filled from
  the position so `hangsPiece` reads the PV instead of re-classifying. All 60 frames completed a
  full cycle (depth 12–18); `engine` records the roots, the bestmove, the depth and completeness.
  Nothing is synthesised — the scores are real but a fixed sample, not a calibration.

Measured under the 2026-09-13 rails when the fixture was written (mean Σ Maia mass the rails would
remove per move, `lossCap` knots 800→0.55, 1400→0.45, 2000→0.35, 2600→0.25):

| target | 1000 | 1500 | 2000 | 2400 |
|---|---:|---:|---:|---:|
| 5M | 0.029 | 0.030 | 0.032 | 0.035 |
| 23M | 0.033 | 0.034 | 0.036 | 0.041 |

The selector's own `maiaMeters.railedMass`, replayed through `selectMove` in
`test/core/strength/maia-fixture.test.ts`, reported 0.026 / 0.033 / 0.037 / 0.040 at the same
targets — the ceilings in `consistency.test.ts` (0.15 per band) leave room for a rating-ramped rail
without letting the wrapper quietly become the chooser.

**2026-09-13 — the package narrowed to the 79M model.** The owner dropped the 5M and 23M exports
("remove all the maia models except the largest one, and use that for all elos"). The fixture
above is **kept as written**: its `policy["5m"]` / `policy["23m"]` distributions are real answers
of those models and the pure selector tests replay them without loading a model, so nothing here
depends on the dropped files. `make-fixture.ts` now defaults to `--sizes 79m` (the only size it can
load); regenerating the fixture would replace those keys with `policy["79m"]`, and the tests that
read `"5m"` would need to follow — not done, not required. `replay.ts --fixture` reads the
fixture's own keys (`FixturePolicyKey`), labels the `PolicyResult` with the shipped size and names
the fixture key in the report header; `replay.ts --maia` on a corpus queries the 79M model at every
rating, as the extension does.

## The tests that use it

- `test/core/strength/maia-fixture.test.ts` — four targets (1000 / 1500 / 2000 / 2400), seeded
  draws shared across targets (common random numbers), stratified by cost class: 100 draws on an
  ordinary position, 12 on a conversion-active one, because `conversionPool` replays every
  candidate's PV through chess.js on each `selectMove` call (≈ 2.7 ms a draw against ≈ 0.2 ms;
  27 of the 60 positions are won). Asserts: every pick is a scored candidate; Maia decides most
  moves and never one under `MAIA.minProb`; mean raw loss is non-increasing in the target (1.5 cp /
  5 % tolerance — measured 34.9 → 33.7 → 30.7 → 29.6 cp); `maiaMeters` ranges when reported;
  determinism. ≈ 5 s.
- `test/core/strength/consistency.test.ts` — §8.3: mean raw loss non-increasing from 800 to 2500
  on the `stockfish18-blitz.json` 20-root pool (persona sampling, 200 draws per position per
  target, measured 91 → 9.7 cp), and the per-band `railedMass` ceiling on this fixture. ≈ 2 s.

To regenerate the fixture after a model or engine re-vendor: run the generator, re-run both tests,
and update the table above from the generator's last lines.

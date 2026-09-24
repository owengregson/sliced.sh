# tools/calibration — fitting Maia to chess.com ratings

The Maia strength calibration (`src/core/constants/maia-calibration.ts`) says, for each chess.com
time class and advertised rating, **which rating Maia-3 is conditioned at** and **at what
temperature its distribution is sampled**, so that the bot's inaccuracy / mistake / blunder rates
match real chess.com players of that rating in that time class. This directory is the harness
that measures it, fits it and verifies it. Nothing here ships; every script runs the shipped
`src/` modules under plain `bun` (`../lib/defines.ts` first).

Why a calibration is needed at all: Maia-3 learned Lichess ratings, and sampling its whole
distribution at T = 1 plays the model's uncertainty as well as the population's; the pipeline's
context terms (clock, think, ambiguity, tilt, opponent pressure) then move the query further. The
fit runs **end to end through `selectMove` with those terms on**, so their average effect is
absorbed into the conditioning rating and their shape is checked per clock quartile.

## Pipeline

| step | script | in → out (under `data/calibration/`, git-ignored) | cost |
|---|---|---|---|
| 1 | `crawl-chesscom.ts` | chess.com public API → `games.jsonl`, `samples.jsonl` (≥ 110 sides per time class × bucket 600…3000, ≤ 2 per player) | ≈ 600 requests, resumable (`http-cache/`) |
| 2 | `build-corpus.ts` | → `corpus.jsonl`: own moves from ply 16 of each sampled side (all of them, or a 20-move window with `--window`, which spreads the same cost over more players); `split` by player hash (≈ 60 % fit / 40 % holdout) | seconds |
| 3 | `requests.ts` | → `requests.jsonl`: per row the Maia self-Elo grid `[R − 900, R + 1000]` step 100 (bullet from `R − 1300`), clamped to the conditioning range | seconds |
| 4 | `maia-batch.ts` (+ `maia_worker.py`) | → `policies.jsonl`: the shipped Maia-3 79M, native onnxruntime (CPU + CoreML), the shipped encoder/decoder; parity with the wasm path in `maia-parity.ts` | ≈ 330 q/s → ≈ 1.7 h for 2 M queries |
| 5 | `frames.ts` | → `frames.jsonl`: the vendored Stockfish 19 referee per row, the pipeline's recipe (MultiPV by rating, per-tc movetime, extra `searchmoves` over Maia's favourites across the grid, the human move's own line, every human-depth cycle 2…14) | ≈ 13 rows/s at 9 workers |
| 6 | `shard.ts` | → `cells/<tc>-<bucket>.jsonl`: row + frame + grid policies joined per cell | seconds |
| 6b | `rating-eval.ts --extract`, `--train [--train-split fit\|holdout\|all] [--model-out F]` | → `moves.jsonl`; the intrinsic rating model trained on one split, and `F-eval.md`, its accuracy on the other split's humans | ≈ 1 min |
| 7 | `fit.ts [--split fit\|holdout\|all] [--model F] [--out DIR]` | → `DIR/cells/*.json` (objective surfaces), `picks.json`, `table-smooth12.json`; `--write` updates the shipped table | ≈ 1.5 h per split at 4 workers on the v2 corpus |
| 8 | `verify.ts [--split S] [--model F]` | → `verify/<label>/report.md`, `summary.json` — the named split only (holdout by default) | ≈ 15–30 min |
| 9 | `crossfit.ts --a LABEL --b LABEL` | → `verify/crossfit-A-B.md`: the two directions pooled, every player once | seconds |

`frames.ts --require-policies` searches only rows whose policies exist, so step 5 can run
alongside step 4 (re-run it until the Maia run ends; it is resumable).

```
bun tools/calibration/crawl-chesscom.ts && bun tools/calibration/build-corpus.ts
bun tools/calibration/requests.ts
bun tools/calibration/maia-batch.ts --in data/calibration/requests.jsonl --out data/calibration/policies.jsonl
bun tools/calibration/frames.ts [--require-policies]
bun tools/calibration/shard.ts
bun tools/calibration/rating-eval.ts --extract
bun tools/calibration/rating-eval.ts --train --train-split fit --model-out data/calibration/rating-model-fit.json
bun tools/calibration/rating-eval.ts --train --train-split holdout --model-out data/calibration/rating-model-holdout.json
bun tools/calibration/rating-eval.ts --train --train-split all --model-out data/calibration/rating-model.json
tools/calibration/run-crossfit.sh   # the sequence below, per direction, then the final fit
#   fit.ts --split fit --model …-fit.json --out data/calibration/fit-A --offsets -1000:1000:100 --only bullet:600,…,bullet:3000
#   fit.ts --split fit --model …-fit.json --out data/calibration/fit-A --only blitz:600,…,rapid:3000
#   fit.ts --smooth --out data/calibration/fit-A
#   verify.ts --table data/calibration/fit-A/table-smooth12.json --label crossA --split holdout --model …-fit.json --chains 8
#   (direction B: swap the splits and the model, label crossB; the identity baseline: --table identity as crossA0/crossB0)
bun tools/calibration/crossfit.ts --a crossA --b crossB      # the out-of-sample verdict
bun tools/calibration/crossfit.ts --a crossA0 --b crossB0    # the same for the behaviour before calibration
# the shipped table: the same fits with --split all --model data/calibration/rating-model.json --out data/calibration/fit, then
bun tools/calibration/fit.ts --smooth --write --out data/calibration/fit
```

Python: `tools/data/.venv` (Python 3.12) with `onnxruntime numpy onnx` for step 4.

## What is measured

Per move, against the referee's best line of the same frame (`sim.ts judgeFor`): expected-points
loss on `winProb(cpEffective)`, and whether it reaches the board ratings' published bands
(`MOVE_CLASSIFICATION`: inaccuracy 0.05, mistake 0.10, blunder 0.20); also ACPL (capped 1000) and
the referee-best rate. The bot and the human are judged by the same frame at the same position.

`sim.ts` replays each sampled (game, side) in ply order with `--chains` independent chains, the
way the service worker plays an own move: `ownMoveMaiaElo` (timing persona `tau` sampled per game,
form 0 as the session holds it) → Maia at that rating from the grid (log-linear interpolation;
mean TV error 0.0025 at step 100) → the human-depth frame `humanDepth(selfElo)` → `selectMove` with
the production context. Per-game state follows the game actually played: the previous-own-moves
memory and the tilt reference are the human's.

Every uncertainty is cluster-robust by game (`stats.ts`). The fit's objective for a cell is
`Σ z²` over expected-points loss and the three band rates, `z = (bot − human)/√(SE_h² + SE_b²)`,
plus the rating term `((plays at − R)/SE)²` from the intrinsic rating model — χ²-like, ≈ 5 when
indistinguishable.

## Fitting and smoothing

`fit.ts` sweeps a flat table `[R, R + Δ, T]` per cell on the fit split — Δ −600…+1000 (bullet
−1000…+1000) step 100, T 0.3…1.8 step 0.1; a coarse pass on every other value, then the best
point's neighbours until it stops moving; all candidate tables of a pass run row-major in one
`simulateMany`, sharing the selector's per-root caches and common random numbers — and saves the
surface. Conditioning and temperature trade off (both move strength), so a surface has a valley of
equivalent points; `--smooth` picks one evaluated point per cell by a monotone Viterbi pass
(`JOINT`): objective + a light prior towards Δ = 0, T = 1 (0.25 χ² units per 400 Elo or 0.4 T; it
only breaks ties) + smoothness between neighbouring buckets, the conditioning never decreasing with
R, at smoothness weight 12 (chosen on the holdout: 1 → Σz² 111, 4 → 101, 12 → 81, 30 → 95;
`--smooth --smooth-weight W` writes `fit/table-smoothW.json` for `verify.ts --table`). Cells with
fewer than 20 fit games are left out. Knots are written as `[R, conditioning, T]`,
the conditioning capped at `MAIA.conditioningEloMax` (what runs).

Results and the shipped table: `docs/qa/maia-calibration-2026-09-23.md`.

## Verification (cross-fitted)

Every player is verified once, by a table and a rating model that never saw them: direction A fits
both on `fit` and verifies on `holdout`, direction B the reverse, and `crossfit.ts` pools the two
(inverse-variance for each cell's "plays at" gap, `(z_A + z_B)/√2` for the loss metrics). This also
removes v1's reuse of the holdout for choosing the smoothing weight. The shipped table is fitted on
all players; the cross-fit is its out-of-sample accuracy.

1. **Error profile** — bot vs humans per cell with 95 % intervals and z, and per clock quartile.
2. **Intrinsic rating** — `rating-model.ts`, a per-move ordered-logit model of move quality given
   rating and position difficulty (12 classes; near-best moves, only-move gap, decidedness, clock
   pressure, material, legal moves; rating × difficulty interactions), trained on one split's humans and knowing
   nothing about Maia. The bot's and the humans' moves over the same held-out positions each get a
   pooled maximum-likelihood rating; their paired gap (cluster-robust by game) added to the players'
   mean actual rating is the rating the bot plays at. It replaced a per-game ridge regression whose
   gap-over-slope comparison amplified noise; `rating-eval.md` has its accuracy.

## Fidelity limits

- The referee is one thread, 32 MB, plain-SIMD under Bun: depths differ from a browser's.
- The production shaped search (Maia's favourites + known best in one search) is approximated by
  the broad MultiPV search plus an extra `searchmoves` pass.
- No position history reaches the selector (repetition guards see only the FEN).
- Positions come from human play, so the bot never plays on from its own earlier mistakes; the
  opening (ply < 16) is excluded because the product plays book moves there.
- Maia at ratings between grid points is interpolated; above `MAIA.conditioningEloMax` it is
  clamped exactly as the pipeline clamps it.

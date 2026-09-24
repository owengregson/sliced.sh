# tools/timing-calibration: fitting think times to chess.com players

The think-time calibration (`src/core/constants/timing-calibration.ts`) holds these, per chess.com
time class, advertised rating and move situation (forced, book, obvious recapture, check,
ordinary):

- **how much of the move budget's compression of the learned sample is kept** (`budgetPower`, per
  class). 1 is the budget as before; 0 plans with ChessMimic's clock-conditioned sample at the
  user's speed setting.
- **how the sampled think is shifted**, a log multiplier above the physical support. A positive
  shift fades out as the own clock runs down.
- **how readily a safe recapture is premoved**, the attempt probability of the session's existing
  premove path, with its own prediction gate (`PREMOVE.tradeReplyMinProb`).

The target is that the bot's *clock-recorded* think times match real chess.com players of that
rating. This directory measures that, fits the table and verifies it on held-out players. Nothing
here ships. Every TypeScript script runs the shipped `src/` modules under plain `bun`
(`../lib/defines.ts` first).

The "clock-recorded" think is the important part. In production a move is released at
`max(planned think, preparation + the hand)`. Preparation is the own-move search, whose
deadline is the class budget (blitz 600 ms, bullet 400 ms) unless a pondered prediction hit
the cache. The hand is the approach plus the natural touch. So what chess.com records can be much
longer than the plan, and a calibration fitted to the plan alone would be wrong. The replay
(`sim.ts`) models the whole path; the fit runs through it.

## Pipeline

| step | script | in → out (under `data/timing/calib/`, git-ignored) | cost |
|---|---|---|---|
| 1 | `build_corpus.py` (reference rules: `build-corpus.ts`) | `data/calibration/games.jsonl` or `data/timing/crawl/games.jsonl` → `corpus.jsonl` (per game: moves, per-ply labels), `labels.jsonl` (per game and ply, for the finetuner, see its README), `corpus-summary.json` | 10.8 k games ≈ 1.5 min at 2 workers (≈ 17 ms per game per worker); `--no-fens` for the crawl |
| 1b | `verify-labels.ts` | recomputes a sample's labels with the TypeScript reference (shipped book and chess modules) and requires 0 mismatches | seconds |
| 2 | `human-report.ts` | humans only: quantiles, premove and sub-second shares per tc group × band × situation, ≤ 30 game-sides per player per class, player-cluster bootstrap | ≈ 20 s |
| 3 | `select.ts` | → `select.json`: the replayed game-sides per (tc group × 400-Elo band × split), ≤ 3 per player, preferring games already searched | seconds |
| 3b | `build_corpus.py --only data/timing/calib/select.json` | → `select-games.jsonl` (the selected games with FENs) | seconds |
| 4 | `frames.ts --shard k/2 [--slot s]` | → `frames.<s>.jsonl`: vendored Stockfish 19 small net, `go depth 8` MultiPV 4, every ply of every selected game (the opponent's positions feed the ponder and the premove predictions) | ≈ 0.35 games/s per worker |
| 5 | `heads.ts --emit` → `heads_worker.py` → `heads.ts --check` | → `heads.jsonl`: the shipped ChessMimic band distribution of every replayed row (shipped `buildInputs` + scalers in TypeScript; batched native onnxruntime; a sample re-run through onnxruntime-web must agree within `fixtureProbTolerance`) | minutes |
| 6 | `fit.ts --stage premove` | one replay at `p = 0.5` → `fit/premove.json` | ≈ 10 min |
| 7 | `fit.ts --stage shift --grid g1,g2,…` | one replay per grid value → `fit/shift_<g>.json` (run two processes with half the grid each) | ≈ 10 min per value |
| 8 | `fit.ts --stage table --source fit\|holdout\|all [--write]` | → `fit/table-<source>.json`; `--write` puts the `all` table in `src/core/constants/timing-calibration.ts` | seconds |
| 9 | `crossfit.ts` | before (shipped band) / new band / mechanisms / fit→holdout / holdout→fit / all → `verify/crossfit/` | ≈ 40 min |
| 10 | `flags.ts --tables identity@shipped,…` | closed loop, the bot on its own clock: flags, spend, final clock per class and band → `verify/flags.md` | ≈ 15 min |
| 11 | `cap-check.ts` | does the fast-reply cap change the move? capped vs full searches → `verify/cap-check.md` | ≈ 30 min |
| 12 | `premove-outcomes.ts` | queued trade premoves executed vs dropped by the site → `verify/premove-outcomes.md` | ≈ 5 min |
| 14 | `select_crawl.py --out DIR` → `build_corpus.py --only DIR/select.json` → (with `SL_TIMING_CALIB_DIR=DIR`) `frames.ts`, `heads.ts --emit --tag main/cand` + `heads_worker.py`, `crawl-verify.ts` | independent holdout on the crawl (players absent from the calibration corpus), main vs shipped → `verify/crawl-holdout/` | ≈ 40 min |
| 13 | `fixture.ts` | → `test/fixtures/timing/calibration-replay.json`, the behavioural test's frozen replay | ≈ 3 min |
| – | `verify.ts --label L --table identity\|shipped\|FILE [--fast-reply] [--hover]` | one replay, one split → `verify/<L>/report.md` | ≈ 5 min |

```
tools/data/.venv/bin/python tools/timing-calibration/build_corpus.py --games data/timing/crawl/games.jsonl --no-fens
bun tools/timing-calibration/verify-labels.ts
bun tools/timing-calibration/human-report.ts --wide
bun tools/timing-calibration/select.ts
tools/data/.venv/bin/python tools/timing-calibration/build_corpus.py --games data/timing/crawl/games.jsonl --only data/timing/calib/select.json
bun tools/timing-calibration/frames.ts --shard 0/2 & bun tools/timing-calibration/frames.ts --shard 1/2
bun tools/timing-calibration/heads.ts --emit && tools/data/.venv/bin/python tools/timing-calibration/heads_worker.py && bun tools/timing-calibration/heads.ts --check
bun tools/timing-calibration/fit.ts --stage premove
bun tools/timing-calibration/fit.ts --stage shift --power 0 --grid -1.0,-0.6,-0.4,-0.2,0,0.2,0.4,0.6,1.0,1.4
bun tools/timing-calibration/fit.ts --stage shift --power 1 --grid -1.0,-0.6,-0.3,0,0.3,0.6,1.0,1.4,1.8,2.2
for s in fit holdout all; do bun tools/timing-calibration/fit.ts --stage table --source $s; done
bun tools/timing-calibration/fit.ts --stage table --source all --write
bun tools/timing-calibration/crossfit.ts
bun tools/timing-calibration/flags.ts --tables identity@shipped,data/timing/calib/fit/table-all.json
bun tools/timing-calibration/cap-check.ts && bun tools/timing-calibration/premove-outcomes.ts
bun tools/timing-calibration/fixture.ts
```

To refit on a candidate ChessMimic band set (the finetuner's), give `heads.ts --emit` the options
`--with-move --scalers FILE --tag T` (the timed-move contract), and give `heads_worker.py` the
options `--models DIR --tag T`. Bands missing from the directory fall back to the shipped ones.
Then set `SL_HEADS_TAG=T` for every later step. The shipped table is fitted this way on the
fine-tuned 2200–3500 band (`heads.cand.jsonl`); the "before" runs use the band on main
(`heads.jsonl`, `identity@shipped`).

## The replay (`sim.ts`)

Each selected side is replayed in ply order by 4 chains, one bot game each. The bot is set to the
human's advertised rating and gets the production preset for the control and a persona from the
chain's game id. It sees the recorded positions, clocks, and the opponent's moves and thinks, and
"plays" the human's move, so a row's situation is the human's. At each own move:

1. **Premove.** After the previous move the session arms a premove when the shipped
   `premoveCandidate` (run once per row over the cached frames, with every draw passing) finds one
   for the reply it predicts. The random gates are drawn per chain with the production
   probabilities. If the opponent plays that reply, one of two things happens. A queueable
   candidate whose opponent think left room for the arming searches (340 ms), the entry delay and
   the gesture is a site premove, recorded as 0.1 s. Anything else is the fast reply
   (`fireOnReply`), realised with the hand's measured distribution.
2. **Planned move.** `TimingModel.planMove` runs with the production context: the cached band
   distribution, the frame's lines, the ponder's expected reply, the book flag, the prior
   position, and the hover square when the idle hand anticipated (`anticipationEngageProb`).
   Preparation follows: `ownMoveBudget`'s movetime, the fast-reply cap when on, and a cache hit
   when the opponent played the predicted reply after the pre-analysis could finish. Then the
   hand: it starts at `max(deadline − approach, preparation)` and takes
   `max(approach, natural touch)`, except that an anticipated prepared touch is realised as
   planned. `observe` feeds the release back.

Recorded = `ceil(release / 100 ms)·100 ms`. With `ownClock` (the closed loop, `flags.ts`) the bot
plays on its own clock, and a chain that runs out is a flag. The latency constants are in `sim.ts` `LATENCY`. The
hand's numbers come from the `hover` executor simulation (60 seeds at 2700). Transport (30 ms)
and preparation overheads are assumptions. No browser measured them.

## What is measured (`stats.ts`)

Per cell (tc group × band × situation), on the **same positions** for bot and human: the
10/25/50/75/90 % quantiles, the premove share (≤ 0.2 s) and the sub-second share, each with a
player-cluster bootstrap 95 % interval. Also CRPS (s), the two-sample KS distance, and the AUC of
the best one-feature real-vs-bot classifier (0.5 means indistinguishable). The headline is the
human-n-weighted mean of |AUC − ½|, KS, |ln median ratio| and |premove share difference| over
situation cells.

## Fitting (`fit.ts`)

- **Premove.** The share is linear in the attempt probability, so one replay at p = 0.5 gives
  `p = 0.5 · human / bot` per recapture cell. It is clamped to [0, 1], smoothed over the rating
  knots (weighted least squares with a first-difference penalty), and then made non-decreasing in
  rating (PAVA).
- **Shift and budget power.** There is one replay per (power, shift) grid value, with every cell
  at that shift. Per cell the objective is `n_eff·Σ_q w_q (ln bot_q − ln human_q)²`. A Viterbi pass
  over the knots (800 … 2800, 3100: the 400-Elo bands' centres) minimises the objective plus
  `λ(v_k − v_{k−1})²` and a `2·g²` prior. Cells with fewer than 25 human moves are filled by the
  smoothness. Per class, the power with the lower total objective is kept.

Every replay covers both splits, so the fit-split table, the holdout-split table and the
all-player table all come from the same runs. `crossfit.ts` verifies each on the other split.

Results and the shipped table: `docs/qa/timing-calibration-2026-09-24.md`.

## Fidelity limits

- The latency model (transport, preparation overhead, cache hits, the hand) is a model. The
  hand's numbers are simulated, not browser-measured.
- The engine lines are depth 8 on the small net. The browser searches deeper, and the premove
  predictions are made from these frames.
- The Maia premove gate (H8) and Maia's opening choice below 1700 are not replayed (no Maia
  policies for these rows). The book flag is the human move's membership in the bot's book.
- The bot plays the human's move and the human's clocks, so it never plays on from its own time
  use.
- Book premoves and quiet premoves: the session queues only self-invalidating premoves (safe
  recaptures, the only move), so a human's 0.1 s book move cannot be matched. The fast reply is
  the floor there.

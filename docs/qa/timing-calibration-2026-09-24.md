# Think-time calibration against chess.com players (2026-09-24)

Owner: at high Elo (for example 2700 vs 2700) the bot is too slow on book and opening moves and on
obvious recaptures. Humans often move in under 1 s; the bot takes more than 1 s. The request was to
solve it generally, by calibration: the bot's think times should match real chess.com players of the
advertised rating, per time class × rating × situation, and be verified on held-out players.

This note covers what was measured, what changed in the product, and how it was verified. The
harness is `tools/timing-calibration/`; its README has the pipeline and the commands. Every number
below can be reproduced from `data/timing/calib/`: the verification outputs are under `verify/`
and the fit's surfaces and tables under `fit/`.

## Summary

- **Why the bot was slow.** In production a move that is not premoved is released at
  `max(planned think, search deadline + the hand)`. The own-move search deadline is 600 ms in blitz
  and 400 ms in bullet unless the pondered prediction hit the cache, and the hand takes about
  0.45 s. So a book move or a recapture could not land under about 1.05 s in blitz or 0.85 s in
  bullet, whatever the timing model planned. Separately, the session premoved only replies it
  predicted with p ≥ 0.55. At 2200+ that gave 11–19 % of obvious recaptures premoved; humans
  premove 27–66 %.
- **Why ordinary moves were wrong the other way.** The move budget compressed ChessMimic's learned
  sample to about a quarter of itself (median `comp` 0.25), and a recognition cap cut every pondered
  reply at about 1.2–1.6 s. The bot spent only about 55 % of the humans' clock in blitz and rapid.
- **What changed.**
  1. A fitted think-time table per chess.com class × rating × situation: a log shift and a budget
     power. Blitz and rapid now plan with the learned sample itself; bullet keeps the budget.
  2. Calibrated recapture-premove rates, routed through the existing premove path, with a
     prediction gate of their own for safe trades.
  3. A fast-reply search cap, used only when the book or the opponent's-turn analysis already
     decided the move.
  4. Wiring for `hover`'s anticipated prepared touch.
  5. Wiring for the fine-tuned band's timed-move row (the lead's decision). The table is fitted
     against that band.
- **Held-out result** (fit split → holdout players, and the reverse): across 143 held-out cells, human-n weighted: mean |AUC − ½| **0.135 → 0.056**, KS **0.33 → 0.16**, mean |ln(bot median / human median)| **0.58 → 0.19** (the reverse direction: 0.059, 0.17, 0.20). Blitz 2600–2700 obvious recaptures are premoved 36–38 % against the humans' 31–38 % (main: 16–22 %).

| run | cells | mean abs(AUC − ½) | KS | mean abs(ln median ratio) | mean abs(premove share diff) |
|---|---|---|---|---|---|
| before-holdout | 143 | 0.135 | 0.326 | 0.580 | 0.073 |
| before-fit | 149 | 0.134 | 0.325 | 0.582 | 0.071 |
| new-head-holdout | 143 | 0.134 | 0.327 | 0.579 | 0.073 |
| mechanisms-holdout | 143 | 0.134 | 0.321 | 0.577 | 0.073 |
| fit-to-holdout | 143 | 0.056 | 0.165 | 0.190 | 0.062 |
| holdout-to-fit | 149 | 0.059 | 0.169 | 0.199 | 0.060 |
| all-holdout | 143 | 0.059 | 0.164 | 0.187 | 0.061 |
| all-fit | 149 | 0.061 | 0.168 | 0.196 | 0.060 |

Legend: `before` is main (the shipped band, identity table, no cap, no hover). `new-head` is the fine-tuned band alone. `mechanisms` adds the fast-reply cap and the hover, with no fitted values. `fit-to-holdout` and `holdout-to-fit` are the cross-fits. `all-*` is the shipped table. The first three change almost nothing on their own; the fitted table does the work.

## What changed in the product

| where | what |
|---|---|
| `src/core/constants/timing-calibration.ts` | `TIMING_CALIBRATION`, written by `fit.ts --write`. Per chess.com class (bullet/blitz/rapid; classical and untimed are not calibrated) it holds the rating knots 800…3100, `budgetPower`, a log `shift` per situation (forced / book / recapture / check / ordinary), and `premove.recapture`. Also `TIMING_CALIBRATION_LIMITS`: the shift bounds, the per-class clock fade, and the persona scaling of the premove rate. |
| `src/core/timing/calibration.ts` | The reader: chess.com class, knot interpolation, situation, obvious recapture (`isObviousRecapture` / `obviousRecaptureAvailable`), and `premovePropensity`. |
| `src/core/timing/timing-model/calibrate.ts` | The stage between the budget normalisation and the clock policies. It applies only to the learned head's samples (`includesExecution`); the parametric fallback is untouched. With `budgetPower` p it keeps `moveTimeScale·(comp/moveTimeScale)^p` of the budget's compression. It shifts the sample above its physical support by `e^shift`, and fades a positive shift out as the own clock runs down (bullet 60 %→30 % of the effective base, blitz and rapid 35 %→10 %). Premoves are never touched. It records `calibrationShift` and `calibrationSituation` in `plan.features`. |
| `timing-model/compose.ts` | The move budget's recognition cap relaxes geometrically towards the distribution cap as `budgetPower` drops (p = 1 keeps it). Hover's anticipated prepared touch: when `ctx.hoverSquare` is the moving piece's square and the move is the pondered reply or a recapture, a quick sample becomes `anticipatedExecution` (reaction, grasp, carry; floor `ANTICIPATION.floorMs`), in instant mode with `features.anticipated = 1`. |
| `TimingContext` | `priorFen` (the position before the opponent's reply, for the recapture test) and `hoverSquare`. |
| `src/service/game-session/recommendation/fast-reply.ts` | The **fast-reply cap** (`SEARCH_BUDGET.fastReplyMs`: bullet 150, blitz 250, rapid 400 ms). The search ends there when the book answered (outside Maia's own openings) or when the opponent's-turn analysis, meaning the pre-analysis of the predicted position or else the ponder's top line, predicted the reply that arrived and rated an obvious recapture our best answer. It is never used in max-strength mode or when the tablebase is consulted. Only the movetime is capped; the MultiPV, depth and cache identity stay as they were. |
| `recommendation.ts`, `recommendation/timing.ts`, `session/move-delivery.ts`, `session/replan.ts` | Pass `priorFen`, `ponderedAnswer` and `hoverSquare` (read structurally from `MoveExecutor.hoverSquare()`, which lives on `feat/tlead-hover`). Timed-move rows: the head infers the pondered answer and the held Maia answer's top moves as candidates alongside the history row, then `prepareChosenMove` infers the chosen move's row on a miss (one bounded inference). The history row remains the fallback. |
| `src/core/strength/premove.ts`, `session/premove.ts` | `PremoveContext.propensity`: the calibrated trade (and, if ever fitted, ordinary) attempt rates, persona-scaled, and the calibrated trade prediction gate `PREMOVE.tradeReplyMinProb` = 0.2, which applies only with a calibrated table. A queued trade is self-invalidating: it is legal only if they take on that square. A safe trade whose calibrated rate is below the ordinary one is thinned to its own rate. Without a table the random stream is unchanged. |
| `src/core/chess/san.ts` | `legalMoves` keeps the last 64 positions (fresh arrays out). One position is asked about by the features, both budgets and the premove gates in the same turn. |

The owner's constraints hold. The bot never moves before the opponent's move is on the board,
except through the existing queued premove, which is entered during their turn for a reply the arm
pre-decided. The clock race, emergency and lone-king policies are unchanged. The settings
(`moveTimeScale`, `premoveTendency` through `pi_p`, variance) still act.

## Corpus and labels

The corpus is `data/calibration/games.jsonl`: chess.com rated games from January to August 2026,
**10 792 games**, both sides, `[%clk]` on every ply, **805 349 labelled plies**
(`build_corpus.py`). The TypeScript reference `build-corpus.ts` uses the shipped book and chess
modules, and `verify-labels.ts` requires 0 mismatches between the two on a sample (300 games,
21 154 plies: 0).

- think = clock before − clock after + increment, at 0.1 s resolution; a premove is recorded as
  0.1 s, so think ≤ 0.2 s counts as a premove. The side's first move is excluded.
- Situations, most specific first:
  - forced: the only legal move.
  - book: the move is in the book the bot itself consults at this rating (`bookOrderFor(E)`, the
    first book that knows the position, weight share ≥ 1 %, ply ≤ 30, E ≤ 3000).
  - recapture: the opponent's move captured on s, we capture back on s, and the material balance
    returns at least to where it was before their capture.
  - check: we are in check.
  - ordinary: everything else.
- Split by player (`splitFor`, about 60/40). The statistics use ≤ 30 game-sides per player per
  class.
- `data/timing/calib/labels.jsonl` (one row per game and ply, README beside it) is the finetuner's
  join table.

The humans alone (`human-report.ts --wide`, player-cluster bootstrap), re-deriving the lead's
finding. At 2200+ an obvious recapture is premoved 27–29 % in blitz below 2600, 37 % at 2600 and
49 % at 3000+; in bullet 46–64 %. Book moves have a blitz median of 0.9–1.1 s against 2.0–2.5 s for
ordinary moves, and a bullet median of 0.4–0.5 s with 27–30 % under 0.2 s.

## The replay

`sim.ts` replays 3 485 selected game-sides from 3 138 games, all of whose plies were searched.
Per tc group × 400-Elo band × split there are up to 60 sides (120 for bullet and blitz 2200+), ≤ 3
per player. Each side runs in 4 chains. The bot is set to the human's rating, sees the human's
positions, clocks and opponent, and "plays" the human's move. Per move:

1. **Premove.** The engine part of the shipped `premoveCandidate` runs once per row over cached
   depth-8 MultiPV-4 frames; the random gates are drawn per chain. A queueable candidate the
   opponent's think left room for (arming searches of 340 ms, the entry delay and a 180 ms gesture)
   is recorded as 0.1 s. Otherwise the fast reply is realised with the hand's measured distribution
   (`hover`'s simulation, p50 about 0.3 s).
2. **Planned move.** `TimingModel.planMove` runs with the production context and the band's cached
   distribution (native onnxruntime, batched; a sample checked against onnxruntime-web, max |Δp|
   5.5e-7). Then preparation: `ownMoveBudget`'s movetime, the fast-reply cap, and a cache hit when
   the opponent played the predicted reply after the pre-analysis finished. Then the hand: it starts
   at `max(deadline − approach, preparation)`. It takes the planned approach if the plan is an
   anticipated prepared touch. It takes a fast touch (floor 150 ms) in a clock race. Otherwise it
   takes `max(approach, natural touch)`, where the natural touch is log-normal with median 453 ms,
   or 403 ms with the hand hovering, per `hover`'s 60-seed measurement at 2700. Add 30 ms of
   transport. The hover engages at `anticipationEngageProb`.
3. The recorded think is `ceil(release / 0.1 s)`.

The closed-loop variant (`flags.ts`) plays each side on the bot's own clock.

## Before (current main, held out)

The before replay uses the shipped head, the identity table, no fast-reply cap and no hover.
The first columns of the tables below (`before-holdout`) are this baseline. At 2200+ the bot's book
and recapture medians sat at 0.9–1.3 s in blitz and 0.7–1.0 s in bullet, against the humans'
0.9–1.4 s and 0.1–0.5 s. It premoved 5–24 % of recaptures (humans 24–66 %) and almost no book
moves. It was also 1.5–3× too fast on ordinary moves in blitz and rapid (blitz 2200 ordinary: bot
1.2 s against human 2.4 s; rapid 10+0 1800: 1.9 s against 5.8 s).

## Fitting

- **Premove.** One replay at attempt rate 0.5; the fitted rate is `0.5 · human / bot` per recapture
  cell, smoothed over knots and made non-decreasing in rating.
- **Shift and budget power.** Replays at shift ∈ {−1, −0.6, −0.4, −0.2, 0, 0.2, 0.4, 0.6, 1, 1.4}
  with budget power 0, and ∈ {−1, −0.6, −0.3, 0, 0.3, 0.6, 1, 1.4, 1.8, 2.2} with power 1. The
  objective is n_eff·Σ w_q (ln bot_q − ln human_q)² over the 10/25/50/75/90 % quantiles. A Viterbi
  pass over knots adds λ = 30 per unit² of neighbour difference and a 2·g² prior. The power with
  the lower total objective wins per class: bullet keeps the budget (power 1); blitz and rapid plan
  with the fine-tuned band's own sample (power 0). Power 0 is also the robust choice against the
  replay's shallow frames. The budget's effort reads the MultiPV breadth, which the depth-8
  MultiPV-4 frames understate, but the learned sample does not read it.
- The clock fade was added after the closed-loop check. Without it, bullet flagged about twice as
  often as the humans. The whole grid was fitted with it in place.
- The fit-split table verifies on the holdout players and the holdout-split table on the fit
  players; the shipped table is fitted on everyone.

The shipped table (`src/core/constants/timing-calibration.ts`):

```ts
export const TIMING_CALIBRATION: TimingCalibrationTable = {
	bullet: {
		knots: [800, 1200, 1600, 2000, 2400, 2800, 3100],
		budgetPower: 1,
		shift: {
			forced: [1, 1, 1, 1, 0.6, 0.6, 0.6],
			book: [-0.6, -0.6, -0.6, -1, -1, -1, -1],
			recapture: [1.8, 1.8, 1.4, 1.4, 1, 1, 1],
			check: [2.2, 2.2, 1.8, 2.2, 2.2, 2.2, 1.8],
			ordinary: [1.4, 1, 1, 1, 1, 1, 0.3],
		},
		premove: { recapture: [0.357, 0.502, 0.555, 0.708, 0.816, 0.891, 0.99], other: null },
	},
	blitz: {
		knots: [800, 1200, 1600, 2000, 2400, 2800, 3100],
		budgetPower: 0,
		shift: {
			forced: [-0.4, -0.2, 0, 0, 0, 0, 0],
			book: [-1, -1, -1, -1, -0.4, -0.4, -0.4],
			recapture: [-0.6, -0.4, -0.4, -0.4, 0, 0.4, 0.4],
			check: [-0.4, -0.4, -0.4, -0.2, -0.2, 0, -0.2],
			ordinary: [-0.4, -0.4, -0.4, -0.2, 0, 0, 0],
		},
		premove: { recapture: [0.19, 0.19, 0.22, 0.341, 0.375, 0.447, 0.543], other: null },
	},
	rapid: {
		knots: [800, 1200, 1600, 2000, 2400, 2800, 3100],
		budgetPower: 0,
		shift: {
			forced: [-0.4, -0.2, 0, -0.4, -0.2, -0.6, -0.6],
			book: [-0.6, -0.4, 0.2, 0, -0.4, -0.6, -0.6],
			recapture: [-0.2, -0.2, 0.6, 0.4, 0, -0.2, -0.2],
			check: [0, 0, 0.6, 0.2, -0.2, -0.6, -0.6],
			ordinary: [0, 0, 1, 0.6, -0.2, -0.2, -0.2],
		},
		premove: { recapture: [0.072, 0.072, 0.092, 0.122, 0.277, 0.473, 0.473], other: null },
	},
};
```

## Results on held-out players

The runs are: before (main); fit → holdout (the table fitted on the fit players, replayed on the
holdout players, with the production configuration); and all → holdout (the shipped table).
Medians in seconds.

### Bullet and blitz, 2200+, by 100 Elo: book, recapture, ordinary

| tc | band | situation | n | human median | before-holdout median | fit-to-holdout median | all-holdout median | human premove | before-holdout premove | fit-to-holdout premove | all-holdout premove |
|---|---|---|---|---|---|---|---|---|---|---|
| bullet | 2200 | book | 128 | 0.50 | 1.00 | 0.90 | 0.90 | 26% | 0% | 1% | 1% |
| bullet | 2200 | recapture | 93 | 0.40 | 0.80 | 0.60 | 0.60 | 48% | 14% | 41% | 41% |
| bullet | 2300 | book | 88 | 0.40 | 1.00 | 0.90 | 0.90 | 39% | 0% | 3% | 3% |
| bullet | 2300 | recapture | 67 | 0.50 | 0.90 | 0.80 | 0.80 | 40% | 5% | 32% | 32% |
| bullet | 2400 | book | 110 | 0.50 | 1.00 | 0.90 | 0.90 | 22% | 0% | 2% | 2% |
| bullet | 2400 | recapture | 73 | 0.50 | 0.90 | 0.50 | 0.50 | 40% | 9% | 39% | 39% |
| bullet | 2500 | book | 140 | 0.40 | 1.00 | 0.90 | 0.90 | 24% | 0% | 1% | 1% |
| bullet | 2500 | recapture | 87 | 0.10 | 0.80 | 0.50 | 0.50 | 56% | 17% | 41% | 41% |
| bullet | 2600 | book | 110 | 0.50 | 0.90 | 0.90 | 0.80 | 22% | 0% | 1% | 1% |
| bullet | 2600 | recapture | 53 | 0.20 | 0.70 | 0.40 | 0.40 | 51% | 17% | 45% | 45% |
| bullet | 2700 | book | 145 | 0.50 | 0.90 | 0.80 | 0.80 | 25% | 0% | 2% | 2% |
| bullet | 2700 | recapture | 66 | 0.10 | 0.80 | 0.60 | 0.55 | 55% | 8% | 38% | 38% |
| bullet | 2800 | book | 204 | 0.40 | 1.00 | 0.90 | 0.90 | 25% | 0% | 0% | 0% |
| bullet | 2800 | recapture | 107 | 0.50 | 0.80 | 0.40 | 0.40 | 44% | 13% | 46% | 46% |
| bullet | 2900 | book | 190 | 0.30 | 1.00 | 0.90 | 0.90 | 36% | 0% | 1% | 1% |
| bullet | 2900 | recapture | 122 | 0.10 | 0.80 | 0.60 | 0.60 | 58% | 11% | 35% | 35% |
| bullet | 3000 | recapture | 161 | 0.10 | 0.80 | 0.40 | 0.40 | 66% | 12% | 41% | 41% |
| blitz | 2200 | book | 68 | 0.90 | 1.30 | 1.00 | 1.00 | 15% | 0% | 4% | 4% |
| blitz | 2200 | recapture | 49 | 1.30 | 1.10 | 1.10 | 1.05 | 24% | 24% | 28% | 27% |
| blitz | 2300 | book | 74 | 1.40 | 1.20 | 1.10 | 1.10 | 4% | 0% | 1% | 1% |
| blitz | 2300 | recapture | 59 | 0.80 | 0.90 | 0.95 | 1.00 | 31% | 17% | 23% | 22% |
| blitz | 2400 | book | 270 | 1.10 | 1.20 | 1.10 | 1.10 | 5% | 0% | 1% | 1% |
| blitz | 2400 | recapture | 158 | 1.10 | 1.10 | 0.80 | 0.80 | 26% | 16% | 32% | 31% |
| blitz | 2500 | book | 144 | 1.00 | 1.20 | 1.10 | 1.10 | 12% | 0% | 2% | 2% |
| blitz | 2500 | recapture | 91 | 1.10 | 0.90 | 1.00 | 1.00 | 27% | 23% | 30% | 28% |
| blitz | 2600 | book | 83 | 1.20 | 1.20 | 1.10 | 1.10 | 8% | 0% | 1% | 1% |
| blitz | 2600 | recapture | 71 | 1.20 | 0.90 | 0.70 | 0.70 | 31% | 22% | 36% | 36% |
| blitz | 2700 | book | 149 | 0.90 | 1.20 | 1.10 | 1.10 | 12% | 2% | 1% | 1% |
| blitz | 2700 | recapture | 55 | 0.90 | 0.90 | 0.70 | 0.70 | 38% | 16% | 38% | 38% |
| blitz | 2800 | book | 202 | 0.90 | 1.20 | 1.10 | 1.10 | 14% | 0% | 2% | 2% |
| blitz | 2800 | recapture | 100 | 0.40 | 1.00 | 0.70 | 0.70 | 48% | 17% | 36% | 37% |
| blitz | 2900 | book | 241 | 0.90 | 1.20 | 1.00 | 1.00 | 10% | 0% | 2% | 2% |
| blitz | 2900 | recapture | 137 | 0.90 | 1.10 | 0.65 | 0.70 | 34% | 15% | 40% | 39% |
| blitz | 3000 | recapture | 181 | 0.50 | 1.10 | 0.30 | 0.40 | 44% | 11% | 48% | 47% |

### Every class and band (400-Elo bands)

| tc | band | situation | n | human median | before-holdout median | fit-to-holdout median | all-holdout median | human premove | before-holdout premove | fit-to-holdout premove | all-holdout premove |
|---|---|---|---|---|---|---|---|---|---|---|
| bullet | 600 | book | 182 | 0.80 | 1.00 | 0.95 | 0.90 | 15% | 0% | 2% | 2% |
| bullet | 600 | recapture | 130 | 1.00 | 0.90 | 0.90 | 0.90 | 17% | 10% | 20% | 19% |
| bullet | 600 | check | 66 | 2.10 | 0.90 | 1.00 | 0.90 | 5% | 3% | 4% | 4% |
| bullet | 600 | ordinary | 1290 | 1.60 | 1.00 | 1.30 | 1.30 | 4% | 0% | 0% | 0% |
| bullet | 1000 | book | 216 | 0.50 | 1.00 | 0.90 | 0.90 | 33% | 0% | 4% | 4% |
| bullet | 1000 | recapture | 179 | 0.70 | 0.90 | 0.80 | 0.90 | 28% | 9% | 28% | 28% |
| bullet | 1000 | check | 65 | 1.20 | 0.80 | 0.80 | 0.80 | 14% | 0% | 0% | 0% |
| bullet | 1000 | ordinary | 1445 | 1.30 | 1.00 | 1.10 | 1.10 | 8% | 0% | 1% | 1% |
| bullet | 1400 | book | 152 | 0.60 | 1.00 | 0.90 | 0.90 | 26% | 0% | 5% | 5% |
| bullet | 1400 | recapture | 152 | 0.70 | 0.90 | 0.80 | 0.80 | 30% | 8% | 26% | 29% |
| bullet | 1400 | check | 114 | 1.00 | 0.70 | 0.70 | 0.70 | 8% | 0% | 1% | 1% |
| bullet | 1400 | ordinary | 1891 | 1.10 | 0.90 | 0.90 | 1.00 | 12% | 0% | 1% | 1% |
| bullet | 1800 | book | 173 | 0.40 | 1.00 | 0.70 | 0.70 | 33% | 0% | 2% | 2% |
| bullet | 1800 | recapture | 159 | 0.60 | 0.90 | 0.70 | 0.70 | 39% | 11% | 31% | 32% |
| bullet | 1800 | check | 92 | 0.80 | 0.70 | 0.70 | 0.70 | 16% | 0% | 1% | 1% |
| bullet | 1800 | ordinary | 1857 | 1.00 | 0.90 | 0.90 | 0.90 | 15% | 0% | 1% | 1% |
| bullet | 2200 | book | 466 | 0.40 | 1.00 | 0.90 | 0.90 | 27% | 0% | 2% | 2% |
| bullet | 2200 | recapture | 320 | 0.40 | 0.90 | 0.60 | 0.60 | 47% | 12% | 39% | 38% |
| bullet | 2200 | check | 215 | 0.80 | 0.80 | 0.80 | 0.80 | 17% | 0% | 0% | 0% |
| bullet | 2200 | forced | 34 | 0.70 | 0.70 | 0.70 | 0.70 | 9% | 1% | 5% | 5% |
| bullet | 2200 | ordinary | 3675 | 0.90 | 0.90 | 1.00 | 1.00 | 14% | 0% | 1% | 1% |
| bullet | 2600 | book | 649 | 0.40 | 1.00 | 0.90 | 0.90 | 28% | 0% | 1% | 1% |
| bullet | 2600 | recapture | 348 | 0.20 | 0.80 | 0.50 | 0.50 | 52% | 12% | 41% | 41% |
| bullet | 2600 | check | 256 | 0.60 | 0.70 | 0.70 | 0.70 | 18% | 1% | 0% | 0% |
| bullet | 2600 | forced | 36 | 0.60 | 0.70 | 0.60 | 0.60 | 28% | 1% | 1% | 1% |
| bullet | 2600 | ordinary | 3703 | 0.90 | 0.90 | 0.90 | 0.90 | 13% | 1% | 1% | 1% |
| bullet | 3000 | recapture | 161 | 0.10 | 0.80 | 0.40 | 0.40 | 66% | 12% | 41% | 41% |
| bullet | 3000 | check | 92 | 0.70 | 0.80 | 0.90 | 0.90 | 17% | 1% | 0% | 0% |
| bullet | 3000 | ordinary | 1988 | 0.70 | 0.90 | 0.90 | 1.00 | 21% | 0% | 1% | 1% |
| blitz | 600 | book | 206 | 1.30 | 2.30 | 1.80 | 1.40 | 5% | 0% | 0% | 0% |
| blitz | 600 | recapture | 157 | 1.40 | 1.30 | 1.50 | 1.50 | 11% | 6% | 10% | 11% |
| blitz | 600 | check | 128 | 2.30 | 1.30 | 2.20 | 2.30 | 3% | 1% | 0% | 0% |
| blitz | 600 | forced | 47 | 1.80 | 0.80 | 2.35 | 1.50 | 2% | 0% | 0% | 0% |
| blitz | 600 | ordinary | 1550 | 3.30 | 1.90 | 3.30 | 3.30 | 3% | 0% | 0% | 0% |
| blitz | 1000 | book | 221 | 1.20 | 2.00 | 1.30 | 1.20 | 6% | 0% | 1% | 1% |
| blitz | 1000 | recapture | 152 | 1.50 | 1.20 | 1.60 | 1.60 | 12% | 12% | 10% | 11% |
| blitz | 1000 | check | 110 | 2.15 | 1.40 | 2.10 | 2.10 | 5% | 0% | 0% | 0% |
| blitz | 1000 | ordinary | 1599 | 2.60 | 1.80 | 2.70 | 2.70 | 3% | 0% | 0% | 0% |
| blitz | 1400 | book | 238 | 1.10 | 1.50 | 1.20 | 1.20 | 9% | 1% | 1% | 1% |
| blitz | 1400 | recapture | 163 | 1.50 | 1.20 | 1.40 | 1.40 | 13% | 15% | 17% | 16% |
| blitz | 1400 | check | 108 | 1.90 | 1.30 | 2.20 | 2.25 | 5% | 0% | 0% | 0% |
| blitz | 1400 | forced | 27 | 1.20 | 0.70 | 0.80 | 0.80 | 0% | 0% | 0% | 0% |
| blitz | 1400 | ordinary | 1550 | 2.80 | 1.70 | 2.60 | 2.70 | 2% | 0% | 0% | 0% |
| blitz | 1800 | book | 257 | 1.00 | 1.30 | 1.00 | 1.00 | 8% | 0% | 1% | 1% |
| blitz | 1800 | recapture | 152 | 1.15 | 1.10 | 1.20 | 1.20 | 22% | 10% | 23% | 23% |
| blitz | 1800 | check | 125 | 1.80 | 1.00 | 1.80 | 2.00 | 2% | 0% | 0% | 0% |
| blitz | 1800 | ordinary | 1657 | 2.40 | 1.30 | 2.30 | 2.60 | 4% | 0% | 0% | 0% |
| blitz | 2200 | book | 556 | 1.10 | 1.20 | 1.10 | 1.10 | 8% | 0% | 1% | 1% |
| blitz | 2200 | recapture | 357 | 1.10 | 1.00 | 0.90 | 0.90 | 27% | 19% | 29% | 28% |
| blitz | 2200 | check | 238 | 1.25 | 0.90 | 1.10 | 1.20 | 9% | 0% | 0% | 0% |
| blitz | 2200 | forced | 40 | 0.90 | 0.70 | 0.70 | 0.70 | 18% | 2% | 1% | 1% |
| blitz | 2200 | ordinary | 3836 | 2.40 | 1.20 | 2.30 | 2.30 | 5% | 0% | 0% | 0% |
| blitz | 2600 | book | 675 | 0.90 | 1.20 | 1.10 | 1.10 | 12% | 0% | 2% | 2% |
| blitz | 2600 | recapture | 363 | 0.90 | 1.10 | 0.70 | 0.70 | 38% | 17% | 38% | 38% |
| blitz | 2600 | check | 259 | 1.00 | 0.90 | 1.00 | 1.00 | 6% | 1% | 1% | 1% |
| blitz | 2600 | forced | 32 | 0.75 | 0.70 | 0.70 | 0.70 | 22% | 0% | 2% | 2% |
| blitz | 2600 | ordinary | 3663 | 2.00 | 1.20 | 2.10 | 2.10 | 7% | 0% | 0% | 0% |
| blitz | 3000 | recapture | 181 | 0.50 | 1.10 | 0.30 | 0.40 | 44% | 11% | 48% | 47% |
| blitz | 3000 | check | 92 | 1.00 | 0.90 | 1.00 | 1.10 | 8% | 0% | 0% | 0% |
| blitz | 3000 | ordinary | 1880 | 1.70 | 1.20 | 1.80 | 1.80 | 6% | 0% | 0% | 0% |
| rapid:600 | 600 | book | 154 | 2.20 | 3.25 | 3.70 | 3.70 | 6% | 0% | 0% | 0% |
| rapid:600 | 600 | recapture | 121 | 2.00 | 2.40 | 3.40 | 3.50 | 7% | 12% | 4% | 4% |
| rapid:600 | 600 | check | 125 | 3.50 | 2.70 | 5.15 | 5.15 | 2% | 0% | 0% | 0% |
| rapid:600 | 600 | ordinary | 1557 | 5.60 | 3.00 | 7.70 | 7.60 | 2% | 0% | 0% | 0% |
| rapid:600 | 1000 | book | 226 | 1.80 | 2.40 | 2.70 | 2.70 | 2% | 0% | 1% | 1% |
| rapid:600 | 1000 | recapture | 166 | 2.05 | 2.20 | 3.00 | 3.20 | 3% | 5% | 4% | 4% |
| rapid:600 | 1000 | check | 109 | 2.70 | 2.30 | 3.50 | 4.20 | 1% | 0% | 0% | 0% |
| rapid:600 | 1000 | forced | 31 | 1.90 | 1.00 | 2.30 | 2.80 | 3% | 0% | 0% | 0% |
| rapid:600 | 1000 | ordinary | 1920 | 4.40 | 2.70 | 6.10 | 6.50 | 1% | 0% | 0% | 0% |
| rapid:600 | 1400 | book | 254 | 1.55 | 2.00 | 3.00 | 3.00 | 3% | 0% | 0% | 0% |
| rapid:600 | 1400 | recapture | 156 | 2.20 | 1.80 | 2.95 | 3.40 | 11% | 12% | 7% | 7% |
| rapid:600 | 1400 | check | 97 | 3.20 | 1.80 | 3.90 | 4.45 | 0% | 0% | 0% | 0% |
| rapid:600 | 1400 | ordinary | 1504 | 5.20 | 2.10 | 5.90 | 7.80 | 1% | 0% | 0% | 0% |
| rapid:600 | 1800 | book | 261 | 1.70 | 1.80 | 2.80 | 2.80 | 4% | 0% | 1% | 1% |
| rapid:600 | 1800 | recapture | 164 | 2.10 | 1.60 | 2.70 | 2.70 | 13% | 15% | 12% | 13% |
| rapid:600 | 1800 | check | 103 | 2.40 | 1.70 | 3.15 | 3.15 | 0% | 0% | 0% | 0% |
| rapid:600 | 1800 | ordinary | 1560 | 5.80 | 1.90 | 6.30 | 6.40 | 1% | 0% | 0% | 0% |
| rapid:600 | 2200 | book | 336 | 1.65 | 1.60 | 1.90 | 1.90 | 4% | 0% | 3% | 3% |
| rapid:600 | 2200 | recapture | 197 | 1.80 | 1.60 | 1.60 | 1.60 | 22% | 12% | 20% | 21% |
| rapid:600 | 2200 | check | 143 | 2.30 | 1.60 | 2.40 | 2.40 | 2% | 1% | 0% | 0% |
| rapid:600 | 2200 | ordinary | 1927 | 5.60 | 1.70 | 6.00 | 5.90 | 1% | 0% | 0% | 0% |
| rapid:600 | 2600 | book | 404 | 1.35 | 1.60 | 1.70 | 1.70 | 4% | 0% | 2% | 2% |
| rapid:600 | 2600 | recapture | 159 | 0.40 | 1.60 | 1.20 | 1.10 | 48% | 11% | 36% | 39% |
| rapid:600 | 2600 | check | 147 | 1.10 | 1.60 | 1.60 | 1.60 | 6% | 0% | 0% | 0% |
| rapid:600 | 2600 | ordinary | 1997 | 4.50 | 1.60 | 4.80 | 4.80 | 3% | 0% | 0% | 0% |
| rapid:600+5 | 600 | book | 115 | 3.40 | 3.10 | 3.10 | 3.10 | 2% | 0% | 0% | 0% |
| rapid:600+5 | 600 | recapture | 70 | 3.10 | 2.30 | 2.90 | 2.90 | 1% | 19% | 5% | 4% |
| rapid:600+5 | 600 | check | 55 | 4.40 | 2.60 | 4.40 | 4.70 | 2% | 2% | 0% | 0% |
| rapid:600+5 | 600 | ordinary | 709 | 8.90 | 3.00 | 6.80 | 6.80 | 0% | 0% | 0% | 0% |
| rapid:600+5 | 1000 | book | 247 | 3.50 | 2.80 | 2.90 | 2.90 | 2% | 1% | 0% | 0% |
| rapid:600+5 | 1000 | recapture | 149 | 3.50 | 2.30 | 2.90 | 2.90 | 3% | 10% | 5% | 5% |
| rapid:600+5 | 1000 | check | 114 | 5.40 | 2.50 | 4.20 | 4.70 | 0% | 0% | 0% | 0% |
| rapid:600+5 | 1000 | ordinary | 1262 | 9.80 | 2.90 | 7.10 | 7.10 | 0% | 1% | 0% | 0% |
| rapid:600+5 | 1400 | ordinary | 68 | 12.70 | 2.25 | 5.80 | 7.55 | 0% | 0% | 0% | 0% |
| rapid:600+5 | 2200 | book | 48 | 8.55 | 1.60 | 4.30 | 4.25 | 2% | 0% | 1% | 1% |
| rapid:600+5 | 2200 | ordinary | 85 | 17.70 | 2.65 | 19.10 | 19.20 | 2% | 0% | 0% | 0% |
| rapid:900+10 | 600 | book | 58 | 3.55 | 3.05 | 3.00 | 3.00 | 0% | 0% | 0% | 0% |
| rapid:900+10 | 600 | recapture | 71 | 2.90 | 2.40 | 2.75 | 2.75 | 1% | 11% | 4% | 4% |
| rapid:900+10 | 600 | check | 68 | 7.75 | 2.60 | 4.10 | 4.20 | 0% | 0% | 0% | 0% |
| rapid:900+10 | 600 | ordinary | 799 | 7.90 | 2.80 | 5.50 | 5.50 | 0% | 0% | 0% | 0% |
| rapid:900+10 | 1000 | book | 88 | 3.35 | 2.40 | 3.00 | 3.00 | 2% | 1% | 1% | 1% |
| rapid:900+10 | 1000 | recapture | 49 | 3.10 | 2.15 | 3.20 | 3.30 | 12% | 14% | 8% | 8% |
| rapid:900+10 | 1000 | check | 27 | 7.70 | 2.20 | 5.75 | 6.75 | 0% | 0% | 0% | 0% |
| rapid:900+10 | 1000 | ordinary | 588 | 11.60 | 2.60 | 7.20 | 8.10 | 0% | 0% | 0% | 0% |
| rapid:900+10 | 1400 | book | 256 | 3.25 | 2.00 | 2.80 | 2.80 | 1% | 0% | 0% | 0% |
| rapid:900+10 | 1400 | recapture | 172 | 4.25 | 1.80 | 3.10 | 3.50 | 4% | 17% | 8% | 8% |
| rapid:900+10 | 1400 | check | 98 | 8.60 | 2.00 | 4.90 | 5.35 | 0% | 1% | 0% | 0% |
| rapid:900+10 | 1400 | ordinary | 1796 | 13.40 | 2.20 | 7.00 | 8.90 | 0% | 1% | 0% | 0% |
| rapid:900+10 | 1800 | book | 277 | 4.00 | 1.90 | 2.90 | 2.90 | 1% | 0% | 1% | 1% |
| rapid:900+10 | 1800 | recapture | 163 | 4.30 | 1.70 | 3.80 | 3.80 | 6% | 17% | 8% | 9% |
| rapid:900+10 | 1800 | check | 91 | 7.20 | 1.90 | 6.10 | 6.20 | 0% | 0% | 0% | 0% |
| rapid:900+10 | 1800 | ordinary | 1690 | 15.30 | 2.60 | 9.40 | 10.00 | 0% | 0% | 0% | 0% |
| rapid:900+10 | 2200 | ordinary | 26 | 9.80 | 1.90 | 37.40 | 37.40 | 0% | 0% | 0% | 0% |

### The reverse direction (holdout-fitted table on the fit players)

| tc | band | situation | n | human median | before-fit median | holdout-to-fit median | all-fit median | human premove | before-fit premove | holdout-to-fit premove | all-fit premove |
|---|---|---|---|---|---|---|---|---|---|---|
| bullet | 600 | book | 165 | 0.80 | 1.00 | 1.00 | 0.90 | 18% | 0% | 1% | 1% |
| bullet | 600 | recapture | 134 | 1.00 | 0.90 | 0.90 | 0.90 | 18% | 8% | 18% | 18% |
| bullet | 600 | ordinary | 1175 | 1.60 | 0.90 | 1.30 | 1.30 | 7% | 0% | 0% | 0% |
| bullet | 1000 | book | 235 | 0.60 | 1.00 | 0.90 | 0.90 | 18% | 0% | 3% | 3% |
| bullet | 1000 | recapture | 158 | 0.85 | 0.80 | 0.80 | 0.80 | 26% | 8% | 28% | 28% |
| bullet | 1000 | ordinary | 1521 | 1.30 | 0.90 | 1.00 | 1.00 | 6% | 0% | 1% | 1% |
| bullet | 1400 | book | 175 | 0.60 | 1.00 | 0.90 | 0.90 | 22% | 0% | 3% | 3% |
| bullet | 1400 | recapture | 159 | 0.80 | 0.90 | 0.80 | 0.80 | 25% | 8% | 30% | 27% |
| bullet | 1400 | ordinary | 1699 | 1.20 | 0.90 | 1.00 | 1.00 | 9% | 0% | 1% | 1% |
| bullet | 1800 | book | 167 | 0.50 | 1.00 | 0.70 | 0.70 | 37% | 0% | 2% | 2% |
| bullet | 1800 | recapture | 162 | 0.70 | 0.90 | 0.70 | 0.70 | 35% | 8% | 33% | 33% |
| bullet | 1800 | ordinary | 1815 | 1.00 | 0.90 | 0.90 | 0.90 | 14% | 0% | 1% | 1% |
| bullet | 2200 | book | 479 | 0.40 | 1.00 | 0.90 | 0.80 | 30% | 0% | 3% | 3% |
| bullet | 2200 | recapture | 303 | 0.30 | 0.80 | 0.60 | 0.60 | 48% | 9% | 38% | 38% |
| bullet | 2200 | ordinary | 3380 | 1.00 | 0.90 | 1.00 | 1.00 | 13% | 0% | 1% | 1% |
| bullet | 2600 | book | 575 | 0.40 | 1.00 | 0.90 | 0.90 | 31% | 0% | 1% | 1% |
| bullet | 2600 | recapture | 398 | 0.20 | 0.90 | 0.60 | 0.60 | 50% | 11% | 35% | 36% |
| bullet | 2600 | ordinary | 3810 | 0.80 | 0.90 | 0.90 | 0.90 | 16% | 0% | 0% | 0% |
| bullet | 3000 | recapture | 187 | 0.10 | 0.90 | 0.40 | 0.40 | 62% | 11% | 38% | 37% |
| bullet | 3000 | ordinary | 2497 | 0.60 | 0.90 | 0.90 | 1.00 | 21% | 0% | 0% | 0% |
| blitz | 600 | book | 204 | 1.60 | 2.30 | 1.40 | 1.40 | 5% | 0% | 1% | 1% |
| blitz | 600 | recapture | 145 | 1.60 | 1.35 | 1.60 | 1.60 | 9% | 10% | 11% | 10% |
| blitz | 600 | ordinary | 1355 | 3.40 | 1.90 | 3.20 | 3.20 | 3% | 0% | 0% | 0% |
| blitz | 1000 | book | 229 | 1.10 | 1.90 | 1.20 | 1.20 | 7% | 0% | 0% | 0% |
| blitz | 1000 | recapture | 166 | 1.40 | 1.30 | 1.50 | 1.45 | 10% | 11% | 15% | 14% |
| blitz | 1000 | ordinary | 1721 | 2.70 | 1.80 | 2.50 | 2.50 | 2% | 0% | 0% | 0% |
| blitz | 1400 | book | 247 | 1.10 | 1.60 | 1.20 | 1.20 | 9% | 1% | 1% | 1% |
| blitz | 1400 | recapture | 168 | 1.35 | 1.20 | 1.50 | 1.35 | 15% | 12% | 17% | 17% |
| blitz | 1400 | ordinary | 1746 | 2.40 | 1.70 | 2.50 | 2.50 | 2% | 0% | 0% | 0% |
| blitz | 1800 | book | 233 | 0.90 | 1.30 | 1.00 | 1.00 | 9% | 1% | 2% | 2% |
| blitz | 1800 | recapture | 179 | 1.20 | 1.10 | 1.30 | 1.30 | 24% | 15% | 23% | 24% |
| blitz | 1800 | ordinary | 1810 | 2.20 | 1.40 | 2.70 | 2.70 | 4% | 0% | 0% | 0% |
| blitz | 2200 | book | 539 | 1.00 | 1.20 | 1.10 | 1.10 | 9% | 0% | 2% | 2% |
| blitz | 2200 | recapture | 349 | 1.00 | 1.10 | 1.00 | 0.90 | 30% | 13% | 30% | 31% |
| blitz | 2200 | ordinary | 3767 | 2.40 | 1.20 | 2.40 | 2.40 | 4% | 1% | 0% | 0% |
| blitz | 2600 | book | 678 | 1.00 | 1.20 | 1.10 | 1.10 | 11% | 1% | 3% | 3% |
| blitz | 2600 | recapture | 295 | 1.00 | 1.10 | 0.80 | 0.80 | 33% | 17% | 34% | 35% |
| blitz | 2600 | ordinary | 3359 | 2.10 | 1.20 | 2.10 | 2.20 | 5% | 0% | 1% | 1% |
| blitz | 3000 | recapture | 305 | 0.30 | 1.10 | 0.60 | 0.45 | 49% | 17% | 42% | 46% |
| blitz | 3000 | ordinary | 3629 | 1.70 | 1.20 | 1.50 | 1.70 | 5% | 0% | 0% | 0% |
| rapid:600 | 600 | book | 150 | 2.20 | 3.40 | 3.40 | 3.40 | 1% | 0% | 0% | 0% |
| rapid:600 | 600 | recapture | 143 | 2.10 | 2.50 | 2.90 | 3.45 | 8% | 11% | 4% | 5% |
| rapid:600 | 600 | ordinary | 1510 | 5.20 | 3.10 | 7.80 | 7.75 | 1% | 0% | 0% | 0% |
| rapid:600 | 1000 | book | 251 | 1.70 | 2.50 | 2.80 | 3.00 | 5% | 0% | 1% | 0% |
| rapid:600 | 1000 | recapture | 176 | 1.90 | 2.20 | 3.00 | 3.00 | 6% | 8% | 6% | 6% |
| rapid:600 | 1000 | ordinary | 1562 | 4.10 | 2.80 | 6.90 | 6.90 | 1% | 0% | 0% | 0% |
| rapid:600 | 1400 | book | 238 | 2.10 | 2.00 | 2.60 | 3.00 | 0% | 0% | 1% | 1% |
| rapid:600 | 1400 | recapture | 183 | 2.60 | 1.70 | 3.50 | 3.55 | 4% | 14% | 6% | 5% |
| rapid:600 | 1400 | ordinary | 1550 | 5.20 | 2.00 | 7.70 | 7.70 | 0% | 0% | 0% | 0% |
| rapid:600 | 1800 | book | 276 | 1.60 | 1.80 | 2.70 | 2.70 | 2% | 0% | 1% | 1% |
| rapid:600 | 1800 | recapture | 168 | 2.10 | 1.70 | 2.70 | 2.70 | 10% | 9% | 12% | 11% |
| rapid:600 | 1800 | ordinary | 1622 | 5.30 | 2.00 | 6.40 | 6.40 | 2% | 1% | 0% | 0% |
| rapid:600 | 2200 | book | 352 | 1.70 | 1.60 | 1.90 | 1.90 | 6% | 1% | 2% | 2% |
| rapid:600 | 2200 | recapture | 168 | 2.00 | 1.60 | 1.60 | 1.60 | 23% | 19% | 28% | 26% |
| rapid:600 | 2200 | ordinary | 1923 | 5.40 | 1.70 | 6.10 | 6.10 | 3% | 0% | 0% | 0% |
| rapid:600 | 2600 | book | 442 | 1.50 | 1.60 | 1.50 | 1.55 | 4% | 0% | 3% | 3% |
| rapid:600 | 2600 | recapture | 196 | 0.80 | 1.60 | 0.80 | 0.90 | 42% | 15% | 44% | 41% |
| rapid:600 | 2600 | ordinary | 2273 | 4.30 | 1.60 | 4.40 | 4.40 | 2% | 0% | 0% | 0% |
| rapid:600+5 | 600 | book | 252 | 3.20 | 3.00 | 3.45 | 3.45 | 2% | 0% | 1% | 1% |
| rapid:600+5 | 600 | recapture | 125 | 3.40 | 2.40 | 2.75 | 3.10 | 4% | 8% | 4% | 4% |
| rapid:600+5 | 600 | ordinary | 1335 | 8.90 | 2.90 | 7.10 | 7.10 | 0% | 0% | 0% | 0% |
| rapid:600+5 | 1000 | book | 241 | 2.90 | 2.60 | 2.80 | 2.80 | 0% | 0% | 0% | 0% |
| rapid:600+5 | 1000 | recapture | 154 | 3.05 | 2.30 | 2.80 | 2.90 | 3% | 12% | 5% | 5% |
| rapid:600+5 | 1000 | ordinary | 1435 | 9.30 | 2.80 | 7.10 | 7.10 | 0% | 0% | 0% | 0% |
| rapid:600+5 | 1400 | book | 29 | 3.40 | 2.00 | 2.50 | 2.80 | 0% | 0% | 0% | 0% |
| rapid:600+5 | 1400 | ordinary | 87 | 9.60 | 2.10 | 10.05 | 10.05 | 0% | 0% | 0% | 0% |
| rapid:600+5 | 1800 | book | 31 | 2.30 | 1.70 | 3.85 | 4.00 | 3% | 0% | 0% | 0% |
| rapid:600+5 | 1800 | ordinary | 193 | 7.30 | 2.60 | 7.30 | 7.30 | 1% | 1% | 0% | 0% |
| rapid:600+5 | 2200 | ordinary | 75 | 6.60 | 2.50 | 14.05 | 13.90 | 0% | 1% | 1% | 1% |
| rapid:900+10 | 600 | book | 72 | 2.55 | 3.30 | 2.95 | 2.95 | 0% | 0% | 0% | 0% |
| rapid:900+10 | 600 | recapture | 73 | 4.00 | 2.50 | 2.40 | 2.80 | 0% | 9% | 5% | 6% |
| rapid:900+10 | 600 | ordinary | 972 | 9.65 | 3.00 | 6.30 | 6.30 | 1% | 0% | 0% | 0% |
| rapid:900+10 | 1000 | book | 138 | 3.40 | 2.30 | 2.90 | 3.10 | 1% | 0% | 0% | 0% |
| rapid:900+10 | 1000 | recapture | 73 | 4.00 | 2.20 | 2.90 | 2.90 | 3% | 10% | 5% | 5% |
| rapid:900+10 | 1000 | ordinary | 566 | 10.35 | 2.60 | 7.45 | 7.45 | 1% | 0% | 0% | 0% |
| rapid:900+10 | 1400 | book | 273 | 2.90 | 2.00 | 2.70 | 3.00 | 2% | 0% | 1% | 0% |
| rapid:900+10 | 1400 | recapture | 173 | 3.30 | 1.90 | 3.30 | 3.30 | 6% | 13% | 6% | 5% |
| rapid:900+10 | 1400 | ordinary | 1507 | 13.90 | 2.30 | 9.70 | 9.80 | 1% | 0% | 0% | 0% |
| rapid:900+10 | 1800 | book | 291 | 3.80 | 1.80 | 2.80 | 2.80 | 2% | 1% | 1% | 1% |
| rapid:900+10 | 1800 | recapture | 125 | 5.30 | 1.80 | 3.90 | 3.90 | 3% | 10% | 9% | 8% |
| rapid:900+10 | 1800 | ordinary | 1314 | 15.40 | 2.50 | 9.90 | 10.00 | 0% | 0% | 0% | 0% |
| rapid:900+10 | 2200 | book | 33 | 6.00 | 1.70 | 4.05 | 4.20 | 0% | 0% | 2% | 1% |
| rapid:900+10 | 2200 | ordinary | 138 | 14.65 | 2.20 | 17.55 | 17.75 | 0% | 1% | 0% | 0% |

Full quantile tables with bootstrap intervals, CRPS, KS and AUC for every cell are in
`data/timing/calib/verify/crossfit/<run>.md`.

## Safety checks

### Clock (closed loop: the bot on its own clock, holdout)

Replayed 2 chains per holdout side on the bot's own clock. "Before" is main; "after" is the shipped
table. Spend is the bot's total think over the humans' on the same moves; the final clock is a
fraction of the base.

| tc | band | sides | flagged: human / before / after | spend bot ÷ human: before / after | final clock q10: human / before / after | q50: human / before / after | q90: human / before / after |
|---|---|---|---|---|---|---|---|
| bullet | 600 | 60 | 3.3% / 0.0% / 0.0% | 0.67 / 0.89 | 0.01 / 0.28 / 0.13 | 0.17 / 0.51 / 0.32 | 0.53 / 0.74 / 0.56 |
| bullet | 1000 | 60 | 3.3% / 0.0% / 2.5% | 0.78 / 0.94 | 0.01 / 0.23 / 0.11 | 0.14 / 0.41 / 0.24 | 0.68 / 0.73 / 0.53 |
| bullet | 1400 | 60 | 10.0% / 1.7% / 8.3% | 0.82 / 0.94 | 0.00 / 0.07 / 0.02 | 0.09 / 0.32 / 0.21 | 0.46 / 0.59 / 0.45 |
| bullet | 1800 | 60 | 10.0% / 2.5% / 8.3% | 0.86 / 0.96 | 0.00 / 0.06 / 0.02 | 0.10 / 0.28 / 0.17 | 0.52 / 0.54 / 0.40 |
| bullet | 2200 | 120 | 4.2% / 6.3% / 7.5% | 0.95 / 1.07 | 0.00 / 0.06 / 0.02 | 0.20 / 0.28 / 0.17 | 0.61 / 0.59 / 0.44 |
| bullet | 2600 | 120 | 11.7% / 6.3% / 10.4% | 0.92 / 1.01 | 0.00 / 0.04 / 0.00 | 0.14 / 0.27 / 0.19 | 0.56 / 0.62 / 0.53 |
| bullet | 3000 | 56 | 0.0% / 16.1% / 15.2% | 1.09 / 1.11 | 0.04 / 0.00 / 0.00 | 0.30 / 0.23 / 0.23 | 0.65 / 0.51 / 0.51 |
| blitz | 600 | 60 | 0.0% / 0.0% / 0.8% | 0.65 / 0.94 | 0.01 / 0.36 / 0.05 | 0.26 / 0.59 / 0.36 | 0.71 / 0.81 / 0.69 |
| blitz | 1000 | 60 | 0.0% / 0.0% / 2.5% | 0.75 / 0.98 | 0.02 / 0.29 / 0.04 | 0.41 / 0.56 / 0.45 | 0.71 / 0.81 / 0.72 |
| blitz | 1400 | 60 | 0.0% / 0.0% / 0.0% | 0.71 / 0.95 | 0.06 / 0.41 / 0.09 | 0.37 / 0.62 / 0.50 | 0.76 / 0.90 / 0.81 |
| blitz | 1800 | 60 | 1.7% / 0.0% / 1.7% | 0.61 / 0.94 | 0.01 / 0.37 / 0.09 | 0.27 / 0.59 / 0.30 | 0.73 / 0.87 / 0.80 |
| blitz | 2200 | 120 | 4.2% / 0.0% / 5.0% | 0.64 / 0.97 | 0.00 / 0.26 / 0.02 | 0.17 / 0.54 / 0.25 | 0.63 / 0.83 / 0.67 |
| blitz | 2600 | 120 | 4.2% / 0.0% / 3.8% | 0.64 / 0.98 | 0.02 / 0.26 / 0.04 | 0.18 / 0.56 / 0.26 | 0.72 / 0.78 / 0.64 |
| blitz | 3000 | 48 | 2.1% / 0.0% / 4.2% | 0.69 / 1.02 | 0.03 / 0.27 / 0.03 | 0.16 / 0.53 / 0.20 | 0.67 / 0.80 / 0.61 |
| rapid:600 | 600 | 60 | 1.7% / 0.0% / 2.5% | 0.78 / 1.24 | 0.17 / 0.42 / 0.13 | 0.57 / 0.71 / 0.52 | 0.82 / 0.88 / 0.78 |
| rapid:600 | 1000 | 60 | 0.0% / 0.0% / 3.3% | 0.77 / 1.48 | 0.07 / 0.39 / 0.02 | 0.56 / 0.67 / 0.36 | 0.90 / 0.88 / 0.81 |
| rapid:600 | 1400 | 60 | 1.7% / 0.0% / 0.0% | 0.45 / 1.29 | 0.13 / 0.61 / 0.04 | 0.57 / 0.81 / 0.43 | 0.88 / 0.91 / 0.76 |
| rapid:600 | 1800 | 60 | 1.7% / 0.0% / 2.5% | 0.44 / 1.00 | 0.02 / 0.60 / 0.08 | 0.49 / 0.78 / 0.50 | 0.80 / 0.90 / 0.77 |
| rapid:600 | 2200 | 60 | 1.7% / 0.0% / 2.5% | 0.39 / 1.02 | 0.01 / 0.48 / 0.01 | 0.25 / 0.74 / 0.26 | 0.64 / 0.88 / 0.65 |
| rapid:600 | 2600 | 51 | 3.9% / 0.0% / 7.8% | 0.42 / 0.92 | 0.01 / 0.47 / 0.01 | 0.15 / 0.66 / 0.24 | 0.51 / 0.82 / 0.55 |
| rapid:600+5 | 600 | 28 | 0.0% / 0.0% / 0.0% | 0.43 / 0.70 | 0.19 / 0.78 / 0.57 | 0.57 / 0.97 / 0.76 | 0.89 / 1.05 / 0.94 |
| rapid:600+5 | 1000 | 60 | 0.0% / 0.0% / 0.0% | 0.43 / 0.71 | 0.08 / 0.83 / 0.48 | 0.56 / 0.97 / 0.83 | 0.96 / 1.06 / 0.96 |
| rapid:900+10 | 600 | 27 | 0.0% / 0.0% / 0.0% | 0.48 / 0.72 | 0.63 / 1.04 / 0.93 | 0.95 / 1.15 / 1.05 | 1.12 / 1.35 / 1.24 |
| rapid:900+10 | 1000 | 19 | 0.0% / 0.0% / 0.0% | 0.30 / 0.61 | 0.27 / 1.08 / 0.77 | 0.63 / 1.21 / 0.99 | 1.09 / 1.39 / 1.15 |
| rapid:900+10 | 1400 | 60 | 0.0% / 0.0% / 0.0% | 0.21 / 0.66 | 0.09 / 1.09 / 0.40 | 0.57 / 1.21 / 0.90 | 0.98 / 1.44 / 1.13 |
| rapid:900+10 | 1800 | 60 | 0.0% / 0.0% / 0.0% | 0.27 / 0.70 | 0.06 / 1.06 / 0.37 | 0.56 / 1.17 / 0.85 | 1.01 / 1.32 / 1.04 |

Blitz and rapid now spend what the humans spend: main spent 40–78 %, which is where its surplus
final clock came from. They flag at the humans' rate within a few percentage points (rapid 10+0
2600: 7.8 % against 3.9 %, n = 51). Bullet flags at or below the humans' rate from 600 to 2600. At
3000+ it flags 15 % (main 16 %) against the humans' 0 %: the floor, see Limitations.

### The fast-reply cap does not change the move (`cap-check.ts`)

For positions where the rule applies, the engine searched each one twice with the vendored
Stockfish, at the capped and at the full movetime (×3 for Bun's single thread), at the production
MultiPV and depth. Book verdicts (the trap check and the mate/conversion guards) differed on
**1 of 316**. For recaptures, the best move differed on 31 of 500, but the full search rejected the
pondered recapture (more than 45 cp worse) that the capped search kept on only **3 of 500
(0.6 %)**. Per class and band, the rejection rate is 0–4 % (n = 25 each). Not measured: Maia's
answer arriving after a capped deadline. The book answer and the pondered recapture are decided
before the search, so this matters only where Maia would have played something else.

### Queued trade premoves: executed vs dropped (`premove-outcomes.ts`)

Per 100 opponent turns, the number of queued (site) trade premoves the shipped rates enter, and
what became of them when the opponent's recorded move landed:

| tc | band | opponent turns | entered / 100 turns | executed (predicted capture) | executed (another capture on the square) | dropped by the site |
|---|---|---|---|---|---|---|
| blitz | 1000 | 4212 | 2.2 | 47% | 0% | 53% |
| blitz | 1400 | 4172 | 2.5 | 50% | 4% | 47% |
| blitz | 1800 | 4424 | 4.7 | 42% | 2% | 56% |
| blitz | 2200 | 10054 | 5.0 | 44% | 2% | 55% |
| blitz | 2600 | 9984 | 5.8 | 45% | 1% | 54% |
| blitz | 3000 | 4354 | 7.5 | 47% | 0% | 53% |
| blitz | 600 | 4176 | 2.3 | 39% | 2% | 59% |
| bullet | 1000 | 3834 | 5.0 | 47% | 2% | 52% |
| bullet | 1400 | 4660 | 5.3 | 42% | 0% | 58% |
| bullet | 1800 | 4602 | 6.6 | 44% | 1% | 55% |
| bullet | 2200 | 9420 | 7.4 | 41% | 1% | 58% |
| bullet | 2600 | 9984 | 8.3 | 41% | 0% | 59% |
| bullet | 3000 | 4504 | 8.5 | 43% | 1% | 56% |
| bullet | 600 | 3360 | 5.0 | 35% | 1% | 64% |
| rapid | 1000 | 10000 | 0.8 | 48% | 2% | 49% |
| rapid | 1400 | 8936 | 1.2 | 59% | 1% | 40% |
| rapid | 1800 | 8746 | 1.7 | 42% | 1% | 57% |
| rapid | 2200 | 5656 | 4.4 | 36% | 1% | 63% |
| rapid | 2600 | 5448 | 4.7 | 47% | 1% | 52% |
| rapid | 600 | 7870 | 0.7 | 36% | 0% | 64% |

A dropped premove is chess.com's ordinary premove cancellation: the piece returns to its square the
moment the opponent's move lands. Premoves are client-side and never shown to the opponent. The
edge cases are pinned in `test/core/strength/premove-queue-edges.test.ts`:

- another piece captures on the square: the recapture stays legal and is still the proven-safe
  exchange;
- the capture gives check: the recapture takes the checker;
- a quiet check or any non-capturing reply: the premove becomes illegal and is dropped;
- en passant: never queued, because the landing square holds none of our pieces;
- a capturing promotion: we take back the promoted piece, and a non-capturing promotion drops the
  premove.

### Tests

The model's own clock-budget replay (`test/core/timing/blitz-clock-budget.test.ts`) replays
complete PGN games at 2400 through the shipped band, now with the timed-move row, `priorFen` and
the book flag the session supplies. With the shipped table:
- 3+0: 125 s left at move 20 (≥ 90 required), 67 s at move 30, 0 flags. The middle window
  (85–55 % of the clock) has median 3.3 s (humans 2.3 s), 8.9 % under 1 s (human envelope
  6.7–34.9 %) and 11.5 % over 10 s (envelope 2.9–19.4 %).
- 10+0: 164 s at move 40, inside the humans' interquartile range 66.9–241 s.

With the timed-move row and the old budget the long-think share was 0.017 (below the envelope). The
fine-tuned band's own sample (budget power 0) brings it inside. `calibration-replay.test.ts` pins
2600–2999 blitz holdout sides from frozen frames: book and recapture medians within ln 0.3 of the
humans' and closer than main, and the recapture premove share within 15 points.

Mechanics tests pin the identity table (`test/fakes/timing-calibration.ts`), as the Maia calibration
does. These are `premove-queued`, `slow-search-release` and `opponent-pressure-timing`: their heads
are fixtures, and they test queue and deadline mechanics at the strength propensities.
`premove-calibrated.test.ts` checks that the calibrated rate reaches the session's premove path:
with rate 0 no premove is entered, and with rate 1 the pre-decided recapture is entered during the
opponent's turn. `bun run check` is green.

## Limitations

- **Book premoves.** Humans premove 22–39 % of bullet book moves and 4–15 % of blitz ones. The
  session only queues self-invalidating premoves (safe recaptures, the only move), so the bot's
  book moves are floored at preparation + the hand: about 0.7–0.9 s in bullet. Under 0.2 s is
  unreachable without queueing moves that fire on any reply.
- **Bullet 3000+ flagging.** This is inherited from the floor, not the calibration. The bot cannot
  make its many sub-half-second ordinary replies without premoving them. The calibrated table
  reduces the closed-loop flag rate from main's; see the clock table.
- **The latency model is a model.** Transport (30 ms), preparation overhead (25 ms), the cache-hit
  rule, and the arming time (340 ms) are assumptions. The hand's numbers are `hover`'s simulation,
  not browser measurements.
- **Frames.** The frames are depth 8, MultiPV 4, small net. Production lines are deeper and wider
  (hence power 0 where it wins).
- The Maia premove gate (H8) and Maia's openings below 1700 are not replayed. The book flag is the
  human move's membership in the bot's book.
- **Paired design.** The bot plays the human's moves and positions. The closed-loop check puts it
  on its own clock but still in the human's game.
- **Corpus size.** The corpus is 10.8 k games; bands with few players have wide intervals (see
  the per-cell intervals). The timing crawl (about 272 k games, `data/timing/crawl/`, with kept-side
  caps) was not used for this fit. `build_corpus.py --no-fens` reads it (the `kept` flag is carried
  and honoured by the statistics), and refitting on it is the next step.
- The recapture premove share is still below the humans' at bullet 2600+ (35–46 % against
  44–66 %). The rate is at its ceiling (0.9–0.99 attempts): the prediction must name the reply,
  and the opponent must think long enough for the entry.

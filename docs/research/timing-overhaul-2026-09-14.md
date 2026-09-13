# Timing overhaul: rating, recognition, and a clock that lasts

The 97-game export demonstrates a spending problem, particularly in the current 3+0 regime.
The 27-game window at ratings 2401–2452 contains eight losses on time. In the middle clock band,
our median move consumed 6.0 seconds versus the opponents' 2.8 seconds. These are observations
from this account and its opponents, not estimates for all players at those ratings.

## What the earlier attempt missed

The previous change added higher-rated checkpoints, a clock-fraction fast-move floor, and more
low-clock multipliers. It improved some simulated clocks, but the resulting policy contained
separate own-clock compression, relative urgency, another early low-clock multiplier, a second
late low-clock multiplier, book/forced/threat shortcuts, and clock equalization. ChessMimic did
not consume the allocation passed to it. A per-move cap was the main link between spending and
the rest of the game; its remaining-move horizon eventually shrank to ten moves simply because
many moves had already been played.

Other issues affected the diagnosis and validation:

- The absence of latency on the fastest observed move cannot rule out latency on uncached turns.
  The service now accounts for policy preparation and searches within one turn deadline.
- The old acceptance simulator chose random legal moves, attached unrelated evaluation lines,
  stopped after 40 moves, and compared its distribution with real 2400-rated games.
- An early engine best move was marked as memorized theory even without a book hit.
- A single strong engine move was always treated as an obvious human reply, including tactics
  that require discovery.
- Global fast-move quotas and coefficient-of-variation resampling changed the model's conditional
  distribution to satisfy population-level statistics.
- Most requested ratings below 1200 were silently represented by a 1200–1300 checkpoint.

## One clock budget, several reasons to spend it

`budgetController` divides available time by a rolling material-based horizon, reserves a buffer,
and adds 80% of the increment once. The horizon never falls below 24 future own moves merely
because a game is long. Available clock already provides spending feedback; the inconsistent
schedule-ratio multiplier was removed.

`createMoveBudget` gives that allocation a position-specific weight. Confirmed theory, predicted
replies, a sole legal move, a clear recapture, and an answered material threat support recognition.
Several plausible choices, an unexpected evaluation change, promotion, and a difficult sole
engine continuation support deliberation. Missing analysis is uncertainty, not evidence that only
one choice exists. Recognition signals combine through their strongest applicable signal rather
than successive discounts. Complex positions can use a larger burst of the available budget.

The model retains the learned distribution and its within-game correlation. Normal and long
samples are scaled down when their distribution mean exceeds the position's allocation; a large
remaining clock does not force a learned quick decision to take longer. This uses the mean of the
masked empirical buckets, including the residual multiplier, rather than budgeting a heavy tail
from its median. Actual plans still include the physical hand, recognition limits, emergency
caps, and opponent time-pressure policy. Recognition limits never shorten an otherwise affordable
sampled gesture. The user speed control and budget setting retain their respective roles.

The old fast quota/floor, book multiplier, clock-equalization term, duplicate low-clock controls,
and global CV resampling were removed, together with their unused registry knobs. Telemetry may
measure variability; it no longer changes the sampling distribution to obtain it.

## What changes with rating

These are bounded engineering priors, linearly interpolated between rows, **not fitted population
measurements**. They describe separate abilities; there is no blanket rule that a higher rating
must play every move faster or slower. The learned checkpoints provide additional position and
rating information.

| Requested Elo | Recognition | Selectivity for complexity | Clock discipline |
|---:|---:|---:|---:|
| 400 | 0.12 | 0.20 | 0.35 |
| 800 | 0.22 | 0.30 | 0.43 |
| 1200 | 0.38 | 0.43 | 0.53 |
| 1600 | 0.56 | 0.59 | 0.65 |
| 2000 | 0.74 | 0.75 | 0.77 |
| 2400 | 0.86 | 0.89 | 0.86 |
| 2800 | 0.92 | 0.97 | 0.91 |
| 3200 | 0.94 | 1.00 | 0.93 |
| 3800 | 0.95 | 1.00 | 0.94 |

Lower ratings have less recognition of a confirmed pattern, less contrast between routine and
difficult decisions, and greater permissible early overspending. Advanced players bank more
time on familiar replies while preserving room for difficult decisions. Improvements saturate
at the extreme upper end. The 3500–3800 settings do not claim a measured human timing population;
the learned top checkpoint saturates at its training limit.

The added upstream `0_1000` model supplies genuine novice-range conditioning. Band selection
first chooses a checkpoint containing the requested rating and fills only uncovered gaps by
nearest fitted population mean. The novice checkpoint has different bucket edges: its first
bucket spans two seconds. Decoding, clock masking, and mean calculation now use the responding
checkpoint's schema; its one-to-two-second mass is not converted into an instant move.

## Evidence and remaining uncertainty

Sigman et al. found phase-dependent, long-tailed response times and correlations across successive
moves. This supports retaining distribution shape and history, rather than imposing uniform delays
or an independent distribution at every move. It does not supply the exact Elo coefficients above.
[Original study](https://www.frontiersin.org/journals/neuroscience/articles/10.3389/fnins.2010.00060/full).

ChessMimic was trained on Lichess rated blitz and reports a useful but imperfect clock predictor.
Its clock conditioning includes remaining clocks and increment; it does not replace a complete
time-management policy for every starting time control. These results do not establish that
Lichess ratings and Chess.com ratings have identical timing distributions.
[ChessMimic paper](https://arxiv.org/html/2606.04473v1).

Core tests cover every rating knot, monotone clock allocation, continuity between knots,
recognition versus tactical discovery, increment preservation, model failures, per-band bucket
decoding, physical phases, and 110-move budget stress at 3+0, 5+0, 3+2, 10+5, and 30+0. That
synthetic stress test uses the parametric fallback head, not ONNX inference. A fixed finite clock
cannot guarantee an arbitrarily long game while retaining a physical move duration.

The revised real-model acceptance test replays complete recorded games with coherent Stockfish
frames and charges the search plus the fitted executor window. Distribution comparisons use
the human opponents in the same selected corpus, with sampling uncertainty. A broader PGN's
long-think rate is background context, not a mandatory rate for a smaller, different sample.
Its output is the reproducible source for replay metrics.

No new model was trained. The demonstrated failures concern conditioning, allocation, decoding,
and pipeline accounting, for which more parameters would not provide a direct remedy. Population
calibration across rating and time-control combinations still needs held-out human game data.

## Cross-rating real-model clock safety diagnostic

A separate diagnostic replayed all 112 legal plies of corpus game 2 (56 own moves) at each
rating below, with seed 0 and balanced defaults. It used the bundled ONNX Runtime WASM engine
under Bun, the real six-band models, and the recorded coherent Stockfish frames. Each turn
charged the full `ownMoveBudget` preparation ceiling plus the remaining `fitTiming` executor
window. Clock expiry was checked before adding increment. The opponent's recorded clock was
scaled to the target starting clock, with cumulative increment added. This is a constructed
safety sweep, not a replay of actual human clock behavior at the substituted controls or ratings.

All 45 combinations completed without flagging: 2,394 real model queries and 126 intentional
clock-race bypasses, in 105.7 seconds. Remaining clock after own move 56, in seconds:

| Elo | 1+0 | 3+0 | 3+2 | 10+0 | 30+0 |
|---:|---:|---:|---:|---:|---:|
| 400 | 10.5 | 38.4 | 65.3 | 155.8 | 1257.8 |
| 800 | 7.9 | 36.5 | 64.2 | 203.0 | 1185.2 |
| 1200 | 7.9 | 45.6 | 67.6 | 310.7 | 1349.8 |
| 1600 | 10.4 | 55.4 | 51.9 | 460.9 | 1465.7 |
| 2000 | 7.5 | 35.4 | 70.7 | 352.2 | 1416.2 |
| 2400 | 7.9 | 46.5 | 46.0 | 403.1 | 1490.3 |
| 2800 | 7.9 | 34.0 | 76.8 | 343.6 | 1436.8 |
| 3200 | 10.7 | 73.8 | 204.3 | 478.7 | 1634.6 |
| 3800 | 9.3 | 36.9 | 92.7 | 436.3 | 1629.2 |

This verifies the model paths and finite-game clock accounting across the supported range. It
does not validate population realism: every cell uses the same expert moves, only one seed, and
no live browser transport latency. The large unused 30+0 clocks also expose the limitation of a
blitz-trained distribution used outside its training control. The budget does not force those
samples to consume spare time; rapid and classical human pacing require held-out data before
claiming calibration. The matched 3+0 replay remains the relevant human-distribution comparison.

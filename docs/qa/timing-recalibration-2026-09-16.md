# Opponent clock pressure: timing recalibration

Settings: fixed 2500 target, Base speed 1.0×, Match opponent rating disabled.
Baseline: `7a81c5d`. Source: the owner's `chess_com_games_2026-09-16.pgn`.

## Diagnosis

The 14 games are all 3+0; opponents average 2345 (range 2231–2456). The bot wins
12 and loses two, and leads on the last recorded clock in nine games. Its mean
move time on moves 11–30 is 3.43 seconds, versus 4.65 for its opponents.
An exploratory full-strength Stockfish analysis finds almost identical means
in approximately equal positions (3.56 versus 3.61 seconds), but a larger gap
when the bot is winning by at least three pawns (3.56 versus 5.43 seconds).
These position groups are descriptive, not causal estimates or precise strength
measurements. Advantage and opponent strength help explain the clocks; the PGN
does not support a blanket slowdown of every 2500 move.

There is nevertheless a concrete policy defect: when only the opponent falls
below ten seconds, `TimingModel` skips learned inference and replaces every
position's sampled time with a short uniform reply window. This also selects
emergency hand execution even with ample time on our clock. Separately, normal
ChessMimic samples already condition on both clocks, but the policy applies a
second opponent-pressure speedup of up to 45% afterward.

## Changes

- Preserve learned preparation, position-dependent thinking and normal hand
  execution when only the opponent is in time trouble.
- Mark learned samples as opponent-clock-conditioned and omit the duplicate
  pressure multiplier. Parametric fallback retains its gradual speedup.
- Allow the usual bounded 100 ms timing-inference window when an opponent-only
  rush shortens engine search to 30–70 ms. Normal searches retain their existing
  inference allowance; engine search deadlines are unchanged.
- Retain our own emergency execution, lone-king timing, clock reserves and
  strength-selection rules. No Elo target, model weights or global speed factor
  changed.

## Matched-position comparison

The owner's September 13, 14 and 16 PGNs were deduplicated, then filtered to
3+0 human opponents rated at least 2200, after their first two moves, with more
than 30 seconds remaining and the bot below ten seconds. There are 104 positions
from 17 games. Six lone-king positions keep their separate fast policy, leaving
98 positions from 16 games for the comparison below.

Replays use recorded moves and clocks, full-network Stockfish 19 MultiPV frames
(depth 12 / 120 ms limit), native ChessMimic ONNX inference and eight seeded
personas per position. Estimated charged time is the greater of the plan and
50 ms preparation plus its reserved hand motion. All 784 applicable new samples
used ChessMimic; the old policy bypassed it.

| Metric | Before | After | Recorded humans |
| --- | ---: | ---: | ---: |
| Median seconds | 0.52 | 1.04 | 1.60 |
| Mean seconds | 0.53 | 1.50 | 2.62 |
| Replies below one second | 100% | 48.0% | 19.4% |
| Replies above three seconds | 0% | 10.1% | 20.4% |

This removes the artificial all-subsecond regime and restores a thinking tail.
The model is still faster than this small human cohort. These are independently
sampled recorded positions, not complete games or a held-out calibration study.
The comparison lacks live recognition, cache and transport telemetry and does
not establish Chess.com timing parity.

Follow-up uncertainty check: the bot's median is faster in 14 of those 16 games.
Resampling paired whole games 20,000 times (seed 160926), keeping all positions
and their eight model draws together, gives a percentile 95% interval of
0.24–1.00 seconds for human median minus simulated bot median. Leaving out any
single game keeps the gap positive at 0.46–0.76 seconds. This supports a
consistent speed bias in this selected cohort; it does not account for selection
bias, repeat players, or error in estimated browser overhead. The 784 model
draws are not 784 independent human observations. These humans are rated
2220–2442 and the matched-position model uses each human's rating.

The remaining clock-budget compression is a concrete tuning candidate: learned
samples have a raw median of 2.10 seconds, and the median budget multiplier is
0.47 on the duration above the physical lower endpoint. Final charged median
is 1.04 seconds after all timing policy. This is evidence about the current
calculation, not proof that removing the budget would safely match human clocks.
Statistics are retained in the diagnostic folder as `pressure-gap-statistics.json`.

## Clock safety and execution

Four games from the latest PGN (indices 3, 11, 12, 13: 39, 78, 32, 57 bot moves)
were replayed twice per version at fixed 2500 with actual ONNX inference. Our
clock rolls forward from the model's charged time; opponent clocks and moves
remain recorded. Full-network Stockfish 19 supplies MultiPV6 frames with a
depth-12 / 100 ms limit. Charges include the existing search budget, the bounded
timing window and reserved hand motion. There were no flags in either version's
eight runs. The updated 78-move replays finished with 18.1 and 15.2 seconds;
the other runs finished with 24.5–103.5 seconds. This is a timing simulation,
not a replay of actual browser latency or future opponent responses.

The existing native-inference clock-budget suite also passes its 16 blitz and
16 rapid replays without flags. Ordinary-clock calibration metrics are unchanged.
Focused regression coverage checks normal multi-frame execution under opponent
pressure, actual charged time, our own sub-250 ms emergency behavior, inference
finishing after a short search, cancellation, and existing strength/search limits.

`bun run check` passes: 3,305 tests across 340 files, zero failures, plus lint,
type checking and generated-source/constants checks.

Diagnostic scripts, native inference output, source hashes and replay results
are retained locally in `.scratch/timing-recalibration-2026-09-16/` (ignored).
Run `bun .scratch/timing-recalibration-2026-09-16/sliced-pressure-compare.ts
.scratch/timing-recalibration-2026-09-16/sliced-pressure-with-inference.json` to
repeat the seeded matched-position comparison using its cached distributions.
Run `bun .scratch/timing-recalibration-2026-09-16/sliced-latest-clock-replay.ts`
to repeat the full-game timing simulation with fresh native inference.

No personal Chrome session was operated. Native browser validation remains
unperformed; no claim is made that a build alone verifies live game behavior.

## Release artifact

- `bun run build` passes, including distribution verification and packaging.
- `release/sliced-2.0.0.zip`: 315,481,687 bytes; 84 files.
- SHA-256: `8565889e480da41661c664fd5d32ef888589458fb15441e4d5f1bf0b5655c69e`.
- ZIP CRC passes; all archived files match the rebuilt `dist/` byte for byte.
- Changes remain local and uncommitted.

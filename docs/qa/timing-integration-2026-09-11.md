# Ordinary move pacing investigation — 2026-09-11

The reported setup was approximately 1650, Balanced, opponent matching, and 3+0.
The complaint concerned ordinary moves arriving faster than the opponent's and
frequent wins on time. Neither a hand-duration average nor the result mix alone
establishes that the timing distribution needs retraining.

## Confirmed integration defects

The production recommendation pipeline never called `TimingModel.prepare()`.
Warming a ChessMimic band only loads the inference runtime; the timing head needs
per-position probabilities before `sample()`. Consequently, ordinary recommendations
always used the V1 fallback with the reason `not prepared`.

The pipeline now prepares timing inference alongside opening-book lookup and
engine search. Preparation uses the actual position, move history, active target
and both clocks. The selected move and searched alternatives are added before
sampling the plan. Inference can use the already-running engine search budget
(600 ms for the ordinary 3+0 case); when a search ends, any unfinished preparation
is cancelled. A cached or unusually quick search retains only the original 100 ms
window measured from preparation start. The urgent/lone-king bypass remains.
Cancellation cannot publish a newly prepared plan. Timeout still returns a
playable fallback recommendation and is explicitly diagnosable.

A separate feedback defect compared hand execution time with the entire planned
turn, even though the plan starts before analysis/setup. For example, a correctly
delivered 1.5-second turn with 600 ms of analysis could be reported as 900 ms, causing
an erroneous `ln(0.9/1.5)` adjustment to the model's pace residual. Session accounting
now measures turn-to-submission separately from hand execution. Physical input
telemetry retains its own duration. Manual acceleration reports the actual elapsed
time without teaching that shortcut as ordinary pace. Late observations target
the original game/ply; a prior game's receipt cannot alter the next game's state.

## Native model probe

The vendored `1500_1600` ONNX band was executed through the production
`onnxruntime-web` loader and timing inference host, with one runtime thread.
The requested target was 1650, clamped to the band's 1600 edge by the existing
upstream preprocessing. The probes used the start position, Ruy Lopez and Italian
positions with their full opening histories, and the tactical Kiwipete position.
Positions and searched alternatives came from
`test/fixtures/strength/stockfish18-blitz.json`. Kiwipete has no historical move
sequence and is only a tactical example, not a natural game sample.

Each cell sampled 300 plans over repeated fresh 40-move state blocks, with fixed
clocks, a seeded Balanced persona and normal speed. Correct feedback used the
planned turn duration. The faulty-feedback comparison subtracted 600 ms to model
omitted analysis/setup, with a 100 ms lower bound. This is a controlled defect
reproduction; it is not a measured opponent distribution or playing-strength test.

Mean planned seconds at 90 seconds on both clocks:

| Position | V1, faulty hand-only feedback | V1, correct feedback | Prepared ChessMimic, correct feedback |
| --- | ---: | ---: | ---: |
| Start | 1.12 | 1.31 | 1.75 |
| Ruy Lopez | 2.50 | 2.73 | 3.05 |
| Italian | 1.11 | 1.34 | 3.01 |
| Tactical Kiwipete | 1.56 | 1.67 | 5.09 |

The prepared model retains position-dependent variation. It is not uniformly
slower: at a full clock, the Ruy probe averaged 5.00 seconds versus 5.62 for V1 with
correct feedback. The opening remains quick. All samples still pass through the
existing physical floors, clock allocation caps and urgent policies.

An initial 24-query native sweep ran at 48.4 ms median and 90.5 ms maximum. A later
12-query run concurrent with heavy statistical tests ran at 177.9 ms median and
703.4ms maximum. The existing 100 ms head/port deadline can therefore cause fallback
under contention. A subsequent test put real ONNX inference in a separate process
from the service-side timer and native Stockfish. With one/four Stockfish threads,
all eight ONNX responses arrived in 116–377 ms while the 600 ms searches finished
in 601–643 ms. All eight missed the original 100 ms timeout. This established the
need for the search-aligned budget, without extending ordinary search duration.

The new diagnostics expose the actual head, band and fallback reason. These timing
measurements describe host load, not an ONNX accuracy discrepancy. The first
same-process probe was rejected as timeout evidence because native ONNX could
block the timer; a Bun nested-worker attempt stalled and was stopped. The ordinary
child-process probe and durable integration avoid both problems.

No model weights, global speed multipliers, presets, or clock-pressure constants
were retuned. The native model already responds to position and clocks; assessing
its game-wide pacing is only meaningful after it is actually called and elapsed
turns are measured correctly. No retraining or claimed human calibration was
performed.

## Validation

Targeted pipeline regressions verify concurrent preparation, consumption of the
prepared distribution, timeout fallback, cancellation and urgent bypass. Head
tests cover decoding, fallback, stale inference and clock masks. Observation
tests cover attribution and manual acceleration. The durable
`test/integration/strength-pipeline.test.ts` runs actual bundled ONNX in a separate
runtime process concurrently with native Stockfish through the production relay,
head and recommendation pipeline. Both positions produced a ChessMimic plan while
retaining the active 1650 native strength, twenty coherent candidates and 600 ms
search budget (25 assertions; initial run 5.28 s). The complete model statistical
suite was initially interrupted after host load exceeded Bun's default 5-second
per-case timeout; those were timeout failures, not failed timing assertions. The
release task records its separate aggregate gate.

Local probe scripts and full distributions are retained under
`/tmp/sliced-pacing-audit/`: `probe.ts`, `compare.ts`, `native-results.json` and
`comparison.json`. `concurrent-process.ts` / `concurrent-process.json` contain the
independent-timer evidence. Run the durable native regression with
`bun test test/integration/strength-pipeline.test.ts` from the repository root.
No public game was played in this probe.

## Receipt accounting and feature ingestion

The service-to-executor regression holds engine search for 500 ms while a fixed
head plans a 4,000 ms turn. The piece is released at 4,000 ms from the original
recommendation timestamp, while the hand window lasts 3,500 ms. Previously the
model observed 3,500 ms and changed its pace residual from zero to approximately
−0.133531 (`ln(3500/4000)`) despite an on-time move. It now observes 4,000 ms and
leaves the residual unchanged. The later post-drop rest and verification are
excluded. Exported `actualMs` is turn-to-submission; `executionMs` and the physical
`MoveHoldTime` retain the hand-window duration. The offline physical-hold report
prefers that execution field when its AC record is absent, and still accepts
older hand-only exports.

The timestamp tracks the promotion-picker release when a picker is used, the
original board drop for auto-queen, and a recovery release if an interrupted
committed touch is later verified as accepted. A manual Space acceleration or
retry records the actual duration without adapting the natural pace from it.
Receipt attribution retains the original game and authoritative snapshot ply,
including when a newer board event arrives before verification finishes.
The reactive-premove regression delays a real accepted terminal event across a
game replacement: the original row receives its duration and the replacement
model's think history remains empty. Captured timing provenance is independent
of whether the choice is eligible for search-quality statistics.

A separate controlled 3+0 feature test reports `tc=blitz`, `inc_s=0`, `clock_s=180`
and `base_eff=180`. A seven-second opponent turn becomes the expected
`ln(7 + oppPaceOffsetS)` feature; own/opponent clocks of 176/173 seconds produce
`ln(177/174)` after the defined one-second smoothing. These tests found no
milliseconds/seconds or normal-path time-control classification defect. They do
not establish that all live bridge updates arrive without coalescing or delay.

The focused checks cover three timing-observation cases, 41 hand-controller
cases (including promotion recovery), three full-session telemetry-conformance
cases, and an offline-report duration regression. Existing fast-forward,
verification-race and queued-premove regressions also passed. Timing aggregate
version 1 discards the old hand-only average independently of game/move counts
and quality statistics. Its mean is weighted by a separate measured-turn count;
queued premoves without turn-to-acceptance timing do not become hand-duration
samples. The sidebar shows no average until a corrected sample arrives, and its
tooltip reports the sample count and exclusions. Migration, persistence and
panel regressions cover this separation. No public match was used for these checks.

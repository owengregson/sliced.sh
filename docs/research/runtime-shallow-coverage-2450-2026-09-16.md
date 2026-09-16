# Target-2450 runtime shallow-coverage probe — 2026-09-16

The bounded offline probe does **not** support missing per-candidate shallow scores as the main
explanation for a strength regression. With exact cached Maia answers available to the actual
pipeline, **11/12 positions entered verification and every surviving candidate in those 11 had
a shallow score**. The remaining position missed the complete human-depth frame and used the
plain Maia draw. That whole-frame bypass is also present in the previous selector; restoring
the old per-candidate deep fallback would not change that branch.

There is a separate, concrete calibration concern: nominal target 2450 produced model queries
at **2220–2435**, mean **2355.58**, and selection/verification ratings at **2191–2428**, mean
**2318.58**. Clock/think context lowers the query rating; the selector then subtracts an
additional entropy/ambiguity penalty, **1–71 points**, mean **37**. These are actual conditioning
and decision parameters, not measurements of achieved playing Elo. This probe cannot establish
win rate against a 2200 opponent or justify a new Elo offset.

## Protocol and artifacts

- Twelve lexicographically first positions from the existing recognition audit's held-out
  2400 bucket; one position per game. The IDs were selected before new searches.
- Original PGN history and both clocks; target 2450, form 0, default mistake scale 1,
  balanced/hybrid, book disabled, fresh per-game selection state, no prior ponder state.
- Actual current `RecommendationPipeline`, `EngineController`, `UciEngine`, SF19 smallnet,
  two threads, and shipped Maia 79M. Bun uses the same-source plain-SIMD Stockfish build,
  not the extension's relaxed-SIMD binary.
- The ordinary planning budget was 600 ms. The cached-policy run spent part of it on the
  unrestricted anchor, then ran the shaped search with the remaining budget; its returned
  shaped-search budgets were 264–387 ms. These were ordinary runtime requests, not the
  earlier audit's generous depth/three-second searches.
- A V1 timing head supplied the existing offline harness's timing interface. This is a
  selection/search coverage probe, not a validation of learned timing or mouse execution.
- Diagnostic wrappers recorded actual selector and verifier arguments while calling the
  unchanged functions. The old distinct-candidate verifier and corrected verifier were then
  compared on **the same captured survivor/evidence sets**, using current common constants.
  This isolates the verifier change; it is not a replay of every historical production change.
- Corrected probabilities are analytic. Old probabilities use 20,000 seeded non-intuitive
  draws plus the exact intuition component per active position. No coefficients were fitted.

The [machine-readable report](runtime-shallow-coverage-2450-2026-09-16.json) contains summaries,
per-position distributions and source SHA-256s. None of the nine recorded source hashes changed
within either run. Detailed requests, engine frames and query answers remain in
`.scratch/runtime-coverage-2450-20260916/`; the diagnostic entry point is `probe.ts` there.

```sh
bun .scratch/runtime-coverage-2450-20260916/probe.ts
CACHED_POLICY=1 bun .scratch/runtime-coverage-2450-20260916/probe.ts
```

The second command requires the first run's captures and rejects any changed policy inputs.
It makes no new model queries and uses fresh actual-budget engine searches. There were 12
distinct positions and two bounded passes, not a new large calibration job. No production
files, user browser tabs, native Chrome or live extension state were changed.

## Why two passes are reported separately

The first pass ran warm Maia inference in the same Bun process as the controller. Inference
took approximately 287–414 ms and every preliminary search returned depth 0. This shares an
event loop in a way the extension's separate service/offscreen contexts do not. Its coverage
cannot be presented as a faithful browser runtime measurement.

The second pass returned the first pass's **exact-input-checked** policy answers immediately,
then used fresh SF19 searches. It isolates search coverage with an available policy. It also
does not establish browser performance or the frequency of policy availability in real games.

| Metric | Same-process inference | Exact cached policy |
|---|---:|---:|
| Positions | 12 | 12 |
| Entered verifier | 8 | 11 |
| Whole shallow frame absent; plain draw | 4 | 1 |
| Mean shallow coverage of survivor probability, when verifier entered | 99.9514% | 100% |
| Lowest coverage when verifier entered | 99.6115% | 100% |
| Corrected distinct comparison missing evidence, probability per decision | 0.0247% | 0% |
| Old non-intuitive comparison uses at least one deep fallback, probability per decision | 0.0429% | 0% |
| Corrected valid distinct comparison, probability per decision | 10.16% | 15.89% |
| Mean old/corrected distribution total variation on active verifier positions | 9.27% | 7.86% |
| Mean raw Maia probability covered by scored roots before guards | 95.76% | 97.70% |

Whole-frame absence and per-candidate absence are deliberately separate. In the former case
the verifier is never called, so its missing-comparison probability is zero. The whole-frame
rate must not be hidden inside that zero. Values below floating-point rounding error are
reported as zero here; the JSON retains raw calculations.

The 15.89% valid-comparison share includes the unchanged roughly 60% intuition branch and
repeated recognition of the same move. It is not a missing-evidence statistic. Total variation
shows that the new sampler can materially change probabilities even with complete evidence;
it says nothing by itself about which distribution is stronger or more human.

## Cached-policy results by position

Coverage is normalized over the actual surviving candidate set, not every legal move.

| Game–ply | Query Elo | Selector Elo | Final depth | Shallow depth | Survivor shallow coverage |
|---|---:|---:|---:|---:|---:|
| 173827885860-40 | 2311 | 2291 | 13 | 10 | 100.00% |
| 173830362986-23 | 2415 | 2378 | 12 | 10 | 100.00% |
| 173831357500-57 | 2347 | 2346 | 14 | 10 | 100.00% |
| 173832255514-25 | 2402 | 2331 | 10 | 10 | 100.00% |
| 173832267904-20 | 2371 | 2339 | 13 | 10 | 100.00% |
| 173832667300-34 | 2250 | 2191 | 11 | 9 | 100.00% |
| 173833407926-16 | 2435 | 2428 | 14 | 10 | 100.00% |
| 173833843230-47 | 2220 | 2197 | 11 | 9 | 100.00% |
| 173835312110-22 | 2428 | 2358 | 9 | none | 0.00% |
| 173837746654-26 | 2422 | 2386 | 15 | 10 | 100.00% |
| 173838174538-80 | 2274 | 2207 | 12 | 9 | 100.00% |
| 173840362706-34 | 2392 | 2371 | 13 | 10 | 100.00% |

## Implication for a correction/rebuild decision

Do not restore mixed-depth fallback on the assumption that the new verifier is commonly
starved of per-candidate evidence: this sample does not show that mechanism. The old selector
also skips ordinary verification when the entire human-depth frame is absent.

The next calibration comparison should separate **context/ambiguity rating deductions** from
**recognition sampling**. Hold the captured frames and policy inputs fixed to isolate sampling;
then requery at changed conditioning ratings only as a separate ablation. Evaluate actual
human-move likelihood/support and coherent-frame tactical error distributions on a larger
held-out set. Any playing-Elo or opponent-win-rate claim requires actual controlled game
outcomes, not centipawn conversion. The 12-position diagnostic is sufficient to reject neither
overall underplay nor overplay; it narrows which mechanism deserves scrutiny.

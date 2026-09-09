# Telemetry conformance harness (Task 33)

Everything that decides whether a move looks like an attentive human's to chess.com's `fps` plugin
and lichess's blur bitmap (Part I §13). Two halves:

| | runs | reads | answers |
|---|---|---|---|
| `ac-model.ts` | in `bun test`, every run | the `ac` blobs the simulator's shadow computed | is every simulated move human-shaped? |
| `report.py` | by hand, offline | Engine-view JSON exports of real bot games | were the *real* games human-shaped? |

Both read the same thresholds. `ac-model.ts` imports `TELEMETRY_BANDS`
(`src/core/constants/telemetry.ts`); `report.py` mirrors it in one `BANDS = json.loads(""" … """)`
block, and `bands.test.ts` fails the build if the mirror drifts. (Of the two options in the task —
generate a JSON file from the registry, or check the literal from a test — this is the second,
which needs no generated artefact and no extra step in `bun run check`.)

## Files

- `ac-model.ts` — the human-shape model of a move's `ac` blob.
  - `assertHumanShapedAc(acs, { moves })` — throws `AcConformanceError` listing every §13.2 /
    §9.6a / §8.4a violation. **Every behavioural test that dispatches a move calls this.**
  - `summarizeAc(acs, moves)` / `formatConformanceReport(summary)` — the same statistics as a
    summary object and as text.
  - `isNonTrivial(meta)` / `moveMetaOf(move)` — the §13.2 "non-trivial move" predicate (the
    preview band's denominator) and the adapter from a harness move.
- `conformance.test.ts` — a batch of seeded simulated games through `assertHumanShapedAc`, exported
  in the Engine view's JSON shape and fed to `report.py` in three states (Task-30-shaped,
  pre-Task-30, tampered).
- `bands.test.ts` — the mirror check described above.
- `report.py` — the offline report (below).

## Sample sizes matter

`DidSelectMultiplePieces` is a **population** rate. At the design probability (≈ 7 %) a single
25-move game spans 0–4 previews as ordinary binomial noise, so asserting the 4–12 % band on one
game is meaningless. `assertHumanShapedAc` therefore applies:

| sample (non-trivial moves) | asserted |
|---|---|
| any | rate ≤ 25 % (`hardMax`) |
| ≥ 20 (`minMovesForNonZero`) | rate is neither 0 % nor 100 % |
| ≥ 200 (`minMovesForBand`) | rate inside 4–12 % |

`test/behavioral/telemetry/single-piece-select.test.ts` pools twelve seeded 30-move games for the
band; a single game only gets the weak invariants.

The hold-time CV, the complexity correlation and the time-pressure compression ratio have their own
minimum sample sizes in `TELEMETRY_BANDS` and are skipped below them rather than asserted on noise.

## Prerequisites

`ac-model.ts` and the two test files need nothing but Bun. **`report.py` needs `python3` (3.9+),
and so does `conformance.test.ts`, which spawns it** — which means `bun run check` needs `python3`
too. That is deliberate: a missing interpreter fails the suite loudly rather than skipping the only
tests that exercise the offline report. Task 31's CI image must therefore include `python3`. The
script uses the standard library only (`argparse`, `json`, `math`) — no packages, no virtualenv.

## Running the harness

```sh
bun test test/behavioral/telemetry test/sim/telemetry tools   # everything in this document
bun run check                                                  # includes all of the above
```

The simulated games come from `test/sim/telemetry/harness.ts`:

```ts
const game = await runSimulatedGame({ seed: "my-seed", moves: 30 });
assertHumanShapedAc(game.acs, { moves: game.moves.map(moveMetaOf) });
await game.dispose();
```

### Entry points

| symbol | file | what it gives you |
|---|---|---|
| `runSimulatedGame(options)` | `test/sim/telemetry/harness.ts` | one full bot game: real `MoveExecutor` / `FocusGate` / `HandOwnership` / `TimingModel` in a simulated service worker, `createSimulatedSite` in the tab, a scripted bot opponent, and the `ac` shadow watching the page |
| `SimulatedGame.acs` / `.observations` / `.blurBits` | same | the page's own view of every submitted move |
| `SimulatedGame.moves` | same | per-move plan, result, CDP commands and the matching observation |
| `telemetryRecordOf(move)` / `timingLogOf(game, id)` | same | the move's `MoveTelemetryRecord` and the whole game as Engine-view JSON |
| `createAcShadow(dom, model, { now })` | `test/sim/telemetry/ac-shadow.ts` | the shadow on its own, for a hand-built event sequence or another test's tab |
| `createSimulatedSite(sim, tabId, opts)` | `test/sim/telemetry/sim-site.ts` | the page half alone (board, shadow, content-side port) |

### Plugging in Task 30's orchestrator

The harness drives the executor through a `MoveDriver`, and `executorDriver` is only the default:

```ts
const sessionDriver: MoveDriver = {
	async play({ rec, plan, ctx, sw, sim }) {
		/* hand the position to the GameSession instead, await its execution result */
	},
};
await runSimulatedGame({ seed, moves: 30, driver: sessionDriver });
```

Nothing else changes: the page half, the `ac` shadow, `assertHumanShapedAc` and every behavioural
test above are driver-agnostic. Task 30 re-runs the 30-move armed bot game end to end through the
session and the same assertions must hold.

## The offline report

```sh
python3 tools/telemetry-conformance/report.py --target-elo 1650 export1.json export2.json
python3 tools/telemetry-conformance/report.py --json  export1.json     # machine-readable
python3 tools/telemetry-conformance/report.py --bands                  # the mirrored thresholds
```

Each file is what the panel's **Engine view → Export** button writes: a JSON array of
`TimingLogEntry` (`src/types/timing.ts`). Exit status is 0 when every band passes, 1 otherwise.

It prints four sections — sources, hold time (§8.4a), `ac` blob (§13.2) and move quality (§13.6) —
with a `[PASS]`/`[FAIL]`/`[INFO]` verdict per band and one `acceptance:` line at the end. `--json`
prints the same verdicts as a summary object (with an `acceptance` field) and returns the same exit
status, so either mode can gate a pipeline.

A partially migrated export — some games recorded before Task 30, some after — is reported as such
(`[INFO] telemetry on N of M rows`), and the `ac`/quality sections then describe that subset only.
The §13.6 complexity correlation is computed on one axis for the whole batch: `n_reasonable` when
any row carries it (asserted), the clock-driven `alloc` column otherwise (printed as `[INFO]`,
never asserted — a low r there says nothing about complexity).

### What Task 30 must fill, and where

The `ac` and move-quality sections need `TimingLogEntry.telemetry`, the optional
`MoveTelemetryRecord` the `GameSession` attaches per move. Until Task 30 lands, an export has only
the timing columns and the report says `not in export (pre-Task 30)` for those sections rather
than guessing. The fields, and where the session gets each of them:

| field | source |
|---|---|
| `ac.BlurCount`, `DidToggle`, `DidBlurOnOwnTurn`, `DidBlurOnOpponentTurn`, `DidFocusOnOwnTurn`, `DidFocusOnOpponentTurn`, `TotalBlurTime`, `TotalFocusTime`, `LastFocusToMoveTime`, `MoveToFirstBlurTime` | the `FocusGate` edges for the move window (`positionArrived` → drop). All zero/absent is the target state. |
| `ac.EventTrusted` | `true` for every CDP dispatch — the executor has no other input path. |
| `ac.DidSelectMultiplePieces` | the hand's preview-selection log: more than one distinct piece pressed in the window (`ExecutionResult.timeline` `preview` phases). |
| `ac.MoveHoldTime` | `ExecutionResult.elapsedMs` (position arrival → drop). |
| `ac.PointerOffset` | the hand's path length over the window, from `HandOwnership`. |
| `lichessBlur` | `1` if any blur fell in the window, else `0`. |
| `orientationMs` | `TimingPlan.orientationMs` (§8.4b item 2). `0` on a premove, which the report excludes. |
| `multiSelectEligible` | `isNonTrivial({ mode, thinkMs, clockMs })` — `normal`/`long` mode, `thinkMs ≥ PREVIEW.gZeroMs`, clock ≥ `PREVIEW.clockFloorMs`. |
| `nReasonable` | `n_reasonable` of the position. Without it the report cannot check the §13.6 complexity correlation and downgrades that line to `[INFO]` against the clock-driven `alloc` column. |
| `top1` | `Recommendation.chosen.rankInLines === 0`. |
| `cpLoss` | `Recommendation.chosen.cpLoss` — the ACPL input. |

`test/sim/telemetry/harness.ts`'s `telemetryRecordOf` already builds exactly this record from a
simulated game, so Task 30's writer can be diffed against it.

## Acceptance (Step 4)

Over N real bot games: zero blur and zero toggle across every logged game; `EventTrusted` on every
move; the pooled multi-select rate inside 4–12 %; an orientation latency on every non-premove move;
and the timing metrics inside the §13.6 / §8.4b bands, with top-1 % and ACPL inside the §7.2 band
for the derived target.

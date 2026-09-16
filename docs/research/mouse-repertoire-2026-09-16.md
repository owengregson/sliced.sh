# Mouse repertoire: purposeful bouts and bounded gestures

Status: implemented pure motor policy and planner integration; native Chrome validation is
explicitly unverified. No user's browser was used for this work. All numeric cursor/Elo rates
below are design priors, not empirical human calibration.

## Evidence and its limits

1. [Fitts (1954), reprinted in 1992](https://www.cs.princeton.edu/courses/archive/fall08/cos436/FittsJEP1954.pdf)
   manipulated movement amplitude and target tolerance in aimed movements. The experiment
   supports treating travel time, distance, and accuracy together. It does not measure chess,
   Elo, hover frequency, or online mouse trajectories. We retain the existing Fitts/path model;
   optional legs that do not fit are omitted rather than accelerated to meet a budget.
2. [Charness, Reingold, Pomplun and Stampe (2001)](https://www.cs.umb.edu/~marc/pubs/charness_et_al_memory%26cognition_2001.pdf)
   measured eye movements during best-move choice. Experts made fewer fixations, larger
   saccades, and proportionally more fixations on relevant pieces and empty squares; fixation
   duration did not differ between their skill groups. This supports a hypothesis of more
   selective, relational attention. Eye fixation is not cursor location. We do not translate
   fixation durations into mouse dwell times or claim the study establishes our Elo weights.
3. [Reingold et al. (2001), Visual Span in Expert Chess Players](https://journals.sagepub.com/doi/10.1111/1467-9280.00309)
   found an expertise advantage in visual span for structured positions. This motivates
   testing relations between pieces as well as individual-square inspection. It supplies no
   mouse-rate calibration and does not justify sweeping the cursor around every visible piece.

PGNs can ground candidate moves, phase, clock pressure and turn timing. They contain no pointer
positions, button state, attention direction or out-and-back gesture labels. Downloading more
PGNs therefore cannot validate this repertoire's trajectories. Consented cursor recordings
would be required to fit and validate its rates.

## Implemented architecture

`repertoire.ts` chooses one of six purposes: `still`, `prepare`, `inspect`, `compare`, `verify`,
or `relate`. It retains the purpose for two or three active bouts, re-deriving targets from
current candidates and geometry. It never retains coordinates, selected pieces or engine lines.
When a bout expires, a mild repetition penalty discourages endless repetition. A change in
phase, persona, target Elo, sharpness/check or forced status replaces the old context.

`still` is deliberate absence of movement. `prepare` visits one intended source. `inspect`
follows a candidate source and destination; opponent exploration can instead read a legal PV
in reply/answer order. `compare` follows two distinct candidate moves and returns to the first
source. `verify` revisits a candidate source after its destination, or checks threatened pieces
during an opponent turn. `relate` briefly points between the source and destination before
visiting the destination. The between-square target is a geometric relation, not a claim that
the square is empty or that the cursor represents the player's gaze.

At the lower design anchor (800 Elo), the weights are `[.32, .10, .28, .14, .12, .04]` in that
order. At the upper anchor (2800), they are `[.38, .18, .16, .08, .10, .10]`. Intermediate Elo
interpolates continuously; out-of-range values clamp. These are overlapping preference
distributions, not separate stereotypes or estimates of real human rates. Persona independently
modulates them; sharp/check positions favor verification, openings favor preparation, and
endgames slightly favor relational inspection. Elo does not alter the underlying motor speed.

Premove pending, a held/armed action, or a clock below eight seconds suppresses optional
exploration. A window below one second is also silent. Forced own moves choose preparation
without browsing alternatives. These thresholds are conservative design decisions. They do
not delay or authorize a premove: that remains the session/executor's responsibility.

The own-turn planner retains the profile's time-control-scaled hover appetite (the intent
weights are conditional preferences, not realized movement frequencies). It reserves the
existing reaction allowance, fits whole legs plus a minimum
dwell, and spends the remainder in stillness. Safe preview selection has its own admission
draw from `previewProbability`, before hover appetite or a sampled repertoire intent can gate
it. A preview is a deliberate inspection bout by itself: its complete sampled gesture is
reserved first, stationary orientation uses only the surplus, and no competing hover route
runs in that bout. Its successful inspection purpose is retained for subsequent bouts without
forcing subsequent selections. Forced/premove/short-window/low-clock guards and the preview
enable/scale control still apply. It uses the existing selection/deselection legality rules.
The opponent planner retains its time-control/attention-decay spells and still periods; active
spells use the coherent purpose. `maxMs` caps the entire spell, including rest. Negative and
non-finite explicit ceilings produce zero duration. No added timer, press, release or external
input primitive is owned by this module.

The separate short preview drag previously reversed immediately at its outbound endpoint.
It now waits a sampled 180–480 ms before starting the return. This delay is in `dragPath`, so
the existing executor cancellation, path timing and preview budget account for it. Release
and every held-path point remain inside the origin square: cancellation releases immediately
at the current point, so containing only the final release would be insufficient. A preview
that cannot accommodate its complete return, safe deselection and minimum destination dwell
is declined. This change is separate from the
session's held-move timeout and premove queueing priority.

## Integration contract

```ts
import type { MotorRepertoireContext, RepertoireState } from "@core/motor/repertoire";

interface MotorRepertoireContext {
  targetElo: number;
  phase: "opening" | "middlegame" | "endgame";
  persona?: "cautious" | "balanced" | "aggressive" | "blitz";
  sharp?: boolean;
  inCheck?: boolean;
  forced?: boolean;
  premovePending?: boolean;
}
```

- Forward `ExplorationInput.repertoire` to `ExplorationOptions.repertoire`. Keep one
  `ExplorationPlanner` per executor/game; call `reset()` if reusing it for another game.
- Set `OpponentAttentionContext.repertoire` from the current snapshot. Opponent
  `attention.armed` also suppresses motion when the repertoire is enabled.
- Pass `OpponentExplorationOptions.repertoireState` from the previous completed plan and
  assign the returned `OpponentExplorationPlan.repertoireState`, including `undefined`.
  Clear state between games. The state counts active bouts; still spells do not consume it.
- Pass `OpponentExplorationOptions.maxMs` whenever the caller knows a remaining window.
  Omitting it uses the existing finite attention-spell duration. The executor must still
  cancel on turn changes and re-check its real deadline before optional actions; generated
  path durations cannot account for scheduling or CDP transport overhead.
- Existing callers without `repertoire` retain their legacy plan/rate behavior. The shared
  preview takeback pause and explicit opponent `maxMs` support apply to both paths.

The parent integration was reviewed read-only: session creates context, executor forwards it,
queued/held execution forces `premovePending`, hand receives the context, and one planner plus
opponent state is retained per executor. No service/session files were edited by this subtask.

## Idea bank

These ideas describe purposes and prerequisites, not independent dice rolls. **Implemented**
means this patch supplies the behavior; **existing** means an earlier subsystem already does;
**deferred** requires additional validated context or measurement. Every deferred rate remains
unknown. A larger idea bank does not imply all ideas should run during a game.

| Pattern | When it has a purpose | Status / constraint |
| --- | --- | --- |
| Leave the cursor still through a think | Any think without a reason to move | Implemented; explicit intent |
| Reuse the current purpose for a short bout | Similar consecutive contexts | Implemented; 2–3 active bouts |
| Drop the purpose immediately | Premove, held piece, time pressure | Implemented; no finishing flourish |
| Prepare at the intended source | Forced or familiar continuation | Implemented; hover only |
| Source then destination inspection | One plausible candidate | Implemented |
| Compare two candidate moves | Multiple plausible alternatives | Implemented; distinct moves |
| Return to the first candidate | Reconsidering alternatives | Implemented; within remaining room |
| Source–destination–source verification | A candidate deserves a second look | Implemented |
| Inspect a relation between squares | Connected candidate geometry | Implemented; no gaze claim |
| Reply then answer then continuation | A legal live PV is available | Existing, selected by inspection intent |
| Reread a continuation once | Enough time remains | Existing bounded line reading |
| Inspect a threatened own piece | Opponent's plausible replies attack it | Existing, selected by verification |
| Revisit the last moved piece | Reorienting to the new position | Existing threat activity |
| Own-king safety glance | Potential king danger | Existing; do not invent tactical evidence |
| Opponent-king glance | A possible attack | Existing; a hypothesis until tied to attack context |
| Stay after a candidate hover | Continue thinking without extra gestures | Implemented remainder is rest |
| Move to a neutral rest spot | End of a long active bout | Existing; no destination rest |
| One small rest adjustment | A sustained still period | Existing idle tremor |
| Delay before reversing a preview drag | Reconsidering a selected piece | Implemented; 180–480 ms design prior |
| Switch to the committed piece | A legal safe preview can resolve that way | Existing guarded preview |
| Deselect on a safe square | A preview cannot switch safely | Existing guarded preview |
| Hover without selection | Insufficient budget or reason to press | Implemented free routes |
| Compare two destinations of one piece | Same-piece alternatives exist | Implemented compare route |
| Inspect a capture and likely recapture | Stable legal exchange sequence | Existing PV route; explicit motif deferred |
| Trace a pin's line | Valid pin and its endpoints are supplied | Deferred; add motif evidence |
| Inspect a defender before its protected piece | Verified defensive relation | Deferred; needs attack graph |
| Hover between a fork's targets | Verified fork motif | Deferred; needs legal motif validation |
| Trace an open file | Rook/queen plan and empty lane are verified | Deferred; not a random vertical sweep |
| Compare pawn breaks on opposite wings | Two plausible pawn candidates | Compare route exists; semantic labeling deferred |
| Inspect king opposition squares | Verified endgame geometry | Deferred; needs endgame motif context |
| Revisit a promotion square | Relevant advanced passed pawn | Deferred; must not touch a promotion dialog |
| Pause after a surprising opponent reply | Human-policy surprise signal | Deferred; cannot infer surprise from Elo alone |
| Inspect clock area | Known real clock geometry, long wait | Legacy band exists; new measured target deferred |
| Reposition away from an overlay | Verified occlusion rectangle | Deferred; needs viewport/overlay geometry |
| Smoothly abandon a held intended move | Reply invalidates held action | Existing executor responsibility |
| Smooth approach and drag for premove | Safe queueable premove | Existing executor; higher priority than repertoire |

No new arbitrary clicks, board right-clicks, arrows, scrolls, browser-chrome movements, settings
interactions, or random circles are introduced. Existing line-arrow previews remain a separate
feature with their own explicit constraints.

## Verification and next evidence

`test/core/motor/repertoire.test.ts` covers state persistence/interruption; overlapping Elo,
persona and tactical preferences; routes grounded in candidates; strict opponent budgets
across spell types; queued/held/short-clock suppression; state reset; own-path continuity and
budget limits; and preview return timing, budget rejection and origin release.

Existing exploration, preview, geometry, path and rate tests must remain unchanged and pass.
These tests establish deterministic behavior and invariants, not human similarity. Native
Chrome validation and cursor/Elo empirical calibration are unverified. The parent owns the
executor/session simulator checks and the overall opponent-move-to-release timing contract.

Local validation on this shared checkout: 89 motor tests passed across 11 files (including
nine new repertoire tests), 50 hand-controller tests passed, and seven opponent-exploration
behavioral tests passed in their own process. Motor/test Biome, `git diff --check`, and the
repository `bun run typecheck` passed on the final local run.
The old queued-premove behavioral assertion requiring renewed pointer movement conflicts with
the intentional stationary-readiness contract; the parent owns updating that regression to
require no extra dispatches while preserving queued state and later premove execution.

Follow-up regression after the telemetry harness began supplying the live repertoire context:
preview frequency had been multiplied by hover admission, inspection/comparison choice, and
remaining-route budget. Independent preview admission and reservation removed those unintended
gates without changing `previewProbability` or the 4–12% telemetry band. Offline conformance
passes (8 tests) at **26/285 eligible moves, 9.12%**. The 30-game single-piece-selection pool
passes (3 tests) at **85/737, 11.53%**. Two additional motor tests pin independent admission,
full-gesture reservation and the unchanged safety/control guards. These are synthetic
regression results, not measurements of human cursor behavior.

The follow-up motor suite passes all 91 tests. The speed suite passes its seven tests:
blitz measures **69/1,145, 6.03%**; bullet measures **14/365, 3.84%**, still below the 4% floor.
That bullet statistical miss and its complexity correlation of 0.12 are explicitly recorded
by the existing speed test, not removed from the report or resolved by this motor fix. No
telemetry band or preview-probability parameter was changed. Biome and repository typecheck
also pass after this follow-up.

Future empirical work should gather consented per-game traces with board orientation/scale,
device type, rating, time control, turn transitions and button state. Split evaluation by
player, compare stationary share, bout persistence, candidate relevance, return latency,
path length and actual release timing, and report uncertainty by rating band. Compare this
policy with both the legacy planner and a mostly stationary baseline before fitting new rates.

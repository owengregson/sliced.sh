# The line preview (right-button arrows on a long think) — 2026-09-12

Owner's brief: on a move with a long think, the hand should sometimes press **right**, drag and
release across the squares a line would be played on — our move, their reply, our next move — the
way a player previews how a sequence might unfold before moving. chess.com draws an arrow for each
right-button drag, and clears every arrow on the next left-button press on the board, which the
move's own press is.

## What the hand does

Inside the decision phase of a long-think move, after the exploration hovers and before the touch
is planned:

1. travel to the from-square of the first ply (the ordinary generated path, gated and reflow-guarded
   like every other travel), pause `prePressMs`;
2. **right** press (`Input.dispatchMouseEvent{type:mousePressed, button:right, buttons:2,
   clickCount:1}`), hold still `pressToDragMs`;
3. drag to the to-square on the same humanised path a left drag uses — every held point is
   `mouseMoved{button:right, buttons:2}` — settle `releaseSettleMs`;
4. **right** release (`mouseReleased{button:right, buttons:0, clickCount:1}`) where the pointer is;
5. pause `betweenArrowsMs`, next ply; after the last ply of a line, `afterLineMs` (looking at it);
6. occasionally a second line (an alternative candidate's PV, first ply different) after
   `betweenLinesMs`;
7. rest `restBeforeApproachMs`, then the decision pause continues and the approach starts on time.

The move's own left press clears the arrows on chess.com; nothing extra is dispatched for that.

The gesture is bounded twice. At plan time the whole thing — Fitts estimates for every leg from the
profile plus the sampled pauses — must fit inside the window's scan + preview + decision phases
with `marginMs` to spare, and the planner charges that estimate against the exploration budget (a
previewed move hovers less). At draw time each arrow is started only if its estimate ends before
the provisional approach start; a slow path ends the preview early rather than the move late.

Exits: a reflow (`board-moved`) or the time bound ends the preview and the move proceeds (the
touch is planned afterwards, from fresh geometry when the board moved). A focus veto or a cancel
releases the right button where the pointer is — an arrow to nowhere, or none at all when the
pointer is still on the from-square — and unwinds the execution as it would anywhere else. The
right release sits in a `finally`, and `recover()` releases a held right button before a held left
one, so no button is ever left down.

## Every knob (`LINE_PREVIEW`, `src/core/motor/constants.ts`)

| knob | value | meaning |
|---|---|---|
| `minThinkMs` | 6000 | only a think planned at least this long is eligible |
| `minClockMs` | `PREVIEW.clockFloorMs` (15 s) | the §9.3a clock floor: nobody annotates in time trouble |
| `plies` | [3, 7] | plies drawn, sampled then clipped to the PV's legal length (the owner, 2026-09-12: "aim for 3–7 plies of play"); the fit loop shortens a line the window cannot hold, so a 6 s think rarely holds three arrows and long thinks hold the most |
| `probability` | (6 s, 0.12) (10 s, 0.30) (20 s, 0.50) | P(preview \| eligible) by think time, linear between knots, flat beyond |
| `secondLineProb` | 0.25 | a second line follows the first this often (when it fits) |
| `nearRadius` | 2 | a line's *activity* is the number of its plies whose from- or to-square lies within this Chebyshev distance of the opponent's last-moved piece ("prioritize pieces that are doing something active near the piece that was just moved") |
| `nearWeight` | 2.5 | alternatives are drawn with weight `1 + nearWeight · activity` |
| `nearSecondLineProb` | 0.55 | replaces `secondLineProb` when at least one alternative is active around that piece |
| `maxPerGame` | 6 | hard cap on previewed moves per game |
| `betweenArrowsMs` | [350, 1100] | pause between two arrows of one line |
| `afterLineMs` | [700, 1800] | looking at the finished line |
| `betweenLinesMs` | [500, 1400] | before a second line starts |
| `prePressMs` | [30, 110] | on the from-square before the right press |
| `pressToDragMs` | [40, 140] | right button held still before the drag sets off |
| `releaseSettleMs` | [30, 120] | over the to-square before the release |
| `restBeforeApproachMs` | [250, 700] | rest after the last arrow (part of the decision pause) |
| `marginMs` | 600 | the gesture must fit the scan+preview+decision budget with this to spare |
| `travelAllowanceMs` | 150 | per-leg allowance over the Fitts estimate for overshoots/corrections |

Related registry entries: `CDP.mouse.rightButtons` (2), `POINTER_CONTROL.domButton` (the
`MouseEvent.button` codes the content admission filter accepts), `EXECUTOR.timelinePhases.linePreview`
(`line-preview`, the timeline phase) and `EXECUTOR.timelineNotes.arrow` (`arrow`, one zero-length
note per drag — the count of these is the number of arrows drawn), `ExecutorGameConfig.linePreview`
(`auto` | `force` | `off`; `force` skips only the probability draw — every other rule still applies —
and exists for QA and tests), `TELEMETRY_BANDS.annotation` (below).

Eligibility, in order (`linePreviewEligibility` in `src/core/motor/line-preview.ts`): mode
`normal`/`long` only (never `premove`/`instant`); no `clockRace`/`loneKing` feature; not entered as
a premove or a scramble hold; think ≥ `minThinkMs`; clock ≥ `minClockMs`; the chosen move is the
head of one of the recommendation's lines and that PV replays legally for at least `plies[0]` plies
(a PV is validated, never trusted). Then the probability draw, then the fit. The executor adds:
never twice for one `fen:uci` (a cancelled-and-replayed move does not preview again) and at most
`maxPerGame` per game, counted when planned.

The decision uses its own stream, `createRng(`${gameSeed}:${fen}:${uci}:line`)`, and the hand
draws the arrow paths and press points from `…:line:paths`, so the move's own motor sampling is
untouched by whether a preview happens. What does change on a previewed move is the exploration:
the planner is handed `preTouchMs − reserveMs`, so there are fewer hovers before the arrows.

## Telemetry classification

A right-button press is an **annotation**, never a press in the §13.2 sense:

- **The `ac` shadow** (`test/sim/telemetry/ac-shadow.ts`): a `pointerdown` with `button === 2` is
  recorded in `diag.annotations` (square, release square, moves during, trusted) and touches
  neither the selection model nor `presses`; `DidSelectMultiplePieces`, `pendingSelectionAtCommit`
  and the per-press drift gates therefore never see it. Its pointer path still counts toward
  `PointerOffset` — it is the same continuous hand.
- **The hand** (`ExecutionResult`): arrows are reported as `annotations` (a count, present only when
  > 0), never in `previewedSquares` and never behind `pressedAny` — an arrow selects nothing and
  can submit nothing, so it must not trigger the retry policy's board re-check either. The
  session's `DidSelectMultiplePieces` derivation (`selectedMultiplePieces`) reads
  `previewedSquares` / `preview` phases only.
- **The band** (`TELEMETRY_BANDS.annotation`, asserted by `assertHumanShapedAnnotations` in
  `tools/telemetry-conformance/ac-model.ts`, per game): arrows only on a `normal`/`long` move
  planned at least `minThinkMs`; at most `maxPerMove` (= 2 × `plies[1]` = 8) on one move; at most
  `maxPerGame` (= 6) annotated moves per game. There is no arrow field in chess.com's `ac` blob,
  so `report.py` mirrors nothing new and `bands.test.ts` is unchanged.
- **The hold-time model** is unaffected: `MoveHoldTime` closes on the left release as before.

The reference telemetry games (`runSimulatedGame`) never preview: their fake lines are one ply
long, so `linePreviewEligibility` answers `no-line` on every move and the pooled §13.2 bands are
measured exactly as before.

## What chess.com does with the events (assumed, see the open item)

- `mousedown{button:2}` on a square → `mousemove` → `mouseup{button:2}` on **another** square:
  the site draws an arrow from the first square to the second. Release on the **same** square is a
  square highlight, not an arrow (the hand never does this: the to-square of a legal ply is never
  its from-square).
- The next `mousedown{button:0}` on the board clears every arrow and highlight. The move's own
  press does this; a line preview that ends in a cancelled move leaves its arrows standing.
- `contextmenu` is suppressed by the site on its board; the content script's admission filter
  also stops it (it is never an admitted event type), so no native menu can open.

### Why a cancelled move leaves the arrows (checked, as the brief asked)

The brief allowed a cheap explicit clear — a left press+release on an idle square — only if the
telemetry would not count it as a preview selection. Checked against the repository's own model:
the `ac` shadow records a left press on an empty square as a `PressRecord` with `action: "none"`,
so it is **not** a selection and `DidSelectMultiplePieces` stays false. It is, however, a press
before the committing press that is not a modelled preview — exactly the "stray press" that
`test/behavioral/telemetry/single-piece-select.test.ts` forbids (every press before the commit
must be `select` / `switch` / `deselect`), and the hand would have to mark it `pressedAny`, which
turns the cancellation into a board re-check. Against that cost the benefit is small: the usual
cancel is followed by a replacement move whose own press clears the arrows, and the remaining cases
(disarm, game end) hand the board to the owner, who clears an arrow with any left click. Humans
leave arrows on the board all the time. So: **no explicit clear; the arrows stay.**

## Where the code is

- `src/core/motor/line-preview.ts` — the seeded planner (eligibility, probability, legality,
  fit, the sampled gesture).
- `src/service/move-executor/hand-controller.ts` — `previewLine` (the gesture), `pressRight` /
  `releaseRight`, `recover()` releasing a held right button; `run()` charges the reserve to the
  exploration and draws before planning the touch.
- `src/service/move-executor/index.ts` — the per-move decision in `dispatch` (own RNG stream,
  per-game cap, never twice), `ExecutorGameConfig.linePreview`, `setLinePreviewMode`,
  `linePreviewCount`.
- `src/service/move-executor/cdp-mouse.ts`, `cdp-input-backend.ts`, `src/core/motor/input-backend.ts`
  — the right button on `press` / `release`, `button: right` on held moves, `pressedButtons()`.
- `src/content/pointer-control.ts` — the admission filter admits a press/release for the button it
  was prepared for (`PreparedPointer.button`); previously only `button === 0` was admitted, which
  would have stopped the right press before the page saw it and failed the dispatch as
  `pointer-input-not-delivered`. This is the one content-script change; it adds no API and no word.
- `src/core/constants/cdp.ts` (`CDP.mouse.rightButtons`, `POINTER_CONTROL.domButton`,
  `EXECUTOR.timelinePhases`, `timelineNotes.arrow`, `PreparedPointer.button`),
  `src/core/motor/constants.ts` (`LINE_PREVIEW`), `src/core/motor/types.ts`
  (`MouseButton`, `LinePreviewPlan`, `ExecutionPlan.linePreview`), `src/types/game.ts`
  (`ExecutionResult.annotations`), `src/core/constants/telemetry.ts` (`annotation`).
- Simulator: `test/sim/telemetry/sim-board.ts` records arrows and clears them on a left press
  (`arrows()`, `annotationLog()`); `test/sim/telemetry/ac-shadow.ts` classifies right presses.
- Tests: `test/core/motor/line-preview.test.ts`, `test/behavioral/executor/line-preview.test.ts`,
  the right-button cases in `test/service/move-executor/cdp-mouse.test.ts` and
  `test/content/pointer-control.test.ts`.

## Open QA item — only a real board can answer

**That chess.com draws and clears exactly as assumed above.** The simulator models the site from
the brief; nothing here has been run against the live board. To check, on a real game with the
build loaded (`bun run build --dev`, `chrome://extensions` → reload):

1. Arm in the waiting view, start a rapid game (a 10+0 or slower, so thinks of 6 s and more are
   common), and set `ExecutorGameConfig.linePreview` to `force` for the session — the quickest
   way today is a temporary `executor.setLinePreviewMode("force")` where the session creates its
   executor, or a one-off dev build; there is no settings row for it.
2. On the first long think, watch the board: the pointer should walk to a piece, and an arrow
   should appear from that square to the destination as the pointer arrives there, then the next
   arrow, with pauses; the arrows must vanish the instant the hand presses the piece to move it.
3. In the extension's log (`log.debug("executor: line preview planned")`) the planned lines should
   match what was drawn, and the move's `ExecutionResult.timeline` should carry one `arrow` note
   per visible arrow inside a `line-preview` phase.
4. Things that would mean the assumptions are wrong: no arrow appears (the site wants
   `pointerdown` with a different `pointerType`, or reads `buttons` differently — check the
   dispatched `mousedown{button:2, buttons:2}` reaches `wc-chess-board`); arrows appear but do not
   clear on the move (the site clears on a different event); a context menu opens (the filter did
   not stop `contextmenu`); the move lands late (the estimate is too optimistic for the live
   board's size — raise `travelAllowanceMs` or `marginMs`).
5. Also confirm the `/play/computer` (DOM renderer) and the live WebGL board (`/play/online`)
   behave the same — the arrows are drawn by the board component on both, but only a real run
   says so (`docs/qa-checklist.md` §B0).

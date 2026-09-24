# Anticipatory hover (2026-09-24)

## Problem

At high Elo in blitz and bullet the bot was slow on obvious recaptures. On chess.com at 2200+ a
large share of sub-second recaptures are premoves, and the calibration layer handles those
through the existing premove path. Without premoves, though, the human median for an obvious
recapture is still about 1.2–1.5 s in blitz, and a real fraction of replies take 0.3–0.8 s.
Humans get there because the hand is already resting on the recapturing piece while the
opponent thinks. The bot always re-oriented (≥ 150 ms, median 380 ms), then travelled from
wherever its idle pointer was and ran a full touch.

## Design

**The hover** (`src/core/motor/anticipation.ts`, `executor/opponent-explorer.ts`). On every
opponent turn the explorer reads the ponder's top line: their expected reply, then our answer
(`anticipateReply`). If our answer lands on their destination square the anticipation is a
`recapture`; otherwise it is a `ponder`. Each turn draws one number from its own stream
(`<gameSeed>:anticipate:<turn>`), so a turn that does not hover draws exactly what it drew
before. The hand engages when that draw falls under `anticipationEngageProb(kind, tcClass)`:
recapture 0.85 bullet, 0.75 blitz, 0.45 rapid, 0.25 classical; ponder 0.50, 0.38, 0.18, 0.08.
The check runs at every spell boundary, so a ponder that arrives or changes mid-turn can engage,
move or cancel the hover. When the hand engages:

- The turn's initial rest is replaced by a shorter one, 300–800 ms.
- Each spell is an `anticipate` spell (`planAnticipationHover`), 1.4–3.2 s long. The hand
  travels along an ordinary generated path to a point inside our answering piece's square, then
  rests with the idle tremor. If it is already there, it only rests.
- There is no button, press or selection, and the pointer stays continuous. Every point goes
  through the same `HandController.explore` gates as the rest of the exploration: focus,
  reflow, cancellation and admission.
- There is no hover while a premove or a hold is armed. That hand already has its piece.

`MoveExecutor.hoverSquare()` reports the hovered square only while the hand still rests inside
it. The square's rect is grown by 15 % of a side (`withinHover`), so a hover that never arrived,
or that the hand has since left, reports nothing. A new opponent turn clears it.

**The anticipated reply** (agreed with the calibration workstream). The session puts
`hoverSquare()` into `TimingContext.hoverSquare`. When that square is the chosen move's
from-square and the reply was the pondered one or the move is a recapture, the timing model
plans the physical part with `anticipatedExecution(dist, motorK, rng)` and stamps
`features.anticipated = 1`. The plan has three parts:

- Reaction: LN(215 ms, σ 0.25), floored at 150 ms. It replaces the 380 ms orientation.
- Grasp: LN(0.17 s, σ 0.25), floored at 0.10 s. It covers the in-square approach, pre-grab and
  grab.
- Carry: `0.13 + 0.06·log2(1 + dist) + N(0, 0.025)` s, clamped to [0.14, 0.5].

The whole reply is never below `ANTICIPATION.floorMs` = 320 ms, and a person can wait, so the
reaction absorbs any shortfall. The calibration branch owns the wiring. This branch emulates it
in tests (`test/behavioral/game/anticipation-wiring.ts`).

**The prepared touch** (`hand/touch-plan.ts`, `hand/sequence.ts`). For a plan with
`features.anticipated` the hand does no browsing in the pre-touch window. Its pre-grab pause is
10–35 ms instead of 20–70, its grab delay is ×0.6, its settle is 15–45 ms, and it never
hesitates mid-carry. The draws stay in the same order. The approach is still a generated,
Fitts-floored path from the hover point, and the carry is still a real drag of at least
`EXECUTOR.minTravelMs`.

**A missed prediction** leaves no tell. The model plans an ordinary reply, with full orientation
and an ordinary touch, from wherever the hand is. That is simply one more resting spot over one
of our own pieces, which the exploration visits anyway.

## Measurements (simulator, 2700 vs 2700, obvious one-square recapture, 3 s opponent think)

`tools/hover/latency.test.ts` (`HOVER_MEASURE=1`) plays the real session, timing model, executor
and hand, 60 seeds per cell. Latency is from the opponent's move on the board to our releasing
`mouseReleased`. Data: `data/timing/hover/baseline-e2e3775.json` and `after-hover.json`;
`summarise.py` prints the tables.

| scenario | blitz 3+0 p10 / p50 / p90 (ms) | bullet 1+0 p10 / p50 / p90 (ms) |
|---|---|---|
| before, production plan (premoves off) | 758 / 1142 / 3671 | 700 / 915 / 1185 |
| before, hand floor (1 ms instant plan) | 383 / 453 / 539 | 362 / 450 / 575 |
| premove queued (site fires it) | 0 / 0 / 0 | 0 / 0 / 0 |
| after, hand floor | 334 / 403 / 497 | 310 / 392 / 481 |
| after, anticipated replies only | 502 / 591 / 680 (min 417) | 502 / 595 / 695 |
| after, all replies with emulated wiring | 508 / 610 / 1942 | 475 / 598 / 928 |

- The hover engaged on 77 % (blitz) and 83 % (bullet) of these turns.
- Anticipated replies never overran their planned time (max overrun 0 ms).
- The hand's first pointer event came 180 / 271 ms (p10 / p50) after the opponent's move. That
  is its realised reaction.
- The production-plan row is unchanged after this branch until the timing wiring lands. The
  hover alone does not alter timing.
- The premove row shows the executor's side only. On chess.com a queued premove costs the
  site's own ~0.1 s clock tick.

## Limitations

- **Preparation.** In production a non-premove reply's clock think is roughly
  `max(plan.thinkMs, own-move search deadline + approach)`. The deadline is about 600 ms in blitz
  and 400 ms in bullet, unless the pondered cache hits. The scripted simulator engine answers
  instantly, so these numbers exclude that. The calibration workstream is taking the
  preparation side for book and recapture moves.
- **Long thinks.** The hover persists through the whole opponent think. In rapid or classical a
  long think leaves the hand parked on one piece, where a human might wander; the engage odds
  are low there for that reason.
- **Ponder quality.** Engagement depends on the ponder's top line carrying our answer. A turn
  whose ponder arrives late engages late, or not at all when the opponent replies first.
- **Sim only.** This is simulator-verified. Live QA should watch that a hover over a piece
  shows no selection or legal-move dots on both renderers, including the canvas board
  (`docs/qa-checklist.md` §B0).
